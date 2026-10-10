#!/usr/bin/env node
/**
 * tests/run-tests.mjs — Node checks for PROTOCOL: FEEDBACK.
 * No browser, no WebGL. Movement, parry, loadout, style and collision.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CFG, ENEMIES, FIST_ID, VARIANTS_PER_SLOT, WEAPONS, rankFor } from '../js/config.js';
import { TUNNEL, WALL_H, createArenaColliders } from '../js/arenaData.js';
import { createBox, fitsHeight, rayCylinderY } from '../js/collision.js';
import { accelerate, fillEnv, integratePlayer } from '../js/movement.js';
import { createPlayer } from '../js/player.js';
import { createDash, refillDash, tickDash, tryDash } from '../js/dash.js';
import { accumulateScroll, createLoadout, cycleSlot, pressSlot, weaponIndex } from '../js/loadout.js';
import { createParry, markParrySuccess, pressParry, tickParry } from '../js/parry.js';
import { addStyle, createStyle, freshnessMul, noteWeaponUse, updateStyle } from '../js/style.js';
import { createBus } from '../js/bus.js';
import { cancelTransient, createShotBuffer, createWeapons, pointBlankDamage, resetWeapons, updateWeapons } from '../js/weapons.js';
import { createProjectilePool, reflectProjectile, spawnProjectile } from '../js/projectiles.js';
import { SPAWN_CLEAR, enemyCap } from '../js/enemies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = path.join(ROOT, 'js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'values differ'}: expected ${expected}, got ${actual}`);
  }
}

function near(actual, expected, eps, msg) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${msg || 'not near'}: expected ${expected} ± ${eps}, got ${actual}`);
  }
}

const ctlIdle = {
  fire: false,
  firePressed: false,
  fireReleased: false,
  reload: false,
};

function freshPlayer() {
  const p = createPlayer();
  p.x = 0;
  p.y = 0;
  p.z = 0;
  p.onGround = true;
  p.coyote = CFG.coyote;
  return p;
}

function step(p, dt, input, env, boxes) {
  integratePlayer(p, dt, input, env, boxes);
}

console.log('syntax');
const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();
assert(files.length > 10, 'expected js modules');
for (const file of files) {
  execFileSync(process.execPath, ['--check', path.join(JS_DIR, file)], { stdio: 'pipe' });
  console.log(`  ok   node --check ${file}`);
}
execFileSync(process.execPath, ['--check', path.join(ROOT, 'server.mjs')], { stdio: 'pipe' });
console.log('  ok   node --check server.mjs');

console.log('\nfeel');

test('accelerate keeps speed already above the wish', () => {
  const r = accelerate(30, 4, 1, 0, 10.2, 78, 0.016);
  assertEqual(r.vx, 30);
  assertEqual(r.vz, 4);
});

test('ground accel does not cancel a dash leftover', () => {
  const p = freshPlayer();
  const env = fillEnv({});
  p.vx = 28;
  p.vz = 0;
  p.onGround = true;
  step(p, 0.016, { wishX: 1, wishZ: 0, jumpPressed: false }, env, []);
  assert(p.vx > 26, `extra speed was cancelled: ${p.vx}`);
});

test('wall kicks cap at 3 and reset on the ground', () => {
  const p = freshPlayer();
  const env = fillEnv({});
  p.y = 3;
  p.onGround = false;
  p.coyote = 0;
  p.touchingWall = true;
  p.wallNx = -1;
  p.wallNz = 0;
  p.wallKicks = 0;
  for (let i = 0; i < 3; i++) {
    p.touchingWall = true;
    p.onGround = false;
    p.coyote = 0;
    p.wallLock = 0;
    p.y = 3;
    step(p, 0.001, { wishX: 0, wishZ: 0, jumpPressed: true }, env, []);
    assert(p.justWallJump, `kick ${i + 1} did not fire`);
  }
  assertEqual(p.wallKicks, 3);
  p.touchingWall = true;
  p.onGround = false;
  p.coyote = 0;
  p.wallLock = 0;
  p.y = 3;
  step(p, 0.001, { wishX: 0, wishZ: 0, jumpPressed: true }, env, []);
  assertEqual(p.wallKicks, 3, 'fourth kick');
  assert(!p.justWallJump, 'fourth kick still launched');

  p.y = 0.05;
  p.vy = -4;
  p.onGround = false;
  p.wallKicks = 3;
  step(p, 0.05, { wishX: 0, wishZ: 0, jumpPressed: false }, env, []);
  assert(p.onGround, 'did not land');
  assertEqual(p.wallKicks, 0);
});

test('coyote floor jump beats a wall kick', () => {
  const p = freshPlayer();
  const env = fillEnv({});
  p.onGround = false;
  p.coyote = CFG.coyote;
  p.touchingWall = true;
  p.wallNx = -1;
  p.y = 0.2;
  const vx = p.vx;
  step(p, 0.001, { wishX: 0, wishZ: 0, jumpPressed: true }, env, []);
  assert(p.justJumped && !p.justWallJump, 'used a wall kick during coyote');
  assertEqual(p.wallKicks, 0);
  near(p.vy, CFG.jumpSpeed, 0.05);
  assertEqual(p.vx, vx);
});

test('dash spends one charge and refills one per 1.5s; parry restores all', () => {
  const d = createDash();
  assertEqual(d.charges, 3);
  assert(tryDash(d, 1, 0, 0, -1));
  assert(tryDash(d, 0, 1, 0, -1) === false, 'second dash while active');
  d.active = 0;
  assert(tryDash(d, 0, 0, 0, -1));
  d.active = 0;
  assert(tryDash(d, -1, 0, 0, -1));
  assertEqual(d.charges, 0);
  assert(tryDash(d, 1, 0, 0, -1) === false);
  tickDash(d, 1.49);
  assertEqual(d.charges, 0, 'recharged early');
  tickDash(d, 0.02);
  assertEqual(d.charges, 1);
  tickDash(d, 1.5);
  assertEqual(d.charges, 2, 'two charges came back in one window');
  refillDash(d);
  assertEqual(d.charges, 3);
  assertEqual(d.recharge, 0);
});

test('slide jump keeps horizontal speed', () => {
  const p = freshPlayer();
  const env = fillEnv({});
  env.frictionScale = CFG.slideFriction;
  p.vx = 22;
  p.vz = -4;
  p.onGround = true;
  p.y = 0;
  step(p, 0.016, { wishX: 0, wishZ: 0, jumpPressed: true }, env, []);
  assert(p.justJumped, 'did not jump');
  assert(p.vx > 21, `slide speed was dumped: ${p.vx}`);
  assert(p.vz < -3.5, `vz dumped: ${p.vz}`);
  assert(p.vy > CFG.jumpSpeed - CFG.gravity * 0.02, `jump was cancelled: ${p.vy}`);
});

test('scroll threshold, one step per event, wraparound', () => {
  const scroll = { accum: 0 };
  assertEqual(accumulateScroll(scroll, 40, 0, CFG.scrollThreshold), 0);
  assertEqual(accumulateScroll(scroll, 40, 0, CFG.scrollThreshold), 1);
  assertEqual(accumulateScroll(scroll, 400, 0, CFG.scrollThreshold), 1, 'free spin skipped');
  assert(Math.abs(scroll.accum) < CFG.scrollThreshold, 'leftover already another slot');
  const loadout = createLoadout();
  loadout.slot = 4;
  assertEqual(cycleSlot(loadout, 1), 0);
  assertEqual(cycleSlot(loadout, -1), 4);
});

test('same slot key cycles variant; a new slot does not', () => {
  const loadout = createLoadout();
  assertEqual(pressSlot(loadout, 0), 'variant');
  assertEqual(loadout.variant[0], 1);
  assertEqual(pressSlot(loadout, 0), 'variant');
  assertEqual(loadout.variant[0], 2);
  assertEqual(pressSlot(loadout, 0), 'variant');
  assertEqual(loadout.variant[0], 0);
  assertEqual(pressSlot(loadout, 3), 'slot');
  assertEqual(loadout.slot, 3);
  assertEqual(loadout.variant[3], 0);
  assertEqual(pressSlot(loadout, 3), 'variant');
  assertEqual(loadout.variant[3], 1);
});

test('weapon table index is slot * 3 + variant', () => {
  assertEqual(WEAPONS.length, 15);
  for (let i = 0; i < WEAPONS.length; i++) {
    assertEqual(WEAPONS[i].slot * VARIANTS_PER_SLOT + WEAPONS[i].variant, i, WEAPONS[i].id);
    const loadout = createLoadout();
    loadout.slot = WEAPONS[i].slot;
    loadout.variant[loadout.slot] = WEAPONS[i].variant;
    assertEqual(weaponIndex(loadout), i);
  }
  assertEqual(FIST_ID, 15);
});

test('parry whiff locks 0.4s; success skips the lock', () => {
  const p = createParry();
  assert(pressParry(p, CFG.parryWindow));
  assert(pressParry(p, CFG.parryWindow) === false, 'buffered a second parry');
  assertEqual(tickParry(p, 0.14, CFG.parryRecovery, CFG.parrySuccess), null);
  assertEqual(p.state, 'active');
  assertEqual(tickParry(p, 0.02, CFG.parryRecovery, CFG.parrySuccess), 'whiff');
  assertEqual(p.state, 'recovery');
  tickParry(p, 0.39, CFG.parryRecovery, CFG.parrySuccess);
  assertEqual(p.state, 'recovery');
  tickParry(p, 0.02, CFG.parryRecovery, CFG.parrySuccess);
  assertEqual(p.state, 'ready');

  const s = createParry();
  pressParry(s, CFG.parryWindow);
  markParrySuccess(s, CFG.parrySuccess, CFG.parryInvuln);
  assertEqual(tickParry(s, 0.01, CFG.parryRecovery, CFG.parrySuccess), null);
  assertEqual(s.state, 'success');
  tickParry(s, CFG.parrySuccess, CFG.parryRecovery, CFG.parrySuccess);
  assertEqual(s.state, 'ready', 'success path took the whiff lock');
});

test('style ranks, idle-only decay, freshness drop', () => {
  assertEqual(rankFor(14.9), 'D');
  assertEqual(rankFor(15), 'C');
  assertEqual(rankFor(29.9), 'C');
  assertEqual(rankFor(30), 'B');
  assertEqual(rankFor(49.9), 'B');
  assertEqual(rankFor(50), 'A');
  assertEqual(rankFor(74.9), 'A');
  assertEqual(rankFor(75), 'S');

  const style = createStyle();
  const bus = createBus();
  addStyle(style, 40, 'KILL', bus);
  updateStyle(style, 0, bus);
  assertEqual(style.rank, 'B');
  const held = style.meter;
  updateStyle(style, 0.2, bus);
  near(style.meter, held, 0.001, 'decayed while still acting');
  style.idle = 0;
  updateStyle(style, 0.5, bus);
  assert(style.meter < held - 5, `idle decay too small: ${style.meter}`);

  const fresh = createStyle();
  const first = noteWeaponUse(fresh, 2, 1);
  const second = noteWeaponUse(fresh, 2, 1);
  assert(second < first, 'repeating a weapon did not lose freshness');
  near(freshnessMul(fresh, 2), 0.28 + 0.72 * fresh.fresh[2], 1e-6);
});

test('point blank only inside range', () => {
  assert(pointBlankDamage(10, 2.5, 2.5, 1.9) > 10, 'on the range edge should still count');
  assert(pointBlankDamage(10, 1.2, 2.5, 1.9) > 10);
  assertEqual(pointBlankDamage(8, 9, 2.5, 1.9), 8);
  assertEqual(pointBlankDamage(8, 0, 0, 1.9), 8);
});

test('reflect doubles damage, owner becomes player, fist id', () => {
  const pool = createProjectilePool(4);
  const id = spawnProjectile(pool, {
    x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: -12,
    damage: 11, radius: 0.2, kind: 0, owner: 1, life: 2,
    splash: 0, splashR: 0, homing: 0, weaponId: 0, flags: 0,
  });
  assert(id >= 0);
  assert(reflectProjectile(pool, id, 0, 0, -1, CFG.parrySpeedMul, CFG.parrySpeedMin, CFG.parryDamageMul));
  assertEqual(pool.owner[id], 0);
  assertEqual(pool.damage[id], 22);
  assertEqual(pool.weapon[id], FIST_ID);
  assertEqual(pool.flags[id] & 1, 1);
  assert(pool.vz[id] < -CFG.parrySpeedMin + 0.01, 'reflect was not boosted');
});

test('overhang rejects a stand and accepts a crouch', () => {
  const boxes = createArenaColliders();
  const x = (TUNNEL.minX + TUNNEL.maxX) * 0.5;
  const z = (TUNNEL.minZ + TUNNEL.maxZ) * 0.5;
  assertEqual(WALL_H, 5.6);
  assert(
    fitsHeight(x, 0, z, CFG.radius, CFG.standHeight, boxes) === false,
    'standing fit under the lip',
  );
  assert(
    fitsHeight(x, 0, z, CFG.radius, CFG.crouchHeight, boxes),
    'crouch did not fit the slide gap',
  );
});

test('a ray that starts inside a cylinder hits at t = 0', () => {
  const t = rayCylinderY(0, 1, 0, 0, 0, 1, 20, 0, 0, 0, 0.4, 1.8);
  assertEqual(t, 0);
});

test('no shots while fire is locked; switch cancels reload but keeps the mag', () => {
  const w = createWeapons();
  resetWeapons(w);
  const shots = createShotBuffer();
  w.cooldown[1] = 0;
  const blocked = updateWeapons(w, 0.016, {
    ...ctlIdle, fire: true, firePressed: true,
  }, false, 1, shots);
  assert(!blocked.fired);
  assertEqual(shots.count, 0);
  assertEqual(w.mag[1], WEAPONS[1].mag, 'locked fire still spent ammo');

  w.mag[1] = 2;
  const started = updateWeapons(w, 0.016, { ...ctlIdle, reload: true }, true, 1, shots);
  assert(started.reloadStarted);
  assertEqual(w.reloading[1], 1);
  cancelTransient(w);
  assertEqual(w.reloading[1], 0);
  assertEqual(w.mag[1], 2);
  assertEqual(w.equip, CFG.equipTime);
});

test('locked numbers the pit is tuned to', () => {
  assertEqual(CFG.wallJumpSpeed, 11.2);
  assertEqual(CFG.wallJumpUp, 9.15);
  assertEqual(CFG.airFriction, 0.04);
  assertEqual(CFG.stopSpeed, 2.2);
  assertEqual(CFG.slideFriction, 0.12);
  assertEqual(CFG.slamBounce, 7.2);
  assertEqual(CFG.dashFov, 14);
  assertEqual(WEAPONS[0].chargeDamage, 46);
  assertEqual(WEAPONS[1].damage, 26);
  assertEqual(WEAPONS[5].damage, 52);
  assertEqual(WEAPONS[6].damage, 82);
  assertEqual(WEAPONS[7].damage, 48);
  assertEqual(WEAPONS[7].splash, 30);
  assertEqual(WEAPONS[14].homing, 4.5);
  assertEqual(CFG.styleKill, 26);
  assertEqual(CFG.styleParry, 34);
  assertEqual(CFG.styleDodge, 16);
  assertEqual(CFG.styleSlam, 12);
  assertEqual(CFG.styleHit, 0.35);
  assertEqual(CFG.styleDecay, 14);
  assertEqual(CFG.styleIdle, 1.05);
  assertEqual(ENEMIES.filth.speed, 7.2);
  assertEqual(ENEMIES.stray.shotSpeed, 12.2);
  assertEqual(ENEMIES.stray.telegraph, 0.28);
  assertEqual(ENEMIES.soldier.hp, 96);
  assertEqual(ENEMIES.soldier.shotSpeed, 17);
  assertEqual(SPAWN_CLEAR, 9);
  assertEqual(enemyCap(0), 2);
  assertEqual(enemyCap(18), 3);
  assertEqual(enemyCap(200), 5);
  const main = fs.readFileSync(path.join(JS_DIR, 'main.js'), 'utf8');
  assert(main.includes("'feedback-best'"), 'best score key drifted');
  assert(main.includes("'feedback.settings'"), 'settings key drifted');
  assert(!main.includes('feedback-settings'), 'old settings key still written');
});

test('arena wall blocks a body and reports contact', () => {
  const p = freshPlayer();
  const env = fillEnv({});
  const wall = createBox(1.2, 0, -2, 2.4, 4, 2, 'wall');
  p.x = 0.9;
  p.y = 0;
  p.vx = 8;
  p.onGround = true;
  step(p, 0.05, { wishX: 0, wishZ: 0, jumpPressed: false }, env, [wall]);
  assert(p.x + p.radius <= wall.minX + 0.02, `passed through wall at ${p.x}`);
  assert(p.touchingWall, 'no wall contact');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  process.exit(1);
}
