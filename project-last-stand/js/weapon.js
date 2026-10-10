/**
 * weapon.js
 * ------------------------------------------------------------------
 * Weapons: definitions, ammo bookkeeping, hitscan firearms, close-range
 * melee swings and first-person viewmodels.
 *
 * Hitscan resolution:
 *   1. Build the shot direction from the camera basis (with spread).
 *   2. Find the nearest world box with a slab-test raycast.
 *   3. Raycast the enemy hitboxes (THREE.Raycaster) up to that distance.
 *   4. Apply falloff and headshot multipliers, then report the hit to the
 *      game through hooks.onEnemyHit so scoring/health stay in one place.
 *
 * Nothing is removed "on click": a shot only damages an enemy whose
 * hitbox is actually under the (spread-jittered) crosshair ray.
 */
import * as THREE from 'three';
import { raycastBoxes } from './collision.js';
import { createGlowTexture } from './textures.js';
import { mergeMeshesByMaterial } from './level.js';

export const WEAPON_DEFS = {
  rifle: {
    id: 'rifle',
    category: 'firearm',
    name: 'MX-7 ASSAULT RIFLE',
    slot: 1,
    damage: 24,
    headshotMultiplier: 2,
    fireRate: 9.5,          // shots per second
    auto: true,
    magazineSize: 30,
    startReserve: 120,
    maxReserve: 300,
    reloadTime: 1.9,
    reloadMode: 'magazine', // whole magazine at once
    switchTime: 0.45,
    pellets: 1,
    spread: 0.008,          // radians (half-angle of the cone)
    bloomPerShot: 0.0035,   // spread grows while firing continuously
    maxBloom: 0.03,
    bloomDecay: 5,
    range: 150,
    falloff: null,
    recoil: { pitch: 0.012, yaw: 0.004, kick: 0.035, trauma: 0.12 },
    tracer: true,
    sound: 'rifle',
  },
  shotgun: {
    id: 'shotgun',
    category: 'firearm',
    name: 'HB-12 HELLBORE SHOTGUN',
    slot: 2,
    damage: 13,             // per pellet
    headshotMultiplier: 2,
    fireRate: 1.05,
    auto: false,
    magazineSize: 8,
    startReserve: 32,
    maxReserve: 72,
    reloadTime: 0.55,       // per shell
    reloadMode: 'shell',
    switchTime: 0.6,
    pellets: 9,
    spread: 0.075,
    bloomPerShot: 0,
    maxBloom: 0,
    bloomDecay: 5,
    range: 32,
    falloff: { start: 7, end: 26, min: 0.3 }, // full damage close, 30% far away
    recoil: { pitch: 0.045, yaw: 0.01, kick: 0.12, trauma: 0.45 },
    tracer: false,
    sound: 'shotgun',
  },
  knife: {
    id: 'knife',
    category: 'melee',
    name: 'FIELD KNIFE',
    slot: 3,
    damage: 44,
    reach: 1.65,
    arcDegrees: 14,
    rayCount: 1,
    maxTargets: 1,
    hitTime: 0.11,
    attackDuration: 0.42,
    attackCooldown: 0.48,
    switchTime: 0.36,
  },
  pipe: {
    id: 'pipe',
    category: 'melee',
    name: 'STEEL PIPE',
    slot: 4,
    damage: 52,
    reach: 1.9,
    arcDegrees: 42,
    rayCount: 5,
    maxTargets: 2,
    hitTime: 0.2,
    attackDuration: 0.62,
    attackCooldown: 0.72,
    switchTime: 0.4,
  },
  axe: {
    id: 'axe',
    category: 'melee',
    name: 'FIRE AXE',
    slot: 5,
    damage: 95,
    reach: 2.05,
    arcDegrees: 30,
    rayCount: 3,
    maxTargets: 1,
    hitTime: 0.31,
    attackDuration: 0.94,
    attackCooldown: 1.08,
    switchTime: 0.48,
  },
};

/** Slot order is stable: rifle and shotgun keep their existing keys. */
export const WEAPON_ORDER = ['rifle', 'shotgun', 'knife', 'pipe', 'axe'];

/** Firearms only; melee weapons never consume or receive ammunition. */
export const AMMO_PICKUP = { rifle: 45, shotgun: 10 };

/** Per-weapon ammo state. */
class WeaponState {
  constructor(def) {
    this.def = def;
    this.reset();
  }
  reset() {
    this.ammo = this.def.category === 'firearm' ? this.def.magazineSize : null;
    this.reserve = this.def.category === 'firearm' ? this.def.startReserve : null;
    this.cooldown = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.attacking = false;
    this.attackTimer = 0;
    this.attackHit = false;
  }
}

/* ------------------------------------------------------------------ *
 * Viewmodels (procedural). Built in camera space; the barrel points -Z.
 * ------------------------------------------------------------------ */
function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.4, ...opts });
}

function box(w, h, d, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

function buildRifleModel() {
  const group = new THREE.Group();
  const dark = mat(0x23282f, { roughness: 0.45, metalness: 0.7 });
  const mid = mat(0x3d444d, { roughness: 0.5, metalness: 0.6 });
  const polymer = mat(0x1a1d21, { roughness: 0.85, metalness: 0.05 });
  const accent = mat(0xb71c1c, { roughness: 0.4, metalness: 0.2 });

  group.add(box(0.07, 0.11, 0.36, mid));                    // receiver
  const rail = box(0.03, 0.03, 0.3, dark); rail.position.set(0, 0.07, -0.02); group.add(rail);
  const sight = box(0.03, 0.05, 0.03, dark); sight.position.set(0, 0.11, -0.05); group.add(sight);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, 0.24, 10), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.3);
  group.add(barrel);
  const hand = box(0.075, 0.075, 0.2, polymer); hand.position.set(0, -0.01, -0.2); group.add(hand);
  const stripe = box(0.072, 0.012, 0.22, accent); stripe.position.set(0, 0.03, -0.08); group.add(stripe);
  const stock = box(0.06, 0.1, 0.2, polymer); stock.position.set(0, -0.01, 0.24); group.add(stock);
  const mag = box(0.05, 0.16, 0.07, dark); mag.position.set(0, -0.12, 0.02); mag.rotation.x = 0.18; group.add(mag);
  const grip = box(0.05, 0.12, 0.05, polymer); grip.position.set(0, -0.11, 0.1); grip.rotation.x = -0.3; group.add(grip);

  // One draw call per material instead of one per part (parts never move on their own).
  mergeMeshesByMaterial(group);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.44);
  group.add(muzzle);
  return { group, muzzle, barrelLength: 0.44 };
}

function buildShotgunModel() {
  const group = new THREE.Group();
  const dark = mat(0x262b31, { roughness: 0.5, metalness: 0.65 });
  const wood = mat(0x5b3b22, { roughness: 0.8, metalness: 0.0 });
  const red = mat(0x9b1b1b, { roughness: 0.5, metalness: 0.2 });

  group.add(box(0.085, 0.12, 0.3, dark));                   // receiver
  for (const dx of [-0.018, 0.018]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.55, 10), dark);
    b.rotation.x = Math.PI / 2;
    b.position.set(dx, 0.045, -0.42);
    group.add(b);
  }
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 10), dark);
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, -0.03, -0.36);
  group.add(tube);
  const pump = box(0.08, 0.07, 0.16, wood); pump.position.set(0, -0.05, -0.34); group.add(pump);
  const stock = box(0.07, 0.14, 0.3, wood); stock.position.set(0, -0.01, 0.27); stock.rotation.x = -0.08; group.add(stock);
  const band = box(0.088, 0.02, 0.03, red); band.position.set(0, 0.0, -0.14); group.add(band);
  const sight = box(0.02, 0.03, 0.02, dark); sight.position.set(0, 0.08, -0.5); group.add(sight);

  mergeMeshesByMaterial(group);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.045, -0.7);
  group.add(muzzle);
  return { group, muzzle, barrelLength: 0.7 };
}

function buildKnifeModel() {
  const group = new THREE.Group();
  const steel = mat(0x9caab5, { roughness: 0.28, metalness: 0.85 });
  const grip = mat(0x202729, { roughness: 0.85, metalness: 0.05 });
  const accent = mat(0xb32626, { roughness: 0.55, metalness: 0.1 });

  group.add(box(0.052, 0.062, 0.17, grip));
  const guard = box(0.13, 0.026, 0.04, steel);
  guard.position.set(0, 0.015, 0.005);
  group.add(guard);
  const blade = box(0.052, 0.018, 0.22, steel);
  blade.position.set(0, 0.032, -0.115);
  group.add(blade);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 4), steel);
  tip.rotation.x = -Math.PI / 2;
  tip.position.set(0, 0.032, -0.265);
  group.add(tip);
  const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.025, 8), accent);
  pommel.rotation.x = Math.PI / 2;
  pommel.position.set(0, 0, 0.105);
  group.add(pommel);

  mergeMeshesByMaterial(group);
  return { group };
}

function buildPipeModel() {
  const group = new THREE.Group();
  const metal = mat(0x747c83, { roughness: 0.42, metalness: 0.78 });
  const grip = mat(0x272321, { roughness: 0.9, metalness: 0.02 });
  const tape = mat(0xb18b39, { roughness: 0.78, metalness: 0.05 });

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.038, 0.57, 9), metal);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.set(0, 0, -0.04);
  group.add(shaft);
  const handGrip = box(0.075, 0.075, 0.14, grip);
  handGrip.position.set(0, 0, 0.13);
  group.add(handGrip);
  for (const z of [-0.31, 0.23]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.035, 9), metal);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = z;
    group.add(cap);
  }
  const band = box(0.078, 0.08, 0.035, tape);
  band.position.set(0, 0, 0.105);
  group.add(band);

  mergeMeshesByMaterial(group);
  return { group };
}

function buildAxeModel() {
  const group = new THREE.Group();
  const steel = mat(0x9aa4ab, { roughness: 0.32, metalness: 0.82 });
  const darkSteel = mat(0x363b3e, { roughness: 0.48, metalness: 0.72 });
  const handle = mat(0x4d2c1d, { roughness: 0.8, metalness: 0.03 });
  const red = mat(0xb32626, { roughness: 0.5, metalness: 0.15 });

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.033, 0.58, 9), handle);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.set(0.015, -0.01, 0.04);
  group.add(shaft);
  const grip = box(0.065, 0.075, 0.16, darkSteel);
  grip.position.set(0.015, -0.01, 0.19);
  group.add(grip);
  const head = box(0.24, 0.17, 0.09, steel);
  head.position.set(-0.09, 0.035, -0.215);
  group.add(head);
  const poll = box(0.11, 0.13, 0.1, darkSteel);
  poll.position.set(0.055, 0.035, -0.215);
  group.add(poll);
  const warningStripe = box(0.12, 0.018, 0.095, red);
  warningStripe.position.set(0.0, -0.025, 0.15);
  group.add(warningStripe);

  mergeMeshesByMaterial(group);
  return { group };
}

/**
 * Damage multiplier for a hit at `distance` metres.
 * Full damage up to `falloff.start`, linear fall-off to `falloff.min` at `falloff.end`.
 */
export function computeFalloff(def, distance) {
  if (!def.falloff) return 1;
  const { start, end, min } = def.falloff;
  const t = Math.min(1, Math.max(0, (distance - start) / (end - start)));
  return 1 - (1 - min) * t;
}

export class WeaponSystem {
  /**
   * @param {object} opts
   * @param {THREE.PerspectiveCamera} opts.camera  must be in the scene (viewmodels are its children)
   * @param {import('./audio.js').AudioManager} opts.audio
   * @param {import('./effects.js').EffectsManager} opts.effects
   * @param {import('./player.js').Player} opts.player
   * @param {object} opts.hooks  onShot(def), onEnemyHit({enemy,damage,headshot,point,distance,weapon}) -> {killed},
   *                             onSwitch(def), onReload(def), onMessage(text)
   */
  constructor({ camera, audio, effects, player, hooks = {} }) {
    this.camera = camera;
    this.audio = audio;
    this.effects = effects;
    this.player = player;
    this.hooks = hooks;

    this.states = WEAPON_ORDER.map((id) => new WeaponState(WEAPON_DEFS[id]));
    this.index = 0;
    this.switchTimer = 0;
    this.bloom = 0;
    this.aimAmount = 0;
    this.viewKick = 0;
    this.flashTimer = 0;
    this.shotCount = 0;

    this.models = [
      buildRifleModel(),
      buildShotgunModel(),
      buildKnifeModel(),
      buildPipeModel(),
      buildAxeModel(),
    ];
    for (const m of this.models) {
      m.group.visible = false;
      m.group.position.set(0.24, -0.24, -0.42);
      camera.add(m.group);
      if (!m.muzzle) continue; // Only firearms have muzzle-flash sprites.
      const flashMat = new THREE.SpriteMaterial({
        map: createGlowTexture('#ffb347'),
        color: 0xffc27a,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      m.flash = new THREE.Sprite(flashMat);
      m.flash.scale.set(0.32, 0.32, 1);
      m.flash.position.set(0, 0, -0.04);
      m.muzzle.add(m.flash);
    }
    this.models[this.index].group.visible = true;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0;
    this._origin = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._rayOrigin = { x: 0, y: 0, z: 0 };
    this._rayDirection = { x: 0, y: 0, z: -1 };
  }

  get state() {
    return this.states[this.index];
  }

  get def() {
    return this.states[this.index].def;
  }

  reset() {
    for (const s of this.states) s.reset();
    this.index = 0;
    this.switchTimer = 0;
    this.bloom = 0;
    this.aimAmount = 0;
    this.viewKick = 0;
    this.flashTimer = 0;
    this.models.forEach((m, i) => {
      m.group.visible = i === 0;
      if (m.flash) {
        m.flash.visible = false;
        m.flash.material.opacity = 0;
      }
    });
  }

  /** Switches by slot index; firearms keep slots 1-2 and melee uses slots 3-5. */
  requestSwitch(index) {
    if (index < 0 || index >= this.states.length || index === this.index) return false;
    const old = this.state;
    old.reloading = false;
    old.attacking = false;
    old.attackTimer = 0;
    old.attackHit = false;
    this.flashTimer = 0;
    this.models[this.index].group.visible = false;
    this.index = index;
    this.models[index].group.visible = true;
    this.switchTimer = this.def.switchTime;
    this.audio.playSwitch();
    this.hooks.onSwitch?.(this.def);
    return true;
  }

  /** Begins a reload if possible. Returns true if a reload started. */
  startReload() {
    const st = this.state;
    if (st.def.category !== 'firearm' || this.switchTimer > 0 || st.reloading) return false;
    if (st.ammo >= st.def.magazineSize) return false;
    if (st.reserve <= 0) {
      this.hooks.onMessage?.('NO RESERVE AMMO');
      this.audio.playDryFire();
      return false;
    }
    st.reloading = true;
    st.reloadTimer = st.def.reloadTime;
    this.audio.playReload(st.def.reloadMode === 'shell' ? 'shellStart' : 'magOut');
    this.hooks.onReload?.(st.def);
    return true;
  }

  /** Finishes one reload step (whole magazine, or one shell for the shotgun). */
  completeReloadStep() {
    const st = this.state;
    const def = st.def;
    if (def.reloadMode === 'magazine') {
      const take = Math.min(def.magazineSize - st.ammo, st.reserve);
      st.ammo += take;
      st.reserve -= take;
      st.reloading = false;
      this.audio.playReload('magIn');
      return;
    }
    // Shell mode: insert one shell and keep going until full or out of reserve.
    st.ammo += 1;
    st.reserve -= 1;
    this.audio.playReload('shell');
    if (st.ammo < def.magazineSize && st.reserve > 0) {
      st.reloadTimer = def.reloadTime;
    } else {
      st.reloading = false;
      this.audio.playReload('pump');
    }
  }

  /** True when a firearm has room for reserve ammo. Melee is inexhaustible. */
  needsAmmo() {
    return this.states.some((st) =>
      st.def.category === 'firearm' && st.reserve < st.def.maxReserve);
  }

  /** Shows or hides the viewmodel (hidden in menus and after death). */
  setVisible(visible) {
    this.models.forEach((m, i) => (m.group.visible = visible && i === this.index));
  }

  /** Releases procedural viewmodel GPU resources when the game is disposed. */
  dispose() {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    for (const model of this.models) {
      this.camera.remove(model.group);
      model.group.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (!object.material) return;
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) {
          materials.add(material);
          if (material.map) textures.add(material.map);
        }
      });
    }
    for (const geometry of geometries) geometry.dispose();
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
  }

  /**
   * Adds reserve ammo for every weapon (ammo pickups).
   * @returns {boolean} true when at least one weapon accepted ammo
   */
  addAmmo() {
    let added = false;
    for (const st of this.states) {
      if (st.def.category !== 'firearm') continue;
      const amount = AMMO_PICKUP[st.def.id];
      const before = st.reserve;
      st.reserve = Math.min(st.def.maxReserve, st.reserve + amount);
      if (st.reserve > before) added = true;
    }
    return added;
  }

  /**
   * Per-frame update. `input` carries edge/held flags, `ctx` the world info.
   * ctx: { canFire, colliders, hitboxes(): Object3D[], speedFactor, bobPhase, dt }
   */
  update(dt, input, ctx) {
    const st = this.state;
    const isMelee = st.def.category === 'melee';
    st.cooldown = Math.max(0, st.cooldown - dt);
    this.switchTimer = Math.max(0, this.switchTimer - dt);
    this.viewKick *= Math.exp(-14 * dt);
    if (!isMelee) {
      this.bloom *= Math.exp(-st.def.bloomDecay * dt);
      this.flashTimer = Math.max(0, this.flashTimer - dt);
    }

    const aiming = !isMelee && !!input.aim && ctx.canFire;
    this.aimAmount += ((aiming ? 1 : 0) - this.aimAmount) * Math.min(1, dt * 12);

    if (st.reloading) {
      st.reloadTimer -= dt;
      if (st.reloadTimer <= 0) this.completeReloadStep();
    }

    if (isMelee) {
      if (!ctx.canFire) {
        st.attacking = false;
        st.attackTimer = 0;
        st.attackHit = false;
      } else {
        if (st.attacking) {
          st.attackTimer = Math.min(st.def.attackDuration, st.attackTimer + dt);
          if (!st.attackHit && st.attackTimer >= st.def.hitTime) {
            st.attackHit = true;
            this.resolveMeleeAttack(st.def, ctx);
          }
          if (st.attackTimer >= st.def.attackDuration) {
            st.attacking = false;
            st.attackTimer = 0;
            st.attackHit = false;
          }
        }
        // Melee is edge-triggered: holding the mouse never repeats a swing.
        if (input.firePressed) this.tryMeleeAttack();
      }
    } else if (ctx.canFire) {
      if (input.reloadPressed) this.startReload();
      const wantsFire = st.def.auto ? input.fireHeld : input.firePressed;
      if (wantsFire) this.tryFire(ctx);
    }

    this.updateViewmodel(ctx);
    this.updateMuzzleFlash();
  }

  /** Starts one melee swing; damage is applied once on its animated hit frame. */
  tryMeleeAttack() {
    const st = this.state;
    if (st.def.category !== 'melee' || this.switchTimer > 0 || st.cooldown > 0 || st.attacking) return false;
    st.attacking = true;
    st.attackTimer = 0;
    st.attackHit = false;
    st.cooldown = st.def.attackCooldown;
    this.audio.playMeleeSwing(st.def.id);
    return true;
  }

  /** Applies a short forward fan of melee rays, stopped by the first world collider. */
  resolveMeleeAttack(def, ctx) {
    const hitboxes = ctx.hitboxes();
    if (hitboxes.length === 0) return;

    const cam = this.camera;
    cam.updateMatrixWorld(true);
    const origin = this._origin.setFromMatrixPosition(cam.matrixWorld);
    const forward = cam.getWorldDirection(this._forward);
    const originData = this._rayOrigin;
    originData.x = origin.x;
    originData.y = origin.y;
    originData.z = origin.z;

    const seen = new Set();
    const arc = THREE.MathUtils.degToRad(def.arcDegrees);
    const count = Math.max(1, def.rayCount);
    for (let i = 0; i < count && seen.size < def.maxTargets; i++) {
      const angle = count === 1 ? 0 : (i / (count - 1) - 0.5) * arc;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const dir = this._dir.set(
        forward.x * c + forward.z * s,
        forward.y,
        -forward.x * s + forward.z * c,
      ).normalize();
      const rayDir = this._rayDirection;
      rayDir.x = dir.x;
      rayDir.y = dir.y;
      rayDir.z = dir.z;

      const blocker = raycastBoxes(originData, rayDir, def.reach, ctx.colliders);
      this.raycaster.set(origin, dir);
      // Keep a tiny gap before a wall so a target on its far side cannot be hit.
      this.raycaster.far = blocker ? Math.max(0, blocker.distance - 0.02) : def.reach;
      if (this.raycaster.far <= 0) continue;

      const hits = this.raycaster.intersectObjects(hitboxes, false);
      for (const hit of hits) {
        const enemy = hit.object.userData.enemy;
        if (!enemy || !enemy.isTargetable() || seen.has(enemy)) continue;
        seen.add(enemy);
        const point = hit.point.clone();
        const normal = { x: -dir.x, y: -dir.y, z: -dir.z };
        const outcome = this.hooks.onEnemyHit?.({
          enemy,
          damage: def.damage,
          headshot: false,
          point,
          distance: hit.distance,
          weapon: def.id,
        });
        this.effects.spawnBlood(point, normal, 1.1);
        this.audio.playHitFlesh(false);
        if (outcome?.killed) this.effects.spawnBlood(point, normal, 2);
        break; // One target per ray; `seen` also prevents multi-ray double hits.
      }
    }
  }

  /** Fires if the weapon is ready. Returns true when a shot was taken. */
  tryFire(ctx) {
    const st = this.state;
    if (st.def.category !== 'firearm' || this.switchTimer > 0 || st.cooldown > 0) return false;
    if (st.ammo <= 0) {
      st.cooldown = 0.3;
      this.audio.playDryFire();
      if (st.reserve > 0) this.startReload();
      else this.hooks.onMessage?.('OUT OF AMMO');
      return false;
    }
    if (st.reloading) {
      // Magazine reloads cannot be interrupted; shell reloads can (shoot to cancel).
      if (st.def.reloadMode === 'magazine') return false;
      st.reloading = false;
    }

    st.ammo -= 1;
    st.cooldown = 1 / st.def.fireRate;
    this.shotCount++;
    this.fireShot(st.def, ctx);
    return true;
  }

  /** Shot direction, pellets, hit resolution and feedback. */
  fireShot(def, ctx) {
    const cam = this.camera;
    cam.updateMatrixWorld(true);
    const origin = this._origin.setFromMatrixPosition(cam.matrixWorld);
    const forward = cam.getWorldDirection(this._forward);
    const right = this._right.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const up = this._up.setFromMatrixColumn(cam.matrixWorld, 1).normalize();

    // Spread: base + bloom, tighter while aiming, looser while moving.
    const aimMult = 1 - 0.55 * this.aimAmount;
    const moveMult = 1 + 0.6 * (ctx.speedFactor || 0);
    const spread = (def.spread + this.bloom) * aimMult * moveMult;
    if (def.bloomPerShot) this.bloom = Math.min(def.maxBloom, this.bloom + def.bloomPerShot);

    const hitboxes = ctx.hitboxes();
    const results = [];
    for (let i = 0; i < def.pellets; i++) {
      // Uniform sample inside a disc for an even pellet pattern.
      const r = spread * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      const dir = this._dir
        .copy(forward)
        .addScaledVector(right, Math.cos(a) * r)
        .addScaledVector(up, Math.sin(a) * r)
        .normalize();
      results.push(this.traceRay(origin, dir, def.range, ctx, hitboxes));
    }

    // Resolve hits. Each enemy gets at most one blood burst per shot.
    const burstEnemies = new Set();
    let impacts = 0;
    let hitAnything = false;
    let furthest = null;
    for (const res of results) {
      if (res.type === 'enemy') {
        hitAnything = true;
        const falloff = this.falloffFor(def, res.distance);
        const damage = def.damage * falloff * (res.headshot ? def.headshotMultiplier : 1);
        const outcome = this.hooks.onEnemyHit?.({
          enemy: res.enemy,
          damage,
          headshot: res.headshot,
          point: res.point,
          distance: res.distance,
          weapon: def.id,
        });
        // One blood burst and one hit sound per enemy per shot (shotgun pellets).
        if (!burstEnemies.has(res.enemy)) {
          burstEnemies.add(res.enemy);
          this.effects.spawnBlood(res.point, res.normal, res.headshot ? 1.6 : 1);
          this.audio.playHitFlesh(res.headshot);
        }
        if (outcome?.killed) this.effects.spawnBlood(res.point, res.normal, 2);
      } else if (res.type === 'world') {
        if (impacts < 3) {
          this.effects.spawnImpact(res.point, res.normal, res.surface);
          impacts++;
        }
      }
      if (res.type !== 'miss' && (!furthest || res.distance > furthest.distance)) furthest = res;
    }

    // Visual + audio feedback for the shot itself.
    const muzzle = this.models[this.index].muzzle.getWorldPosition(this._muzzle);
    if (def.tracer) {
      const end = results[0].point;
      this.effects.spawnTracer(muzzle, end, 0xffd27a);
    }
    this.flashTimer = 0.05;
    this.models[this.index].flash.material.rotation = Math.random() * Math.PI;
    this.models[this.index].flash.material.opacity = 1;
    this.viewKick = Math.min(1, this.viewKick + def.recoil.kick * 6);

    this.player.addRecoil(
      def.recoil.pitch,
      (Math.random() - 0.5) * 2 * def.recoil.yaw,
    );
    this.player.addTrauma(def.recoil.trauma);
    this.audio.playShot(def.sound);
    this.hooks.onShot?.(def, hitAnything);
  }

  /** Damage multiplier for distance (shotgun falloff). */
  falloffFor(def, distance) {
    return computeFalloff(def, distance);
  }

  /**
   * Finds what a ray hits first: enemy hitbox, world box, floor/ceiling, or nothing.
   * Returns { type: 'enemy'|'world'|'miss', point, normal, distance, enemy?, headshot? }.
   */
  traceRay(origin, dir, range, ctx, hitboxes) {
    const o = { x: origin.x, y: origin.y, z: origin.z };
    const d = { x: dir.x, y: dir.y, z: dir.z };
    const worldHit = raycastBoxes(o, d, range, ctx.colliders);
    let maxDist = worldHit ? worldHit.distance : range;

    // Floor (y = 0) and ceiling (y = WALL height) planes.
    let surface = 'concrete';
    let planeNormal = null;
    let planeT = Infinity;
    if (dir.y < -1e-6) {
      const t = -origin.y / dir.y;
      if (t > 0 && t < maxDist) { planeT = t; planeNormal = { x: 0, y: 1, z: 0 }; surface = 'floor'; }
    } else if (dir.y > 1e-6) {
      const t = (4 - origin.y) / dir.y;
      if (t > 0 && t < maxDist) { planeT = t; planeNormal = { x: 0, y: -1, z: 0 }; surface = 'ceiling'; }
    }
    if (planeT < maxDist) maxDist = planeT;

    // Enemy hitboxes (nearest targetable one that is closer than the wall).
    this.raycaster.set(origin, dir);
    this.raycaster.far = maxDist;
    const hits = this.raycaster.intersectObjects(hitboxes, false);
    for (const hit of hits) {
      const enemy = hit.object.userData.enemy;
      if (!enemy || !enemy.isTargetable()) continue;
      return {
        type: 'enemy',
        enemy,
        headshot: hit.object.name === 'hitbox-head',
        point: hit.point.clone(),
        normal: { x: -dir.x, y: -dir.y, z: -dir.z },
        distance: hit.distance,
      };
    }

    if (planeT < Infinity && planeT <= (worldHit ? worldHit.distance : Infinity)) {
      const point = new THREE.Vector3(origin.x + dir.x * planeT, origin.y + dir.y * planeT, origin.z + dir.z * planeT);
      return { type: 'world', point, normal: planeNormal, distance: planeT, surface };
    }
    if (worldHit) {
      const p = worldHit.point;
      return {
        type: 'world',
        point: new THREE.Vector3(p.x, p.y, p.z),
        normal: worldHit.normal,
        distance: worldHit.distance,
        surface: worldHit.box.tag === 'wall' ? 'concrete' : 'metal',
      };
    }
    return {
      type: 'miss',
      point: new THREE.Vector3(origin.x + dir.x * range, origin.y + dir.y * range, origin.z + dir.z * range),
      distance: range,
    };
  }

  /** Viewmodel placement and attack animation for firearms and melee. */
  updateViewmodel(ctx) {
    const st = this.state;
    const model = this.models[this.index];
    const switchT = this.switchTimer > 0 ? this.switchTimer / st.def.switchTime : 0;
    const bob = Math.sin(ctx.bobPhase || 0) * 0.012 * (ctx.speedFactor || 0);
    const g = model.group;

    if (st.def.category === 'melee') {
      const phase = st.attacking ? Math.min(1, st.attackTimer / st.def.attackDuration) : 0;
      const swing = st.attacking ? Math.sin(Math.PI * phase) : 0;
      const dip = switchT * 0.35;
      g.position.x = 0.28 + bob * 0.5;
      g.position.y = -0.24 - dip + Math.abs(bob);
      g.position.z = -0.4 + swing * (st.def.id === 'axe' ? 0.04 : 0.025);

      if (st.def.id === 'knife') {
        g.rotation.x = -0.2 - swing * 0.7 + switchT * 0.45;
        g.rotation.y = 0.12 - swing * 0.35;
        g.rotation.z = 0.22 + swing * 1.05 - bob * 2;
      } else if (st.def.id === 'pipe') {
        g.rotation.x = -0.1 - swing * 0.35 + switchT * 0.45;
        g.rotation.y = swing * 0.15;
        g.rotation.z = -0.12 - swing * 1.2 - bob * 2;
      } else {
        // A heavier overhead chop, with a longer wind-up and follow-through.
        g.rotation.x = -0.28 - swing * 1.25 + switchT * 0.45;
        g.rotation.y = -0.08 + swing * 0.2;
        g.rotation.z = 0.16 + swing * 0.4 - bob * 2;
        g.position.y -= swing * 0.07;
      }
      return;
    }

    const aim = this.aimAmount;
    const reloadPhase = st.reloading ? 1 - st.reloadTimer / st.def.reloadTime : 0;
    const reloadT = st.reloading ? Math.sin(Math.PI * Math.min(1, reloadPhase)) : 0;
    const hipX = st.def.id === 'shotgun' ? 0.26 : 0.24;
    const hipY = -0.24;
    const hipZ = -0.42;
    const adsX = 0.0;
    const adsY = -0.175;
    const adsZ = -0.3;

    g.position.x = hipX + (adsX - hipX) * aim + bob * 0.5;
    g.position.y = hipY + (adsY - hipY) * aim - switchT * 0.35 - reloadT * 0.13 + Math.abs(bob);
    g.position.z = hipZ + (adsZ - hipZ) * aim + this.viewKick * 0.12;
    g.rotation.x = -this.viewKick * 0.25 + reloadT * 0.3 + switchT * 0.5;
    g.rotation.z = reloadT * 0.22 - bob * 2;
    g.rotation.y = 0;
  }

  updateMuzzleFlash() {
    const m = this.models[this.index];
    if (!m.flash) return;
    if (this.flashTimer > 0) {
      m.flash.material.opacity = 1;
      m.flash.visible = true;
    } else {
      m.flash.visible = false;
      m.flash.material.opacity = 0;
    }
  }

  /** HUD snapshot. */
  getHudData() {
    const st = this.state;
    const hasAmmo = st.def.category === 'firearm';
    return {
      name: st.def.name,
      ammo: st.ammo,
      reserve: st.reserve,
      hasAmmo,
      melee: !hasAmmo,
      attacking: st.attacking,
      reloading: st.reloading,
      switching: this.switchTimer > 0,
      slot: st.def.slot,
      auto: st.def.auto,
    };
  }
}
