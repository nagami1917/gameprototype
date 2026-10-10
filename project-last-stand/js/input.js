/**
 * input.js
 * ------------------------------------------------------------------
 * Keyboard and mouse state for the game.
 *
 *  - Held state (isDown) is polled every frame by the game loop.
 *  - Edge state (wasPressed) is latched on keydown/mousedown and cleared
 *    by endFrame(), so one tap = one action even if the frame rate varies.
 *  - Mouse look deltas are only accumulated while the pointer is locked.
 *  - Every listener is registered in one place and removed by dispose().
 */

export class InputController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.target      element that receives pointer lock
   * @param {(e: KeyboardEvent) => void} [opts.onKeyDown]  called for every keydown (menus/pause)
   * @param {() => void} [opts.onPointerLockLost]
   * @param {() => void} [opts.onWindowBlur]
   */
  constructor({ target, onKeyDown, onPointerLockLost, onWindowBlur }) {
    this.target = target;
    this.onKeyDownCb = onKeyDown;
    this.onPointerLockLostCb = onPointerLockLost;
    this.onWindowBlurCb = onWindowBlur;

    this.keys = new Set();
    this.pressed = new Set();
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.locked = false;

    this._listeners = [];
    this.bind(window, 'keydown', (e) => this.handleKeyDown(e));
    this.bind(window, 'keyup', (e) => this.keys.delete(e.code));
    this.bind(window, 'blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
      this.onWindowBlurCb?.();
    });
    this.bind(document, 'mousemove', (e) => this.handleMouseMove(e));
    this.bind(document, 'mousedown', (e) => this.handleMouseDown(e));
    this.bind(document, 'mouseup', (e) => this.mouseButtons.delete(e.button));
    this.bind(document, 'contextmenu', (e) => e.preventDefault());
    this.bind(document, 'pointerlockchange', () => this.handleLockChange());
    this.bind(document, 'pointerlockerror', () => this.handleLockChange());
  }

  bind(obj, type, fn) {
    obj.addEventListener(type, fn);
    this._listeners.push([obj, type, fn]);
  }

  handleKeyDown(e) {
    // Stop the browser from scrolling or activating focused buttons with game keys.
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    if (!e.repeat) this.pressed.add(e.code);
    this.keys.add(e.code);
    this.onKeyDownCb?.(e);
  }

  handleMouseDown(e) {
    if (!this.locked && document.pointerLockElement !== this.target) return;
    this.mouseButtons.add(e.button);
    this.mousePressed.add(e.button);
  }

  handleMouseMove(e) {
    if (document.pointerLockElement !== this.target) return;
    this.mouseDx += e.movementX || 0;
    this.mouseDy += e.movementY || 0;
  }

  handleLockChange() {
    const locked = document.pointerLockElement === this.target;
    const wasLocked = this.locked;
    this.locked = locked;
    if (!locked) {
      this.keys.clear();
      this.mouseButtons.clear();
      if (wasLocked) this.onPointerLockLostCb?.();
    }
  }

  isDown(code) {
    return this.keys.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  mouseDown(button = 0) {
    return this.mouseButtons.has(button);
  }

  mouseWasPressed(button = 0) {
    return this.mousePressed.has(button);
  }

  /** Returns and clears accumulated mouse movement. */
  consumeMouseDelta() {
    const d = { x: this.mouseDx, y: this.mouseDy };
    this.mouseDx = 0;
    this.mouseDy = 0;
    return d;
  }

  /** Clears one-frame edge flags. Call once per frame after reading input. */
  endFrame() {
    this.pressed.clear();
    this.mousePressed.clear();
  }

  /** Requests pointer lock; returns a promise that resolves to true/false. */
  requestLock() {
    try {
      const result = this.target.requestPointerLock();
      if (result && typeof result.then === 'function') {
        return result.then(() => true, () => false);
      }
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  releaseLock() {
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  dispose() {
    for (const [obj, type, fn] of this._listeners) obj.removeEventListener(type, fn);
    this._listeners.length = 0;
    this.keys.clear();
    this.pressed.clear();
    this.mouseButtons.clear();
  }
}
