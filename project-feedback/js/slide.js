/**
 * slide.js
 * Ctrl on the ground slides (low friction, low body). Ctrl in the air slams.
 * Jumping out of a slide does not zero horizontal speed — movement.js never
 * touches vx/vz on a jump, and this frame still uses slide friction.
 */
import { CFG } from './config.js';
import { fitsHeight } from './collision.js';

export function createSlide() {
  return {
    sliding: false,
    slamming: false,
    boost: false,
    hold: 0,
    started: false,
  };
}

export function resetSlide(s) {
  s.sliding = false;
  s.slamming = false;
  s.boost = false;
  s.hold = 0;
  s.started = false;
}

/**
 * Call before integrate, using last frame's onGround.
 * `started` is true only on the frame a slide begins (for the bus).
 */
export function updateSlide(s, dt, ctrl, ctrlPressed, player, boxes) {
  s.boost = false;
  s.started = false;
  if (!player.alive) {
    s.sliding = false;
    s.slamming = false;
    return;
  }
  if (ctrlPressed) {
    if (player.onGround) {
      s.sliding = true;
      s.hold = CFG.slideHold;
      s.boost = true;
      s.started = true;
      s.slamming = false;
    } else if (!s.slamming) {
      s.slamming = true;
    }
  }
  if (s.sliding) {
    s.hold = Math.max(0, s.hold - dt);
    if (!player.onGround) {
      s.sliding = false;
    } else if (!ctrl && s.hold <= 0) {
      if (fitsHeight(player.x, player.y, player.z, player.radius, CFG.standHeight, boxes)) {
        s.sliding = false;
      }
    }
  }
}

/** After integrate: a jump or a dash ends the slide, but the speed is already kept. */
export function finishSlide(s, player, dashed) {
  if (player.justJumped || dashed) s.sliding = false;
  if (player.slamImpact) s.slamming = false;
}
