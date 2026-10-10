/**
 * projectiles.js
 * Fixed pool. Spawn copies the event payload immediately so the bus can
 * reuse it. Reflect rewrites velocity along a direction and doubles damage.
 */
import { EV } from './bus.js';
import { raycastClosest, rayCylinderY } from './collision.js';

export function createProjectilePool(n) {
  const free = new Int16Array(n);
  for (let i = 0; i < n; i++) free[i] = n - 1 - i;
  return {
    n,
    alive: new Uint8Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    vz: new Float32Array(n),
    damage: new Float32Array(n),
    radius: new Float32Array(n),
    life: new Float32Array(n),
    owner: new Uint8Array(n),
    kind: new Uint8Array(n),
    splash: new Float32Array(n),
    splashR: new Float32Array(n),
    homing: new Float32Array(n),
    flags: new Uint8Array(n),
    weapon: new Uint8Array(n),
    gen: new Uint16Array(n),
    free,
    freeTop: n,
    genClock: 1,
  };
}

export function resetProjectiles(pool) {
  pool.alive.fill(0);
  pool.freeTop = pool.n;
  for (let i = 0; i < pool.n; i++) pool.free[i] = pool.n - 1 - i;
}

export function spawnProjectile(pool, s) {
  if (pool.freeTop <= 0) return -1;
  const i = pool.free[--pool.freeTop];
  pool.alive[i] = 1;
  pool.x[i] = s.x;
  pool.y[i] = s.y;
  pool.z[i] = s.z;
  pool.vx[i] = s.vx;
  pool.vy[i] = s.vy;
  pool.vz[i] = s.vz;
  pool.damage[i] = s.damage;
  pool.radius[i] = s.radius;
  pool.life[i] = s.life || 2;
  pool.owner[i] = s.owner || 0;
  pool.kind[i] = s.kind || 0;
  pool.splash[i] = s.splash || 0;
  pool.splashR[i] = s.splashR || 0;
  pool.homing[i] = s.homing || 0;
  pool.flags[i] = s.flags || 0;
  pool.weapon[i] = s.weaponId || 0;
  pool.gen[i] = pool.genClock++;
  if (pool.genClock > 60000) pool.genClock = 1;
  return i;
}

export function killProjectile(pool, i) {
  if (!pool.alive[i]) return;
  pool.alive[i] = 0;
  pool.free[pool.freeTop++] = i;
}

export function reflectProjectile(pool, i, fx, fy, fz, speedMul, minSpeed, damageMul) {
  if (!pool.alive[i]) return false;
  const sp0 = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i]);
  const sp = Math.max(sp0 * speedMul, minSpeed);
  const len = Math.hypot(fx, fy, fz) || 1;
  pool.vx[i] = (fx / len) * sp;
  pool.vy[i] = (fy / len) * sp;
  pool.vz[i] = (fz / len) * sp;
  pool.damage[i] *= damageMul;
  pool.owner[i] = 0;
  pool.flags[i] |= 1;
  pool.weapon[i] = 15;
  pool.life[i] = Math.max(pool.life[i], 1.6);
  pool.x[i] += pool.vx[i] * 0.016;
  pool.y[i] += pool.vy[i] * 0.016;
  pool.z[i] += pool.vz[i] * 0.016;
  return true;
}

const _explode = { x: 0, y: 0, z: 0, direct: -1, directDamage: 0, splash: 0, radius: 0, weaponId: 0 };
const _impact = { x: 0, y: 0, z: 0, kind: 0 };
const _threat = { damage: 0, x: 0, y: 0, z: 0, id: 0, nx: 0, nz: 0 };

function steerHoming(pool, i, enemies, dt) {
  let best = 20 * 20;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  let found = false;
  const list = enemies.list;
  for (let e = 0; e < list.length; e++) {
    const en = list[e];
    if (!en.alive) continue;
    const dx = en.x - pool.x[i];
    const dy = (en.y + en.height * 0.5) - pool.y[i];
    const dz = en.z - pool.z[i];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) {
      best = d2;
      tx = en.x;
      ty = en.y + en.height * 0.5;
      tz = en.z;
      found = true;
    }
  }
  if (!found) return;
  const dist = Math.sqrt(best) || 1;
  const sp = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i]) || 1;
  const k = Math.min(1, pool.homing[i] * dt);
  pool.vx[i] += ((tx - pool.x[i]) / dist * sp - pool.vx[i]) * k;
  pool.vy[i] += ((ty - pool.y[i]) / dist * sp - pool.vy[i]) * k;
  pool.vz[i] += ((tz - pool.z[i]) / dist * sp - pool.vz[i]) * k;
  const nsp = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i]) || 1;
  const scale = sp / nsp;
  pool.vx[i] *= scale;
  pool.vy[i] *= scale;
  pool.vz[i] *= scale;
}

/**
 * Moves the pool and emits EXPLODE / IMPACT / THREAT. Damage to enemies is
 * applied by the EXPLODE listener (splash) or by the returned direct hits
 * through the HIT path in the listener registered by main — actually this
 * function emits EXPLODE for rockets and calls `onHitEnemy` via bus HIT
 * for direct non-splash hits so style and health stay on the bus.
 */
export function updateProjectiles(pool, dt, boxes, enemies, player, bus, ray) {
  const list = enemies.list;
  for (let i = 0; i < pool.n; i++) {
    if (!pool.alive[i]) continue;
    pool.life[i] -= dt;
    if (pool.life[i] <= 0) {
      killProjectile(pool, i);
      continue;
    }
    if (pool.homing[i] > 0 && pool.owner[i] === 0) steerHoming(pool, i, enemies, dt);

    const ox = pool.x[i];
    const oy = pool.y[i];
    const oz = pool.z[i];
    const spd = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i]);
    if (spd < 1e-5) continue;
    const inv = 1 / spd;
    const dx = pool.vx[i] * inv;
    const dy = pool.vy[i] * inv;
    const dz = pool.vz[i] * inv;
    const step = spd * dt;

    raycastClosest(ox, oy, oz, dx, dy, dz, step, boxes, ray);
    let limit = ray.hit ? ray.t : step + 1;
    let wall = ray.hit;
    let wallX = ray.x;
    let wallY = ray.y;
    let wallZ = ray.z;

    let bestE = -1;
    let bestT = limit;
    if (pool.owner[i] === 0) {
      for (let e = 0; e < list.length; e++) {
        const en = list[e];
        if (!en.alive) continue;
        const t = rayCylinderY(ox, oy, oz, dx, dy, dz, bestT, en.x, en.y, en.z, en.radius + pool.radius[i] * 0.25, en.height);
        if (t >= 0 && t <= bestT) {
          bestT = t;
          bestE = e;
        }
      }
    }

    let playerT = 99;
    if (pool.owner[i] === 1 && player.alive) {
      const t = rayCylinderY(
        ox, oy, oz, dx, dy, dz, limit,
        player.x, player.y, player.z, player.radius + pool.radius[i] * 0.2, player.height,
      );
      if (t >= 0 && t <= limit && (bestE < 0 || t < bestT)) playerT = t;
    }

    if (playerT < 90 && playerT <= limit && (bestE < 0 || playerT <= bestT)) {
      const hx = ox + dx * playerT;
      const hz = oz + dz * playerT;
      killProjectile(pool, i);
      _threat.damage = pool.damage[i];
      _threat.x = hx;
      _threat.y = oy + dy * playerT;
      _threat.z = hz;
      _threat.id = pool.gen[i];
      const plen = Math.hypot(player.x - hx, player.z - hz) || 1;
      _threat.nx = (player.x - hx) / plen;
      _threat.nz = (player.z - hz) / plen;
      bus.emit(EV.THREAT, _threat);
      _impact.x = hx;
      _impact.y = _threat.y;
      _impact.z = hz;
      _impact.kind = pool.kind[i];
      bus.emit(EV.IMPACT, _impact);
      continue;
    }

    if (bestE >= 0 && bestT <= limit) {
      const hx = ox + dx * bestT;
      const hy = oy + dy * bestT;
      const hz = oz + dz * bestT;
      const wid = pool.weapon[i];
      const dmg = pool.damage[i];
      const splash = pool.splash[i];
      const splashR = pool.splashR[i];
      const kind = pool.kind[i];
      killProjectile(pool, i);
      if (splash > 0 || kind === 2) {
        _explode.x = hx;
        _explode.y = hy;
        _explode.z = hz;
        _explode.direct = bestE;
        _explode.directDamage = dmg;
        _explode.splash = splash;
        _explode.radius = splashR;
        _explode.weaponId = wid;
        bus.emit(EV.EXPLODE, _explode);
      } else {
        _impact.x = hx;
        _impact.y = hy;
        _impact.z = hz;
        _impact.kind = kind;
        bus.emit(EV.IMPACT, _impact);
        // Direct hit rides the explode-less path. Main listens for a dedicated
        // shape on IMPACT only for sparks; damage is emitted as EXPLODE with
        // zero splash so one handler covers both. Use EXPLODE always for hits
        // that damage enemies.
        _explode.x = hx;
        _explode.y = hy;
        _explode.z = hz;
        _explode.direct = bestE;
        _explode.directDamage = dmg;
        _explode.splash = 0;
        _explode.radius = 0;
        _explode.weaponId = wid;
        bus.emit(EV.EXPLODE, _explode);
      }
      continue;
    }

    if (wall && limit <= step + 1e-4) {
      killProjectile(pool, i);
      if (pool.kind[i] === 2 || pool.splash[i] > 0) {
        _explode.x = wallX;
        _explode.y = wallY;
        _explode.z = wallZ;
        _explode.direct = -1;
        _explode.directDamage = 0;
        _explode.splash = pool.splash[i] || pool.damage[i] * 0.6;
        _explode.radius = pool.splashR[i] || 3;
        _explode.weaponId = pool.weapon[i];
        bus.emit(EV.EXPLODE, _explode);
      } else {
        _impact.x = wallX;
        _impact.y = wallY;
        _impact.z = wallZ;
        _impact.kind = pool.kind[i];
        bus.emit(EV.IMPACT, _impact);
      }
      continue;
    }

    pool.x[i] = ox + dx * step;
    pool.y[i] = oy + dy * step;
    pool.z[i] = oz + dz * step;
    if (pool.y[i] < 0.05 && pool.vy[i] < 0) {
      if (pool.kind[i] === 2) {
        const yy = 0.05;
        killProjectile(pool, i);
        _explode.x = pool.x[i];
        _explode.y = yy;
        _explode.z = pool.z[i];
        _explode.direct = -1;
        _explode.directDamage = 0;
        _explode.splash = pool.splash[i];
        _explode.radius = pool.splashR[i];
        _explode.weaponId = pool.weapon[i];
        bus.emit(EV.EXPLODE, _explode);
      } else {
        pool.y[i] = 0.05;
        killProjectile(pool, i);
        _impact.x = ox;
        _impact.y = 0.05;
        _impact.z = oz;
        _impact.kind = 0;
        bus.emit(EV.IMPACT, _impact);
      }
    }
  }
}
