/**
 * arena.js
 * Builds the pit from the same boxes the simulation collides with.
 * Lighting is warm and low; enemy eyes and projectiles carry the read.
 */
import * as THREE from 'three';
import { INNER, TUNNEL, createArenaColliders } from './arenaData.js';

const MATS = {
  wall: { color: 0x3a342c, roughness: 0.88, metalness: 0.04 },
  pillar: { color: 0x4a5560, roughness: 0.42, metalness: 0.55 },
  platform: { color: 0x2e3a44, roughness: 0.7, metalness: 0.2 },
  crate: { color: 0x6a5340, roughness: 0.8, metalness: 0.08 },
  overhang: { color: 0x241e1a, roughness: 0.75, metalness: 0.12 },
};

function floorTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#1a1612';
  g.fillRect(0, 0, 1024, 1024);
  g.strokeStyle = '#2e2922';
  g.lineWidth = 2;
  for (let i = 0; i <= 1024; i += 64) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 1024);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(1024, i);
    g.stroke();
  }
  g.strokeStyle = '#c9842a';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(512, 512, 150, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(512, 512, 168, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 0.16;
  g.fillStyle = '#f3efe4';
  g.font = 'bold 240px Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('07', 512, 500);
  g.globalAlpha = 0.35;
  for (let i = 0; i < 1800; i++) {
    const v = 18 + Math.random() * 28;
    g.fillStyle = `rgba(${v},${v - 3},${v - 6},0.22)`;
    g.fillRect(Math.random() * 1024, Math.random() * 1024, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function label(text, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 96);
  g.fillStyle = color;
  g.font = 'bold 64px Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 0.6),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  return mesh;
}

export function buildArena(scene) {
  const boxes = createArenaColliders();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const materials = {};
  for (const key of Object.keys(MATS)) {
    materials[key] = new THREE.MeshStandardMaterial(MATS[key]);
  }
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const mesh = new THREE.Mesh(geo, materials[b.tag] || materials.wall);
    mesh.position.set(
      (b.minX + b.maxX) / 2,
      (b.minY + b.maxY) / 2,
      (b.minZ + b.maxZ) / 2,
    );
    mesh.scale.set(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
    scene.add(mesh);
  }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 64),
    new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.92, metalness: 0.02, color: 0xffffff }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  scene.add(floor);

  const hazard = new THREE.MeshStandardMaterial({
    color: 0xe0a04a, roughness: 0.45, metalness: 0.15, emissive: 0x6a3a08, emissiveIntensity: 0.35,
  });
  const lip = new THREE.Mesh(geo, hazard);
  lip.position.set((TUNNEL.minX + TUNNEL.maxX) / 2, TUNNEL.lipY, (TUNNEL.minZ + TUNNEL.maxZ) / 2);
  lip.scale.set(TUNNEL.maxX - TUNNEL.minX, 0.08, TUNNEL.maxZ - TUNNEL.minZ);
  scene.add(lip);

  const stripe = new THREE.Mesh(geo, hazard);
  const y = 0.22;
  stripe.position.set(0, y, -INNER + 0.08);
  stripe.scale.set(INNER * 2, 0.16, 0.12);
  scene.add(stripe);
  const stripe2 = stripe.clone();
  stripe2.position.set(0, y, INNER - 0.08);
  scene.add(stripe2);
  const stripe3 = stripe.clone();
  stripe3.position.set(-INNER + 0.08, y, 0);
  stripe3.scale.set(0.12, 0.16, INNER * 2);
  scene.add(stripe3);
  const stripe4 = stripe3.clone();
  stripe4.position.set(INNER - 0.08, y, 0);
  scene.add(stripe4);

  const slideMark = label('SLIDE', '#ffb000');
  slideMark.position.set(-9.5, 0.55, 11.35);
  slideMark.rotation.y = Math.PI;
  scene.add(slideMark);

  const wallMark = label('WALL', '#3ee0ff');
  wallMark.position.set(11.6, 1.35, 0);
  wallMark.rotation.y = -Math.PI / 2;
  scene.add(wallMark);

  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffb25a });
  const lamps = [
    [12, 3.4, 12],
    [-12, 3.4, -12],
    [12, 3.4, -12],
    [-12, 3.6, 8],
  ];
  for (let i = 0; i < lamps.length; i++) {
    const [x, ly, z] = lamps[i];
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 0.35), lampMat);
    bulb.position.set(x, ly, z);
    scene.add(bulb);
    const light = new THREE.PointLight(0xffb066, 18, 22, 2);
    light.position.set(x, ly, z);
    scene.add(light);
  }

  scene.add(new THREE.AmbientLight(0xfff0dc, 0.38));
  scene.add(new THREE.HemisphereLight(0xc8b89a, 0x1a120c, 0.45));
  const sun = new THREE.DirectionalLight(0xfff1d2, 1.7);
  sun.position.set(14, 22, 8);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x8ecfff, 0.4);
  rim.position.set(-12, 8, -10);
  scene.add(rim);

  scene.background = new THREE.Color(0x12100e);
  scene.fog = new THREE.FogExp2(0x12100e, 0.012);
  return boxes;
}
