/**
 * parry.js
 * Feedbacker timing. Active for 0.15s. A whiff locks the parry for 0.4s.
 * A success skips that lock. The hit test is a sphere in front of the camera.
 */

export function createParry() {
  return {
    state: 'ready',
    time: 0,
    invuln: 0,
  };
}

export function resetParry(p) {
  p.state = 'ready';
  p.time = 0;
  p.invuln = 0;
}

export function pressParry(p, window) {
  if (p.state !== 'ready') return false;
  p.state = 'active';
  p.time = window;
  return true;
}

/**
 * Advances the state machine. Returns 'whiff' on the frame the active
 * window expires without a success.
 */
export function tickParry(p, dt, recovery, successTime) {
  if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
  if (p.state === 'active') {
    p.time -= dt;
    if (p.time <= 0) {
      p.state = 'recovery';
      p.time = recovery;
      return 'whiff';
    }
  } else if (p.state === 'recovery' || p.state === 'success') {
    p.time -= dt;
    if (p.time <= 0) p.state = 'ready';
  }
  return null;
  void successTime;
}

export function markParrySuccess(p, successTime, invuln) {
  p.state = 'success';
  p.time = successTime;
  p.invuln = invuln;
}

export function fillParrySphere(yaw, pitch, ox, oy, oz, reach, radius, out) {
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;
  out.x = ox + fx * reach;
  out.y = oy + fy * reach;
  out.z = oz + fz * reach;
  out.r = radius;
  out.fx = fx;
  out.fy = fy;
  out.fz = fz;
  return out;
}

function dist2(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

/** Closest point on segment AB to C, as a 0..1 param. */
function segmentT(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-8) return 0;
  let t = ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return t;
}

/**
 * Active-window query. Projectiles are tested as a swept segment so a fast
 * bolt cannot skip the fist between frames. Returns { proj, enemy }.
 */
export function findParryTarget(sphere, pool, enemies, dt) {
  let best = 1e12;
  let proj = -1;
  let enemy = -1;
  const r = sphere.r;
  for (let i = 0; i < pool.n; i++) {
    if (!pool.alive[i] || pool.owner[i] !== 1) continue;
    const x1 = pool.x[i] + pool.vx[i] * dt;
    const y1 = pool.y[i] + pool.vy[i] * dt;
    const z1 = pool.z[i] + pool.vz[i] * dt;
    const t = segmentT(pool.x[i], pool.y[i], pool.z[i], x1, y1, z1, sphere.x, sphere.y, sphere.z);
    const px = pool.x[i] + (x1 - pool.x[i]) * t;
    const py = pool.y[i] + (y1 - pool.y[i]) * t;
    const pz = pool.z[i] + (z1 - pool.z[i]) * t;
    const reach = r + pool.radius[i];
    const d2 = dist2(px, py, pz, sphere.x, sphere.y, sphere.z);
    if (d2 <= reach * reach && d2 < best) {
      best = d2;
      proj = i;
      enemy = -1;
    }
  }
  for (let i = 0; i < enemies.list.length; i++) {
    const e = enemies.list[i];
    if (!e.alive || e.state !== 'strike') continue;
    const tx = e.x + e.fx * 0.9;
    const ty = e.y + e.height * 0.65;
    const tz = e.z + e.fz * 0.9;
    const reach = r + 0.55;
    const d2 = dist2(tx, ty, tz, sphere.x, sphere.y, sphere.z);
    if (d2 <= reach * reach && d2 < best) {
      best = d2;
      enemy = i;
      proj = -1;
    }
  }
  return { proj, enemy };
}
