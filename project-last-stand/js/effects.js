/**
 * effects.js
 * ------------------------------------------------------------------
 * Visual effects with pooled, reusable objects (no per-shot allocation
 * of meshes or geometry):
 *   - ParticleSystem: one THREE.Points draw call per system. Used for
 *     blood, sparks, dust and ambient motes.
 *   - DecalPool: recycled bullet-hole, blood and explosion-scorch decals on
 *     surfaces, each with a lifetime and an optional owner (a door panel).
 *   - Tracers: a small pool of fading line segments.
 */
import * as THREE from 'three';
import { createBulletHoleTexture, createBloodTexture, createScorchTexture } from './textures.js';

const PARTICLE_VERTEX = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 color;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.05, d) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`;

/** Shared shader material factory for point particles. */
function createParticleMaterial(additive) {
  return new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    uniforms: { uScale: { value: 600 } },
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/**
 * A pool of simple physical particles stored in typed arrays.
 * Dead particles are swapped with the last live one, so the draw range
 * always covers exactly the live particles.
 */
export class ParticleSystem {
  constructor(scene, capacity, { additive = false } = {}) {
    this.capacity = capacity;
    this.count = 0;
    this.cursor = 0;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);

    this.material = createParticleMaterial(additive);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.scene = scene;
  }

  emit({ x, y, z }, { vx = 0, vy = 0, vz = 0 } = {}, life, size, color, gravity = 0, drag = 0) {
    let i;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity; // recycle the oldest slot
    }
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.col[i3] = color.r;
    this.col[i3 + 1] = color.g;
    this.col[i3 + 2] = color.b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.size[i] = size;
    this.alpha[i] = 1;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove: move the last live particle into this slot.
        const last = --this.count;
        if (i !== last) this.copy(last, i);
        continue;
      }
      const i3 = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp - this.gravity[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 1.6);
      this.size[i] = this.baseSize[i] * (0.5 + 0.5 * t);
      i++;
    }
    this.geometry.setDrawRange(0, this.count);
    const attrs = this.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.color.needsUpdate = true;
    attrs.size.needsUpdate = true;
    attrs.alpha.needsUpdate = true;
  }

  copy(from, to) {
    const f3 = from * 3;
    const t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.col[t3 + k] = this.col[f3 + k];
    }
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.baseSize[to] = this.baseSize[from];
    this.size[to] = this.size[from];
    this.alpha[to] = this.alpha[from];
    this.gravity[to] = this.gravity[from];
    this.drag[to] = this.drag[from];
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* Scratch objects for spawnExplosion(): a blast must not add garbage to the
 * frame it happens in, and nothing here outlives the call. */
const _fireColor = new THREE.Color();
const _smokeColor = new THREE.Color();
const _sootGround = { x: 0, y: 0, z: 0 };
const UP_NORMAL = { x: 0, y: 1, z: 0 };

const _decalZ = new THREE.Vector3(0, 0, 1);
const _decalN = new THREE.Vector3();
const _decalQ = new THREE.Quaternion();
const _decalSpin = new THREE.Quaternion();
const _decalP = new THREE.Vector3();
const _decalS = new THREE.Vector3();
const _decalM = new THREE.Matrix4();
const _decalHidden = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Decal lifetime tunables (seconds).
 * Marks fade out by shrinking to zero scale over the last `DECAL_FADE_TIME`
 * seconds: `MeshBasicMaterial` has no per-instance alpha, and scaling keeps
 * the pool at one draw call with no shader patching.
 */
export const HOLE_LIFETIME = 12;
export const BLOOD_DECAL_LIFETIME = 30;
/** Blast soot lingers far longer than a bullet hole: it is the after-action trace. */
export const SCORCH_LIFETIME = 40;
/** Plane size of one scorch decal at scale 1, in metres (blasts scale off it). */
export const SCORCH_DECAL_SIZE = 3;
export const DECAL_FADE_TIME = 0.4;
/**
 * How far a door has to slide before its marks are culled. Deliberately tiny:
 * the panel starts retracting into the ceiling the moment it moves, so a mark
 * left behind would hang in the open doorway.
 */
export const DOOR_CULL_THRESHOLD = 0.02;

/**
 * Recycled decals placed on surfaces (bullet holes, blood pools).
 * All decals of one pool are a single InstancedMesh, so the pool costs one
 * draw call instead of one per decal. Unused slots get a zero-scale matrix.
 *
 * Every slot carries its own lifetime and, optionally, the surface that owns
 * it (`owner`, e.g. a sliding door). A mark dies with the surface it was
 * placed on and expires on its own after `lifetime` seconds.
 */
export class DecalPool {
  constructor(scene, count, material, size, lifetime = HOLE_LIFETIME) {
    this.scene = scene;
    this.count = count;
    this.lifetime = lifetime;
    this.cursor = 0;
    this.dirty = false;
    const geo = new THREE.PlaneGeometry(size, size);
    this.mesh = new THREE.InstancedMesh(geo, material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 2;
    // Instances are spread over the level, so the mesh's own bounds are not meaningful.
    this.mesh.frustumCulled = false;

    // Per-slot state lives in parallel typed arrays: no per-decal objects and
    // nothing is allocated while the game is running.
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.qx = new Float32Array(count);
    this.qy = new Float32Array(count);
    this.qz = new Float32Array(count);
    this.qw = new Float32Array(count);
    this.baseScale = new Float32Array(count);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.alive = new Uint8Array(count);
    this.hidden = new Uint8Array(count); // owned by a surface that is moving away
    this.fading = new Uint8Array(count); // currently inside the fade tail
    this.owner = new Array(count).fill(null);
    // Free-list stack: slots whose decal expired (or was never used), so a new
    // mark never pops one that was placed this second while others are free.
    this.freeSlots = new Int32Array(count);
    this.freeCount = 0;

    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, _decalHidden);
    this.resetSlots();
    scene.add(this.mesh);
    this.geo = geo;
  }

  /** Number of slots currently showing a decal. */
  get activeCount() {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.alive[i]) n++;
    return n;
  }

  /**
   * Places a decal at `point` facing `normal`.
   * @param {{x:number,y:number,z:number}} point
   * @param {{x:number,y:number,z:number}} normal
   * @param {number} [scale]
   * @param {number} [rotation] spin around the surface normal, in radians
   * @param {{openAmount:number}|null} [owner] surface that owns this mark
   *        (a door); the decal is hidden as soon as that surface moves.
   */
  place(point, normal, scale = 1, rotation = 0, owner = null) {
    let i;
    if (this.freeCount > 0) {
      i = this.freeSlots[--this.freeCount];
    } else {
      // Pool is full: recycle in placement order, which is also expiry order.
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;
    }
    _decalN.set(normal.x, normal.y, normal.z);
    _decalQ.setFromUnitVectors(_decalZ, _decalN);
    _decalSpin.setFromAxisAngle(_decalZ, rotation);
    _decalQ.multiply(_decalSpin); // same as mesh.rotateZ(rotation) after setting the quaternion
    // Nudge off the surface so the plane does not z-fight with it.
    this.px[i] = point.x + normal.x * 0.01;
    this.py[i] = point.y + normal.y * 0.01;
    this.pz[i] = point.z + normal.z * 0.01;
    this.qx[i] = _decalQ.x;
    this.qy[i] = _decalQ.y;
    this.qz[i] = _decalQ.z;
    this.qw[i] = _decalQ.w;
    this.baseScale[i] = scale;
    this.life[i] = this.lifetime;
    this.maxLife[i] = this.lifetime;
    this.alive[i] = 1;
    this.hidden[i] = 0;
    this.fading[i] = 0;
    this.owner[i] = owner || null;
    this.writeMatrix(i, 1);
    this.dirty = true;
    return i;
  }

  /**
   * Ages every live decal, fades it out at the end of its life and hides the
   * marks whose owning surface is moving away (a door panel retracting into
   * the ceiling). Hidden marks come back if the surface returns.
   * @param {number} dt seconds
   * @param {Array<{openAmount:number}>} [owners] surfaces that can own decals
   */
  update(dt, owners) {
    const cull = owners && owners.length > 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;
      const owner = this.owner[i];
      if (!cull || !owner) continue;
      // Repeatable: culling is re-evaluated every frame, so a mark placed while
      // the door was closing is hidden again the next time it opens.
      const hide = owner.openAmount > DOOR_CULL_THRESHOLD ? 1 : 0;
      if (hide !== this.hidden[i]) {
        this.hidden[i] = hide;
        this.writeMatrix(i, hide ? 0 : this.fadeScale(i));
        this.dirty = true;
      }
    }

    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.release(i);
        this.dirty = true;
        continue;
      }
      if (this.hidden[i]) continue; // owner keeps it invisible; life still ticks
      const fade = this.fadeScale(i);
      if (fade < 1) {
        this.fading[i] = 1;
        this.writeMatrix(i, fade);
        this.dirty = true;
      } else if (this.fading[i]) {
        // Just came out of the fade tail (only happens for restored door marks).
        this.fading[i] = 0;
        this.writeMatrix(i, 1);
        this.dirty = true;
      }
    }

    // One upload per frame for the whole pool, not one per touched decal.
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Scale multiplier for the fade tail (1 while the decal is fresh). */
  fadeScale(i) {
    if (this.life[i] >= DECAL_FADE_TIME) return 1;
    const t = this.life[i] / DECAL_FADE_TIME;
    return t > 0 ? t : 0;
  }

  /** Composes and uploads the instance matrix for one slot. */
  writeMatrix(i, fade = 1) {
    const scale = this.baseScale[i] * fade;
    if (!this.alive[i] || this.hidden[i] || scale <= 0) {
      this.mesh.setMatrixAt(i, _decalHidden);
      return;
    }
    _decalP.set(this.px[i], this.py[i], this.pz[i]);
    _decalQ.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i]);
    _decalS.setScalar(scale);
    _decalM.compose(_decalP, _decalQ, _decalS);
    this.mesh.setMatrixAt(i, _decalM);
  }

  /** Frees a slot: hides it and pushes it back on the free-list. */
  release(i) {
    this.alive[i] = 0;
    this.hidden[i] = 0;
    this.fading[i] = 0;
    this.life[i] = 0;
    this.owner[i] = null;
    this.mesh.setMatrixAt(i, _decalHidden);
    // Safe: a live slot is never in the free-list, and the list is rebuilt by clear().
    this.freeSlots[this.freeCount++] = i;
  }

  /** Marks every slot free again (used when a run starts or ends). */
  resetSlots() {
    // Filled in reverse so slots hand out in ascending order, matching the
    // ring cursor: slot 0 is always the oldest live decal.
    for (let i = 0; i < this.count; i++) this.freeSlots[i] = this.count - 1 - i;
    this.freeCount = this.count;
    this.cursor = 0;
  }

  /** Hides every decal (used when a run ends). */
  clear() {
    for (let i = 0; i < this.count; i++) {
      this.mesh.setMatrixAt(i, _decalHidden);
      this.alive[i] = 0;
      this.hidden[i] = 0;
      this.fading[i] = 0;
      this.life[i] = 0;
      this.maxLife[i] = 0;
      this.owner[i] = null;
    }
    this.resetSlots();
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
  }
}

export class EffectsManager {
  /**
   * @param {THREE.Scene} scene
   * @param {{bounds: {minX:number,minZ:number,maxX:number,maxZ:number}}} opts
   */
  constructor(scene, { bounds } = {}) {
    this.scene = scene;
    this.bounds = bounds || { minX: 0, minZ: 0, maxX: 40, maxZ: 40 };
    this.blood = new ParticleSystem(scene, 900, { additive: false });
    this.sparks = new ParticleSystem(scene, 400, { additive: true });
    this.dust = new ParticleSystem(scene, 200, { additive: false });
    this.motes = this.createMotes(scene);

    const holeTex = createBulletHoleTexture();
    const bloodTex = createBloodTexture(3);
    this.holeMaterial = new THREE.MeshBasicMaterial({
      map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.bloodMaterial = new THREE.MeshBasicMaterial({
      map: bloodTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const scorchTex = createScorchTexture();
    this.scorchMaterial = new THREE.MeshBasicMaterial({
      map: scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.holes = new DecalPool(scene, 70, this.holeMaterial, 0.22);
    this.bloodDecals = new DecalPool(scene, 24, this.bloodMaterial, 1.1);
    // Blasts are rare (a 1-round launcher), so a dozen slots is plenty and the
    // pool still costs one draw call.
    this.scorch = new DecalPool(scene, 12, this.scorchMaterial, SCORCH_DECAL_SIZE, SCORCH_LIFETIME);
    this.tracers = [];
    this.tracerCursor = 0;
    this.createTracers(scene, 10);
    this.textures = [holeTex, bloodTex, scorchTex];
  }

  createMotes(scene) {
    const count = 160;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const { minX, minZ, maxX, maxZ } = this.bounds;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = minX + Math.random() * (maxX - minX);
      pos[i * 3 + 1] = 0.4 + Math.random() * 3.2;
      pos[i * 3 + 2] = minZ + Math.random() * (maxZ - minZ);
      seeds[i * 3] = Math.random() * 6.28;
      seeds[i * 3 + 1] = 0.2 + Math.random() * 0.4;
      seeds[i * 3 + 2] = Math.random() * 6.28;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const size = new Float32Array(count).fill(0.035);
    const alpha = new Float32Array(count).fill(0.35);
    const color = new Float32Array(count * 3).fill(0.75);
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    const material = createParticleMaterial(false);
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    scene.add(points);
    return { points, geo, material, count, seeds };
  }

  createTracers(scene, count) {
    for (let i = 0; i < count; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.tracers.push({ line, life: 0 });
    }
  }

  /** Blood burst at an impact point (intensity scales the particle count). */
  spawnBlood(point, normal, intensity = 1) {
    const n = Math.round(7 * intensity);
    const base = normal || { x: 0, y: 1, z: 0 };
    for (let i = 0; i < n; i++) {
      const sx = (Math.random() - 0.5) * 3;
      const sy = Math.random() * 2.6 + 0.4;
      const sz = (Math.random() - 0.5) * 3;
      const bias = 1.2;
      const c = new THREE.Color().setRGB(0.42 + Math.random() * 0.2, 0.01, 0.01);
      this.blood.emit(
        { x: point.x, y: point.y, z: point.z },
        { vx: sx + base.x * bias, vy: sy + base.y * bias, vz: sz + base.z * bias },
        0.5 + Math.random() * 0.5,
        0.06 + Math.random() * 0.05,
        c,
        9,
        0.4,
      );
    }
  }

  /** Blood pool on the floor where an enemy dies. */
  spawnFloorBlood(x, z) {
    this.bloodDecals.place({ x, y: 0, z }, { x: 0, y: 1, z: 0 }, 1.1 + Math.random() * 0.7, Math.random() * 6.28);
  }

  /**
   * Impact sparks/dust + bullet hole for a world surface.
   * @param {{openAmount:number}|null} [owner] moving surface the mark sits on
   *        (a door panel): the mark is hidden as soon as that surface moves.
   */
  spawnImpact(point, normal, surface = 'concrete', owner = null) {
    const isMetal = surface === 'metal' || surface === 'floor';
    const n = isMetal ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const vx = (Math.random() - 0.5) * 3 + normal.x * 2;
      const vy = Math.random() * 2.5 + normal.y * 2;
      const vz = (Math.random() - 0.5) * 3 + normal.z * 2;
      if (isMetal) {
        this.sparks.emit(point, { vx, vy, vz }, 0.25 + Math.random() * 0.25, 0.035,
          new THREE.Color().setRGB(1, 0.7 + Math.random() * 0.2, 0.25), 7, 0.5);
      } else {
        const g = 0.45 + Math.random() * 0.15;
        this.dust.emit(point, { vx: vx * 0.5, vy: vy * 0.5, vz: vz * 0.5 }, 0.6, 0.12,
          new THREE.Color().setRGB(g, g, g * 1.02), 1.5, 3);
      }
    }
    this.holes.place(point, normal, 0.7 + Math.random() * 0.5, Math.random() * 6.28);
  }

  /**
   * Fireball, smoke and a scorch mark for one explosion.
   *
   * @param {{x:number,y:number,z:number}} point  blast centre (never retained)
   * @param {object} [opts]
   * @param {number} [opts.radius]   splash radius in metres; scales the ball and the soot
   * @param {{x:number,y:number,z:number}|null} [opts.normal] surface face the blast met
   * @param {string} [opts.surface]  'concrete' | 'metal' | 'floor' | 'ceiling'
   * @param {{openAmount:number}|null} [opts.owner] moving surface (door panel) the soot is on
   */
  spawnExplosion(point, { radius = 4.5, normal = null, surface = 'concrete', owner = null } = {}) {
    const scale = radius / 4.5;
    // Fireball: fast additive cores, gone in a blink.
    const metal = surface === 'metal';
    const fireballs = metal ? 34 : 26;
    for (let i = 0; i < fireballs; i++) {
      const speed = (5 + Math.random() * 9) * scale;
      _fireColor.setRGB(1, 0.55 + Math.random() * 0.35, 0.08 + Math.random() * 0.2);
      this.sparks.emit(
        point,
        {
          vx: (Math.random() - 0.5) * 2 * speed,
          vy: (Math.random() * 0.9 + 0.1) * speed,
          vz: (Math.random() - 0.5) * 2 * speed,
        },
        0.22 + Math.random() * 0.34,
        (0.2 + Math.random() * 0.3) * scale,
        _fireColor,
        6,
        2.4, // drag: the ball loses speed fast instead of spraying across the room
      );
    }
    // Smoke: slow, long-lived, rises as it thins out (negative gravity = lift).
    for (let i = 0; i < (metal ? 12 : 20); i++) {
      const g = 0.12 + Math.random() * 0.1;
      _smokeColor.setRGB(g, g * 0.97, g * 0.94);
      this.dust.emit(
        point,
        {
          vx: (Math.random() - 0.5) * 2.4 * scale,
          vy: 0.5 + Math.random() * 1.6,
          vz: (Math.random() - 0.5) * 2.4 * scale,
        },
        0.9 + Math.random() * 0.9,
        (0.35 + Math.random() * 0.5) * scale,
        _smokeColor,
        -0.35,
        1.2,
      );
    }
    // Soot: on the surface the round went off against, or on the floor when it
    // cooked off in mid-air. Marks go through the decal pool, so they expire and
    // die with the door panel they sit on exactly like bullet holes.
    if (normal) {
      this.scorch.place(point, normal, scale, Math.random() * 6.28, owner);
    } else {
      _sootGround.x = point.x;
      _sootGround.y = 0;
      _sootGround.z = point.z;
      this.scorch.place(_sootGround, UP_NORMAL, scale, Math.random() * 6.28, null);
    }
  }

  /** Short fading tracer line from the muzzle to the impact point. */
  spawnTracer(from, to, color = 0xffd27a) {
    const t = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;
    const attr = t.line.geometry.attributes.position;
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    t.line.material.color.setHex(color);
    t.line.material.opacity = 0.85;
    t.line.visible = true;
    t.life = 0.07;
  }

  /** Removes all bullet holes, blood pools and scorch marks, resetting lifetimes. */
  clearDecals() {
    this.holes.clear();
    this.bloodDecals.clear();
    this.scorch.clear();
  }

  /**
   * Per-frame update of particles, decals fading, tracers and motes.
   * @param {number} dt seconds
   * @param {number} [time] elapsed run time, used by the ambient motes
   * @param {Array<{openAmount:number}>} [doors] surfaces that own decals
   */
  update(dt, time = 0, doors = null) {
    this.blood.update(dt);
    this.sparks.update(dt);
    this.dust.update(dt);

    // Decals: expire on a timer and disappear with the surface they sit on.
    this.holes.update(dt, doors);
    this.bloodDecals.update(dt, doors);
    this.scorch.update(dt, doors);

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.line.visible = false;
      } else {
        t.line.material.opacity = Math.max(0, t.life / 0.07) * 0.85;
      }
    }

    // Ambient motes drift slowly and wrap inside the facility.
    const m = this.motes;
    const { minX, minZ, maxX, maxZ } = this.bounds;
    const arr = m.geo.attributes.position.array;
    for (let i = 0; i < m.count; i++) {
      const i3 = i * 3;
      arr[i3] += Math.sin(time * m.seeds[i3 + 1] + m.seeds[i3]) * 0.12 * dt;
      arr[i3 + 1] += Math.cos(time * m.seeds[i3 + 1] * 1.3 + m.seeds[i3 + 2]) * 0.05 * dt;
      arr[i3 + 2] += Math.cos(time * m.seeds[i3 + 1] + m.seeds[i3]) * 0.12 * dt;
      if (arr[i3] < minX) arr[i3] += maxX - minX;
      if (arr[i3] > maxX) arr[i3] -= maxX - minX;
      if (arr[i3 + 2] < minZ) arr[i3 + 2] += maxZ - minZ;
      if (arr[i3 + 2] > maxZ) arr[i3 + 2] -= maxZ - minZ;
    }
    m.geo.attributes.position.needsUpdate = true;
  }

  /** Keeps point sizes correct for the current viewport. */
  setViewport(pixelHeight, fovDeg) {
    const scale = pixelHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    for (const sys of [this.blood, this.sparks, this.dust]) sys.material.uniforms.uScale.value = scale;
    this.motes.material.uniforms.uScale.value = scale;
  }

  dispose() {
    this.blood.dispose();
    this.sparks.dispose();
    this.dust.dispose();
    this.scene.remove(this.motes.points);
    this.motes.geo.dispose();
    this.motes.material.dispose();
    this.holes.dispose();
    this.bloodDecals.dispose();
    this.scorch.dispose();
    this.holeMaterial.dispose();
    this.bloodMaterial.dispose();
    this.scorchMaterial.dispose();
    for (const t of this.textures) t.dispose();
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
    }
  }
}
