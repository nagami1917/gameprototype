/**
 * dash.js
 * Three charges. Only one recharges at a time, over dashRecharge seconds.
 * The dash itself is a velocity override owned by movement via env.dashActive.
 */
import { CFG } from './config.js';

export function createDash() {
  return {
    charges: CFG.dashCharges,
    max: CFG.dashCharges,
    recharge: 0,
    active: 0,
    iFrames: 0,
    dx: 0,
    dz: -1,
    dodged: false,
  };
}

export function resetDash(d) {
  d.charges = d.max;
  d.recharge = 0;
  d.active = 0;
  d.iFrames = 0;
  d.dodged = false;
  d.dx = 0;
  d.dz = -1;
}

/**
 * Direction is the current wish vector, or look-forward when there is no input.
 * Returns false when a charge is unavailable or a dash is already running.
 */
export function tryDash(d, wishX, wishZ, forwardX, forwardZ) {
  if (d.charges < 1 || d.active > 0) return false;
  let x = wishX;
  let z = wishZ;
  if (Math.hypot(x, z) < 0.12) {
    x = forwardX;
    z = forwardZ;
  }
  const len = Math.hypot(x, z) || 1;
  d.dx = x / len;
  d.dz = z / len;
  d.charges -= 1;
  d.active = CFG.dashTime;
  d.iFrames = CFG.dashIFrames;
  d.dodged = false;
  if (d.recharge <= 0 && d.charges < d.max) d.recharge = CFG.dashRecharge;
  return true;
}

export function tickDash(d, dt) {
  if (d.active > 0) d.active = Math.max(0, d.active - dt);
  if (d.iFrames > 0) d.iFrames = Math.max(0, d.iFrames - dt);
  if (d.charges >= d.max) {
    d.recharge = 0;
    return;
  }
  if (d.recharge <= 0) d.recharge = CFG.dashRecharge;
  d.recharge -= dt;
  if (d.recharge <= 0) {
    d.charges += 1;
    d.recharge = d.charges < d.max ? CFG.dashRecharge : 0;
  }
}

export function refillDash(d) {
  d.charges = d.max;
  d.recharge = 0;
}

/** 0..1 fill of the charge currently recharging. Full charges report 1. */
export function dashRechargeFraction(d) {
  if (d.charges >= d.max || d.recharge <= 0) return 1;
  return 1 - d.recharge / CFG.dashRecharge;
}
