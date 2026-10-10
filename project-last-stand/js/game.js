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
import { WeaponSystem } from './weapon.js';
import { Enemy, warmEnemyVisuals } from './enemy.js';
import { EnemyAI } from './enemyAI.js';
import { WaveManager } from './waveManager.js';
import { EffectsManager } from './effects.js';
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

    // Helmet flashlight with shadows (toggle in settings).
    this.flashlight = new THREE.SpotLight(0xdfeeff, 100, 30, 0.7, 0.5, 2);
    this.flashlight.position.set(0.15, -0.08, 0);
    this.flashlight.target.position.set(0, -0.1, -10);
    this.flashlightAimQuaternion = this.camera.quaternion.clone();
    this.flashlightAimDirection = new THREE.Vector3(0, 0, -1);
    this.flashlightTargetPosition = new THREE.Vector3();
    this.flashlight.castShadow = this.settings.shadows;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.1;
    this.flashlight.shadow.camera.far = 30;
    this.flashlight.shadow.bias = -0.0008;
    this.flashlight.shadow.normalBias = 0.03;
    this.camera.add(this.flashlight);
    this.scene.add(this.flashlight.target);

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

    this.weapons = new WeaponSystem({
      camera: this.camera,
      audio: this.audio,
      effects: this.effects,
      player: this.player,
      hooks: {
        onShot: (def) => this.onShot(def),
        onEnemyHit: (info) => this.onEnemyHit(info),
        onMessage: (text) => this.ui.toast(text, 'warn'),
      },
    });

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
    for (const m of this.weapons.models) {
      reveal(m.group);
      reveal(m.flash);
    }
    for (const t of this.effects.tracers) reveal(t.line);
    reveal(this.effects.holes.mesh);
    reveal(this.effects.bloodDecals.mesh);
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

  onEnemyHit({ enemy, damage, headshot, point }) {
    if (!enemy.isTargetable()) return { killed: false };
    const result = enemy.takeDamage(damage, { headshot });
    if (result.killed) {
      this.onEnemyKilled(enemy, headshot);
    } else {
      this.ui.hitMarker({ kill: false, headshot });
      if (enemy.type.armor && !headshot) this.audio.playHitMetal(point);
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
    return {
      moveZ: fwd - back,
      moveX: right - left,
      sprint,
      jump: k.isDown('Space') && !dashChord,
      dash: dashChord && k.wasPressed('Space')
        ? { x: Number(k.isDown('KeyD')) - Number(k.isDown('KeyA')), z: -Number(k.isDown('KeyS')) }
        : null,
      aim: k.mouseDown(2) && k.locked,
    };
  }

  /** Core gameplay step. Only runs while PLAYING. */
  updatePlaying(dt) {
    const input = this.input;
    const look = input.consumeMouseDelta();
    if (input.locked) this.player.look(look.x, look.y);
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

    // Weapons: switching, reload, fire (raycasts use this frame's hitboxes).
    if (input.wasPressed('Digit1') || input.wasPressed('Numpad1')) this.weapons.requestSwitch(0);
    if (input.wasPressed('Digit2') || input.wasPressed('Numpad2')) this.weapons.requestSwitch(1);
    this.weapons.update(
      dt,
      {
        fireHeld: input.mouseDown(0) && input.locked,
        firePressed: input.mouseWasPressed(0) && input.locked,
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
    this.effects.update(dt, this.time);
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
    this.effects?.dispose();
    this.level?.dispose();
    this.audio?.dispose();
    this.renderer?.dispose();
  }
}
