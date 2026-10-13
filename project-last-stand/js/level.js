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
  createScreenAtlas,
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
          // Back-reference from the hit box to the door, so bullet marks placed
          // on it can be culled as soon as the panel starts retracting.
          door.collider.owner = door;
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

/**
 * Merges indexed geometries (box, plane, cylinder, sphere) into one BufferGeometry.
 * Each part is transformed by its matrix; positions, normals and uvs are kept.
 * @param {Array<{geometry: THREE.BufferGeometry, matrix: THREE.Matrix4}>} parts
 * @returns {{geometry: THREE.BufferGeometry, offsets: number[]}}  offsets[i] = first vertex of part i
 */
export function mergeGeometries(parts) {
  let vCount = 0;
  let iCount = 0;
  for (const { geometry } of parts) {
    const n = geometry.attributes.position.count;
    vCount += n;
    iCount += geometry.index ? geometry.index.count : n;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  const offsets = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let v = 0;
  let k2 = 0;
  for (const { geometry, matrix } of parts) {
    const src = geometry.attributes;
    const count = src.position.count;
    offsets.push(v);
    normalMatrix.getNormalMatrix(matrix);
    for (let k = 0; k < count; k++) {
      p.fromBufferAttribute(src.position, k).applyMatrix4(matrix);
      pos[(v + k) * 3] = p.x;
      pos[(v + k) * 3 + 1] = p.y;
      pos[(v + k) * 3 + 2] = p.z;
      n.fromBufferAttribute(src.normal, k).applyNormalMatrix(normalMatrix).normalize();
      nor[(v + k) * 3] = n.x;
      nor[(v + k) * 3 + 1] = n.y;
      nor[(v + k) * 3 + 2] = n.z;
      uv[(v + k) * 2] = src.uv.getX(k);
      uv[(v + k) * 2 + 1] = src.uv.getY(k);
    }
    if (geometry.index) {
      for (let k = 0; k < geometry.index.count; k++) idx[k2++] = geometry.index.getX(k) + v;
    } else {
      for (let k = 0; k < count; k++) idx[k2++] = v + k;
    }
    v += count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return { geometry: geo, offsets };
}

/**
 * Replaces the separate meshes inside `group` that share a material with one
 * merged mesh per material. Mesh transforms are baked into the geometry, so the
 * group itself can still be animated as a whole. Used for the viewmodels.
 */
export function mergeMeshesByMaterial(group) {
  const byMaterial = new Map();
  for (const child of group.children) {
    if (!child.isMesh) continue;
    child.updateMatrix();
    if (!byMaterial.has(child.material)) byMaterial.set(child.material, []);
    byMaterial.get(child.material).push(child);
  }
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const { geometry } = mergeGeometries(meshes.map((m) => ({ geometry: m.geometry, matrix: m.matrix })));
    for (const m of meshes) {
      group.remove(m);
      m.geometry.dispose();
    }
    group.add(new THREE.Mesh(geometry, material));
  }
}

/** Maps a unit plane's uvs onto one row of a texture atlas (row 0 is the top row). */
function remapUvToAtlasRow(geometry, row, rows) {
  const uv = geometry.attributes.uv;
  const v1 = 1 - row / rows;
  const v0 = 1 - (row + 1) / rows;
  for (let k = 0; k < uv.count; k++) uv.setY(k, v0 + uv.getY(k) * (v1 - v0));
  uv.needsUpdate = true;
}

/** Translation (and optional Y rotation) helper for merge matrices. */
function placeMatrix(x, y, z, rotY = 0) {
  const m = new THREE.Matrix4().makeRotationY(rotY);
  m.setPosition(x, y, z);
  return m;
}

/* ------------------------------------------------------------------ *
 * Pickups: health packs and ammo crates that respawn during supply breaks.
 *
 * Every ammo crate carries an ammo *kind* (milestone 5): the game rolls one per
 * crate at each restock (weapon.js assignCrateKinds()) and the crate shows it
 * with its stripe and glow colour. The palette comes in through the
 * constructor, because weapon.js imports this module and must not be imported
 * back; `DEFAULT_CRATE_STYLE` is only the look of a kind the palette lacks.
 * ------------------------------------------------------------------ */
const DEFAULT_AMMO_KIND = 'rifle';
const DEFAULT_CRATE_STYLE = Object.freeze({ color: 0xf2c200, glow: 0xffd34d });

export class PickupSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {{x:number,z:number}[]} healthSpots
   * @param {{x:number,z:number}[]} ammoSpots
   * @param {THREE.Texture|null} glowTexture
   * @param {{ ammoKinds?: Record<string, {color:number, glow:number}> }} [opts]
   *   `ammoKinds` is the per-kind crate palette (weapon.js AMMO_KIND_INFO)
   */
  constructor(scene, healthSpots, ammoSpots, glowTexture, { ammoKinds = {} } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.items = [];

    const healthGroup = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.36, 0.42),
      new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.5, metalness: 0.1 }),
    );
    // The red cross is two bars with one material: merged into a single mesh.
    const crossMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xaa0000, emissiveIntensity: 0.8 });
    const cross = new THREE.Mesh(mergeGeometries([
      { geometry: new THREE.BoxGeometry(0.08, 0.02, 0.26), matrix: placeMatrix(0, 0.19, 0) },
      { geometry: new THREE.BoxGeometry(0.26, 0.02, 0.08), matrix: placeMatrix(0, 0.19, 0) },
    ]).geometry, crossMat);
    healthGroup.add(base, cross);

    // One stripe material and one glow material per ammo kind; a crate swaps
    // between them when its kind changes, so a restock allocates nothing.
    this.glowTexture = glowTexture;
    this.crateStyles = new Map();
    const styleFor = (kind) => {
      if (!this.crateStyles.has(kind)) {
        const palette = ammoKinds[kind] ?? DEFAULT_CRATE_STYLE;
        this.crateStyles.set(kind, {
          stripe: new THREE.MeshStandardMaterial({
            color: palette.color, roughness: 0.5, emissive: palette.color, emissiveIntensity: 0.18,
          }),
          glow: new THREE.SpriteMaterial({
            map: glowTexture, color: palette.glow, transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending, opacity: 0.7,
          }),
        });
      }
      return this.crateStyles.get(kind);
    };
    for (const kind of Object.keys(ammoKinds)) styleFor(kind);
    this.crateStyleFor = (kind) => styleFor(ammoKinds[kind] ? kind : DEFAULT_AMMO_KIND);

    const ammoGroup = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(0.56, 0.32, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x4f5e2c, roughness: 0.7, metalness: 0.3 }),
    );
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.05, 0.44), this.crateStyleFor(DEFAULT_AMMO_KIND).stripe);
    stripe.name = 'stripe';
    stripe.position.y = 0.0;
    ammoGroup.add(crate, stripe);

    this.healthTemplate = healthGroup;
    this.ammoTemplate = ammoGroup;
    this.glowMaterials = {
      health: new THREE.SpriteMaterial({ map: glowTexture, color: 0x66ff99, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }),
      ammo: this.crateStyleFor(DEFAULT_AMMO_KIND).glow,
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
    const item = { type, x: spot.x, z: spot.z, mesh, active: true, phase: Math.random() * 6, kind: null };
    if (type === 'ammo') {
      item.kind = DEFAULT_AMMO_KIND;
      item.stripe = mesh.getObjectByName('stripe');
      item.glow = glow;
    }
    this.items.push(item);
  }

  /** The ammo crates, in layout order - the order `setAmmoKinds()` fills. */
  get ammoItems() {
    return this.items.filter((item) => item.type === 'ammo');
  }

  /** How many ammo crates the level has (what assignCrateKinds() must roll for). */
  get ammoCount() {
    let n = 0;
    for (const item of this.items) if (item.type === 'ammo') n++;
    return n;
  }

  /**
   * Gives the i-th ammo crate the i-th kind and repaints it. A short list
   * repeats its last entry; an empty one leaves every crate as it is.
   * @param {string[]} kinds
   */
  setAmmoKinds(kinds) {
    if (!Array.isArray(kinds) || kinds.length === 0) return;
    let i = 0;
    for (const item of this.items) {
      if (item.type !== 'ammo') continue;
      const kind = kinds[Math.min(i++, kinds.length - 1)];
      if (item.kind === kind) continue;
      item.kind = kind;
      const style = this.crateStyleFor(kind);
      if (item.stripe) item.stripe.material = style.stripe;
      if (item.glow) item.glow.material = style.glow;
    }
  }

  /**
   * Supply break: every spot is available again and the ammo crates take the
   * kinds in `kinds` (see setAmmoKinds()); omit it to keep their current kinds.
   * @param {string[]} [kinds]
   */
  restock(kinds) {
    if (kinds) this.setAmmoKinds(kinds);
    this.setAllActive(true);
  }

  /** Makes every pickup spot available again (supply break). */
  setAllActive(active) {
    for (const item of this.items) {
      item.active = active;
      item.mesh.visible = active;
    }
  }

  /**
   * Returns the first active pickup within `radius` that `accept(type, kind)`
   * allows (`kind` is the ammo kind of a crate, null for a health pack), and
   * deactivates it. Returns null if nothing is collected.
   */
  tryCollect(x, z, radius, accept) {
    for (const item of this.items) {
      if (!item.active) continue;
      if (Math.hypot(item.x - x, item.z - z) > radius) continue;
      if (!accept(item.type, item.kind)) continue;
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
    for (const style of this.crateStyles.values()) {
      style.stripe.dispose();
      style.glow.dispose();
    }
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
   * @param {Record<string, {color:number, glow:number}>} [opts.ammoKinds]
   *   crate palette per ammo kind, forwarded to PickupSystem (weapon.js AMMO_KIND_INFO)
   */
  constructor(scene, { renderer = null, rows = LAYOUT, ammoKinds = {} } = {}) {
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
    this.pickups = new PickupSystem(scene, this.plan.healthSpots, this.plan.ammoSpots, this.glowTexture, { ammoKinds });
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

    // Consoles: all bodies share one material and one merged mesh; the emissive
    // screens on their front faces are rows of one texture atlas (one draw call).
    if (consoles.length > 0) {
      const bodyParts = [];
      const screenParts = [];
      consoles.forEach((k, i) => {
        const place = placeMatrix(k.x, 0, k.z, k.rot);
        bodyParts.push({
          geometry: new THREE.BoxGeometry(1.4, 1.3, 0.6),
          matrix: place.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.65, 0)),
        });
        const screenGeo = new THREE.PlaneGeometry(1.1, 0.7);
        remapUvToAtlasRow(screenGeo, i, consoles.length);
        screenParts.push({
          geometry: screenGeo,
          matrix: place.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.9, 0.305)),
        });
      });
      const bodyMat = this.track(new THREE.MeshStandardMaterial({ color: 0x2b323b, roughness: 0.55, metalness: 0.4 }));
      this.addMesh(mergeGeometries(bodyParts).geometry, bodyMat);
      const screenAtlas = this.track(createScreenAtlas(consoles.map((k) => k.seed)));
      const screenMat = this.track(new THREE.MeshBasicMaterial({ map: screenAtlas, toneMapped: false }));
      this.addMesh(mergeGeometries(screenParts).geometry, screenMat, { cast: false, receive: false });
    }

    // Cryo tanks: glass shell with a glowing liquid core and metal base.
    const glassMat = this.track(new THREE.MeshStandardMaterial({
      color: 0x8ff5d0, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, depthWrite: false,
    }));
    const liquidMat = this.track(new THREE.MeshStandardMaterial({
      color: 0x0d3a2a, emissive: 0x25ff9a, emissiveIntensity: 1.1, roughness: 0.3,
    }));
    const baseMat = this.track(new THREE.MeshStandardMaterial({ color: 0x30363e, roughness: 0.5, metalness: 0.6 }));
    // Each tank part is merged across all tanks: glass, liquid, and base + cap.
    const at = (t, y) => placeMatrix(t.x, y, t.z);
    if (tanks.length > 0) {
      this.addMesh(mergeGeometries(tanks.map((t) => ({
        geometry: new THREE.CylinderGeometry(0.6, 0.6, 2.4, 20, 1, true), matrix: at(t, 1.4),
      }))).geometry, glassMat, { cast: false });
      this.addMesh(mergeGeometries(tanks.map((t) => ({
        geometry: new THREE.CylinderGeometry(0.5, 0.5, 2.1, 16), matrix: at(t, 1.3),
      }))).geometry, liquidMat, { cast: false, receive: false });
      const metalParts = [];
      for (const t of tanks) {
        metalParts.push({ geometry: new THREE.CylinderGeometry(0.66, 0.7, 0.2, 20), matrix: at(t, 0.1) });
        metalParts.push({ geometry: new THREE.CylinderGeometry(0.62, 0.62, 0.16, 20), matrix: at(t, 2.6) });
      }
      this.addMesh(mergeGeometries(metalParts).geometry, baseMat);
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

    // Every fixture panel and emergency beacon is one mesh. Their colours animate, so
    // the colour is stored per vertex and rewritten in update() (no per-fixture material).
    const parts = [];
    const addFixture = (p, emergency) => {
      if (emergency) {
        const part = parts.push({
          geometry: new THREE.SphereGeometry(0.14, 12, 10),
          matrix: placeMatrix(p.x, WALL_HEIGHT - 0.35, p.z),
          hex: 0xff2a1a,
        }) - 1;
        let light = null;
        if (pointBudget > 0) {
          pointBudget--;
          light = new THREE.PointLight(0xff3322, 0, 11, 2);
          light.position.set(p.x, WALL_HEIGHT - 0.5, p.z);
          this.group.add(light);
        }
        this.lights.push({ kind: 'emergency', light, part, phase: Math.random() * 6, base: 22 });
        return;
      }
      const part = parts.push({ geometry: panelGeo, matrix: placeMatrix(p.x, WALL_HEIGHT - 0.02, p.z), hex: 0xdfeaff }) - 1;
      let light = null;
      if (pointBudget > 0) {
        pointBudget--;
        light = new THREE.PointLight(0xc4dcff, 16, 12, 2);
        light.position.set(p.x, WALL_HEIGHT - 0.6, p.z);
        this.group.add(light);
      }
      this.lights.push({
        kind: 'flicker', light, part, phase: Math.random() * 6,
        base: 16, timer: 1 + Math.random() * 4, off: false,
      });
    };

    for (const p of this.plan.lights) addFixture(p, false);
    for (const p of this.plan.emergencyLights) addFixture(p, true);

    if (parts.length > 0) {
      const merged = mergeGeometries(parts.map(({ geometry, matrix }) => ({ geometry, matrix })));
      const colors = new Float32Array(merged.geometry.attributes.position.count * 3);
      this.fixtureColors = colors;
      for (const L of this.lights) {
        L.vStart = merged.offsets[L.part];
        L.vCount = parts[L.part].geometry.attributes.position.count;
        const c = new THREE.Color(parts[L.part].hex);
        this.setFixtureColor(L.vStart, L.vCount, c.r, c.g, c.b);
      }
      merged.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
      this.fixtureAttr = merged.geometry.attributes.color;
      const fixtureMat = this.track(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
      this.addMesh(merged.geometry, fixtureMat, { cast: false, receive: false });
    }
  }

  /** Writes a linear RGB colour to `count` vertices starting at `start`. */
  setFixtureColor(start, count, r, g, b) {
    const c = this.fixtureColors;
    for (let k = start; k < start + count; k++) {
      c[k * 3] = r;
      c[k * 3 + 1] = g;
      c[k * 3 + 2] = b;
    }
  }

  buildSigns(anisotropy) {
    // Signs of one kind share a texture and a material, so they merge into one mesh per kind.
    const geo = new THREE.PlaneGeometry(1.2, 0.6);
    const byKind = new Map();
    for (const s of this.plan.signs) {
      if (!byKind.has(s.kind)) byKind.set(s.kind, []);
      byKind.get(s.kind).push(s);
    }
    for (const [kind, signs] of byKind) {
      const mat = this.track(new THREE.MeshStandardMaterial({
        map: this.track(createWarningSignTexture(kind, { anisotropy })),
        roughness: 0.6,
        emissive: 0x221100,
        emissiveIntensity: 0.6,
      }));
      const parts = signs.map((s) => ({
        geometry: geo,
        matrix: placeMatrix(s.x, s.y, s.z, s.rotY),
      }));
      this.addMesh(mergeGeometries(parts).geometry, mat, { cast: false, receive: false });
    }
    geo.dispose();
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
        this.setFixtureColor(L.vStart, L.vCount, 0.87 * level, 0.92 * level, 1.0 * level);
      } else {
        // Emergency beacon: sharp alarm pulse.
        const pulse = Math.pow(Math.max(0, Math.sin(t * 5 + L.phase)), 6);
        if (L.light) L.light.intensity = L.base * pulse;
        this.setFixtureColor(L.vStart, L.vCount, 0.25 + 0.75 * pulse, 0.05 * pulse, 0.03 * pulse + 0.02);
      }
    }
    if (this.fixtureAttr) this.fixtureAttr.needsUpdate = true;
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
