/**
 * collision.js
 * ------------------------------------------------------------------
 * Lightweight, allocation-free collision helpers.
 *
 * World model:
 *   - Every solid object is an axis-aligned box (AABB) created with
 *     `createBox`. Boxes carry a `tag` (wall, crate, door, ...) and an
 *     `active` flag so doors can open/close their collider.
 *   - Actors (player and enemies) are vertical cylinders: a circle in
 *     the XZ plane that spans [feetY, feetY + height].
 *
 * Exposed helpers:
 *   - resolveCylinder / moveCylinder  -> walk without passing through solids
 *   - raycastBoxes                     -> hitscan / line-of-sight queries
 *   - hasLineOfSight                   -> cheap visibility test for AI
 */

/** Creates a static AABB collider. */
export function createBox(minX, minY, minZ, maxX, maxY, maxZ, tag = 'static') {
  return { minX, minY, minZ, maxX, maxY, maxZ, tag, active: true };
}

/** Creates an AABB from a centre point and full size. */
export function boxFromCenter(cx, cy, cz, sx, sy, sz, tag = 'static') {
  return createBox(
    cx - sx / 2, cy - sy / 2, cz - sz / 2,
    cx + sx / 2, cy + sy / 2, cz + sz / 2,
    tag,
  );
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Pushes a vertical cylinder out of every overlapping active box.
 * `pos` is any object with x/y/z (feet position). Only X and Z are
 * modified; Y is the feet height and is never touched.
 * Returns true when at least one collision was resolved.
 */
export function resolveCylinder(pos, radius, height, boxes) {
  const feetY = pos.y;
  const headY = feetY + height;
  let collided = false;

  // Several passes so that resolving one box does not leave us inside another (corners).
  for (let iter = 0; iter < 3; iter++) {
    let any = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.active) continue;
      // Ignore boxes entirely above or below the actor.
      if (b.maxY <= feetY + 0.02 || b.minY >= headY) continue;

      const cx = clamp(pos.x, b.minX, b.maxX);
      const cz = clamp(pos.z, b.minZ, b.maxZ);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;

      if (d2 > 1e-12) {
        // Centre is outside the box: push along the separating normal.
        const d = Math.sqrt(d2);
        const push = radius - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
      } else {
        // Centre is inside the box: exit through the closest face.
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
      any = true;
      collided = true;
    }
    if (!any) break;
  }
  return collided;
}

/**
 * Moves a cylinder by (dx, dz) in small sub-steps, resolving collisions
 * after each axis-separated step so the actor slides along walls instead
 * of stopping dead. Sub-stepping prevents tunnelling through thin geometry.
 */
export function moveCylinder(pos, dx, dz, radius, height, boxes) {
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) {
    resolveCylinder(pos, radius, height, boxes);
    return;
  }
  const steps = Math.max(1, Math.ceil(dist / 0.12));
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    pos.x += sx;
    resolveCylinder(pos, radius, height, boxes);
    pos.z += sz;
    resolveCylinder(pos, radius, height, boxes);
  }
}

/** True when a circle of `radius` at (x, z) overlaps no active box spanning height y..y+h. */
export function isCircleFree(x, z, radius, y, height, boxes) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b.active) continue;
    if (b.maxY <= y || b.minY >= y + height) continue;
    const cx = clamp(x, b.minX, b.maxX);
    const cz = clamp(z, b.minZ, b.maxZ);
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < radius * radius) return false;
  }
  return true;
}

/**
 * Slab-test a ray against one box.
 * Direction must be normalised. Returns { t, axis, sign } or null.
 * `axis` is the 0/1/2 index of the face that was entered (for normals).
 */
function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sign = 0;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ox < b.minX || ox > b.maxX) return null;
  } else {
    let t1 = (b.minX - ox) / dx;
    let t2 = (b.maxX - ox) / dx;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (oy < b.minY || oy > b.maxY) return null;
  } else {
    let t1 = (b.minY - oy) / dy;
    let t2 = (b.maxY - oy) / dy;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (oz < b.minZ || oz > b.maxZ) return null;
  } else {
    let t1 = (b.minZ - oz) / dz;
    let t2 = (b.maxZ - oz) / dz;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null; // origin inside the box
  return { t: tmin, axis, sign };
}

/**
 * Finds the nearest box hit by a ray.
 * Returns { distance, point:{x,y,z}, normal:{x,y,z}, box } or null.
 */
export function raycastBoxes(origin, dir, maxDist, boxes) {
  let best = null;
  let bestT = maxDist;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b.active) continue;
    const hit = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b, bestT);
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      best = { box: b, axis: hit.axis, sign: hit.sign, t: hit.t };
    }
  }
  if (!best) return null;
  const normal = { x: 0, y: 0, z: 0 };
  if (best.axis === 0) normal.x = best.sign;
  else if (best.axis === 1) normal.y = best.sign;
  else normal.z = best.sign;
  return {
    distance: best.t,
    box: best.box,
    normal,
    point: {
      x: origin.x + dir.x * best.t,
      y: origin.y + dir.y * best.t,
      z: origin.z + dir.z * best.t,
    },
  };
}

/** True when no active box blocks the straight segment a -> b. */
export function hasLineOfSight(a, b, boxes) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const inv = 1 / len;
  const dir = { x: dx * inv, y: dy * inv, z: dz * inv };
  const hit = raycastBoxes(a, dir, len - 0.05, boxes);
  return hit === null;
}
