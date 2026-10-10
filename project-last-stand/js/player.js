/**
 * player.js
 * ------------------------------------------------------------------
 * First-person player: movement, collision, health and camera.
 *
 *  - Movement is relative to the yaw (camera) direction.
 *  - Walking, sprinting, aiming (ADS) and jumping with gravity.
 *  - Collision uses the shared cylinder resolver (collision.js), so the
 *    player slides along walls and cannot pass through solids.
 *  - Camera-only effects: head bob, weapon recoil (decaying kick) and
 *    trauma-based shake. None of them change the aim yaw/pitch.
 */
import * as THREE from 'three';
import { moveCylinder } from './collision.js';

export const PLAYER_MAX_HEALTH = 100;
const WALK_SPEED = 4.6;
const SPRINT_SPEED = 7.0;
const AIM_SPEED_MULT = 0.6;
const JUMP_VELOCITY = 7.4;
const GRAVITY = 22;
const EYE_HEIGHT = 1.65;
const RADIUS = 0.36;
const HEIGHT = 1.8;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

export class Player {
  /**
   * @param {object} opts
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {object} [opts.hooks]  onFootstep(sprinting), onDamaged(amount, fromPos), onDeath()
   */
  constructor({ camera, hooks = {} }) {
    this.camera = camera;
    this.hooks = hooks;
    this.camera.rotation.order = 'YXZ';

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;
    this.radius = RADIUS;
    this.height = HEIGHT;
    this.eyeHeight = EYE_HEIGHT;
    this.eyeOffset = EYE_HEIGHT;

    this.health = PLAYER_MAX_HEALTH;
    this.maxHealth = PLAYER_MAX_HEALTH;
    this.alive = true;

    this.sensitivity = 1;
    this.invertY = false;
    this.baseFov = camera.fov;
    this.aiming = false;
    this.aimAmount = 0;
    this.sprinting = false;
    this.speed = 0;

    this.recoil = { pitch: 0, yaw: 0 };
    this.trauma = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.stepDistance = 0;
    this.deathDrop = 0;
    this.shakeEnabled = true;
    this.speedFactor = 0;
  }

  /** Places the player at a spawn point and restores full health. */
  spawn(x, z, yaw = 0) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.onGround = true;
    this.recoil = { pitch: 0, yaw: 0 };
    this.trauma = 0;
    this.deathDrop = 0;
    this.eyeOffset = this.eyeHeight;
    this.aiming = false;
    this.aimAmount = 0;
    this.stepDistance = 0;
  }

  /** Mouse look. dx/dy are raw pixel deltas from pointer lock. */
  look(dx, dy) {
    if (!this.alive) return;
    const k = 0.0022 * this.sensitivity;
    this.yaw -= dx * k;
    this.pitch -= dy * k * (this.invertY ? -1 : 1);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  /** Recoil impulse (pitch up, yaw jitter). Decays back toward zero. */
  addRecoil(pitch, yaw) {
    this.recoil.pitch += pitch;
    this.recoil.yaw += yaw;
  }

  /** Adds screen-shake trauma (0..1). */
  addTrauma(amount) {
    if (!this.shakeEnabled) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Forward and right unit vectors on the ground plane. */
  forwardVector(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  rightVector(out = new THREE.Vector3()) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /**
   * Applies one frame of movement.
   * @param {number} dt
   * @param {object} controls  { moveX (-1..1 strafe), moveZ (-1..1 forward), sprint, jump, aim }
   * @param {Array} colliders  static boxes
   * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} bounds
   */
  update(dt, controls, colliders, bounds) {
    // Recoil recovers smoothly; trauma decays linearly.
    const recover = Math.exp(-5 * dt);
    this.recoil.pitch *= recover;
    this.recoil.yaw *= recover;
    this.trauma = Math.max(0, this.trauma - dt * 1.3);

    this.aimAmount += ((controls.aim && this.alive ? 1 : 0) - this.aimAmount) * Math.min(1, dt * 10);
    this.aiming = this.aimAmount > 0.5;

    if (!this.alive) {
      // Death: slump to the floor.
      this.velocity.set(0, 0, 0);
      this.deathDrop = Math.min(1, this.deathDrop + dt * 1.5);
      this.eyeOffset = this.eyeHeight * (1 - 0.7 * this.deathDrop);
      this.speed = 0;
      this.speedFactor = 0;
      this.updateCamera();
      return;
    }

    // Desired direction in world space from the input axes.
    const f = this.forwardVector(this._f || (this._f = new THREE.Vector3()));
    const r = this.rightVector(this._r || (this._r = new THREE.Vector3()));
    let mx = f.x * controls.moveZ + r.x * controls.moveX;
    let mz = f.z * controls.moveZ + r.z * controls.moveX;
    const inputLen = Math.hypot(mx, mz);
    if (inputLen > 1) {
      mx /= inputLen;
      mz /= inputLen;
    }
    const wantsMove = inputLen > 0.01;

    this.sprinting = !!controls.sprint && controls.moveZ > 0.1 && !this.aiming && this.onGround;
    let targetSpeed = this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    if (this.aiming) targetSpeed *= AIM_SPEED_MULT;
    if (!wantsMove) targetSpeed = 0;

    // Accelerate toward target velocity (quicker on the ground than in air).
    const accel = this.onGround ? 14 : 3;
    const k = Math.min(1, accel * dt);
    this.velocity.x += (mx * targetSpeed - this.velocity.x) * k;
    this.velocity.z += (mz * targetSpeed - this.velocity.z) * k;

    // Jump and gravity.
    if (controls.jump && this.onGround) {
      this.velocity.y = JUMP_VELOCITY;
      this.onGround = false;
    }
    this.velocity.y -= GRAVITY * dt;

    // Horizontal movement with collision (sub-stepped inside moveCylinder).
    const dx = this.velocity.x * dt;
    const dz = this.velocity.z * dt;
    moveCylinder(this.position, dx, dz, RADIUS, HEIGHT, colliders);

    // Vertical movement: the floor is at y = 0 everywhere.
    this.position.y += this.velocity.y * dt;
    if (this.position.y <= 0) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.onGround = true;
    }

    // Keep inside the level bounds (outer walls already do this; this is a safety net).
    if (bounds) {
      this.position.x = Math.min(bounds.maxX - 0.5, Math.max(bounds.minX + 0.5, this.position.x));
      this.position.z = Math.min(bounds.maxZ - 0.5, Math.max(bounds.minZ + 0.5, this.position.z));
    }

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.speed = horizontalSpeed;
    this.speedFactor = Math.min(1, horizontalSpeed / SPRINT_SPEED) * (this.onGround ? 1 : 0.3);

    // Head bob and footsteps while walking on the ground.
    if (this.onGround && horizontalSpeed > 0.5) {
      const rate = this.sprinting ? 12 : 8.5;
      this.bobPhase += dt * rate;
      this.bobAmount += (1 - this.bobAmount) * Math.min(1, dt * 8);
      this.stepDistance += horizontalSpeed * dt;
      const stepLen = this.sprinting ? 1.9 : 2.4;
      if (this.stepDistance >= stepLen) {
        this.stepDistance = 0;
        this.hooks.onFootstep?.(this.sprinting);
      }
    } else {
      this.bobAmount += (0 - this.bobAmount) * Math.min(1, dt * 8);
    }

    this.updateCamera();
  }

  /** Writes the final camera transform (aim + recoil + shake + bob). */
  updateCamera() {
    const cam = this.camera;
    // Shake: noise-like offsets scaled by trauma squared.
    const shake = this.shakeEnabled ? this.trauma * this.trauma : 0;
    const t = performance.now() * 0.001;
    const sx = (Math.sin(t * 47.1) + Math.sin(t * 23.3 + 1.7)) * 0.5 * shake;
    const sy = (Math.sin(t * 37.9 + 3.1) + Math.sin(t * 19.7)) * 0.5 * shake;

    const bob = Math.sin(this.bobPhase) * 0.045 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase * 0.5) * 0.03 * this.bobAmount;

    const eye = this.eyeOffset + bob;
    cam.position.set(
      this.position.x + bobX + sx * 0.02,
      this.position.y + eye + sy * 0.015,
      this.position.z,
    );
    cam.rotation.set(
      this.pitch + this.recoil.pitch + sy * 0.02,
      this.yaw + this.recoil.yaw + sx * 0.02,
      sx * 0.015,
      'YXZ',
    );

    // ADS narrows the field of view a little.
    const targetFov = this.baseFov * (1 - 0.12 * this.aimAmount);
    if (Math.abs(cam.fov - targetFov) > 0.01) {
      cam.fov = targetFov;
      cam.updateProjectionMatrix();
    }
  }

  /** Applies damage. Returns the amount actually taken. */
  damage(amount, fromPos = null) {
    if (!this.alive || amount <= 0) return 0;
    this.health = Math.max(0, this.health - amount);
    this.addTrauma(0.35);
    this.hooks.onDamaged?.(amount, fromPos);
    if (this.health <= 0) {
      this.alive = false;
      this.hooks.onDeath?.();
    }
    return amount;
  }

  /** Restores health up to the maximum. Returns the amount healed. */
  heal(amount) {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }
}

export const PLAYER_CONSTANTS = { RADIUS, HEIGHT, EYE_HEIGHT, WALK_SPEED, SPRINT_SPEED };
