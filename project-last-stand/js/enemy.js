/**
 * enemy.js
 * ------------------------------------------------------------------
 * Enemy data, health and visuals.
 *
 * This module owns everything about a single enemy EXCEPT its decisions:
 *   - stats (ENEMY_TYPES), health and damage intake,
 *   - the procedural humanoid model with pivoting limbs,
 *   - hitboxes used by hitscan weapons (head + body),
 *   - the floating health bar,
 *   - state timers and animation for: spawn, idle, chase, attack, hurt, death.
 *
 * Decisions (when to chase, where to path, when to strike) live in enemyAI.js.
 */
import * as THREE from 'three';

/** Base stats. Wave multipliers are applied per-enemy on spawn. */
export const ENEMY_TYPES = {
  infected: {
    id: 'infected',
    name: 'Infected',
    maxHealth: 70,
    speed: 2.3,        // wandering speed
    chaseSpeed: 3.0,   // hunting speed (slower than the player's sprint)
    damage: 10,
    attackRange: 1.0,  // extra reach beyond the two body radii
    attackCooldown: 1.1,
    windup: 0.4,       // telegraph before the strike lands
    detectionRange: 22,
    armor: 0,
    score: 100,
    radius: 0.38,
    height: 1.8,
    scale: 1.0,
    staggerable: true,
    palette: { skin: 0x7d8f6a, cloth: 0x2e3a33, glow: 0x9dff5a, pose: 'shamble' },
  },
  runner: {
    id: 'runner',
    name: 'Runner',
    maxHealth: 42,
    speed: 3.2,
    chaseSpeed: 6.0,   // faster than walking, slower than sprinting
    damage: 12,
    attackRange: 0.95,
    attackCooldown: 1.0,
    windup: 0.25,
    detectionRange: 26,
    armor: 0,
    score: 150,
    radius: 0.34,
    height: 1.7,
    scale: 0.96,
    staggerable: true,
    palette: { skin: 0x9c6f5e, cloth: 0x5a2222, glow: 0xff6a3a, pose: 'lean' },
  },
  armored: {
    id: 'armored',
    name: 'Armored',
    maxHealth: 210,
    speed: 1.4,
    chaseSpeed: 2.0,
    damage: 30,
    attackRange: 1.2,
    attackCooldown: 1.9,
    windup: 0.7,
    detectionRange: 20,
    armor: 0.35,      // 35% body-shot damage reduction (headshots ignore armor)
    score: 300,
    radius: 0.48,
    height: 2.1,
    scale: 1.18,
    staggerable: false, // super-armor: flinches but never loses its swing
    palette: { skin: 0x505a5c, cloth: 0x1c2226, armor: 0x2d3a44, glow: 0xff3030, pose: 'brute' },
  },
};

export const SPAWN_RISE_TIME = 1.0;
export const DEATH_FALL_TIME = 0.9;
export const DEATH_REMOVE_TIME = 3.4;
const HURT_TIME = 0.2;

let nextEnemyId = 1;

/* Shared geometry/material cache: one geometry set per enemy type. */
const sharedAssets = {};

function buildSharedAssets(typeId) {
  if (sharedAssets[typeId]) return sharedAssets[typeId];
  const type = ENEMY_TYPES[typeId];
  const s = type.scale;
  const box = (w, h, d) => new THREE.BoxGeometry(w * s, h * s, d * s);
  const assets = {
    legGeo: box(0.2, 0.9, 0.22),
    torsoGeo: box(0.5, 0.72, 0.3),
    armGeo: box(0.16, 0.66, 0.17),
    headGeo: new THREE.SphereGeometry(0.17 * s, 14, 10),
    eyeGeo: box(0.09, 0.03, 0.03),
    plateGeo: box(0.58, 0.5, 0.1),
    padGeo: new THREE.BoxGeometry(0.2 * s, 0.14 * s, 0.22 * s),
    visorGeo: box(0.26, 0.07, 0.04),
    barBgGeo: new THREE.PlaneGeometry(1, 1),
  };
  sharedAssets[typeId] = assets;
  return assets;
}

/** Hit-detection materials are invisible but still raycastable. */
const hitboxMaterial = new THREE.MeshBasicMaterial({ visible: false });

/*
 * Body materials are pooled per enemy type instead of being created and
 * disposed with every enemy. Disposing a material releases its shader program
 * once no other material uses it, so a wave that clears the field used to
 * force every enemy program to be compiled again when the next wave spawned.
 * Pooled materials stay alive, so their programs stay compiled.
 */
const bodyMaterialPools = {};

function createBodyMaterials(typeId) {
  const pal = ENEMY_TYPES[typeId].palette;
  const mats = {
    skin: new THREE.MeshStandardMaterial({ color: pal.skin, roughness: 0.85, emissive: 0x000000 }),
    cloth: new THREE.MeshStandardMaterial({ color: pal.cloth, roughness: 0.95, emissive: 0x000000 }),
    glow: new THREE.MeshBasicMaterial({ color: pal.glow }),
  };
  if (pal.armor) {
    mats.armor = new THREE.MeshStandardMaterial({ color: pal.armor, roughness: 0.45, metalness: 0.6, emissive: 0x000000 });
  }
  return mats;
}

function acquireBodyMaterials(typeId) {
  const pool = bodyMaterialPools[typeId] || (bodyMaterialPools[typeId] = []);
  return pool.length > 0 ? pool.pop() : createBodyMaterials(typeId);
}

function releaseBodyMaterials(typeId, mats) {
  for (const key of Object.keys(mats)) {
    const m = mats[key];
    if (m.emissive && key !== 'glow') m.emissive.setHex(0x000000); // clear any damage flash
  }
  bodyMaterialPools[typeId].push(mats);
}

/** Builds the procedural humanoid (feet at origin, facing +Z). */
function buildModel(typeId, assets) {
  const type = ENEMY_TYPES[typeId];
  const s = type.scale;
  const pal = type.palette;
  const mats = acquireBodyMaterials(typeId);
  const root = new THREE.Group();
  // Tilt in local space first, then yaw: a falling body topples relative to its facing.
  root.rotation.order = 'YXZ';
  const body = new THREE.Group();
  root.add(body);

  // Legs (pivot at hip so they can swing when walking)
  const legs = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.12 * s, 0.92 * s, 0);
    const leg = new THREE.Mesh(assets.legGeo, mats.cloth);
    leg.position.y = -0.45 * s;
    pivot.add(leg);
    body.add(pivot);
    legs.push(pivot);
  }

  // Torso
  const torso = new THREE.Mesh(assets.torsoGeo, mats.cloth);
  torso.position.y = 1.28 * s;
  body.add(torso);
  if (mats.armor) {
    const plate = new THREE.Mesh(assets.plateGeo, mats.armor);
    plate.position.set(0, 1.3 * s, 0.2 * s);
    body.add(plate);
    for (const side of [-1, 1]) {
      const pad = new THREE.Mesh(assets.padGeo, mats.armor);
      pad.position.set(side * 0.34 * s, 1.56 * s, 0);
      body.add(pad);
    }
  }

  // Head with glowing eyes (visor for the armored type)
  const head = new THREE.Mesh(assets.headGeo, mats.skin);
  head.position.y = 1.72 * s;
  body.add(head);
  if (mats.armor) {
    const visor = new THREE.Mesh(assets.visorGeo, mats.glow);
    visor.position.set(0, 1.73 * s, 0.16 * s);
    body.add(visor);
  } else {
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(assets.eyeGeo, mats.glow);
      eye.position.set(side * 0.06 * s, 1.75 * s, 0.155 * s);
      body.add(eye);
    }
  }

  // Arms (pivot at shoulder)
  const arms = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.31 * s, 1.55 * s, 0);
    const arm = new THREE.Mesh(assets.armGeo, mats.skin);
    arm.position.y = -0.33 * s;
    pivot.add(arm);
    body.add(pivot);
    arms.push(pivot);
  }

  // Pose: runners lean forward, the infected shamble with arms out.
  if (pal.pose === 'lean') body.rotation.x = 0.22;
  if (pal.pose === 'shamble') {
    arms.forEach((a) => (a.rotation.x = -0.35));
  }
  if (pal.pose === 'brute') {
    arms.forEach((a) => (a.rotation.x = -0.15));
  }

  // Hitboxes: body (box) and head (sphere). Invisible but raycastable.
  const H = type.height;
  const bodyH = H - 0.3;
  const bodyBox = new THREE.Mesh(
    new THREE.BoxGeometry(type.radius * 2.2, bodyH, type.radius * 2.2),
    hitboxMaterial,
  );
  bodyBox.position.y = bodyH / 2;
  bodyBox.name = 'hitbox-body';
  const headBox = new THREE.Mesh(new THREE.SphereGeometry(0.22 * s, 10, 8), hitboxMaterial);
  headBox.position.y = H - 0.1;
  headBox.name = 'hitbox-head';
  root.add(bodyBox, headBox);

  return {
    root,
    body,
    legs,
    arms,
    materials: mats,
    hitboxes: { body: bodyBox, head: headBox },
  };
}

/*
 * Health bar materials never change per enemy, so every bar shares one pair.
 * (Previously each enemy allocated and disposed its own pair.)
 */
const barMaterials = {
  bg: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }),
  fg: new THREE.MeshBasicMaterial({ color: 0xff2a2a, depthWrite: false }),
};

/** Floating health bar that always faces the camera. */
function buildHealthBar(assets) {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(assets.barBgGeo, barMaterials.bg);
  bg.scale.set(0.9, 0.1, 1);
  const fg = new THREE.Mesh(assets.barBgGeo, barMaterials.fg);
  fg.scale.set(0.86, 0.06, 1);
  fg.position.z = 0.001;
  group.add(bg, fg);
  group.userData = { fg };
  group.visible = false;
  return group;
}

/** Simple angle wrapping helper. */
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Builds one visible model of every enemy type so their shader programs can be
 * compiled before the first wave (see Game.prewarmShaders). It draws no random
 * numbers, so it does not change the sequence of spawns. Returns a function
 * that removes the models again and returns their materials to the pool.
 */
export function warmEnemyVisuals(scene) {
  const group = new THREE.Group();
  const models = [];
  for (const typeId of Object.keys(ENEMY_TYPES)) {
    const assets = buildSharedAssets(typeId);
    const model = buildModel(typeId, assets);
    const bar = buildHealthBar(assets);
    bar.visible = true;
    group.add(model.root, bar);
    models.push({ typeId, model });
  }
  scene.add(group);
  return () => {
    scene.remove(group);
    for (const { typeId, model } of models) releaseBodyMaterials(typeId, model.materials);
  };
}

export class Enemy {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {string} opts.typeId
   * @param {number} opts.x  world X of the feet
   * @param {number} opts.z  world Z of the feet
   * @param {{health:number, damage:number, speed:number}} opts.multipliers wave scaling
   * @param {boolean} opts.aggro  start hunting immediately
   */
  constructor({ scene, typeId, x, z, multipliers, aggro = false }) {
    const type = ENEMY_TYPES[typeId];
    if (!type) throw new Error(`Unknown enemy type: ${typeId}`);
    this.id = nextEnemyId++;
    this.type = type;
    this.typeId = typeId;
    this.scene = scene;

    // Scaled stats for this wave
    this.maxHealth = Math.round(type.maxHealth * multipliers.health);
    this.health = this.maxHealth;
    this.damage = Math.round(type.damage * multipliers.damage);
    this.chaseSpeed = type.chaseSpeed * multipliers.speed;
    this.wanderSpeed = type.speed * multipliers.speed;

    // Transform: position is the feet on the floor.
    this.position = new THREE.Vector3(x, 0, z);
    this.home = { x, z };
    this.yaw = Math.random() * Math.PI * 2;
    this.moveSpeed = 0;

    // AI bookkeeping (read/written by enemyAI.js)
    this.aggro = aggro;
    this.canSee = false;
    this.losTimer = Math.random() * 0.25;
    this.lastSeen = -999;
    this.path = null;
    this.pathIndex = 0;
    this.pathGoal = null;
    this.nextPathTime = 0;
    this.cooldown = 0.4 + Math.random() * 0.6;
    this.attackTimer = 0;
    this.hurtTimer = 0;
    this.wanderTimer = Math.random() * 3;
    this.wanderTarget = null;
    this.stuckSampleTimer = 0.8;
    this.sampleX = x;
    this.sampleZ = z;
    this.stuckCount = 0;
    this.unstickTimer = 0;
    this.unstickDir = { x: 0, z: 0 };

    // State machine: spawn -> idle/chase <-> attack/hurt -> death
    this.state = 'spawn';
    this.stateTime = 0;
    this.flashTimer = 0;
    this.barTimer = 0;
    this.targeted = false;
    this.swingPending = false; // set when an attack starts; the game plays the swing sound
    this.wasAggro = false;     // used by the game to play the growl once on aggro
    this.deathDir = Math.random() < 0.5 ? -1 : 1;
    this.disposed = false;

    // Visuals
    const assets = buildSharedAssets(typeId);
    this.model = buildModel(typeId, assets);
    // Hitscan resolves hits through the hitbox: link each one back to this enemy.
    for (const hb of Object.values(this.model.hitboxes)) hb.userData.enemy = this;
    this.model.root.position.copy(this.position);
    this.model.root.position.y = -1.8; // rises out of the floor during spawn
    scene.add(this.model.root);
    this.healthBar = buildHealthBar(assets);
    scene.add(this.healthBar);
    this.model.root.updateMatrixWorld(true);
  }

  /** Enemies can only be hit once they've finished rising out of the floor. */
  isTargetable() {
    return this.state !== 'spawn' && this.state !== 'death';
  }

  /** Still in play for the wave counter (not yet dying). */
  isAlive() {
    return this.state !== 'death';
  }

  /** The death animation is complete and the object can be removed. */
  isRemovable() {
    return this.state === 'death' && this.stateTime >= DEATH_REMOVE_TIME;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
    if (next === 'attack') this.swingPending = true;
  }

  /**
   * Applies damage. Armor reduces body damage; headshots bypass armor.
   * Returns { dealt, killed }. Death is handled here so the caller only
   * needs to award score when `killed` is true.
   */
  takeDamage(amount, { headshot = false } = {}) {
    if (!this.isTargetable()) return { dealt: 0, killed: false };
    let dealt = amount;
    if (!headshot && this.type.armor) dealt *= 1 - this.type.armor;
    dealt = Math.max(1, Math.round(dealt));
    this.health -= dealt;
    this.flashTimer = 0.12;
    this.barTimer = 3.5;
    this.aggro = true; // being shot always alerts the target

    if (this.health <= 0) {
      this.health = 0;
      this.setState('death');
      this.deathDir = Math.random() < 0.5 ? -1 : 1;
      this.model.root.userData.dying = true;
      return { dealt, killed: true };
    }
    if (this.type.staggerable && this.state !== 'hurt') {
      this.hurtTimer = HURT_TIME;
      this.setState('hurt');
    }
    return { dealt, killed: false };
  }

  /** Sets facing (yaw) toward a target angle with smooth turning. */
  turnToward(targetYaw, dt, rate = 10) {
    const diff = wrapAngle(targetYaw - this.yaw);
    this.yaw += diff * Math.min(1, rate * dt);
  }

  /** Called every frame by the game loop (visuals + timers, not AI). */
  update(dt, camera) {
    this.stateTime += dt;
    const root = this.model.root;
    const s = this.type.scale;
    const pal = this.type.palette;

    // Spawn: rise out of the floor
    if (this.state === 'spawn') {
      const t = Math.min(1, this.stateTime / SPAWN_RISE_TIME);
      root.position.y = -1.8 * (1 - t * t);
      if (t >= 1) this.setState(this.aggro ? 'chase' : 'idle');
    } else if (this.state === 'death') {
      const t = Math.min(1, this.stateTime / DEATH_FALL_TIME);
      const e = t * t * (3 - 2 * t); // smoothstep
      root.rotation.x = this.deathDir * e * (Math.PI / 2) * 0.98;
      root.position.y = -0.12 * e * s;
      this.model.legs.forEach((l) => (l.rotation.x *= 0.9));
    } else {
      root.position.y = 0;
      root.rotation.x = 0;
    }

    // Facing
    root.position.x = this.position.x;
    root.position.z = this.position.z;
    if (this.state !== 'death') root.rotation.y = this.yaw;

    // Animation: limbs
    const walkRate = 5.5 * (this.moveSpeed / Math.max(this.wanderSpeed, 0.1));
    this.walkPhase = (this.walkPhase || 0) + dt * Math.min(walkRate, 9);
    const legSwing = this.moveSpeed > 0.1 ? Math.sin(this.walkPhase) * 0.7 : 0;
    this.model.legs[0].rotation.x = legSwing;
    this.model.legs[1].rotation.x = -legSwing;

    const [armL, armR] = this.model.arms;
    if (this.state === 'attack') {
      // Raise both arms during the windup, then slam down.
      const t = Math.min(1, this.stateTime / Math.max(this.attackWindup || 0.4, 0.05));
      const raise = -2.1 * Math.min(1, t * 1.4);
      const slam = t >= 1 ? 0.6 : 0;
      armL.rotation.x = raise + slam;
      armR.rotation.x = raise + slam;
      this.model.body.rotation.x = t >= 1 ? 0.12 : 0;
    } else {
      const armSwing = this.moveSpeed > 0.1 ? -Math.sin(this.walkPhase) * 0.5 : 0;
      const base = pal.pose === 'lean' ? -0.6 : pal.pose === 'shamble' ? -0.35 : -0.15;
      armL.rotation.x = base + armSwing;
      armR.rotation.x = base - armSwing;
      if (this.state !== 'hurt') this.model.body.rotation.x = pal.pose === 'lean' ? 0.22 : 0;
    }

    if (this.state === 'hurt') {
      const f = Math.max(0, this.hurtTimer / HURT_TIME);
      this.model.body.rotation.x = -0.25 * f;
      this.hurtTimer -= dt;
    }

    // Damage flash
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    const flashOn = this.flashTimer > 0;
    for (const key of Object.keys(this.model.materials)) {
      const m = this.model.materials[key];
      if (m.emissive && key !== 'glow') m.emissive.setHex(flashOn ? 0x8a0000 : 0x000000);
    }

    // Health bar
    this.barTimer = Math.max(0, this.barTimer - dt);
    this.updateHealthBar(camera);

    root.updateMatrixWorld(true);
  }

  updateHealthBar(camera) {
    const bar = this.healthBar;
    const show = this.isTargetable() && (this.barTimer > 0 || this.targeted);
    bar.visible = show;
    if (!show) return;
    bar.position.set(this.position.x, this.type.height + 0.45, this.position.z);
    if (camera) bar.quaternion.copy(camera.quaternion);
    const frac = this.health / this.maxHealth;
    const fg = bar.userData.fg;
    fg.scale.x = Math.max(0.001, 0.86 * frac);
    fg.position.x = -0.43 + (0.86 * frac) / 2;
  }

  /** World-space hitboxes used by the weapon raycaster. */
  getHitboxes() {
    return [this.model.hitboxes.body, this.model.hitboxes.head];
  }

  /** Removes the visuals from the scene and returns the body materials to the pool. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.model.root);
    this.scene.remove(this.healthBar);
    releaseBodyMaterials(this.typeId, this.model.materials);
  }
}
