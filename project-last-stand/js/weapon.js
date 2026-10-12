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
 *
 * Every weapon is described by a plain data block in `WEAPON_DEFS`;
 * `validateWeaponDef()` is the schema check the test suite runs over all of
 * them, and the numbers it derives (`sustainedDps()`) are the balance
 * guardrails. The five keys 1-5 are no longer hard-wired to weapon ids: they
 * index `loadout`, an array of ids built by `sanitizeLoadout()` and persisted
 * with the settings.
 */
import * as THREE from 'three';
import { raycastBoxes } from './collision.js';
import { createGlowTexture } from './textures.js';
import { mergeMeshesByMaterial } from './level.js';
import { MeleeViewmodel, swingTimeline } from './meleeAnim.js';

export const WEAPON_DEFS = {
  rifle: {
    id: 'rifle',
    category: 'firearm',
    name: 'MX-7 ASSAULT RIFLE',
    shortName: 'RIFLE',      // HUD slot label
    slot: 1,                 // default slot; `loadout` may move it
    ammoKind: 'rifle',       // which pickups refill it (see AMMO_PICKUP)
    unlockWave: 1,           // earliest wave the loadout screen may offer it
    moveSpeedMult: 1,        // hold-speed multiplier while it is drawn
    adsZoom: 1.25,           // aimed FOV multiplier (reserved: not wired yet)
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
    shortName: 'SHOTGUN',
    slot: 2,
    ammoKind: 'shell',
    unlockWave: 1,
    moveSpeedMult: 1,
    adsZoom: 1,
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
  smg: {
    id: 'smg',
    category: 'firearm',
    name: 'S-9 VIPER SMG',
    shortName: 'SMG',
    slot: 1,                 // shares slot 1 with the rifle: both are "the close one"
    ammoKind: 'rifle',
    unlockWave: 1,
    moveSpeedMult: 1,
    adsZoom: 1.15,
    damage: 15,
    headshotMultiplier: 1.6, // less rewarding than a rifle round: it is a spray gun
    fireRate: 14,
    auto: true,
    magazineSize: 35,
    startReserve: 210,
    maxReserve: 420,
    reloadTime: 1.6,
    reloadMode: 'magazine',
    switchTime: 0.3,         // fastest draw in the game
    pellets: 1,
    spread: 0.014,
    bloomPerShot: 0.006,     // heavy bloom: the first rounds are the accurate ones
    maxBloom: 0.055,
    bloomDecay: 4.5,
    range: 70,
    falloff: { start: 16, end: 45, min: 0.5 }, // close-mid weapon: half damage past 45 m
    recoil: { pitch: 0.008, yaw: 0.005, kick: 0.03, trauma: 0.1 },
    tracer: true,
    sound: 'smg',
  },
  dmr: {
    id: 'dmr',
    category: 'firearm',
    name: 'MKR-1 MARKSMAN',
    shortName: 'MARKSMAN',
    slot: 2,                 // the long-range alternative to the shotgun
    ammoKind: 'rifle',
    unlockWave: 1,
    moveSpeedMult: 1,
    adsZoom: 2.2,
    damage: 68,
    headshotMultiplier: 2.5,
    fireRate: 2.2,
    auto: false,
    magazineSize: 12,
    startReserve: 72,
    maxReserve: 144,
    reloadTime: 2.4,
    reloadMode: 'magazine',
    switchTime: 0.65,
    pellets: 1,
    spread: 0.0035,
    bloomPerShot: 0.006,
    maxBloom: 0.02,
    bloomDecay: 6,
    range: 200,              // long lanes across the whole facility
    falloff: null,           // a marksman round does not care about distance
    penetration: 1,          // keeps going through one body at 60% damage
    recoil: { pitch: 0.03, yaw: 0.006, kick: 0.08, trauma: 0.3 },
    tracer: true,
    sound: 'dmr',
  },
  knife: {
    id: 'knife',
    category: 'melee',
    name: 'FIELD KNIFE',
    shortName: 'KNIFE',
    slot: 3,
    unlockWave: 1,
    moveSpeedMult: 1,
    damage: 44,
    reach: 1.65,
    arcDegrees: 14,
    rayCount: 1,
    maxTargets: 1,
    hitTime: 0.11,
    attackDuration: 0.42,
    attackCooldown: 0.48,
    switchTime: 0.36,
    // Animation timing (seconds): wind-up ends, strike ends, active hit window =
    // [hitTime, hitTime + activeTime]. The blade reaches its impact pose mid-window.
    swing: 'slash',
    windup: 0.07,
    strikeEnd: 0.22,
    activeTime: 0.08,
    trailColor: 0xbfe6ff,
  },
  pipe: {
    id: 'pipe',
    category: 'melee',
    name: 'STEEL PIPE',
    shortName: 'PIPE',
    slot: 4,
    unlockWave: 1,
    moveSpeedMult: 1,
    damage: 52,
    reach: 1.9,
    arcDegrees: 42,
    rayCount: 5,
    maxTargets: 2,
    hitTime: 0.2,
    attackDuration: 0.62,
    attackCooldown: 0.72,
    switchTime: 0.4,
    swing: 'slash',
    windup: 0.14,
    strikeEnd: 0.4,
    activeTime: 0.16,
    trailColor: 0xffe0a0,
  },
  axe: {
    id: 'axe',
    category: 'melee',
    name: 'FIRE AXE',
    shortName: 'AXE',
    slot: 5,
    unlockWave: 1,
    moveSpeedMult: 1,
    damage: 95,
    reach: 2.05,
    arcDegrees: 30,
    rayCount: 3,
    maxTargets: 1,
    hitTime: 0.31,
    attackDuration: 0.94,
    attackCooldown: 1.08,
    switchTime: 0.48,
    swing: 'chop',
    windup: 0.22,
    strikeEnd: 0.56,
    activeTime: 0.2,
    trailColor: 0xffa860,
  },
};

/** Slot order is stable: rifle and shotgun keep their existing keys. */
export const WEAPON_ORDER = ['rifle', 'shotgun', 'knife', 'pipe', 'axe'];

/**
 * Slots 1-5 are data now: keys 1-5 select `loadout[i]`, so a new weapon does
 * not need a new key or a HUD edit. The default is today's fixed order.
 */
export const SLOT_COUNT = WEAPON_ORDER.length;

/** Category each slot accepts; the loadout screen and sanitizeLoadout() share it. */
export const SLOT_CATEGORIES = Object.freeze(['firearm', 'firearm', 'melee', 'melee', 'melee']);

export const DEFAULT_LOADOUT = Object.freeze([...WEAPON_ORDER]);

/** Firearms only; melee weapons never consume or receive ammunition. */
export const AMMO_PICKUP = {
  rifle: 45,
  shotgun: 10,
  smg: 90,     // cheap, small rounds: pickups top the Viper up quickly
  dmr: 24,     // marksman rounds are the reason the DMR is not the default gun
};

/** Every weapon that can be picked in a loadout, in catalogue order. */
export const WEAPON_IDS = Object.freeze(Object.keys(WEAPON_DEFS));

/**
 * True for a weapon id that exists and belongs in `category` (used to keep a
 * firearm out of a melee slot and the other way round).
 */
function fitsSlot(id, category) {
  const def = WEAPON_DEFS[id];
  return !!def && (category ? def.category === category : true);
}

/**
 * Coerces anything into a usable 5-slot loadout: unknown ids, duplicates,
 * weapons in the wrong category and missing entries all fall back to `base`
 * (or to the first legal weapon for that slot).
 *
 * @param {unknown} input    array of weapon ids, possibly short or bogus
 * @param {string[]} [base]  loadout to fall back to, defaults to the standard one
 * @returns {string[]}       a new array of exactly SLOT_COUNT valid ids
 */
export function sanitizeLoadout(input, base = DEFAULT_LOADOUT) {
  const fallback = Array.isArray(base) && base.length === SLOT_COUNT ? base : DEFAULT_LOADOUT;
  const used = new Set();
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const category = SLOT_CATEGORIES[i];
    const wanted = Array.isArray(input) ? input[i] : null;
    const pick = [wanted, fallback[i]]
      .find((id) => fitsSlot(id, category) && !used.has(id))
      ?? WEAPON_IDS.find((id) => WEAPON_DEFS[id].category === category && !used.has(id))
      ?? fallback[i];
    out.push(pick);
    used.add(pick);
  }
  return out;
}

/** HUD labels for a loadout: `['1 RIFLE', '2 SHOTGUN', ...]`, key = index + 1. */
export function hudSlotLabels(loadout = DEFAULT_LOADOUT) {
  return loadout.map((id, i) => `${i + 1} ${WEAPON_DEFS[id]?.shortName ?? WEAPON_DEFS[id]?.name ?? id}`);
}

/**
 * What the loadout screen may offer per slot: one entry per key, with the legal
 * weapons for that category. Built from WEAPON_DEFS so a new gun only needs a
 * def to appear in the menu.
 */
export function loadoutSlotOptions() {
  return SLOT_CATEGORIES.map((category, index) => ({
    index,
    category,
    name: `SLOT ${index + 1} - ${category === 'firearm' ? 'FIREARM' : 'MELEE'}`,
    options: WEAPON_IDS.filter((id) => WEAPON_DEFS[id].category === category)
      .map((id) => ({ id, name: WEAPON_DEFS[id].name, unlockWave: WEAPON_DEFS[id].unlockWave })),
  }));
}

/* ------------------------------------------------------------------ *
 * Schema + balance helpers (pure: no three.js, no game state)
 * ------------------------------------------------------------------ */

/** Fields every def must provide, per category, by type. */
const REQUIRED_FIELDS = {
  firearm: {
    number: ['damage', 'headshotMultiplier', 'fireRate', 'magazineSize', 'startReserve', 'maxReserve',
      'reloadTime', 'switchTime', 'pellets', 'spread', 'range', 'bloomPerShot', 'maxBloom', 'bloomDecay',
      'unlockWave', 'moveSpeedMult', 'adsZoom'],
    string: ['name', 'shortName', 'ammoKind', 'reloadMode', 'sound'],
    boolean: ['auto'],
    object: ['recoil'],
  },
  melee: {
    number: ['damage', 'reach', 'arcDegrees', 'rayCount', 'maxTargets', 'hitTime', 'attackDuration',
      'attackCooldown', 'switchTime', 'unlockWave', 'moveSpeedMult'],
    string: ['name', 'shortName', 'swing'],
    boolean: [],
    object: [],
  },
};

/** Fields that only make sense for one category and must be absent from the other. */
const CATEGORY_ONLY_FIELDS = {
  firearm: ['magazineSize', 'startReserve', 'maxReserve', 'reloadTime', 'reloadMode', 'ammoKind',
    'auto', 'pellets', 'spread', 'bloomPerShot', 'maxBloom', 'bloomDecay', 'recoil', 'falloff',
    'headshotMultiplier', 'penetration', 'adsZoom', 'tracer', 'sound'],
  melee: ['reach', 'arcDegrees', 'rayCount', 'maxTargets', 'hitTime', 'attackDuration',
    'swing', 'windup', 'strikeEnd', 'activeTime', 'trailColor'],
};

export const AMMO_KINDS = Object.freeze(['rifle', 'shell', 'heavy', 'explosive']);

/**
 * Checks one weapon def against the schema. Pure, so the test suite can run it
 * over every def (and over deliberately broken ones) without a browser.
 *
 * Cross-def rules (slot uniqueness) need the whole table: they compare `def`
 * with the other weapons that share the *default* loadout, because a loadout
 * holds exactly one weapon per key while two weapons may declare the same
 * preferred slot (the S-9 and the MX-7 both default to slot 1).
 *
 * @param {object} def                 weapon definition
 * @param {object} [allDefs]           whole table, defaults to WEAPON_DEFS
 * @param {string[]} [loadout]         default loadout, defaults to DEFAULT_LOADOUT
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateWeaponDef(def, allDefs = WEAPON_DEFS, loadout = DEFAULT_LOADOUT) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (!def || typeof def !== 'object') return { valid: false, errors: ['def must be an object'] };

  const id = def.id;
  if (typeof id !== 'string' || id.length === 0) fail('id must be a non-empty string');
  const category = def.category;
  if (category !== 'firearm' && category !== 'melee') {
    fail(`category must be 'firearm' or 'melee' (got ${String(category)})`);
    return { valid: false, errors };
  }

  const schema = REQUIRED_FIELDS[category];
  for (const field of schema.number) {
    const value = def[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be a finite number`);
  }
  for (const field of schema.string) {
    if (typeof def[field] !== 'string' || def[field].length === 0) fail(`${field} must be a non-empty string`);
  }
  for (const field of schema.boolean) {
    if (typeof def[field] !== 'boolean') fail(`${field} must be a boolean`);
  }
  for (const field of schema.object) {
    if (!def[field] || typeof def[field] !== 'object') fail(`${field} must be an object`);
  }

  // Positive-value rules.
  if (!(def.damage > 0)) fail('damage must be greater than 0');
  if (!(def.switchTime > 0)) fail('switchTime must be greater than 0');
  if (def.unlockWave < 1) fail('unlockWave must be at least 1');
  if (!(def.moveSpeedMult > 0)) fail('moveSpeedMult must be greater than 0');

  if (category === 'firearm') {
    if (!(def.reloadTime > 0)) fail('reloadTime must be greater than 0');
    if (!(def.fireRate > 0)) fail('fireRate must be greater than 0');
    if (!(def.magazineSize >= 1)) fail('magazineSize must be at least 1');
    if (!(def.startReserve >= def.magazineSize)) fail('startReserve must be >= magazineSize');
    if (!(def.maxReserve >= def.startReserve)) fail('maxReserve must be >= startReserve');
    if (!(def.pellets >= 1)) fail('pellets must be at least 1');
    if (!(def.spread >= 0) || !(def.spread < Math.PI / 2)) fail('spread must be a small non-negative angle');
    if (!(def.range > 0)) fail('range must be greater than 0');
    if (!AMMO_KINDS.includes(def.ammoKind)) fail(`ammoKind must be one of ${AMMO_KINDS.join(', ')}`);
    if (def.reloadMode !== 'magazine' && def.reloadMode !== 'shell') fail("reloadMode must be 'magazine' or 'shell'");
    if (!(def.headshotMultiplier > 1)) fail('headshotMultiplier must be greater than 1');
    if (def.penetration !== undefined && !(Number.isInteger(def.penetration) && def.penetration >= 0)) {
      fail('penetration must be a non-negative integer when present');
    }
    if (def.falloff) {
      if (!(def.falloff.start >= 0 && def.falloff.end > def.falloff.start)) fail('falloff end must be past its start');
      if (!(def.falloff.min > 0 && def.falloff.min <= 1)) fail('falloff min must be in (0, 1]');
    }
  } else {
    if (!(def.hitTime >= 0 && def.hitTime < def.attackDuration)) fail('hitTime must be inside the attack');
    if (!(def.attackCooldown >= def.attackDuration)) fail('attackCooldown must outlast attackDuration');
    if (!(def.reach > 0 && def.arcDegrees > 0)) fail('reach and arcDegrees must be greater than 0');
    if (!(def.rayCount >= 1 && def.maxTargets >= 1)) fail('rayCount and maxTargets must be at least 1');
  }

  // A def may not mix firearm and melee fields: that is how "melee has no ammo"
  // and "a firearm has no reach" stay true without special cases elsewhere.
  for (const field of CATEGORY_ONLY_FIELDS[category === 'firearm' ? 'melee' : 'firearm']) {
    if (def[field] !== undefined) fail(`${category} defs must not define ${field}`);
  }

  // Slot sanity + uniqueness inside the default loadout.
  if (!Number.isInteger(def.slot) || def.slot < 1 || def.slot > SLOT_COUNT) {
    fail(`slot must be an integer in 1..${SLOT_COUNT}`);
  } else if (SLOT_CATEGORIES[def.slot - 1] !== category) {
    fail(`slot ${def.slot} is a ${SLOT_CATEGORIES[def.slot - 1]} slot, not ${category}`);
  } else if (loadout.includes(id)) {
    for (const otherId of loadout) {
      if (otherId === id) continue;
      const other = allDefs[otherId];
      if (other && other.slot === def.slot) fail(`slot ${def.slot} is already used by ${otherId} in the default loadout`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates the whole table (ids matching their keys) and returns a report.
 * @returns {{valid: boolean, errors: string[]}} errors are prefixed with the weapon id
 */
export function validateWeaponDefs(allDefs = WEAPON_DEFS, loadout = DEFAULT_LOADOUT) {
  const errors = [];
  for (const [key, def] of Object.entries(allDefs)) {
    if (def.id !== key) errors.push(`${key}: id does not match its key (${String(def.id)})`);
    for (const error of validateWeaponDef(def, allDefs, loadout).errors) errors.push(`${key}: ${error}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Seconds to empty a full magazine and load the next one.
 * Shell reloads insert one round at a time, so the whole tube takes
 * `reloadTime * magazineSize`; magazine reloads are a single `reloadTime`.
 */
export function magazineCycleTime(def) {
  if (def.category !== 'firearm') return 0;
  const emptyTime = def.magazineSize / def.fireRate;
  const reload = def.reloadMode === 'shell' ? def.reloadTime * def.magazineSize : def.reloadTime;
  return emptyTime + reload;
}

/** Damage a full magazine can deal to one body, ignoring falloff and headshots. */
export function magazineDamage(def) {
  return def.category === 'firearm' ? def.damage * def.pellets * def.magazineSize : 0;
}

/**
 * Sustained damage per second: a full magazine (all pellets on one body) over
 * the time it takes to empty it and reload. This is the number the balance
 * test bands; shotguns beat it in the first second of a fight, which is the
 * whole point of a shotgun.
 */
export function sustainedDps(def) {
  const cycle = magazineCycleTime(def);
  return cycle > 0 ? magazineDamage(def) / cycle : 0;
}

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
    this.attackFacing = 'right';
    this.struck = new Set(); // enemies already hit by the current swing
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
  return {
    group,
    // The knife grip is centred on the group origin, which is the hand socket.
    grip: new THREE.Vector3(0, 0, 0),
    trail: { base: new THREE.Vector3(0, 0.035, -0.02), tip: new THREE.Vector3(0, 0.035, -0.27) },
  };
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
  return {
    group,
    grip: new THREE.Vector3(0, 0, 0.13),
    trail: { base: new THREE.Vector3(0, 0, -0.02), tip: new THREE.Vector3(0, 0, -0.32) },
  };
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
  return {
    group,
    grip: new THREE.Vector3(0.015, -0.01, 0.19),
    trail: { base: new THREE.Vector3(0.03, 0.035, -0.215), tip: new THREE.Vector3(-0.21, 0.035, -0.215) },
  };
}

/**
 * Parametric firearm viewmodel.
 *
 * The rifle and shotgun were hand-placed part by part; every gun after them is
 * a spec table for this builder instead: a receiver plus optional primitives
 * (barrel, handguard, magazine, stock, grip, rail, sight, accents) described as
 * plain numbers. Parts are merged per material like the hand-built models, so a
 * gun with 15 primitives is still a handful of draw calls.
 *
 * @param {object} spec
 * @param {object} spec.colors            {body, frame, accent} hex colours
 * @param {object} spec.receiver          {w,h,d,x?,y?,z?} main body box
 * @param {Array}  [spec.barrels]         cylinders along -Z: {r0,r1,len,x?,y?,z?,color?}
 *                                        (r0 = radius at the receiver, r1 = at the muzzle)
 * @param {Array}  [spec.boxes]           extra boxes: {w,h,d,x?,y?,z?,rx?,rz?,color?}
 * @param {object} [spec.muzzle]          {x?,y?,z?} muzzle marker; the flash sprite hangs on it
 * @returns {{group: THREE.Group, muzzle: THREE.Object3D, barrelLength: number}}
 */
function buildParametricFirearm(spec) {
  const group = new THREE.Group();
  const colors = { body: 0x23282f, frame: 0x1a1d21, accent: 0xb71c1c, ...spec.colors };
  const materials = {
    body: mat(colors.body, { roughness: 0.45, metalness: 0.7 }),
    frame: mat(colors.frame, { roughness: 0.85, metalness: 0.05 }),
    accent: mat(colors.accent, { roughness: 0.45, metalness: 0.25 }),
  };

  const rec = spec.receiver;
  const body = box(rec.w, rec.h, rec.d, materials.body);
  body.position.set(rec.x || 0, rec.y || 0, rec.z || 0);
  group.add(body);

  for (const b of spec.barrels || []) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(b.r0, b.r1, b.len, 10), materials[b.color || 'body']);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(b.x || 0, b.y || 0, b.z || 0);
    group.add(barrel);
  }
  for (const p of spec.boxes || []) {
    const part = box(p.w, p.h, p.d, materials[p.color || 'frame']);
    part.position.set(p.x || 0, p.y || 0, p.z || 0);
    if (p.rx) part.rotation.x = p.rx;
    if (p.rz) part.rotation.z = p.rz;
    group.add(part);
  }

  mergeMeshesByMaterial(group);
  const muzzle = new THREE.Object3D();
  const m = spec.muzzle || {};
  muzzle.position.set(m.x || 0, m.y || 0, m.z ?? -(rec.d / 2 + 0.1));
  group.add(muzzle);
  return { group, muzzle, barrelLength: Math.abs(muzzle.position.z) };
}

/** S-9 VIPER: stubby, suppressed, a long magazine and a red stripe on the rail. */
function buildSmgModel() {
  return buildParametricFirearm({
    colors: { body: 0x272d35, frame: 0x191c20, accent: 0xc2321f },
    receiver: { w: 0.072, h: 0.095, d: 0.3 },
    barrels: [
      { r0: 0.013, r1: 0.012, len: 0.16, y: 0.005, z: -0.22 },  // barrel
      { r0: 0.021, r1: 0.02, len: 0.1, y: 0.005, z: -0.3 },     // stubby suppressor
    ],
    boxes: [
      { w: 0.062, h: 0.05, d: 0.14, y: -0.004, z: -0.2 },              // handguard
      { w: 0.026, h: 0.026, d: 0.24, y: 0.062, z: -0.03, color: 'body' }, // top rail
      { w: 0.028, h: 0.05, d: 0.028, y: 0.1, z: -0.06 },               // front sight
      { w: 0.05, h: 0.16, d: 0.058, y: -0.15, z: 0.01, rx: 0.16 },     // magazine
      { w: 0.05, h: 0.1, d: 0.05, y: -0.1, z: 0.095, rx: -0.3 },       // grip
      { w: 0.046, h: 0.055, d: 0.15, y: -0.005, z: 0.19 },             // folded stock
      { w: 0.074, h: 0.01, d: 0.14, y: 0.026, z: -0.12, color: 'accent' }, // viper stripe
    ],
    muzzle: { x: 0, y: 0.005, z: -0.37 },
  });
}

/** MKR-1 MARKSMAN: long heavy barrel, big scope, wooden-toned stock and rail. */
function buildDmrModel() {
  return buildParametricFirearm({
    colors: { body: 0x232a2a, frame: 0x151819, accent: 0x8a6b2b },
    receiver: { w: 0.07, h: 0.105, d: 0.42 },
    barrels: [
      { r0: 0.015, r1: 0.012, len: 0.34, y: 0.008, z: -0.37 },  // heavy barrel
      { r0: 0.022, r1: 0.019, len: 0.06, y: 0.008, z: -0.56 },  // muzzle brake
      { r0: 0.026, r1: 0.026, len: 0.26, y: 0.098, z: -0.03 },  // scope tube
      { r0: 0.02, r1: 0.024, len: 0.04, y: 0.098, z: -0.17 },   // objective bell
    ],
    boxes: [
      { w: 0.068, h: 0.07, d: 0.26, y: -0.006, z: -0.28 },           // handguard
      { w: 0.03, h: 0.03, d: 0.34, y: 0.072, z: -0.02, color: 'body' }, // rail
      { w: 0.028, h: 0.05, d: 0.05, y: 0.062, z: -0.12 },            // front scope mount
      { w: 0.028, h: 0.05, d: 0.05, y: 0.062, z: 0.08 },             // rear scope mount
      { w: 0.05, h: 0.14, d: 0.08, y: -0.12, z: -0.04, rx: 0.08 },   // magazine
      { w: 0.05, h: 0.12, d: 0.055, y: -0.11, z: 0.12, rx: -0.3 },   // grip
      { w: 0.058, h: 0.09, d: 0.3, y: -0.012, z: 0.33, rx: -0.04 },  // butt stock
      { w: 0.06, h: 0.03, d: 0.09, y: 0.045, z: 0.28 },              // cheek rest
      { w: 0.072, h: 0.01, d: 0.2, y: 0.032, z: -0.1, color: 'accent' }, // brass accent
    ],
    muzzle: { x: 0, y: 0.008, z: -0.6 },
  });
}

/** Damage each body behind the first takes, compounding: 60%, then 36%. */
export const PENETRATION_DAMAGE_MULT = 0.6;

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

/**
 * One viewmodel factory per weapon id. Built once per WeaponSystem and shared
 * by every loadout, so switching guns never builds geometry and
 * Game.prewarmShaders() can compile the guns that are not even carried.
 */
const VIEWMODEL_BUILDERS = {
  rifle: buildRifleModel,
  shotgun: buildShotgunModel,
  smg: buildSmgModel,
  dmr: buildDmrModel,
  knife: buildKnifeModel,
  pipe: buildPipeModel,
  axe: buildAxeModel,
};

export class WeaponSystem {
  /**
   * @param {object} opts
   * @param {THREE.PerspectiveCamera} opts.camera  must be in the scene (viewmodels are its children)
   * @param {import('./audio.js').AudioManager} opts.audio
   * @param {import('./effects.js').EffectsManager} opts.effects
   * @param {import('./player.js').Player} opts.player
   * @param {string[]} [opts.loadout]  weapon id per key (1-5); sanitized, defaults to WEAPON_ORDER
   * @param {object} opts.hooks  onShot(def), onEnemyHit({enemy,damage,headshot,point,distance,weapon}) -> {killed},
   *                             onSwitch(def), onReload(def), onMessage(text)
   */
  constructor({ camera, audio, effects, player, loadout, hooks = {} }) {
    this.camera = camera;
    this.audio = audio;
    this.effects = effects;
    this.player = player;
    this.hooks = hooks;

    this.index = 0;
    this.switchTimer = 0;
    this.bloom = 0;
    this.aimAmount = 0;
    this.viewKick = 0;
    this.flashTimer = 0;
    this.shotCount = 0;

    // Melee weapons are held by the first-person arm rig; firearms stay on the camera.
    this.melee = new MeleeViewmodel(camera);
    this.viewmodelVisible = true;

    this.viewmodels = new Map(WEAPON_IDS.map((id) => [id, VIEWMODEL_BUILDERS[id]?.() ?? null]));
    for (const m of this.viewmodels.values()) {
      if (!m) continue;
      m.group.visible = false;
      m.group.position.set(0.24, -0.24, -0.42);
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

    this.loadout = [];
    this.states = [];
    this.models = [];
    this.setLoadout(loadout);

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

  /**
   * Rebuilds the slots for a new loadout. Only safe between runs (menu/pause):
   * ammo and the drawn weapon are reset, which a mid-fight swap must not do.
   * @param {string[]} loadout  weapon id per key, sanitized against the current loadout
   */
  setLoadout(loadout) {
    this.loadout = sanitizeLoadout(loadout, this.loadout);
    this.states = this.loadout.map((id) => new WeaponState(WEAPON_DEFS[id]));
    this.index = 0;
    this.switchTimer = 0;
    this.bloom = 0;
    this.aimAmount = 0;
    this.viewKick = 0;
    this.flashTimer = 0;
    this.shotCount = 0;
    this.melee.reset();
    this.bindModels();
  }

  /** Points the slot list at the viewmodels of the current loadout. */
  bindModels() {
    this.models = this.loadout.map((id) => this.viewmodels.get(id));
    this.models.forEach((_, i) => this.attachModel(i));
    this.syncVisibility();
  }

  reset() {
    for (const s of this.states) s.reset();
    this.index = 0;
    this.switchTimer = 0;
    this.bloom = 0;
    this.aimAmount = 0;
    this.viewKick = 0;
    this.flashTimer = 0;
    this.melee.reset();
    this.viewmodelVisible = true;
    // Every viewmodel, not just the carried ones: a gun may have flashed before
    // a loadout change and must not come back with a stuck muzzle flash.
    for (const m of this.viewmodels.values()) {
      if (m?.flash) {
        m.flash.visible = false;
        m.flash.material.opacity = 0;
      }
    }
    this.models.forEach((_, i) => this.attachModel(i));
    this.syncVisibility();
  }

  /**
   * Parents a viewmodel to the right place: melee weapons go to the hand socket
   * of the arm rig (so they cannot detach from the hand), firearms to the camera.
   */
  attachModel(index) {
    const m = this.models[index];
    const def = this.states[index].def;
    if (def.category === 'melee') {
      this.melee.socket.add(m.group);
      m.group.position.copy(m.grip).negate(); // the grip point sits on the hand socket
      m.group.rotation.set(0, 0, 0);
    } else {
      this.camera.add(m.group);
      m.group.position.set(0.24, -0.24, -0.42);
    }
  }

  /** Shows the current weapon (and the arm, for melee) only while the viewmodel is visible. */
  syncVisibility() {
    const visible = this.viewmodelVisible;
    this.models.forEach((m, i) => (m.group.visible = visible && i === this.index));
    this.melee.setVisible(visible && this.def.category === 'melee');
  }

  /** Switches by slot index: key `index + 1`, whatever `loadout[index]` is. */
  requestSwitch(index) {
    if (index < 0 || index >= this.states.length || index === this.index) return false;
    const old = this.state;
    old.reloading = false;
    old.attacking = false;
    old.attackTimer = 0;
    old.attackHit = false;
    old.struck.clear();
    this.flashTimer = 0;
    this.melee.reset();
    this.index = index;
    this.attachModel(index);
    this.syncVisibility();
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
    this.viewmodelVisible = visible;
    this.syncVisibility();
  }

  /** Releases procedural viewmodel GPU resources when the game is disposed. */
  dispose() {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    this.melee.dispose();
    for (const model of this.viewmodels.values()) {
      if (!model) continue;
      model.group.removeFromParent();
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
      // A weapon without a pickup value simply keeps its reserve (every firearm
      // has one today - the schema test enforces it).
      const amount = AMMO_PICKUP[st.def.id];
      if (!amount) continue;
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
      this.updateMelee(dt, input, ctx);
    } else if (ctx.canFire) {
      if (input.reloadPressed) this.startReload();
      const wantsFire = st.def.auto ? input.fireHeld : input.firePressed;
      if (wantsFire) this.tryFire(ctx);
    }

    if (isMelee) this.updateMeleeViewmodel(dt, ctx);
    else this.updateViewmodel(ctx);
    this.updateMuzzleFlash();
  }

  /**
   * Melee state machine: one swing at a time, edge-triggered, with a cooldown.
   * Inputs: firePressed (left mouse) or attackPressed (Space) start a swing.
   */
  updateMelee(dt, input, ctx) {
    if (!ctx.canFire) {
      this.cancelMeleeAttack();
      return;
    }
    if (this.state.attacking) this.advanceMeleeAttack(dt, ctx);
    // Holding the button or Space never repeats a swing.
    if (input.firePressed || input.attackPressed) this.tryMeleeAttack(input.facing);
  }

  /** Moves the swing timer forward, runs hit detection in the active window and ends the swing. */
  advanceMeleeAttack(dt, ctx) {
    const st = this.state;
    const def = st.def;
    const tl = swingTimeline(def);
    const prev = st.attackTimer;
    const next = Math.min(tl.end, prev + dt);
    st.attackTimer = next;

    // Lunge: the camera dips a touch as the strike begins.
    if (prev < tl.windup && next >= tl.windup) this.player.addRecoil(-0.012, 0);

    // The blade is only dangerous during its active window. Each frame that overlaps the
    // window sweeps again, but an enemy already in st.struck is never hit twice in one swing.
    const winStart = def.hitTime;
    const winEnd = def.hitTime + def.activeTime;
    if (next >= winStart && prev < winEnd) {
      const before = st.struck.size;
      this.resolveMeleeAttack(def, ctx, st.struck);
      if (st.struck.size > before) {
        st.attackHit = true;
        this.melee.onImpact();
        this.player.addRecoil(-0.02, 0);
        this.player.addTrauma(0.12);
      }
    }

    if (next >= tl.end) this.endMeleeAttack();
  }

  endMeleeAttack() {
    const st = this.state;
    st.attacking = false;
    st.attackTimer = 0;
    st.attackHit = false;
    st.struck.clear();
  }

  cancelMeleeAttack() {
    this.endMeleeAttack();
    this.melee.reset();
  }

  /** Viewmodel update for the arm rig: pose, body recoil and blade trail. */
  updateMeleeViewmodel(dt, ctx) {
    const st = this.state;
    this.melee.update(dt, {
      def: st.def,
      attacking: st.attacking,
      timer: st.attackTimer,
      facing: st.attackFacing,
      weapon: this.models[this.index],
      bobPhase: ctx.bobPhase,
      speedFactor: ctx.speedFactor,
      switchT: this.switchTimer > 0 ? this.switchTimer / st.def.switchTime : 0,
    });
  }

  /**
   * Starts one melee swing. `facing` picks the swing side: 'right' is a forehand
   * (wind-up on the right, cut to the left), 'left' is a backhand (mirrored).
   */
  tryMeleeAttack(facing = 'right') {
    const st = this.state;
    if (st.def.category !== 'melee' || this.switchTimer > 0 || st.cooldown > 0 || st.attacking) return false;
    st.attacking = true;
    st.attackTimer = 0;
    st.attackHit = false;
    st.attackFacing = facing === 'left' ? 'left' : 'right';
    st.struck.clear();
    st.cooldown = st.def.attackCooldown;
    this.audio.playMeleeSwing(st.def.id);
    return true;
  }

  /**
   * Applies a short forward fan of melee rays, stopped by the first world collider.
   * Enemies already in `struck` are skipped, so one swing never hits the same enemy twice.
   */
  resolveMeleeAttack(def, ctx, struck) {
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

    const arc = THREE.MathUtils.degToRad(def.arcDegrees);
    const count = Math.max(1, def.rayCount);
    for (let i = 0; i < count && struck.size < def.maxTargets; i++) {
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
        if (!enemy || !enemy.isTargetable() || struck.has(enemy)) continue;
        struck.add(enemy);
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
        break; // One target per ray; `struck` also prevents multi-ray double hits.
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
      results.push(this.traceRay(origin, dir, def.range, ctx, hitboxes, def.penetration || 0));
    }

    // Resolve hits. Each enemy gets at most one blood burst per shot.
    const burstEnemies = new Set();
    let impacts = 0;
    let hitAnything = false;
    for (const res of results) {
      if (res.type === 'enemy') {
        hitAnything = true;
        this.resolveEnemyHit(def, res, 1, burstEnemies);
        // A penetrating round keeps going at a fraction of its damage
        // (60%, then 36% if a weapon ever penetrates two bodies). Non-penetrating
        // weapons never build the array, so ordinary shots pay nothing for it.
        if (res.pierced) {
          for (let i = 0; i < res.pierced.length; i++) {
            this.resolveEnemyHit(def, res.pierced[i], PENETRATION_DAMAGE_MULT ** (i + 1), burstEnemies);
          }
        }
      }
      // Where the bullet actually stopped: the wall right behind a pierced
      // body gets the decal, and the tracer ends there too.
      const stop = res.behind || res;
      if (stop.type === 'world' && impacts < 3) {
        this.effects.spawnImpact(stop.point, stop.normal, stop.surface, stop.owner);
        impacts++;
      }
    }

    // Visual + audio feedback for the shot itself.
    const muzzle = this.models[this.index].muzzle.getWorldPosition(this._muzzle);
    if (def.tracer) {
      const end = results[0].behind ? results[0].behind.point : results[0].point;
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

  /**
   * Applies one enemy hit from a trace: falloff, headshot multiplier, the game's
   * damage hook, blood and the flesh-hit sound. One blood burst and one sound per
   * enemy per shot, however many pellets or pierced bodies were involved.
   *
   * @param {object} def         weapon def
   * @param {object} hit         a traceRay() enemy result
   * @param {number} scale       damage scale: 1 for the first body, less for pierced ones
   * @param {Set<object>} burstEnemies  enemies already reported for this shot
   */
  resolveEnemyHit(def, hit, scale, burstEnemies) {
    const falloff = this.falloffFor(def, hit.distance);
    const damage = def.damage * scale * falloff * (hit.headshot ? def.headshotMultiplier : 1);
    const outcome = this.hooks.onEnemyHit?.({
      enemy: hit.enemy,
      damage,
      headshot: hit.headshot,
      point: hit.point,
      distance: hit.distance,
      weapon: def.id,
    });
    if (!burstEnemies.has(hit.enemy)) {
      burstEnemies.add(hit.enemy);
      this.effects.spawnBlood(hit.point, hit.normal, hit.headshot ? 1.6 : 1);
      this.audio.playHitFlesh(hit.headshot);
    }
    if (outcome?.killed) this.effects.spawnBlood(hit.point, hit.normal, 2);
  }

  /** Damage multiplier for distance (shotgun falloff). */
  falloffFor(def, distance) {
    return computeFalloff(def, distance);
  }

  /**
   * Finds what a ray hits first: enemy hitbox, world box, floor/ceiling, or nothing.
   * Returns { type: 'enemy'|'world'|'miss', point, normal, distance, enemy?, headshot? }.
   *
   * `penetration` lets the ray keep going through that many extra enemy bodies
   * (the marksman round): the additional hits come back in `pierced`, and
   * whatever finally stopped the ray in `behind`, so the tracer and the wall
   * decal still land behind the bodies it went through.
   */
  traceRay(origin, dir, range, ctx, hitboxes, penetration = 0) {
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
    // The wall/floor result is only built when the ray is not stopped by a body,
    // so the ordinary single-hit path allocates exactly what it used to.
    const plane = planeT < Infinity ? { t: planeT, normal: planeNormal, surface } : null;

    // Enemy hitboxes (nearest targetable one that is closer than the wall).
    this.raycaster.set(origin, dir);
    this.raycaster.far = maxDist;
    const hits = this.raycaster.intersectObjects(hitboxes, false);

    if (penetration <= 0) {
      for (const hit of hits) {
        const enemy = hit.object.userData.enemy;
        if (!enemy || !enemy.isTargetable()) continue;
        return this.enemyHitResult(hit, dir);
      }
      return this.stopResult(origin, dir, range, worldHit, plane);
    }

    // Penetrating shot: walk the (distance-sorted) hits and keep one result per
    // enemy - a body and a head box belong to the same target, so they must not
    // both count as bodies to shoot through.
    const got = [];
    for (const hit of hits) {
      const enemy = hit.object.userData.enemy;
      if (!enemy || !enemy.isTargetable()) continue;
      if (got.some((result) => result.enemy === enemy)) continue;
      got.push(this.enemyHitResult(hit, dir));
      if (got.length > penetration) break;
    }
    if (got.length === 0) return this.stopResult(origin, dir, range, worldHit, plane);
    const primary = got[0];
    primary.pierced = got.slice(1);
    primary.behind = this.stopResult(origin, dir, range, worldHit, plane);
    return primary;
  }

  /** One enemy hit, in the shape a non-penetrating traceRay() returns. */
  enemyHitResult(hit, dir) {
    return {
      type: 'enemy',
      enemy: hit.object.userData.enemy,
      headshot: hit.object.name === 'hitbox-head',
      point: hit.point.clone(),
      normal: { x: -dir.x, y: -dir.y, z: -dir.z },
      distance: hit.distance,
    };
  }

  /**
   * Result for a ray that met no (further) targetable enemy: the world box, the
   * floor/ceiling plane, or nothing within range.
   *
   * @param {object} plane  floor/ceiling slab test {t, normal, surface}, or null
   */
  stopResult(origin, dir, range, worldHit, plane) {
    if (plane && plane.t <= (worldHit ? worldHit.distance : Infinity)) {
      const point = new THREE.Vector3(origin.x + dir.x * plane.t, origin.y + dir.y * plane.t, origin.z + dir.z * plane.t);
      // Floor and ceiling never move, so these marks have no owner.
      return { type: 'world', point, normal: plane.normal, distance: plane.t, surface: plane.surface, owner: null };
    }
    if (worldHit) {
      const p = worldHit.point;
      return {
        type: 'world',
        point: new THREE.Vector3(p.x, p.y, p.z),
        normal: worldHit.normal,
        distance: worldHit.distance,
        surface: worldHit.box.tag === 'wall' ? 'concrete' : 'metal',
        // The surface that owns the mark (a door panel) so its decals can be
        // culled the moment the surface slides away. Static boxes have none.
        owner: worldHit.box.owner || null,
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

    // Melee viewmodels are posed by the arm rig (meleeAnim.js), not here.
    if (st.def.category === 'melee') return;

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
      slot: this.index + 1, // the live key, not the def's default slot
      auto: st.def.auto,
    };
  }
}
