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
  console.log('\nWeapons');

  test('shotgun falloff: full damage at 7 m, 30% at 26 m, linear between', () => {
    const def = weapon.WEAPON_DEFS.shotgun;
    assertNear(weapon.computeFalloff(def, 0), 1, 1e-9, 'close range');
    assertNear(weapon.computeFalloff(def, 7), 1, 1e-9, 'start of falloff');
    assertNear(weapon.computeFalloff(def, 26), 0.3, 1e-9, 'end of falloff');
    assertNear(weapon.computeFalloff(def, 40), 0.3, 1e-9, 'beyond the end');
    assertNear(weapon.computeFalloff(def, 16.5), 0.65, 1e-9, 'midpoint');
  });

  test('rifle has no distance falloff and both weapons have headshot bonuses', () => {
    assertEqual(weapon.computeFalloff(weapon.WEAPON_DEFS.rifle, 100), 1, 'rifle falloff');
    assert(weapon.WEAPON_DEFS.rifle.headshotMultiplier > 1, 'rifle headshot multiplier');
    assert(weapon.WEAPON_DEFS.shotgun.headshotMultiplier > 1, 'shotgun headshot multiplier');
  });

  test('weapon magazine and pellet counts match the design', () => {
    assertEqual(weapon.WEAPON_DEFS.rifle.magazineSize, 30, 'rifle mag');
    assertEqual(weapon.WEAPON_DEFS.shotgun.magazineSize, 8, 'shotgun mag');
    assertEqual(weapon.WEAPON_DEFS.shotgun.pellets, 9, 'shotgun pellets');
    assert(weapon.WEAPON_DEFS.rifle.auto === true, 'rifle should be automatic');
    assert(weapon.WEAPON_DEFS.shotgun.auto === false, 'shotgun should not be automatic');
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
