/**
 * style.js
 * Meter from D to S. Points come from kills, parries, dash-dodges and
 * weapon variety. The meter only decays after a quiet gap — not while
 * you are still acting.
 */
import { CFG, FRESH_SLOTS, rankFor } from './config.js';
import { EV } from './bus.js';

export function createStyle() {
  const fresh = new Float32Array(FRESH_SLOTS);
  fresh.fill(1);
  return {
    meter: 0,
    rank: 'D',
    idle: 0,
    combo: 0,
    peak: 'D',
    peakMeter: 0,
    fresh,
    decay: CFG.styleDecay,
    max: CFG.styleMax,
  };
}

export function resetStyle(s) {
  s.meter = 0;
  s.rank = 'D';
  s.idle = 0;
  s.combo = 0;
  s.peak = 'D';
  s.peakMeter = 0;
  s.fresh.fill(1);
}

export function freshnessMul(style, id) {
  const f = id >= 0 && id < style.fresh.length ? style.fresh[id] : 1;
  return 0.28 + 0.72 * f;
}

export function noteWeaponUse(style, id, weight) {
  if (id < 0 || id >= style.fresh.length) return 1;
  const mul = freshnessMul(style, id);
  style.fresh[id] = Math.max(0.1, style.fresh[id] - 0.2 * weight);
  if (weight >= 0.8) {
    for (let i = 0; i < style.fresh.length; i++) {
      if (i !== id) style.fresh[i] = Math.min(1, style.fresh[i] + 0.06);
    }
  }
  return mul;
}

const _action = { tag: '', points: 0 };

export function addStyle(style, points, tag, bus) {
  if (points <= 0) return;
  style.meter = Math.min(style.max, style.meter + points);
  style.idle = CFG.styleIdle;
  style.combo += 1;
  if (style.meter > style.peakMeter) {
    style.peakMeter = style.meter;
    style.peak = rankFor(style.meter);
  }
  if (tag && bus) {
    _action.tag = tag;
    _action.points = points;
    bus.emit(EV.STYLE, _action);
  }
}

export function updateStyle(style, dt, bus) {
  for (let i = 0; i < style.fresh.length; i++) {
    style.fresh[i] = Math.min(1, style.fresh[i] + dt * 0.045);
  }
  if (style.idle > 0) {
    style.idle -= dt;
  } else if (style.meter > 0) {
    const mul = style.rank === 'S' ? 1.65 : style.rank === 'A' ? 1.28 : 1;
    style.meter = Math.max(0, style.meter - style.decay * mul * dt);
    if (style.meter < 1) style.combo = 0;
  }
  const next = rankFor(style.meter);
  if (next !== style.rank) {
    const up = rankFor(style.meter) !== style.rank;
    void up;
    const prev = style.rank;
    style.rank = next;
    _action.tag = next;
    _action.points = prev === next ? 0 : 1;
    if (bus) bus.emit(EV.RANK, _action);
  }
}

export function bindStyle(style, bus) {
  bus.on(EV.KILL, (e) => {
    const mul = noteWeaponUse(style, e.weaponId, 1);
    const air = e.airborne ? CFG.styleAir : 0;
    const pts = Math.round(CFG.styleKill * mul + air);
    addStyle(style, pts, e.airborne ? 'AIR KILL' : 'KILL', bus);
  });
  bus.on(EV.PARRY_OK, () => {
    noteWeaponUse(style, 15, 0.5);
    addStyle(style, CFG.styleParry, 'PARRY', bus);
  });
  bus.on(EV.DODGE, () => {
    addStyle(style, CFG.styleDodge, 'DODGE', bus);
  });
  bus.on(EV.SLAM_HIT, () => {
    addStyle(style, CFG.styleSlam, 'SLAM', bus);
  });
  bus.on(EV.HIT, (e) => {
    const mul = noteWeaponUse(style, e.weaponId, 0.12);
    addStyle(style, CFG.styleHit * mul, null, bus);
  });
}
