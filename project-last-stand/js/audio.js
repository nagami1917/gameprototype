/**
 * audio.js
 * ------------------------------------------------------------------
 * All game audio is synthesised with the Web Audio API, so the project
 * ships without binary sound files (assets/audio is reserved for any
 * future recorded samples).
 *
 *  - init() must be called from a user gesture (the Play button). Browsers
 *    keep AudioContext suspended until then; we resume it explicitly.
 *  - Positional sounds use simple distance attenuation and stereo panning
 *    relative to the listener (the player camera).
 *  - Voices are capped and freed through `onended`, so bursts of gunfire
 *    cannot exhaust the audio thread.
 *  - If Web Audio is unavailable every method is a silent no-op.
 */

const MAX_VOICES = 40;

export class AudioManager {
  constructor({ volume = 0.8 } = {}) {
    this.enabled = typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
    this.ctx = null;
    this.volume = volume;
    this.voices = 0;
    this.listener = { x: 0, z: 0, yaw: 0 };
    this.ambienceOn = false;
    this.ambienceLevel = 1;
    this.ambientTimer = 3;
    this.heartbeatRate = 0;
    this.heartbeatTimer = 0;
    this.ambNodes = null;
    this.pendingOutputs = [];
  }

  /** Creates the AudioContext. Call inside a click/keydown handler. */
  init() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volumeCurve(this.volume);
        this.master.connect(this.ctx.destination);
        this.sfxBus = this.ctx.createGain();
        this.sfxBus.gain.value = 0.9;
        this.sfxBus.connect(this.master);
        this.ambBus = this.ctx.createGain();
        this.ambBus.gain.value = 0.6;
        this.ambBus.connect(this.master);
        this.noise = this.createNoiseBuffer(2);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    } catch (err) {
      console.warn('[audio] Web Audio unavailable:', err);
      this.enabled = false;
      return false;
    }
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  volumeCurve(v) {
    const c = Math.min(1, Math.max(0, v));
    return c * c;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.setTargetAtTime(this.volumeCurve(this.volume), this.ctx.currentTime, 0.05);
  }

  setListener(x, z, yaw) {
    this.listener.x = x;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  createNoiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ------------------------------------------------------------------ *
   * Low-level helpers
   * ------------------------------------------------------------------ */
  canPlay() {
    return this.enabled && this.ready && this.voices < MAX_VOICES;
  }

  /** Spatial output node: distance attenuation + stereo pan toward `pos`. */
  output(pos = null, volume = 1) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    let g = volume;
    let pan = 0;
    if (pos) {
      const dx = pos.x - this.listener.x;
      const dz = pos.z - this.listener.z;
      const dist = Math.hypot(dx, dz);
      g *= Math.min(1, 1 / (1 + dist * 0.12));
      const d = dist || 1;
      // Listener right vector for yaw (see Player.rightVector).
      const rx = Math.cos(this.listener.yaw);
      const rz = -Math.sin(this.listener.yaw);
      pan = Math.max(-1, Math.min(1, ((dx / d) * rx + (dz / d) * rz) * 0.9));
    }
    gain.gain.value = g;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.connect(panner);
    panner.connect(this.sfxBus);
    // Remember the chain so it can be disconnected once the sound has finished.
    this.pendingOutputs.push({ gain, panner, until: ctx.currentTime + 3 });
    return gain;
  }

  /** Starts a noise source and frees its voice slot when it ends. */
  noiseSource(duration, offset = Math.random() * 1.5) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const t = this.ctx.currentTime;
    src.start(t, offset, duration + 0.05);
    src.stop(t + duration + 0.05);
    this.voices++;
    src.onended = () => { this.voices = Math.max(0, this.voices - 1); };
    return src;
  }

  /** Oscillator with an optional pitch glide, auto-disconnected via onended. */
  tone(type, f0, f1, duration, out) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + duration);
    osc.connect(out);
    osc.start(t);
    osc.stop(t + duration + 0.05);
    this.voices++;
    osc.onended = () => { this.voices = Math.max(0, this.voices - 1); };
    return osc;
  }

  /** Simple attack/decay envelope on a gain node. */
  envelope(gainNode, peak, attack, decay) {
    const t = this.ctx.currentTime;
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /** Noise burst through a filter. */
  burst({ pos = null, volume = 0.5, filter = 'bandpass', freq = 1000, q = 1, attack = 0.001, decay = 0.1, sweepTo = null }) {
    if (!this.canPlay()) return;
    const ctx = this.ctx;
    const out = this.output(pos, volume);
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + attack + decay);
    const env = ctx.createGain();
    f.connect(env);
    env.connect(out);
    this.envelope(env, 1, attack, decay);
    this.noiseSource(attack + decay).connect(f);
  }

  /** Pitched tone with an amplitude envelope. */
  blip({ pos = null, volume = 0.3, type = 'sine', f0 = 440, f1 = null, decay = 0.2, attack = 0.002 }) {
    if (!this.canPlay()) return;
    const out = this.output(pos, volume);
    const env = this.ctx.createGain();
    env.connect(out);
    this.envelope(env, 1, attack, decay);
    this.tone(type, f0, f1, attack + decay, env);
  }

  /* ------------------------------------------------------------------ *
   * Weapons
   * ------------------------------------------------------------------ */
  playShot(kind) {
    if (!this.canPlay()) return;
    if (kind === 'shotgun') {
      this.burst({ volume: 0.9, filter: 'lowpass', freq: 2600, q: 0.7, attack: 0.001, decay: 0.28, sweepTo: 400 });
      this.blip({ volume: 0.55, type: 'sine', f0: 110, f1: 32, decay: 0.3 });
    } else {
      this.burst({ volume: 0.55, filter: 'bandpass', freq: 1400, q: 0.9, attack: 0.001, decay: 0.09 });
      this.burst({ volume: 0.3, filter: 'highpass', freq: 3500, q: 0.5, attack: 0.001, decay: 0.012 });
      this.blip({ volume: 0.35, type: 'sine', f0: 140, f1: 45, decay: 0.12 });
    }
  }

  playDryFire() {
    this.blip({ volume: 0.2, type: 'square', f0: 1800, f1: 1400, decay: 0.02 });
    this.burst({ volume: 0.15, filter: 'highpass', freq: 4000, decay: 0.02 });
  }

  playSwitch() {
    this.burst({ volume: 0.2, filter: 'highpass', freq: 3800, decay: 0.035 });
    this.blip({ volume: 0.12, type: 'triangle', f0: 900, f1: 600, decay: 0.06 });
  }

  /** kind: magOut | magIn | shellStart | shell | pump */
  playReload(kind) {
    switch (kind) {
      case 'magOut':
        this.blip({ volume: 0.3, f0: 520, f1: 300, decay: 0.09 });
        this.burst({ volume: 0.25, freq: 2000, q: 1.5, decay: 0.05 });
        break;
      case 'magIn':
        this.blip({ volume: 0.35, f0: 820, f1: 620, decay: 0.07 });
        this.burst({ volume: 0.3, freq: 2400, q: 2, decay: 0.04 });
        break;
      case 'shellStart':
        this.burst({ volume: 0.2, freq: 2200, q: 2, decay: 0.03 });
        break;
      case 'shell':
        this.burst({ volume: 0.25, freq: 2600, q: 2.5, decay: 0.025 });
        break;
      case 'pump':
        this.blip({ volume: 0.35, f0: 200, f1: 120, decay: 0.14 });
        this.burst({ volume: 0.25, freq: 1500, q: 1, decay: 0.08 });
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ *
   * Impacts and combat feedback
   * ------------------------------------------------------------------ */
  playHitFlesh(headshot = false) {
    this.burst({ volume: 0.5, filter: 'lowpass', freq: 700, decay: 0.09 });
    this.blip({ volume: 0.35, f0: 210, f1: 90, decay: 0.1 });
    if (headshot) this.blip({ volume: 0.25, type: 'triangle', f0: 1900, f1: 1200, decay: 0.08 });
  }

  playHitMetal(pos = null) {
    this.blip({ pos, volume: 0.18, f0: 2200, f1: 2100, decay: 0.2 });
    this.blip({ pos, volume: 0.1, f0: 3100, f1: 3000, decay: 0.12 });
  }

  playKill(pos = null) {
    this.blip({ pos, volume: 0.3, f0: 90, f1: 35, decay: 0.35 });
  }

  playPlayerHurt() {
    this.blip({ volume: 0.45, f0: 150, f1: 70, decay: 0.3 });
    this.burst({ volume: 0.35, filter: 'lowpass', freq: 500, decay: 0.2 });
  }

  playPlayerDeath() {
    this.blip({ volume: 0.5, type: 'sawtooth', f0: 180, f1: 28, decay: 1.8 });
    this.burst({ volume: 0.3, filter: 'lowpass', freq: 600, decay: 1.2, sweepTo: 80 });
  }

  /* ------------------------------------------------------------------ *
   * Enemies
   * ------------------------------------------------------------------ */
  playEnemyGrowl(typeId, pos) {
    if (!this.canPlay()) return;
    const f0 = typeId === 'armored' ? 55 : typeId === 'runner' ? 170 : 105;
    const out = this.output(pos, 0.35);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 650;
    const env = this.ctx.createGain();
    filter.connect(env);
    env.connect(out);
    this.envelope(env, 1, 0.12, 0.6);
    const osc = this.tone('sawtooth', f0, f0 * 0.8, 0.8, filter);
    // Vibrato for a wet, throaty feel.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 7;
    const depth = this.ctx.createGain();
    depth.gain.value = f0 * 0.06;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    lfo.start();
    lfo.stop(this.ctx.currentTime + 0.85);
  }

  playEnemyAttack(pos) {
    this.burst({ pos, volume: 0.35, filter: 'bandpass', freq: 1600, q: 1.2, decay: 0.16, sweepTo: 500 });
    this.blip({ pos, volume: 0.2, f0: 260, f1: 150, decay: 0.15 });
  }

  playEnemyDeath(pos) {
    this.blip({ pos, volume: 0.35, type: 'sawtooth', f0: 220, f1: 60, decay: 0.6 });
    this.burst({ pos, volume: 0.3, filter: 'lowpass', freq: 900, decay: 0.5, sweepTo: 180 });
  }

  /* ------------------------------------------------------------------ *
   * Player movement and world
   * ------------------------------------------------------------------ */
  playFootstep(sprinting = false) {
    const f = sprinting ? 900 : 600;
    this.burst({ volume: sprinting ? 0.22 : 0.16, filter: 'lowpass', freq: f, decay: 0.07 });
  }

  playPickup(kind) {
    if (kind === 'health') {
      this.blip({ volume: 0.25, type: 'sine', f0: 660, decay: 0.12 });
      this.blip({ volume: 0.25, type: 'sine', f0: 990, decay: 0.2, attack: 0.09 });
    } else {
      this.blip({ volume: 0.2, type: 'triangle', f0: 440, decay: 0.12 });
      this.blip({ volume: 0.2, type: 'triangle', f0: 660, decay: 0.2, attack: 0.08 });
    }
  }

  playDoor(pos) {
    this.burst({ pos, volume: 0.25, filter: 'bandpass', freq: 300, q: 2, decay: 0.7, sweepTo: 180 });
    this.blip({ pos, volume: 0.15, f0: 80, f1: 50, decay: 0.6 });
  }

  playWaveStart() {
    this.blip({ volume: 0.25, type: 'square', f0: 440, decay: 0.35 });
    this.blip({ volume: 0.25, type: 'square', f0: 330, decay: 0.35, attack: 0.4 });
  }

  playWaveClear() {
    [392, 523, 659].forEach((f, i) => this.blip({ volume: 0.22, type: 'triangle', f0: f, decay: 0.4, attack: 0.1 * i }));
  }

  /* ------------------------------------------------------------------ *
   * Ambience (looping drone + wind + random metallic events)
   * ------------------------------------------------------------------ */
  startAmbience() {
    if (!this.enabled) return;
    if (!this.init()) return;
    if (!this.ambNodes) {
      const ctx = this.ctx;
      const amb = ctx.createGain();
      amb.gain.value = 0;
      amb.connect(this.ambBus);

      // Low drone: two detuned saws through a slowly moving lowpass.
      const drone = ctx.createBiquadFilter();
      drone.type = 'lowpass';
      drone.frequency.value = 180;
      drone.Q.value = 3;
      drone.connect(amb);
      const oscA = ctx.createOscillator();
      oscA.type = 'sawtooth';
      oscA.frequency.value = 43;
      const oscB = ctx.createOscillator();
      oscB.type = 'sawtooth';
      oscB.frequency.value = 43.6;
      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.05;
      oscA.connect(droneGain);
      oscB.connect(droneGain);
      droneGain.connect(drone);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.05;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 70;
      lfo.connect(lfoDepth);
      lfoDepth.connect(drone.frequency);

      // Wind: looping, band-limited noise with a slow swell.
      const wind = ctx.createBufferSource();
      wind.buffer = this.noise;
      wind.loop = true;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 380;
      windFilter.Q.value = 0.6;
      const windGain = ctx.createGain();
      windGain.gain.value = 0.035;
      wind.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(amb);
      const swell = ctx.createOscillator();
      swell.frequency.value = 0.08;
      const swellDepth = ctx.createGain();
      swellDepth.gain.value = 0.025;
      swell.connect(swellDepth);
      swellDepth.connect(windGain.gain);

      for (const n of [oscA, oscB, lfo, wind, swell]) n.start();
      this.ambNodes = { amb };
    }
    this.ambienceOn = true;
    this.applyAmbienceLevel();
  }

  stopAmbience() {
    this.ambienceOn = false;
    this.applyAmbienceLevel();
  }

  /** 1 = normal, ~0.4 when paused, 0 when muted by the game. */
  setAmbienceLevel(level) {
    this.ambienceLevel = level;
    this.applyAmbienceLevel();
  }

  applyAmbienceLevel() {
    if (!this.ambNodes || !this.ctx) return;
    const target = this.ambienceOn ? this.ambienceLevel : 0;
    this.ambNodes.amb.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
  }

  /** Enables a heartbeat loop at `bpm` beats per minute (0 disables it). */
  setHeartbeat(bpm) {
    this.heartbeatRate = bpm;
  }

  /** Called once per frame for timed ambient events and heartbeat. */
  update(dt) {
    if (!this.ready) return;
    // Disconnect finished output chains so the audio graph does not grow.
    const now = this.ctx.currentTime;
    for (let i = this.pendingOutputs.length - 1; i >= 0; i--) {
      const p = this.pendingOutputs[i];
      if (now >= p.until) {
        p.gain.disconnect();
        p.panner.disconnect();
        this.pendingOutputs.splice(i, 1);
      }
    }
    if (this.ambienceOn) {
      this.ambientTimer -= dt;
      if (this.ambientTimer <= 0) {
        this.ambientTimer = 5 + Math.random() * 8;
        const a = Math.random() * Math.PI * 2;
        const r = 8 + Math.random() * 20;
        const pos = { x: this.listener.x + Math.cos(a) * r, z: this.listener.z + Math.sin(a) * r };
        this.blip({ pos, volume: 0.09, f0: 620 + Math.random() * 400, f1: 500, decay: 0.9 });
        this.burst({ pos, volume: 0.12, filter: 'highpass', freq: 1500, decay: 0.2 });
      }
    }
    if (this.heartbeatRate > 0) {
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = 60 / this.heartbeatRate;
        this.blip({ volume: 0.35, f0: 70, f1: 45, decay: 0.12 });
        this.blip({ volume: 0.25, f0: 60, f1: 40, decay: 0.1, attack: 0.16 });
      }
    }
  }

  dispose() {
    try {
      this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.ambNodes = null;
    this.enabled = false;
  }
}
