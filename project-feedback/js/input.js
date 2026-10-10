/**
 * input.js
 * Keyboard, mouse, wheel and pointer lock. Look deltas are pixels; the
 * player module turns them into yaw/pitch. Scroll is accumulated here and
 * consumed once per frame so a trackpad or a free wheel cannot skip slots.
 */
import { CFG } from './config.js';
import { consumeScroll } from './loadout.js';

export function createInput(target, hooks = {}) {
  const input = {
    target,
    keys: new Set(),
    pressed: new Set(),
    dx: 0,
    dy: 0,
    dragDx: 0,
    dragDy: 0,
    mouseDown: false,
    mousePressed: false,
    mouseReleased: false,
    rightDown: false,
    locked: false,
    cursorX: 0,
    cursorY: 0,
    scroll: { accum: 0 },
    sens: 1,
    invert: false,
    _drag: false,
    _lastX: 0,
    _lastY: 0,
    _listeners: [],
  };

  const bind = (obj, type, fn, opts) => {
    obj.addEventListener(type, fn, opts);
    input._listeners.push([obj, type, fn, opts]);
  };

  bind(window, 'keydown', (e) => {
    const gameKey = isGameKey(e.code);
    if (gameKey) e.preventDefault();
    if (!e.repeat) input.pressed.add(e.code);
    input.keys.add(e.code);
    hooks.onKeyDown?.(e);
  });
  bind(window, 'keyup', (e) => input.keys.delete(e.code));
  bind(window, 'blur', () => {
    input.keys.clear();
    input.mouseDown = false;
    input.rightDown = false;
    input._drag = false;
    hooks.onBlur?.();
  });
  bind(document, 'mousemove', (e) => {
    if (document.pointerLockElement === target) {
      input.dx += e.movementX || 0;
      input.dy += e.movementY || 0;
    } else if (input._drag) {
      input.dragDx += e.clientX - input._lastX;
      input.dragDy += e.clientY - input._lastY;
    }
    input._lastX = e.clientX;
    input._lastY = e.clientY;
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      input.cursorX = (e.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.5);
      input.cursorY = (e.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.5);
    }
  });
  bind(document, 'mousedown', (e) => {
    if (e.button === 2) {
      input.rightDown = true;
      input._drag = document.pointerLockElement !== target;
      input._lastX = e.clientX;
      input._lastY = e.clientY;
    }
    if (e.button !== 0) return;
    const locked = document.pointerLockElement === target;
    if (!locked && e.target !== target && !target.contains(e.target)) return;
    if (!locked && hooks.allowClickFire && !hooks.allowClickFire()) return;
    input.mouseDown = true;
    input.mousePressed = true;
  });
  bind(document, 'mouseup', (e) => {
    if (e.button === 0 && input.mouseDown) {
      input.mouseDown = false;
      input.mouseReleased = true;
    }
    if (e.button === 2) {
      input.rightDown = false;
      input._drag = false;
    }
  });
  bind(window, 'wheel', (e) => {
    if (!hooks.captureWheel || !hooks.captureWheel()) return;
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 40;
    const cap = CFG.scrollThreshold * 1.25;
    if (dy > cap) dy = cap;
    if (dy < -cap) dy = -cap;
    input.scroll.accum += dy;
  }, { passive: false });
  bind(document, 'contextmenu', (e) => e.preventDefault());
  bind(document, 'pointerlockchange', () => {
    const locked = document.pointerLockElement === target;
    const was = input.locked;
    input.locked = locked;
    if (!locked) {
      input.mouseDown = false;
      input.rightDown = false;
      if (was) hooks.onLockLost?.();
    }
  });
  bind(document, 'pointerlockerror', () => {
    input.locked = false;
    hooks.onLockLost?.();
  });

  input.requestLock = () => {
    try {
      const result = target.requestPointerLock();
      if (result && typeof result.then === 'function') return result.then(() => true, () => false);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  };
  input.releaseLock = () => {
    if (document.pointerLockElement === target) document.exitPointerLock();
  };
  input.endFrame = () => {
    input.pressed.clear();
    input.mousePressed = false;
    input.mouseReleased = false;
  };
  input.dispose = () => {
    for (const [obj, type, fn, opts] of input._listeners) obj.removeEventListener(type, fn, opts);
    input._listeners.length = 0;
  };
  return input;
}

function isGameKey(code) {
  return code === 'Space' || code.startsWith('Arrow') || code === 'Tab'
    || code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD'
    || code === 'ShiftLeft' || code === 'ShiftRight'
    || code === 'ControlLeft' || code === 'ControlRight';
}

/** Fills `out` from held keys. Wheel advances at most one slot. */
export function sampleInput(input, out) {
  const k = input.keys;
  out.moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
  out.moveZ = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
  out.jumpPressed = input.pressed.has('Space');
  out.dash = input.pressed.has('ShiftLeft') || input.pressed.has('ShiftRight');
  out.ctrl = k.has('ControlLeft') || k.has('ControlRight');
  out.ctrlPressed = input.pressed.has('ControlLeft') || input.pressed.has('ControlRight');
  out.parry = input.pressed.has('KeyF') || input.pressed.has('KeyQ');
  out.fire = input.mouseDown;
  out.firePressed = input.mousePressed;
  out.fireReleased = input.mouseReleased;
  out.reload = input.pressed.has('KeyR');
  out.slot = -1;
  if (input.pressed.has('Digit1')) out.slot = 0;
  else if (input.pressed.has('Digit2')) out.slot = 1;
  else if (input.pressed.has('Digit3')) out.slot = 2;
  else if (input.pressed.has('Digit4')) out.slot = 3;
  else if (input.pressed.has('Digit5')) out.slot = 4;
  out.wheel = consumeScroll(input.scroll, CFG.scrollThreshold);
  out.lookX = input.dx + input.dragDx;
  out.lookY = input.dy + input.dragDy;
  input.dx = 0;
  input.dy = 0;
  input.dragDx = 0;
  input.dragDy = 0;
  out.cursorX = input.cursorX;
  out.cursorY = input.cursorY;
  out.locked = input.locked;
  out.dragging = input._drag;
  out.invert = input.invert;
  out.sens = input.sens;
  return out;
}
