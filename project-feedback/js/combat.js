/**
 * combat.js
 * Hitscan resolution and close-range heal. Emits nothing; the composer
 * turns results into bus events so this stays testable without a DOM.
 */
import { raycastClosest, rayCylinderY } from './collision.js';

export function createHitBuffer(n) {
  return {
    count: 0,
    pierce: 0,
    index: new Int16Array(n),
    damage: new Float32Array(n),
    dist: new Float32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
  };
}

export function healAmount(damage, dist, range, fraction) {
  if (damage <= 0 || dist >= range) return 0;
  const t = 1 - dist / range;
  return damage * fraction * (0.55 + 0.45 * t);
}

export function shockwaveDamage(dist, radius, damage) {
  if (dist >= radius || dist < 0) return 0;
  return damage * (1 - (dist / radius) * 0.5);
}

export function blastImpulse(px, py, pz, x, y, z, radius, force, out) {
  const dx = px - x;
  const dy = (py + 0.9) - y;
  const dz = pz - z;
  const d = Math.hypot(dx, dy, dz);
  if (d > radius || d < 0.04) return false;
  const fall = 1 - d / radius;
  const inv = 1 / d;
  out.x = dx * inv * force * fall;
  out.y = Math.max(0.35, dy * inv) * force * fall;
  out.z = dz * inv * force * fall;
  return true;
}

/**
 * Fills `hits` with enemies along the ray, up to the first wall.
 * Non-pierce keeps only the nearest. End point is written to `ray`.
 */
export function resolveHitscan(ox, oy, oz, dx, dy, dz, range, pierce, boxes, enemies, hits, ray) {
  hits.count = 0;
  hits.pierce = pierce ? 1 : 0;
  const blocked = raycastClosest(ox, oy, oz, dx, dy, dz, range, boxes, ray);
  const wallT = blocked ? ray.t : range;
  let best = -1;
  let bestT = wallT;
  const list = enemies.list || enemies;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.alive) continue;
    const t = rayCylinderY(ox, oy, oz, dx, dy, dz, wallT, e.x, e.y, e.z, e.radius, e.height);
    if (t < 0) continue;
    if (pierce) {
      if (hits.count < hits.index.length) {
        hits.index[hits.count] = i;
        hits.dist[hits.count] = t;
        hits.x[hits.count] = ox + dx * t;
        hits.y[hits.count] = oy + dy * t;
        hits.z[hits.count] = oz + dz * t;
        hits.count += 1;
      }
    } else if (t < bestT) {
      bestT = t;
      best = i;
    }
  }
  if (!pierce && best >= 0) {
    hits.index[0] = best;
    hits.dist[0] = bestT;
    hits.x[0] = ox + dx * bestT;
    hits.y[0] = oy + dy * bestT;
    hits.z[0] = oz + dz * bestT;
    hits.count = 1;
  }
  const endT = pierce ? wallT : (best >= 0 ? bestT : wallT);
  ray.endX = ox + dx * endT;
  ray.endY = oy + dy * endT;
  ray.endZ = oz + dz * endT;
  ray.endT = endT;
  ray.hitWall = blocked && endT >= wallT - 1e-4 && (pierce || best < 0);
  return endT;
}
