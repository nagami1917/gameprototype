#!/usr/bin/env node
/**
 * tests/run-tests.mjs - automated checks that run in Node without a browser.
 *
 *   npm test
 *
 * Covers: syntax of every module, collision, navigation (A*), map connectivity
 * and spawn validity, wave composition, shotgun falloff and storage.
 * Browser/WebGL behaviour is verified separately with a headless browser.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  if (actual !== expected) throw new Error(`${msg || 'values differ'}: expected ${expected}, got ${actual}`);
}
function assertNear(actual, expected, eps, msg) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${msg || 'not close'}: expected ${expected} +/- ${eps}, got ${actual}`);
  }
}

/* ------------------------------------------------------------------ *
 * In-memory localStorage for storage tests
 * ------------------------------------------------------------------ */
const memory = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  },
};

async function main() {
  console.log('PROJECT: LAST STAND - test suite\n');

  /* ---------------- syntax ---------------- */
  console.log('Syntax');
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  test(`node --check passes for all ${files.length} modules in js/`, () => {
    for (const f of files) {
      execFileSync(process.execPath, ['--check', path.join(JS_DIR, f)], { stdio: 'pipe' });
    }
  });
  test('server.mjs passes node --check', () => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'server.mjs')], { stdio: 'pipe' });
  });

  /* ---------------- collision ---------------- */
  const collision = await import(pathToFileURL(path.join(JS_DIR, 'collision.js')).href);
  const { createBox, boxFromCenter, moveCylinder, isCircleFree, raycastBoxes, hasLineOfSight } = collision;

  console.log('\nCollision');
  test('createBox defaults to an active static box', () => {
    const b = createBox(0, 0, 0, 1, 1, 1);
    assert(b.active === true, 'box should be active');
    assertEqual(b.tag, 'static', 'default tag');
  });

  test('moveCylinder stops at a wall and never enters it', () => {
    const wall = createBox(2, 0, -5, 3, 4, 5, 'wall'); // wall slab at x in [2,3]
    const pos = { x: 0, y: 0, z: 0 };
    moveCylinder(pos, 10, 0, 0.36, 1.8, [wall]);
    assert(pos.x <= 2 - 0.36 + 1e-6, `player passed through the wall (x=${pos.x})`);
    assert(pos.x > 1.4, `player stopped too early (x=${pos.x})`);
  });

  test('moveCylinder slides along a wall', () => {
    const wall = createBox(2, 0, -5, 3, 4, 5, 'wall');
    const pos = { x: 0, y: 0, z: 0 };
    moveCylinder(pos, 3, 2, 0.36, 1.8, [wall]);
    assert(pos.z > 1.5, `expected sliding along z (z=${pos.z})`);
  });

  test('inactive boxes (open doors) do not block movement', () => {
    const door = createBox(2, 0, -5, 3, 4, 5, 'door');
    door.active = false;
    const pos = { x: 0, y: 0, z: 0 };
    moveCylinder(pos, 4, 0, 0.36, 1.8, [door]);
    assertNear(pos.x, 4, 1e-6, 'inactive box should not block');
  });

  test('boxes above the actor head do not block', () => {
    const beam = createBox(-1, 2.5, -1, 1, 4, 1, 'beam');
    const pos = { x: 0, y: 0, z: 0 };
    assert(isCircleFree(0, 0, 0.36, 0, 1.8, [beam]), 'overhead beam should not block a standing actor');
  });

  test('isCircleFree rejects positions overlapping a box', () => {
    const b = boxFromCenter(0, 1, 0, 2, 2, 2);
    assert(!isCircleFree(0, 0, 0.3, 0, 1.8, [b]), 'centre of box should be blocked');
    assert(isCircleFree(5, 5, 0.3, 0, 1.8, [b]), 'far point should be free');
  });

  test('raycastBoxes returns distance and face normal', () => {
    const b = createBox(4, 0, -1, 5, 3, 1, 'wall');
    const hit = raycastBoxes({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 50, [b]);
    assert(hit, 'expected a hit');
    assertNear(hit.distance, 4, 1e-6, 'distance to the near face');
    assertEqual(hit.normal.x, -1, 'normal should face the ray origin');
  });

  test('raycastBoxes respects maxDist and ignores inactive boxes', () => {
    const b = createBox(4, 0, -1, 5, 3, 1, 'wall');
    assert(raycastBoxes({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 3, [b]) === null, 'hit beyond maxDist');
    b.active = false;
    assert(raycastBoxes({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 50, [b]) === null, 'inactive box was hit');
  });

  test('hasLineOfSight is blocked by a wall and clear otherwise', () => {
    const b = createBox(4, 0, -1, 5, 3, 1, 'wall');
    assert(!hasLineOfSight({ x: 0, y: 1, z: 0 }, { x: 8, y: 1, z: 0 }, [b]), 'wall should block sight');
    assert(hasLineOfSight({ x: 0, y: 1, z: 0 }, { x: 8, y: 1, z: 3 }, [b]), 'open line should be visible');
  });

  /* ---------------- player movement ---------------- */
  const THREE = await import('three');
  const { Player } = await import(pathToFileURL(path.join(JS_DIR, 'player.js')).href);
  console.log('\nPlayer movement');

  test('dash moves backward and sideways relative to player facing', () => {
    for (const { dash, axis, sign } of [
      { dash: { x: 0, z: -1 }, axis: 'z', sign: 1 },
      { dash: { x: -1, z: 0 }, axis: 'x', sign: -1 },
      { dash: { x: 1, z: 0 }, axis: 'x', sign: 1 },
    ]) {
      const player = new Player({ camera: new THREE.PerspectiveCamera() });
      player.spawn(0, 0, 0);
      player.update(0.05, { moveX: 0, moveZ: 0, dash }, [], null);
      assert(player.position[axis] * sign > 0.5, `dash should move along ${axis} in direction ${sign}`);
    }
  });

  test('dash spends stamina and covers the boosted distance', () => {
    const player = new Player({ camera: new THREE.PerspectiveCamera() });
    player.spawn(0, 0, 0);
    for (let i = 0; i < 6; i++) {
      player.update(0.05, { moveX: 0, moveZ: 0, dash: i === 0 ? { x: 0, z: -1 } : null }, [], null);
    }
    assertNear(player.stamina, 68, 1e-6, 'dash stamina cost');
    assert(player.position.z > 4.5, `dash should cover a long burst (z=${player.position.z})`);
  });

  test('sprinting drains stamina and stamina regenerates after a delay', () => {
    const player = new Player({ camera: new THREE.PerspectiveCamera() });
    player.spawn(0, 0, 0);
    for (let i = 0; i < 10; i++) {
      player.update(0.1, { moveX: 0, moveZ: 1, sprint: true }, [], null);
    }
    assertNear(player.stamina, 76, 1e-6, 'sprint stamina drain');
    const afterSprint = player.stamina;
    for (let i = 0; i < 9; i++) player.update(0.1, { moveX: 0, moveZ: 0 }, [], null);
    assert(player.stamina > afterSprint, 'stamina should regenerate after the recovery delay');
  });

  /* ---------------- navigation ---------------- */
  const enemyAI = await import(pathToFileURL(path.join(JS_DIR, 'enemyAI.js')).href);
  const { NavGrid } = enemyAI;
  console.log('\nNavigation');

  test('A* routes around a wall with a gap', () => {
    const bounds = { minX: 0, minZ: 0, maxX: 20, maxZ: 20 };
    // Wall across z=10 from x=0 to x=16, leaving a gap at x in [16,20].
    const wall = createBox(0, 0, 9.5, 16, 4, 10.5, 'wall');
    const nav = new NavGrid(bounds, 1, [wall], 0.42);
    const path = nav.findPath(2, 2, 2, 18);
    assert(Array.isArray(path) && path.length > 0, 'expected a path');
    const last = path[path.length - 1];
    assertNear(last.x, 2, 1.01, 'goal x');
    assertNear(last.z, 18, 1.01, 'goal z');
    // Every waypoint must be walkable.
    for (const p of path) assert(nav.isWalkableWorld(p.x, p.z), `waypoint (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) is inside a wall`);
    // The route must pass through the gap.
    const crossing = path.find((p) => p.z > 9 && p.z < 11);
    assert(!crossing || crossing.x > 15.5, 'path crossed the wall outside the gap');
  });

  test('A* returns null when the goal is sealed off', () => {
    const bounds = { minX: 0, minZ: 0, maxX: 20, maxZ: 20 };
    const ring = [
      createBox(5, 0, 5, 15, 4, 6, 'wall'),
      createBox(5, 0, 14, 15, 4, 15, 'wall'),
      createBox(5, 0, 5, 6, 4, 15, 'wall'),
      createBox(14, 0, 5, 15, 4, 15, 'wall'),
    ];
    const nav = new NavGrid(bounds, 1, ring, 0.42);
    assert(nav.findPath(1, 1, 10, 10) === null, 'sealed goal should be unreachable');
  });

  test('nearestWalkable never returns a node inside an obstacle', () => {
    const bounds = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
    const nav = new NavGrid(bounds, 1, [createBox(4, 0, 4, 6, 4, 6, 'wall')], 0.42);
    const idx = nav.nearestWalkable(5, 5, 3);
    assert(idx >= 0, 'expected a walkable node nearby');
    const c = nav.nodeCenter(idx);
    assert(nav.isWalkableWorld(c.x, c.z), 'returned node is not walkable');
  });

  /* ---------------- map ---------------- */
  const level = await import(pathToFileURL(path.join(JS_DIR, 'level.js')).href);
  console.log('\nMap');
  const plan = level.planLayout(level.parseLayout(level.LAYOUT), level.makeRng(2024));
  const cols = plan.cols;
  const rowsN = plan.rows;
  const cellAt = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rowsN ? '#' : plan.grid ? plan.grid[r][c] : level.LAYOUT[r][c]);
  const layoutGrid = level.LAYOUT.map((r) => r.split(''));
  const isWallCell = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rowsN ? true : layoutGrid[r][c] === '#');
  const cellOf = (x, z) => ({ c: Math.floor(x / level.CELL_SIZE), r: Math.floor(z / level.CELL_SIZE) });

  /** BFS over non-wall cells. Doors are passable. */
  function reachableFrom(start) {
    const seen = new Set([`${start.c},${start.r}`]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = cur.c + dc;
        const nr = cur.r + dr;
        const key = `${nc},${nr}`;
        if (seen.has(key) || isWallCell(nc, nr)) continue;
        seen.add(key);
        queue.push({ c: nc, r: nr });
      }
    }
    return seen;
  }

  const startCell = cellOf(plan.playerStart.x, plan.playerStart.z);
  const reach = reachableFrom(startCell);

  test('every floor cell is connected to the player start', () => {
    let floor = 0;
    let unreachable = [];
    for (let r = 0; r < rowsN; r++) {
      for (let c = 0; c < cols; c++) {
        if (isWallCell(c, r)) continue;
        floor++;
        if (!reach.has(`${c},${r}`)) unreachable.push(`${c},${r}`);
      }
    }
    assert(floor > 300, `map seems too small (${floor} floor cells)`);
    assertEqual(unreachable.length, 0, `unreachable floor cells: ${unreachable.slice(0, 5).join(' ')}`);
  });

  test('there are at least 12 spawn points and all are reachable and not in walls', () => {
    assert(plan.spawns.length >= 12, `only ${plan.spawns.length} spawns`);
    for (const s of plan.spawns) {
      const { c, r } = cellOf(s.x, s.z);
      assert(!isWallCell(c, r), `spawn inside a wall at ${c},${r}`);
      assert(reach.has(`${c},${r}`), `spawn unreachable at ${c},${r}`);
    }
  });

  test('spawn points are not placed on the player start', () => {
    for (const s of plan.spawns) {
      const d = Math.hypot(s.x - plan.playerStart.x, s.z - plan.playerStart.z);
      assert(d > 6, `spawn only ${d.toFixed(1)} m from the player start`);
    }
  });

  test('pickup spots are reachable and there are health and ammo pickups', () => {
    assert(plan.healthSpots.length >= 2, 'expected at least 2 health spots');
    assert(plan.ammoSpots.length >= 3, 'expected at least 3 ammo spots');
    for (const p of [...plan.healthSpots, ...plan.ammoSpots]) {
      const { c, r } = cellOf(p.x, p.z);
      assert(reach.has(`${c},${r}`), `pickup unreachable at ${c},${r}`);
    }
  });

  test('doors, flicker lights and emergency lights are present', () => {
    assert(plan.doors.length >= 8, `expected 8+ doors, got ${plan.doors.length}`);
    assert(plan.lights.length >= 6, `expected 6+ flicker lights, got ${plan.lights.length}`);
    assert(plan.emergencyLights.length >= 2, 'expected 2+ emergency lights');
    assert(plan.lights.length + plan.emergencyLights.length <= level.MAX_POINT_LIGHTS + 2,
      'too many point lights for the forward renderer budget');
  });

  test('nav grid marks the player start walkable', () => {
    const nav = level.buildNavGrid(plan);
    assert(nav.isWalkableWorld(plan.playerStart.x, plan.playerStart.z), 'player start is not walkable in the nav grid');
  });

  test('layout rows are rectangular', () => {
    for (const row of level.LAYOUT) assertEqual(row.length, level.LAYOUT[0].length, 'row length');
  });

  /* ---------------- waves ---------------- */
  const wm = await import(pathToFileURL(path.join(JS_DIR, 'waveManager.js')).href);
  const { getWaveConfig, buildWaveQueue } = wm;
  console.log('\nWaves');

  test('wave 1 has 5 infected only', () => {
    const cfg = getWaveConfig(1);
    assertEqual(cfg.total, 5, 'wave 1 total');
    const q = buildWaveQueue(cfg, () => 0.5);
    assertEqual(q.length, 5, 'queue length');
    assert(q.every((t) => t === 'infected'), `unexpected types in wave 1: ${[...new Set(q)]}`);
  });

  test('wave totals increase and are capped at 60', () => {
    let prev = 0;
    for (let w = 1; w <= 30; w++) {
      const t = getWaveConfig(w).total;
      assert(t >= prev, `total decreased at wave ${w}`);
      prev = t;
    }
    assertEqual(getWaveConfig(40).total, 60, 'cap');
  });

  test('runners appear from wave 2 and armored from wave 3', () => {
    assertEqual(getWaveConfig(1).weights.runner, 0, 'runner weight wave 1');
    assert(getWaveConfig(2).weights.runner > 0, 'runner weight wave 2');
    assertEqual(getWaveConfig(2).weights.armored, 0, 'armored weight wave 2');
    assert(getWaveConfig(3).weights.armored > 0, 'armored weight wave 3');
  });

  test('every fifth wave adds an elite armored group', () => {
    assertEqual(getWaveConfig(4).eliteBonus, 0, 'wave 4 elite');
    assertEqual(getWaveConfig(5).eliteBonus, 2, 'wave 5 elite');
    const q = buildWaveQueue(getWaveConfig(5), () => 0.01);
    assertEqual(q.filter((t) => t === 'armored').length >= 2, true, 'elite armored present');
  });

  test('difficulty multipliers grow and respect their caps', () => {
    const early = getWaveConfig(2).multipliers.health;
    const late = getWaveConfig(30).multipliers;
    assert(early > 1 && early < late.health, 'health multiplier should grow');
    assertNear(late.health, 2.2, 1e-9, 'health cap');
    assertNear(late.damage, 1.6, 1e-9, 'damage cap');
    assertNear(late.speed, 1.35, 1e-9, 'speed cap');
  });

  test('maxAlive is capped and clear bonus grows with the wave', () => {
    assertEqual(getWaveConfig(30).maxAlive, 12, 'maxAlive cap');
    assert(getWaveConfig(3).clearBonus > getWaveConfig(2).clearBonus, 'clear bonus should grow');
  });

  /* ---------------- weapons ---------------- */
  const weapon = await import(pathToFileURL(path.join(JS_DIR, 'weapon.js')).href);
  const enemyDefs = await import(pathToFileURL(path.join(JS_DIR, 'enemy.js')).href);
  console.log('\nWeapons');

  test('shotgun falloff: full damage at 7 m, 30% at 26 m, linear between', () => {
    const def = weapon.WEAPON_DEFS.shotgun;
    assertNear(weapon.computeFalloff(def, 0), 1, 1e-9, 'close range');
    assertNear(weapon.computeFalloff(def, 7), 1, 1e-9, 'start of falloff');
    assertNear(weapon.computeFalloff(def, 26), 0.3, 1e-9, 'end of falloff');
    assertNear(weapon.computeFalloff(def, 40), 0.3, 1e-9, 'beyond the end');
    assertNear(weapon.computeFalloff(def, 16.5), 0.65, 1e-9, 'midpoint');
  });

  test('rifle has no distance falloff and both firearms have headshot bonuses', () => {
    assertEqual(weapon.computeFalloff(weapon.WEAPON_DEFS.rifle, 100), 1, 'rifle falloff');
    assert(weapon.WEAPON_DEFS.rifle.headshotMultiplier > 1, 'rifle headshot multiplier');
    assert(weapon.WEAPON_DEFS.shotgun.headshotMultiplier > 1, 'shotgun headshot multiplier');
  });

  test('knife, pipe and axe occupy slots 3-5 with distinct melee profiles', () => {
    assertEqual(weapon.WEAPON_ORDER.join(','), 'rifle,shotgun,knife,pipe,axe', 'stable weapon order');
    const knife = weapon.WEAPON_DEFS.knife;
    const pipe = weapon.WEAPON_DEFS.pipe;
    const axe = weapon.WEAPON_DEFS.axe;
    assertEqual(knife.category, 'melee', 'knife category');
    assertEqual(pipe.category, 'melee', 'pipe category');
    assertEqual(axe.category, 'melee', 'axe category');
    assertEqual(knife.slot, 3, 'knife slot');
    assertEqual(pipe.slot, 4, 'pipe slot');
    assertEqual(axe.slot, 5, 'axe slot');
    assert(knife.damage < pipe.damage && pipe.damage < axe.damage, 'damage should scale from knife to axe');
    assert(knife.attackCooldown < pipe.attackCooldown && pipe.attackCooldown < axe.attackCooldown, 'heavy weapons should swing more slowly');
    assert(pipe.maxTargets > knife.maxTargets, 'pipe should have a wider multi-target sweep');
    for (const def of [knife, pipe, axe]) {
      assert(def.reach > 0 && def.arcDegrees > 0 && def.hitTime < def.attackDuration, `${def.id} needs a valid swing profile`);
      assert(def.magazineSize === undefined && def.startReserve === undefined, `${def.id} must not use ammo`);
      assert(weapon.AMMO_PICKUP[def.id] === undefined, `${def.id} must not receive ammo pickups`);
    }
  });

  test('weapon magazine and pellet counts match the design', () => {
    assertEqual(weapon.WEAPON_DEFS.rifle.magazineSize, 30, 'rifle mag');
    assertEqual(weapon.WEAPON_DEFS.shotgun.magazineSize, 8, 'shotgun mag');
    assertEqual(weapon.WEAPON_DEFS.shotgun.pellets, 9, 'shotgun pellets');
    assert(weapon.WEAPON_DEFS.rifle.auto === true, 'rifle should be automatic');
    assert(weapon.WEAPON_DEFS.shotgun.auto === false, 'shotgun should not be automatic');
  });

  /* ---------------- weapon schema ---------------- */
  console.log('\nWeapon schema');

  test('every def in WEAPON_DEFS passes validateWeaponDef', () => {
    const report = weapon.validateWeaponDefs();
    assert(report.valid, `schema errors:\n       ${report.errors.join('\n       ')}`);
    for (const [id, def] of Object.entries(weapon.WEAPON_DEFS)) {
      const own = weapon.validateWeaponDef(def);
      assert(own.valid, `${id} must validate on its own: ${own.errors.join('; ')}`);
      assertEqual(def.id, id, `${id} id must match its key`);
    }
  });

  test('firearms declare ammo kinds, slot defaults and the reserved tuning fields', () => {
    for (const [id, def] of Object.entries(weapon.WEAPON_DEFS)) {
      assert(weapon.AMMO_KINDS.includes(def.ammoKind) || def.category === 'melee',
        `${id} needs an ammoKind from AMMO_KINDS`);
      assert(def.unlockWave >= 1, `${id} unlockWave`);
      assert(def.moveSpeedMult > 0, `${id} moveSpeedMult`);
      if (def.category === 'firearm') assert(def.adsZoom > 0, `${id} adsZoom`);
      else assertEqual(def.ammoKind, undefined, `${id} is melee and must not carry an ammo kind`);
    }
    assertEqual(weapon.WEAPON_DEFS.rifle.ammoKind, 'rifle', 'rifle ammo kind');
    assertEqual(weapon.WEAPON_DEFS.shotgun.ammoKind, 'shell', 'shotgun ammo kind');
  });

  test('validateWeaponDef reports the broken field instead of throwing', () => {
    const rifle = weapon.WEAPON_DEFS.rifle;
    const knife = weapon.WEAPON_DEFS.knife;
    const bad = (patch) => weapon.validateWeaponDef({ ...rifle, recoil: { ...rifle.recoil }, ...patch });
    const badMelee = (patch) => weapon.validateWeaponDef({ ...knife, ...patch });

    assert(bad({ damage: 0 }).errors.some((e) => e.includes('damage')), 'zero damage');
    assert(bad({ damage: -5 }).errors.some((e) => e.includes('damage')), 'negative damage');
    assert(bad({ startReserve: 10 }).errors.some((e) => e.includes('startReserve')), 'reserve under a magazine');
    assert(bad({ reloadTime: 0 }).errors.some((e) => e.includes('reloadTime')), 'zero reload time');
    assert(bad({ ammoKind: 'plasma' }).errors.some((e) => e.includes('ammoKind')), 'unknown ammo kind');
    assert(bad({ magazineSize: 0 }).errors.some((e) => e.includes('magazineSize')), 'empty magazine');
    assert(bad({ reach: 2 }).errors.some((e) => e.includes('reach')), 'firearm must not define melee fields');
    assert(bad({ slot: 2 }).errors.some((e) => e.includes('shotgun')), 'slot clashes with the default loadout');
    assert(bad({ slot: 4 }).errors.some((e) => e.includes('slot')), 'firearm in a melee slot');
    assert(bad({ slot: 9 }).errors.some((e) => e.includes('slot')), 'slot out of range');
    assert(bad({ headshotMultiplier: 1 }).errors.some((e) => e.includes('headshotMultiplier')), 'no headshot bonus');
    assert(badMelee({ magazineSize: 8 }).errors.some((e) => e.includes('magazineSize')), 'melee must not define a magazine');
    assert(badMelee({ attackCooldown: 0.1 }).errors.some((e) => e.includes('attackCooldown')), 'cooldown inside the swing');
    assert(badMelee({ damage: 'lots' }).errors.some((e) => e.includes('damage')), 'damage must be a number');
    assert(bad({ unlockWave: 0 }).errors.some((e) => e.includes('unlockWave')), 'unlockWave starts at 1');
    assertEqual(bad({}).errors.length, 0, 'an untouched clone is still valid');
  });

  test('sustained DPS of every firearm sits inside the 60-160 band', () => {
    for (const [id, def] of Object.entries(weapon.WEAPON_DEFS)) {
      if (def.category !== 'firearm') {
        assertEqual(weapon.sustainedDps(def), 0, `${id} is melee and has no dps`);
        continue;
      }
      const dps = weapon.sustainedDps(def);
      assert(dps >= 60 && dps <= 160, `${id}: ${dps.toFixed(1)} sustained dps is outside 60-160`);
    }
    // Reference points from the roadmap: the rifle is the yardstick at ~142 and
    // the shotgun trades average dps for burst.
    assertNear(weapon.sustainedDps(weapon.WEAPON_DEFS.rifle), 142, 1, 'rifle sustained dps');
    const shotgun = weapon.WEAPON_DEFS.shotgun;
    assertNear(weapon.sustainedDps(shotgun), 78, 1, 'shotgun sustained dps (whole tube reloaded)');
    // The shotgun's burst is the exception the band ignores: a single shell
    // carries more damage than any other weapon's shot.
    const oneBlast = weapon.magazineDamage(shotgun) / shotgun.magazineSize;
    for (const def of Object.values(weapon.WEAPON_DEFS)) {
      if (def.category !== 'firearm' || def.id === 'shotgun') continue;
      assert(oneBlast > def.damage * (def.pellets || 1), `shotgun blast should out-damage ${def.id}`);
    }
  });

  test('no firearm body-shots an armored infected at wave-1 health', () => {
    const armored = enemyDefs.ENEMY_TYPES.armored;
    const wave1Health = wm.getWaveConfig(1).multipliers.health; // every later wave only adds health
    const health = armored.maxHealth * wave1Health;
    for (const [id, def] of Object.entries(weapon.WEAPON_DEFS)) {
      if (def.category !== 'firearm') continue;
      // Enemy.takeDamage() rounds per hit, so shotguns must be counted pellet
      // by pellet - that is the worst case for the armour, and it still holds.
      const perHit = Math.max(1, Math.round(def.damage * (1 - armored.armor)));
      const triggerDamage = perHit * (def.pellets || 1);
      assert(triggerDamage < health,
        `${id}: one trigger pull deals ${triggerDamage} to armour, which one-shots ${health} hp`);
    }
    // Armour only ever reduces body shots, so headshots remain the answer.
    const rifleHead = weapon.WEAPON_DEFS.rifle.damage * weapon.WEAPON_DEFS.rifle.headshotMultiplier;
    assert(rifleHead > weapon.WEAPON_DEFS.rifle.damage, 'headshots ignore armour and must still beat a body shot');
  });

  test('melee attacks are unlimited, edge-triggered, and blocked by walls', () => {
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              createRadialGradient() { return { addColorStop() {} }; },
              fillRect() {},
            };
          },
        };
      },
    };
    let swings = 0;
    const hits = [];
    const audioStub = {
      playSwitch() {},
      playMeleeSwing() { swings++; },
      playDryFire() {},
      playReload() {},
      playShot() {},
      playHitFlesh() {},
    };
    const effectsStub = { spawnBlood() {}, spawnImpact() {}, spawnTracer() {} };
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.5, 0);
    camera.lookAt(0, 1.5, -1);
    camera.updateMatrixWorld(true);
    const system = new weapon.WeaponSystem({
      camera,
      audio: audioStub,
      effects: effectsStub,
      player: { addRecoil() {}, addTrauma() {} },
      hooks: { onEnemyHit: (info) => { hits.push(info); return { killed: false }; } },
    });
    const enemy = { isTargetable: () => true };
    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1, 0.45), new THREE.MeshBasicMaterial());
    hitbox.position.set(0, 1.5, -1.15);
    hitbox.userData.enemy = enemy;
    hitbox.updateMatrixWorld(true);
    const ctx = {
      canFire: true,
      colliders: [createBox(-1, 1, -0.7, 1, 2, -0.6, 'wall')],
      hitboxes: () => [hitbox],
      speedFactor: 0,
      bobPhase: 0,
    };
    try {
      assert(system.addAmmo(), 'firearms should accept their ammo pickup');
      assertEqual(system.states[0].reserve, 165, 'rifle reserve increased');
      assertEqual(system.states[1].reserve, 42, 'shotgun reserve increased');
      assertEqual(system.requestSwitch(2), true, 'select knife');
      assertEqual(system.startReload(), false, 'melee cannot reload');
      assertEqual(system.getHudData().ammo, null, 'melee has no fake ammo count');

      system.update(0.4, { firePressed: true, fireHeld: true, reloadPressed: true, aim: true }, ctx);
      system.update(0.12, { firePressed: false, fireHeld: true }, ctx);
      assertEqual(hits.length, 0, 'a wall blocks the knife');
      system.update(0.37, { firePressed: false, fireHeld: true }, ctx);
      system.update(0.02, { firePressed: false, fireHeld: true }, ctx);
      ctx.colliders = [];
      system.update(0.02, { firePressed: true, fireHeld: true }, ctx);
      system.update(0.12, { firePressed: false, fireHeld: true }, ctx);
      assertEqual(hits.length, 1, 'a clear knife swing hits once');
      assertEqual(hits[0].weapon, 'knife', 'melee hit reports its weapon id');
      assertEqual(hits[0].headshot, false, 'melee hit does not award an unintended headshot');
      system.update(0.5, { firePressed: false, fireHeld: true }, ctx);
      assertEqual(hits.length, 1, 'holding fire does not auto-repeat melee');
      assertEqual(swings, 2, 'each accepted attack plays one swing sound');
    } finally {
      system.dispose();
      hitbox.geometry.dispose();
      hitbox.material.dispose();
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  });

  /* ---------------- melee swing animation ---------------- */
  const meleeAnim = await import(pathToFileURL(path.join(JS_DIR, 'meleeAnim.js')).href);
  console.log('\nMelee swing');

  /** Runs `fn` with a minimal document stub (the viewmodels create small canvases). */
  function withDocumentStub(fn) {
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return { createRadialGradient() { return { addColorStop() {} }; }, fillRect() {} };
          },
        };
      },
    };
    try {
      return fn();
    } finally {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  }

  function makeMeleeSystem(hitboxes = []) {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.5, 0);
    camera.lookAt(0, 1.5, -1);
    camera.updateMatrixWorld(true);
    const counts = { swings: 0 };
    const hits = [];
    const system = new weapon.WeaponSystem({
      camera,
      audio: {
        playSwitch() {}, playDryFire() {}, playReload() {}, playShot() {}, playHitFlesh() {},
        playMeleeSwing() { counts.swings++; },
      },
      effects: { spawnBlood() {}, spawnImpact() {}, spawnTracer() {} },
      player: { addRecoil() {}, addTrauma() {} },
      hooks: { onEnemyHit: (info) => { hits.push(info); return { killed: false }; } },
    });
    const ctx = { canFire: true, colliders: [], hitboxes: () => hitboxes, speedFactor: 0, bobPhase: 0 };
    return { camera, system, hits, counts, ctx };
  }

  function makeTargetHitbox(z = -1.15) {
    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1, 0.45), new THREE.MeshBasicMaterial());
    hitbox.position.set(0, 1.5, z);
    hitbox.userData.enemy = { isTargetable: () => true };
    hitbox.updateMatrixWorld(true);
    return hitbox;
  }

  test('swing timelines are ordered, the hit window sits inside the strike and cooldowns outlast swings', () => {
    for (const id of ['knife', 'pipe', 'axe']) {
      const def = weapon.WEAPON_DEFS[id];
      const tl = meleeAnim.swingTimeline(def);
      assert(0 < tl.windup && tl.windup < tl.impact && tl.impact < tl.follow && tl.follow < tl.end, `${id} timeline must be ordered`);
      assertNear(tl.end, def.attackDuration, 1e-9, `${id} timeline ends with the attack`);
      assert(def.hitTime > tl.windup && def.hitTime + def.activeTime < tl.follow, `${id} hit window must lie inside the strike`);
      assert(def.attackCooldown > def.attackDuration, `${id} cooldown must outlast the swing`);
    }
  });

  test('swing poses start and end at rest, change smoothly and mirror for backhands', () => {
    const def = weapon.WEAPON_DEFS.knife;
    const rest = meleeAnim.REST_POSE;
    const start = meleeAnim.swingPoseAt(def, 0);
    const end = meleeAnim.swingPoseAt(def, def.attackDuration);
    for (const k of Object.keys(rest)) {
      assertNear(start[k], rest[k], 1e-9, `start ${k}`);
      assertNear(end[k], rest[k], 1e-9, `end ${k}`);
    }
    // No jumps: at 240 Hz no joint moves more than a quarter radian (the fast strike peaks near 0.17).
    let prev = start;
    for (let t = 1 / 240; t <= def.attackDuration; t += 1 / 240) {
      const p = meleeAnim.swingPoseAt(def, t);
      for (const k of Object.keys(rest)) assert(Math.abs(p[k] - prev[k]) < 0.25, `${k} jumps at t=${t.toFixed(3)}`);
      prev = p;
    }
    const tl = meleeAnim.swingTimeline(def);
    const windup = meleeAnim.swingPoseAt(def, tl.windup);
    const impact = meleeAnim.swingPoseAt(def, tl.impact);
    assert(windup.sy < rest.sy && impact.sy > rest.sy, 'forehand winds up on the right and cuts to the left');
    const backhandWindup = meleeAnim.swingPoseAt(def, tl.windup, 'left');
    assertNear(backhandWindup.sy - rest.sy, -(windup.sy - rest.sy), 1e-9, 'backhand mirrors shoulder yaw');
    assertNear(backhandWindup.sr - rest.sr, -(windup.sr - rest.sr), 1e-9, 'backhand mirrors shoulder roll');
    assertNear(backhandWindup.el, windup.el, 1e-9, 'backhand keeps the elbow bend');
    assertNear(backhandWindup.sp, windup.sp, 1e-9, 'backhand keeps shoulder pitch');
  });

  test('the melee weapon is parented to the hand socket and follows the arm through the swing', () => {
    withDocumentStub(() => {
      const { camera, system, ctx } = makeMeleeSystem();
      try {
        system.requestSwitch(2); // knife
        const knife = system.models[2].group;
        assert(knife.parent === system.melee.socket, 'knife must be attached to the hand socket');
        assert(system.models[0].group.parent === camera, 'firearms stay on the camera');
        assert(system.melee.root.visible && !system.models[0].group.visible, 'arm shows for melee, rifle hidden');
        system.update(0.5, {}, ctx); // finish the draw
        system.update(0.001, { firePressed: true }, ctx);
        assert(system.state.attacking, 'swing started');
        const grip = new THREE.Vector3();
        const hand = new THREE.Vector3();
        for (let i = 0; i < 40; i++) {
          system.update(1 / 60, {}, ctx);
          camera.updateMatrixWorld(true);
          knife.getWorldPosition(grip);
          system.melee.socket.getWorldPosition(hand);
          assert(grip.distanceTo(hand) < 1e-6, `grip must stay on the hand (frame ${i})`);
        }
        assert(!system.state.attacking, 'swing ends after its duration');
        system.requestSwitch(0); // back to the rifle: arm hidden, rifle back on the camera
        assert(!system.melee.root.visible, 'arm hidden for firearms');
        assert(system.models[0].group.parent === camera, 'rifle re-attached to the camera');
      } finally {
        system.dispose();
      }
    });
  });

  test('a melee swing damages each enemy at most once, only during its active window', () => {
    withDocumentStub(() => {
      const hitbox = makeTargetHitbox();
      const { system, hits, ctx } = makeMeleeSystem([hitbox]);
      try {
        system.requestSwitch(3); // steel pipe: two-target sweep, so only the struck set prevents repeats
        system.update(0.5, {}, ctx);
        system.update(0.001, { firePressed: true }, ctx);
        const def = weapon.WEAPON_DEFS.pipe;
        let t = 0.001;
        while (t < def.hitTime - 0.02) { system.update(0.02, {}, ctx); t += 0.02; }
        assertEqual(hits.length, 0, 'no hit before the active window opens');
        for (let i = 0; i < 40; i++) system.update(0.01, {}, ctx);
        assertEqual(hits.length, 1, 'one enemy is hit once across the whole active window');
        assertEqual(hits[0].weapon, 'pipe', 'hit reports the pipe');
      } finally {
        system.dispose();
        hitbox.geometry.dispose();
        hitbox.material.dispose();
      }
    });
  });

  test('swings never overlap, respect the cooldown and honour the facing side', () => {
    withDocumentStub(() => {
      const { system, counts, ctx } = makeMeleeSystem();
      try {
        system.requestSwitch(2); // knife
        system.update(0.5, {}, ctx);
        system.update(0.001, { firePressed: true }, ctx);
        assertEqual(system.state.attackFacing, 'right', 'default swing is a forehand');
        system.update(0.1, { firePressed: true, attackPressed: true }, ctx);
        assertEqual(counts.swings, 1, 'a second press mid-swing does not start another swing');
        system.update(0.35, {}, ctx); // the first swing has ended, but the cooldown is still running
        assert(!system.state.attacking, 'first swing ended');
        system.update(0.01, { attackPressed: true }, ctx);
        assertEqual(counts.swings, 1, 'attacks are blocked during the cooldown');
        system.update(0.2, {}, ctx); // cooldown (0.48 s) is now over
        system.update(0.001, { attackPressed: true }, ctx);
        assertEqual(counts.swings, 2, 'a new swing starts once the cooldown has finished');
        assertEqual(system.state.attackFacing, 'right', 'Space swing uses the forehand by default');
        system.update(0.6, {}, ctx);
        system.tryMeleeAttack('left');
        assertEqual(system.state.attackFacing, 'left', 'left facing starts a backhand');
      } finally {
        system.dispose();
      }
    });
  });

  /* ---------------- decals ---------------- */
  const effects = await import(pathToFileURL(path.join(JS_DIR, 'effects.js')).href);
  const { DecalPool, HOLE_LIFETIME, BLOOD_DECAL_LIFETIME, DECAL_FADE_TIME } = effects;
  console.log('\nDecals');

  // A stub scene is enough: the pool only needs add()/remove(), no WebGL context.
  const decalScene = { add() {}, remove() {} };
  const makePool = (count = 4, lifetime = HOLE_LIFETIME) =>
    new DecalPool(decalScene, count, new THREE.MeshBasicMaterial(), 1, lifetime);
  const UP = { x: 0, y: 1, z: 0 };

  const _m = new THREE.Matrix4();
  /**
   * Instance scale of a slot (0 means the decal is not drawn). Read straight
   * off the matrix basis: Matrix4.decompose() reports 1,1,1 for a degenerate
   * (zero-scale) matrix in three r186.
   */
  const scaleOf = (pool, i) => {
    pool.mesh.getMatrixAt(i, _m);
    const e = _m.elements;
    return Math.hypot(e[0], e[1], e[2]);
  };

  test('decals expire after their lifetime and free the slot', () => {
    const pool = makePool();
    try {
      for (let i = 0; i < 3; i++) pool.place({ x: i, y: 0, z: 0 }, UP, 1, 0);
      assertEqual(pool.activeCount, 3, 'three live decals');
      pool.update(HOLE_LIFETIME - 1, null);
      assertEqual(pool.activeCount, 3, 'still alive one second before expiry');
      pool.update(1.1, null);
      assertEqual(pool.activeCount, 0, 'all decals expired');
      for (let i = 0; i < 3; i++) assertEqual(scaleOf(pool, i), 0, `slot ${i} should be hidden`);
    } finally {
      pool.dispose();
    }
  });

  test('decals fade out by shrinking over the fade tail', () => {
    const pool = makePool();
    try {
      pool.place({ x: 0, y: 0, z: 0 }, UP, 2, 0);
      pool.update(HOLE_LIFETIME - DECAL_FADE_TIME * 0.5, null);
      assertNear(scaleOf(pool, 0), 1, 1e-3, 'halfway through the fade tail, scale is half');
      assert(scaleOf(pool, 0) > 0, 'still visible while fading');
      pool.update(DECAL_FADE_TIME, null);
      assertEqual(pool.activeCount, 0, 'gone once the tail is over');
    } finally {
      pool.dispose();
    }
  });

  test('recycling takes expired slots before the newest marks', () => {
    const pool = makePool(4);
    try {
      pool.place({ x: 0, y: 0, z: 0 }, UP, 1, 0);
      pool.place({ x: 1, y: 0, z: 0 }, UP, 1, 0);
      pool.update(HOLE_LIFETIME * 0.5, null); // age the first two
      pool.place({ x: 2, y: 0, z: 0 }, UP, 1, 0);
      pool.place({ x: 3, y: 0, z: 0 }, UP, 1, 0); // pool is now full
      pool.update(HOLE_LIFETIME * 0.5 + 0.1, null); // only the first two expire
      assertEqual(pool.activeCount, 2, 'the two older marks expired');
      // The free-list is a stack, so the two released slots can come back in
      // any order - what matters is that they are the expired ones.
      const reused = [pool.place({ x: 4, y: 0, z: 0 }, UP, 1, 0), pool.place({ x: 5, y: 0, z: 0 }, UP, 1, 0)];
      assert(reused.includes(0) && reused.includes(1), `expected the expired slots 0 and 1, got ${reused}`);
      assertEqual(pool.activeCount, 4, 'the recent marks (slots 2 and 3) were kept');
      assert(pool.alive[2] && pool.alive[3], 'slots 2 and 3 still hold the newest marks');
    } finally {
      pool.dispose();
    }
  });

  test('marks on a door vanish when the panel moves and return when it closes', () => {
    const pool = makePool(4);
    const door = { openAmount: 0 };
    try {
      pool.place({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 1, 0, door);
      pool.update(0.016, [door]);
      assert(scaleOf(pool, 0) > 0, 'closed door keeps its marks');

      door.openAmount = 0.5;
      pool.update(0.016, [door]);
      assertEqual(scaleOf(pool, 0), 0, 'mark is culled as soon as the panel moves');

      // Repeatable: close it, the panel is back where it was, so is the mark.
      door.openAmount = 0;
      pool.update(0.016, [door]);
      assert(scaleOf(pool, 0) > 0, 'mark is restored when the door closes');

      door.openAmount = 1;
      pool.update(0.016, [door]);
      assertEqual(scaleOf(pool, 0), 0, 'mark is culled again on the next open');
    } finally {
      pool.dispose();
    }
  });

  test('marks without an owner ignore door movement', () => {
    const pool = makePool(4);
    const door = { openAmount: 1 };
    try {
      pool.place({ x: 0, y: 0, z: 0 }, UP, 1, 0);                    // floor blood
      pool.place({ x: 2, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 1, 0); // wall
      pool.update(0.016, [door]);
      assert(scaleOf(pool, 0) > 0, 'floor marks are untouched by doors');
      assert(scaleOf(pool, 1) > 0, 'wall marks are untouched by doors');
    } finally {
      pool.dispose();
    }
  });

  test('clear() releases every slot and resets the pool', () => {
    const pool = makePool(4);
    try {
      pool.place({ x: 0, y: 0, z: 0 }, UP, 1, 0);
      pool.place({ x: 1, y: 0, z: 0 }, UP, 1, 0);
      pool.clear();
      assertEqual(pool.activeCount, 0, 'no live decals after a clear');
      for (let i = 0; i < pool.count; i++) assertEqual(scaleOf(pool, i), 0, `slot ${i} hidden`);
      assertEqual(pool.place({ x: 0, y: 0, z: 0 }, UP, 1, 0), 0, 'the pool starts from slot 0 again');
      pool.update(HOLE_LIFETIME + 1, null);
      assertEqual(pool.activeCount, 0, 'lifetimes were reset, so the fresh mark still expires');
    } finally {
      pool.dispose();
    }
  });

  test('blood pools outlive bullet holes', () => {
    assert(BLOOD_DECAL_LIFETIME > HOLE_LIFETIME, 'blood pools should last longer than bullet holes');
    const pool = makePool(4, BLOOD_DECAL_LIFETIME);
    try {
      pool.place({ x: 0, y: 0, z: 0 }, UP, 1, 0);
      pool.update(HOLE_LIFETIME + 1, null);
      assertEqual(pool.activeCount, 1, 'pool uses its own lifetime');
    } finally {
      pool.dispose();
    }
  });

  /* ---------------- storage ---------------- */
  const storage = await import(pathToFileURL(path.join(JS_DIR, 'storage.js')).href);
  console.log('\nStorage');

  test('sanitizeSettings clamps ranges and falls back for bad input', () => {
    const s = storage.sanitizeSettings({ sensitivity: 99, fov: 5, volume: -2, invertY: 'yes' });
    assertEqual(s.sensitivity, 3, 'sensitivity clamp');
    assertEqual(s.fov, 60, 'fov clamp');
    assertEqual(s.volume, 0, 'volume clamp');
    assertEqual(s.invertY, false, 'invertY must be boolean');
    const d = storage.sanitizeSettings({ sensitivity: 'abc' });
    assertEqual(d.sensitivity, storage.DEFAULT_SETTINGS.sensitivity, 'NaN falls back to default');
  });

  test('loadStorage tolerates corrupt JSON and returns defaults', () => {
    memory.set(storage.STORAGE_KEY, '{not json');
    const data = storage.loadStorage();
    assertEqual(data.highScore, 0, 'highScore default');
    assertEqual(data.settings.fov, storage.DEFAULT_SETTINGS.fov, 'settings default');
    memory.delete(storage.STORAGE_KEY);
  });

  test('recordRun keeps the best score and wave and counts runs', () => {
    memory.clear();
    const first = storage.recordRun(storage.loadStorage(), { score: 1200, wave: 3, kills: 20 });
    assert(first.newHighScore && first.newHighWave, 'first run should set records');
    const second = storage.recordRun(first.record, { score: 500, wave: 2, kills: 4 });
    assertEqual(second.record.highScore, 1200, 'high score kept');
    assertEqual(second.record.highWave, 3, 'high wave kept');
    assertEqual(second.record.bestKills, 20, 'best kills kept');
    assertEqual(second.record.runs, 2, 'run count');
    const reloaded = storage.loadStorage();
    assertEqual(reloaded.highScore, 1200, 'persisted high score');
  });

  test('storage failures do not throw', () => {
    const original = globalThis.window.localStorage;
    globalThis.window = { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } };
    try {
      const data = storage.loadStorage();
      assertEqual(data.highWave, 0, 'defaults when storage is blocked');
      assert(storage.saveStorage({ highScore: 1 }) === false, 'save should report failure');
    } finally {
      globalThis.window = { localStorage: original };
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exitCode = 1;
});
