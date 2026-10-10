/**
 * main.js
 * Composition root. Systems do not import each other; this file owns the
 * frame order and turns their events into damage, heals and presentation.
 *
 * Frame order:
 *   look (real time, even in hitstop) → intents → movement → weapons →
 *   enemies → parry → projectiles → style → hud / camera.
 * Hitstop slows only the simulation. Camera and input stay at full rate.
 */
import * as THREE from 'three';
import { CFG, WEAPONS, rankValue } from './config.js';
import { EV, createBus } from './bus.js';
import { createRayHit } from './collision.js';
import { aimDir, applySpread, fillEnv, flatForward, flatRight, integratePlayer } from './movement.js';
import { createPlayer, healPlayer, hurtPlayer, lookPlayer, resetPlayer } from './player.js';
import { createDash, dashRechargeFraction, refillDash, resetDash, tickDash, tryDash } from './dash.js';
import { createSlide, finishSlide, resetSlide, updateSlide } from './slide.js';
import { createParry, fillParrySphere, findParryTarget, markParrySuccess, pressParry, resetParry, tickParry } from './parry.js';
import { createLoadout, cycleSlot, pressSlot, resetLoadout, weaponIndex } from './loadout.js';
import { cancelTransient, createShotBuffer, createWeapons, pointBlankDamage, resetWeapons, updateWeapons } from './weapons.js';
import { createProjectilePool, reflectProjectile, resetProjectiles, spawnProjectile, updateProjectiles } from './projectiles.js';
import { createEnemies, damageEnemy, initialSpawn, resetEnemies, staggerEnemy, updateEnemies } from './enemies.js';
import { bindStyle, createStyle, resetStyle, updateStyle } from './style.js';
import { blastImpulse, createHitBuffer, healAmount, resolveHitscan, shockwaveDamage } from './combat.js';
import { PLAYER_SPAWN } from './arenaData.js';
import { buildArena } from './arena.js';
import { createViews } from './views.js';
import { createInput, sampleInput } from './input.js';
import { bindAudio, createAudio, initAudio, setMuted, setSliding, setVolume } from './audio.js';
import { bindHud, createHud, fillDeath, setMenuBest, showFatal, showScreen, updateHud } from './hud.js';

const SETTINGS_KEY = 'feedback.settings';
const BEST_KEY = 'feedback-best';
const HINTS = [
  'SHIFT dashes. Three charges — they recharge one at a time.',
  'F or Q parries. Punch orange shots back at whoever fired them.',
  'CTRL slides on the ground. In the air it slams.',
  'Scroll or press 1–5. The same key cycles that slot’s variant.',
  'Damage dealt up close heals you. Rail from across the pit does not.',
  'Three wall-jumps, then you need the ground. The east ledge wants one.',
];

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
if (!renderer.getContext()) {
  const fatal = document.getElementById('fatal');
  fatal.hidden = false;
  fatal.textContent = 'WebGL is required to run PROTOCOL: FEEDBACK.';
  throw new Error('no webgl');
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CFG.fov, 1, 0.08, 140);
camera.rotation.order = 'YXZ';
scene.add(camera);

const boxes = buildArena(scene);
const views = createViews(scene, camera);
const bus = createBus();
const player = createPlayer();
const dash = createDash();
const slide = createSlide();
const parry = createParry();
const loadout = createLoadout();
const weapons = createWeapons();
const shots = createShotBuffer();
const projectiles = createProjectilePool(CFG.projectilePool);
const enemies = createEnemies(CFG.enemyPool);
const style = createStyle();
const audio = createAudio();
const env = fillEnv({});
const ray = createRayHit();
const hits = createHitBuffer(12);
const fwd = { x: 0, y: 0, z: 1 };
const right = { x: 1, y: 0, z: 0 };
const aim = { x: 0, y: 0, z: 1 };
const spreadOut = { x: 0, y: 0, z: 1 };
const sphere = { x: 0, y: 0, z: 0, r: 0, fx: 0, fy: 0, fz: 0 };
const impulse = { x: 0, y: 0, z: 0 };
const moveIn = { wishX: 0, wishZ: 0, jumpPressed: false };
const ctl = {
  moveX: 0, moveZ: 0, jumpPressed: false, dash: false, ctrl: false, ctrlPressed: false,
  parry: false, fire: false, firePressed: false, fireReleased: false, reload: false,
  slot: -1, wheel: 0, lookX: 0, lookY: 0, cursorX: 0, cursorY: 0, locked: false, dragging: false,
};
const snap = {
  hp: 100, maxHp: 100, kills: 0, parries: 0, dodges: 0, timeText: '0:00',
  rank: 'D', meter: 0, combo: 0, charges: 3, chargeFrac: 1, wallLeft: 3, airborne: false,
  weaponName: 'PISTOL', variantName: 'CHARGE', ammo: '12', ammoFrac: 1,
  slot: 0, variant: 0, speed: 0, charge: 0, parry: 'ready', spreadPx: 0,
  onTarget: false, iframes: false, hurt: 0, hint: '', showCapture: false,
};
const viewState = {
  player, enemies, projectiles, mode: 'menu', weaponKind: 'pistol', variant: 0,
  equip: 0, parry: 'ready', parryTime: 0, lookX: 0, lookY: 0,
  justLanded: false, slamImpact: false, slamming: false, deathT: 0,
};
const firePayload = { kind: 'pistol', charged: 0 };
const switchPayload = { slot: 0, variant: 0 };
const killPayload = { weaponId: 0, x: 0, y: 0, z: 0, airborne: 0 };
const hitPayload = { weaponId: 0, damage: 0, x: 0, y: 0, z: 0 };
const healPayload = { amount: 0 };
const hurtPayload = { amount: 0 };
const dodgePayload = { id: 0 };
const wallPayload = { left: 3 };
const slamPayload = { x: 0, y: 0, z: 0, hits: 0 };
const parryPayload = { kind: '' };
const fxPayload = { x: 0, y: 0, z: 0, direct: -1, directDamage: 0, splash: 0, radius: 0, weaponId: 0, fxOnly: 1 };
const flags = { parried: false };

let mode = 'menu';
let hitstop = 0;
let timeAlive = 0;
let kills = 0;
let parries = 0;
let dodges = 0;
let dying = false;
let deathDelay = 0;
let orbit = 0.4;
let last = performance.now();

const saved = loadSettings();
const storedBest = loadBest();
const best = {
  rank: storedBest.rank || 'D',
  meter: storedBest.meter || 0,
  kills: storedBest.kills || 0,
};

const input = createInput(canvas, {
  onKeyDown: onKey,
  // A failed or dropped pointer lock is not a pause. The pit stays playable
  // with cursor-offset look and right-drag; ESC is the pause.
  onBlur: () => {
    if (mode === 'playing') pause();
  },
  captureWheel: () => mode === 'playing',
  allowClickFire: () => mode === 'playing',
});
input.sens = clamp(saved.sens ?? 1, 0.3, 2.5);
input.invert = !!saved.invert;

const hud = createHud();
bindHud(hud, bus, (slot) => {
  if (mode !== 'playing') return;
  pressSlot(loadout, slot);
  switched();
});
bindStyle(style, bus);
bindAudio(audio, bus);

bus.on(EV.PARRY_OK, () => {
  flags.parried = true;
  hitstop = CFG.hitstop;
  refillDash(dash);
  parries += 1;
  views.addTrauma(0.16);
});
bus.on(EV.ENEMY_FIRE, (e) => {
  spawnProjectile(projectiles, e);
});
bus.on(EV.EXPLODE, (e) => resolveExplosion(e));
bus.on(EV.THREAT, (e) => resolveThreat(e));
bus.on(EV.DEATH, () => {
  dying = true;
  deathDelay = 0.55;
});
bus.on(EV.IMPACT, (e) => {
  views.burst(e.x, e.y, e.z, 0xffd7a8, 5, 3);
});

wireSettings();
setMenuBest(hud, bestText());
resize();
window.addEventListener('resize', resize);
document.getElementById('btn-play').addEventListener('click', engage);
document.getElementById('btn-resume').addEventListener('click', resume);
document.getElementById('btn-restart').addEventListener('click', () => { initAudio(audio); beginRun(); input.requestLock(); });
document.getElementById('btn-menu').addEventListener('click', beginMenu);
document.getElementById('btn-retry').addEventListener('click', () => { initAudio(audio); beginRun(); input.requestLock(); });
document.getElementById('btn-dead-menu').addEventListener('click', beginMenu);
document.getElementById('capture-hint').addEventListener('click', () => input.requestLock());

if (new URLSearchParams(location.search).has('debug')) {
  window.FEEDBACK = { player, dash, slide, parry, loadout, weapons, enemies, projectiles, style, bus };
}

requestAnimationFrame(frame);

function frame(now) {
  requestAnimationFrame(frame);
  let realDt = (now - last) / 1000;
  last = now;
  if (realDt > 0.05) realDt = 0.05;
  if (!(realDt > 0)) realDt = 0;

  if (mode === 'menu') {
    orbit += realDt * 0.13;
    viewState.mode = 'menu';
    views.update(viewState, realDt);
    camera.position.set(Math.sin(orbit) * 15.5, 5.4, Math.cos(orbit) * 15.5);
    camera.lookAt(0, 1.3, 0);
    renderer.render(scene, camera);
    input.endFrame();
    return;
  }
  if (mode === 'paused' || mode === 'dead') {
    viewState.mode = mode;
    views.update(viewState, realDt);
    renderer.render(scene, camera);
    input.endFrame();
    return;
  }

  let simDt = realDt;
  if (hitstop > 0) {
    hitstop -= realDt;
    simDt = realDt * CFG.hitstopScale;
    if (hitstop < 0) hitstop = 0;
  }
  let stepDt = simDt;
  flags.parried = false;

  sampleInput(input, ctl);
  let lookX = ctl.lookX;
  let lookY = ctl.lookY;
  if (!ctl.locked && !ctl.dragging) {
    const dead = 0.07;
    let ox = ctl.cursorX;
    let oy = ctl.cursorY;
    if (Math.abs(ox) < dead) ox = 0;
    else ox -= Math.sign(ox) * dead;
    if (Math.abs(oy) < dead) oy = 0;
    else oy -= Math.sign(oy) * dead;
    lookX += ox * 900 * realDt;
    lookY += oy * 720 * realDt;
  }
  if (!ctl.locked) {
    const rate = 1100 * realDt;
    if (input.keys.has('ArrowLeft')) lookX -= rate;
    if (input.keys.has('ArrowRight')) lookX += rate;
    if (input.keys.has('ArrowUp')) lookY -= rate;
    if (input.keys.has('ArrowDown')) lookY += rate;
  }
  lookPlayer(player, lookX, lookY, input.sens, input.invert);

  if (!player.alive) {
    if (dying) {
      deathDelay -= realDt;
      viewState.deathT = 1 - Math.max(0, deathDelay) / 0.55;
      if (deathDelay <= 0) finishDeath();
    }
    viewState.mode = 'playing';
    viewState.lookX = lookX;
    viewState.lookY = lookY;
    views.update(viewState, realDt);
    renderer.render(scene, camera);
    input.endFrame();
    return;
  }

  timeAlive += realDt;
  flatForward(player.yaw, fwd);
  flatRight(player.yaw, right);
  let wx = fwd.x * ctl.moveZ + right.x * ctl.moveX;
  let wz = fwd.z * ctl.moveZ + right.z * ctl.moveX;
  const wlen = Math.hypot(wx, wz);
  if (wlen > 1) { wx /= wlen; wz /= wlen; }

  tickDash(dash, simDt);
  updateSlide(slide, simDt, ctl.ctrl, ctl.ctrlPressed, player, boxes);
  if (slide.started) bus.emit(EV.SLIDE, slamPayload);

  let dashed = false;
  if (ctl.dash && tryDash(dash, wx, wz, fwd.x, fwd.z)) {
    dashed = true;
    slide.slamming = false;
    bus.emit(EV.DASH, dodgePayload);
    views.kickFov(CFG.dashFov);
    views.feel.roll = -ctl.moveX * 0.07;
  }

  env.dashActive = dash.active > 0;
  env.dashX = dash.dx;
  env.dashZ = dash.dz;
  env.slamming = slide.slamming;
  env.frictionScale = slide.sliding ? CFG.slideFriction : 1;
  env.forceCrouch = slide.sliding;
  env.slideBoost = slide.boost;
  env.forwardX = fwd.x;
  env.forwardZ = fwd.z;
  moveIn.wishX = wx;
  moveIn.wishZ = wz;
  moveIn.jumpPressed = ctl.jumpPressed;
  integratePlayer(player, simDt, moveIn, env, boxes);
  finishSlide(slide, player, dashed);

  if (player.justWallJump) {
    wallPayload.left = CFG.maxWallKicks - player.wallKicks;
    bus.emit(EV.WALL, wallPayload);
    views.burst(player.x + player.wallNx * 0.3, player.y + 0.5, player.z + player.wallNz * 0.3, 0xd7d1c6, 7, 3);
  } else if (player.justJumped) {
    bus.emit(EV.JUMP, wallPayload);
  }
  if (player.slamImpact) resolveSlam();

  if (ctl.wheel) {
    cycleSlot(loadout, ctl.wheel > 0 ? 1 : -1);
    switched();
  }
  if (ctl.slot >= 0) {
    pressSlot(loadout, ctl.slot);
    switched();
  }

  if (ctl.parry && pressParry(parry, CFG.parryWindow)) bus.emit(EV.PARRY_START, parryPayload);

  const idx = weaponIndex(loadout);
  const allowFire = parry.state !== 'active' && weapons.equip <= 0;
  const fired = updateWeapons(weapons, simDt, ctl, allowFire, idx, shots);
  if (fired.empty) bus.emit(EV.EMPTY, firePayload);
  if (fired.reloadStarted) bus.emit(EV.RELOAD, firePayload);
  if (fired.fired) {
    firePayload.kind = shots.items[0].kind;
    firePayload.charged = shots.items[0].charged;
    bus.emit(EV.FIRE, firePayload);
    views.muzzle();
    resolveShots();
  }

  updateEnemies(enemies, simDt, player, boxes, bus, ray, true);

  if (parry.state === 'active') {
    fillParrySphere(
      player.yaw, player.pitch, player.x, player.y + player.eye, player.z,
      CFG.parryReach, CFG.parryRadius, sphere,
    );
    const hit = findParryTarget(sphere, projectiles, enemies, simDt);
    if (hit.proj >= 0) {
      reflectProjectile(
        projectiles, hit.proj, sphere.fx, sphere.fy, sphere.fz,
        CFG.parrySpeedMul, CFG.parrySpeedMin, CFG.parryDamageMul,
      );
      markParrySuccess(parry, CFG.parrySuccess, CFG.parryInvuln);
      parryPayload.kind = 'projectile';
      bus.emit(EV.PARRY_OK, parryPayload);
      views.burst(sphere.x, sphere.y, sphere.z, 0x3ee0ff, 12, 6);
    } else if (hit.enemy >= 0) {
      staggerEnemy(enemies.list[hit.enemy], CFG.staggerTime);
      markParrySuccess(parry, CFG.parrySuccess, CFG.parryInvuln);
      parryPayload.kind = 'melee';
      bus.emit(EV.PARRY_OK, parryPayload);
      const en = enemies.list[hit.enemy];
      views.burst(en.x, en.y + 1, en.z, 0xfff6ea, 8, 4);
    }
  }
  if (flags.parried) stepDt = realDt * CFG.hitstopScale;
  if (tickParry(parry, stepDt, CFG.parryRecovery, CFG.parrySuccess) === 'whiff') {
    bus.emit(EV.PARRY_WHIFF, parryPayload);
  }

  updateProjectiles(projectiles, stepDt, boxes, enemies, player, bus, ray);
  resolveMelee();
  updateStyle(style, simDt, bus);
  setSliding(audio, slide.sliding);

  publishHud(idx);
  viewState.mode = 'playing';
  viewState.weaponKind = WEAPONS[idx].kind;
  viewState.variant = loadout.variant[loadout.slot];
  viewState.equip = weapons.equip;
  viewState.parry = parry.state;
  viewState.parryTime = parry.time;
  viewState.lookX = lookX;
  viewState.lookY = lookY;
  viewState.justLanded = player.justLanded;
  viewState.slamImpact = player.slamImpact;
  viewState.slamming = slide.slamming;
  viewState.deathT = 0;
  views.update(viewState, realDt);

  const vig = 0.3 + Math.min(0.34, player.speed / 50) + (player.hp < 32 ? 0.18 : 0);
  document.documentElement.style.setProperty('--vig', vig.toFixed(3));
  document.body.classList.toggle('is-dash', dash.active > 0);
  document.body.classList.toggle('is-slam', slide.slamming);
  document.body.classList.toggle('is-slide', slide.sliding);

  input.endFrame();
  renderer.render(scene, camera);
}

function resolveShots() {
  aimDir(player.yaw, player.pitch, aim);
  const ox = player.x;
  const oy = player.y + player.eye;
  const oz = player.z;
  for (let s = 0; s < shots.count; s++) {
    const shot = shots.items[s];
    if (shot.mode === 'projectile') {
      const dir = applySpread(aim.x, aim.y, aim.z, shot.spread, spreadOut);
      spawnProjectile(projectiles, {
        x: ox + dir.x * 0.55,
        y: oy + dir.y * 0.55,
        z: oz + dir.z * 0.55,
        vx: dir.x * shot.speed,
        vy: dir.y * shot.speed,
        vz: dir.z * shot.speed,
        damage: shot.damage,
        radius: shot.radius,
        life: shot.life,
        owner: 0,
        kind: shot.projKind,
        splash: shot.splash,
        splashR: shot.splashR,
        homing: shot.homing,
        weaponId: shot.weaponId,
        flags: 0,
      });
      continue;
    }
    const pellets = shot.pellets || 1;
    const color = shot.kind === 'rail' ? 0x7ef0ff : shot.kind === 'shotgun' ? 0xffe2a8 : 0xfff6d2;
    for (let p = 0; p < pellets; p++) {
      const dir = applySpread(aim.x, aim.y, aim.z, shot.spread, spreadOut);
      const dx = dir.x;
      const dy = dir.y;
      const dz = dir.z;
      resolveHitscan(ox, oy, oz, dx, dy, dz, shot.range, shot.pierce, boxes, enemies, hits, ray);
      views.beam(ox, oy, oz, ray.endX, ray.endY, ray.endZ, color, shot.beam ? 0.12 : 0.04, shot.beam ? 0.055 : 0.012);
      let skip = -1;
      for (let h = 0; h < hits.count; h++) {
        const en = enemies.list[hits.index[h]];
        const dmg = pointBlankDamage(shot.damage, hits.dist[h], shot.pointBlank, shot.pbMul);
        applyEnemyDamage(en, dmg, dx, 0, dz, shot.weaponId, hits.x[h], hits.y[h], hits.z[h]);
        if (!shot.pierce) skip = hits.index[h];
      }
      if (shot.splash > 0) {
        splashOthers(ray.endX, ray.endY, ray.endZ, shot.splash, shot.splashR, shot.weaponId, skip);
        fxPayload.x = ray.endX;
        fxPayload.y = ray.endY;
        fxPayload.z = ray.endZ;
        fxPayload.radius = shot.splashR;
        fxPayload.weaponId = shot.weaponId;
        fxPayload.fxOnly = 1;
        bus.emit(EV.EXPLODE, fxPayload);
        if (blastImpulse(player.x, player.y, player.z, ray.endX, ray.endY, ray.endZ, shot.splashR, 8, impulse)) {
          player.vx += impulse.x;
          player.vy += impulse.y * 0.65;
          player.vz += impulse.z;
        }
      } else if (hits.count === 0) {
        views.burst(ray.endX, ray.endY, ray.endZ, 0xffe2a8, 4, 2.5);
      }
    }
  }
}

function resolveExplosion(e) {
  const x = e.x;
  const y = e.y;
  const z = e.z;
  const direct = e.direct;
  const weaponId = e.weaponId;
  if (e.fxOnly) {
    views.explode(x, y, z);
    return;
  }
  if (e.radius > 0.2) views.explode(x, y, z);
  else views.burst(x, y, z, 0xffe08a, 6, 4);
  if (direct >= 0) {
    const en = enemies.list[direct];
    if (en && en.alive) applyEnemyDamage(en, e.directDamage, en.x - x, 0, en.z - z, weaponId, x, y, z);
  }
  if (e.splash > 0 && e.radius > 0) splashOthers(x, y, z, e.splash, e.radius, weaponId, direct);
  if (e.radius > 0 && blastImpulse(player.x, player.y, player.z, x, y, z, e.radius + 0.4, 13, impulse)) {
    player.vx += impulse.x;
    player.vy += impulse.y;
    player.vz += impulse.z;
    player.onGround = false;
    views.addTrauma(0.22);
  }
}

function splashOthers(x, y, z, splash, radius, weaponId, skip) {
  const list = enemies.list;
  for (let i = 0; i < list.length; i++) {
    if (i === skip) continue;
    const en = list[i];
    if (!en.alive) continue;
    const dx = en.x - x;
    const dy = (en.y + en.height * 0.45) - y;
    const dz = en.z - z;
    const d = Math.hypot(dx, dy, dz);
    if (d >= radius) continue;
    applyEnemyDamage(en, splash * (1 - d / radius), dx, 0, dz, weaponId, en.x, en.y + 0.5, en.z);
  }
}

function resolveSlam() {
  slamPayload.x = player.x;
  slamPayload.y = player.y;
  slamPayload.z = player.z;
  slamPayload.hits = 0;
  const list = enemies.list;
  for (let i = 0; i < list.length; i++) {
    const en = list[i];
    if (!en.alive) continue;
    const dx = en.x - player.x;
    const dy = (en.y + en.height * 0.4) - player.y;
    const dz = en.z - player.z;
    const d = Math.hypot(dx, dy, dz);
    const dmg = shockwaveDamage(d, CFG.slamRadius, CFG.slamDamage);
    if (dmg <= 0) continue;
    slamPayload.hits += 1;
    applyEnemyDamage(en, dmg, dx, 0, dz, -1, en.x, en.y + 0.4, en.z);
  }
  bus.emit(EV.SLAM, slamPayload);
  if (slamPayload.hits > 0) bus.emit(EV.SLAM_HIT, slamPayload);
  views.shockwave(player.x, 0.06, player.z);
  views.addTrauma(CFG.slamShake);
}

function resolveMelee() {
  const list = enemies.list;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.alive || e.state !== 'strike' || e.attackHit) continue;
    const tx = e.x + e.fx * 0.9;
    const ty = e.y + e.height * 0.6;
    const tz = e.z + e.fz * 0.9;
    const dx = player.x - tx;
    const dy = (player.y + 0.8) - ty;
    const dz = player.z - tz;
    if (dx * dx + dy * dy + dz * dz > 1.5 * 1.5) continue;
    e.attackHit = true;
    const len = Math.hypot(dx, dz) || 1;
    hurtPayload.amount = e.damage;
    hurtPayload.x = tx;
    hurtPayload.y = ty;
    hurtPayload.z = tz;
    hurtPayload.id = e.id + 1000;
    hurtPayload.nx = dx / len;
    hurtPayload.nz = dz / len;
    // Reuse the threat listener. Fields are copied inside resolveThreat.
    bus.emit(EV.THREAT, hurtPayload);
  }
}

function resolveThreat(e) {
  if (!player.alive) return;
  const damage = e.damage !== undefined ? e.damage : e.amount;
  const x = e.x;
  const y = e.y;
  const z = e.z;
  const nx = e.nx || 0;
  const nz = e.nz || 0;
  if (dash.iFrames > 0) {
    if (!dash.dodged) {
      dash.dodged = true;
      dodges += 1;
      dodgePayload.id = e.id || 0;
      bus.emit(EV.DODGE, dodgePayload);
    }
    views.burst(x, y, z, 0xb7fff6, 6, 3);
    return;
  }
  if (parry.invuln > 0) return;
  const dealt = hurtPlayer(player, damage);
  if (dealt === 0) return;
  player.vx += nx * 4.2;
  player.vz += nz * 4.2;
  views.addTrauma(0.42);
  hurtPayload.amount = damage;
  bus.emit(EV.HURT, hurtPayload);
  if (dealt < 0) bus.emit(EV.DEATH, hurtPayload);
}

function applyEnemyDamage(en, amount, dx, _dy, dz, weaponId, hx, hy, hz) {
  if (!en || !en.alive || amount <= 0) return;
  const len = Math.hypot(dx, dz) || 1;
  const push = Math.min(7, amount * 0.07);
  const killed = damageEnemy(en, amount, (dx / len) * push, (dz / len) * push, weaponId < 0 ? 0 : weaponId);
  const dist = Math.hypot(player.x - en.x, (player.y + player.eye) - (en.y + en.height * 0.5), player.z - en.z);
  const heal = healAmount(amount, dist, CFG.healRange, CFG.healFraction);
  if (heal > 0) {
    const got = healPlayer(player, heal);
    if (got > 0) {
      healPayload.amount = got;
      bus.emit(EV.HEAL, healPayload);
      views.burst(en.x, en.y + en.height * 0.6, en.z, 0xff3a2f, 4, 2);
    }
  }
  hitPayload.weaponId = weaponId < 0 ? 0 : weaponId;
  hitPayload.damage = amount;
  hitPayload.x = hx;
  hitPayload.y = hy;
  hitPayload.z = hz;
  if (weaponId >= 0) bus.emit(EV.HIT, hitPayload);
  views.burst(hx, hy, hz, 0xffb0a0, 5, 3);
  if (killed) {
    killPayload.weaponId = weaponId < 0 ? 0 : weaponId;
    killPayload.x = en.x;
    killPayload.y = en.y + 0.8;
    killPayload.z = en.z;
    killPayload.airborne = player.airTime > 0.22 ? 1 : 0;
    kills += 1;
    bus.emit(EV.KILL, killPayload);
    views.burst(en.x, en.y + 0.7, en.z, 0xff3a2f, 14, 6);
  }
}

function switched() {
  cancelTransient(weapons);
  switchPayload.slot = loadout.slot;
  switchPayload.variant = loadout.variant[loadout.slot];
  bus.emit(EV.SWITCH, switchPayload);
}

function publishHud(idx) {
  const def = WEAPONS[idx];
  snap.hp = player.hp;
  snap.maxHp = player.maxHp;
  snap.kills = kills;
  snap.parries = parries;
  snap.dodges = dodges;
  snap.timeText = fmtTime(timeAlive);
  snap.rank = style.rank;
  snap.meter = style.meter;
  snap.combo = style.combo;
  snap.charges = dash.charges;
  snap.chargeFrac = dashRechargeFraction(dash);
  snap.wallLeft = CFG.maxWallKicks - player.wallKicks;
  snap.airborne = !player.onGround;
  snap.weaponName = def.name;
  snap.variantName = def.variantName;
  snap.ammo = ammoText(def, idx);
  snap.ammoFrac = ammoFrac(def, idx);
  snap.slot = loadout.slot;
  snap.variant = loadout.variant[loadout.slot];
  snap.speed = player.speed;
  snap.charge = weapons.charging ? weapons.charge : 0;
  snap.parry = parry.state;
  snap.spreadPx = (def.spread || 0) * 240 + weapons.heat * 14;
  snap.onTarget = lookingAtEnemy();
  snap.iframes = dash.iFrames > 0 || parry.invuln > 0;
  snap.hurt = player.hurt;
  snap.hint = timeAlive < 34 ? HINTS[Math.floor(timeAlive / 5.6) % HINTS.length] : '';
  snap.showCapture = !input.locked;
  updateHud(hud, snap);
}

function lookingAtEnemy() {
  aimDir(player.yaw, player.pitch, aim);
  const ox = player.x;
  const oy = player.y + player.eye;
  const oz = player.z;
  const list = enemies.list;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.alive) continue;
    const dx = e.x - ox;
    const dy = (e.y + e.height * 0.55) - oy;
    const dz = e.z - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 40 || dist < 0.2) continue;
    const dot = (dx / dist) * aim.x + (dy / dist) * aim.y + (dz / dist) * aim.z;
    if (dot > 0.992) return true;
  }
  return false;
}

function ammoText(def, idx) {
  if (!def.mag) {
    if (weapons.cooldown[idx] > 0.05) return weapons.cooldown[idx].toFixed(1) + 's';
    return 'READY';
  }
  if (weapons.reloading[idx]) return weapons.mag[idx] + '  RELOAD';
  return String(weapons.mag[idx]);
}

function ammoFrac(def, idx) {
  if (!def.mag) {
    const cd = def.cooldown || 1;
    return 1 - Math.min(1, weapons.cooldown[idx] / cd);
  }
  return weapons.mag[idx] / def.mag;
}

function engage() {
  initAudio(audio);
  beginRun();
  input.requestLock();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function beginRun() {
  resetPlayer(player, PLAYER_SPAWN.x, PLAYER_SPAWN.z, PLAYER_SPAWN.yaw);
  resetDash(dash);
  resetSlide(slide);
  resetParry(parry);
  resetLoadout(loadout);
  resetWeapons(weapons);
  resetProjectiles(projectiles);
  resetEnemies(enemies);
  resetStyle(style);
  initialSpawn(enemies, player, boxes);
  kills = 0;
  parries = 0;
  dodges = 0;
  timeAlive = 0;
  input.scroll.accum = 0;
  hitstop = 0;
  dying = false;
  deathDelay = 0;
  mode = 'playing';
  showScreen(hud, 'playing');
  document.body.classList.remove('is-dash', 'is-slam', 'is-slide');
}

function beginMenu() {
  mode = 'menu';
  dying = false;
  input.releaseLock();
  resetProjectiles(projectiles);
  resetEnemies(enemies);
  showScreen(hud, 'menu');
  setMenuBest(hud, bestText());
}

function pause() {
  if (mode !== 'playing') return;
  mode = 'paused';
  showScreen(hud, 'pause');
}

function resume() {
  if (mode !== 'paused') return;
  mode = 'playing';
  showScreen(hud, 'playing');
  input.requestLock();
}

function finishDeath() {
  if (mode === 'dead') return;
  mode = 'dead';
  input.releaseLock();
  let fresh = false;
  if (rankValue(style.peak) > rankValue(best.rank) || (style.peak === best.rank && style.peakMeter > best.meter)) {
    best.rank = style.peak;
    best.meter = style.peakMeter;
    fresh = true;
  }
  if (kills > best.kills) {
    best.kills = kills;
    fresh = true;
  }
  if (fresh) saveSettings();
  fillDeath(hud, {
    rank: style.peak,
    kills,
    parries,
    dodges,
    timeText: fmtTime(timeAlive),
    note: fresh ? 'NEW BEST' : 'The pit keeps what you dropped.',
  });
  showScreen(hud, 'dead');
  setMenuBest(hud, bestText());
}

function onKey(e) {
  if (e.code === 'Enter' && mode === 'menu') engage();
  else if (e.code === 'Enter' && mode === 'dead') {
    initAudio(audio);
    beginRun();
    input.requestLock();
  } else if (e.code === 'Escape') {
    if (mode === 'playing') {
      input.releaseLock();
      pause();
    } else if (mode === 'paused') resume();
  } else if (e.code === 'KeyM' && mode !== 'menu') {
    setMuted(audio, !audio.muted);
  }
}

function fmtTime(t) {
  const s = Math.floor(Math.max(0, t));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

function bestText() {
  if (!best.kills && best.rank === 'D' && !best.meter) return 'NO RECORD';
  return best.rank + '  ·  ' + best.kills + ' KILLS';
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function loadBest() {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sens: input.sens,
      volume: audio.volume,
      invert: input.invert,
      shake: views.feel.shake > 0,
    }));
    localStorage.setItem(BEST_KEY, JSON.stringify({
      rank: best.rank,
      meter: best.meter,
      kills: best.kills,
    }));
  } catch {
    /* private mode */
  }
}

function wireSettings() {
  const sensEl = document.getElementById('set-sens');
  const volEl = document.getElementById('set-vol');
  const invEl = document.getElementById('set-invert');
  const shakeEl = document.getElementById('set-shake');
  const sensOut = document.getElementById('out-sens');
  const volOut = document.getElementById('out-vol');
  sensEl.value = String(input.sens);
  sensOut.textContent = input.sens.toFixed(2);
  const vol = saved.volume === undefined ? 0.8 : saved.volume;
  audio.volume = vol;
  volEl.value = String(Math.round(vol * 100));
  volOut.textContent = Math.round(vol * 100) + '%';
  invEl.checked = input.invert;
  shakeEl.checked = saved.shake !== false;
  views.setShake(shakeEl.checked);
  sensEl.addEventListener('input', () => {
    input.sens = Number(sensEl.value);
    sensOut.textContent = input.sens.toFixed(2);
    saveSettings();
  });
  volEl.addEventListener('input', () => {
    const v = Number(volEl.value) / 100;
    setVolume(audio, v);
    volOut.textContent = volEl.value + '%';
    saveSettings();
  });
  invEl.addEventListener('change', () => {
    input.invert = invEl.checked;
    saveSettings();
  });
  shakeEl.addEventListener('change', () => {
    views.setShake(shakeEl.checked);
    saveSettings();
  });
}

function resize() {
  const w = window.innerWidth;
  const h = Math.max(1, window.innerHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

window.addEventListener('error', (e) => {
  showFatal(hud, e.message || 'Unable to start');
});
