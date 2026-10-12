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
  const audio = await import(pathToFileURL(path.join(JS_DIR, 'audio.js')).href);
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

  test('the default loadout mirrors the legacy weapon order and slot categories', () => {
    assertEqual(weapon.DEFAULT_LOADOUT.join(','), weapon.WEAPON_ORDER.join(','), 'default loadout');
    assertEqual(weapon.SLOT_COUNT, 5, 'five slots');
    assertEqual(weapon.SLOT_CATEGORIES.length, weapon.SLOT_COUNT, 'one category per slot');
    weapon.DEFAULT_LOADOUT.forEach((id, i) => {
      assertEqual(weapon.WEAPON_DEFS[id].category, weapon.SLOT_CATEGORIES[i], `slot ${i + 1} accepts the right category`);
      assertEqual(weapon.WEAPON_DEFS[id].slot, i + 1, `${id} keeps its default slot`);
    });
    // The always-carried sidearm takes the key after the loadout slots, so the
    // HUD lists six chips even though the loadout itself is still five keys.
    assertEqual(weapon.hudSlotLabels().join('|'), '1 RIFLE|2 SHOTGUN|3 KNIFE|4 PIPE|5 AXE|6 SIDEARM', 'HUD labels');
  });

  test('sanitizeLoadout drops duplicates, unknown ids and wrong-category picks', () => {
    const clean = weapon.sanitizeLoadout(['shotgun', 'shotgun', 'axe', 'nope', 'axe']);
    assertEqual(clean.length, weapon.SLOT_COUNT, 'always five slots');
    assertEqual(new Set(clean).size, weapon.SLOT_COUNT, 'no weapon occupies two slots');
    assertEqual(clean[0], 'shotgun', 'a legal pick is kept');
    assertEqual(clean[1], 'rifle', 'a duplicate firearm falls back to the default');
    assertEqual(clean[2], 'axe', 'a legal melee pick is kept');
    assertEqual(clean[3], 'pipe', 'an unknown id falls back');
    assertEqual(clean[4], 'knife', 'a duplicate melee falls back to a free weapon');

    // Category bands: a firearm in a melee slot (and the reverse) is rejected.
    assertEqual(weapon.sanitizeLoadout(['axe', 'pipe', 'rifle', 'shotgun', 'knife']).join(','),
      weapon.DEFAULT_LOADOUT.join(','), 'wrong-category picks fall back');
    // Short, missing and nonsense input keeps the rest of the kit.
    assertEqual(weapon.sanitizeLoadout(['shotgun']).join(','), 'shotgun,rifle,knife,pipe,axe', 'short array');
    assertEqual(weapon.sanitizeLoadout(undefined).join(','), weapon.DEFAULT_LOADOUT.join(','), 'undefined input');
    assertEqual(weapon.sanitizeLoadout('rifle').join(','), weapon.DEFAULT_LOADOUT.join(','), 'non-array input');
    assertEqual(weapon.sanitizeLoadout(null, ['nope']).join(','), weapon.DEFAULT_LOADOUT.join(','), 'bogus fallback');
  });

  test('loadoutSlotOptions offers only weapons that fit the slot', () => {
    const slots = weapon.loadoutSlotOptions();
    assertEqual(slots.length, weapon.SLOT_COUNT, 'one entry per key');
    for (const slot of slots) {
      assert(slot.options.length >= 2, `${slot.name} needs choices`);
      for (const option of slot.options) {
        assertEqual(weapon.WEAPON_DEFS[option.id].category, slot.category, `${option.id} in ${slot.name}`);
        assert(option.unlockWave >= 1, `${option.id} carries its unlock wave`);
      }
    }
    assertEqual(slots[0].category, 'firearm', 'slot 1 is a firearm slot');
    assertEqual(slots[2].category, 'melee', 'slot 3 is a melee slot');
    const offered = new Set(slots.flatMap((s) => s.options.map((o) => o.id)));
    // Every weapon is offered somewhere *except* the always-carried ones: there
    // is nothing to choose, they are in the kit either way (weapon.js
    // ALWAYS_CARRIED). The count is derived, so a second always-carried weapon
    // cannot quietly go missing from the screen.
    assertEqual(offered.size, Object.keys(weapon.WEAPON_DEFS).length - weapon.ALWAYS_CARRIED.length,
      'every pickable weapon is offered somewhere');
    for (const id of weapon.ALWAYS_CARRIED) {
      assert(!offered.has(id), `${id} is always carried and must not be a loadout pick`);
    }
  });

  test('the S-9 VIPER and MKR-1 MARKSMAN match the roadmap stats', () => {
    const smg = weapon.WEAPON_DEFS.smg;
    assertEqual(smg.name, 'S-9 VIPER SMG', 'SMG name');
    assertEqual(smg.category, 'firearm', 'SMG category');
    assertEqual(smg.ammoKind, 'rifle', 'SMG shares rifle ammo');
    assertEqual(smg.damage, 15, 'SMG damage');
    assertEqual(smg.fireRate, 14, 'SMG fire rate');
    assertEqual(smg.magazineSize, 35, 'SMG magazine');
    assertEqual(smg.startReserve, 210, 'SMG reserve');
    assertEqual(smg.reloadTime, 1.6, 'SMG reload');
    assertEqual(smg.spread, 0.014, 'SMG spread');
    assertEqual(smg.auto, true, 'SMG is automatic');
    assert(smg.maxBloom > smg.spread, 'SMG bloom must visibly widen the cone');
    assert(smg.switchTime <= 0.3, 'SMG has the fastest draw');
    assert(smg.falloff && smg.falloff.min < 1, 'SMG is a close-mid weapon');

    const dmr = weapon.WEAPON_DEFS.dmr;
    assertEqual(dmr.name, 'MKR-1 MARKSMAN', 'DMR name');
    assertEqual(dmr.category, 'firearm', 'DMR category');
    assertEqual(dmr.ammoKind, 'rifle', 'DMR shares rifle ammo');
    assertEqual(dmr.damage, 68, 'DMR damage');
    assertEqual(dmr.fireRate, 2.2, 'DMR fire rate');
    assertEqual(dmr.magazineSize, 12, 'DMR magazine');
    assertEqual(dmr.startReserve, 72, 'DMR reserve');
    assertEqual(dmr.reloadTime, 2.4, 'DMR reload');
    assertEqual(dmr.headshotMultiplier, 2.5, 'DMR headshot multiplier');
    assertEqual(dmr.range, 200, 'DMR range');
    assertEqual(dmr.penetration, 1, 'DMR penetrates one body');
    assertEqual(dmr.auto, false, 'DMR is semi-automatic');
    assertEqual(dmr.falloff, null, 'DMR has no distance falloff');
    assert(dmr.damage * dmr.headshotMultiplier >= enemyDefs.ENEMY_TYPES.runner.maxHealth,
      'a marksman headshot drops a runner');

    // Tuning guardrails: the two guns must not outclass the originals at what
    // those originals are for.
    const rifle = weapon.WEAPON_DEFS.rifle;
    assert(smg.switchTime < rifle.switchTime, 'the SMG draws faster than the rifle');
    assert(dmr.range > rifle.range, 'the DMR reaches further than the rifle');
    assert(dmr.fireRate < rifle.fireRate && smg.fireRate > rifle.fireRate, 'rate of fire splits the roles');
  });

  test('every firearm has an ammo pickup amount and a shot profile', () => {
    for (const [id, def] of Object.entries(weapon.WEAPON_DEFS)) {
      if (def.category !== 'firearm') {
        assertEqual(weapon.AMMO_PICKUP[id], undefined, `${id} must not receive ammo pickups`);
        continue;
      }
      // Named exemption, not a silent skip: an always-carried weapon never takes
      // a crate - it refills itself at every intermission (refillAlwaysCarried())
      // - so it must have *no* pickup row, and that is asserted here.
      if (weapon.ALWAYS_CARRIED.includes(id)) {
        assertEqual(weapon.AMMO_PICKUP[id], undefined, `${id} is pickup-fed by the intermission refill, not by crates`);
      } else {
        assert(weapon.AMMO_PICKUP[id] > 0, `${id} needs an AMMO_PICKUP amount`);
      }
      const profile = audio.shotProfile(def.sound);
      assert(profile && profile.body, `${id} (sound '${def.sound}') needs a SHOT_PROFILES row`);
    }
    assert(weapon.AMMO_PICKUP.smg > weapon.AMMO_PICKUP.dmr, 'SMG ammo is the common kind');
  });

  test('the rifle and shotgun shot profiles are the ones the game already had', () => {
    const { SHOT_PROFILES, shotProfile } = audio;
    const rifle = SHOT_PROFILES.rifle;
    assertEqual(rifle.noise.length, 2, 'rifle had two noise layers');
    assertEqual(rifle.noise[0].filter, 'bandpass', 'rifle crack filter');
    assertEqual(rifle.noise[0].freq, 1400, 'rifle crack frequency');
    assertEqual(rifle.noise[1].freq, 3500, 'rifle snap frequency');
    assertEqual(rifle.body.f0, 140, 'rifle body blip start');
    assertEqual(rifle.body.f1, 45, 'rifle body blip end');
    assertEqual(rifle.body.decay, 0.12, 'rifle body blip decay');

    const shotgun = SHOT_PROFILES.shotgun;
    assertEqual(shotgun.noise.length, 1, 'shotgun had one noise layer');
    assertEqual(shotgun.noise[0].filter, 'lowpass', 'shotgun boom filter');
    assertEqual(shotgun.noise[0].freq, 2600, 'shotgun boom frequency');
    assertEqual(shotgun.noise[0].sweepTo, 400, 'shotgun boom sweep');
    assertEqual(shotgun.noise[0].decay, 0.28, 'shotgun boom decay');
    assertEqual(shotgun.body.f0, 110, 'shotgun body blip start');

    assertEqual(shotProfile('nope'), rifle, 'an unknown sound falls back to the rifle');
    const signatures = ['rifle', 'shotgun', 'smg', 'dmr'].map((k) => JSON.stringify(SHOT_PROFILES[k]));
    assertEqual(new Set(signatures).size, signatures.length, 'every gun must sound different');
  });

  /**
   * Splash weapons are exempt from the sustained-DPS band *by name*, the same way
   * the shotgun is exempt from the burst comparison below.
   *
   * `sustainedDps()` assumes one trigger pull puts one bullet into one body. A
   * GL-6 round is 140 damage on every enemy inside 4.5 m, so on paper it reads as
   * ~36 dps while in practice it deletes a clump: the number is measuring the
   * wrong thing for this weapon class (docs/Weapons_Roadmap.md §7).
   */
  const SPLASH_DPS_EXEMPT = new Set(['launcher']);

  test('sustained DPS of every firearm sits inside the 60-160 band', () => {
    for (const [id, def] of Object.entries(weapon.WEAPON_DEFS)) {
      if (def.category !== 'firearm') {
        assertEqual(weapon.sustainedDps(def), 0, `${id} is melee and has no dps`);
        continue;
      }
      const dps = weapon.sustainedDps(def);
      if (SPLASH_DPS_EXEMPT.has(id)) {
        // The exemption is deliberate, so it is pinned: the day a splash weapon
        // climbs into the normal band it is no longer a burst weapon.
        assert(dps < 60, `${id} is exempt from the dps band as a burst weapon, but sits at ${dps.toFixed(1)}`);
        continue;
      }
      assert(dps >= 60 && dps <= 160, `${id}: ${dps.toFixed(1)} sustained dps is outside 60-160`);
    }
    // Reference points from the roadmap: the rifle is the yardstick at ~142 and
    // the shotgun trades average dps for burst.
    assertNear(weapon.sustainedDps(weapon.WEAPON_DEFS.rifle), 142, 1, 'rifle sustained dps');
    const shotgun = weapon.WEAPON_DEFS.shotgun;
    assertNear(weapon.sustainedDps(shotgun), 78, 1, 'shotgun sustained dps (whole tube reloaded)');
    // The shotgun's burst is the exception the band ignores: a single shell
    // carries more damage than any other weapon's shot. Splash weapons are out
    // of the comparison for the same reason: one grenade is a 4.5 m explosion
    // and is *meant* to out-damage a shell (the shell still beats every bullet).
    const oneBlast = weapon.magazineDamage(shotgun) / shotgun.magazineSize;
    for (const def of Object.values(weapon.WEAPON_DEFS)) {
      if (def.category !== 'firearm' || def.id === 'shotgun' || SPLASH_DPS_EXEMPT.has(def.id)) continue;
      assert(oneBlast > def.damage * (def.pellets || 1), `shotgun blast should out-damage ${def.id}`);
    }
    assert(weapon.magazineDamage(weapon.WEAPON_DEFS.launcher) > oneBlast,
      'a grenade round is the biggest single hit in the game');
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

  /**
   * A fake 2D context: every draw call is a no-op and gradients hand back a
   * stub with addColorStop(). Pixel reads get a real buffer, so a generator that
   * paints per-pixel noise still runs (it just paints into nothing).
   */
  function makeCanvasContext() {
    const gradient = { addColorStop() {} };
    const noop = () => {};
    return {
      canvas: null,
      fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '',
      save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
      beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, rect: noop,
      arc: noop, ellipse: noop, clip: noop, fill: noop, stroke: noop,
      fillRect: noop, strokeRect: noop, clearRect: noop,
      fillText: noop, strokeText: noop, measureText: () => ({ width: 10 }),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }),
      putImageData: noop,
    };
  }

  /** Runs `fn` with a minimal document stub (viewmodels and decals create small canvases). */
  function withDocumentStub(fn) {
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        const canvas = { width: 0, height: 0, style: {} };
        canvas.getContext = () => {
          const ctx = makeCanvasContext();
          ctx.canvas = canvas;
          return ctx;
        };
        return canvas;
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

  /* ---------------- loadout slots ---------------- */
  console.log('\nLoadout slots');

  /** A WeaponSystem with the minimal stubs, for any loadout. */
  function makeWeaponSystem(loadout) {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.5, 0);
    camera.lookAt(0, 1.5, -1);
    camera.updateMatrixWorld(true);
    const system = new weapon.WeaponSystem({
      camera,
      loadout,
      audio: {
        playSwitch() {}, playDryFire() {}, playReload() {}, playShot() {}, playHitFlesh() {}, playMeleeSwing() {},
      },
      effects: { spawnBlood() {}, spawnImpact() {}, spawnTracer() {} },
      player: { addRecoil() {}, addTrauma() {} },
      hooks: {},
    });
    return { camera, system };
  }

  test('WeaponSystem builds its slots from the loadout, so keys 1-5 follow it', () => {
    withDocumentStub(() => {
      const { camera, system } = makeWeaponSystem(['shotgun', 'rifle', 'axe', 'knife', 'pipe']);
      try {
        assertEqual(system.loadout.join(','), 'shotgun,rifle,axe,knife,pipe', 'loadout applied in order');
        assertEqual(system.states[0].def.id, 'shotgun', 'slot 1 is the shotgun');
        assertEqual(system.states[0].ammo, weapon.WEAPON_DEFS.shotgun.magazineSize, 'ammo state follows the weapon');
        assertEqual(system.models[0].group.parent, camera, 'the shotgun viewmodel is drawn first');
        assertEqual(system.getHudData().slot, 1, 'the HUD shows the live key, not the def slot');

        assertEqual(system.requestSwitch(2), true, 'key 3 works');
        assertEqual(system.def.id, 'axe', 'key 3 draws the axe');
        assertEqual(system.getHudData().slot, 3, 'HUD key');
        assertEqual(system.models[2].group.parent, system.melee.socket, 'melee viewmodels use the arm rig');
        assertEqual(system.requestSwitch(4), true, 'key 5 works');
        assertEqual(system.def.id, 'pipe', 'key 5 draws the pipe');
        // The always-carried sidearm owns the key after the last loadout slot:
        // the kit is five *chosen* weapons plus it. See the milestone-4 tests.
        assertEqual(system.slotCount, weapon.SLOT_COUNT + weapon.ALWAYS_CARRIED.length, 'one key per slot plus the sidearm');
        assertEqual(system.requestSwitch(5), true, 'key 6 works');
        assertEqual(system.def.id, 'pistol', 'key 6 draws the sidearm');
        assertEqual(system.getHudData().slot, 6, 'the sidearm reports its own key');
        assertEqual(system.requestSwitch(6), false, 'there is no key 7');

        system.setLoadout(weapon.DEFAULT_LOADOUT);
        assertEqual(system.loadout.join(','), weapon.DEFAULT_LOADOUT.join(','), 'loadout swapped');
        assertEqual(system.states[0].def.id, 'rifle', 'states rebuilt for the new slots');
        assertEqual(system.index, 0, 'slot 1 is drawn after a swap');
        assertEqual(system.models[1].group.parent, camera, 'every slot is attached again');
      } finally {
        system.dispose();
      }
    });
  });

  test('a custom loadout never leaks a weapon into two slots or the wrong category', () => {
    withDocumentStub(() => {
      const { system } = makeWeaponSystem(['shotgun', 'shotgun', 'axe', 'axe', 'axe']);
      try {
        assertEqual(new Set(system.loadout).size, weapon.SLOT_COUNT, 'every slot holds a different weapon');
        for (let i = 0; i < weapon.SLOT_COUNT; i++) {
          assertEqual(system.states[i].def.category, weapon.SLOT_CATEGORIES[i], `slot ${i + 1} category`);
        }
        const before = system.loadout.join(',');
        system.setLoadout(['nope', 'nope', 'nope', 'nope', 'nope']);
        assertEqual(system.loadout.join(','), before, 'an all-garbage pick keeps the current kit');
      } finally {
        system.dispose();
      }
    });
  });

  test('a loadout change hides the weapons that left the kit: one gun on screen, always', () => {
    withDocumentStub(() => {
      const { camera, system } = makeWeaponSystem();
      try {
        // Every viewmodel is built once and shared, so the only thing that keeps
        // the old kit off the screen is explicit hiding on every rebind.
        const drawn = () => [...system.viewmodels.entries()]
          .filter(([, m]) => m?.group.visible).map(([id]) => id);
        assertEqual(drawn().join(','), 'rifle', 'slot 1 is the only gun drawn at the start');
        assertEqual(system.viewmodels.get('rifle').group.parent, camera, 'the drawn gun hangs off the camera');

        system.setLoadout(['launcher', 'shotgun', 'knife', 'pipe', 'axe']);
        assertEqual(drawn().join(','), 'launcher', 'the rifle left the kit and must leave the screen');

        system.setLoadout(['smg', 'dmr', 'axe', 'pipe', 'knife']);
        assertEqual(drawn().join(','), 'smg', 'two swaps in a row still leave exactly one gun drawn');
        for (const [id, model] of system.viewmodels) {
          if (id === 'smg') continue;
          assert(!model.group.visible, `${id} must not be visible after the swap`);
          // Kept in the scene graph on purpose: prewarmShaders() compiles every
          // viewmodel at startup, and three only compiles attached objects.
          assert(model.group.parent !== null, `${id} must stay attached so its shader stays compiled`);
        }

        // A weapon that comes back into the kit is drawn again, and the gun it
        // replaced goes away.
        assertEqual(system.requestSwitch(2), true, 'switch to the axe');
        assertEqual(drawn().join(','), 'axe', 'only the drawn melee weapon is visible');
        assertEqual(system.models[2].group.parent, system.melee.socket, 'and it is on the hand socket');
        assertEqual(system.viewmodels.get('smg').group.visible, false, 'the SMG is hidden while the axe is out');

        // Menu / death hiding must survive a loadout change in either order.
        system.setVisible(false);
        system.setLoadout(weapon.DEFAULT_LOADOUT);
        assertEqual(drawn().join(','), '', 'nothing is drawn while the viewmodel is hidden');
        system.setVisible(true);
        assertEqual(drawn().join(','), 'rifle', 'showing the viewmodel brings back only the drawn slot');
      } finally {
        system.dispose();
      }
    });
  });

  /* ---------------- new firearms ---------------- */
  console.log('\nNew firearms');

  /** A system drawn on the DMR (slot 2) with one target box per enemy down -Z. */
  function makeRange(loadout = ['rifle', 'dmr', 'knife', 'pipe', 'axe'], slot = 1) {
    const { system } = makeWeaponSystem(loadout);
    const hits = [];
    const impulses = [];
    const nearEnemy = { isTargetable: () => true, name: 'near' };
    const farEnemy = { isTargetable: () => true, name: 'far' };
    const target = (z, enemy) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1, 0.45), new THREE.MeshBasicMaterial());
      mesh.position.set(0, 1.5, z);
      mesh.userData.enemy = enemy;
      mesh.updateMatrixWorld(true);
      return mesh;
    };
    const near = target(-2, nearEnemy);
    const far = target(-6, farEnemy);
    system.hooks.onEnemyHit = (info) => { hits.push(info); return { killed: false }; };
    system.effects.spawnImpact = (point, normal, surface, owner) => impulses.push({ point, surface, owner });
    const ctx = { canFire: true, colliders: [], hitboxes: () => [near, far], speedFactor: 0, bobPhase: 0, dt: 0 };
    system.requestSwitch(slot);
    system.update(0.7, {}, ctx); // finish the draw
    return { system, hits, impulses, ctx, nearEnemy, farEnemy };
  }

  test('every weapon id has a viewmodel, and the new guns have muzzle anchors', () => {
    withDocumentStub(() => {
      const { system } = makeWeaponSystem();
      try {
        for (const id of weapon.WEAPON_IDS) {
          const model = system.viewmodels.get(id);
          assert(model && model.group, `${id} needs a viewmodel`);
        }
        for (const id of ['rifle', 'shotgun', 'smg', 'dmr', 'pistol']) {
          const model = system.viewmodels.get(id);
          assert(model.muzzle, `${id} needs a muzzle marker for its flash sprite`);
          assert(model.flash?.isSprite, `${id} needs a muzzle flash sprite`);
          assert(model.barrelLength > 0.2, `${id} barrel length`);
        }
        // Every melee weapon has to offer the arm rig a grip point and a blade
        // trail, and it is attached to the hand socket from the start: a viewmodel
        // that is never in a loadout still has to be in the scene graph for
        // prewarmShaders() to compile it.
        for (const id of ['knife', 'pipe', 'axe', 'machete', 'sledge']) {
          const model = system.viewmodels.get(id);
          assert(model.grip && model.trail, `${id} needs a grip point and a trail for the arm rig`);
          assertEqual(model.group.parent, system.melee.socket, `${id} starts the run on the hand socket`);
        }
        // The parametric builder merges its primitives per material, so a
        // spec with 15 parts is still a handful of meshes.
        const materials = new Set();
        let meshes = 0;
        system.viewmodels.get('dmr').group.traverse((o) => {
          if (!o.isMesh) return;
          meshes++;
          materials.add(o.material);
        });
        // 15 primitives in the spec, merged down to one mesh per palette colour.
        assert(meshes <= 4, `DMR should merge its parts (got ${meshes} meshes)`);
        assert(materials.size <= 3, `DMR should reuse its palette (got ${materials.size} materials)`);
      } finally {
        system.dispose();
      }
    });
  });

  test('traceRay penetrates one body, reports where the round stopped, and is unchanged otherwise', () => {
    withDocumentStub(() => {
      const { system, ctx } = makeRange();
      try {
        const origin = new THREE.Vector3(0, 1.5, 0);
        const dir = new THREE.Vector3(0, 0, -1);
        const pierced = system.traceRay(origin, dir, 200, ctx, ctx.hitboxes(), 1);
        assertEqual(pierced.type, 'enemy', 'the nearest body is the primary hit');
        assertEqual(pierced.pierced.length, 1, 'the body behind it is pierced');
        assert(pierced.pierced[0].distance > pierced.distance, 'the pierced hit is further away');
        assertEqual(pierced.behind.type, 'miss', 'nothing stopped the round inside its range');

        // Without penetration the ray behaves exactly as before.
        const single = system.traceRay(origin, dir, 200, ctx, ctx.hitboxes());
        assertEqual(single.type, 'enemy', 'default trace still stops on a body');
        assertEqual(single.pierced, undefined, 'default trace builds no pierced list');
        assertEqual(single.behind, undefined, 'default trace builds no behind result');

        // A wall between the two bodies ends the round there.
        ctx.colliders = [createBox(-3, 0, -4.2, 3, 4, -3.8, 'wall')];
        const blocked = system.traceRay(origin, dir, 200, ctx, ctx.hitboxes(), 1);
        assertEqual(blocked.pierced.length, 0, 'a wall stops the round');
        assertEqual(blocked.behind.type, 'world', 'the wall is what stopped it');
        assertNear(blocked.behind.distance, 3.8, 0.01, 'wall distance');
        assertEqual(blocked.behind.surface, 'concrete', 'wall surface drives the decal');
        assertEqual(blocked.behind.owner, null, 'static walls own no decals');
      } finally {
        system.dispose();
      }
    });
  });

  test('a DMR shot deals 60% behind the first body and still marks the wall', () => {
    withDocumentStub(() => {
      const { system, hits, impulses, ctx } = makeRange();
      try {
        system.update(0.016, { firePressed: true }, ctx);
        assertEqual(hits.length, 2, 'one trigger pull hits two bodies');
        assertEqual(hits[0].weapon, 'dmr', 'the hit reports the marksman');
        assertEqual(hits[0].damage, 68, 'the first body takes full damage');
        assertNear(hits[1].damage, 68 * weapon.PENETRATION_DAMAGE_MULT, 1e-9, 'the body behind takes 60%');
        assertEqual(hits[1].distance > hits[0].distance, true, 'the pierced body is further away');
        assertEqual(impulses.length, 0, 'nothing was hit behind the bodies, so no impact');

        // Wall right behind the pair: the round still stops there and marks it.
        ctx.colliders = [createBox(-3, 0, -7.5, 3, 4, -7.2, 'wall')];
        system.update(0.7, {}, ctx); // clear the cooldown
        system.update(0.016, { firePressed: true }, ctx);
        assertEqual(hits.length, 4, 'the wall does not block the two bodies in front of it');
        assertEqual(impulses.length, 1, 'the wall behind the bodies takes the decal');
        assertNear(impulses[0].point.z, -7.2, 0.05, 'decal sits on the wall face');
      } finally {
        system.dispose();
      }
    });
  });

  test('the SMG sprays faster than the rifle, blooms hard and hits for its 15 a round', () => {
    withDocumentStub(() => {
      // One second of held trigger at 60 fps, once with each automatic weapon.
      const spray = (loadout) => {
        const { system, hits, ctx } = makeRange(loadout, 0);
        for (let i = 0; i < 60; i++) system.update(1 / 60, { fireHeld: true }, ctx);
        const result = { shots: system.shotCount, ammo: system.state.ammo, hits, bloom: system.bloom, system };
        return result;
      };
      const smg = spray(['smg', 'shotgun', 'knife', 'pipe', 'axe']);
      const rifle = spray(['rifle', 'shotgun', 'knife', 'pipe', 'axe']);
      try {
        // 14 rounds a second cannot land 14 times in 60 frames, but it must beat
        // the rifle's 9.5/s comfortably and stay inside the rated rate.
        assert(smg.shots > rifle.shots, `SMG (${smg.shots}) must out-fire the rifle (${rifle.shots})`);
        assert(smg.shots >= 11 && smg.shots <= 14, `SMG fired ${smg.shots} rounds in a second`);
        assertEqual(smg.ammo, 35 - smg.shots, 'every round comes out of the magazine');
        assert(smg.hits.length > 0 && smg.hits.every((h) => h.damage === 15), 'SMG body shots are 15');
        assert(smg.bloom > 0, 'the cone widens while the trigger is held');
        assert(smg.bloom <= weapon.WEAPON_DEFS.smg.maxBloom, 'bloom is capped');
      } finally {
        smg.system.dispose();
        rifle.system.dispose();
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

  /* ---------------- projectiles ---------------- */
  const projectiles = await import(pathToFileURL(path.join(JS_DIR, 'projectiles.js')).href);
  const { ProjectileSystem, MAX_PROJECTILES, SELF_DAMAGE_MULT } = projectiles;
  console.log('\nProjectiles');

  const stubScene = () => ({ add() {}, remove() {} });

  /**
   * Blast hooks in the shape the game wires up: hits are resolved with the same
   * armour + rounding rules Enemy.takeDamage() uses (body shots only), so the
   * kill counts in these tests are the real ones.
   */
  function makeBlastHooks() {
    const hits = [];
    const selfHits = [];
    const blasts = [];
    return {
      hits,
      selfHits,
      blasts,
      onEnemyHit: (info) => {
        const enemy = info.enemy;
        let dealt = info.damage;
        if (enemy.type?.armor) dealt *= 1 - enemy.type.armor;
        dealt = Math.max(1, Math.round(dealt));
        enemy.health -= dealt;
        const killed = enemy.health <= 0;
        hits.push({ enemy, damage: info.damage, dealt, distance: info.distance, weapon: info.weapon, killed });
        return { killed };
      },
      onPlayerHit: (info) => selfHits.push(info),
      onExplode: (info) => blasts.push(info),
    };
  }

  /** Enemy stub with the real type stats, so heights/radii/health are honest. */
  function makeEnemyAt(x, z, typeId = 'infected') {
    const type = enemyDefs.ENEMY_TYPES[typeId];
    return { position: { x, y: 0, z }, type, health: type.maxHealth, isTargetable: () => true };
  }

  const makeProjectileSystem = (opts = {}) =>
    new ProjectileSystem(stubScene(), { effects: null, audio: null, ...opts });

  /** A target box straight ahead, for proving a weapon does *not* raycast. */
  function makeTargetBox(z = -4) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1, 0.45), new THREE.MeshBasicMaterial());
    box.position.set(0, 1.5, z);
    box.userData.enemy = { isTargetable: () => true };
    box.updateMatrixWorld(true);
    return box;
  }

  test('the projectile pool holds 8 rounds, fills in order and recycles oldest-first', () => {
    const sys = makeProjectileSystem();
    try {
      assertEqual(MAX_PROJECTILES, 8, 'the roadmap caps live grenades at 8');
      assertEqual(sys.instanceCount, MAX_PROJECTILES, 'one instance slot per live round');
      assertEqual(sys.liveCount, 0, 'the pool starts empty');
      assertEqual(sys.mesh.count, 0, 'an empty pool is not drawn at all');
      const slots = [];
      for (let i = 0; i < 12; i++) {
        slots.push(sys.spawn({
          origin: { x: i, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 },
          speed: 12, damage: 140, splashRadius: 4.5, fuse: 10,
        }));
        assert(sys.liveCount <= MAX_PROJECTILES, `live count passed the cap (${sys.liveCount})`);
      }
      assertEqual(sys.liveCount, MAX_PROJECTILES, 'the pool is full, and no bigger');
      assertEqual(sys.mesh.count, MAX_PROJECTILES, 'a live round draws the whole pool');
      assertEqual(slots.slice(0, 8).join(','), '0,1,2,3,4,5,6,7', 'slots are handed out in order');
      assertEqual(slots[8], 0, 'the ninth round recycles the oldest slot');
      assertEqual(slots[11], 3, 'and carries on round the ring');
      assertEqual(sys.instanceCount, MAX_PROJECTILES, 'the pool never grew');
      sys.clear();
      assertEqual(sys.mesh.count, 0, 'an emptied pool stops being drawn');
    } finally {
      sys.dispose();
    }
  });

  test('a round detonates when its fuse runs out, exactly once', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 },
        speed: 10, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 0.5, range: 1000,
      });
      sys.update(0.4, [], [], hooks);
      assertEqual(sys.liveCount, 1, 'still flying before the fuse burns out');
      assertEqual(hooks.blasts.length, 0, 'no blast yet');
      sys.update(0.2, [], [], hooks);
      assertEqual(sys.liveCount, 0, 'the fuse took the round');
      assertEqual(hooks.blasts.length, 1, 'one blast');
      // The fuse is checked before the frame's movement, so it goes off where it
      // was when the second frame began (0.4 s of flight at 10 m/s).
      assertNear(hooks.blasts[0].point.x, 4, 0.5, 'detonation position');
      assertEqual(sys.instanceCount, MAX_PROJECTILES, 'the pool is unchanged');
      sys.update(1, [], [], hooks);
      assertEqual(hooks.blasts.length, 1, 'a spent round does not go off twice');
    } finally {
      sys.dispose();
    }
  });

  test('a round bounces off walls and closed door panels, and flies through an open one', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      const wall = createBox(4, 0, -3, 5, 4, 3, 'wall');
      sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 },
        speed: 20, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 10, range: 1000,
      });
      for (let i = 0; i < 60; i++) sys.update(1 / 60, [wall], [], hooks);
      assertEqual(sys.liveCount, 1, 'it is still bouncing, not detonating');
      assert(sys.px[0] < 4, `the round went through the wall (x=${sys.px[0]})`);
      assert(sys.vx[0] < 0, 'the wall reversed its velocity');

      // A closed door panel is an active box: it bounces off that too.
      const door = { openAmount: 0 };
      const panel = createBox(4, 0, -3, 4.3, 4, 3, 'door');
      panel.owner = door;
      sys.clear();
      sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 },
        speed: 20, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 10, range: 1000,
      });
      for (let i = 0; i < 60; i++) sys.update(1 / 60, [panel], [], hooks);
      assert(sys.px[0] < 4, 'the closed panel stopped the round');
      assertEqual(sys.contactOwner[0], door, 'the round remembers the surface it bounced off');

      // The same panel retracted (inactive) lets the round through: it is an
      // open doorway in the level, not a wall.
      panel.active = false;
      sys.clear();
      sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 },
        speed: 20, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 10, range: 1000,
      });
      for (let i = 0; i < 60; i++) sys.update(1 / 60, [panel], [], hooks);
      assert(sys.px[0] > 5, `an open door must not stop a grenade (x=${sys.px[0]})`);
    } finally {
      sys.dispose();
    }
  });

  test('update() keeps every object it started with: no per-frame allocation', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      const slot = sys.spawn({
        origin: { x: 0, y: 1.5, z: 0 }, dir: { x: 1, y: 0, z: 0 },
        speed: 20, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 600, range: 1e6,
      });
      const identity = {
        mesh: sys.mesh,
        instanceMatrix: sys.mesh.instanceMatrix,
        matrixArray: sys.mesh.instanceMatrix.array,
        geometry: sys.mesh.geometry,
        material: sys.material,
        px: sys.px,
        vx: sys.vx,
        fuse: sys.fuse,
        owner: sys.owner,
        contactOwner: sys.contactOwner,
        hits: hooks.hits,
      };
      const empty = [];
      for (let i = 0; i < 600; i++) sys.update(1 / 60, [], empty, hooks);
      assertEqual(sys.liveCount, 1, 'the round is still in the air after 10 s');
      assert(sys.px[slot] > 100, `the round actually flew (x=${sys.px[slot].toFixed(1)})`);
      assertEqual(sys.mesh, identity.mesh, 'same InstancedMesh');
      assertEqual(sys.mesh.instanceMatrix, identity.instanceMatrix, 'same matrix attribute');
      assertEqual(sys.mesh.instanceMatrix.array, identity.matrixArray, 'same matrix buffer');
      assertEqual(sys.mesh.geometry, identity.geometry, 'same geometry');
      assertEqual(sys.material, identity.material, 'same material');
      assertEqual(sys.px, identity.px, 'same position buffer');
      assertEqual(sys.vx, identity.vx, 'same velocity buffer');
      assertEqual(sys.fuse, identity.fuse, 'same fuse buffer');
      assertEqual(sys.owner, identity.owner, 'same owner array');
      assertEqual(sys.contactOwner, identity.contactOwner, 'same contact array');
      assertEqual(hooks.hits.length, 0, 'nothing was damaged on the way');
      assertEqual(hooks.blasts.length, 0, 'nothing detonated on the way');
      assertEqual(sys.instanceCount, MAX_PROJECTILES, 'the pool did not grow');
    } finally {
      sys.dispose();
    }
  });

  test('20k empty frames do not grow the heap (coarse guard on the tight loop)', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      const colliders = [createBox(4, 0, -3, 5, 4, 3, 'wall')];
      const enemies = [makeEnemyAt(2, 0)];
      for (let i = 0; i < 500; i++) sys.update(1 / 60, colliders, enemies, hooks); // warm up
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 20000; i++) sys.update(1 / 60, colliders, enemies, hooks);
      const growth = process.memoryUsage().heapUsed - before;
      // One small object per frame would be ~1 MB here; 512 kB leaves room for
      // engine noise while still failing loudly on a real per-frame allocation.
      assert(growth < 512 * 1024, `20k empty frames grew the heap by ${(growth / 1024).toFixed(0)} kB`);
    } finally {
      sys.dispose();
    }
  });

  test('splash hits what it can see and ignores anything behind cover', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      // Blast at the origin: one enemy in the open, one behind a wall. Both sit
      // inside the blast radius, so only line of sight can separate them.
      const near = makeEnemyAt(1.5, 0);
      const edge = makeEnemyAt(-4, 0);
      const behindWall = makeEnemyAt(3.6, 0);
      const wall = createBox(2, 0, -2, 3, 4, 2, 'wall');
      sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 1, z: 0 },
        speed: 0, damage: 140, splashRadius: 4.5, fuse: 0.01, range: 1000,
      });
      sys.update(0.02, [wall], [near, edge, behindWall], hooks);
      assertEqual(hooks.blasts.length, 1, 'the round went off');
      assertEqual(hooks.hits.length, 2, 'the two enemies in the open were caught');
      const byEnemy = new Map(hooks.hits.map((h) => [h.enemy, h]));
      assert(byEnemy.has(near) && byEnemy.has(edge), 'both visible enemies took damage');
      assert(!byEnemy.has(behindWall), 'a wall must stop the blast entirely');
      // Falloff: close hurts more than the rim.
      assert(byEnemy.get(near).damage > byEnemy.get(edge).damage, 'damage falls off with distance');
      const expectedNear = 140 * (1 - 0.75 * (1.5 / 4.5));
      assertNear(byEnemy.get(near).damage, expectedNear, 0.05, 'damage falls off linearly to 25% at the rim');
      assert(byEnemy.get(near).damage >= enemyDefs.ENEMY_TYPES.infected.maxHealth,
        'a body 1.5 m from the blast dies');
      assertEqual(byEnemy.get(near).weapon, 'launcher', 'the hit reports the launcher');
      assertEqual(hooks.hits.length, 2, 'nothing else was touched');
    } finally {
      sys.dispose();
    }
  });

  test('one round clears a clump of infected but spares the ones behind a wall', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      const clump = [
        makeEnemyAt(0.8, 0.4),
        makeEnemyAt(-1.1, -0.6),
        makeEnemyAt(0.4, -1.4),
        makeEnemyAt(-0.7, 1.1),
        makeEnemyAt(1.6, 1.2, 'runner'),
      ];
      const shielded = makeEnemyAt(3.6, 0); // inside the blast radius, behind a wall
      const wall = createBox(2, 0, -2, 3, 4, 2, 'wall');
      sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 1, z: 0 },
        speed: 0, damage: 140, splashRadius: 4.5, fuse: 0.01, range: 1000,
      });
      sys.update(0.02, [wall], [...clump, shielded], hooks);
      assertEqual(hooks.hits.length, clump.length, 'every infected in the clump was caught');
      assert(clump.every((e) => e.health <= 0), 'the clump is dead');
      assertEqual(hooks.hits.filter((h) => h.killed).length, clump.length, 'all five are kills');
      assertEqual(shielded.health, enemyDefs.ENEMY_TYPES.infected.maxHealth, 'the shielded one is untouched');
    } finally {
      sys.dispose();
    }
  });

  test('the thrower can only be hurt by their own blast with line of sight', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      const owner = { position: { x: 0, y: 0, z: 0 }, alive: true, height: 1.8, radius: 0.36 };
      // Blast right next to the shooter, nothing in between.
      sys.spawn({
        origin: { x: 0.5, y: 1, z: 0 }, dir: { x: 0, y: 1, z: 0 },
        speed: 0, damage: 140, splashRadius: 4.5, fuse: 0.01, range: 1000, owner,
      });
      sys.update(0.02, [], [], hooks);
      assertEqual(hooks.selfHits.length, 1, 'the shooter took their own blast');
      const expected = 140 * (1 - 0.75 * (0.5 / 4.5)) * SELF_DAMAGE_MULT;
      assertNear(hooks.selfHits[0].damage, expected, 0.5, 'self damage is scaled and falls off');
      assertEqual(SELF_DAMAGE_MULT, 0.5, 'the documented self-damage scale');

      // The same blast on the far side of a wall: no damage, no matter how close
      // the geometry puts the shooter to the surface.
      hooks.selfHits.length = 0;
      const wall = createBox(1.4, 0, -2, 2.6, 4, 2, 'wall');
      const shooter = { position: { x: 3.4, y: 0, z: 0 }, alive: true, height: 1.8 };
      sys.spawn({
        origin: { x: 0.5, y: 1, z: 0 }, dir: { x: 0, y: 1, z: 0 },
        speed: 0, damage: 140, splashRadius: 4.5, fuse: 0.01, range: 1000, owner: shooter,
      });
      sys.update(0.02, [wall], [], hooks);
      assertEqual(hooks.selfHits.length, 0, 'a wall protects the thrower from their own blast');

      // A dead shooter is not damaged again (the game takes over at that point).
      hooks.selfHits.length = 0;
      const dead = { position: { x: 0.5, y: 0, z: 0 }, alive: false, height: 1.8 };
      sys.spawn({
        origin: { x: 0.5, y: 1, z: 0 }, dir: { x: 0, y: 1, z: 0 },
        speed: 0, damage: 140, splashRadius: 4.5, fuse: 0.01, range: 1000, owner: dead,
      });
      sys.update(0.02, [], [], hooks);
      assertEqual(hooks.selfHits.length, 0, 'a dead owner is skipped');
    } finally {
      sys.dispose();
    }
  });

  test('a round that touches a body goes off on the spot, wherever the fuse is', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      const enemy = makeEnemyAt(3, 0);
      sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 },
        speed: 20, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 30, range: 1000,
      });
      let frames = 0;
      while (sys.liveCount > 0 && frames < 120) {
        sys.update(1 / 60, [], [enemy], hooks);
        frames++;
      }
      assert(frames < 30, `proximity should end the flight quickly (took ${frames} frames)`);
      assertEqual(hooks.blasts.length, 1, 'the round went off against the body');
      assert(hooks.blasts[0].point.x > 2 && hooks.blasts[0].point.x < 3.6, 'the blast is at the body');
      assert(enemy.health < enemyDefs.ENEMY_TYPES.infected.maxHealth, 'the body took the blast');
    } finally {
      sys.dispose();
    }
  });

  test('clear() drops live rounds without a bang and frees their slots', () => {
    const sys = makeProjectileSystem();
    try {
      const hooks = makeBlastHooks();
      for (let i = 0; i < 3; i++) {
        sys.spawn({
          origin: { x: i, y: 1, z: 0 }, dir: { x: 0, y: 1, z: 0 },
          speed: 5, damage: 140, splashRadius: 4.5, fuse: 5,
        });
      }
      assertEqual(sys.liveCount, 3, 'three rounds in the air');
      sys.clear();
      assertEqual(sys.liveCount, 0, 'clear() empties the pool');
      sys.update(1, [], [], hooks);
      assertEqual(hooks.blasts.length, 0, 'no round went off during the clear');
      assertEqual(sys.spawn({
        origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 1, z: 0 }, speed: 5, damage: 140, splashRadius: 4.5, fuse: 5,
      }), 0, 'slots hand out from the start again');
    } finally {
      sys.dispose();
    }
  });

  test('an explosion leaves a scorch mark that expires and dies with its door', () => {
    withDocumentStub(() => {
      const fx = new effects.EffectsManager(decalScene, { bounds: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 } });
      try {
        assertEqual(fx.scorch.activeCount, 0, 'no soot before the first blast');
        fx.spawnExplosion({ x: 0, y: 1, z: 0 }, { radius: 4.5, normal: { x: 0, y: 1, z: 0 }, surface: 'floor' });
        assertEqual(fx.scorch.activeCount, 1, 'a blast leaves one scorch mark');
        assert(fx.sparks.count > 0, 'the fireball emitted particles');
        assert(fx.dust.count > 0, 'the blast emitted smoke');
        assert(fx.scorch.mesh.count === 12, 'the scorch pool is a fixed-size instanced mesh');
        fx.update(effects.SCORCH_LIFETIME - 1, 0, null);
        assertEqual(fx.scorch.activeCount, 1, 'still there a second before it expires');
        fx.update(1.5, 0, null);
        assertEqual(fx.scorch.activeCount, 0, 'scorch marks expire on their own');

        // A blast against a door panel hands the pool that panel as the owner.
        const door = { openAmount: 0 };
        fx.spawnExplosion({ x: 2, y: 1, z: 0 }, { radius: 4.5, normal: { x: -1, y: 0, z: 0 }, surface: 'metal', owner: door });
        assertEqual(fx.scorch.activeCount, 1, 'soot on the panel');
        fx.update(0.016, 0, [door]);
        assert(scaleOf(fx.scorch, 0) > 0, 'a closed door keeps its soot');
        door.openAmount = 1;
        fx.update(0.016, 0, [door]);
        assertEqual(scaleOf(fx.scorch, 0), 0, 'the soot is culled when the panel retracts');

        fx.clearDecals();
        assertEqual(fx.scorch.activeCount, 0, 'clearDecals() clears the soot pool too');
      } finally {
        fx.dispose();
      }
    });
  });

  test('a blast on a door panel leaves soot the door takes with it when it opens', () => {
    withDocumentStub(() => {
      const fx = new effects.EffectsManager(decalScene, { bounds: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 } });
      const blasts = [];
      const sys = new ProjectileSystem(stubScene(), {
        effects: fx,
        audio: { playExplosion: (pos) => blasts.push(pos) },
        hooks: {},
      });
      try {
        const door = { openAmount: 0 };
        const panel = createBox(4, 0, -1, 4.3, 4, 1, 'door');
        panel.owner = door;
        sys.spawn({
          origin: { x: 0, y: 1.5, z: 0 }, dir: { x: 1, y: 0, z: 0 },
          speed: 20, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 0.6, range: 1000,
        });
        const hooks = makeBlastHooks();
        for (let i = 0; i < 60 && sys.liveCount > 0; i++) sys.update(1 / 60, [panel], [], hooks);
        assertEqual(sys.liveCount, 0, 'the fuse ended the flight');
        assertEqual(blasts.length, 1, 'the blast played its positional sound once');
        assertEqual(fx.scorch.activeCount, 1, 'the panel took a scorch mark');
        assert(fx.scorch.owner[0] === door, 'the mark belongs to the door panel');
        fx.update(0.016, 0, [door]);
        assert(scaleOf(fx.scorch, 0) > 0, 'closed panel shows the soot');
        door.openAmount = 1;
        fx.update(0.016, 0, [door]);
        assertEqual(scaleOf(fx.scorch, 0), 0, 'and the soot goes up with the panel');
      } finally {
        sys.dispose();
        fx.dispose();
      }
    });
  });

  test('a round that cooks off in mid-air scorches the floor under it', () => {
    withDocumentStub(() => {
      const fx = new effects.EffectsManager(decalScene, { bounds: { minX: 0, minZ: 0, maxX: 20, maxZ: 20 } });
      const sys = new ProjectileSystem(stubScene(), { effects: fx, audio: null, hooks: {} });
      try {
        sys.spawn({
          origin: { x: 2, y: 1.4, z: 3 }, dir: { x: 1, y: 0, z: 0 },
          speed: 5, gravity: 0, damage: 140, splashRadius: 4.5, fuse: 0.2, range: 1000,
        });
        for (let i = 0; i < 30 && sys.liveCount > 0; i++) sys.update(1 / 60, [], [], makeBlastHooks());
        assertEqual(fx.scorch.activeCount, 1, 'a mid-air blast still marks the ground');
        assert(fx.scorch.activeCount === 1, 'one mark per blast');
      } finally {
        sys.dispose();
        fx.dispose();
      }
    });
  });

  /* ---------------- GL-6 THUMPER ---------------- */
  console.log('\nGL-6 THUMPER');

  test('the GL-6 def matches the roadmap block and passes the schema', () => {
    const def = weapon.WEAPON_DEFS.launcher;
    assertEqual(def.name, 'GL-6 THUMPER', 'name');
    assertEqual(def.category, 'firearm', 'category');
    assertEqual(def.ammoKind, 'explosive', 'ammo kind');
    assertEqual(def.slot, 2, 'defaults to the long-gun slot');
    assertEqual(def.damage, 140, 'splash damage at the centre');
    assertEqual(def.fireRate, 0.9, 'rate of fire');
    assertEqual(def.magazineSize, 1, 'single shot');
    assertEqual(def.startReserve, 6, 'reserve');
    assertEqual(def.reloadTime, 2.8, 'reload');
    assertEqual(def.reloadMode, 'magazine', 'magazine reload');
    assertEqual(def.auto, false, 'not automatic');
    assertEqual(def.tracer, false, 'no tracer: the round is visible');
    assertEqual(def.projectile.speed, 26, 'muzzle velocity');
    assertEqual(def.projectile.fuse, 1.1, 'fuse');
    assertEqual(def.splash.radius, 4.5, 'blast radius');
    assert(weapon.validateWeaponDef(def).valid, `schema: ${weapon.validateWeaponDef(def).errors.join('; ')}`);

    // category-only fields: explosives are firearms' business, never melee's.
    const knife = weapon.WEAPON_DEFS.knife;
    assert(weapon.validateWeaponDef({ ...knife, projectile: def.projectile }).errors.some((e) => e.includes('projectile')),
      'melee must not define a projectile');
    assert(weapon.validateWeaponDef({ ...knife, splash: def.splash }).errors.some((e) => e.includes('splash')),
      'melee must not define splash damage');
    // A projectile without a blast radius is a hit scan with extra steps.
    const noSplash = { ...def, projectile: { ...def.projectile } };
    delete noSplash.splash;
    assert(weapon.validateWeaponDef(noSplash).errors.some((e) => e.includes('splash')),
      'a projectile weapon needs a splash radius');
    const badFuse = { ...def, projectile: { ...def.projectile, fuse: 0 } };
    assert(weapon.validateWeaponDef(badFuse).errors.some((e) => e.includes('fuse')), 'fuse must be positive');

    // Balance guardrails: the documented exceptions live in the dps test, the
    // ammo row and the sound row are here so a new explosive cannot forget them.
    assertEqual(weapon.AMMO_PICKUP.launcher, 2, 'explosive rounds come two at a time');
    assert(weapon.sustainedDps(def) < 60, 'the launcher is a burst weapon by design');
    assert(audio.EXPLOSION_PROFILES.frag, 'the blast needs its own profile row');
    assert(audio.EXPLOSION_PROFILES.frag.noise.length > 0 && audio.EXPLOSION_PROFILES.frag.body.length > 0,
      'the blast row needs noise and body layers');
  });

  test('the launcher is selectable in a loadout and reports itself to the HUD', () => {
    const picked = weapon.sanitizeLoadout(['launcher', 'shotgun', 'knife', 'pipe', 'axe']);
    assertEqual(picked[0], 'launcher', 'slot 1 can hold the thumper');
    const reversed = weapon.sanitizeLoadout(['shotgun', 'launcher', 'knife', 'pipe', 'axe']);
    assertEqual(reversed[1], 'launcher', 'and so can slot 2');
    assertEqual(weapon.hudSlotLabels(reversed)[1], '2 THUMPER', 'HUD chip label');
    const offered = weapon.loadoutSlotOptions().find((slot) => slot.options.some((o) => o.id === 'launcher'));
    assert(offered && offered.category === 'firearm', 'the loadout screen offers it as a firearm');
    assert(weapon.WEAPON_IDS.includes('launcher'), 'in the catalogue');
    assertEqual(weapon.WEAPON_DEFS.launcher.unlockWave, 3, 'it is flagged as a later unlock');
  });

  test('firing the launcher spawns one round, spends the round and reloads through the HUD', () => {
    withDocumentStub(() => {
      const spawned = [];
      const shots = [];
      let rayHits = 0;
      const target = makeTargetBox(-4);
      // Snapshots the values the way ProjectileSystem.spawn() copies them: the
      // weapon reuses one argument block, so anything not copied here would be
      // overwritten by the next shot.
      const projectiles = {
        spawn: (args) => {
          spawned.push({
            weapon: args.weapon,
            damage: args.damage,
            splashRadius: args.splashRadius,
            speed: args.speed,
            gravity: args.gravity,
            radius: args.radius,
            fuse: args.fuse,
            range: args.range,
            restitution: args.restitution,
            owner: args.owner,
            origin: { x: args.origin.x, y: args.origin.y, z: args.origin.z },
            dir: { x: args.dir.x, y: args.dir.y, z: args.dir.z },
          });
          return 0;
        },
      };
      const { camera, system } = makeWeaponSystem(['launcher', 'shotgun', 'knife', 'pipe', 'axe']);
      system.projectiles = projectiles;
      system.hooks.onShot = (def, hitAnything) => shots.push({ id: def.id, hitAnything });
      system.hooks.onEnemyHit = () => { rayHits++; return { killed: false }; };
      try {
        const ctx = { canFire: true, colliders: [], hitboxes: () => [target], speedFactor: 0, bobPhase: 0, dt: 0 };
        system.update(0.8, {}, ctx); // finish the draw
        assertEqual(system.getHudData().ammo, 1, 'one up the tube');
        assertEqual(system.def.category, 'firearm', 'the launcher is a firearm to the rest of the HUD');
        assertEqual(system.getHudData().melee, false, 'it renders an ammo block');
        system.update(1 / 60, { firePressed: true }, ctx);
        assertEqual(spawned.length, 1, 'exactly one round left the tube');
        assertEqual(spawned[0].weapon, 'launcher', 'the round knows its weapon');
        assertEqual(spawned[0].damage, 140, 'centre damage');
        assertEqual(spawned[0].splashRadius, 4.5, 'blast radius');
        assertEqual(spawned[0].speed, 26, 'muzzle velocity');
        assertEqual(spawned[0].fuse, 1.1, 'fuse');
        assertEqual(spawned[0].owner, system.player, 'the round remembers who fired it');
        assert(spawned[0].origin.y > 1.4, 'the round leaves the eye (1.5 m), not the floor');
        assert(spawned[0].dir.z < -0.9, 'and flies down the crosshair');
        assertEqual(shots.length, 1, 'onShot fired once');
        assertEqual(shots[0].hitAnything, false, 'the flight sim owns the hit, not the trigger');
        assertEqual(rayHits, 0, 'nothing was hit by a ray: this weapon is not hitscan');
        assertEqual(system.getHudData().ammo, 0, 'the tube is empty');
        assertEqual(system.state.cooldown > 0, true, 'the launcher is on its rate-of-fire cooldown');

        // Empty: the next trigger pull dry-fires and starts the magazine reload.
        system.update(1.2, {}, ctx);
        system.update(1 / 60, { firePressed: true }, ctx);
        assertEqual(spawned.length, 1, 'no round came out of an empty tube');
        assertEqual(system.getHudData().reloading, true, 'the HUD shows the reload');
        assertEqual(system.getHudData().hasAmmo, true, 'the HUD still renders an ammo block');
        // A magazine reload cannot be interrupted by pulling the trigger.
        for (let i = 0; i < 10; i++) system.update(0.1, { firePressed: true }, ctx);
        assertEqual(spawned.length, 1, 'trigger pulls during the reload do nothing');
        while (system.state.reloading) system.update(0.1, {}, ctx);
        assertEqual(system.getHudData().ammo, 1, 'the reload put one round back');
        assertEqual(system.getHudData().reserve, 5, 'out of the six it started with');
        system.update(1 / 60, { firePressed: true }, ctx);
        assertEqual(spawned.length, 2, 'and the launcher fires again');
      } finally {
        system.dispose();
        target.geometry.dispose();
        target.material.dispose();
      }
    });
  });

  test('a round leaves the muzzle clear of the wall the player is hugging', () => {
    withDocumentStub(() => {
      const spawned = [];
      const { camera, system } = makeWeaponSystem(['launcher', 'shotgun', 'knife', 'pipe', 'axe']);
      system.projectiles = { spawn: (args) => { spawned.push({ x: args.origin.x, y: args.origin.y, z: args.origin.z, dx: args.dir.x, dz: args.dir.z }); return 0; } };
      try {
        // Camera 0.36 m from a wall (the player's own collision radius), looking at it.
        camera.position.set(0, 1.65, 0);
        camera.lookAt(0, 1.65, -1);
        camera.updateMatrixWorld(true);
        system.update(0.8, {}, { canFire: true, colliders: [], hitboxes: () => [], speedFactor: 0, bobPhase: 0 });
        system.update(1 / 60, { firePressed: true }, { canFire: true, colliders: [], hitboxes: () => [], speedFactor: 0, bobPhase: 0 });
        assertEqual(spawned.length, 1, 'the round launched');
        assert(spawned[0].z < 0 && spawned[0].z > -0.36,
          `the spawn point must stay inside the player's own radius (z=${spawned[0].z})`);
      } finally {
        system.dispose();
      }
    });
  });

  /* ---------------- milestone 4: melee + always-carried sidearm ---------------- */
  const gameModule = await import(pathToFileURL(path.join(JS_DIR, 'game.js')).href);
  console.log('\nMelee + sidearm');

  /** A real Enemy on a stub scene, out of its spawn rise and in play. */
  function makeEnemy(typeId = 'infected', x = 0, z = 0) {
    const enemy = new enemyDefs.Enemy({
      scene: { add() {}, remove() {} },
      typeId,
      x,
      z,
      multipliers: { health: 1, damage: 1, speed: 1 },
    });
    enemy.setState('chase'); // spawn-rise is not targetable: take it to the fight
    return enemy;
  }

  /** Minimal world context for EnemyAI.update(), for the knockback step. */
  function makeAIWorld(playerPos = { x: 0, z: -4 }, colliders = []) {
    return {
      player: { position: { x: playerPos.x, y: 0, z: playerPos.z }, alive: true },
      colliders,
      nav: { isWalkableWorld: () => true, findPath: () => null },
      enemies: [],
      time: 0,
      noise: null,
      huntAll: false,
      requestPath: () => true,
      damagePlayer: () => {},
    };
  }

  test('the CLEAVER MACHETE and SLEDGEHAMMER match the roadmap block and pass the schema', () => {
    const machete = weapon.WEAPON_DEFS.machete;
    assertEqual(machete.name, 'CLEAVER MACHETE', 'machete name');
    assertEqual(machete.category, 'melee', 'machete category');
    assertEqual(machete.damage, 58, 'machete damage');
    assertEqual(machete.reach, 1.85, 'machete reach');
    assertEqual(machete.arcDegrees, 55, 'machete arc');
    assertEqual(machete.maxTargets, 3, 'machete targets');
    assertEqual(machete.swing, 'sweep', 'machete swing style');
    assertEqual(machete.attackCooldown, 0.5, 'machete cycle');

    const sledge = weapon.WEAPON_DEFS.sledge;
    assertEqual(sledge.name, 'SLEDGEHAMMER', 'sledge name');
    assertEqual(sledge.damage, 140, 'sledge damage');
    assertEqual(sledge.reach, 2.1, 'sledge reach');
    assertEqual(sledge.arcDegrees, 24, 'sledge arc');
    assertEqual(sledge.maxTargets, 1, 'sledge hits one body');
    assertEqual(sledge.swing, 'smash', 'sledge swing style');
    assertEqual(sledge.attackCooldown, 1.3, 'sledge cycle');
    assertEqual(sledge.heavyStagger, true, 'the hammer always staggers');
    assert(sledge.knockback > 0, 'the hammer shoves');
    assert(weapon.validateWeaponDef(machete).valid, `machete schema: ${weapon.validateWeaponDef(machete).errors.join('; ')}`);
    assert(weapon.validateWeaponDef(sledge).valid, `sledge schema: ${weapon.validateWeaponDef(sledge).errors.join('; ')}`);

    // Roles: the machete is the sweep, the sledge is the commitment.
    const pipe = weapon.WEAPON_DEFS.pipe;
    const axe = weapon.WEAPON_DEFS.axe;
    assert(machete.arcDegrees > pipe.arcDegrees && machete.maxTargets > pipe.maxTargets,
      'the machete sweeps wider than the pipe');
    assert(machete.attackCooldown < pipe.attackCooldown, 'and faster');
    assert(sledge.damage > axe.damage && sledge.attackCooldown > axe.attackCooldown,
      'the sledge trades speed for one huge blow');
    assert(sledge.windup > Math.max(weapon.WEAPON_DEFS.knife.windup, pipe.windup, axe.windup, machete.windup),
      'and telegraphs longer than any other melee weapon');

    for (const def of [machete, sledge]) {
      assertEqual(def.ammoKind, undefined, `${def.id} is melee and carries no ammo kind`);
      assertEqual(def.magazineSize, undefined, `${def.id} must not define a magazine`);
      assertEqual(weapon.AMMO_PICKUP[def.id], undefined, `${def.id} takes no ammo pickups`);
      const tl = meleeAnim.swingTimeline(def);
      assert(0 < tl.windup && tl.windup < tl.impact && tl.impact < tl.follow && tl.follow < tl.end,
        `${def.id} timeline must be ordered`);
      assert(def.hitTime > tl.windup && def.hitTime + def.activeTime < tl.follow, `${def.id} hit window inside the strike`);
      assert(def.attackCooldown > def.attackDuration, `${def.id} cooldown must outlast the swing`);
      // The style name has to resolve: a typo would fall back to 'slash' in silence.
      assert(meleeAnim.STYLE_POSES[def.swing], `${def.id} names a swing style that exists`);
    }
    // Only the sledge carries the new melee extras: the other swings are untouched.
    for (const id of ['knife', 'pipe', 'axe', 'machete']) {
      assertEqual(weapon.WEAPON_DEFS[id].heavyStagger, undefined, `${id} must not stagger super-armour`);
      assertEqual(weapon.WEAPON_DEFS[id].knockback, undefined, `${id} must not shove`);
    }
    // Schema: the two new fields are optional, melee-only and validated when present.
    assert(weapon.validateWeaponDef({ ...sledge, heavyStagger: 'yes' }).errors.some((e) => e.includes('heavyStagger')),
      'heavyStagger must be a boolean');
    assert(weapon.validateWeaponDef({ ...sledge, knockback: -1 }).errors.some((e) => e.includes('knockback')),
      'knockback cannot be negative');
    assert(weapon.validateWeaponDef({ ...weapon.WEAPON_DEFS.rifle, recoil: { ...weapon.WEAPON_DEFS.rifle.recoil }, knockback: 1 })
      .errors.some((e) => e.includes('knockback')), 'a firearm must not define knockback');
    assert(weapon.validateWeaponDef({ ...weapon.WEAPON_DEFS.rifle, recoil: { ...weapon.WEAPON_DEFS.rifle.recoil }, heavyStagger: true })
      .errors.some((e) => e.includes('heavyStagger')), 'a firearm must not define heavyStagger');
  });

  test('the sweep and smash poses start at rest, move smoothly and mirror for backhands', () => {
    const rest = meleeAnim.REST_POSE;
    for (const id of ['machete', 'sledge']) {
      const def = weapon.WEAPON_DEFS[id];
      const start = meleeAnim.swingPoseAt(def, 0);
      const end = meleeAnim.swingPoseAt(def, def.attackDuration);
      for (const k of Object.keys(rest)) {
        assertNear(start[k], rest[k], 1e-9, `${id} start ${k}`);
        assertNear(end[k], rest[k], 1e-9, `${id} end ${k}`);
      }
      // No jumps: the same 240 Hz guard the knife has, so a new pose set cannot
      // teleport the arm between frames.
      let prev = start;
      for (let t = 1 / 240; t <= def.attackDuration; t += 1 / 240) {
        const p = meleeAnim.swingPoseAt(def, t);
        for (const k of Object.keys(rest)) {
          assert(Math.abs(p[k] - prev[k]) < 0.25, `${id}: ${k} jumps at t=${t.toFixed(3)}`);
        }
        prev = p;
      }
      const tl = meleeAnim.swingTimeline(def);
      const windup = meleeAnim.swingPoseAt(def, tl.windup);
      const backhand = meleeAnim.swingPoseAt(def, tl.windup, 'left');
      assertNear(backhand.sy - rest.sy, -(windup.sy - rest.sy), 1e-9, `${id} backhand mirrors shoulder yaw`);
      assertNear(backhand.sr - rest.sr, -(windup.sr - rest.sr), 1e-9, `${id} backhand mirrors shoulder roll`);
      assertNear(backhand.sp, windup.sp, 1e-9, `${id} backhand keeps shoulder pitch`);
      assertNear(backhand.el, windup.el, 1e-9, `${id} backhand keeps the elbow bend`);
    }

    // The sweep is the horizontal one: pull right, cut all the way left, level.
    const machete = weapon.WEAPON_DEFS.machete;
    const mTl = meleeAnim.swingTimeline(machete);
    const mWind = meleeAnim.swingPoseAt(machete, mTl.windup);
    const mImpact = meleeAnim.swingPoseAt(machete, mTl.impact);
    assert(mWind.sy < rest.sy && mImpact.sy > rest.sy, 'the sweep winds up right and cuts left');
    assert(Math.abs(mImpact.sp - rest.sp) < 0.5, 'and stays level: it is a sweep, not a chop');

    // The smash is the vertical one: up behind the shoulder, then straight down,
    // with the follow-through lower than the impact.
    const sledge = weapon.WEAPON_DEFS.sledge;
    const sTl = meleeAnim.swingTimeline(sledge);
    const sWind = meleeAnim.swingPoseAt(sledge, sTl.windup);
    const sImpact = meleeAnim.swingPoseAt(sledge, sTl.impact);
    const sFollow = meleeAnim.swingPoseAt(sledge, sTl.follow);
    assert(sWind.sp > rest.sp && sWind.el < rest.el, 'the smash raises the arm overhead');
    assert(sImpact.sp < sWind.sp, 'and brings it down');
    assert(sFollow.sp < sImpact.sp, 'the follow-through drives below the impact');
  });

  test('the sledgehammer staggers everything except an armoured body blow', () => {
    const infected = makeEnemy('infected');
    const armored = makeEnemy('armored');
    const dying = makeEnemy('infected');
    try {
      assertEqual(infected.type.staggerable, true, 'infected are staggerable');
      assertEqual(armored.type.staggerable, false, 'armoured is super-armour');
      // Ordinary blows behave exactly as before.
      assertEqual(infected.applyStagger({}), true, 'an ordinary blow flinches an infected');
      assertNear(infected.hurtTimer, 0.2, 1e-9, 'a bullet-size flinch');
      infected.setState('chase');
      assertEqual(armored.applyStagger({}), false, 'super-armour shrugs off an ordinary blow');
      assertEqual(armored.state, 'chase', 'and never loses its swing');
      // Heavy blows: the sledgehammer's `heavyStagger`.
      assertEqual(infected.applyStagger({ heavy: true }), true, 'a hammer always flinches an infected');
      assertNear(infected.hurtTimer, enemyDefs.HEAVY_STAGGER_TIME, 1e-9, 'a heavy flinch is its own length');
      assert(enemyDefs.HEAVY_STAGGER_TIME > 0.2, 'and visibly longer than a bullet flinch');
      // The call the roadmap asked for: an armoured *body* blow is the exception.
      assertEqual(armored.applyStagger({ heavy: true }), false, 'the plate takes the hammer');
      assertEqual(armored.state, 'chase', 'so brute force alone never beats the brute');
      // A head blow beats the plate, exactly as headshots bypass armour for damage.
      assertEqual(armored.applyStagger({ heavy: true, headshot: true }), true, 'a head hit staggers the brute');
      assertEqual(armored.state, 'hurt', 'and it loses its swing');
      // takeDamage keeps its own rule: bullets never stagger super-armour.
      const armored2 = makeEnemy('armored');
      armored2.takeDamage(30);
      assertEqual(armored2.state, 'chase', 'a body shot does not stagger the brute');
      const infected2 = makeEnemy('infected');
      infected2.takeDamage(10);
      assertEqual(infected2.state, 'hurt', 'a body shot does stagger an infected');
      // A dying enemy has nothing left to flinch.
      dying.health = 1;
      dying.takeDamage(50);
      assertEqual(dying.state, 'death', 'the blow killed it');
      assertEqual(dying.applyStagger({ heavy: true }), false, 'a corpse cannot be staggered');
    } finally {
      for (const e of [infected, armored, dying]) e.dispose();
    }
  });

  test('a hammer blow shoves a body, and a wall still stops it', () => {
    const ai = new enemyAI.EnemyAI();
    const infected = makeEnemy('infected');
    const blocked = makeEnemy('infected');
    try {
      const world = makeAIWorld();
      infected.aggro = true;
      // Nothing to shove with: a zero direction or a zero impulse is a no-op.
      infected.applyKnockback(0, 0, 1.2);
      infected.applyKnockback(1, 0, 0);
      assertEqual(infected.isKnockedBack(), false, 'an empty shove does nothing');

      infected.applyKnockback(1, 0, weapon.WEAPON_DEFS.sledge.knockback);
      assert(infected.isKnockedBack(), 'the body is being pushed');
      const startX = infected.position.x;
      const startV = infected.knockX;
      assertNear(startV, weapon.WEAPON_DEFS.sledge.knockback * enemyDefs.KNOCKBACK_SPEED, 1e-9,
        'the impulse becomes a velocity: metres x KNOCKBACK_SPEED');
      // The AI hands moveCylinder() exactly (knockX, knockZ) * dt each frame, so
      // summing that is how far the shove itself carried the body. A decaying
      // velocity integrates to v0 / KNOCKBACK_DECAY = 7.2 / 9 = 0.8 m - the body
      // is pushed, not teleported, and it stops in about a third of a second.
      let shoved = 0;
      for (let i = 0; i < 36; i++) {
        shoved += infected.knockX / 60;
        ai.update(infected, 1 / 60, world);
      }
      // (The frame-stepped sum reads a touch over the 0.8 m continuous integral,
      // because each frame carries the velocity it started with.)
      assert(shoved > 0.7 && shoved < 0.95, `a 1.2 m impulse carries about 0.8 m, got ${shoved.toFixed(3)}`);
      assert(infected.position.x - startX > 0.35, 'and the body really moved');
      assertEqual(infected.isKnockedBack(), false, 'the shove is over');
      assertEqual(infected.state, 'chase', 'the AI state machine kept running throughout');

      // The same shove into a wall: moveCylinder() keeps the wall solid.
      const wall = createBox(1, 0, -2, 2, 4, 2, 'wall');
      const wallWorld = makeAIWorld({ x: 0, z: -4 }, [wall]);
      blocked.aggro = true;
      blocked.applyKnockback(1, 0, 4); // deliberately oversized: it must still not pass
      for (let i = 0; i < 60; i++) ai.update(blocked, 1 / 60, wallWorld);
      assert(blocked.position.x <= 1 - blocked.type.radius + 1e-6,
        `the wall stopped the shove (x=${blocked.position.x})`);
      assert(blocked.position.x > 0.3, 'but the body still moved into the wall');
    } finally {
      for (const e of [infected, blocked]) e.dispose();
    }
  });

  test('a sledgehammer hit reports a heavy stagger and a shove; the machete reports neither', () => {
    withDocumentStub(() => {
      const hits = [];
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(0, 1.5, 0);
      camera.lookAt(0, 1.5, -1);
      camera.updateMatrixWorld(true);
      const system = new weapon.WeaponSystem({
        camera,
        loadout: ['rifle', 'shotgun', 'sledge', 'pipe', 'machete'],
        audio: {
          playSwitch() {}, playDryFire() {}, playReload() {}, playShot() {}, playHitFlesh() {}, playMeleeSwing() {},
        },
        effects: { spawnBlood() {}, spawnImpact() {}, spawnTracer() {} },
        player: { addRecoil() {}, addTrauma() {} },
        hooks: { onEnemyHit: (info) => { hits.push(info); return { killed: false }; } },
      });
      const hitbox = makeTargetHitbox();
      const ctx = { canFire: true, colliders: [], hitboxes: () => [hitbox], speedFactor: 0, bobPhase: 0 };
      /** Draws the weapon in `slot` and runs one swing to completion. */
      const swing = (slot, seconds) => {
        const before = hits.length;
        system.requestSwitch(slot);
        system.update(0.8, {}, ctx); // finish the draw
        system.update(0.001, { firePressed: true }, ctx);
        for (let i = 0; i < Math.ceil(seconds * 60); i++) system.update(1 / 60, {}, ctx);
        return hits.length > before;
      };
      try {
        assert(swing(2, 0.8), 'the sledgehammer connected');
        const hammer = hits[hits.length - 1];
        assertEqual(hammer.weapon, 'sledge', 'the hit reports the hammer');
        assertEqual(hammer.damage, 140, 'one blow, 140 damage');
        assertEqual(hammer.stagger, 'heavy', 'and it asks for the heavy stagger');
        assert(hammer.knockback, 'plus a shove');
        assertEqual(hammer.knockback.distance, weapon.WEAPON_DEFS.sledge.knockback, 'the def decides the impulse');
        // The target is straight down the camera, so the shove points downrange:
        // the ray that landed sits inside the 24-degree fan, which is why the x
        // component is small but not zero.
        assertNear(Math.hypot(hammer.knockback.x, hammer.knockback.z), 1, 1e-9, 'the shove direction is a unit vector');
        assert(hammer.knockback.z < -0.9, 'the shove points downrange');
        assert(Math.abs(hammer.knockback.x) <= Math.sin(weapon.WEAPON_DEFS.sledge.arcDegrees * Math.PI / 360) + 1e-9,
          'and stays inside the swing arc');
        // A hook is allowed to keep what it was handed: the shove must be a copy,
        // not the ray-scratch vector the next swing overwrites.
        assert(hammer.knockback !== system._dir, 'the shove is not aliased to the ray scratch');

        assert(swing(4, 0.6), 'the machete connected');
        const cleaver = hits[hits.length - 1];
        assertEqual(cleaver.weapon, 'machete', 'the hit reports the machete');
        assertEqual(cleaver.damage, 58, '58 a swing');
        assertEqual(cleaver.stagger, undefined, 'the machete does not stagger super-armour');
        assertEqual(cleaver.knockback, undefined, 'and does not shove: the old melee swings are untouched');
      } finally {
        system.dispose();
        hitbox.geometry.dispose();
        hitbox.material.dispose();
      }
    });
  });

  test('the MK2 SIDEARM matches the roadmap block and is never a loadout pick', () => {
    const def = weapon.WEAPON_DEFS.pistol;
    assertEqual(def.name, 'MK2 SIDEARM', 'name');
    assertEqual(def.category, 'firearm', 'category');
    assertEqual(def.ammoKind, 'rifle', 'it shares the rifle crates it never takes');
    assertEqual(def.damage, 30, 'damage');
    assertEqual(def.fireRate, 5, 'rate of fire');
    assertEqual(def.auto, false, 'semi-auto: one click, one round');
    assertEqual(def.magazineSize, 12, 'magazine');
    assertEqual(def.startReserve, 36, 'reserve');
    assertEqual(def.maxReserve, 36, 'a capped pool: it is a backup, not a primary');
    assertEqual(def.reloadTime, 1.3, 'reload');
    assertNear(weapon.sustainedDps(def), 97, 1, 'about 97 sustained dps');
    const dps = weapon.sustainedDps(def);
    assert(dps >= 60 && dps <= 160, `the sidearm must sit inside the balance band (${dps.toFixed(1)})`);
    assert(def.switchTime < weapon.WEAPON_DEFS.smg.switchTime, 'the fastest draw in the game');
    assert(weapon.validateWeaponDef(def).valid, `schema: ${weapon.validateWeaponDef(def).errors.join('; ')}`);

    // Weak vs armour: armour is not bypassed, and half a magazine of body shots
    // does not drop the brute, so the sidearm is a backup even against armour.
    const armored = enemyDefs.ENEMY_TYPES.armored;
    const perBodyShot = Math.max(1, Math.round(def.damage * (1 - armored.armor)));
    assertEqual(perBodyShot, 20, 'an armoured body shot takes 30 x 0.65');
    assert(perBodyShot * Math.ceil(def.magazineSize / 2) < armored.maxHealth,
      'half a sidearm magazine does not clear an armoured infected');

    // Availability: always carried, never picked, never fed by a crate.
    assert(weapon.ALWAYS_CARRIED.includes('pistol'), 'the sidearm is always carried');
    assertEqual(weapon.AMMO_PICKUP.pistol, undefined, 'the intermission refill feeds it, not crates');
    const allPistols = weapon.sanitizeLoadout(['pistol', 'pistol', 'pistol', 'pistol', 'pistol']);
    assert(!allPistols.includes('pistol'), 'the sidearm cannot occupy a loadout slot');
    assertEqual(new Set(allPistols).size, weapon.SLOT_COUNT, 'and the kit is still complete');
    assertEqual(weapon.sanitizeLoadout(['shotgun', 'dmr', 'axe', 'pipe', 'axe']).join(','),
      'shotgun,dmr,axe,pipe,knife', 'the rest of the kit is unaffected by the refusal');
    const offered = weapon.loadoutSlotOptions().flatMap((slot) => slot.options.map((option) => option.id));
    assert(!offered.includes('pistol'), 'the loadout screen does not offer it: there is nothing to choose');
  });

  test('the sidearm keeps its own key, ignores crates and refills every intermission', () => {
    withDocumentStub(() => {
      const { camera, system } = makeWeaponSystem(['shotgun', 'dmr', 'axe', 'pipe', 'knife']);
      try {
        assertEqual(system.slotCount, 6, 'five loadout keys plus the sidearm');
        assertEqual(system.slotIds.join(','), 'shotgun,dmr,axe,pipe,knife,pistol', 'the sidearm is the last key');
        assertEqual(system.states[5].def.id, 'pistol', 'state 6 is the sidearm');
        assertEqual(system.models[5].group.parent, camera, 'its viewmodel hangs off the camera like any firearm');
        assertEqual(system.states[5].reserve, 36, 'a fresh run starts it full');

        // A loadout change never costs the player the sidearm.
        system.setLoadout(['launcher', 'smg', 'machete', 'sledge', 'axe']);
        assertEqual(system.slotIds[5], 'pistol', 'a kit swap keeps the sidearm');
        assertEqual(system.slotCount, 6, 'and the key count stays stable');

        // A crate never touches it: needsAmmo() ignores it and addAmmo() skips it.
        system.states.forEach((st, i) => { if (i !== 5) st.reserve = st.def.maxReserve; });
        system.states[5].reserve = 0;
        assertEqual(system.needsAmmo(), false, 'a dry sidearm does not make a crate collectable');
        assertEqual(system.addAmmo(), false, 'and a crate gives it nothing');
        assertEqual(system.states[5].reserve, 0, 'it stays dry until the intermission');

        // Intermission refill: back to 36, nothing else touched, idempotent.
        const others = system.states.slice(0, 5).map((st) => st.reserve).join(',');
        assertEqual(system.refillAlwaysCarried(), true, 'the refill reports that it did something');
        assertEqual(system.states[5].reserve, weapon.WEAPON_DEFS.pistol.startReserve, 'to 36 rounds');
        assertEqual(system.states.slice(0, 5).map((st) => st.reserve).join(','), others, 'and nothing else changes');
        assertEqual(system.refillAlwaysCarried(), false, 'a second call in the same break is a no-op');

        // It is an ordinary firearm to the HUD.
        system.requestSwitch(5);
        const hud = system.getHudData();
        assertEqual(hud.name, 'MK2 SIDEARM', 'HUD name');
        assertEqual(hud.hasAmmo, true, 'it renders an ammo block');
        assertEqual(hud.slot, 6, 'key 6');
        assertEqual(hud.ammo, 12, 'a full magazine');

        // ...and on the trigger: the ordinary hitscan path, 30 a round, one round
        // out of the magazine (no new firing code was added for it).
        const { system: shooter, hits, ctx: rangeCtx } = makeRange();
        try {
          assertEqual(shooter.requestSwitch(5), true, 'draw the sidearm in the range');
          shooter.update(0.4, {}, rangeCtx); // finish the draw
          shooter.update(1 / 60, { firePressed: true }, rangeCtx);
          assertEqual(hits.length, 1, 'one round, one hit');
          assertEqual(hits[0].weapon, 'pistol', 'the hit reports the sidearm');
          assertEqual(hits[0].damage, 30, '30 damage a round');
          assertEqual(shooter.getHudData().ammo, 11, 'and one round left the magazine');
        } finally {
          shooter.dispose();
        }
      } finally {
        system.dispose();
      }
    });
  });

  test('the real intermission event refills the sidearm (WaveManager -> Game.onWaveEvent)', () => {
    withDocumentStub(() => {
      const { system } = makeWeaponSystem(['rifle', 'shotgun', 'knife', 'pipe', 'axe']);
      system.states[5].reserve = 0; // a spent sidearm coming out of a wave
      const toasts = [];
      const events = [];
      const restocks = [];
      // A bare Game: the real onWaveEvent() body with its DOM-facing collaborators
      // stubbed, so the wiring under test is the one the browser runs.
      const bareGame = Object.create(gameModule.Game.prototype);
      Object.assign(bareGame, {
        stats: { wave: 0, score: 0 },
        loadout: system.loadout,
        level: { pickups: { ammoCount: 4, restock: (kinds) => restocks.push(kinds) } },
        ui: {
          setCountdown() {},
          showBanner() {},
          toast: (text) => toasts.push(text),
        },
        audio: { playWaveStart() {}, playWaveClear() {} },
        weapons: system,
      });
      try {
        const manager = new wm.WaveManager({
          spawnEnemy: () => true,
          onEvent: (name, payload) => {
            events.push(name);
            bareGame.onWaveEvent(name, payload);
          },
        });
        manager.start();
        manager.update(wm.COUNTDOWN_SECONDS + 1, 0); // countdown over: wave 1 is live
        assertEqual(manager.phase, 'active', 'the wave started');
        for (let i = 0; i < 2400 && manager.phase === 'active'; i++) manager.update(0.05, 0);
        assertEqual(manager.phase, 'intermission', 'the wave ended into the break');
        assert(events.includes('waveCleared'), 'waveCleared is the "intermission starts" event');
        assertNear(manager.timer, wm.INTERMISSION_SECONDS, 0.06, 'and the break is the full intermission');
        assertEqual(system.states[5].reserve, 36, 'the sidearm came back at the intermission');
        assert(toasts.includes('SIDEARM RESTOCKED'), 'with a line in the toast stack');
        assert(bareGame.stats.score > 0, 'the clear bonus still landed');
        // The toast is only for an actual refill: a full sidearm stays quiet.
        toasts.length = 0;
        bareGame.onWaveEvent('waveCleared', { wave: 2, bonus: 600 });
        assert(!toasts.includes('SIDEARM RESTOCKED'), 'no refill, no toast');
        assert(toasts.includes('Supply crates restocked'), 'the crates still restock');
        // Milestone 5: the same event rolls a kind for every crate, for this kit.
        assertEqual(restocks.length, 2, 'one crate roll per intermission');
        for (const kinds of restocks) {
          assertEqual(kinds.length, 4, 'one kind per crate in the level');
          assert(kinds.includes('rifle') && kinds.includes('shell'), 'both carried kinds are on the floor');
          assert(kinds.every((k) => k === 'rifle' || k === 'shell'), 'and nothing the kit cannot use');
        }
      } finally {
        system.dispose();
      }
    });
  });

  /* ---------------- milestone 5: ammo kinds + kind-aware crates ---------------- */
  console.log('\nAmmo kinds');

  test('every ammo kind has a label, a crate colour and a lottery weight; rifle is the common kind', () => {
    for (const kind of weapon.AMMO_KINDS) {
      const info = weapon.AMMO_KIND_INFO[kind];
      assert(info, `${kind} has an AMMO_KIND_INFO row`);
      assert(typeof info.label === 'string' && info.label.length > 0, `${kind} has a HUD label`);
      assert(Number.isInteger(info.color) && Number.isInteger(info.glow), `${kind} has crate colours`);
      assert(info.weight > 0, `${kind} can actually be rolled`);
    }
    for (const kind of Object.keys(weapon.AMMO_KIND_INFO)) {
      assert(weapon.AMMO_KINDS.includes(kind), `${kind} is a schema kind, not a stray row`);
    }
    const w = (k) => weapon.AMMO_KIND_INFO[k].weight;
    // Roadmap §5 acceptance for milestone 5: "LMG ammo is rarer than rifle ammo".
    assert(w('rifle') > w('shell') && w('shell') > w('heavy') && w('heavy') > w('explosive'),
      'rarity runs rifle > shell > heavy > explosive');
    // No two kinds share a stripe colour, or a crate could not state its kind.
    const colours = new Set(weapon.AMMO_KINDS.map((k) => weapon.AMMO_KIND_INFO[k].color));
    assertEqual(colours.size, weapon.AMMO_KINDS.length, 'crate stripes are distinct per kind');
  });

  test('carriedAmmoKinds() lists what the crate-fed guns of a kit use, never the sidearm', () => {
    assertEqual(weapon.carriedAmmoKinds(weapon.DEFAULT_LOADOUT).join(','), 'rifle,shell', 'default kit');
    assertEqual(weapon.carriedAmmoKinds(['smg', 'dmr', 'knife', 'pipe', 'axe']).join(','), 'rifle',
      'two rifle-ammo guns are one kind');
    assertEqual(weapon.carriedAmmoKinds(['shotgun', 'launcher', 'knife', 'pipe', 'axe']).join(','), 'shell,explosive',
      'in AMMO_KINDS order, whatever the key order');
    assertEqual(weapon.carriedAmmoKinds(['launcher', 'shotgun', 'knife', 'pipe', 'axe']).join(','), 'shell,explosive',
      'same kit, same answer');
    // The pistol is in every kit (key 6) and nominally fires rifle rounds, but it
    // never takes a crate, so it must not be the reason rifle crates appear.
    assert(weapon.WEAPON_DEFS.pistol.ammoKind === 'rifle', 'precondition: sidearm nominal kind');
    assertEqual(weapon.carriedAmmoKinds(['shotgun', 'launcher', 'knife', 'pipe', 'axe']).includes('rifle'), false,
      'no rifle crates for a kit whose only rifle-ammo gun is the sidearm');
  });

  test('assignCrateKinds() covers every carried kind, rolls the rest by rarity and never rolls a useless crate', () => {
    const rng = level.makeRng(5);
    const four = weapon.assignCrateKinds(4, ['rifle', 'shell'], rng);
    assertEqual(four.length, 4, 'one kind per crate');
    assert(four.includes('rifle') && four.includes('shell'), 'both kinds are guaranteed with crates to spare');
    assert(four.every((k) => k === 'rifle' || k === 'shell'), 'nothing the kit cannot use');
    // One crate, two kinds: the rule degrades to "one of them", not to a crash.
    const one = weapon.assignCrateKinds(1, ['shell', 'explosive'], rng);
    assertEqual(one.length, 1, 'one crate');
    assert(one[0] === 'shell' || one[0] === 'explosive', 'and it is a carried kind');
    assertEqual(weapon.assignCrateKinds(0, ['rifle'], rng).length, 0, 'no crates, no kinds');
    // Rarity: over many crates the common kind clearly outnumbers the rare one.
    const many = weapon.assignCrateKinds(600, ['rifle', 'explosive'], level.makeRng(11));
    const count = (k) => many.filter((x) => x === k).length;
    assert(count('rifle') > count('explosive') * 3,
      `rifle crates (${count('rifle')}) are much more common than explosive ones (${count('explosive')})`);
    // Deterministic for a seed, so a run can be replayed.
    assertEqual(weapon.assignCrateKinds(8, ['rifle', 'shell'], level.makeRng(99)).join(','),
      weapon.assignCrateKinds(8, ['rifle', 'shell'], level.makeRng(99)).join(','), 'same seed, same crates');
    // The guaranteed crates move around: not always the first spots.
    const positions = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      positions.add(weapon.assignCrateKinds(4, ['rifle', 'shell'], level.makeRng(seed)).indexOf('shell'));
    }
    assert(positions.size > 1, 'the shell crate is not pinned to one spot');
    // Garbage in: unknown kinds are dropped, an empty list means rifle crates.
    assertEqual(weapon.assignCrateKinds(3, ['plasma', 'shell'], rng).every((k) => k === 'shell'), true,
      'unknown kinds are ignored');
    assertEqual(weapon.assignCrateKinds(2, [], rng).join(','), 'rifle,rifle', 'empty list falls back to rifle crates');
  });

  test('needsAmmo(kind) / addAmmo(kind): a crate only feeds the carried guns of its kind, never the sidearm', () => {
    withDocumentStub(() => {
      const { system } = makeWeaponSystem(['rifle', 'shotgun', 'knife', 'pipe', 'axe']);
      const rifle = system.states[0];
      const shotgun = system.states[1];
      const pistol = system.states[5];
      assertEqual(pistol.def.id, 'pistol', 'precondition: the sidearm is on key 6');
      try {
        rifle.reserve = rifle.def.maxReserve;
        shotgun.reserve = 0;
        pistol.reserve = 0;
        assertEqual(system.needsAmmo('rifle'), false, 'a dry shotgun does not make a rifle crate collectable');
        assertEqual(system.needsAmmo('shell'), true, 'a shell crate is');
        assertEqual(system.needsAmmo(), true, 'the untyped check still means "anything has room"');
        assertEqual(system.needsAmmo('explosive'), false, 'a kind the kit does not carry is never wanted');
        assertEqual(system.addAmmo('rifle'), false, 'a rifle crate gives a full rifle nothing');
        assertEqual(shotgun.reserve, 0, 'and does not touch the shotgun');
        assertEqual(pistol.reserve, 0, 'nor the dry sidearm - the intermission refill owns it');
        assertEqual(system.addAmmo('shell'), true, 'a shell crate restocks the shotgun');
        assertEqual(shotgun.reserve, weapon.AMMO_PICKUP.shotgun, 'by its AMMO_PICKUP amount');
        assertEqual(rifle.reserve, rifle.def.maxReserve, 'and leaves the rifle alone');
        assertEqual(pistol.reserve, 0, 'the sidearm still gets nothing from any crate');
        assertEqual(system.needsAmmo('rifle'), false, 'a dry sidearm alone does not want a rifle crate');
        const byKind = system.reservesByKind();
        assertEqual(byKind.rifle, rifle.def.maxReserve, 'reserve per kind: rifle');
        assertEqual(byKind.shell, weapon.AMMO_PICKUP.shotgun, 'reserve per kind: shell');
        assertEqual(byKind.explosive, undefined, 'kinds the kit does not carry are absent');
      } finally {
        system.dispose();
      }
      // One crate, two guns of its kind: both are topped up.
      const pair = makeWeaponSystem(['rifle', 'smg', 'knife', 'pipe', 'axe']).system;
      try {
        pair.states[0].reserve = 0;
        pair.states[1].reserve = 0;
        assertEqual(pair.addAmmo('rifle'), true, 'the rifle crate is accepted');
        assertEqual(pair.states[0].reserve, weapon.AMMO_PICKUP.rifle, 'rifle +45');
        assertEqual(pair.states[1].reserve, weapon.AMMO_PICKUP.smg, 'SMG +90 from the same crate');
        assertEqual(pair.reservesByKind().rifle, weapon.AMMO_PICKUP.rifle + weapon.AMMO_PICKUP.smg,
          'the kind read-out sums both pools');
        const hud = pair.getHudData();
        assertEqual(hud.ammoKind, 'rifle', 'the HUD knows which crate feeds the drawn gun');
        assertEqual(hud.ammoKindLabel, 'RIFLE', 'with its label');
        pair.requestSwitch(2);
        assertEqual(pair.getHudData().ammoKind, null, 'melee has no kind');
        assertEqual(pair.getHudData().ammoKindLabel, '', 'and prints no tag');
      } finally {
        pair.dispose();
      }
    });
  });

  test('PickupSystem crates carry a kind, show it, and hand it to the collect filter', () => {
    const scene = new THREE.Scene();
    const palette = weapon.AMMO_KIND_INFO;
    const pickups = new level.PickupSystem(scene, [{ x: 0, z: 0 }], [{ x: 3, z: 0 }, { x: 6, z: 0 }, { x: 9, z: 0 }], null,
      { ammoKinds: palette });
    try {
      assertEqual(pickups.ammoCount, 3, 'three crates');
      assertEqual(pickups.ammoItems.every((item) => item.kind === 'rifle'), true, 'rifle until told otherwise');
      pickups.restock(['shell', 'explosive', 'rifle']);
      const crates = pickups.ammoItems;
      assertEqual(crates.map((c) => c.kind).join(','), 'shell,explosive,rifle', 'kinds land in layout order');
      // The crate states its kind: stripe and glow take the kind's colours.
      assertEqual(crates[0].stripe.material.color.getHex(), palette.shell.color, 'shell stripe');
      assertEqual(crates[0].glow.material.color.getHex(), palette.shell.glow, 'shell glow');
      assertEqual(crates[1].stripe.material.color.getHex(), palette.explosive.color, 'explosive stripe');
      assertEqual(crates[2].stripe.material.color.getHex(), palette.rifle.color, 'rifle stripe');
      // Materials are shared per kind, not cloned per restock.
      pickups.restock(['rifle', 'rifle', 'rifle']);
      assert(crates[0].stripe.material === crates[2].stripe.material, 'one stripe material per kind');
      assertEqual(crates[0].glow.material.color.getHex(), palette.rifle.glow, 'repainted to rifle');
      pickups.restock(['shell', 'explosive', 'rifle']);
      // The filter sees the kind, and a refusal leaves the crate on the floor.
      const seen = [];
      const refused = pickups.tryCollect(3, 0, 0.5, (type, kind) => { seen.push([type, kind]); return false; });
      assertEqual(refused, null, 'refused crate is not collected');
      assertEqual(seen[0][0], 'ammo', 'the filter was asked about a crate');
      assertEqual(seen[0][1], 'shell', 'and told its kind');
      assertEqual(crates[0].active, true, 'the crate stays');
      const got = pickups.tryCollect(3, 0, 0.5, (type, kind) => kind === 'shell');
      assert(got && got.kind === 'shell', 'accepted by kind');
      assertEqual(crates[0].active, false, 'and taken');
      const health = pickups.tryCollect(0, 0, 0.5, (type, kind) => { seen.push([type, kind]); return true; });
      assertEqual(health.type, 'health', 'health packs still collect');
      assertEqual(seen[seen.length - 1][1], null, 'a health pack has no kind');
      // A short list repeats its last kind; an empty one changes nothing.
      pickups.restock(['explosive']);
      assertEqual(pickups.ammoItems.map((c) => c.kind).join(','), 'explosive,explosive,explosive', 'short list repeats');
      assertEqual(crates[0].active, true, 'restock reactivates');
      pickups.restock([]);
      assertEqual(pickups.ammoItems.map((c) => c.kind).join(','), 'explosive,explosive,explosive', 'empty list keeps kinds');
      // The level's own crates: a two-firearm kit carries at most two kinds, so
      // with this many 'A' cells assignCrateKinds() guarantees each of them a crate.
      assert(plan.ammoSpots.length >= 2, `the facility has crates for every kind (${plan.ammoSpots.length})`);
    } finally {
      pickups.dispose();
    }
  });

  test('collecting a crate in Game refills only its kind and names it in the toast', () => {
    withDocumentStub(() => {
      const { system } = makeWeaponSystem(['rifle', 'shotgun', 'knife', 'pipe', 'axe']);
      const toasts = [];
      const picked = [];
      const scene = new THREE.Scene();
      const pickups = new level.PickupSystem(scene, [], [{ x: 0, z: 0 }, { x: 0, z: 8 }], null,
        { ammoKinds: weapon.AMMO_KIND_INFO });
      const bareGame = Object.create(gameModule.Game.prototype);
      Object.assign(bareGame, {
        loadout: system.loadout,
        level: { pickups },
        player: { position: { x: 0, z: 0 }, health: 100, maxHealth: 100 },
        ui: { toast: (text) => toasts.push(text) },
        audio: { playPickup: (type) => picked.push(type) },
        weapons: system,
      });
      try {
        pickups.restock(['rifle', 'shell']);
        const rifle = system.states[0];
        const shotgun = system.states[1];
        rifle.reserve = rifle.def.maxReserve;
        shotgun.reserve = 0;
        // Standing on a rifle crate with a full rifle: it is not for us.
        bareGame.updatePickups();
        assertEqual(picked.length, 0, 'a full-rifle player walks over the rifle crate');
        assertEqual(pickups.ammoItems[0].active, true, 'which stays for later');
        // Step onto the shell crate.
        bareGame.player.position = { x: 0, z: 8 };
        bareGame.updatePickups();
        assertEqual(picked.join(','), 'ammo', 'the shell crate is taken');
        assertEqual(shotgun.reserve, weapon.AMMO_PICKUP.shotgun, 'shotgun restocked');
        assertEqual(rifle.reserve, rifle.def.maxReserve, 'rifle untouched');
        assertEqual(toasts[toasts.length - 1], 'SHELL AMMO RESTOCKED', 'the toast states the kind');
        // restockSupplies() rolls kinds for the real kit and reactivates the crates.
        bareGame.restockSupplies();
        assertEqual(pickups.ammoItems.every((c) => c.active), true, 'both crates are back');
        const kinds = pickups.ammoItems.map((c) => c.kind);
        assert(kinds.includes('rifle') && kinds.includes('shell'), 'one crate per carried kind');
      } finally {
        pickups.dispose();
        system.dispose();
      }
    });
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

  test('loadStorage returns a sanitized loadout and defaults when it is missing', () => {
    memory.clear();
    assertEqual(storage.loadStorage().loadout.join(','), weapon.DEFAULT_LOADOUT.join(','), 'default when missing');
    memory.set(storage.STORAGE_KEY, JSON.stringify({ loadout: ['shotgun', 'shotgun', 'axe', 'nope', 'nope'] }));
    const loaded = storage.loadStorage();
    assertEqual(loaded.loadout.length, weapon.SLOT_COUNT, 'five slots after a round trip');
    assertEqual(new Set(loaded.loadout).size, weapon.SLOT_COUNT, 'no duplicates survive a round trip');
    assertEqual(loaded.loadout[0], 'shotgun', 'a valid pick is kept');
    memory.set(storage.STORAGE_KEY, JSON.stringify({ loadout: 'rifle' }));
    assertEqual(storage.loadStorage().loadout.join(','), weapon.DEFAULT_LOADOUT.join(','), 'garbage falls back');
    memory.delete(storage.STORAGE_KEY);
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
