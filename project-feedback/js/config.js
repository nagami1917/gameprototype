/**
 * config.js
 * Tunables for PROTOCOL: FEEDBACK. Gameplay code reads these instead of
 * scattering magic numbers, so feel changes stay in one place.
 */

export const CFG = {
  look: 0.00215,
  pitchLimit: Math.PI / 2 - 0.04,
  fov: 92,
  dashFov: 14,
  speedFov: 0.16,

  gravity: 28,
  jumpSpeed: 8.9,
  wallJumpSpeed: 11.2,
  wallJumpUp: 9.15,
  maxWallKicks: 3,
  wallLock: 0.13,
  coyote: 0.08,
  jumpBuffer: 0.11,

  groundSpeed: 10.2,
  airSpeed: 10.2,
  groundAccel: 78,
  airAccel: 16,
  groundFriction: 0.62,
  airFriction: 0.04,
  stopSpeed: 2.2,
  softCap: 34,

  standHeight: 1.75,
  standEye: 1.58,
  crouchHeight: 0.58,
  crouchEye: 0.46,
  radius: 0.34,

  dashSpeed: 28,
  dashTime: 0.15,
  dashIFrames: 0.18,
  dashCharges: 3,
  dashRecharge: 1.5,

  slideFriction: 0.12,
  slideBoost: 12.5,
  slideHold: 0.18,

  slamSpeed: 36,
  slamBounce: 7.2,
  slamRadius: 4.5,
  slamDamage: 38,
  slamShake: 0.75,

  parryWindow: 0.15,
  parryRecovery: 0.4,
  parrySuccess: 0.16,
  parryInvuln: 0.26,
  parryReach: 1.12,
  parryRadius: 0.82,
  parrySpeedMul: 1.8,
  parrySpeedMin: 34,
  parryDamageMul: 2,
  hitstop: 0.06,
  hitstopScale: 0.02,

  equipTime: 0.18,
  scrollThreshold: 80,

  healRange: 5.6,
  healFraction: 0.22,

  maxHp: 100,
  maxEnemies: 5,
  projectilePool: 96,
  enemyPool: 8,

  styleKill: 26,
  styleParry: 34,
  styleDodge: 16,
  styleSlam: 12,
  styleHit: 0.35,
  styleAir: 8,
  styleIdle: 1.05,
  styleDecay: 14,
  styleMax: 100,

  staggerTime: 0.85,
};

/** Virtual weapon id used when a reflected shot gets the kill. Counts as variety. */
export const FIST_ID = 15;
export const FRESH_SLOTS = 16;

/**
 * 5 slots × 3 variants. Index is always slot * 3 + variant.
 * Hitscan weapons omit projKind. Projectile weapons set it.
 * fireMode: 'semi' | 'auto' | 'burst' | 'charge'
 */
export const WEAPONS = [
  {
    id: 'pistol-charge', slot: 0, variant: 0, name: 'PISTOL', variantName: 'CHARGE', kind: 'pistol',
    fireMode: 'charge', damage: 15, chargeDamage: 46, chargeTime: 0.62,
    mag: 12, reload: 1.05, cooldown: 0.2, spread: 0.006, range: 80, pierce: 0,
  },
  {
    id: 'pistol-marksman', slot: 0, variant: 1, name: 'PISTOL', variantName: 'MARKSMAN', kind: 'pistol',
    fireMode: 'semi', damage: 26, mag: 8, reload: 1.15, cooldown: 0.34, spread: 0, range: 90, pierce: 0,
  },
  {
    id: 'pistol-burst', slot: 0, variant: 2, name: 'PISTOL', variantName: 'BURST', kind: 'pistol',
    fireMode: 'burst', damage: 10, burst: 3, burstInterval: 0.055,
    mag: 18, reload: 1.1, cooldown: 0.4, spread: 0.012, range: 72, pierce: 0,
  },
  {
    id: 'shotgun-pump', slot: 1, variant: 0, name: 'SHOTGUN', variantName: 'PUMP', kind: 'shotgun',
    fireMode: 'semi', damage: 8, pellets: 8, spread: 0.072, pointBlank: 2.5, pbMul: 1.9,
    mag: 6, reload: 0.42, reloadMode: 'shell', cooldown: 0.56, range: 26,
  },
  {
    id: 'shotgun-wide', slot: 1, variant: 1, name: 'SHOTGUN', variantName: 'WIDE', kind: 'shotgun',
    fireMode: 'semi', damage: 5, pellets: 12, spread: 0.15, pointBlank: 2.15, pbMul: 1.65,
    mag: 4, reload: 0.48, reloadMode: 'shell', cooldown: 0.64, range: 20,
  },
  {
    id: 'shotgun-slug', slot: 1, variant: 2, name: 'SHOTGUN', variantName: 'SLUG', kind: 'shotgun',
    fireMode: 'semi', damage: 52, pellets: 1, spread: 0.008, pointBlank: 2.4, pbMul: 1.4,
    mag: 5, reload: 0.5, reloadMode: 'shell', cooldown: 0.7, range: 64,
  },
  {
    id: 'rail-electric', slot: 2, variant: 0, name: 'RAILGUN', variantName: 'ELECTRIC', kind: 'rail',
    fireMode: 'semi', damage: 82, pierce: 1, cooldown: 2.35, range: 84, spread: 0, beam: 1,
  },
  {
    id: 'rail-malicious', slot: 2, variant: 1, name: 'RAILGUN', variantName: 'MALICIOUS', kind: 'rail',
    fireMode: 'semi', damage: 48, splash: 30, splashR: 3.3, cooldown: 2.7, range: 72, spread: 0, beam: 1,
  },
  {
    id: 'rail-drill', slot: 2, variant: 2, name: 'RAILGUN', variantName: 'DRILL', kind: 'rail',
    fireMode: 'semi', damage: 36, pierce: 1, cooldown: 1.65, range: 84, spread: 0, beam: 1,
  },
  {
    id: 'rocket-direct', slot: 3, variant: 0, name: 'ROCKET', variantName: 'DIRECT', kind: 'rocket',
    fireMode: 'semi', damage: 56, splash: 34, splashR: 3.6, speed: 30,
    mag: 4, reload: 1.45, cooldown: 0.62, radius: 0.24, projKind: 2, life: 2.4,
  },
  {
    id: 'rocket-heavy', slot: 3, variant: 1, name: 'ROCKET', variantName: 'HEAVY', kind: 'rocket',
    fireMode: 'semi', damage: 78, splash: 46, splashR: 4.4, speed: 16,
    mag: 2, reload: 1.7, cooldown: 0.95, radius: 0.32, projKind: 2, life: 3,
  },
  {
    id: 'rocket-burst', slot: 3, variant: 2, name: 'ROCKET', variantName: 'BURST', kind: 'rocket',
    fireMode: 'burst', damage: 24, splash: 16, splashR: 2.3, speed: 34, burst: 3, burstInterval: 0.09,
    mag: 6, reload: 1.55, cooldown: 0.48, radius: 0.16, projKind: 2, life: 2,
  },
  {
    id: 'nail-standard', slot: 4, variant: 0, name: 'NAILGUN', variantName: 'STANDARD', kind: 'nail',
    fireMode: 'auto', damage: 5, speed: 52, fireRate: 14, spread: 0.02,
    mag: 80, reload: 1.3, radius: 0.07, projKind: 1, life: 0.85,
  },
  {
    id: 'nail-overheat', slot: 4, variant: 1, name: 'NAILGUN', variantName: 'OVERHEAT', kind: 'nail',
    fireMode: 'auto', damage: 4, speed: 46, fireRate: 22, spread: 0.016, heatSpread: 0.07,
    mag: 100, reload: 1.45, radius: 0.07, projKind: 1, life: 0.8,
  },
  {
    id: 'nail-attractor', slot: 4, variant: 2, name: 'NAILGUN', variantName: 'ATTRACTOR', kind: 'nail',
    fireMode: 'auto', damage: 6, speed: 38, fireRate: 11, spread: 0.03, homing: 4.5,
    mag: 50, reload: 1.35, radius: 0.08, projKind: 1, life: 1.1,
  },
];

export const SLOT_LABELS = ['PISTOL', 'SHOTGUN', 'RAIL', 'ROCKET', 'NAIL'];
export const SLOT_COUNT = 5;
export const VARIANTS_PER_SLOT = 3;

export const ENEMIES = {
  filth: {
    hp: 46, speed: 7.2, radius: 0.42, height: 0.92, damage: 20,
    windup: 0.36, strike: 0.15, recover: 0.42, cooldown: 0.7, lunge: 13.5,
  },
  stray: {
    hp: 58, speed: 4.5, radius: 0.4, height: 1.65, damage: 12, prefer: 11,
    fire: 1.7, telegraph: 0.28, shotSpeed: 12.2, shotRadius: 0.3, projKind: 0, burst: 1, burstGap: 0.2,
  },
  soldier: {
    hp: 96, speed: 3.7, radius: 0.46, height: 1.85, damage: 9, prefer: 9.5,
    fire: 2.15, telegraph: 0.18, shotSpeed: 17, shotRadius: 0.16, projKind: 3, burst: 2, burstGap: 0.28,
  },
};

export const RANK_AT = [
  { id: 'D', min: 0 },
  { id: 'C', min: 15 },
  { id: 'B', min: 30 },
  { id: 'A', min: 50 },
  { id: 'S', min: 75 },
];

export function rankFor(meter) {
  let rank = 'D';
  for (let i = 0; i < RANK_AT.length; i++) {
    if (meter >= RANK_AT[i].min) rank = RANK_AT[i].id;
  }
  return rank;
}

export function rankValue(rank) {
  for (let i = 0; i < RANK_AT.length; i++) {
    if (RANK_AT[i].id === rank) return i;
  }
  return 0;
}
