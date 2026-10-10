/**
 * collision.js
 * Allocation-free AABB helpers. Actors are vertical cylinders; the world is
 * boxes. Callers pass scratch objects so the hot path never allocates.
 */

export function createBox(minX, minY, minZ, maxX, maxY, maxZ, tag = 'solid') {
  return { minX, minY, minZ, maxX, maxY, maxZ, tag, active: true };
}

export function createContact() {
  return { wall: false, nx: 0, nz: 0, grounded: false, ceiling: false };
}

export function createRayHit() {
  return { hit: false, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, box: null };
}

export function circleOverlapsBox(x, z, radius, b) {
  const cx = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
  const cz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < radius * radius;
}

/** True when a standing volume at (x, y, z) does not intersect any box. */
export function fitsHeight(x, y, z, radius, height, boxes) {
  const head = y + height;
  const r = radius * 0.92;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b.active) continue;
    if (b.maxY <= y + 0.05) continue;
    if (b.minY >= head - 0.02) continue;
    if (circleOverlapsBox(x, z, r, b)) return false;
  }
  return true;
}

function pushCircle(pos, radius, b, contact) {
  let cx = pos.x < b.minX ? b.minX : pos.x > b.maxX ? b.maxX : pos.x;
  let cz = pos.z < b.minZ ? b.minZ : pos.z > b.maxZ ? b.maxZ : pos.z;
  const dx = pos.x - cx;
  const dz = pos.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return false;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    const push = radius - d + 0.0008;
    const nx = dx / d;
    const nz = dz / d;
    pos.x += nx * push;
    pos.z += nz * push;
    if (contact) {
      contact.nx += nx;
      contact.nz += nz;
      contact.wall = true;
    }
  } else if (contact) {
    const toMinX = pos.x - b.minX + radius;
    const toMaxX = b.maxX - pos.x + radius;
    const toMinZ = pos.z - b.minZ + radius;
    const toMaxZ = b.maxZ - pos.z + radius;
    const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
    if (m === toMinX) { pos.x = b.minX - radius; contact.nx -= 1; }
    else if (m === toMaxX) { pos.x = b.maxX + radius; contact.nx += 1; }
    else if (m === toMinZ) { pos.z = b.minZ - radius; contact.nz -= 1; }
    else { pos.z = b.maxZ + radius; contact.nz += 1; }
    contact.wall = true;
  } else {
    const toMinX = pos.x - b.minX + radius;
    const toMaxX = b.maxX - pos.x + radius;
    const toMinZ = pos.z - b.minZ + radius;
    const toMaxZ = b.maxZ - pos.z + radius;
    const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
    if (m === toMinX) pos.x = b.minX - radius;
    else if (m === toMaxX) pos.x = b.maxX + radius;
    else if (m === toMinZ) pos.z = b.minZ - radius;
    else pos.z = b.maxZ + radius;
  }
  return true;
}

const _push = { wall: false, nx: 0, nz: 0, grounded: false, ceiling: false };

/** Push a cylinder out of walls. Ignores boxes that don't overlap [feet, head]. */
export function pushCylinder(pos, radius, height, boxes) {
  const feet = pos.y;
  const head = feet + height;
  for (let iter = 0; iter < 3; iter++) {
    let any = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.active) continue;
      if (b.maxY <= feet + 0.05 || b.minY >= head) continue;
      if (pushCircle(pos, radius, b, null)) any = true;
    }
    if (!any) break;
  }
}

function resolveHorizontal(p, boxes, contact) {
  const radius = p.radius;
  for (let iter = 0; iter < 3; iter++) {
    let any = false;
    const feet = p.y;
    const head = feet + p.height;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.active) continue;
      if (b.maxY <= feet + 0.06) continue;
      if (b.minY >= head) continue;
      // Low lips are steps, not walls, when the space above them is clear.
      if (b.maxY <= feet + 0.46 && circleOverlapsBox(p.x, p.z, radius, b)) {
        if (fitsHeight(p.x, b.maxY, p.z, radius, p.height, boxes)) {
          p.y = b.maxY;
          continue;
        }
      }
      if (b.maxY <= p.y + 0.06) continue;
      if (b.minY >= p.y + p.height) continue;
      if (pushCircle(p, radius, b, contact)) any = true;
    }
    if (!any) break;
  }
}

function resolveVertical(p, prevY, sy, boxes, contact) {
  if (p.y <= 0) {
    p.y = 0;
    contact.grounded = true;
  }
  const r = p.radius * 0.7;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b.active) continue;
    if (!circleOverlapsBox(p.x, p.z, r, b)) continue;
    const head = p.y + p.height;
    const prevHead = prevY + p.height;
    if (sy <= 0 && prevY >= b.maxY - 0.03 && p.y < b.maxY && p.y > b.maxY - 1.05 && head > b.maxY) {
      p.y = b.maxY;
      contact.grounded = true;
    } else if (sy > 0 && prevHead <= b.minY + 0.03 && head > b.minY) {
      p.y = b.minY - p.height;
      contact.ceiling = true;
      if (p.vy > 0) p.vy = 0;
    }
  }
}

/**
 * Move a player-like body by its velocity for `dt`, sliding on walls.
 * `contact` is filled and also returned (same reference — do not store it).
 */
export function moveBody(p, dt, boxes, contact) {
  contact.wall = false;
  contact.nx = 0;
  contact.nz = 0;
  contact.grounded = false;
  contact.ceiling = false;

  const hdist = Math.hypot(p.vx, p.vz) * dt;
  const hsteps = hdist > 0.2 ? Math.ceil(hdist / 0.2) : 1;
  const sx = (p.vx * dt) / hsteps;
  const sz = (p.vz * dt) / hsteps;
  for (let s = 0; s < hsteps; s++) {
    p.x += sx;
    resolveHorizontal(p, boxes, contact);
    p.z += sz;
    resolveHorizontal(p, boxes, contact);
  }
  if (contact.wall) {
    const len = Math.hypot(contact.nx, contact.nz);
    if (len > 1e-5) {
      contact.nx /= len;
      contact.nz /= len;
      const into = p.vx * contact.nx + p.vz * contact.nz;
      if (into < 0) {
        p.vx -= contact.nx * into;
        p.vz -= contact.nz * into;
      }
    } else {
      contact.wall = false;
    }
  }

  const vdist = Math.abs(p.vy) * dt;
  const vsteps = vdist > 0.22 ? Math.ceil(vdist / 0.22) : 1;
  const sy = (p.vy * dt) / vsteps;
  for (let s = 0; s < vsteps; s++) {
    const prevY = p.y;
    p.y += sy;
    resolveVertical(p, prevY, sy, boxes, contact);
  }
  if (p.y <= 0) {
    p.y = 0;
    contact.grounded = true;
  }
  return contact;
}

function raySlab(o, d, min, max, tmin, tmax) {
  if (Math.abs(d) < 1e-9) {
    if (o < min || o > max) return null;
    return { tmin, tmax, entered: false, sign: 0 };
  }
  let t1 = (min - o) / d;
  let t2 = (max - o) / d;
  let sign = -1;
  if (t1 > t2) {
    const tmp = t1;
    t1 = t2;
    t2 = tmp;
    sign = 1;
  }
  let entered = false;
  if (t1 > tmin) {
    tmin = t1;
    entered = true;
  }
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return null;
  return { tmin, tmax, entered, sign };
}

/** Nearest box along a normalised ray. Fills `out`. Returns out.hit. */
export function raycastClosest(ox, oy, oz, dx, dy, dz, maxT, boxes, out) {
  out.hit = false;
  out.box = null;
  let best = maxT;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let box = null;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b.active) continue;
    let tmin = 0;
    let tmax = best;
    let axis = -1;
    let sign = 0;
    const xs = raySlab(ox, dx, b.minX, b.maxX, tmin, tmax);
    if (!xs) continue;
    tmin = xs.tmin;
    tmax = xs.tmax;
    if (xs.entered) { axis = 0; sign = xs.sign; }
    const ys = raySlab(oy, dy, b.minY, b.maxY, tmin, tmax);
    if (!ys) continue;
    tmin = ys.tmin;
    tmax = ys.tmax;
    if (ys.entered) { axis = 1; sign = ys.sign; }
    const zs = raySlab(oz, dz, b.minZ, b.maxZ, tmin, tmax);
    if (!zs) continue;
    tmin = zs.tmin;
    if (zs.entered) { axis = 2; sign = zs.sign; }
    if (axis < 0 || tmin < 0 || tmin >= best) continue;
    best = tmin;
    box = b;
    nx = axis === 0 ? sign : 0;
    ny = axis === 1 ? sign : 0;
    nz = axis === 2 ? sign : 0;
  }
  if (!box) return false;
  out.hit = true;
  out.t = best;
  out.x = ox + dx * best;
  out.y = oy + dy * best;
  out.z = oz + dz * best;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.box = box;
  return true;
}

/**
 * Ray vs Y-aligned cylinder. Returns t in [0, maxT], or -1.
 * A ray that starts inside the cylinder hits at t = 0 so point-blank shots connect.
 */
export function rayCylinderY(ox, oy, oz, dx, dy, dz, maxT, cx, cy, cz, radius, height) {
  const ex = ox - cx;
  const ez = oz - cz;
  if (ex * ex + ez * ez <= radius * radius && oy >= cy && oy <= cy + height) return 0;
  const a = dx * dx + dz * dz;
  if (a < 1e-8) return -1;
  const b = 2 * (ex * dx + ez * dz);
  const c = ex * ex + ez * ez - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = (-b - s) / (2 * a);
  if (t < 0 || t > maxT) t = (-b + s) / (2 * a);
  if (t < 0 || t > maxT) return -1;
  const y = oy + dy * t;
  if (y < cy || y > cy + height) return -1;
  return t;
}

export function hasLineOfSight(ax, ay, az, bx, by, bz, boxes, hit) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return true;
  const inv = 1 / len;
  return !raycastClosest(ax, ay, az, dx * inv, dy * inv, dz * inv, len - 0.05, boxes, hit);
}

void _push;
