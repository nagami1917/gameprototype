/**
 * level.js
 * ------------------------------------------------------------------
 * The abandoned research facility.
 *
 * The map is an ASCII grid (LAYOUT). Every character is a 2 m cell:
 *   #  concrete wall (4 m tall)        .  floor
 *   D  sliding blast door              C  storage crate (cover)
 *   L  lab bench (cover)               T  cryo tank (cover)
 *   M  control console (cover)         S  enemy spawn point
 *   P  player start                    H  health pickup spot
 *   A  ammo pickup spot                l  flickering ceiling light
 *   E  emergency beacon (flashing red)
 *
 * The module is split in two layers so that it can be tested in Node:
 *   1. planLayout()  - pure data: colliders, props, lights, spawns, nav data.
 *   2. Level         - turns the plan into Three.js meshes, lights and animation.
 */
import * as THREE from 'three';
import { createBox, boxFromCenter } from './collision.js';
import { NavGrid } from './enemyAI.js';
import {
  createConcreteTexture,
  createFloorTexture,
  createCeilingTexture,
  createCrateTexture,
  createDoorTexture,
  createScreenTexture,
  createWarningSignTexture,
  createGlowTexture,
} from './textures.js';

export const CELL_SIZE = 2;
export const WALL_HEIGHT = 4;
export const NAV_CELL = 1;
export const NAV_AGENT_RADIUS = 0.42;
export const MAX_POINT_LIGHTS = 8;

export const LAYOUT = [
  '##############################',
  '#P.......#.A.......#S.......S#',
  '#........#..LL.....#.........#',
  '#..C.....#..LL..E..#..T...T..#',
  '#....l...D.........#.........#',
  '#........#M.......SD........S#',
  '#.C....C.#....l....#....l....#',
  '#...M....#C.......C#..M......#',
  '#H......S#.........#.........#',
  '####D#########D#########D#####',
  '#............l...............#',
  '####D#########D#########D#####',
  '#C......S#.........#S.......S#',
  '#........#M.......M#.........#',
  '#.CC.....#.........#...T.T...#',
  '#........#..LLL....#.........#',
  '#..E.M...#.........#....l....#',
  '#..L.....#....l....#S.......S#',
  '#........#M........#....C....#',
  '#C.....C.#.........#...H.....#',
  '#...A....#....A....#S.......S#',
  '##############################',
];

/* ------------------------------------------------------------------ *
 * Pure planning helpers (no Three.js objects, safe to unit test)
 * ------------------------------------------------------------------ */

/** Seeded PRNG for deterministic prop placement. */
export function makeRng(seed = 2024) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Validates the ASCII layout and returns a grid object. */
export function parseLayout(rows) {
  if (!Array.isArray(rows) || rows.length < 3) throw new Error('Layout needs at least 3 rows');
  const cols = rows[0].length;
  rows.forEach((row, j) => {
    if (row.length !== cols) throw new Error(`Layout row ${j} has length ${row.length}, expected ${cols}`);
  });
  for (let i = 0; i < cols; i++) {
    if (rows[0][i] !== '#' || rows[rows.length - 1][i] !== '#') throw new Error('Layout must be enclosed by walls');
  }
  return { cols, rows: rows.length, grid: rows.map((r) => r.split('')) };
}

/** Cell centre in world coordinates. */
export function cellCenter(c, r) {
  return { x: (c + 0.5) * CELL_SIZE, z: (r + 0.5) * CELL_SIZE };
}

/** Characters that behave as solid (blocking) cells on the grid. */
const SOLID_CHARS = new Set(['#', 'C', 'L', 'T', 'M']);

/**
 * Builds the complete static plan of the level.
 * @param {ReturnType<typeof parseLayout>} layout
 * @param {() => number} rng  random source (seeded for stable props)
 */
export function planLayout(layout, rng = makeRng()) {
  const { cols, rows, grid } = layout;
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? '#' : grid[r][c]);
  const isWall = (c, r) => at(c, r) === '#';
  const S = CELL_SIZE;

  const plan = {
    cols,
    rows,
    bounds: { minX: 0, minZ: 0, maxX: cols * S, maxZ: rows * S },
    wallBoxes: [],
    wallRuns: [],
    props: { crates: [], benches: [], tanks: [], consoles: [], pipes: [] },
    doors: [],
    lights: [],
    emergencyLights: [],
    spawns: [],
    healthSpots: [],
    ammoSpots: [],
    playerStart: null,
    signs: [],
    colliders: [],
  };

  // 1. Walls: merge horizontal runs of '#' into single boxes.
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!isWall(c, r)) { c++; continue; }
      const start = c;
      while (c < cols && isWall(c, r)) c++;
      const box = createBox(start * S, 0, r * S, c * S, WALL_HEIGHT, (r + 1) * S, 'wall');
      plan.wallBoxes.push(box);
      plan.wallRuns.push({ box, tint: 0.82 + rng() * 0.18 });
    }
  }

  // 2. Per-cell features.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = at(c, r);
      const { x, z } = cellCenter(c, r);
      switch (ch) {
        case 'P':
          plan.playerStart = { x, z };
          break;
        case 'S':
          plan.spawns.push({ x, z });
          break;
        case 'H':
          plan.healthSpots.push({ x, z });
          break;
        case 'A':
          plan.ammoSpots.push({ x, z });
          break;
        case 'l':
          plan.lights.push({ x, z });
          break;
        case 'E':
          plan.emergencyLights.push({ x, z });
          break;
        case 'D': {
          // Horizontal wall line (walls left & right) -> panel spans X.
          const horizontal = isWall(c - 1, r) && isWall(c + 1, r);
          const door = { x, z, horizontal, openAmount: 0, hold: 0, collider: null };
          door.collider = horizontal
            ? createBox(x - S / 2, 0, z - 0.15, x + S / 2, WALL_HEIGHT, z + 0.15, 'door')
            : createBox(x - 0.15, 0, z - S / 2, x + 0.15, WALL_HEIGHT, z + S / 2, 'door');
          plan.doors.push(door);
          break;
        }
        case 'C': {
          const w = 1.25 + rng() * 0.35;
          const d = 1.25 + rng() * 0.35;
          const h = 1.0 + rng() * 0.3;
          const ox = (rng() - 0.5) * 0.3;
          const oz = (rng() - 0.5) * 0.3;
          const crate = {
            x: x + ox, z: z + oz, w, d, h, rot: rng() < 0.5 ? 0 : Math.PI / 2,
            stacked: rng() < 0.35,
          };
          plan.props.crates.push(crate);
          const sx = crate.rot ? d : w;
          const sz = crate.rot ? w : d;
          plan.colliders.push(boxFromCenter(crate.x, h / 2, crate.z, sx, h, sz, 'crate'));
          break;
        }
        case 'L': {
          const bench = { x, z, rot: rng() < 0.5 ? 0 : Math.PI / 2, seed: rng() };
          plan.props.benches.push(bench);
          const sx = bench.rot ? 0.8 : 1.7;
          const sz = bench.rot ? 1.7 : 0.8;
          plan.colliders.push(boxFromCenter(x, 0.9 / 2, z, sx, 0.9, sz, 'bench'));
          break;
        }
        case 'T': {
          plan.props.tanks.push({ x, z });
          plan.colliders.push(boxFromCenter(x, 2.5 / 2, z, 1.2, 2.5, 1.2, 'tank'));
          break;
        }
        case 'M': {
          const rot = Math.floor(rng() * 4) * (Math.PI / 2);
          plan.props.consoles.push({ x, z, rot, seed: Math.floor(rng() * 1000) + 1 });
          const sx = rot % Math.PI === 0 ? 1.4 : 0.6;
          const sz = rot % Math.PI === 0 ? 0.6 : 1.4;
          plan.colliders.push(boxFromCenter(x, 1.3 / 2, z, sx, 1.3, sz, 'console'));
          break;
        }
        default:
          break;
      }
    }
  }

  // 3. Wall signage: a deterministic subset of walls facing a corridor/room.
  const kinds = ['danger', 'biohazard', 'quarantine', 'keepclear'];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (!isWall(c, r)) continue;
      if (((c * 7 + r * 13) % 11) !== 0) continue;
      // Pick the first open neighbour (east, west, south, north).
      const faces = [
        { dc: 1, dr: 0, rotY: -Math.PI / 2 },
        { dc: -1, dr: 0, rotY: Math.PI / 2 },
        { dc: 0, dr: 1, rotY: Math.PI },
        { dc: 0, dr: -1, rotY: 0 },
      ];
      const face = faces.find((f) => !isWall(c + f.dc, r + f.dr) && at(c + f.dc, r + f.dr) !== 'D');
      if (!face) continue;
      const wx = (c + 0.5) * S + face.dc * (S / 2 + 0.01);
      const wz = (r + 0.5) * S + face.dr * (S / 2 + 0.01);
      plan.signs.push({
        x: wx,
        z: wz,
        y: 2.35,
        rotY: face.rotY,
        kind: kinds[(c + r) % kinds.length],
      });
    }
  }

  // 4. Ceiling pipes along corridors (visual only).
  for (let r = 0; r < rows; r++) {
    let runStart = -1;
    for (let c = 0; c <= cols; c++) {
      const open = c < cols && !isWall(c, r);
      if (open && runStart < 0) runStart = c;
      if (!open && runStart >= 0) {
        if (c - runStart >= 6) {
          plan.props.pipes.push({ x0: runStart * S, x1: c * S, z: (r + 0.5) * S + 0.55, y: 3.45 });
        }
        runStart = -1;
      }
    }
  }

  // 5. Static collision set: walls + props. Doors are appended separately.
  plan.colliders = [...plan.wallBoxes, ...plan.colliders];
  plan.staticBoxes = plan.colliders.slice();
  plan.doorBoxes = plan.doors.map((d) => d.collider);
  plan.colliders.push(...plan.doorBoxes);
  return plan;
}

/** Builds the nav grid from a plan (static boxes only; doors are passable). */
export function buildNavGrid(plan) {
  return new NavGrid(plan.bounds, NAV_CELL, plan.staticBoxes, NAV_AGENT_RADIUS);
}

/* ------------------------------------------------------------------ *
 * Mesh batching: merges many axis-aligned boxes into a single draw call.
 * ------------------------------------------------------------------ */
class BoxBatch {
  /**
   * @param {'world'|'unit'} uvMode  'world' tiles textures in metres,
   *   'unit' maps each face to 0..1 (used for crates and labels).
   */
  constructor(uvMode = 'world', uvScale = 0.5) {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.colors = [];
    this.indices = [];
    this.uvMode = uvMode;
    this.uvScale = uvScale;
    this.vertexCount = 0;
  }

  addBox(x0, y0, z0, x1, y1, z1, hex = 0xffffff) {
    const min = [x0, y0, z0];
    const max = [x1, y1, z1];
    const color = new THREE.Color(hex); // converted to linear working space
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      for (const sign of [-1, 1]) {
        const base = this.vertexCount;
        const normal = [0, 0, 0];
        normal[axis] = sign;
        const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
        for (const [a, b] of corners) {
          const p = [0, 0, 0];
          p[axis] = sign > 0 ? max[axis] : min[axis];
          p[u] = a ? max[u] : min[u];
          p[v] = b ? max[v] : min[v];
          this.positions.push(p[0], p[1], p[2]);
          this.normals.push(normal[0], normal[1], normal[2]);
          if (this.uvMode === 'unit') {
            this.uvs.push(a, b);
          } else {
            this.uvs.push(p[u] * this.uvScale, p[v] * this.uvScale);
          }
          this.colors.push(color.r, color.g, color.b);
          this.vertexCount++;
        }
        // Winding: (u,v) is counter-clockwise around +axis; reverse for -axis faces.
        if (sign > 0) this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else this.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

/* ------------------------------------------------------------------ *
 * Pickups: health packs and ammo boxes that respawn during supply breaks.
 * ------------------------------------------------------------------ */
export class PickupSystem {
  constructor(scene, healthSpots, ammoSpots, glowTexture) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.items = [];

    const healthGroup = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.36, 0.42),
      new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.5, metalness: 0.1 }),
    );
    const crossMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xaa0000, emissiveIntensity: 0.8 });
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.26), crossMat);
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.08), crossMat);
    crossV.position.y = 0.19;
    crossH.position.y = 0.19;
    healthGroup.add(base, crossV, crossH);

    const ammoGroup = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(0.56, 0.32, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x4f5e2c, roughness: 0.7, metalness: 0.3 }),
    );
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 0.05, 0.44),
      new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.5, emissive: 0x332200 }),
    );
    stripe.position.y = 0.0;
    ammoGroup.add(crate, stripe);

    this.healthTemplate = healthGroup;
    this.ammoTemplate = ammoGroup;
    this.glowTexture = glowTexture;
    this.glowMaterials = {
      health: new THREE.SpriteMaterial({ map: glowTexture, color: 0x66ff99, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }),
      ammo: new THREE.SpriteMaterial({ map: glowTexture, color: 0xffd34d, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }),
    };

    for (const spot of healthSpots) this.addItem('health', spot);
    for (const spot of ammoSpots) this.addItem('ammo', spot);
    this.setAllActive(true);
  }

  addItem(type, spot) {
    const template = type === 'health' ? this.healthTemplate : this.ammoTemplate;
    const mesh = template.clone(true);
    mesh.position.set(spot.x, 0.3, spot.z);
    const glow = new THREE.Sprite(this.glowMaterials[type]);
    glow.scale.set(1.1, 1.1, 1);
    glow.position.set(0, 0.2, 0);
    mesh.add(glow);
    this.group.add(mesh);
    this.items.push({ type, x: spot.x, z: spot.z, mesh, active: true, phase: Math.random() * 6 });
  }

  /** Makes every pickup spot available again (supply break). */
  setAllActive(active) {
    for (const item of this.items) {
      item.active = active;
      item.mesh.visible = active;
    }
  }

  /**
   * Returns the first active pickup within `radius` that `accept(type)` allows,
   * and deactivates it. Returns null if nothing is collected.
   */
  tryCollect(x, z, radius, accept) {
    for (const item of this.items) {
      if (!item.active) continue;
      if (Math.hypot(item.x - x, item.z - z) > radius) continue;
      if (!accept(item.type)) continue;
      item.active = false;
      item.mesh.visible = false;
      return item;
    }
    return null;
  }

  update(dt, time) {
    for (const item of this.items) {
      if (!item.active) continue;
      item.mesh.position.y = 0.3 + Math.sin(time * 2.2 + item.phase) * 0.06;
      item.mesh.rotation.y += dt * 0.9;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    this.healthTemplate.traverse((o) => o.material && o.material.dispose());
    this.ammoTemplate.traverse((o) => o.material && o.material.dispose());
    this.glowMaterials.health.dispose();
    this.glowMaterials.ammo.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * Level: the visual + interactive world built from the plan.
 * ------------------------------------------------------------------ */
export class Level {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts
   * @param {THREE.WebGLRenderer} [opts.renderer]  used for anisotropy
   * @param {string[]} [opts.rows]  layout override (defaults to LAYOUT)
   */
  constructor(scene, { renderer = null, rows = LAYOUT } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.time = 0;
    this.disposables = [];

    const layout = parseLayout(rows);
    this.plan = planLayout(layout, makeRng(2024));
    this.bounds = this.plan.bounds;
    this.colliders = this.plan.colliders;
    this.spawnPoints = this.plan.spawns;
    this.playerStart = this.plan.playerStart;
    this.doors = this.plan.doors;
    this.navGrid = buildNavGrid(this.plan);

    const anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
    this.textures = {
      concrete: this.track(createConcreteTexture({ anisotropy })),
      floor: this.track(createFloorTexture({ anisotropy })),
      ceiling: this.track(createCeilingTexture({ anisotropy })),
      crate: this.track(createCrateTexture({ anisotropy })),
      door: this.track(createDoorTexture({ anisotropy })),
    };
    this.textures.floor.repeat.set((this.bounds.maxX) / 4, (this.bounds.maxZ) / 4);
    this.textures.ceiling.repeat.set((this.bounds.maxX) / 4, (this.bounds.maxZ) / 4);
    this.textures.concrete.repeat.set(1, 1);

    this.buildFloorAndCeiling();
    this.buildWalls();
    this.buildProps();
    this.buildDoors();
    this.buildLights();
    this.buildSigns(anisotropy);

    this.glowTexture = this.track(createGlowTexture('#ffffff'));
    this.pickups = new PickupSystem(scene, this.plan.healthSpots, this.plan.ammoSpots, this.glowTexture);
    this.dust = null;
  }

  track(obj) {
    this.disposables.push(obj);
    return obj;
  }

  addMesh(geometry, material, { cast = true, receive = true } = {}) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.group.add(mesh);
    return mesh;
  }

  buildFloorAndCeiling() {
    const { maxX, maxZ } = this.bounds;
    const floorGeo = new THREE.PlaneGeometry(maxX, maxZ);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = this.track(new THREE.MeshStandardMaterial({
      map: this.textures.floor, color: 0xc8d0d8, roughness: 0.72, metalness: 0.35,
    }));
    const floor = this.addMesh(floorGeo, floorMat, { cast: false });
    floor.position.set(maxX / 2, 0, maxZ / 2);

    const ceilGeo = new THREE.PlaneGeometry(maxX, maxZ);
    ceilGeo.rotateX(Math.PI / 2);
    const ceilMat = this.track(new THREE.MeshStandardMaterial({
      map: this.textures.ceiling, color: 0x9aa4b0, roughness: 0.9,
    }));
    const ceil = this.addMesh(ceilGeo, ceilMat, { cast: false });
    ceil.position.set(maxX / 2, WALL_HEIGHT, maxZ / 2);
  }

  buildWalls() {
    const batch = new BoxBatch('world', 0.5);
    for (const { box, tint } of this.plan.wallRuns) {
      const g = Math.round(tint * 255);
      const hex = (g << 16) | (g << 8) | g;
      batch.addBox(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, hex);
    }
    // Trim along the base of every wall for a more finished look.
    for (const { box } of this.plan.wallRuns) {
      batch.addBox(box.minX - 0.02, 0, box.minZ - 0.02, box.maxX + 0.02, 0.12, box.maxZ + 0.02, 0x2a2e33);
    }
    const mat = this.track(new THREE.MeshStandardMaterial({
      map: this.textures.concrete, vertexColors: true, roughness: 0.95, metalness: 0,
    }));
    this.wallMesh = this.addMesh(batch.toGeometry(), mat);
  }

  buildProps() {
    const { crates, benches, tanks, consoles, pipes } = this.plan.props;
    const metalBatch = new BoxBatch('world', 0.6);
    const crateBatch = new BoxBatch('unit');

    // Storage crates (textured, vertex-tinted, optional stacked crate).
    for (const c of crates) {
      const sx = c.rot ? c.d : c.w;
      const sz = c.rot ? c.w : c.d;
      const tint = 0.7 + ((Math.abs(Math.sin(c.x * 12.9898 + c.z * 78.233)) * 0.3));
      const hex = new THREE.Color(tint, tint * 0.92, tint * 0.78).getHex();
      crateBatch.addBox(c.x - sx / 2, 0, c.z - sz / 2, c.x + sx / 2, c.h, c.z + sz / 2, hex);
      if (c.stacked) {
        const h2 = 0.7;
        crateBatch.addBox(c.x - sx * 0.4, c.h, c.z - sz * 0.4, c.x + sx * 0.35, c.h + h2, c.z + sz * 0.35, hex);
      }
    }
    const crateMat = this.track(new THREE.MeshStandardMaterial({
      map: this.textures.crate, vertexColors: true, roughness: 0.85, metalness: 0,
    }));
    this.addMesh(crateBatch.toGeometry(), crateMat);

    // Lab benches: slab top, four legs, and a few instruments on top.
    for (const b of benches) {
      const sx = b.rot ? 0.8 : 1.7;
      const sz = b.rot ? 1.7 : 0.8;
      const x0 = b.x - sx / 2;
      const z0 = b.z - sz / 2;
      metalBatch.addBox(x0, 0.84, z0, x0 + sx, 0.9, z0 + sz, 0x9aa5ad);
      for (const [lx, lz] of [[0.08, 0.08], [sx - 0.08, 0.08], [0.08, sz - 0.08], [sx - 0.08, sz - 0.08]]) {
        metalBatch.addBox(x0 + lx - 0.04, 0, z0 + lz - 0.04, x0 + lx + 0.04, 0.84, z0 + lz + 0.04, 0x3a4048);
      }
      const rnd = b.seed;
      for (let i = 0; i < 3; i++) {
        const ix = x0 + 0.2 + i * (sx - 0.4) / 2;
        const iz = b.z + (rnd - 0.5) * 0.1;
        const h = 0.15 + ((rnd * (i + 3)) % 1) * 0.2;
        const tint = i === 1 ? 0x3ad6c0 : 0xe6eef2;
        metalBatch.addBox(ix - 0.08, 0.9, iz - 0.08, ix + 0.08, 0.9 + h, iz + 0.08, tint);
      }
    }

    // Consoles: body + emissive screen on the front face.
    for (const k of consoles) {
      const body = new THREE.Group();
      const bodyMat = this.track(new THREE.MeshStandardMaterial({ color: 0x2b323b, roughness: 0.55, metalness: 0.4 }));
      const boxGeo = new THREE.BoxGeometry(1.4, 1.3, 0.6);
      const mesh = new THREE.Mesh(boxGeo, bodyMat);
      mesh.position.y = 0.65;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      body.add(mesh);
      const screenMat = this.track(new THREE.MeshBasicMaterial({ map: this.track(createScreenTexture(k.seed)), toneMapped: false }));
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), screenMat);
      screen.position.set(0, 0.9, 0.305);
      body.add(screen);
      body.position.set(k.x, 0, k.z);
      body.rotation.y = k.rot;
      this.group.add(body);
    }

    // Cryo tanks: glass shell with a glowing liquid core and metal base.
    const glassMat = this.track(new THREE.MeshStandardMaterial({
      color: 0x8ff5d0, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, depthWrite: false,
    }));
    const liquidMat = this.track(new THREE.MeshStandardMaterial({
      color: 0x0d3a2a, emissive: 0x25ff9a, emissiveIntensity: 1.1, roughness: 0.3,
    }));
    const baseMat = this.track(new THREE.MeshStandardMaterial({ color: 0x30363e, roughness: 0.5, metalness: 0.6 }));
    for (const t of tanks) {
      const glass = this.addMesh(new THREE.CylinderGeometry(0.6, 0.6, 2.4, 20, 1, true), glassMat, { cast: false });
      glass.position.set(t.x, 1.4, t.z);
      const liquid = this.addMesh(new THREE.CylinderGeometry(0.5, 0.5, 2.1, 16), liquidMat, { cast: false, receive: false });
      liquid.position.set(t.x, 1.3, t.z);
      const base = this.addMesh(new THREE.CylinderGeometry(0.66, 0.7, 0.2, 20), baseMat);
      base.position.set(t.x, 0.1, t.z);
      const cap = this.addMesh(new THREE.CylinderGeometry(0.62, 0.62, 0.16, 20), baseMat);
      cap.position.set(t.x, 2.6, t.z);
    }

    // Ceiling pipes (decor).
    for (const p of pipes) {
      metalBatch.addBox(p.x0, p.y, p.z - 0.08, p.x1, p.y + 0.16, p.z + 0.08, 0x3b434c);
    }

    const metalMat = this.track(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.6, metalness: 0.45,
    }));
    this.addMesh(metalBatch.toGeometry(), metalMat);
  }

  buildDoors() {
    const doorGeo = new THREE.BoxGeometry(1, 1, 1);
    const doorMat = this.track(new THREE.MeshStandardMaterial({
      map: this.textures.door, roughness: 0.55, metalness: 0.55,
    }));
    const frameBatch = new BoxBatch('world', 0.6);
    for (const d of this.doors) {
      const panel = new THREE.Mesh(doorGeo, doorMat);
      panel.castShadow = true;
      panel.receiveShadow = true;
      if (d.horizontal) {
        panel.scale.set(2, WALL_HEIGHT, 0.2);
      } else {
        panel.scale.set(0.2, WALL_HEIGHT, 2);
      }
      panel.position.set(d.x, WALL_HEIGHT / 2, d.z);
      this.group.add(panel);
      d.panel = panel;
      d.baseHeight = WALL_HEIGHT;
      // Frame posts on both sides of the opening (static decor).
      const post = 0.22;
      if (d.horizontal) {
        frameBatch.addBox(d.x - 1 - post, 0, d.z - 0.2, d.x - 1, WALL_HEIGHT, d.z + 0.2, 0x59606a);
        frameBatch.addBox(d.x + 1, 0, d.z - 0.2, d.x + 1 + post, WALL_HEIGHT, d.z + 0.2, 0x59606a);
      } else {
        frameBatch.addBox(d.x - 0.2, 0, d.z - 1 - post, d.x + 0.2, WALL_HEIGHT, d.z - 1, 0x59606a);
        frameBatch.addBox(d.x - 0.2, 0, d.z + 1, d.x + 0.2, WALL_HEIGHT, d.z + 1 + post, 0x59606a);
      }
    }
    const frameMat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.5 }));
    this.addMesh(frameBatch.toGeometry(), frameMat);
  }

  buildLights() {
    const panelGeo = new THREE.BoxGeometry(1.2, 0.04, 0.45);
    this.lights = [];
    let pointBudget = MAX_POINT_LIGHTS;

    const addFixture = (p, emergency) => {
      if (emergency) {
        const beaconMat = this.track(new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false }));
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), beaconMat);
        beacon.position.set(p.x, WALL_HEIGHT - 0.35, p.z);
        this.group.add(beacon);
        let light = null;
        if (pointBudget > 0) {
          pointBudget--;
          light = new THREE.PointLight(0xff3322, 0, 11, 2);
          light.position.set(p.x, WALL_HEIGHT - 0.5, p.z);
          this.group.add(light);
        }
        this.lights.push({ kind: 'emergency', light, beacon, beaconMat, phase: Math.random() * 6, base: 22 });
        return;
      }
      const mat = this.track(new THREE.MeshBasicMaterial({ color: 0xdfeaff, toneMapped: false }));
      const panel = new THREE.Mesh(panelGeo, mat);
      panel.position.set(p.x, WALL_HEIGHT - 0.02, p.z);
      this.group.add(panel);
      let light = null;
      if (pointBudget > 0) {
        pointBudget--;
        light = new THREE.PointLight(0xc4dcff, 16, 12, 2);
        light.position.set(p.x, WALL_HEIGHT - 0.6, p.z);
        this.group.add(light);
      }
      this.lights.push({
        kind: 'flicker', light, panelMat: mat, phase: Math.random() * 6,
        base: 16, timer: 1 + Math.random() * 4, off: false,
      });
    };

    for (const p of this.plan.lights) addFixture(p, false);
    for (const p of this.plan.emergencyLights) addFixture(p, true);
  }

  buildSigns(anisotropy) {
    const geo = new THREE.PlaneGeometry(1.2, 0.6);
    const mats = {};
    for (const s of this.plan.signs) {
      if (!mats[s.kind]) {
        mats[s.kind] = this.track(new THREE.MeshStandardMaterial({
          map: this.track(createWarningSignTexture(s.kind, { anisotropy })),
          roughness: 0.6,
          emissive: 0x221100,
          emissiveIntensity: 0.6,
        }));
      }
      const mesh = new THREE.Mesh(geo, mats[s.kind]);
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = s.rotY;
      this.group.add(mesh);
    }
  }

  /**
   * Per-frame animation: door sliding, flickering lights, emergency pulses.
   * @param {number} dt
   * @param {Array<{x:number,z:number}>} actors  positions that can open doors
   */
  update(dt, actors = []) {
    this.time += dt;
    const t = this.time;

    // Doors open when an actor is near and close after a short hold.
    for (const d of this.doors) {
      let near = false;
      for (const a of actors) {
        if (Math.hypot(a.x - d.x, a.z - d.z) < 2.3) { near = true; break; }
      }
      if (near) d.hold = 1.6;
      else d.hold = Math.max(0, d.hold - dt);
      const target = d.hold > 0 ? 1 : 0;
      d.openAmount += Math.max(-dt * 2.5, Math.min(dt * 2.5, target - d.openAmount));
      // Collider is solid until the door is mostly open.
      d.collider.active = d.openAmount < 0.6;
      // Shutter animation: the panel retracts into the ceiling.
      const h = Math.max(0.02, WALL_HEIGHT * (1 - d.openAmount));
      d.panel.scale.y = h;
      d.panel.position.y = WALL_HEIGHT - h / 2;
      d.panel.visible = h > 0.05;
    }

    // Ceiling lights: mostly steady with occasional stutters.
    for (const L of this.lights) {
      if (L.kind === 'flicker') {
        L.timer -= dt;
        if (L.timer <= 0) {
          if (L.off) {
            L.off = false;
            L.timer = 2 + Math.random() * 5;
          } else if (Math.random() < 0.35) {
            L.off = true;
            L.timer = 0.04 + Math.random() * 0.22;
          } else {
            L.timer = 1.5 + Math.random() * 4;
          }
        }
        const level = L.off ? 0.08 : 0.94 + 0.06 * Math.sin(t * 9 + L.phase);
        if (L.light) L.light.intensity = L.base * level;
        L.panelMat.color.setRGB(0.87 * level, 0.92 * level, 1.0 * level);
      } else {
        // Emergency beacon: sharp alarm pulse.
        const pulse = Math.pow(Math.max(0, Math.sin(t * 5 + L.phase)), 6);
        if (L.light) L.light.intensity = L.base * pulse;
        L.beaconMat.color.setRGB(0.25 + 0.75 * pulse, 0.05 * pulse, 0.03 * pulse + 0.02);
      }
    }
  }

  /** Frees geometry, materials, textures and pickups. */
  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const obj of this.disposables) {
      if (obj.dispose) obj.dispose();
    }
    this.pickups.dispose();
  }
}
