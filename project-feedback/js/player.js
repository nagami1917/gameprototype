/**
 * player.js
 * Player state, look, health. Movement math lives in movement.js so this
 * file stays a thin owner of the body. No Three.js — the camera is a view.
 */
import { CFG } from './config.js';
import { createContact } from './collision.js';

export function createPlayer() {
  return {
    x: 0,
    y: 0,
    z: 9,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    onGround: true,
    alive: true,
    hp: CFG.maxHp,
    maxHp: CFG.maxHp,
    radius: CFG.radius,
    height: CFG.standHeight,
    eye: CFG.standEye,
    wallKicks: 0,
    touchingWall: false,
    wallNx: 0,
    wallNz: 1,
    wallLock: 0,
    coyote: CFG.coyote,
    jumpBuffer: 0,
    justLanded: false,
    justJumped: false,
    justWallJump: false,
    slamImpact: false,
    forcedCrouch: false,
    speed: 0,
    airTime: 0,
    hurt: 0,
    _contact: createContact(),
  };
}

export function resetPlayer(p, x, z, yaw) {
  p.x = x;
  p.y = 0;
  p.z = z;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.yaw = yaw;
  p.pitch = 0;
  p.onGround = true;
  p.alive = true;
  p.hp = p.maxHp;
  p.height = CFG.standHeight;
  p.eye = CFG.standEye;
  p.wallKicks = 0;
  p.touchingWall = false;
  p.wallLock = 0;
  p.coyote = CFG.coyote;
  p.jumpBuffer = 0;
  p.justLanded = false;
  p.justJumped = false;
  p.justWallJump = false;
  p.slamImpact = false;
  p.forcedCrouch = false;
  p.speed = 0;
  p.airTime = 0;
  p.hurt = 0;
}

export function lookPlayer(p, dx, dy, sens, invert) {
  if (!p.alive) return;
  const k = CFG.look * sens;
  p.yaw -= dx * k;
  p.pitch -= dy * k * (invert ? -1 : 1);
  if (p.pitch > CFG.pitchLimit) p.pitch = CFG.pitchLimit;
  if (p.pitch < -CFG.pitchLimit) p.pitch = -CFG.pitchLimit;
}

/** Returns damage applied, 0 if ignored, -1 if this hit killed. */
export function hurtPlayer(p, amount) {
  if (!p.alive || amount <= 0) return 0;
  p.hp -= amount;
  p.hurt = 0.42;
  if (p.hp <= 0) {
    p.hp = 0;
    p.alive = false;
    p.vx = 0;
    p.vz = 0;
    return -1;
  }
  return amount;
}

export function healPlayer(p, amount) {
  if (!p.alive || amount <= 0) return 0;
  const before = p.hp;
  p.hp = Math.min(p.maxHp, p.hp + amount);
  return p.hp - before;
}
