/**
 * enemyAI.js
 * ------------------------------------------------------------------
 * Enemy decision making and navigation.
 *
 * NavGrid  - a 1 m walkability grid baked from the static colliders.
 *            Cells touching a wall/crate (inflated by the agent radius)
 *            are blocked. A* over the grid gives paths that go around
 *            obstacles; the path is then smoothed with line-of-sight tests.
 *
 * EnemyAI  - per-enemy state logic:
 *              idle/wander  -> aggro (sight, noise, or wave hunt)
 *              chase        -> direct steering when visible, A* otherwise
 *              attack       -> telegraphed windup, then damage if in reach
 *              hurt         -> short stagger after being shot
 *            Movement always goes through moveCylinder(), so enemies can
 *            never walk through walls, crates or closed doors - including the
 *            knockback shove of a sledgehammer blow, which is integrated here
 *            and decays away over a third of a second.
 */
import { moveCylinder, hasLineOfSight } from './collision.js';
import { KNOCKBACK_DECAY } from './enemy.js';

export const PLAYER_RADIUS = 0.36;
const PATH_REFRESH = 0.7;      // seconds between full path recalculations
const SEPARATION_RADIUS = 0.85; // personal space between enemies
const LOS_REFRESH = 0.25;      // seconds between line-of-sight checks
const SQRT2 = Math.SQRT2;

/* ---------- small binary min-heap used by A* ---------- */
class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  clear() {
    this.keys.length = 0;
    this.vals.length = 0;
  }
  push(key, val) {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const k = this.keys;
    const v = this.vals;
    const topVal = v[0];
    const lastKey = k.pop();
    const lastVal = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        let mk = lastKey;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lastKey;
      v[i] = lastVal;
    }
    return topVal;
  }
}

/** Walkability grid + A* pathfinding in world XZ coordinates. */
export class NavGrid {
  /**
   * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} bounds
   * @param {number} cell  node size in metres (1.0 is a good default)
   * @param {Array} boxes  static colliders (doors excluded by the caller)
   * @param {number} agentRadius  clearance kept from obstacles
   */
  constructor(bounds, cell, boxes, agentRadius) {
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.cell = cell;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.count = this.cols * this.rows;
    this.walkable = new Uint8Array(this.count);
    this.g = new Float32Array(this.count);
    this.cameFrom = new Int32Array(this.count);
    this.closed = new Uint8Array(this.count);
    this.heap = new MinHeap();

    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const cx = this.minX + (i + 0.5) * cell;
        const cz = this.minZ + (j + 0.5) * cell;
        this.walkable[j * this.cols + i] = this.isClear(cx, cz, agentRadius, boxes) ? 1 : 0;
      }
    }
  }

  /** True when no box is closer than `radius` to (x, z). */
  isClear(x, z, radius, boxes) {
    for (const b of boxes) {
      if (!b.active) continue;
      const cx = Math.min(Math.max(x, b.minX), b.maxX);
      const cz = Math.min(Math.max(z, b.minZ), b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) return false;
    }
    return true;
  }

  indexOf(x, z) {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1;
    return j * this.cols + i;
  }

  isWalkableWorld(x, z) {
    const idx = this.indexOf(x, z);
    return idx >= 0 && this.walkable[idx] === 1;
  }

  nodeCenter(idx) {
    const i = idx % this.cols;
    const j = (idx - i) / this.cols;
    return {
      x: this.minX + (i + 0.5) * this.cell,
      z: this.minZ + (j + 0.5) * this.cell,
    };
  }

  /** Nearest walkable node index to (x, z), searching outward ring by ring. */
  nearestWalkable(x, z, maxRadius = 4) {
    const idx = this.indexOf(x, z);
    if (idx >= 0 && this.walkable[idx]) return idx;
    const ci = Math.floor((x - this.minX) / this.cell);
    const cj = Math.floor((z - this.minZ) / this.cell);
    for (let r = 1; r <= maxRadius; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
          const n = j * this.cols + i;
          if (this.walkable[n]) return n;
        }
      }
    }
    return -1;
  }

  /** Samples the segment a->b on the grid; true if every sample is walkable. */
  lineWalkable(ax, az, bx, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(dist / 0.25));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (!this.isWalkableWorld(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return this.isWalkableWorld(bx, bz);
  }

  /**
   * A* from world (sx, sz) to (gx, gz).
   * Returns an array of smoothed world waypoints (excluding the start),
   * or null when no route exists.
   */
  findPath(sx, sz, gx, gz, maxIterations = 4000) {
    let start = this.nearestWalkable(sx, sz);
    let goal = this.nearestWalkable(gx, gz);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [{ x: gx, z: gz }];

    const g = this.g;
    const cameFrom = this.cameFrom;
    const closed = this.closed;
    g.fill(Infinity);
    cameFrom.fill(-1);
    closed.fill(0);

    const heap = this.heap;
    heap.clear();
    const goalPos = this.nodeCenter(goal);
    const h = (n) => {
      const c = this.nodeCenter(n);
      const dx = Math.abs(c.x - goalPos.x) / this.cell;
      const dz = Math.abs(c.z - goalPos.z) / this.cell;
      return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz); // octile distance
    };

    g[start] = 0;
    heap.push(h(start), start);
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];
    let iterations = 0;
    let found = false;

    while (heap.size > 0 && iterations++ < maxIterations) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      if (cur === goal) { found = true; break; }
      closed[cur] = 1;
      const ci = cur % this.cols;
      const cj = (cur - ci) / this.cols;

      for (const [di, dj, cost] of dirs) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) continue;
        const n = nj * this.cols + ni;
        if (!this.walkable[n] || closed[n]) continue;
        // Forbid corner cutting on diagonals.
        if (di !== 0 && dj !== 0) {
          if (!this.walkable[cj * this.cols + ni] || !this.walkable[nj * this.cols + ci]) continue;
        }
        const tentative = g[cur] + cost;
        if (tentative < g[n]) {
          g[n] = tentative;
          cameFrom[n] = cur;
          heap.push(tentative + h(n), n);
        }
      }
    }
    if (!found) return null;

    // Reconstruct node chain (goal -> start), then reverse.
    const chain = [];
    for (let n = goal; n !== -1; n = cameFrom[n]) chain.push(this.nodeCenter(n));
    chain.reverse();
    chain.shift(); // drop start node
    chain.push({ x: gx, z: gz });
    return this.smooth(sx, sz, chain);
  }

  /** Greedy line-of-sight smoothing: skip intermediate points when the grid allows. */
  smooth(sx, sz, points) {
    const out = [];
    let ax = sx;
    let az = sz;
    let i = 0;
    while (i < points.length) {
      let far = i;
      for (let j = points.length - 1; j > i; j--) {
        if (this.lineWalkable(ax, az, points[j].x, points[j].z)) { far = j; break; }
      }
      out.push(points[far]);
      ax = points[far].x;
      az = points[far].z;
      i = far + 1;
    }
    return out;
  }
}

/** Angle helper. */
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class EnemyAI {
  /**
   * Advances one enemy by dt.
   * @param {import('./enemy.js').Enemy} e
   * @param {number} dt
   * @param {object} w  world context:
   *   player      Player instance (position, alive)
   *   colliders   array of boxes
   *   nav         NavGrid
   *   enemies     all enemies (for separation)
   *   time        game time (s)
   *   noise       {x,z,time} of the last gunshot, or null
   *   huntAll     true once the wave has run long enough to force aggro
   *   requestPath() -> bool, budgeted pathfinding per frame
   *   damagePlayer(amount, enemy)
   */
  update(e, dt, w) {
    if (e.state === 'spawn' || e.state === 'death') return;
    // ---- 0. Knockback: a sledgehammer shove, applied before any state logic, so
    // a staggering blow still slides the body and an armoured enemy that cannot
    // be staggered is still pushed out of its own attack reach. moveCylinder()
    // keeps walls solid: a body can be slammed into a wall, never through one.
    if (e.isKnockedBack()) {
      moveCylinder(e.position, e.knockX * dt, e.knockZ * dt, e.type.radius, e.type.height, w.colliders);
      const decay = Math.exp(-KNOCKBACK_DECAY * dt);
      e.knockX *= decay;
      e.knockZ *= decay;
      // Below a few centimetres per second the shove is over; zeroing it keeps
      // the per-frame check (`isKnockedBack`) from running forever.
      if (Math.hypot(e.knockX, e.knockZ) < 0.05) {
        e.knockX = 0;
        e.knockZ = 0;
      }
    }
    const p = w.player;
    const px = p.position.x;
    const pz = p.position.z;
    const ex = e.position.x;
    const ez = e.position.z;
    const dx = px - ex;
    const dz = pz - ez;
    const dist = Math.hypot(dx, dz);
    const type = e.type;

    // ---- 1. Perception (line of sight is throttled) ----
    e.losTimer -= dt;
    if (e.losTimer <= 0) {
      e.losTimer = LOS_REFRESH + Math.random() * 0.1;
      e.canSee = p.alive && dist < type.detectionRange &&
        hasLineOfSight({ x: ex, y: 1.5, z: ez }, { x: px, y: 1.2, z: pz }, w.colliders);
    }
    if (!p.alive) e.canSee = false;

    // ---- 2. Aggro: spotted, heard, or forced by the wave timer ----
    if (!e.aggro) {
      if (e.canSee) {
        e.aggro = true;
      } else if (w.noise && w.time - w.noise.time < 1.5 &&
                 Math.hypot(w.noise.x - ex, w.noise.z - ez) < 28) {
        e.aggro = true; // heard gunfire nearby
      } else if (w.huntAll && dist < 70) {
        e.aggro = true;
      }
      if (e.aggro) e.lastSeen = w.time;
    } else {
      if (e.canSee) e.lastSeen = w.time;
      // Lose track after a long time out of sight and far away.
      if (w.time - e.lastSeen > 10 && dist > 34 && !w.huntAll) e.aggro = false;
    }

    if (!e.aggro) {
      this.wander(e, dt, w);
      return;
    }

    // ---- 3. Hurt: brief stagger, no movement ----
    if (e.state === 'hurt') {
      e.hurtTimer -= dt;
      e.moveSpeed = 0;
      this.faceTowards(e, dx, dz, dt, 8);
      if (e.hurtTimer <= 0) e.setState('chase');
      return;
    }

    // ---- 4. Attack windup: commit to the strike ----
    if (e.state === 'attack') {
      e.attackTimer -= dt;
      e.moveSpeed = 0;
      this.faceTowards(e, dx, dz, dt, 12);
      if (e.attackTimer <= 0) {
        const reach = type.radius + PLAYER_RADIUS + type.attackRange + 0.25;
        if (p.alive && dist <= reach) w.damagePlayer(e.damage, e);
        e.cooldown = type.attackCooldown;
        e.setState('chase');
      }
      return;
    }

    // ---- 5. Start an attack when in reach and off cooldown ----
    e.cooldown -= dt;
    const reach = type.radius + PLAYER_RADIUS + type.attackRange;
    if (p.alive && dist <= reach && e.cooldown <= 0) {
      e.setState('attack');
      e.attackTimer = type.windup;
      e.attackWindup = type.windup;
      e.moveSpeed = 0;
      this.faceTowards(e, dx, dz, dt, 12);
      return;
    }

    // ---- 6. Chase movement ----
    e.setState('chase');
    let mx = 0;
    let mz = 0;
    const tooClose = dist < type.radius + PLAYER_RADIUS + 0.15;
    if (!tooClose) {
      if (e.canSee && dist < 16) {
        // Clear line of sight: steer straight at the player.
        e.path = null;
        mx = dx / dist;
        mz = dz / dist;
      } else {
        const d = this.followPath(e, w, px, pz);
        mx = d.x;
        mz = d.z;
      }
    }

    // Unstick: after repeated non-progress, sidestep for a moment.
    e.unstickTimer = Math.max(0, e.unstickTimer - dt);
    if (e.unstickTimer > 0) {
      mx = mx * 0.3 + e.unstickDir.x;
      mz = mz * 0.3 + e.unstickDir.z;
    }
    this.checkStuck(e, dt, w, dist, reach);

    // Separation keeps packs from stacking on a single tile.
    let sx = 0;
    let sz = 0;
    for (const o of w.enemies) {
      if (o === e || o.state === 'death' || o.state === 'spawn') continue;
      const ox = ex - o.position.x;
      const oz = ez - o.position.z;
      const d2 = ox * ox + oz * oz;
      if (d2 > 1e-6 && d2 < SEPARATION_RADIUS * SEPARATION_RADIUS) {
        const d = Math.sqrt(d2);
        const f = (SEPARATION_RADIUS - d) / SEPARATION_RADIUS;
        sx += (ox / d) * f;
        sz += (oz / d) * f;
      }
    }
    mx += sx * 0.9;
    mz += sz * 0.9;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1e-4) {
      mx /= mlen;
      mz /= mlen;
    }

    const speed = e.chaseSpeed;
    const stepX = mx * speed * dt;
    const stepZ = mz * speed * dt;
    const before = { x: e.position.x, z: e.position.z };
    moveCylinder(e.position, stepX, stepZ, type.radius, type.height, w.colliders);
    const moved = Math.hypot(e.position.x - before.x, e.position.z - before.z);
    e.moveSpeed = moved / Math.max(dt, 1e-4);

    if (mlen > 1e-4) this.faceTowards(e, mx, mz, dt, 8);
    else this.faceTowards(e, dx, dz, dt, 8);
  }

  /** Idle behaviour: stay near spawn and amble to random nearby points. */
  wander(e, dt, w) {
    if (e.state !== 'idle') e.setState('idle');
    e.wanderTimer -= dt;
    if (e.wanderTimer <= 0 || !e.wanderTarget) {
      e.wanderTimer = 2.5 + Math.random() * 3;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 3;
      const tx = e.home.x + Math.cos(a) * r;
      const tz = e.home.z + Math.sin(a) * r;
      e.wanderTarget = w.nav.isWalkableWorld(tx, tz) ? { x: tx, z: tz } : { x: e.home.x, z: e.home.z };
    }
    const dx = e.wanderTarget.x - e.position.x;
    const dz = e.wanderTarget.z - e.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.2) {
      e.moveSpeed = 0;
      return;
    }
    const step = Math.min(d, e.wanderSpeed * dt);
    const before = { x: e.position.x, z: e.position.z };
    moveCylinder(e.position, (dx / d) * step, (dz / d) * step, e.type.radius, e.type.height, w.colliders);
    const moved = Math.hypot(e.position.x - before.x, e.position.z - before.z);
    e.moveSpeed = moved / Math.max(dt, 1e-4);
    this.faceTowards(e, dx, dz, dt, 4);
  }

  /** Returns a unit movement direction following the A* path (or zero). */
  followPath(e, w, px, pz) {
    const needNew =
      !e.path ||
      w.time >= e.nextPathTime ||
      (e.pathGoal && Math.hypot(e.pathGoal.x - px, e.pathGoal.z - pz) > 2.0);
    if (needNew && w.requestPath()) {
      e.path = w.nav.findPath(e.position.x, e.position.z, px, pz);
      e.pathIndex = 0;
      e.pathGoal = { x: px, z: pz };
      e.nextPathTime = w.time + PATH_REFRESH;
    }
    if (e.path && e.pathIndex < e.path.length) {
      let wp = e.path[e.pathIndex];
      let wx = wp.x - e.position.x;
      let wz = wp.z - e.position.z;
      let d = Math.hypot(wx, wz);
      if (d < 0.35 && e.pathIndex < e.path.length - 1) {
        e.pathIndex++;
        wp = e.path[e.pathIndex];
        wx = wp.x - e.position.x;
        wz = wp.z - e.position.z;
        d = Math.hypot(wx, wz);
      }
      if (d > 1e-4) return { x: wx / d, z: wz / d };
    }
    // No usable path: head straight for the player and let collisions slide us.
    const dx = px - e.position.x;
    const dz = pz - e.position.z;
    const d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d };
  }

  /** Detects enemies that stopped making progress and forces a re-route. */
  checkStuck(e, dt, w, dist, reach) {
    e.stuckSampleTimer -= dt;
    if (e.stuckSampleTimer > 0) return;
    e.stuckSampleTimer = 0.8;
    const moved = Math.hypot(e.position.x - e.sampleX, e.position.z - e.sampleZ);
    e.sampleX = e.position.x;
    e.sampleZ = e.position.z;
    if (moved < 0.15 && dist > reach && e.unstickTimer <= 0) {
      e.stuckCount++;
    } else {
      e.stuckCount = 0;
    }
    if (e.stuckCount >= 2) {
      e.stuckCount = 0;
      e.path = null;
      e.unstickTimer = 0.7;
      const side = Math.random() < 0.5 ? 1 : -1;
      const dx = w.player.position.x - e.position.x;
      const dz = w.player.position.z - e.position.z;
      const d = Math.hypot(dx, dz) || 1;
      // Perpendicular to the player direction
      e.unstickDir = { x: (-dz / d) * side, z: (dx / d) * side };
    }
  }

  faceTowards(e, dx, dz, dt, rate) {
    if (Math.abs(dx) + Math.abs(dz) < 1e-5) return;
    const target = Math.atan2(dx, dz);
    e.turnToward(target, dt, rate);
  }

  /** Exposed for tests. */
  static wrap(a) {
    return wrapAngle(a);
  }
}
