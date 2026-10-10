/**
 * loadout.js
 * Five slots, three variants each. Wheel and number keys both land here.
 * Scroll accumulation is capped to one slot per event so a free-spinning
 * wheel cannot skip, while small trackpad deltas still have to add up.
 */
import { SLOT_COUNT, VARIANTS_PER_SLOT } from './config.js';

export function createLoadout() {
  const variant = new Int8Array(SLOT_COUNT);
  return { slot: 0, variant, slots: SLOT_COUNT };
}

export function resetLoadout(loadout) {
  loadout.slot = 0;
  loadout.variant.fill(0);
}

export function weaponIndex(loadout) {
  return loadout.slot * VARIANTS_PER_SLOT + loadout.variant[loadout.slot];
}

export function cycleSlot(loadout, dir) {
  const n = loadout.slots;
  loadout.slot = (loadout.slot + dir + n * 4) % n;
  return loadout.slot;
}

/**
 * Number key. Same slot cycles the variant; a different slot jumps there
 * without changing that slot's variant.
 * Returns 'variant' or 'slot'.
 */
export function pressSlot(loadout, index) {
  if (index < 0 || index >= loadout.slots) return 'none';
  if (index === loadout.slot) {
    loadout.variant[index] = (loadout.variant[index] + 1) % VARIANTS_PER_SLOT;
    return 'variant';
  }
  loadout.slot = index;
  return 'slot';
}

/**
 * Fold one wheel event into an accumulator. A single event is capped so a
 * free-spinning wheel cannot queue several slots. Returns -1, 0, or 1.
 * @param {{accum: number}} state
 */
export function accumulateScroll(state, deltaY, deltaMode, threshold) {
  let dy = deltaY;
  if (deltaMode === 1) dy *= 16;
  else if (deltaMode === 2) dy *= 40;
  const cap = threshold * 1.25;
  if (dy > cap) dy = cap;
  if (dy < -cap) dy = -cap;
  state.accum += dy;
  return consumeScroll(state, threshold);
}

/** One slot per call. Used once per frame so a burst of events cannot skip. */
export function consumeScroll(state, threshold) {
  if (state.accum >= threshold) {
    state.accum -= threshold;
    if (state.accum > threshold * 0.25) state.accum = threshold * 0.25;
    return 1;
  }
  if (state.accum <= -threshold) {
    state.accum += threshold;
    if (state.accum < -threshold * 0.25) state.accum = -threshold * 0.25;
    return -1;
  }
  return 0;
}
