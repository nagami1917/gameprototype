/**
 * meleeAnim.js
 * ------------------------------------------------------------------
 * First-person melee swing: a jointed arm (shoulder -> elbow -> wrist -> hand)
 * built in camera space, keyframed swing poses with easing, a blade motion
 * trail and a short body recoil.
 *
 *  - The arm is a parent/child hierarchy, so the forearm, wrist and hand follow
 *    the shoulder and elbow automatically. The melee weapon is parented to the
 *    hand socket, so it can never float away from the hand.
 *  - Poses are a pure function of the attack timer (`swingPoseAt`), which keeps
 *    the motion deterministic and testable. WeaponSystem advances the timer once
 *    per frame from the requestAnimationFrame game loop.
 *  - facing 'right' = forehand (wind-up on the right, sweeps left).
 *    facing 'left'  = backhand (the same keyframes mirrored across the body).
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Easing
 * ------------------------------------------------------------------ */
export const easing = Object.freeze({
  /** Smooth start and finish: used for the wind-up and the recovery. */
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  /** Slow start, fast finish: the forward strike accelerates into contact. */
  inCubic: (t) => t * t * t,
  /** Fast start, soft landing: the follow-through decelerates. */
  outCubic: (t) => 1 - (1 - t) ** 3,
});

/* ------------------------------------------------------------------ *
 * Rig geometry (metres, camera space: -Z is forward, +X is right)
 * ------------------------------------------------------------------ */
export const SHOULDER_POS = Object.freeze({ x: 0.22, y: -0.36, z: 0.06 });
const UPPER_ARM_LENGTH = 0.3;
const FOREARM_LENGTH = 0.28;
const WRIST_TO_SOCKET = 0.07;

/* ------------------------------------------------------------------ *
 * Poses
 *
 * Every pose is a set of joint angles (radians) plus a camera-space
 * offset for the whole arm (`rx, ry, rz`, metres):
 *   sy/sp/sr  shoulder yaw / pitch / roll     (Euler order YXZ)
 *   el        elbow bend (about the local X axis)
 *   wy/wp/wr  wrist yaw / pitch / roll        (Euler order YXZ)
 * Positive sp raises the upper arm, positive el folds the forearm up.
 * ------------------------------------------------------------------ */
export const REST_POSE = Object.freeze({
  sy: -0.12, sp: -0.55, sr: -0.01, el: 1.51,
  wy: 0.22, wp: -0.73, wr: 1.0,
  rx: 0, ry: 0, rz: 0,
});

/** Keys that flip sign when the swing is mirrored (left-facing / backhand). */
const MIRROR_KEYS = new Set(['sy', 'sr', 'wy', 'wr', 'rx']);

/**
 * Keyframes per swing style, keyed by `def.swing`. Exported so a test can prove
 * every melee def names a style that exists - a typo would otherwise fall back
 * to `slash` in silence.
 */
export const STYLE_POSES = Object.freeze({
  // Quick horizontal slash (knife, pipe): wind up low-right, cut across to the left.
  slash: Object.freeze({
    windup: { sy: -0.59, sp: -0.36, sr: 0.41, el: 1.79, wy: -0.47, wp: -0.58, wr: 1.0, rx: 0.02, ry: 0.02, rz: 0.02 },
    impact: { sy: 0.5, sp: -0.15, sr: 0.11, el: 0.78, wy: 0.33, wp: -0.6, wr: 1.0, rx: -0.03, ry: -0.02, rz: -0.04 },
    follow: { sy: 0.69, sp: -0.15, sr: 0.49, el: 0.6, wy: 0.31, wp: -0.43, wr: 1.0, rx: -0.05, ry: -0.05, rz: -0.06 },
  }),
  // Heavy overhead chop (fire axe): raise the head high, then bring it down across the front.
  chop: Object.freeze({
    windup: { sy: -0.75, sp: 0.42, sr: 0.9, el: 1.21, wy: -1.0, wp: -0.49, wr: -1.0, rx: 0.02, ry: 0.05, rz: 0.0 },
    impact: { sy: 0.33, sp: -0.14, sr: 0.46, el: 1.0, wy: 0.48, wp: -1.34, wr: 1.0, rx: -0.02, ry: -0.04, rz: -0.06 },
    follow: { sy: 0.37, sp: -0.43, sr: 0.58, el: 1.0, wy: 0.59, wp: -1.22, wr: 1.0, rx: -0.03, ry: -0.08, rz: -0.08 },
  }),
  // Wide flat cut (machete): a long pull-back to the right, then a level sweep
  // that crosses the whole body - the arm barely bends, which is what makes it
  // read as a *sweep* rather than a slash. The strike is short and quick.
  sweep: Object.freeze({
    windup: { sy: -0.8, sp: -0.3, sr: 0.5, el: 1.85, wy: -0.55, wp: -0.5, wr: 1.0, rx: 0.03, ry: 0.03, rz: 0.02 },
    impact: { sy: 0.62, sp: -0.16, sr: 0.16, el: 0.62, wy: 0.4, wp: -0.55, wr: 1.0, rx: -0.04, ry: -0.03, rz: -0.05 },
    follow: { sy: 0.86, sp: -0.12, sr: 0.55, el: 0.5, wy: 0.36, wp: -0.42, wr: 1.0, rx: -0.06, ry: -0.06, rz: -0.07 },
  }),
  // Two-handed overhead smash (sledgehammer): the head goes up and *behind* the
  // shoulder, then everything drives straight down. Slower than the axe chop, and
  // the follow-through sits much lower, because a hammer does not stop at the ribcage.
  smash: Object.freeze({
    windup: { sy: -0.5, sp: 0.62, sr: 0.72, el: 1.05, wy: -0.85, wp: -0.35, wr: -1.0, rx: 0.02, ry: 0.04, rz: 0.0 },
    impact: { sy: 0.22, sp: -0.2, sr: 0.3, el: 1.15, wy: 0.4, wp: -1.45, wr: 1.0, rx: -0.02, ry: -0.03, rz: -0.05 },
    follow: { sy: 0.26, sp: -0.58, sr: 0.4, el: 1.05, wy: 0.5, wp: -1.3, wr: 1.0, rx: -0.04, ry: -0.06, rz: -0.08 },
  }),
});

function mirrorPose(pose) {
  const out = {};
  for (const k of Object.keys(REST_POSE)) {
    out[k] = MIRROR_KEYS.has(k) ? REST_POSE[k] - (pose[k] - REST_POSE[k]) : pose[k];
  }
  return out;
}

function lerpPose(a, b, t) {
  const out = {};
  for (const k of Object.keys(REST_POSE)) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

/**
 * Timeline of one swing in seconds from the attack start.
 *   windup  : wind-up ends, forward strike begins
 *   impact  : the blade is at the centre of its active hit window
 *   follow  : follow-through ends, recovery begins
 *   end     : arm is back at rest (matches def.attackDuration)
 */
export function swingTimeline(def) {
  return {
    windup: def.windup,
    impact: def.hitTime + def.activeTime * 0.5,
    follow: def.strikeEnd,
    end: def.attackDuration,
  };
}

/**
 * Arm pose at `t` seconds into a swing.
 *   0 .. windup    rest -> wind-up      (ease in-out: a readable pull-back)
 *   windup .. impact  wind-up -> impact (ease in: accelerates into the cut)
 *   impact .. follow  impact -> follow  (ease out: follow-through slows down)
 *   follow .. end     follow -> rest    (ease in-out: smooth recovery)
 */
export function swingPoseAt(def, t, facing = 'right') {
  const tl = swingTimeline(def);
  if (!(t > 0) || t >= tl.end) return { ...REST_POSE };
  const preset = STYLE_POSES[def.swing] || STYLE_POSES.slash;
  const mirror = facing === 'left';
  const windup = mirror ? mirrorPose(preset.windup) : preset.windup;
  const impact = mirror ? mirrorPose(preset.impact) : preset.impact;
  const follow = mirror ? mirrorPose(preset.follow) : preset.follow;

  if (t < tl.windup) {
    return lerpPose(REST_POSE, windup, easing.inOutSine(t / tl.windup));
  }
  if (t < tl.impact) {
    const k = (t - tl.windup) / (tl.impact - tl.windup);
    return lerpPose(windup, impact, easing.inCubic(k));
  }
  if (t < tl.follow) {
    const k = (t - tl.impact) / (tl.follow - tl.impact);
    return lerpPose(impact, follow, easing.outCubic(k));
  }
  const k = (t - tl.follow) / (tl.end - tl.follow);
  return lerpPose(follow, REST_POSE, easing.inOutSine(k));
}

/* ------------------------------------------------------------------ *
 * Arm rig
 * ------------------------------------------------------------------ */
function sleeveMesh(radius, length, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.9, length, 10), material);
  mesh.rotation.x = Math.PI / 2; // align the cylinder with the arm (-Z)
  mesh.position.z = -length / 2;
  return mesh;
}

function jointBall(radius, material) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), material);
}

/**
 * Builds the right arm in camera space.
 *   root -> shoulder -> upperArm -> elbow -> forearm -> wrist -> hand -> socket
 * The melee weapon is attached to `socket`.
 */
export function buildArmRig() {
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x262b24, roughness: 0.95, metalness: 0.0 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x101316, roughness: 0.9, metalness: 0.05 });
  const cuff = new THREE.MeshStandardMaterial({ color: 0x0c0e10, roughness: 0.9, metalness: 0.0 });

  const root = new THREE.Group();
  root.name = 'melee-arm';

  const shoulder = new THREE.Group();
  shoulder.name = 'shoulder';
  shoulder.position.set(SHOULDER_POS.x, SHOULDER_POS.y, SHOULDER_POS.z);
  shoulder.rotation.order = 'YXZ';
  root.add(shoulder);
  shoulder.add(jointBall(0.05, sleeve));
  shoulder.add(sleeveMesh(0.046, UPPER_ARM_LENGTH, sleeve));

  const elbow = new THREE.Group();
  elbow.name = 'elbow';
  elbow.position.set(0, 0, -UPPER_ARM_LENGTH);
  shoulder.add(elbow);
  elbow.add(jointBall(0.042, sleeve));
  elbow.add(sleeveMesh(0.04, FOREARM_LENGTH, sleeve));

  const wrist = new THREE.Group();
  wrist.name = 'wrist';
  wrist.position.set(0, 0, -FOREARM_LENGTH);
  wrist.rotation.order = 'YXZ';
  elbow.add(wrist);

  // Sleeve cuff, then a gloved hand wrapped around the grip socket.
  const cuffMesh = new THREE.Mesh(new THREE.BoxGeometry(0.086, 0.07, 0.04), cuff);
  cuffMesh.position.set(0, 0, -0.01);
  wrist.add(cuffMesh);

  const hand = new THREE.Group();
  hand.name = 'hand';
  wrist.add(hand);
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.07, 0.09), glove);
  palm.position.set(0, 0, -0.045);
  hand.add(palm);
  const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.032, 0.075), glove);
  fingers.position.set(0, -0.046, -0.05);
  hand.add(fingers);
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.06), glove);
  thumb.position.set(0.034, 0.02, -0.032);
  thumb.rotation.y = 0.35;
  hand.add(thumb);

  const socket = new THREE.Object3D();
  socket.name = 'grip-socket';
  socket.position.set(0, 0, -WRIST_TO_SOCKET);
  wrist.add(socket);

  return { root, shoulder, elbow, wrist, socket };
}

/* ------------------------------------------------------------------ *
 * Blade trail: a fading ribbon swept by the blade tip and base.
 * Points are stored in camera space so the trail stays put while the
 * body moves, like a real slash arc in the air.
 * ------------------------------------------------------------------ */
export class BladeTrail {
  /**
   * @param {THREE.Object3D} parent  usually the camera
   * @param {object} [opts]
   * @param {number} [opts.maxSamples=24]
   * @param {number} [opts.life=0.16]  seconds before a sample is fully faded
   */
  constructor(parent, { maxSamples = 24, life = 0.16 } = {}) {
    this.maxSamples = maxSamples;
    this.life = life;
    this.samples = []; // { base: Vector3, tip: Vector3, age: number }
    this.color = new THREE.Color(0xcfe8ff);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxSamples * 2 * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxSamples * 2 * 4), 4));
    const indices = new Uint16Array((maxSamples - 1) * 6);
    for (let i = 0; i < maxSamples - 1; i++) {
      const a = i * 2;
      indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'blade-trail';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    parent.add(this.mesh);
  }

  setColor(hex) {
    this.color.set(hex);
  }

  clear() {
    this.samples.length = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  /** Records one blade sample (camera-space points). */
  push(base, tip) {
    this.samples.push({ base: base.clone(), tip: tip.clone(), age: 0 });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  /** Ages the samples, drops faded ones and rebuilds the ribbon. */
  update(dt) {
    const s = this.samples;
    for (const sample of s) sample.age += dt;
    while (s.length && s[0].age >= this.life) s.shift();

    const geometry = this.mesh.geometry;
    const pos = geometry.attributes.position.array;
    const col = geometry.attributes.color.array;
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const sample = s[i];
      // Older samples fade out first; the newest sample is the brightest.
      const fade = Math.pow(1 - sample.age / this.life, 1.6);
      const r = this.color.r * fade;
      const g = this.color.g * fade;
      const b = this.color.b * fade;
      for (let k = 0; k < 2; k++) {
        const p = k === 0 ? sample.base : sample.tip;
        const v = (i * 2 + k) * 3;
        pos[v] = p.x;
        pos[v + 1] = p.y;
        pos[v + 2] = p.z;
        const c = (i * 2 + k) * 4;
        col[c] = r;
        col[c + 1] = g;
        col[c + 2] = b;
        col[c + 3] = fade;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.setDrawRange(0, Math.max(0, (n - 1) * 6));
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * MeleeViewmodel: owns the arm rig, the blade trail and the body recoil.
 * ------------------------------------------------------------------ */
const KICK_DECAY = 14;      // per second
const KICK_BACK = 0.035;    // metres pushed back toward the camera on impact
const KICK_DOWN = 0.012;    // metres dropped on impact

export class MeleeViewmodel {
  /** @param {THREE.PerspectiveCamera} camera  the rig is parented to it */
  constructor(camera) {
    this.camera = camera;
    this.rig = buildArmRig();
    this.root = this.rig.root;
    this.root.visible = false;
    camera.add(this.root);
    this.trail = new BladeTrail(camera);
    this.kick = 0;
    this.weapon = null;       // { group, trail: { base, tip } } of the held weapon
    this._tmp = new THREE.Vector3();
    this.applyPose(REST_POSE, 0, 0, 0);
  }

  /** The hand socket: attach melee weapon groups here. */
  get socket() {
    return this.rig.socket;
  }

  setVisible(visible) {
    this.root.visible = visible;
    if (!visible) this.trail.clear();
  }

  /** Called on the frame the blade lands on something: adds body recoil. */
  onImpact() {
    this.kick = 1;
  }

  /** Returns the arm to rest and clears the trail (weapon switch, cancel, reset). */
  reset() {
    this.kick = 0;
    this.trail.clear();
    this.applyPose(REST_POSE, 0, 0, 0);
  }

  /** Writes joint angles and the arm offset into the rig. */
  applyPose(p, offX, offY, offZ) {
    const r = this.rig;
    r.shoulder.rotation.set(p.sp, p.sy, p.sr);
    r.elbow.rotation.x = p.el;
    r.wrist.rotation.set(p.wp, p.wy, p.wr);
    this.root.position.set(p.rx + offX, p.ry + offY, p.rz + offZ);
  }

  /**
   * Per-frame update.
   * @param {number} dt
   * @param {object} s
   * @param {object} s.def          melee weapon definition
   * @param {boolean} s.attacking   whether a swing is in progress
   * @param {number} s.timer        seconds since the swing started
   * @param {string} s.facing       'right' | 'left'
   * @param {object} s.weapon       { group, trail: { base, tip }, color? }
   * @param {number} [s.bobPhase]
   * @param {number} [s.speedFactor]
   * @param {number} [s.switchT]    0..1 while a weapon is being drawn
   */
  update(dt, s) {
    this.kick *= Math.exp(-KICK_DECAY * dt);
    const bob = Math.sin(s.bobPhase || 0) * 0.012 * (s.speedFactor || 0);
    const dip = (s.switchT || 0) * 0.35;
    const kick = this.kick;

    const pose = s.attacking ? swingPoseAt(s.def, s.timer, s.facing) : REST_POSE;
    this.applyPose(
      pose,
      bob * 0.5 - kick * 0.008,
      Math.abs(bob) - dip - kick * KICK_DOWN,
      kick * KICK_BACK,
    );

    this.camera.updateMatrixWorld(true);
    if (s.weapon && s.weapon !== this.weapon) {
      this.weapon = s.weapon;
      this.trail.setColor(s.def.trailColor ?? 0xcfe8ff);
      this.trail.clear();
    }

    if (s.attacking && s.def && this.weapon) {
      const tl = swingTimeline(s.def);
      // Record the blade from the start of the forward strike until a little after follow-through.
      if (s.timer >= tl.windup && s.timer <= tl.follow + 0.03) this.recordSample();
    }
    this.trail.update(dt);
  }

  recordSample() {
    const { group, trail } = this.weapon;
    const cam = this.camera;
    const base = cam.worldToLocal(group.localToWorld(this._tmp.copy(trail.base)));
    const tip = cam.worldToLocal(group.localToWorld(new THREE.Vector3().copy(trail.tip)));
    this.trail.push(base, tip);
  }

  dispose() {
    this.trail.dispose();
    this.root.removeFromParent();
    const geometries = new Set();
    const materials = new Set();
    this.root.traverse((o) => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) materials.add(o.material);
    });
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
  }
}
