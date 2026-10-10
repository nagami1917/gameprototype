/**
 * enemies.js
 * Three machines: Filth lunges (parryable melee), Stray lobs a slow orb,
 * Soldier fires a faster two-bolt burst. They do not import weapons or the
 * player module — the composer passes a position and a bus.
 */
import { CFG, ENEMIES } from './config.js';
import { EV } from './bus.js';
import { SPAWNS } from './arenaData.js';
import { fitsHeight, hasLineOfSight, pushCylinder } from './collision.js';

/** Enemies do not appear inside this distance of the player. */
export const SPAWN_CLEAR = 9;

/** Alive cap grows with time, never past the pool / config ceiling. */
export function enemyCap(time) {
  return Math.min(CFG.maxEnemies, 2 + Math.floor(time / 18));
}

export function createEnemies(n) {
  const list = [];
  for (let i = 0; i < n; i++) list.push(makeEnemy(i));
  return { list, aliveCount: 0, spawnTimer: 0.2, time: 0, tutored: false };
}

function makeEnemy(id) {
  return {
    id,
    alive: false,
    type: 'stray',
    x: 0, y: 0, z: 0,
    vx: 0, vz: 0,
    yaw: 0, fx: 0, fz: 1,
    hp: 1, maxHp: 1,
    radius: 0.4, height: 1.6,
    state: 'idle',
    timer: 0,
    cooldown: 0,
    attackHit: false,
    flash: 0,
    speed: 4,
    prefer: 10,
    damage: 10,
    fireTimer: 1,
    burstLeft: 1,
    burstMax: 1,
    burstGap: 0.2,
    telegraph: 0.3,
    shotSpeed: 12,
    shotRadius: 0.2,
    projKind: 0,
    windup: 0.3,
    strikeTime: 0.15,
    recover: 0.4,
    lunge: 12,
    cooldownTime: 0.7,
    side: 1,
    sideTimer: 2,
    spawnIn: 0,
    lastWeapon: 0,
  };
}

export function resetEnemies(pool) {
  for (let i = 0; i < pool.list.length; i++) {
    const e = pool.list[i];
    e.alive = false;
    e.timer = 0;
    e.state = 'idle';
    e.hp = 0;
    e.vx = 0;
    e.vz = 0;
  }
  pool.aliveCount = 0;
  pool.spawnTimer = 0.15;
  pool.time = 0;
  pool.tutored = false;
}

function pickType(time) {
  const r = Math.random();
  if (time < 18) return r < 0.5 ? 'stray' : 'filth';
  if (r < 0.38) return 'filth';
  if (r < 0.72) return 'stray';
  return 'soldier';
}

function activate(e, type, x, z, pool) {
  const def = ENEMIES[type];
  e.alive = true;
  e.type = type;
  e.x = x;
  e.y = 0;
  e.z = z;
  e.vx = 0;
  e.vz = 0;
  e.hp = def.hp;
  e.maxHp = def.hp;
  e.radius = def.radius;
  e.height = def.height;
  e.speed = def.speed;
  e.damage = def.damage;
  e.state = 'chase';
  e.timer = 0;
  e.cooldown = 0;
  e.attackHit = false;
  e.flash = 0;
  e.spawnIn = 0.18;
  e.prefer = def.prefer || 8;
  e.fireTimer = 0.55 + Math.random() * 0.45;
  e.burstMax = def.burst || 1;
  e.burstLeft = e.burstMax;
  e.burstGap = def.burstGap || 0.2;
  e.telegraph = def.telegraph || 0.28;
  e.shotSpeed = def.shotSpeed || 12;
  e.shotRadius = def.shotRadius || 0.2;
  e.projKind = def.projKind || 0;
  e.windup = def.windup || 0.36;
  e.strikeTime = def.strike || 0.15;
  e.recover = def.recover || 0.4;
  e.lunge = def.lunge || 12;
  e.cooldownTime = def.cooldown || 0.7;
  e.side = Math.random() < 0.5 ? -1 : 1;
  e.sideTimer = 1.4 + Math.random();
  e.lastWeapon = 0;
  if (type === 'stray' && pool && !pool.tutored) {
    pool.tutored = true;
    e.shotSpeed = 9;
    e.telegraph = 0.5;
    e.fireTimer = 0.35;
    e.fireCooldown = 2.1;
  } else {
    e.fireCooldown = def.fire || 1.6;
  }
}

function tryPlace(pool, player, boxes, type) {
  for (let n = 0; n < 10; n++) {
    const s = SPAWNS[(Math.random() * SPAWNS.length) | 0];
    const dx = s[0] - player.x;
    const dz = s[1] - player.z;
    if (dx * dx + dz * dz < SPAWN_CLEAR * SPAWN_CLEAR) continue;
    if (!fitsHeight(s[0], 0, s[1], 0.5, 1.8, boxes)) continue;
    for (let i = 0; i < pool.list.length; i++) {
      const e = pool.list[i];
      if (e.alive || e.timer > 0) continue;
      activate(e, type || pickType(pool.time), s[0], s[1], pool);
      return true;
    }
    return false;
  }
  return false;
}

export function initialSpawn(pool, player, boxes) {
  const types = ['stray', 'filth', 'stray'];
  for (let i = 0; i < types.length; i++) tryPlace(pool, player, boxes, types[i]);
}

const _steer = { x: 0, z: 0 };
const _fire = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  damage: 0, radius: 0.2, kind: 0, owner: 1,
  splash: 0, splashR: 0, homing: 0, life: 3.2, weaponId: 0, flags: 0,
};
const _tele = { type: '' };

function avoid(e, wx, wz, boxes) {
  const ahead = 1.2;
  if (fitsHeight(e.x + wx * ahead, e.y, e.z + wz * ahead, e.radius + 0.05, e.height, boxes)) {
    _steer.x = wx;
    _steer.z = wz;
    return _steer;
  }
  if (fitsHeight(e.x - wz * ahead, e.y, e.z + wx * ahead, e.radius + 0.05, e.height, boxes)) {
    _steer.x = -wz;
    _steer.z = wx;
    return _steer;
  }
  _steer.x = wz;
  _steer.z = -wx;
  return _steer;
}

function seek(e, tx, tz, speed, boxes) {
  let wx = tx - e.x;
  let wz = tz - e.z;
  const len = Math.hypot(wx, wz) || 1;
  wx /= len;
  wz /= len;
  const st = avoid(e, wx, wz, boxes);
  e.vx = st.x * speed;
  e.vz = st.z * speed;
}

function moveEnemy(e, dt, boxes) {
  e.x += e.vx * dt;
  e.z += e.vz * dt;
  pushCylinder(e, e.radius, e.height, boxes);
  e.y = 0;
  const sp = Math.hypot(e.vx, e.vz);
  if (sp > 16) {
    e.vx *= 16 / sp;
    e.vz *= 16 / sp;
  }
}

function face(e, px, pz) {
  const dx = px - e.x;
  const dz = pz - e.z;
  const len = Math.hypot(dx, dz) || 1;
  e.fx = dx / len;
  e.fz = dz / len;
  e.yaw = Math.atan2(-e.fx, -e.fz);
}

function fireAt(e, player, bus) {
  const ox = e.x + e.fx * 0.65;
  const oy = e.y + e.height * 0.72;
  const oz = e.z + e.fz * 0.65;
  let dx = player.x - ox;
  let dy = (player.y + player.eye * 0.72) - oy;
  let dz = player.z - oz;
  const spread = e.type === 'soldier' ? 0.35 : 0.16;
  dx += (Math.random() - 0.5) * spread;
  dy += (Math.random() - 0.5) * spread * 0.4;
  dz += (Math.random() - 0.5) * spread;
  const len = Math.hypot(dx, dy, dz) || 1;
  const sp = e.shotSpeed;
  _fire.x = ox;
  _fire.y = oy;
  _fire.z = oz;
  _fire.vx = (dx / len) * sp;
  _fire.vy = (dy / len) * sp;
  _fire.vz = (dz / len) * sp;
  _fire.damage = e.damage;
  _fire.radius = e.shotRadius;
  _fire.kind = e.projKind;
  _fire.owner = 1;
  _fire.splash = 0;
  _fire.splashR = 0;
  _fire.homing = 0;
  _fire.life = 3.4;
  _fire.weaponId = 0;
  _fire.flags = 0;
  bus.emit(EV.ENEMY_FIRE, _fire);
}

function tickFilth(e, dt, player, dist, boxes, bus) {
  if (e.state === 'chase' || e.state === 'idle') {
    if (e.cooldown > 0) e.cooldown -= dt;
    seek(e, player.x, player.z, e.speed, boxes);
    if (dist < 2.15 && e.cooldown <= 0 && player.alive) {
      e.state = 'windup';
      e.timer = e.windup;
      _tele.type = e.type;
      bus.emit(EV.TELEGRAPH, _tele);
    }
  } else if (e.state === 'windup') {
    e.vx *= Math.exp(-8 * dt);
    e.vz *= Math.exp(-8 * dt);
    e.timer -= dt;
    if (e.timer <= 0) {
      e.state = 'strike';
      e.timer = e.strikeTime;
      e.attackHit = false;
    }
  } else if (e.state === 'strike') {
    e.vx = e.fx * e.lunge;
    e.vz = e.fz * e.lunge;
    e.timer -= dt;
    if (e.timer <= 0) {
      e.state = 'recover';
      e.timer = e.recover;
      e.cooldown = e.cooldownTime;
    }
  } else if (e.state === 'recover') {
    e.vx *= Math.exp(-6 * dt);
    e.vz *= Math.exp(-6 * dt);
    e.timer -= dt;
    if (e.timer <= 0) e.state = 'chase';
  }
}

function tickRanged(e, dt, player, dist, boxes, bus, ray) {
  if (e.cooldown > 0) e.cooldown -= dt;
  if (e.state === 'chase' || e.state === 'idle') {
    e.sideTimer -= dt;
    if (e.sideTimer <= 0) {
      e.side *= -1;
      e.sideTimer = 1.6 + Math.random() * 1.2;
    }
    let tx = player.x;
    let tz = player.z;
    if (dist < e.prefer - 1.4) {
      tx = e.x - e.fx * 3;
      tz = e.z - e.fz * 3;
    } else if (dist <= e.prefer + 3.2) {
      tx = e.x + -e.fz * e.side * 2.2;
      tz = e.z + e.fx * e.side * 2.2;
    }
    seek(e, tx, tz, e.speed, boxes);
    if (e.fireTimer > 0) e.fireTimer -= dt;
    const los = dist < 26 && hasLineOfSight(
      e.x, e.y + e.height * 0.7, e.z,
      player.x, player.y + 1.2, player.z,
      boxes, ray,
    );
    if (e.fireTimer <= 0 && los && player.alive && dist < 24 && dist > 1.4) {
      e.state = 'telegraph';
      e.timer = e.telegraph;
      _tele.type = e.type;
      bus.emit(EV.TELEGRAPH, _tele);
    }
  } else if (e.state === 'telegraph') {
    e.vx *= Math.exp(-10 * dt);
    e.vz *= Math.exp(-10 * dt);
    e.timer -= dt;
    if (e.timer <= 0) {
      fireAt(e, player, bus);
      e.burstLeft -= 1;
      e.state = 'chase';
      if (e.burstLeft > 0) e.fireTimer = e.burstGap;
      else {
        e.burstLeft = e.burstMax;
        e.fireTimer = e.fireCooldown || 1.6;
      }
    }
  }
}

export function updateEnemies(pool, dt, player, boxes, bus, ray, spawning) {
  pool.time += dt;
  let alive = 0;
  const list = pool.list;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.alive) {
      if (e.timer > 0) e.timer -= dt;
      continue;
    }
    alive += 1;
    if (e.flash > 0) e.flash -= dt;
    if (e.spawnIn > 0) e.spawnIn -= dt;
    const dx = player.x - e.x;
    const dz = player.z - e.z;
    const dist = Math.hypot(dx, dz) || 0.0001;
    if (e.state !== 'strike') face(e, player.x, player.z);
    if (e.state === 'stagger') {
      e.timer -= dt;
      e.vx *= Math.exp(-3 * dt);
      e.vz *= Math.exp(-3 * dt);
      moveEnemy(e, dt, boxes);
      if (e.timer <= 0) e.state = 'chase';
      continue;
    }
    if (e.type === 'filth') tickFilth(e, dt, player, dist, boxes, bus);
    else tickRanged(e, dt, player, dist, boxes, bus, ray);
    moveEnemy(e, dt, boxes);
  }
  pool.aliveCount = alive;
  separateEnemies(pool);
  if (!spawning || !player.alive) return;
  const cap = enemyCap(pool.time);
  if (alive < cap) {
    pool.spawnTimer -= dt;
    if (pool.spawnTimer <= 0) {
      tryPlace(pool, player, boxes, null);
      pool.spawnTimer = 1.25;
    }
  }
}

export function separateEnemies(pool) {
  const list = pool.list;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!b.alive) continue;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const min = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1e-8) {
        b.x += 0.08;
        continue;
      }
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) * 0.5;
      const nx = dx / d;
      const nz = dz / d;
      a.x -= nx * push;
      a.z -= nz * push;
      b.x += nx * push;
      b.z += nz * push;
    }
  }
}

export function damageEnemy(e, amount, pushX, pushZ, weaponId) {
  if (!e.alive || amount <= 0) return false;
  e.hp -= amount;
  e.flash = 0.09;
  e.vx += pushX;
  e.vz += pushZ;
  e.lastWeapon = weaponId;
  const sp = Math.hypot(e.vx, e.vz);
  if (sp > 16) {
    e.vx *= 16 / sp;
    e.vz *= 16 / sp;
  }
  if (e.hp <= 0) {
    e.hp = 0;
    e.alive = false;
    e.state = 'dead';
    e.timer = 2.25;
    return true;
  }
  return false;
}

export function staggerEnemy(e, duration) {
  if (!e.alive) return;
  e.state = 'stagger';
  e.timer = duration;
  e.attackHit = true;
  e.vx *= 0.25;
  e.vz *= 0.25;
}
