/**
 * textures.js
 * ------------------------------------------------------------------
 * Procedural canvas textures. The game ships no image files: every
 * surface texture is painted at runtime with the 2D canvas API, which
 * keeps the project small and lets everything be tweaked in code.
 *
 * All functions must run in a browser (they use `document`).
 */
import * as THREE from 'three';

/** Seeded PRNG so textures look identical on every run. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function toTexture(canvas, { repeat = true, anisotropy = 4, srgb = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = tex.wrapS;
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Adds per-pixel luminance noise to a canvas (cheap grime / grain). */
function addNoise(ctx, w, h, amount, rand) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] = clampByte(d[i] + n);
    d[i + 1] = clampByte(d[i + 1] + n);
    d[i + 2] = clampByte(d[i + 2] + n);
  }
  ctx.putImageData(img, 0, 0);
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Concrete wall texture: mottled grey with cracks and water stains. */
export function createConcreteTexture({ anisotropy = 4 } = {}) {
  const size = 256;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = makeRng(1337);
  ctx.fillStyle = '#6b7075';
  ctx.fillRect(0, 0, size, size);
  // Soft blotches
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 10 + rand() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rand() < 0.6;
    g.addColorStop(0, dark ? 'rgba(30,32,36,0.18)' : 'rgba(180,185,190,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Cracks
  ctx.strokeStyle = 'rgba(20,20,22,0.6)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 6; i++) {
    let x = rand() * size;
    let y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      x += (rand() - 0.5) * 30;
      y += rand() * 16;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Water stain streaks running down the wall
  for (let i = 0; i < 8; i++) {
    const x = rand() * size;
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, 'rgba(40,44,40,0.0)');
    g.addColorStop(0.5, 'rgba(40,46,42,0.22)');
    g.addColorStop(1, 'rgba(40,46,42,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 3 + rand() * 6, size);
  }
  addNoise(ctx, size, size, 26, rand);
  return toTexture(c, { anisotropy });
}

/** Metal floor plating: panel seams, rivets and grime. */
export function createFloorTexture({ anisotropy = 4 } = {}) {
  const size = 256;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = makeRng(42);
  ctx.fillStyle = '#3a3f47';
  ctx.fillRect(0, 0, size, size);
  // Plate seams
  ctx.strokeStyle = 'rgba(10,12,15,0.9)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(120,130,140,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(3, 3, size - 6, size - 6);
  // Rivets
  ctx.fillStyle = 'rgba(150,160,170,0.35)';
  for (const [x, y] of [[20, 20], [236, 20], [20, 236], [236, 236], [128, 20], [128, 236]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Grime
  for (let i = 0; i < 30; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 8 + rand() * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(15,12,10,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  addNoise(ctx, size, size, 18, rand);
  return toTexture(c, { anisotropy });
}

/** Ceiling tiles with a grid of darker acoustic panels. */
export function createCeilingTexture({ anisotropy = 4 } = {}) {
  const size = 256;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = makeRng(7);
  ctx.fillStyle = '#2a2e35';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(5,6,8,0.9)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(70,80,90,0.25)';
  for (let y = 16; y < size; y += 64) {
    for (let x = 16; x < size; x += 64) ctx.fillRect(x, y, 32, 32);
  }
  addNoise(ctx, size, size, 14, rand);
  return toTexture(c, { anisotropy });
}

/** Wooden crate planks with a painted stencil. */
export function createCrateTexture({ anisotropy = 4 } = {}) {
  const size = 256;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = makeRng(99);
  ctx.fillStyle = '#7a5a36';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 4; i++) {
    const y = i * 64;
    ctx.fillStyle = `rgba(${40 + rand() * 30},${25 + rand() * 20},${12},0.35)`;
    ctx.fillRect(0, y + 2, size, 60);
    ctx.fillStyle = 'rgba(20,12,6,0.6)';
    ctx.fillRect(0, y + 62, size, 3);
  }
  // Frame boards
  ctx.strokeStyle = 'rgba(25,15,8,0.9)';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, size - 8, size - 8);
  // Stencil
  ctx.fillStyle = 'rgba(230,200,80,0.75)';
  ctx.font = 'bold 34px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('MED-SUP', size / 2, size / 2 + 12);
  addNoise(ctx, size, size, 22, rand);
  return toTexture(c, { anisotropy });
}

/** Yellow/black hazard stripes (door bands, tank bases). */
export function createHazardTexture({ anisotropy = 4 } = {}) {
  const size = 128;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e0b000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#141414';
  for (let x = -size; x < size * 2; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, size);
    ctx.lineTo(x + 32, size);
    ctx.lineTo(x + 32 + size, 0);
    ctx.lineTo(x + size, 0);
    ctx.closePath();
    ctx.fill();
  }
  return toTexture(c, { anisotropy });
}

/** Sliding blast-door panel with ribs and a hazard band at the bottom. */
export function createDoorTexture({ anisotropy = 4 } = {}) {
  const w = 256;
  const h = 256;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3b4250';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 24; y < h; y += 48) ctx.fillRect(0, y, w, 6);
  ctx.fillStyle = 'rgba(180,190,200,0.15)';
  for (let y = 30; y < h; y += 48) ctx.fillRect(0, y, w, 2);
  // Hazard band at the bottom
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, h - 40, w, 40);
  ctx.clip();
  ctx.fillStyle = '#d9a300';
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = '#151515';
  for (let x = -40; x < w + 40; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + 20, h);
    ctx.lineTo(x + 40, h - 40);
    ctx.lineTo(x + 20, h - 40);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  return toTexture(c, { anisotropy, repeat: false });
}

/** Lab monitor / console screen (emissive). */
export function createScreenTexture(seed = 1, { anisotropy = 4 } = {}) {
  const w = 256;
  const h = 160;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const rand = makeRng(seed * 977);
  ctx.fillStyle = '#041018';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#34ffd0';
  for (let row = 0; row < 9; row++) {
    const y = 14 + row * 16;
    const width = 40 + rand() * 170;
    ctx.globalAlpha = 0.5 + rand() * 0.5;
    ctx.fillRect(12, y, width, 6);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ff5050';
  ctx.font = 'bold 18px monospace';
  ctx.fillText(rand() < 0.5 ? 'SYSTEM FAULT' : 'CONTAINMENT LOST', 12, h - 14);
  // Scanlines
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  return toTexture(c, { anisotropy, repeat: false });
}

/** Warning signs used on corridor walls. */
const SIGN_STYLES = {
  danger: { text: 'DANGER', sub: 'NO ENTRY', bg: '#1a0d0d', accent: '#ff2a2a' },
  biohazard: { text: 'BIOHAZARD', sub: 'CONTAINMENT', bg: '#101a0e', accent: '#ffd21a' },
  quarantine: { text: 'QUARANTINE', sub: 'AUTHORIZED ONLY', bg: '#12161e', accent: '#ff7a1a' },
  keepclear: { text: 'KEEP CLEAR', sub: 'EMERGENCY EXIT', bg: '#0e1412', accent: '#33ff99' },
};

export function createWarningSignTexture(kind = 'danger', { anisotropy = 4 } = {}) {
  const style = SIGN_STYLES[kind] || SIGN_STYLES.danger;
  const w = 256;
  const h = 128;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = style.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = style.accent;
  ctx.lineWidth = 10;
  ctx.strokeRect(6, 6, w - 12, h - 12);
  // Diagonal corner accents
  ctx.fillStyle = style.accent;
  for (let i = 0; i < 4; i++) {
    const x = i % 2 === 0 ? 0 : w - 28;
    const y = i < 2 ? 0 : h - 28;
    ctx.fillRect(x, y, 28, 28);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = style.accent;
  ctx.font = 'bold 40px "Arial Narrow", Arial, sans-serif';
  ctx.fillText(style.text, w / 2, h / 2 + 4);
  ctx.fillStyle = 'rgba(230,230,230,0.8)';
  ctx.font = 'bold 18px monospace';
  ctx.fillText(style.sub, w / 2, h / 2 + 34);
  return toTexture(c, { anisotropy, repeat: false });
}

/** Alpha-blended blood splatter for floor decals. */
export function createBloodTexture(seed = 3, { anisotropy = 4 } = {}) {
  const size = 256;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = makeRng(seed * 131 + 7);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(90,6,8,0.92)';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 60, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 18; i++) {
    const a = rand() * Math.PI * 2;
    const d = 40 + rand() * 60;
    const r = 4 + rand() * 14;
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c, { repeat: false, anisotropy });
}

/** Dark bullet-hole decal with soft edges. */
export function createBulletHoleTexture({ anisotropy = 4 } = {}) {
  const size = 128;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(10,10,10,0.95)');
  g.addColorStop(0.35, 'rgba(20,20,20,0.85)');
  g.addColorStop(0.6, 'rgba(60,60,60,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return toTexture(c, { repeat: false, anisotropy, srgb: true });
}

/** Soft radial glow used for muzzle flashes and pickup halos. */
export function createGlowTexture(color = '#ffffff') {
  const size = 128;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color);
  g.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return toTexture(c, { repeat: false, anisotropy: 1 });
}
