/**
 * bus.js
 * Tiny synchronous event bus. Systems emit facts; they do not import each other.
 *
 * Payload objects are reused by emitters. Listeners must copy anything they
 * keep — the same object is overwritten on the next emit of that event.
 */

export const EV = {
  DASH: 'dash:started',
  SLIDE: 'slide:started',
  SLAM: 'slam:impact',
  SLAM_HIT: 'slam:hit',
  JUMP: 'player:jump',
  WALL: 'player:walljump',
  PARRY_START: 'parry:started',
  PARRY_OK: 'parry:success',
  PARRY_WHIFF: 'parry:whiff',
  SWITCH: 'weapon:switch',
  FIRE: 'weapon:fire',
  EMPTY: 'weapon:empty',
  RELOAD: 'weapon:reload',
  KILL: 'enemy:killed',
  HIT: 'combat:hit',
  HURT: 'player:hurt',
  HEAL: 'player:heal',
  DEATH: 'player:death',
  DODGE: 'player:dodge',
  THREAT: 'player:threat',
  STYLE: 'style:action',
  RANK: 'style:rank',
  TELEGRAPH: 'enemy:telegraph',
  ENEMY_FIRE: 'enemy:fire',
  EXPLODE: 'fx:explode',
  IMPACT: 'fx:impact',
};

export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      let list = map.get(type);
      if (!list) map.set(type, (list = []));
      list.push(fn);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit(type, payload) {
      const list = map.get(type);
      if (!list) return;
      for (let i = 0; i < list.length; i++) list[i](payload);
    },
  };
}
