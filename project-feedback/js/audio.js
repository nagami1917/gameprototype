/**
 * audio.js
 * Procedural Web Audio. Listens on the bus so weapons and the parry never
 * call into the synth directly. The parry ping is a paired high sine that
 * no other cue uses.
 */
import { EV } from './bus.js';
import { rankValue } from './config.js';

export function createAudio() {
  return {
    ctx: null,
    master: null,
    noise: null,
    volume: 0.8,
    muted: false,
    voices: 0,
    slideGain: null,
    lastRank: 'D',
    ready: false,
  };
}

export function initAudio(a) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  if (!a.ctx) {
    a.ctx = new Ctx();
    a.master = a.ctx.createGain();
    a.master.gain.value = a.muted ? 0 : a.volume * a.volume;
    a.master.connect(a.ctx.destination);
    const len = a.ctx.sampleRate * 2;
    const buf = a.ctx.createBuffer(1, len, a.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    a.noise = buf;
    const bed = a.ctx.createOscillator();
    bed.type = 'sine';
    bed.frequency.value = 55;
    const bed2 = a.ctx.createOscillator();
    bed2.type = 'triangle';
    bed2.frequency.value = 82;
    const bg = a.ctx.createGain();
    bg.gain.value = 0.018;
    bed.connect(bg);
    bed2.connect(bg);
    bg.connect(a.master);
    bed.start();
    bed2.start();
    const src = a.ctx.createBufferSource();
    src.buffer = a.noise;
    src.loop = true;
    const filter = a.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 380;
    filter.Q.value = 0.6;
    a.slideGain = a.ctx.createGain();
    a.slideGain.gain.value = 0;
    src.connect(filter);
    filter.connect(a.slideGain);
    a.slideGain.connect(a.master);
    src.start();
  }
  if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
  a.ready = true;
  return true;
}

export function setVolume(a, v) {
  a.volume = Math.max(0, Math.min(1, v));
  if (a.master && !a.muted) a.master.gain.setTargetAtTime(a.volume * a.volume, a.ctx.currentTime, 0.04);
}

export function setMuted(a, muted) {
  a.muted = muted;
  if (!a.master) return;
  a.master.gain.setTargetAtTime(muted ? 0 : a.volume * a.volume, a.ctx.currentTime, 0.03);
}

export function setSliding(a, sliding) {
  if (!a.slideGain || !a.ctx) return;
  a.slideGain.gain.setTargetAtTime(sliding ? 0.045 : 0, a.ctx.currentTime, 0.05);
}

function tone(a, freq, freq2, type, dur, gain) {
  if (!a.ctx || a.voices > 28) return;
  const t = a.ctx.currentTime;
  const o = a.ctx.createOscillator();
  const g = a.ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(1, freq), t);
  if (freq2) o.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g);
  g.connect(a.master);
  a.voices += 1;
  o.onended = () => {
    g.disconnect();
    a.voices -= 1;
  };
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(a, dur, gain, freq) {
  if (!a.ctx || !a.noise || a.voices > 28) return;
  const t = a.ctx.currentTime;
  const src = a.ctx.createBufferSource();
  src.buffer = a.noise;
  const filter = a.ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 0.8;
  const g = a.ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(a.master);
  a.voices += 1;
  src.onended = () => {
    g.disconnect();
    a.voices -= 1;
  };
  src.start(t);
  src.stop(t + dur + 0.02);
}

function sfxFire(a, kind, charged) {
  if (kind === 'pistol') {
    tone(a, charged ? 240 : 180, charged ? 90 : 70, 'square', charged ? 0.16 : 0.07, charged ? 0.16 : 0.08);
    noise(a, charged ? 0.12 : 0.05, 0.12, 1400);
  } else if (kind === 'shotgun') {
    noise(a, 0.18, 0.28, 600);
    tone(a, 90, 40, 'sawtooth', 0.16, 0.12);
  } else if (kind === 'rail') {
    tone(a, 180, 1400, 'sawtooth', 0.22, 0.1);
    tone(a, 880, 220, 'sine', 0.18, 0.06);
  } else if (kind === 'rocket') {
    noise(a, 0.2, 0.16, 300);
    tone(a, 70, 40, 'sine', 0.22, 0.1);
  } else if (kind === 'nail') {
    tone(a, 1800, 900, 'square', 0.03, 0.04);
  }
}

export function bindAudio(a, bus) {
  bus.on(EV.DASH, () => {
    noise(a, 0.12, 0.16, 900);
    tone(a, 220, 70, 'sine', 0.14, 0.08);
  });
  bus.on(EV.PARRY_START, () => noise(a, 0.08, 0.06, 1600));
  bus.on(EV.PARRY_OK, () => {
    // Distinct from every gun: two high sines a fifth apart, plus a click.
    tone(a, 880, 1320, 'sine', 0.12, 0.14);
    tone(a, 1760, 990, 'triangle', 0.1, 0.06);
    noise(a, 0.04, 0.1, 2400);
  });
  bus.on(EV.PARRY_WHIFF, () => tone(a, 180, 90, 'sine', 0.08, 0.04));
  bus.on(EV.FIRE, (e) => sfxFire(a, e.kind, e.charged));
  bus.on(EV.EMPTY, () => tone(a, 120, 80, 'square', 0.05, 0.05));
  bus.on(EV.RELOAD, () => noise(a, 0.06, 0.05, 500));
  bus.on(EV.SWITCH, () => tone(a, 640, 420, 'square', 0.04, 0.04));
  bus.on(EV.SLAM, () => {
    noise(a, 0.22, 0.3, 180);
    tone(a, 60, 32, 'sine', 0.28, 0.16);
  });
  bus.on(EV.EXPLODE, (e) => {
    if (e.radius > 0.2) {
      noise(a, 0.28, 0.32, 240);
      tone(a, 70, 36, 'sine', 0.26, 0.14);
    }
  });
  bus.on(EV.HURT, () => {
    tone(a, 160, 50, 'sawtooth', 0.18, 0.1);
    noise(a, 0.1, 0.1, 400);
  });
  bus.on(EV.HEAL, () => tone(a, 520, 780, 'sine', 0.1, 0.05));
  bus.on(EV.JUMP, () => tone(a, 240, 180, 'sine', 0.05, 0.03));
  bus.on(EV.WALL, () => {
    tone(a, 360, 180, 'square', 0.08, 0.05);
    noise(a, 0.06, 0.06, 800);
  });
  bus.on(EV.TELEGRAPH, () => tone(a, 520, 680, 'sine', 0.07, 0.04));
  bus.on(EV.ENEMY_FIRE, () => noise(a, 0.08, 0.08, 280));
  bus.on(EV.DEATH, () => {
    tone(a, 140, 36, 'sawtooth', 0.5, 0.12);
    noise(a, 0.4, 0.12, 200);
  });
  bus.on(EV.RANK, (e) => {
    const next = rankValue(e.tag);
    const prev = rankValue(a.lastRank);
    a.lastRank = e.tag;
    if (next > prev) {
      tone(a, 440, 880, 'square', 0.16, 0.06);
      tone(a, 660, 1320, 'sine', 0.18, 0.04);
    }
  });
}
