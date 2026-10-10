/**
 * weapons.js
 * Loadout runtime: magazines, cooldowns, charge, burst, reload.
 * Firing produces shot descriptors. It does not touch enemies or meshes.
 * Switching cancels an in-progress fire (burst / charge) and any reload.
 */
import { CFG, WEAPONS } from './config.js';

const N = WEAPONS.length;

export function createWeapons() {
  return {
    mag: new Int16Array(N),
    cooldown: new Float32Array(N),
    reload: new Float32Array(N),
    reloading: new Uint8Array(N),
    charge: 0,
    charging: 0,
    burstLeft: 0,
    burstTimer: 0,
    heat: 0,
    equip: 0,
    index: 0,
  };
}

export function resetWeapons(w) {
  for (let i = 0; i < N; i++) {
    w.mag[i] = WEAPONS[i].mag || 0;
    w.cooldown[i] = 0;
    w.reload[i] = 0;
    w.reloading[i] = 0;
  }
  w.charge = 0;
  w.charging = 0;
  w.burstLeft = 0;
  w.burstTimer = 0;
  w.heat = 0;
  w.equip = 0;
  w.index = 0;
}

export function createShotBuffer() {
  const items = [];
  for (let i = 0; i < 4; i++) {
    items.push({
      mode: 'hitscan',
      damage: 0,
      range: 40,
      spread: 0,
      pellets: 1,
      pierce: 0,
      pointBlank: 0,
      pbMul: 1,
      splash: 0,
      splashR: 0,
      speed: 0,
      radius: 0.1,
      homing: 0,
      projKind: 0,
      life: 1.5,
      weaponId: 0,
      kind: 'pistol',
      charged: 0,
      beam: 0,
    });
  }
  return { count: 0, items };
}

export function cancelTransient(w) {
  w.burstLeft = 0;
  w.burstTimer = 0;
  w.charging = 0;
  w.charge = 0;
  for (let i = 0; i < N; i++) w.reloading[i] = 0;
  w.equip = CFG.equipTime;
}

function startReload(w, i) {
  const def = WEAPONS[i];
  if (!def.mag) return false;
  if (w.mag[i] >= def.mag) return false;
  if (w.reloading[i]) return false;
  w.reloading[i] = 1;
  w.reload[i] = def.reload;
  w.charging = 0;
  w.charge = 0;
  return true;
}

function finishReload(w, i) {
  const def = WEAPONS[i];
  if (def.reloadMode === 'shell') {
    if (w.mag[i] < def.mag) w.mag[i] += 1;
    if (w.mag[i] < def.mag) {
      w.reload[i] = def.reload;
      w.reloading[i] = 1;
    } else {
      w.reloading[i] = 0;
    }
  } else {
    w.mag[i] = def.mag;
    w.reloading[i] = 0;
  }
}

const _result = { fired: false, empty: false, reloadStarted: false };

function pushShot(out, def, idx, charged, heat) {
  if (out.count >= out.items.length) return null;
  const s = out.items[out.count++];
  s.mode = def.projKind ? 'projectile' : 'hitscan';
  s.damage = charged ? def.chargeDamage : def.damage;
  s.range = def.range || 40;
  s.spread = def.spread || 0;
  if (def.heatSpread) s.spread += def.heatSpread * heat;
  s.pellets = def.pellets || 1;
  s.pierce = charged ? 1 : (def.pierce || 0);
  s.pointBlank = def.pointBlank || 0;
  s.pbMul = def.pbMul || 1;
  s.splash = def.splash || 0;
  s.splashR = def.splashR || 0;
  s.speed = def.speed || 0;
  s.radius = def.radius || 0.1;
  s.homing = def.homing || 0;
  s.projKind = def.projKind || 0;
  s.life = def.life || 1.5;
  s.weaponId = idx;
  s.kind = def.kind;
  s.charged = charged ? 1 : 0;
  s.beam = def.beam || 0;
  return s;
}

function tryEmit(w, idx, out, charged) {
  const def = WEAPONS[idx];
  if (w.equip > 0) return 'blocked';
  if (w.cooldown[idx] > 0) return 'cooldown';
  if (def.mag) {
    if (w.reloading[idx]) {
      if (def.reloadMode === 'shell' && w.mag[idx] > 0) w.reloading[idx] = 0;
      else return 'reload';
    }
    if (w.mag[idx] <= 0) {
      startReload(w, idx);
      return 'empty';
    }
    w.mag[idx] -= 1;
  }
  const rate = def.fireRate ? 1 / def.fireRate : (def.cooldown || 0.2);
  w.cooldown[idx] = def.fireMode === 'auto' ? rate : (def.cooldown || rate);
  if (def.heatSpread) w.heat = Math.min(1, w.heat + 0.075);
  pushShot(out, def, idx, charged, w.heat);
  return 'fired';
}

/**
 * @param allowFire false during an active parry or equip — timers still tick.
 * Burst is frozen (not cancelled) while fire is locked, except equip which
 * already cleared it via cancelTransient.
 */
export function updateWeapons(w, dt, ctl, allowFire, idx, out) {
  out.count = 0;
  w.index = idx;
  const def = WEAPONS[idx];
  _result.fired = false;
  _result.empty = false;
  _result.reloadStarted = false;

  for (let i = 0; i < N; i++) {
    if (w.cooldown[i] > 0) w.cooldown[i] = Math.max(0, w.cooldown[i] - dt);
    if (w.reloading[i]) {
      w.reload[i] -= dt;
      if (w.reload[i] <= 0) finishReload(w, i);
    }
  }
  if (w.heat > 0 && !ctl.fire) w.heat = Math.max(0, w.heat - dt * 0.85);
  if (w.equip > 0) w.equip = Math.max(0, w.equip - dt);

  if (!allowFire) {
    if (ctl.fireReleased) {
      w.charging = 0;
      w.charge = 0;
    }
    return _result;
  }

  if (ctl.reload && def.mag && startReload(w, idx)) _result.reloadStarted = true;

  if (def.fireMode === 'charge') {
    if (ctl.fire && !w.reloading[idx] && (!def.mag || w.mag[idx] > 0)) {
      w.charging = 1;
      w.charge = Math.min(1, w.charge + dt / (def.chargeTime || 0.6));
    }
    if (ctl.fireReleased && w.charging) {
      const fired = tryEmit(w, idx, out, w.charge >= 0.34);
      if (fired === 'empty') {
        _result.empty = true;
        _result.reloadStarted = true;
      }
      w.charging = 0;
      w.charge = 0;
    }
  } else if (def.fireMode === 'auto') {
    if (ctl.fire && tryEmit(w, idx, out, false) === 'empty') {
      _result.empty = true;
      _result.reloadStarted = true;
    }
  } else if (def.fireMode === 'burst') {
    if (ctl.firePressed && w.burstLeft <= 0) {
      w.burstLeft = def.burst || 3;
      w.burstTimer = 0;
    }
  } else if (ctl.firePressed && tryEmit(w, idx, out, false) === 'empty') {
    _result.empty = true;
    _result.reloadStarted = true;
  }

  // After the press, so the first burst round leaves on the same frame.
  if (w.burstLeft > 0) {
    w.burstTimer -= dt;
    if (w.burstTimer <= 0) {
      const fired = tryEmit(w, idx, out, false);
      w.burstLeft -= 1;
      w.burstTimer = def.burstInterval || 0.06;
      if (fired === 'empty') {
        w.burstLeft = 0;
        _result.empty = true;
        _result.reloadStarted = true;
      }
    }
  }

  _result.fired = out.count > 0;
  return _result;
}

export function pointBlankDamage(damage, dist, range, mul) {
  if (!range || dist > range) return damage;
  return damage * mul;
}
