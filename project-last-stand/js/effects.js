/**
 * effects.js
 * ------------------------------------------------------------------
 * Visual effects with pooled, reusable objects (no per-shot allocation
 * of meshes or geometry):
 *   - ParticleSystem: one THREE.Points draw call per system. Used for
 *     blood, sparks, dust and ambient motes.
 *   - DecalPool: recycled bullet-hole and blood decals on surfaces.
 *   - Tracers: a small pool of fading line segments.
 */
import * as THREE from 'three';
import { createBulletHoleTexture, createBloodTexture } from './textures.js';

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

/** Recycled decals placed on surfaces (bullet holes, blood pools). */
class DecalPool {
  constructor(scene, count, material, size) {
    this.scene = scene;
    this.items = [];
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(size, size);
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, material);
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.items.push(mesh);
    }
    this.geo = geo;
  }

  /** Places a decal at `point` facing `normal`. */
  place(point, normal, scale = 1, rotation = 0) {
    const mesh = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    mesh.position.set(point.x + normal.x * 0.01, point.y + normal.y * 0.01, point.z + normal.z * 0.01);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(normal.x, normal.y, normal.z));
    mesh.rotateZ(rotation);
    mesh.scale.setScalar(scale);
    mesh.visible = true;
  }

  /** Hides every decal (used when a run ends). */
  clear() {
    for (const m of this.items) m.visible = false;
    this.cursor = 0;
  }

  dispose() {
    for (const m of this.items) this.scene.remove(m);
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
    this.holes = new DecalPool(scene, 70, this.holeMaterial, 0.22);
    this.bloodDecals = new DecalPool(scene, 24, this.bloodMaterial, 1.1);
    this.tracers = [];
    this.tracerCursor = 0;
    this.createTracers(scene, 10);
    this.textures = [holeTex, bloodTex];
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

  /** Impact sparks/dust + bullet hole for a world surface. */
  spawnImpact(point, normal, surface = 'concrete') {
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

  /** Removes all bullet holes and blood pools. */
  clearDecals() {
    this.holes.clear();
    this.bloodDecals.clear();
  }

  /** Per-frame update of particles, decals fading, tracers and motes. */
  update(dt, time = 0) {
    this.blood.update(dt);
    this.sparks.update(dt);
    this.dust.update(dt);

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
    this.holeMaterial.dispose();
    this.bloodMaterial.dispose();
    for (const t of this.textures) t.dispose();
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
    }
  }
}
