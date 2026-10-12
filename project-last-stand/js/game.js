/**
 * game.js
 * ------------------------------------------------------------------
 * Game manager. Owns the renderer, scene and every gameplay system, and
 * drives the state machine:
 *
 *   menu  --play-->  playing  --esc/blur/lock lost-->  paused
 *                      |   ^                              |
 *                      |   +-------------resume-----------+
 *                      |                                  |
 *                      +--health 0-->  gameover  --retry--> playing
 *                                          |
 *                                          +--main menu--> menu
 *
 * Every system is a separate module; this file only wires them together
 * and enforces the rules that span systems (score, kills, pickups, death).
 */
import * as THREE from 'three';
import { Level } from './level.js';
import { Player } from './player.js';
import { WeaponSystem, sanitizeLoadout, hudSlotLabels, loadoutSlotOptions } from './weapon.js';
import { Enemy, warmEnemyVisuals } from './enemy.js';
import { EnemyAI } from './enemyAI.js';
import { WaveManager } from './waveManager.js';
import { EffectsManager } from './effects.js';
import { ProjectileSystem } from './projectiles.js';
import { InputController } from './input.js';
import { hasLineOfSight, raycastBoxes, isCircleFree } from './collision.js';
import { sanitizeSettings, saveStorage, recordRun, DEFAULT_SETTINGS } from './storage.js';

export const STATE = Object.freeze({
  LOADING: 'loading',
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
});

const GAME_OVER_DELAY = 1.8;      // seconds of death animation before the panel appears
const PICKUP_RADIUS = 1.1;
const HEALTH_PACK = 35;
const HEADSHOT_BONUS = 50;
const MAX_FRAME_ERRORS = 5;
const SPAWN_MIN_DISTANCE = 14;
const START_YAW = -Math.PI * 0.75; // face into the start room
const FLASHLIGHT_PAN_RESPONSE = 8;

/**
 * Helmet flashlight. The light is split in two so it reads as "a torch in a
 * dark corridor" instead of "a bright dot on the far wall":
 *   - the beam: wide, soft-edged and far-reaching, the only shadow caster;
 *   - the spill: a dim, very wide, short-range cone that fills the floor at
 *     your feet and the walls either side, so the beam does not feel like a
 *     tube. No shadows, so it costs no extra shadow pass.
 * Decay below the physical 2 flattens the falloff: the beam still lights a
 * wall 25-30 m away instead of dying at ~10 m, without the near field getting
 * any hotter than it already was (the tone mapper rolls the highlights off).
 */
const FLASHLIGHT = Object.freeze({
  color: 0xdfeeff,
  intensity: 55,
  distance: 45,      // metres before the beam is fully cut off
  angle: 0.95,       // half-angle in radians (~54 deg, i.e. a ~108 deg cone)
  penumbra: 0.85,    // soft edges, no hard circle on the wall
  decay: 1.15,
});
const FLASHLIGHT_SPILL = Object.freeze({
  color: 0xcfe2ff,
  intensity: 8,      // a fill, not a beam: it must not wash out the corridor
  distance: 8,
  angle: 1.45,       // ~83 deg half-angle: everything around the player
  penumbra: 1,
  decay: 1.4,
});

export class Game {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {import('./ui.js').UI} opts.ui
   * @param {import('./audio.js').AudioManager} opts.audio
   * @param {object} opts.storage  result of loadStorage()
   */
  constructor({ canvas, ui, audio, storage }) {
    this.canvas = canvas;
    this.ui = ui;
    this.audio = audio;
    this.storageData = storage;
    this.settings = sanitizeSettings(storage.settings || DEFAULT_SETTINGS);
    this.loadout = sanitizeLoadout(storage.loadout);
    // What the loadout screen may offer per slot; the defs are static.
    this.loadoutSlots = loadoutSlotOptions();

    this.state = STATE.LOADING;
    this.time = 0;
    this.enemies = [];
    this.aliveCount = 0;
    this.stats = this.emptyStats();
    this.gameOverTimer = 0;
    this.gameOverShown = false;
    this.frameErrors = 0;
    this.growlCooldown = 0;
    this.pathBudget = 0;
    this.hitboxCache = [];
    this.actorCache = [];
    this.raf = 0;
    this.lastFrame = 0;
    this.disposed = false;

    this.frame = this.frame.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
  }

  emptyStats() {
    return { score: 0, kills: 0, headshots: 0, wave: 0, shots: 0 };
  }

  /** Builds the renderer, scene, systems and listeners. Call once. */
  init() {
    const { canvas } = this;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030405);
    this.scene.fog = new THREE.FogExp2(0x050709, 0.03);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.05, 160);
    this.scene.add(this.camera); // viewmodels and the flashlight are children of the camera

    // Dim ambient fill; the lights in the facility do the heavy lifting.
    this.scene.add(new THREE.HemisphereLight(0x8fa3bd, 0x1a1a20, 0.9));

    // Helmet flashlight: a long soft beam plus a short-range spill (see FLASHLIGHT above).
    this.flashlight = new THREE.SpotLight(
      FLASHLIGHT.color, FLASHLIGHT.intensity, FLASHLIGHT.distance,
      FLASHLIGHT.angle, FLASHLIGHT.penumbra, FLASHLIGHT.decay,
    );
    this.flashlight.position.set(0.15, -0.08, 0);
    this.flashlight.target.position.set(0, -0.1, -10);
    this.flashlightAimQuaternion = this.camera.quaternion.clone();
    this.flashlightAimDirection = new THREE.Vector3(0, 0, -1);
    this.flashlightTargetPosition = new THREE.Vector3();
    this.flashlight.castShadow = this.settings.shadows;
    // The cone is much wider than before, so the shadow map covers more world
    // space per texel: a bigger map (and a touch more bias) keeps it crisp.
    this.flashlight.shadow.mapSize.set(2048, 2048);
    this.flashlight.shadow.camera.near = 0.1;
    this.flashlight.shadow.camera.far = FLASHLIGHT.distance;
    this.flashlight.shadow.bias = -0.0006;
    this.flashlight.shadow.normalBias = 0.05;
    this.camera.add(this.flashlight);
    this.scene.add(this.flashlight.target);

    // Near-field fill. Shares the beam's target, so the pan code below drives
    // both lights with no extra work.
    this.flashlightSpill = new THREE.SpotLight(
      FLASHLIGHT_SPILL.color, FLASHLIGHT_SPILL.intensity, FLASHLIGHT_SPILL.distance,
      FLASHLIGHT_SPILL.angle, FLASHLIGHT_SPILL.penumbra, FLASHLIGHT_SPILL.decay,
    );
    this.flashlightSpill.position.set(0.1, -0.05, -0.1);
    this.flashlightSpill.castShadow = false;
    this.flashlightSpill.target = this.flashlight.target;
    this.camera.add(this.flashlightSpill);

    this.level = new Level(this.scene, { renderer: this.renderer });
    this.effects = new EffectsManager(this.scene, { bounds: this.level.bounds });
    this.effects.setViewport(window.innerHeight * this.renderer.getPixelRatio(), this.camera.fov);

    this.player = new Player({
      camera: this.camera,
      hooks: {
        onFootstep: (sprinting) => this.audio.playFootstep(sprinting),
        onDash: (direction) => this.ui.dashEffect(direction),
        onDamaged: (amount, from) => this.onPlayerDamaged(amount, from),
        onDeath: () => this.onPlayerDeath(),
      },
    });

    // Explosives: one pooled flight sim. The hook block is built once and reused
    // every frame, so the projectile update cannot add garbage to the frame.
    this.projectileHooks = {
      // Splash damage is reported exactly like a hitscan hit, so score, hit
      // markers, decals and death handling stay in this one place.
      onEnemyHit: (info) => this.onEnemyHit(info),
      onPlayerHit: (info) => this.player.damage(info.damage, info.point),
      onExplode: (info) => this.onProjectileExplode(info),
    };
    this.projectiles = new ProjectileSystem(this.scene, {
      effects: this.effects,
      audio: this.audio,
      hooks: this.projectileHooks,
    });

    this.weapons = new WeaponSystem({
      camera: this.camera,
      audio: this.audio,
      effects: this.effects,
      player: this.player,
      projectiles: this.projectiles,
      loadout: this.loadout,
      hooks: {
        onShot: (def) => this.onShot(def),
        onEnemyHit: (info) => this.onEnemyHit(info),
        onMessage: (text) => this.ui.toast(text, 'warn'),
      },
    });

    this.lookTurnSign = 0;
    this.lookTurnTime = -Infinity;
    this.ai = new EnemyAI();
    this.aiWorld = {
      player: this.player,
      colliders: this.level.colliders,
      nav: this.level.navGrid,
      enemies: this.enemies,
      time: 0,
      noise: null,
      huntAll: false,
      requestPath: () => {
        if (this.pathBudget <= 0) return false;
        this.pathBudget--;
        return true;
      },
      damagePlayer: (amount, enemy) => this.player.damage(amount, enemy.position),
    };

    this.waves = new WaveManager({
      spawnEnemy: (typeId, cfg) => this.spawnEnemy(typeId, cfg),
      onEvent: (name, payload) => this.onWaveEvent(name, payload),
    });

    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0;

    this.input = new InputController({
      target: canvas,
      onKeyDown: (e) => this.onKeyDown(e),
      onPointerLockLost: () => this.onPointerLockLost(),
      onWindowBlur: () => this.pauseIfPlaying('Window lost focus. Press RESUME to continue.'),
    });

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.applySettings();
    this.resetPlayerToStart();
    this.weapons.reset();
    this.prewarmShaders();
    this.ui.writeSettingsControls(this.settings);
    this.ui.setLoadout(hudSlotLabels(this.loadout));
    this.ui.writeLoadoutControls(this.loadout, this.loadoutSlots);
    this.ui.setRecords(this.storageData);
    this.setState(STATE.MENU);
    this.ui.setMode('menu');
    this.audio.setAmbienceLevel(0.5);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * Compiles every shader program the game can use, while the title screen loads.
   * Without this, the first wave, first shot, first blood decal or the first
   * time shadows are toggled would stall a frame while the driver compiles the
   * program. Normally hidden objects (viewmodels, decals, tracers, enemies) are
   * made visible for the duration of the compile, then restored. Only the active
   * shadow setting is compiled: compiling the other variant as well doubles the
   * start-up compile for a setting that is rarely changed (toggling it compiles once).
   */
  prewarmShaders() {
    const hidden = [];
    const reveal = (o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    };
    // Every viewmodel, not just the carried ones: the loadout screen can put
    // any gun in a slot, and nothing here should recompile mid-run.
    for (const m of this.weapons.viewmodels.values()) {
      if (!m) continue;
      reveal(m.group);
      if (m.flash) reveal(m.flash);
    }
    // The arm rig and blade trail are hidden until a melee weapon is drawn.
    reveal(this.weapons.melee.root);
    reveal(this.weapons.melee.trail.mesh);
    for (const t of this.effects.tracers) reveal(t.line);
    reveal(this.effects.holes.mesh);
    reveal(this.effects.bloodDecals.mesh);
    // Grenade meshes and the scorch pool only appear the first time a launcher
    // fires; the blast reuses the spark/dust pools, which must be compiled too.
    reveal(this.projectiles.mesh);
    reveal(this.effects.scorch.mesh);
    reveal(this.effects.sparks.points);
    reveal(this.effects.dust.points);
    const removeEnemies = warmEnemyVisuals(this.scene);
    try {
      this.renderer.compile(this.scene, this.camera);
    } finally {
      removeEnemies();
      for (const o of hidden) o.visible = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * State transitions
   * ------------------------------------------------------------------ */
  setState(next) {
    this.state = next;
  }

  /** Starts a fresh run (New game / Retry / Restart). */
  startRun() {
    this.clearWorld();
    this.audio.init();
    this.audio.startAmbience();
    this.audio.setAmbienceLevel(1);
    this.stats = this.emptyStats();
    this.gameOverTimer = 0;
    this.gameOverShown = false;
    this.resetPlayerToStart();
    this.weapons.reset();
    this.level.pickups.setAllActive(true);
    this.effects.clearDecals?.();
    this.waves.start();
    this.setState(STATE.PLAYING);
    this.ui.resetHud();
    this.ui.setMode('playing');
    this.ui.setCountdown('');
    this.input.consumeMouseDelta();
    this.setViewmodelVisible(true);
    this.ui.showBanner('SECTOR 7 BREACH', 'Hold the corridors. Scavenge between waves.');
    this.requestPointerLock();
  }

  /** Resumes a paused run. Must run inside a user gesture (button click). */
  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.setState(STATE.PLAYING);
    this.ui.setMode('playing');
    this.audio.setAmbienceLevel(1);
    this.input.consumeMouseDelta();
    this.requestPointerLock();
  }

  /** Pauses gameplay and releases the mouse. */
  pause(note) {
    if (this.state !== STATE.PLAYING) return;
    this.setState(STATE.PAUSED);
    this.input.releaseLock();
    this.audio.setAmbienceLevel(0.35);
    this.ui.showPause(note);
  }

  pauseIfPlaying(note) {
    this.pause(note);
  }

  /** Back to the title screen. Gameplay state is discarded. */
  toMainMenu() {
    this.clearWorld();
    this.resetPlayerToStart();
    this.weapons.reset();
    this.waves.stop();
    this.waves.reset();
    this.stats = this.emptyStats();
    this.setState(STATE.MENU);
    this.input.releaseLock();
    this.audio.setHeartbeat(0);
    this.audio.setAmbienceLevel(0.5);
    this.setViewmodelVisible(false);
    this.ui.resetHud();
    this.ui.setRecords(this.storageData);
    this.ui.setMode('menu');
  }

  requestPointerLock() {
    this.input.requestLock().then((ok) => {
      if (!ok && this.state === STATE.PLAYING) {
        this.pause('The browser refused mouse capture. Press RESUME to try again.');
      }
    });
  }

  onPointerLockLost() {
    // Escape also releases the lock; treat losing the lock as a pause request.
    if (this.state === STATE.PLAYING) {
      this.pause('Mouse released. Press RESUME to continue.');
    }
  }

  onVisibility() {
    if (document.hidden) this.pauseIfPlaying('Tab was hidden. Press RESUME to continue.');
  }

  onKeyDown(e) {
    // The UI handles Escape inside sub-menus (settings, controls) and marks it
    // as handled; in that case the game must not also resume.
    if (e.code !== 'Escape' || e.defaultPrevented) return;
    if (this.state === STATE.PLAYING) this.pause();
    else if (this.state === STATE.PAUSED && this.ui.screen === 'pause') this.resume();
  }

  onPlayerDeath() {
    if (this.state === STATE.GAMEOVER) return;
    this.setState(STATE.GAMEOVER);
    this.gameOverTimer = 0;
    this.waves.stop();
    this.ui.setMode('gameover');
    this.input.releaseLock();
    this.setViewmodelVisible(false);
    this.audio.playPlayerDeath();
    this.audio.setHeartbeat(0);
    this.ui.showBanner('YOU DIED', 'The facility claims another survivor.', 'danger');

    const { record, newHighScore, newHighWave } = recordRun(
      { ...this.storageData, settings: this.settings },
      { score: this.stats.score, wave: this.stats.wave, kills: this.stats.kills },
    );
    this.storageData = record;
    this.gameOverRecord = newHighScore
      ? 'NEW HIGH SCORE!'
      : newHighWave
        ? 'NEW BEST WAVE!'
        : `Best score ${record.highScore.toLocaleString()} - best wave ${record.highWave}`;
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */
  applySettings() {
    const s = this.settings;
    this.player.sensitivity = s.sensitivity;
    this.player.invertY = s.invertY;
    this.player.shakeEnabled = s.screenShake;
    this.player.baseFov = s.fov;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.audio.setVolume(s.volume);
    this.renderer.shadowMap.enabled = s.shadows;
    if (this.flashlight) this.flashlight.castShadow = s.shadows;
  }

  updateSettings(next) {
    this.settings = sanitizeSettings(next);
    this.applySettings();
    this.storageData = { ...this.storageData, settings: this.settings };
    saveStorage(this.storageData);
  }

  resetSettings() {
    this.updateSettings({ ...DEFAULT_SETTINGS });
    this.ui.writeSettingsControls(this.settings);
  }

  /* ------------------------------------------------------------------ *
   * Loadout
   * ------------------------------------------------------------------ */
  /**
   * Applies a loadout picked in the menu: sanitize it against the current kit,
   * rebuild the weapon slots, repaint the HUD chips and persist it.
   * @param {string[]} ids       weapon id per key; missing keys keep the current weapon
   * @param {boolean} [persist]  false for the `?weapons=` debug override
   * @returns {string[]} the loadout that was actually applied
   */
  setLoadout(ids, persist = true) {
    this.loadout = sanitizeLoadout(ids, this.loadout);
    this.weapons.setLoadout(this.loadout);
    this.ui.setLoadout(hudSlotLabels(this.loadout));
    this.ui.writeLoadoutControls(this.loadout, this.loadoutSlots);
    if (persist) {
      this.storageData = { ...this.storageData, loadout: this.loadout };
      saveStorage(this.storageData);
    }
    return this.loadout;
  }

  /* ------------------------------------------------------------------ *
   * World management
   * ------------------------------------------------------------------ */
  resetPlayerToStart() {
    const start = this.level.playerStart;
    this.player.spawn(start.x, start.z, START_YAW);
    this.player.updateCamera();
    this.flashlightAimQuaternion.copy(this.camera.quaternion);
    this.updateFlashlight(0);
  }

  updateFlashlight(dt) {
    const follow = 1 - Math.exp(-FLASHLIGHT_PAN_RESPONSE * dt);
    this.flashlightAimQuaternion.slerp(this.camera.quaternion, follow);
    this.flashlight.getWorldPosition(this.flashlightTargetPosition);
    this.flashlightAimDirection.set(0, 0, -10).applyQuaternion(this.flashlightAimQuaternion);
    this.flashlight.target.position.copy(this.flashlightTargetPosition).add(this.flashlightAimDirection);
  }

  setViewmodelVisible(visible) {
    this.weapons.setVisible(visible);
  }

  /** Removes every enemy and transient effect (used when a run ends). */
  clearWorld() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.projectiles?.clear?.(); // no grenade outlives the run it was fired in
    this.effects.clearDecals?.();
  }

  countAlive() {
    let n = 0;
    for (const e of this.enemies) if (e.isAlive()) n++;
    return n;
  }

  /**
   * Chooses a spawn point: far enough away, not in view when possible,
   * and not overlapping another enemy. Returns {x,z} or null.
   */
  pickSpawnSpot() {
    const p = this.player.position;
    const hidden = [];
    const visible = [];
    for (const s of this.level.spawnPoints) {
      const dist = Math.hypot(s.x - p.x, s.z - p.z);
      if (dist < SPAWN_MIN_DISTANCE) continue;
      const crowded = this.enemies.some((e) => e.isAlive() && Math.hypot(e.position.x - s.x, e.position.z - s.z) < 2.2);
      if (crowded) continue;
      if (!isCircleFree(s.x, s.z, 0.4, 0, 1.8, this.level.colliders)) continue;
      const seen = hasLineOfSight({ x: s.x, y: 1.5, z: s.z }, { x: p.x, y: 1.5, z: p.z }, this.level.colliders);
      (seen ? visible : hidden).push(s);
    }
    const pool = hidden.length ? hidden : visible;
    if (pool.length === 0) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { x: pick.x + (Math.random() - 0.5) * 0.6, z: pick.z + (Math.random() - 0.5) * 0.6 };
  }

  spawnEnemy(typeId, cfg) {
    const spot = this.pickSpawnSpot();
    if (!spot) return false;
    const aggro = Math.random() < 0.55; // some hunt at once, others must find you
    const enemy = new Enemy({
      scene: this.scene,
      typeId,
      x: spot.x,
      z: spot.z,
      multipliers: cfg.multipliers,
      aggro,
    });
    this.enemies.push(enemy);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Combat callbacks
   * ------------------------------------------------------------------ */
  onShot() {
    this.ui.crosshairFire();
    this.stats.shots++;
    // Gunfire is loud: nearby enemies are alerted to the player's position.
    this.aiWorld.noise = { x: this.player.position.x, z: this.player.position.z, time: this.time };
  }

  onEnemyHit({ enemy, damage, headshot, point, stagger, knockback }) {
    if (!enemy.isTargetable()) return { killed: false };
    const result = enemy.takeDamage(damage, { headshot });
    if (result.killed) {
      this.onEnemyKilled(enemy, headshot);
    } else {
      this.ui.hitMarker({ kill: false, headshot });
      if (enemy.type.armor && !headshot) this.audio.playHitMetal(point);
      // Melee extras, reported by the weapon that landed the blow. A heavy blow
      // flinches things a bullet cannot (the armour exception is Enemy's call)
      // and shoves the body away along the swing.
      if (stagger) enemy.applyStagger({ heavy: true, headshot });
      if (knockback) enemy.applyKnockback(knockback.x, knockback.z, knockback.distance);
    }
    return { killed: result.killed };
  }

  onEnemyKilled(enemy, headshot) {
    const points = enemy.type.score + (headshot ? HEADSHOT_BONUS : 0);
    this.stats.score += points;
    this.stats.kills += 1;
    if (headshot) this.stats.headshots += 1;
    this.ui.hitMarker({ kill: true, headshot });
    this.effects.spawnFloorBlood(enemy.position.x, enemy.position.z);
    this.audio.playEnemyDeath(enemy.position);
    this.audio.playKill(enemy.position);
    if (headshot) this.ui.toast(`HEADSHOT +${points}`, 'good');
  }

  /**
   * A grenade went off. The blast is the loudest thing in the game: every
   * infected nearby gets the noise, and the shockwave shakes the camera of the
   * player who fired it (scaled by distance, capped well below a real hit).
   */
  onProjectileExplode({ point, radius, owner }) {
    this.aiWorld.noise = { x: point.x, z: point.z, time: this.time };
    if (owner !== this.player) return;
    const d = this.player.position.distanceTo(point);
    const close = Math.max(0, 1 - d / (radius * 3));
    if (close > 0) this.player.addTrauma(close * 0.6);
  }

  onPlayerDamaged(amount, fromPos) {
    this.ui.flashDamage();
    if (fromPos) {
      const dx = fromPos.x - this.player.position.x;
      const dz = fromPos.z - this.player.position.z;
      const heading = Math.atan2(dx, dz);
      const forwardHeading = this.player.yaw + Math.PI;
      let rel = heading - forwardHeading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      // CSS rotation is clockwise-positive; enemies on the left need a negative angle.
      this.ui.showDamageDirection((-rel * 180) / Math.PI);
    }
    this.audio.playPlayerHurt();
  }

  /** Enemies in the crosshair's path (for health bars). */
  updateTargeting() {
    for (const e of this.enemies) e.targeted = false;
    const cam = this.camera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    this.raycaster.set(origin, dir);
    this.raycaster.far = 40;
    const hits = this.raycaster.intersectObjects(this.getHitboxes(), false);
    for (const hit of hits) {
      const enemy = hit.object.userData.enemy;
      if (!enemy || !enemy.isTargetable()) continue;
      const wall = raycastBoxes(origin, dir, hit.distance, this.level.colliders);
      if (!wall) enemy.targeted = true;
      break;
    }
  }

  getHitboxes() {
    const list = this.hitboxCache;
    list.length = 0;
    for (const e of this.enemies) {
      if (!e.isTargetable()) continue;
      for (const h of e.getHitboxes()) list.push(h);
    }
    return list;
  }

  /* ------------------------------------------------------------------ *
   * Waves, pickups, supplies
   * ------------------------------------------------------------------ */
  onWaveEvent(name, p = {}) {
    switch (name) {
      case 'countdown':
        this.stats.wave = p.wave;
        this.ui.setCountdown(String(p.seconds));
        if (p.seconds === 5 || p.seconds === 4) this.ui.showBanner(`WAVE ${p.wave}`, 'Incoming in...');
        break;
      case 'waveStart':
        this.ui.setCountdown('');
        this.ui.showBanner(`WAVE ${p.wave}`, `${p.total} hostiles inbound`, 'danger');
        this.audio.playWaveStart();
        break;
      case 'huntAll':
        this.ui.toast('They know exactly where you are.', 'warn');
        break;
      case 'waveCleared':
        this.stats.score += p.bonus;
        this.ui.setCountdown('');
        this.ui.showBanner('WAVE CLEARED', `+${p.bonus} bonus. Restock before the next wave.`, 'good');
        this.audio.playWaveClear();
        this.level.pickups.setAllActive(true);
        this.ui.toast('Supply crates restocked', 'good');
        // The MK2 SIDEARM is the "never empty" weapon: it tops itself back up to
        // 36 rounds here, at the frame the intermission starts, instead of taking
        // ammo crates (weapon.js ALWAYS_CARRIED / refillAlwaysCarried()).
        if (this.weapons.refillAlwaysCarried()) this.ui.toast('SIDEARM RESTOCKED', 'good');
        break;
      case 'intermission':
        if (p.seconds <= 5) this.ui.setCountdown(String(p.seconds));
        break;
      default:
        break;
    }
  }

  updatePickups() {
    const p = this.player.position;
    const item = this.level.pickups.tryCollect(p.x, p.z, PICKUP_RADIUS, (type) =>
      type === 'health' ? this.player.health < this.player.maxHealth : this.weapons.needsAmmo());
    if (!item) return;
    if (item.type === 'health') {
      const healed = this.player.heal(HEALTH_PACK);
      this.ui.toast(`+${healed} HEALTH`, 'good');
    } else {
      this.weapons.addAmmo();
      this.ui.toast('AMMO RESTOCKED', 'good');
    }
    this.audio.playPickup(item.type);
  }

  /* ------------------------------------------------------------------ *
   * Frame loop
   * ------------------------------------------------------------------ */
  readControls() {
    const k = this.input;
    const fwd = k.isDown('KeyW') || k.isDown('ArrowUp') ? 1 : 0;
    const back = k.isDown('KeyS') || k.isDown('ArrowDown') ? 1 : 0;
    const right = k.isDown('KeyD') || k.isDown('ArrowRight') ? 1 : 0;
    const left = k.isDown('KeyA') || k.isDown('ArrowLeft') ? 1 : 0;
    const sprint = k.isDown('ShiftLeft') || k.isDown('ShiftRight');
    const dashChord = sprint && (k.isDown('KeyA') || k.isDown('KeyS') || k.isDown('KeyD'));
    // With a melee weapon drawn, Space swings instead of jumping (see updatePlaying).
    const meleeDrawn = this.weapons.def.category === 'melee';
    return {
      moveZ: fwd - back,
      moveX: right - left,
      sprint,
      jump: k.isDown('Space') && !dashChord && !meleeDrawn,
      dash: dashChord && k.wasPressed('Space')
        ? { x: Number(k.isDown('KeyD')) - Number(k.isDown('KeyA')), z: -Number(k.isDown('KeyS')) }
        : null,
      aim: k.mouseDown(2) && k.locked,
    };
  }

  /**
   * Swing side for a melee attack: strafing decides it, otherwise the most recent
   * horizontal look movement. 'left' = backhand, 'right' = forehand.
   */
  meleeFacing(controls) {
    if (controls.moveX < 0) return 'left';
    if (controls.moveX > 0) return 'right';
    if (this.time - this.lookTurnTime < 0.4) return this.lookTurnSign < 0 ? 'left' : 'right';
    return 'right';
  }

  /** Core gameplay step. Only runs while PLAYING. */
  updatePlaying(dt) {
    const input = this.input;
    const look = input.consumeMouseDelta();
    if (input.locked) this.player.look(look.x, look.y);
    if (Math.abs(look.x) > 2) {
      this.lookTurnSign = Math.sign(look.x);
      this.lookTurnTime = this.time;
    }
    const controls = this.readControls();
    this.player.update(dt, controls, this.level.colliders, this.level.bounds);

    // Enemy AI and visuals.
    this.aliveCount = this.countAlive();
    this.pathBudget = 4;
    this.aiWorld.time = this.time;
    this.aiWorld.huntAll = this.waves.huntAll;
    this.aiWorld.noise = this.aiWorld.noise && this.time - this.aiWorld.noise.time < 2 ? this.aiWorld.noise : null;
    for (const e of this.enemies) {
      if (this.state !== STATE.PLAYING) break; // the player may have died mid-loop
      this.ai.update(e, dt, this.aiWorld);
    }
    this.growlCooldown = Math.max(0, this.growlCooldown - dt);
    for (const e of this.enemies) {
      e.update(dt, this.camera);
      if (e.swingPending) {
        e.swingPending = false;
        this.audio.playEnemyAttack(e.position);
      }
      if (e.aggro && !e.wasAggro) {
        e.wasAggro = true;
        if (this.growlCooldown <= 0 && e.isAlive()) {
          this.growlCooldown = 0.35;
          this.audio.playEnemyGrowl(e.typeId, e.position);
        }
      }
    }

    // Weapons: 1-2 remain firearms, 3-5 the melee loadout, and the keys after
    // them draw the always-carried sidearm (slotCount, not a hard-coded 5).
    for (let slot = 1; slot <= this.weapons.slotCount; slot++) {
      if (input.wasPressed(`Digit${slot}`) || input.wasPressed(`Numpad${slot}`)) {
        this.weapons.requestSwitch(slot - 1);
      }
    }
    // Space attacks only with a melee weapon drawn, and never while a dash chord uses it.
    const meleeDrawn = this.weapons.def.category === 'melee';
    this.weapons.update(
      dt,
      {
        fireHeld: input.mouseDown(0) && input.locked,
        firePressed: input.mouseWasPressed(0) && input.locked,
        attackPressed: meleeDrawn && input.locked && !controls.dash && input.wasPressed('Space'),
        facing: this.meleeFacing(controls),
        reloadPressed: input.wasPressed('KeyR'),
        aim: controls.aim,
      },
      {
        canFire: this.player.alive && input.locked,
        colliders: this.level.colliders,
        hitboxes: () => this.getHitboxes(),
        speedFactor: this.player.speedFactor,
        bobPhase: this.player.bobPhase,
        dt,
      },
    );

    // Explosives fly after the guns have fired and before the wave bookkeeping:
    // a grenade that kills on frame N must count toward wave N in the same frame.
    this.projectiles.update(dt, this.level.colliders, this.enemies, this.projectileHooks);

    // Waves and spawns.
    this.aliveCount = this.countAlive();
    this.waves.update(dt, this.aliveCount);

    // Remove enemies whose death animation has finished.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.isRemovable()) {
        e.dispose();
        this.enemies.splice(i, 1);
      }
    }

    this.updateTargeting();
    this.updatePickups();

    // Heartbeat when badly hurt.
    const hp = this.player.health;
    this.audio.setHeartbeat(hp > 0 && hp < 35 ? 60 + (35 - hp) * 2.2 : 0);
  }

  /** Death sequence: keep animating the world, but no gameplay input or attacks. */
  updateGameOver(dt) {
    this.gameOverTimer += dt;
    this.player.update(dt, { moveX: 0, moveZ: 0 }, this.level.colliders, this.level.bounds);
    for (const e of this.enemies) e.update(dt, this.camera);
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].isRemovable()) {
        this.enemies[i].dispose();
        this.enemies.splice(i, 1);
      }
    }
    if (!this.gameOverShown && this.gameOverTimer >= GAME_OVER_DELAY) {
      this.gameOverShown = true;
      this.ui.showGameOver({
        score: this.stats.score,
        kills: this.stats.kills,
        wave: this.stats.wave,
        headshots: this.stats.headshots,
        recordText: this.gameOverRecord,
      });
    }
  }

  /** Menu backdrop: slow camera pan through the facility. */
  updateMenu(dt) {
    this.player.yaw += dt * 0.05;
    this.player.updateCamera();
  }

  /** Advances all systems by dt seconds. */
  update(dt) {
    // Paused: the whole simulation (time, world, audio clock) is frozen.
    if (this.state === STATE.PAUSED) {
      this.input.endFrame();
      return;
    }
    this.time += dt;

    // Doors react to the player and to living enemies.
    this.actorCache.length = 0;
    this.actorCache.push(this.player.position);
    for (const e of this.enemies) if (e.isAlive()) this.actorCache.push(e.position);
    this.level.update(dt, this.actorCache);
    // Doors are handed to the effects system so bullet marks can die with the
    // panel they were shot into, instead of hanging in the open doorway.
    this.effects.update(dt, this.time, this.level.doors);
    this.level.pickups.update(dt, this.time);
    this.audio.setListener(this.player.position.x, this.player.position.z, this.player.yaw);
    this.audio.update(dt);

    switch (this.state) {
      case STATE.MENU:
        this.updateMenu(dt);
        break;
      case STATE.PLAYING:
        this.updatePlaying(dt);
        break;
      case STATE.GAMEOVER:
        this.updateGameOver(dt);
        break;
      case STATE.PAUSED:
        // Paused: no simulation, camera holds still.
        break;
      default:
        break;
    }

    this.updateFlashlight(dt);

    if (this.state === STATE.PLAYING || this.state === STATE.GAMEOVER || this.state === STATE.PAUSED) {
      this.ui.updateHud(this.buildHudSnapshot());
    }
    this.input.endFrame();
  }

  buildHudSnapshot() {
    const w = this.waves;
    let phaseText = '';
    switch (w.phase) {
      case 'countdown': phaseText = `WAVE ${w.wave} INCOMING`; break;
      case 'active': phaseText = `WAVE ${w.wave} IN PROGRESS`; break;
      case 'intermission': phaseText = 'SUPPLY BREAK'; break;
      default: phaseText = '';
    }
    return {
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      stamina: this.player.stamina,
      maxStamina: this.player.maxStamina,
      weapon: this.weapons.getHudData(),
      kills: this.stats.kills,
      score: this.stats.score,
      wave: w.wave,
      remaining: w.remaining(this.countAlive()),
      phaseText,
    };
  }

  /** Resizes the drawing buffer and camera to the window. */
  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.effects.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);
  }

  frame(now) {
    if (this.disposed) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    try {
      this.update(dt);
      this.frameErrors = 0;
    } catch (err) {
      this.frameErrors++;
      console.error('[game] frame error', err);
      if (this.frameErrors === MAX_FRAME_ERRORS) {
        this.ui.toast('Unexpected error. Check the console for details.', 'warn');
      }
    }
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Stops the loop and frees every resource. Safe to call once. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input?.dispose();
    this.clearWorld();
    this.weapons?.dispose();
    this.projectiles?.dispose();
    this.effects?.dispose();
    this.level?.dispose();
    this.audio?.dispose();
    this.renderer?.dispose();
  }
}
