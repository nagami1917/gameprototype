/**
 * projectiles.js
 * ------------------------------------------------------------------
 * Pooled explosive projectiles (GL-6 THUMPER rounds, and later throwables).
 *
 * Rules this module follows, the same ones ParticleSystem / DecalPool follow:
 *   - one fixed pool, allocated once at construction; nothing grows at runtime,
 *   - all per-projectile state lives in typed arrays (no per-projectile objects),
 *   - `update()` allocates nothing: it reuses module-level scratch objects and
 *     only builds an object when something actually goes off (a blast is an
 *     event, not a per-frame path).
 *
 * Flight model, per sub-step of at most one radius:
 *   1. integrate velocity + gravity,
 *   2. sweep the step with `raycastBoxes()` against the level colliders
 *      (inactive boxes are skipped, so an open door panel does not stop a round),
 *   3. on contact: reflect the velocity about the face normal, lose energy and
 *      damp the sliding component (a grenade bounces off walls and rolls),
 *   4. the floor (y = 0) and the ceiling are planes, exactly like hitscan rays.
 *
 * A round detonates when its fuse runs out, when it touches a body, or when it
 * has flown its full range. Splash then uses the same line-of-sight helper the
 * AI uses, so a blast never damages anything standing behind cover - the
 * thrower included.
 */
import * as THREE from 'three';
import { raycastBoxes, hasLineOfSight } from './collision.js';
import { WALL_HEIGHT } from './level.js';

/** Hard cap on live grenades (roadmap §6: explosives must not tank the frame rate). */
export const MAX_PROJECTILES = 8;
/** The world is a box between these two planes, a constant shared with level.js. */
export const FLOOR_Y = 0;
export const CEILING_Y = WALL_HEIGHT;
/**
 * Damage the thrower takes from their own blast, as a fraction of what a nearby
 * infected would take. Full splash damage would make the launcher unusable at
 * close range; the line-of-sight rule means the only way to hurt yourself is to
 * cook a round off in the open right next to you.
 */
export const SELF_DAMAGE_MULT = 0.5;
/** Damage at the rim of the blast, as a fraction of the centre damage. */
export const SPLASH_RIM_FRACTION = 0.25;
/** Below this speed a round is settling: it still falls, but is not swept. */
const REST_SPEED = 0.75;
/**
 * Ceiling on sub-steps per frame. With the game's dt clamp of 0.05 s and a
 * 26 m/s muzzle velocity a round crosses 1.3 m per frame, which is 12 steps of
 * one radius - so no frame is ever cut short by this cap.
 */
const MAX_STEPS = 12;
/** Energy kept by the velocity component parallel to the surface on a bounce. */
const TANGENT_KEEP = 0.7;
/** Ground friction for a round that is rolling to a stop. */
const REST_FRICTION = 0.86;

/** Surface ids are stored per slot as bytes; 0 means "cooked off in mid-air". */
const SURFACE_NONE = 0;
const SURFACE_CONCRETE = 1;
const SURFACE_METAL = 2;
const SURFACE_FLOOR = 3;
const SURFACE_CEILING = 4;
/** Indexed by surface id, so `SURFACE_NAMES[0]` is the mid-air fallback. */
const SURFACE_NAMES = ['concrete', 'concrete', 'metal', 'floor', 'ceiling'];

/* Scratch: mutated in place, never handed to a caller that could keep it. */
const _rayOrigin = { x: 0, y: 0, z: 0 };
const _rayDir = { x: 0, y: 0, z: -1 };
const _losA = { x: 0, y: 0, z: 0 };
const _losB = { x: 0, y: 0, z: 0 };
const _normal = { x: 0, y: 1, z: 0 };
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

/** Falls back to the standard humanoid size for stubs and future actor types. */
function chestHeight(actor) {
  return actor.type?.height ?? actor.height ?? 1.8;
}

function bodyRadius(actor) {
  return actor.type?.radius ?? actor.radius ?? 0.4;
}

/**
 * The pooled explosive system: `spawn()` launches a round, `update()` flies it.
 */
export class ProjectileSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts
   * @param {import('./effects.js').EffectsManager} opts.effects  blast visuals + scorch decals
   * @param {import('./audio.js').AudioManager} opts.audio
   * @param {object} [opts.hooks]  stable hook object, see `update()`
   * @param {number} [opts.capacity]  pool size (the roadmap caps live grenades at MAX_PROJECTILES)
   */
  constructor(scene, { effects, audio, hooks = {}, capacity = MAX_PROJECTILES } = {}) {
    this.scene = scene;
    this.effects = effects;
    this.audio = audio;
    this.hooks = hooks;
    this.capacity = capacity;
    this.live = 0;
    this.cursor = 0; // ring cursor: recycles the oldest round when the pool is full

    // Per-slot state: typed arrays plus a couple of reference arrays. No objects.
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.fuse = new Float32Array(capacity);
    this.maxFuse = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.splash = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.restitution = new Float32Array(capacity);
    this.range = new Float32Array(capacity);
    this.travelled = new Float32Array(capacity);
    this.surface = new Uint8Array(capacity);
    this.resting = new Uint8Array(capacity);
    this.active = new Uint8Array(capacity);
    /** Thrower of each round; splash never hits them blindly (see applySelfDamage()). */
    this.owner = new Array(capacity).fill(null);
    /** Weapon id reported to `hooks.onEnemyHit`, so scoring/score text stay central. */
    this.weapon = new Array(capacity).fill('launcher');
    /** Contact normal of the last bounce, used to orient the scorch decal. */
    this.contactX = new Float32Array(capacity);
    this.contactY = new Float32Array(capacity);
    this.contactZ = new Float32Array(capacity);
    /** Surface that owns the last contact face (a sliding door panel), or null. */
    this.contactOwner = new Array(capacity).fill(null);

    const geometry = new THREE.SphereGeometry(0.085, 10, 8);
    const material = new THREE.MeshStandardMaterial({
      color: 0x2f3a2a,
      roughness: 0.55,
      metalness: 0.6,
      emissive: 0x1d2a12, // a hot round reads in a dark corridor without its own light
      emissiveIntensity: 0.6,
    });
    this.geometry = geometry;
    this.material = material;
    // One InstancedMesh for the whole pool: a grenade in flight costs no draw
    // call of its own. Unused slots get a zero-scale matrix, like DecalPool.
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'projectiles';
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _hidden);
    // Nothing in the air means nothing drawn at all: an empty pool costs no
    // draw call, which is the normal state for a loadout without explosives.
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  /** Live rounds. Never exceeds `capacity`. */
  get liveCount() {
    return this.live;
  }

  /** Instance slots in the pool (constant: the pool never grows). */
  get instanceCount() {
    return this.mesh.instanceMatrix.count;
  }

  /**
   * Launches one round out of the pool. When the pool is full the oldest live
   * round is recycled, so pulling the trigger always produces a grenade.
   *
   * @param {object} opts
   * @param {{x:number,y:number,z:number}} opts.origin  world spawn point (copied)
   * @param {{x:number,y:number,z:number}} opts.dir     unit flight direction (copied)
   * @param {number} opts.speed          metres per second at the muzzle
   * @param {number} [opts.gravity]      downward acceleration (m/s^2)
   * @param {number} [opts.radius]       collision radius of the round itself
   * @param {number} opts.damage         splash damage at the centre of the blast
   * @param {number} [opts.splashRadius] blast radius in metres
   * @param {number} [opts.fuse]         seconds before it cooks off, at the latest
   * @param {number} [opts.range]        metres of flight before it self-destructs
   * @param {number} [opts.restitution]  bounciness: 0 sticks, 1 is perfectly elastic
   * @param {object|null} [opts.owner]   thrower, for the self-damage rule
   * @param {string} [opts.weapon]       weapon id reported to `hooks.onEnemyHit`
   * @returns {number} pool slot
   */
  spawn({
    origin, dir, speed, gravity = 0, radius = 0.09, damage, splashRadius = 0,
    fuse = 3, range = 150, restitution = 0.35, owner = null, weapon = 'launcher',
  }) {
    let i;
    if (this.live < this.capacity) {
      for (i = 0; i < this.capacity; i++) if (!this.active[i]) break;
    } else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
    }

    this.px[i] = origin.x;
    this.py[i] = origin.y;
    this.pz[i] = origin.z;
    this.vx[i] = dir.x * speed;
    this.vy[i] = dir.y * speed;
    this.vz[i] = dir.z * speed;
    this.gravity[i] = gravity;
    this.fuse[i] = fuse;
    this.maxFuse[i] = fuse;
    this.damage[i] = damage;
    this.splash[i] = splashRadius;
    this.radius[i] = radius;
    this.restitution[i] = restitution;
    this.range[i] = range;
    this.travelled[i] = 0;
    this.surface[i] = SURFACE_NONE;
    this.contactX[i] = 0;
    this.contactY[i] = 1;
    this.contactZ[i] = 0;
    this.contactOwner[i] = null;
    this.resting[i] = 0;
    this.owner[i] = owner || null;
    this.weapon[i] = weapon;
    this.active[i] = 1;
    if (this.live < this.capacity) this.live++;
    this.mesh.count = this.capacity; // something is in the air: draw the pool
    this.syncMatrix(i);
    this.mesh.instanceMatrix.needsUpdate = true;
    return i;
  }

  /**
   * Advances every live round. Allocation-free: all state is in typed arrays and
   * all scratch objects are module-level.
   *
   * @param {number} dt             seconds
   * @param {Array} colliders       level boxes; `active === false` (an open door) is ignored
   * @param {Array} enemies         enemies to fly past and to splash
   * @param {object} [hooks]        defaults to the constructor's hooks:
   *        `onEnemyHit(info)` gets the same shape hitscan uses,
   *        `onPlayerHit(info)` gets the thrower's own blast damage,
   *        `onExplode(info)` sees every blast (audio, AI noise, screen shake).
   */
  update(dt, colliders, enemies, hooks) {
    const h = hooks || this.hooks;
    if (!(dt > 0)) return;
    let touched = false;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;
      touched = true;
      this.fuse[i] -= dt;
      if (this.fuse[i] <= 0) {
        this.detonate(i, h, colliders, enemies);
        continue;
      }

      // Sub-step, so a 26 m/s round cannot tunnel through a 0.3 m door panel.
      // The whole frame is always simulated: the step count is chosen so each
      // step is at most one radius long, and a step that is never swept (a round
      // settling on the floor) is cheap.
      const radius = this.radius[i];
      const startSpeed = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
      const steps = startSpeed > 0
        ? Math.max(1, Math.min(MAX_STEPS, Math.ceil((startSpeed * dt) / radius)))
        : 1;
      const stepT = dt / steps;
      for (let s = 0; s < steps; s++) {
        const vx = this.vx[i];
        const vy = this.vy[i];
        const vz = this.vz[i];
        const speed = Math.hypot(vx, vy, vz);
        if (this.resting[i] || speed < REST_SPEED) {
          // Settling: no sweep at walking pace, but gravity and friction still apply.
          this.vx[i] = vx * REST_FRICTION;
          this.vz[i] = vz * REST_FRICTION;
          this.vy[i] = vy - this.gravity[i] * stepT;
          this.px[i] += this.vx[i] * stepT;
          this.py[i] += this.vy[i] * stepT;
          this.pz[i] += this.vz[i] * stepT;
          this.planes(i);
          continue;
        }
        const nx = this.px[i] + vx * stepT;
        const ny = this.py[i] + vy * stepT;
        const nz = this.pz[i] + vz * stepT;
        const dist = speed * stepT;
        // Gravity lands after the sweep, so the swept segment stays straight.
        this.vy[i] = vy - this.gravity[i] * stepT;

        const hit = this.sweep(i, nx, ny, nz, colliders);
        if (hit) {
          this.bounce(i, hit);
        } else {
          this.px[i] = nx;
          this.py[i] = ny;
          this.pz[i] = nz;
          this.travelled[i] += dist;
          this.planes(i);
        }
      }

      // A round that touches a body goes off on the spot (proximity, not a raycast).
      if (this.touchesEnemy(i, enemies)) {
        this.detonate(i, h, colliders, enemies);
        continue;
      }
      // Out of range: cook it off where it is instead of flying forever.
      if (this.travelled[i] >= this.range[i]) {
        this.detonate(i, h, colliders, enemies);
        continue;
      }
      this.syncMatrix(i);
    }
    // One upload per frame for the whole pool, not one per grenade.
    if (touched) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Sweeps the sub-step from the current position to (nx, ny, nz).
   * @returns {object|null} the `raycastBoxes()` contact, if the sphere met a face
   */
  sweep(i, nx, ny, nz, colliders) {
    const dx = nx - this.px[i];
    const dy = ny - this.py[i];
    const dz = nz - this.pz[i];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return null;
    _rayDir.x = dx / len;
    _rayDir.y = dy / len;
    _rayDir.z = dz / len;
    _rayOrigin.x = this.px[i];
    _rayOrigin.y = this.py[i];
    _rayOrigin.z = this.pz[i];
    // A sphere of radius r meets a face `r` before its centre ray does.
    return raycastBoxes(_rayOrigin, _rayDir, len + this.radius[i], colliders);
  }

  /**
   * Reflects a round off the face it met and parks it a radius clear of it.
   * @param {object} hit  the `raycastBoxes()` contact from `sweep()`
   */
  bounce(i, hit) {
    const r = this.radius[i];
    const normal = hit.normal;
    const back = hit.distance - r; // distance along the sweep to the contact circle
    if (back > 0) {
      this.px[i] = _rayOrigin.x + _rayDir.x * back;
      this.py[i] = _rayOrigin.y + _rayDir.y * back;
      this.pz[i] = _rayOrigin.z + _rayDir.z * back;
    }
    const vx = this.vx[i];
    const vy = this.vy[i];
    const vz = this.vz[i];
    const vn = vx * normal.x + vy * normal.y + vz * normal.z;
    if (vn < 0) {
      const reb = -vn * this.restitution[i];
      // The tangential part keeps most of its speed: grenades ricochet and roll.
      this.vx[i] = (vx - vn * normal.x) * TANGENT_KEEP + reb * normal.x;
      this.vy[i] = (vy - vn * normal.y) * TANGENT_KEEP + reb * normal.y;
      this.vz[i] = (vz - vn * normal.z) * TANGENT_KEEP + reb * normal.z;
      this.recordSurface(i, hit.box.tag === 'wall' ? SURFACE_CONCRETE : SURFACE_METAL,
        normal.x, normal.y, normal.z, hit.box.owner || null);
    }
    // A slow contact with a floor-level face is how a round comes to rest.
    if (normal.y > 0.5 && Math.hypot(this.vx[i], this.vy[i], this.vz[i]) < REST_SPEED * 2) {
      this.resting[i] = 1;
    }
  }

  /** Floor and ceiling are planes, not boxes (the same model the hitscan rays use). */
  planes(i) {
    const r = this.radius[i];
    if (this.py[i] - r < FLOOR_Y) {
      this.py[i] = FLOOR_Y + r;
      if (this.vy[i] < 0) this.vy[i] = -this.vy[i] * this.restitution[i];
      this.vx[i] *= TANGENT_KEEP;
      this.vz[i] *= TANGENT_KEEP;
      this.recordSurface(i, SURFACE_FLOOR, 0, 1, 0, null);
      if (Math.hypot(this.vx[i], this.vy[i], this.vz[i]) < REST_SPEED * 2) {
        this.resting[i] = 1;
        this.vx[i] = 0;
        this.vy[i] = 0;
        this.vz[i] = 0;
      }
    } else if (this.py[i] + r > CEILING_Y) {
      this.py[i] = CEILING_Y - r;
      if (this.vy[i] > 0) this.vy[i] = -this.vy[i] * this.restitution[i];
      this.vx[i] *= TANGENT_KEEP;
      this.vz[i] *= TANGENT_KEEP;
      this.recordSurface(i, SURFACE_CEILING, 0, -1, 0, null);
    }
  }

  /** True when the round's sphere overlaps an enemy cylinder (feet to head). */
  touchesEnemy(i, enemies) {
    if (!enemies || enemies.length === 0) return false;
    const r = this.radius[i];
    for (let e = 0; e < enemies.length; e++) {
      const enemy = enemies[e];
      if (!enemy) continue;
      if (typeof enemy.isTargetable === 'function' && !enemy.isTargetable()) continue;
      const feet = enemy.position.y;
      if (this.py[i] + r < feet || this.py[i] - r > feet + chestHeight(enemy)) continue;
      const dx = this.px[i] - enemy.position.x;
      const dz = this.pz[i] - enemy.position.z;
      const reach = r + bodyRadius(enemy);
      if (dx * dx + dz * dz <= reach * reach) return true;
    }
    return false;
  }

  /**
   * Blows one round: visuals, audio, then splash damage with falloff and a line
   * of sight check, so nothing is ever hurt through a wall.
   */
  detonate(i, hooks, colliders, enemies) {
    const x = this.px[i];
    const y = this.py[i];
    const z = this.pz[i];
    const damage = this.damage[i];
    const radius = this.splash[i];
    const owner = this.owner[i];
    const weapon = this.weapon[i];
    const surfaceId = this.surface[i];
    const contactOwner = this.contactOwner[i];
    const normal = surfaceId === SURFACE_NONE
      ? null
      : { x: this.contactX[i], y: this.contactY[i], z: this.contactZ[i] };
    this.release(i);

    // Event-time allocation only (a blast is not a per-frame path).
    const point = { x, y, z };
    if (this.effects) {
      this.effects.spawnExplosion(point, {
        radius,
        normal,
        surface: SURFACE_NAMES[surfaceId],
        owner: contactOwner,
      });
    }
    if (this.audio) this.audio.playExplosion(point);
    if (radius > 0) {
      _losA.x = x;
      _losA.y = y;
      _losA.z = z;
      this.applySplash(point, damage, radius, weapon, hooks, colliders, enemies);
      this.applySelfDamage(point, damage, radius, owner, hooks, colliders);
    }
    hooks.onExplode?.({ point, radius, damage, owner, weapon });
  }

  /** Falloff + LoS against every enemy in range. */
  applySplash(point, damage, radius, weapon, hooks, colliders, enemies) {
    if (!enemies || enemies.length === 0) return;
    for (let e = 0; e < enemies.length; e++) {
      const enemy = enemies[e];
      if (!enemy || !enemy.isTargetable()) continue;
      const height = chestHeight(enemy);
      const ex = enemy.position.x;
      const ez = enemy.position.z;
      const ey = enemy.position.y + height * 0.55; // chest: a body does not start at the feet
      const dx = ex - point.x;
      const dy = ey - point.y;
      const dz = ez - point.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > radius) continue;
      _losB.x = ex;
      _losB.y = ey;
      _losB.z = ez;
      // Cover blocks the blast: the same visibility helper the AI uses.
      if (!hasLineOfSight(_losA, _losB, colliders)) continue;
      const falloff = 1 - (1 - SPLASH_RIM_FRACTION) * (distance / radius);
      const dealt = damage * falloff;
      if (dealt < 1) continue;
      const hitPoint = { x: ex, y: ey, z: ez };
      const outcome = hooks.onEnemyHit?.({
        enemy,
        damage: dealt,
        headshot: false, // an explosion has no aiming point to headshot with
        point: hitPoint,
        distance,
        weapon,
      });
      if (this.effects) {
        _normal.x = distance > 1e-4 ? -dx / distance : 0;
        _normal.y = distance > 1e-4 ? -dy / distance : 1;
        _normal.z = distance > 1e-4 ? -dz / distance : 0;
        this.effects.spawnBlood(hitPoint, _normal, outcome?.killed ? 2 : 1.2);
      }
    }
  }

  /**
   * The thrower's own blast. Rule (recorded in docs/Weapons_Roadmap.md §7): the
   * round is *not* exempt from hurting whoever fired it, but it only ever does
   * so with clear line of sight - firing into a wall at point blank cannot hurt
   * the shooter through that wall, only with the blast that reaches open air.
   */
  applySelfDamage(point, damage, radius, owner, hooks, colliders) {
    if (!owner || owner.alive === false || !owner.position) return;
    const oy = owner.position.y + chestHeight(owner) * 0.55;
    const dx = owner.position.x - point.x;
    const dy = oy - point.y;
    const dz = owner.position.z - point.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > radius) return;
    _losB.x = owner.position.x;
    _losB.y = oy;
    _losB.z = owner.position.z;
    if (!hasLineOfSight(_losA, _losB, colliders)) return;
    const falloff = 1 - (1 - SPLASH_RIM_FRACTION) * (distance / radius);
    const dealt = damage * falloff * SELF_DAMAGE_MULT;
    if (dealt < 1) return;
    hooks.onPlayerHit?.({ damage: dealt, point, owner, distance });
  }

  /** Records the contact face so the scorch mark can be oriented and culled. */
  recordSurface(i, surfaceId, nx, ny, nz, owner) {
    this.surface[i] = surfaceId;
    this.contactX[i] = nx;
    this.contactY[i] = ny;
    this.contactZ[i] = nz;
    this.contactOwner[i] = owner || null;
  }

  /** Frees a slot and hides its instance. */
  release(i) {
    this.active[i] = 0;
    this.resting[i] = 0;
    this.surface[i] = SURFACE_NONE;
    this.owner[i] = null;
    this.weapon[i] = 'launcher';
    this.contactOwner[i] = null;
    if (this.live > 0) this.live--;
    this.mesh.setMatrixAt(i, _hidden);
    if (this.live === 0) this.mesh.count = 0; // back to not costing a draw call
  }

  /** Writes the instance matrix for a live slot (the sphere is centred on it). */
  syncMatrix(i) {
    _position.set(this.px[i], this.py[i], this.pz[i]);
    _scale.setScalar(1);
    _matrix.compose(_position, _quaternion, _scale);
    this.mesh.setMatrixAt(i, _matrix);
  }

  /** Drops every live round without a bang (run start/end, dispose). */
  clear() {
    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;
      this.release(i);
    }
    this.live = 0;
    this.cursor = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene?.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
