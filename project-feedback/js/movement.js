/**
 * movement.js
 * Quake-style accelerate / friction and the player integration step.
 * Extra speed (dash, slide, rocket) is not clamped back to walk speed —
 * friction bleeds it. That is the slippery feel.
 */
import { CFG } from './config.js';
import { fitsHeight, moveBody } from './collision.js';

export function accelerate(vx, vz, wishX, wishZ, wishSpeed, accel, dt) {
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen < 1e-6 || wishSpeed <= 0 || accel <= 0) return { vx, vz };
  const dx = wishX / wishLen;
  const dz = wishZ / wishLen;
  const current = vx * dx + vz * dz;
  const add = wishSpeed - current;
  if (add <= 0) return { vx, vz };
  let a = accel * dt;
  if (a > add) a = add;
  return { vx: vx + dx * a, vz: vz + dz * a };
}

export function applyFriction(vx, vz, friction, dt, stopSpeed) {
  const speed = Math.hypot(vx, vz);
  if (speed < 1e-4) return { vx: 0, vz: 0 };
  if (friction <= 0) return { vx, vz };
  const control = speed < stopSpeed ? stopSpeed : speed;
  const drop = control * friction * dt;
  const next = Math.max(0, speed - drop);
  const scale = next / speed;
  return { vx: vx * scale, vz: vz * scale };
}

export function wallJumpVelocity(vx, vz, nx, nz, wishX, wishZ, env) {
  let ax = nx;
  let az = nz;
  if (ax * ax + az * az < 1e-6) {
    ax = -vx;
    az = -vz;
  }
  if (ax * ax + az * az < 1e-6) {
    ax = 0;
    az = 1;
  }
  const wlen = Math.hypot(wishX, wishZ);
  if (wlen > 0.2) {
    ax += (wishX / wlen) * 0.45;
    az += (wishZ / wlen) * 0.45;
  }
  const al = Math.hypot(ax, az) || 1;
  ax /= al;
  az /= al;
  const incoming = Math.hypot(vx, vz);
  const launch = Math.max(env.wallJumpSpeed, incoming * 0.82);
  return { vx: ax * launch, vz: az * launch, vy: env.wallJumpUp };
}

export function fillEnv(env) {
  env.gravity = CFG.gravity;
  env.jumpSpeed = CFG.jumpSpeed;
  env.wallJumpSpeed = CFG.wallJumpSpeed;
  env.wallJumpUp = CFG.wallJumpUp;
  env.maxWallKicks = CFG.maxWallKicks;
  env.wallLock = CFG.wallLock;
  env.coyote = CFG.coyote;
  env.jumpBuffer = CFG.jumpBuffer;
  env.groundSpeed = CFG.groundSpeed;
  env.airSpeed = CFG.airSpeed;
  env.groundAccel = CFG.groundAccel;
  env.airAccel = CFG.airAccel;
  env.groundFriction = CFG.groundFriction;
  env.airFriction = CFG.airFriction;
  env.stopSpeed = CFG.stopSpeed;
  env.softCap = CFG.softCap;
  env.standHeight = CFG.standHeight;
  env.standEye = CFG.standEye;
  env.crouchHeight = CFG.crouchHeight;
  env.crouchEye = CFG.crouchEye;
  env.dashSpeed = CFG.dashSpeed;
  env.slamSpeed = CFG.slamSpeed;
  env.slamBounce = CFG.slamBounce;
  env.slideBoostSpeed = CFG.slideBoost;
  env.dashActive = false;
  env.dashX = 0;
  env.dashZ = 1;
  env.slamming = false;
  env.frictionScale = 1;
  env.forceCrouch = false;
  env.slideBoost = false;
  env.forwardX = 0;
  env.forwardZ = -1;
  return env;
}

function capSpeed(p, cap, dt) {
  const sp = Math.hypot(p.vx, p.vz);
  if (sp <= cap || sp < 1e-6) return;
  const excess = sp - cap;
  const drop = Math.min(sp - cap * 0.5, excess * dt * 1.6);
  const ns = sp - drop;
  p.vx *= ns / sp;
  p.vz *= ns / sp;
}

/**
 * One movement tick. Mutates `p`. Jump never touches horizontal velocity,
 * so leaving a slide keeps the speed you had.
 */
export function integratePlayer(p, dt, input, env, boxes) {
  p.justLanded = false;
  p.justJumped = false;
  p.justWallJump = false;
  p.slamImpact = false;

  if (p.wallLock > 0) p.wallLock = Math.max(0, p.wallLock - dt);
  if (p.hurt > 0) p.hurt = Math.max(0, p.hurt - dt);
  if (!p.onGround && p.coyote > 0) p.coyote = Math.max(0, p.coyote - dt);
  if (p.jumpBuffer > 0) p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  if (input.jumpPressed) p.jumpBuffer = env.jumpBuffer;

  const canStand = fitsHeight(p.x, p.y, p.z, p.radius, env.standHeight, boxes);
  const crouched = env.forceCrouch || !canStand;
  p.forcedCrouch = crouched && !env.forceCrouch;
  p.height = crouched ? env.crouchHeight : env.standHeight;
  const eyeTarget = crouched ? env.crouchEye : env.standEye;
  p.eye += (eyeTarget - p.eye) * (1 - Math.exp(-14 * dt));

  let wx = input.wishX;
  let wz = input.wishZ;
  const wlen = Math.hypot(wx, wz);
  if (wlen > 1) {
    wx /= wlen;
    wz /= wlen;
  }

  if (env.slideBoost) {
    const sp = Math.hypot(p.vx, p.vz);
    if (sp < env.slideBoostSpeed) {
      let bx = wlen > 0.15 ? wx : env.forwardX;
      let bz = wlen > 0.15 ? wz : env.forwardZ;
      const bl = Math.hypot(bx, bz) || 1;
      p.vx = (bx / bl) * env.slideBoostSpeed;
      p.vz = (bz / bl) * env.slideBoostSpeed;
    }
  }

  if (env.dashActive) {
    p.vx = env.dashX * env.dashSpeed;
    p.vz = env.dashZ * env.dashSpeed;
    // Dash suppresses gravity and levels out vertical speed.
    p.vy *= Math.exp(-12 * dt);
  } else {
    const fr = p.onGround ? env.groundFriction * env.frictionScale : env.airFriction;
    const f = applyFriction(p.vx, p.vz, fr, dt, env.stopSpeed);
    p.vx = f.vx;
    p.vz = f.vz;
    if (wlen > 0.01) {
      const accel = p.onGround ? env.groundAccel : env.airAccel;
      const wishSpeed = p.onGround ? env.groundSpeed : env.airSpeed;
      const a = accelerate(p.vx, p.vz, wx, wz, wishSpeed, accel, dt);
      p.vx = a.vx;
      p.vz = a.vz;
    }
  }

  if (p.jumpBuffer > 0 && p.wallLock <= 0 && !p.onGround && p.coyote <= 0
      && p.touchingWall && p.wallKicks < env.maxWallKicks) {
    const wj = wallJumpVelocity(p.vx, p.vz, p.wallNx, p.wallNz, wx, wz, env);
    p.vx = wj.vx;
    p.vz = wj.vz;
    p.vy = wj.vy;
    p.wallKicks += 1;
    p.wallLock = env.wallLock;
    p.jumpBuffer = 0;
    p.onGround = false;
    p.justWallJump = true;
    p.justJumped = true;
  } else if (p.jumpBuffer > 0 && (p.onGround || p.coyote > 0)) {
    p.vy = env.jumpSpeed;
    p.onGround = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
    p.justJumped = true;
  }

  if (!env.dashActive && !p.onGround) p.vy -= env.gravity * dt;
  if (env.slamming && !p.onGround && p.vy > -env.slamSpeed) p.vy = -env.slamSpeed;

  capSpeed(p, env.softCap, dt);

  const wasGround = p.onGround;
  const contact = moveBody(p, dt, boxes, p._contact);
  if (contact.wall) {
    p.touchingWall = true;
    p.wallNx = contact.nx;
    p.wallNz = contact.nz;
  } else {
    p.touchingWall = false;
  }

  const landed = contact.grounded && !wasGround;
  p.justLanded = landed;

  if (env.slamming && landed) {
    p.vy = env.slamBounce;
    p.onGround = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
    p.slamImpact = true;
    p.wallKicks = 0;
  } else if (contact.grounded) {
    p.onGround = true;
    p.wallKicks = 0;
    p.coyote = env.coyote;
    if (p.vy < 0) p.vy = 0;
  } else {
    p.onGround = false;
  }

  if (contact.ceiling && p.vy > 0) p.vy = 0;

  p.speed = Math.hypot(p.vx, p.vz);
  if (p.onGround) p.airTime = 0;
  else p.airTime += dt;

  if (p.x < -36) p.x = -36;
  if (p.x > 36) p.x = 36;
  if (p.z < -36) p.z = -36;
  if (p.z > 36) p.z = 36;
}

export function aimDir(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

export function flatForward(yaw, out) {
  out.x = -Math.sin(yaw);
  out.y = 0;
  out.z = -Math.cos(yaw);
  return out;
}

export function flatRight(yaw, out) {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

/** Cone spread around a direction. Writes `out` and returns it. */
export function applySpread(dx, dy, dz, spread, out) {
  if (spread <= 0) {
    out.x = dx;
    out.y = dy;
    out.z = dz;
    return out;
  }
  let sx;
  let sy;
  let sz;
  if (Math.abs(dy) < 0.92) {
    sx = -dz;
    sy = 0;
    sz = dx;
  } else {
    sx = 1;
    sy = 0;
    sz = 0;
  }
  let sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl;
  sy /= sl;
  sz /= sl;
  const ux = dy * sz - dz * sy;
  const uy = dz * sx - dx * sz;
  const uz = dx * sy - dy * sx;
  const rx = (Math.random() - 0.5) * 2 * spread;
  const ry = (Math.random() - 0.5) * 2 * spread;
  out.x = dx + sx * rx + ux * ry;
  out.y = dy + sy * rx + uy * ry;
  out.z = dz + sz * rx + uz * ry;
  const len = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= len;
  out.y /= len;
  out.z /= len;
  return out;
}
