/**
 * views.js
 * Camera, viewmodels, enemy meshes, pooled projectiles, beams and particles.
 * Simulation state is copied onto meshes here — views never decide damage.
 */
import * as THREE from 'three';
import { CFG } from './config.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _dir = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _c = new THREE.Color();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function part(geo, mat, x, y, z, sx, sy, sz) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  return m;
}

export function createViews(scene, camera) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const vm = new THREE.Group();
  const arm = new THREE.Group();
  camera.add(vm);
  camera.add(arm);
  vm.position.set(0.28, -0.24, -0.42);

  const steel = new THREE.MeshStandardMaterial({ color: 0xb7b1a6, roughness: 0.4, metalness: 0.65 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1916, roughness: 0.55, metalness: 0.4 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.8, metalness: 0.05 });
  const accent = new THREE.MeshStandardMaterial({
    color: 0xffb000, emissive: 0xffb000, emissiveIntensity: 0.8, roughness: 0.35, metalness: 0.4,
  });
  const knuckleMat = new THREE.MeshStandardMaterial({
    color: 0xf2efe6, emissive: 0xffb000, emissiveIntensity: 0.2, roughness: 0.35, metalness: 0.5,
  });

  function gun(kind) {
    const g = new THREE.Group();
    if (kind === 'pistol') {
      g.add(part(box, dark, 0, 0, 0, 0.07, 0.12, 0.22));
      g.add(part(box, steel, 0, 0.03, -0.16, 0.045, 0.045, 0.16));
      g.add(part(box, accent, 0, 0.08, -0.02, 0.02, 0.04, 0.04));
    } else if (kind === 'shotgun') {
      g.add(part(box, wood, 0, -0.02, 0.06, 0.08, 0.09, 0.28));
      g.add(part(box, dark, 0.03, 0.03, -0.16, 0.03, 0.03, 0.28));
      g.add(part(box, dark, -0.03, 0.03, -0.16, 0.03, 0.03, 0.28));
      g.add(part(box, accent, 0, 0.08, 0.02, 0.03, 0.02, 0.06));
    } else if (kind === 'rail') {
      g.add(part(box, dark, 0, 0, 0.02, 0.06, 0.07, 0.34));
      g.add(part(box, steel, 0, 0.01, -0.28, 0.025, 0.025, 0.36));
      g.add(part(sphere, accent, 0, 0.01, -0.08, 0.045, 0.045, 0.045));
      g.add(part(sphere, accent, 0, 0.01, -0.18, 0.04, 0.04, 0.04));
    } else if (kind === 'rocket') {
      g.add(part(box, dark, 0, 0, 0, 0.12, 0.12, 0.36));
      g.add(part(box, steel, 0, 0, -0.22, 0.09, 0.09, 0.16));
      g.add(part(box, accent, 0, 0.08, 0.04, 0.04, 0.03, 0.08));
    } else {
      g.add(part(box, dark, 0, 0, 0.02, 0.14, 0.1, 0.22));
      g.add(part(box, steel, 0.04, 0.02, -0.16, 0.02, 0.02, 0.2));
      g.add(part(box, steel, 0, 0.02, -0.16, 0.02, 0.02, 0.2));
      g.add(part(box, steel, -0.04, 0.02, -0.16, 0.02, 0.02, 0.2));
      g.add(part(box, accent, 0, 0.07, 0.02, 0.08, 0.02, 0.04));
    }
    const flash = new THREE.Mesh(
      sphere,
      new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    flash.position.set(0, 0.02, -0.42);
    flash.scale.setScalar(0.001);
    flash.visible = false;
    g.add(flash);
    g.userData.flash = flash;
    g.visible = false;
    vm.add(g);
    return g;
  }

  const guns = {
    pistol: gun('pistol'),
    shotgun: gun('shotgun'),
    rail: gun('rail'),
    rocket: gun('rocket'),
    nail: gun('nail'),
  };
  const gunKinds = ['pistol', 'shotgun', 'rail', 'rocket', 'nail'];

  const sleeve = new THREE.MeshStandardMaterial({ color: 0x2a241e, roughness: 0.8, metalness: 0.15 });
  arm.add(part(box, sleeve, 0, 0, 0.08, 0.09, 0.09, 0.22));
  arm.add(part(box, steel, 0, 0, -0.08, 0.08, 0.08, 0.12));
  const fist = part(box, steel, 0, 0, -0.16, 0.1, 0.09, 0.1);
  arm.add(fist);
  const knuckle = part(box, knuckleMat, 0, 0.02, -0.22, 0.08, 0.04, 0.04);
  arm.add(knuckle);
  arm.position.set(-0.36, -0.34, -0.22);

  const enemyViews = [];
  const eyeColors = { filth: 0xff3a2f, stray: 0xffb000, soldier: 0x9fd7ff };
  for (let i = 0; i < CFG.enemyPool; i++) {
    enemyViews.push(buildEnemy(box, sphere));
    scene.add(enemyViews[i].group);
  }

  const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const nailMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const orbMesh = new THREE.InstancedMesh(sphere, sphereMat, CFG.projectilePool);
  const nailMesh = new THREE.InstancedMesh(box, nailMat, CFG.projectilePool);
  orbMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  nailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  orbMesh.frustumCulled = false;
  nailMesh.frustumCulled = false;
  for (let i = 0; i < CFG.projectilePool; i++) {
    _m.makeScale(0, 0, 0);
    orbMesh.setMatrixAt(i, _m);
    nailMesh.setMatrixAt(i, _m);
    orbMesh.setColorAt(i, _c.setHex(0xff8a1e));
    nailMesh.setColorAt(i, _c.setHex(0xffe14a));
  }
  scene.add(orbMesh);
  scene.add(nailMesh);

  const beams = [];
  for (let i = 0; i < 14; i++) {
    const mesh = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    beams.push({ mesh, life: 0, max: 0.08 });
  }
  let beamCursor = 0;

  const rings = [];
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.52, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffb000, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    scene.add(mesh);
    rings.push({ mesh, life: 0 });
  }
  let ringCursor = 0;

  const boom = new THREE.Mesh(
    sphere,
    new THREE.MeshBasicMaterial({
      color: 0xff6a2a, transparent: true, opacity: 0.45, depthWrite: false,
    }),
  );
  boom.visible = false;
  scene.add(boom);
  let boomLife = 0;

  const P = 180;
  const pPos = new Float32Array(P * 3);
  const pCol = new Float32Array(P * 3);
  const sim = {
    x: new Float32Array(P), y: new Float32Array(P), z: new Float32Array(P),
    vx: new Float32Array(P), vy: new Float32Array(P), vz: new Float32Array(P),
    life: new Float32Array(P), cr: new Float32Array(P), cg: new Float32Array(P), cb: new Float32Array(P),
  };
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const points = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({
      size: 0.1, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }),
  );
  points.frustumCulled = false;
  scene.add(points);
  let pCursor = 0;

  const feel = {
    swayX: 0, swayY: 0, kick: 0, fovKick: 0, trauma: 0, dip: 0, roll: 0,
    flash: 0, time: 0, baseFov: CFG.fov, shake: 1,
  };

  function burst(x, y, z, hex, count, speed) {
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    for (let k = 0; k < count; k++) {
      const i = pCursor % P;
      pCursor += 1;
      sim.x[i] = x;
      sim.y[i] = y;
      sim.z[i] = z;
      const a = Math.random() * Math.PI * 2;
      const u = 0.3 + Math.random() * 0.7;
      sim.vx[i] = Math.cos(a) * speed * u;
      sim.vy[i] = (Math.random() * 0.8 + 0.2) * speed;
      sim.vz[i] = Math.sin(a) * speed * u;
      sim.life[i] = 0.18 + Math.random() * 0.22;
      sim.cr[i] = r;
      sim.cg[i] = g;
      sim.cb[i] = b;
    }
  }

  function beam(x1, y1, z1, x2, y2, z2, color, life, width) {
    const b = beams[beamCursor % beams.length];
    beamCursor += 1;
    b.life = life;
    b.max = life;
    b.mesh.visible = true;
    b.mesh.material.color.setHex(color);
    b.mesh.material.opacity = 0.9;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    b.mesh.scale.set(width, width, len);
    b.mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    _dir.set(dx / len, dy / len, dz / len);
    b.mesh.quaternion.setFromUnitVectors(_z, _dir);
  }

  function addTrauma(amount) {
    feel.trauma = Math.min(1, feel.trauma + amount * (reduce ? 0.25 : feel.shake));
  }

  function kickFov(amount) {
    feel.fovKick = Math.max(feel.fovKick, amount * (reduce ? 0.35 : 1));
  }

  function update(state, realDt) {
    feel.time += realDt;
    const p = state.player;
    feel.trauma = Math.max(0, feel.trauma - realDt * 1.4);
    feel.fovKick *= Math.exp(-6 * realDt);
    feel.dip *= Math.exp(-8 * realDt);
    feel.roll *= Math.exp(-7 * realDt);
    feel.kick = damp(feel.kick, 0, 14, realDt);
    if (state.justLanded) feel.dip = Math.min(0.12, feel.dip + 0.05);
    if (state.slamImpact) feel.dip = 0.14;

    const shake = feel.trauma * feel.trauma;
    const t = feel.time;
    const sx = Math.sin(t * 47) * shake * 0.07;
    const sy = Math.sin(t * 36 + 1.7) * shake * 0.05;
    const roll = Math.sin(t * 23) * shake * 0.03 + feel.roll;

    if (state.mode === 'menu') {
      vm.visible = false;
      arm.visible = false;
    } else {
      vm.visible = true;
      arm.visible = true;
      camera.position.set(p.x + sx, p.y + p.eye + sy - feel.dip, p.z);
      let pitch = p.pitch + sy * 0.55;
      if (!p.alive) pitch += Math.min(0.45, state.deathT || 0);
      if (state.slamming) pitch += 0.12;
      _euler.set(pitch, p.yaw + sx * 0.4, roll);
      camera.quaternion.setFromEuler(_euler);
      const targetFov = feel.baseFov + feel.fovKick + Math.min(10, p.speed * CFG.speedFov);
      if (Math.abs(camera.fov - targetFov) > 0.08) {
        camera.fov = damp(camera.fov, targetFov, 10, realDt);
        camera.updateProjectionMatrix();
      } else if (Math.abs(camera.fov - targetFov) > 0.02) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
    }

    const lookX = Math.max(-40, Math.min(40, state.lookX || 0));
    const lookY = Math.max(-40, Math.min(40, state.lookY || 0));
    feel.swayX = damp(feel.swayX, -lookX * 0.0016 - p.vx * 0.004, 8, realDt);
    feel.swayY = damp(feel.swayY, -lookY * 0.0012, 8, realDt);
    const equip = state.equip || 0;
    const equipK = equip > 0 ? Math.sin((equip / CFG.equipTime) * Math.PI) : 0;
    const parry = state.parry;
    let punch = 0;
    if (parry === 'active') punch = 1 - (state.parryTime / CFG.parryWindow);
    else if (parry === 'success') punch = 1;
    else if (parry === 'recovery') punch = Math.max(0, state.parryTime / CFG.parryRecovery);
    const ext = parry === 'active' ? 1 - (1 - Math.min(1, Math.max(0, punch))) ** 3 : Math.min(1, Math.max(0, punch));
    arm.position.set(-0.36 + ext * 0.24, -0.34 + ext * 0.26, -0.22 - ext * 0.5);
    knuckleMat.emissiveIntensity = parry === 'active' || parry === 'success' ? 2.4 : 0.15;
    vm.position.set(
      0.28 + feel.swayX + (parry === 'active' ? 0.06 : 0),
      -0.24 + feel.swayY - equipK * 0.2 - feel.kick * 0.08,
      -0.42 + (parry === 'active' ? 0.12 : 0),
    );
    vm.rotation.x = equipK * 0.7 + feel.kick * 0.35;
    const active = state.weaponKind || 'pistol';
    activeGun = active;
    for (let i = 0; i < gunKinds.length; i++) {
      const g = guns[gunKinds[i]];
      g.visible = gunKinds[i] === active;
      const fl = g.userData.flash;
      if (fl && fl.userData.life > 0) {
        fl.userData.life -= realDt;
        const k = Math.max(0, fl.userData.life / 0.05);
        fl.scale.setScalar(0.04 + (1 - k) * 0.12);
        fl.visible = k > 0.02;
      }
    }
    accent.color.setHex(state.variant === 1 ? 0xffb000 : state.variant === 2 ? 0x3ee0ff : 0xd7d1c6);
    accent.emissive.setHex(state.variant === 1 ? 0xffb000 : state.variant === 2 ? 0x3ee0ff : 0x000000);

    const list = state.enemies.list;
    for (let i = 0; i < enemyViews.length; i++) {
      const v = enemyViews[i];
      const e = list[i];
      if (!e || !e.alive) {
        v.group.visible = false;
        continue;
      }
      v.group.visible = true;
      v.filth.visible = e.type === 'filth';
      v.stray.visible = e.type === 'stray';
      v.soldier.visible = e.type === 'soldier';
      const active = e.type === 'soldier' ? v.soldier : e.type === 'filth' ? v.filth : v.stray;
      const bob = e.type === 'stray' ? 0.08 + Math.sin(feel.time * 2.4 + i) * 0.05 : 0;
      v.group.position.set(e.x, e.y + bob, e.z);
      v.group.rotation.set(0, e.yaw, e.state === 'stagger' ? 0.4 : 0);
      const sc = e.spawnIn > 0 ? Math.max(0.05, 1 - e.spawnIn / 0.18) : 1;
      v.group.scale.setScalar(sc);
      active.body.emissive.setHex(e.flash > 0 ? 0xfff6ea : 0x000000);
      active.body.emissiveIntensity = e.flash > 0 ? 0.85 : 0.04;
      const eyeHex = (e.state === 'windup' || e.state === 'telegraph') ? 0xffc14a
        : e.state === 'strike' ? 0xffffff
          : eyeColors[e.type];
      active.eye.emissive.setHex(eyeHex);
      active.eye.color.setHex(eyeHex);
      const h = Math.max(0.02, e.hp / e.maxHp);
      v.hp.scale.x = h;
      v.hp.position.x = (h - 1) * 0.4;
      v.bar.position.y = e.height + 0.28;
      v.bar.rotation.y = p.yaw - e.yaw;
    }

    for (let i = 0; i < state.projectiles.n; i++) {
      const pool = state.projectiles;
      if (!pool.alive[i]) {
        _s.set(0, 0, 0);
        _m.compose(_p.set(0, -20, 0), _q.identity(), _s);
        orbMesh.setMatrixAt(i, _m);
        nailMesh.setMatrixAt(i, _m);
        continue;
      }
      const reflected = (pool.flags[i] & 1) !== 0;
      const kind = pool.kind[i];
      let hex = 0xff8a1e;
      if (kind === 3) hex = 0xfff4c8;
      else if (kind === 2) hex = 0xff4a18;
      else if (kind === 1) hex = 0xffe14a;
      if (reflected) hex = 0x3ee0ff;
      _c.setHex(hex);
      if (kind === 1) {
        _s.set(0, 0, 0);
        _m.compose(_p.set(0, -20, 0), _q.identity(), _s);
        orbMesh.setMatrixAt(i, _m);
        const sp = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i]) || 1;
        _dir.set(pool.vx[i] / sp, pool.vy[i] / sp, pool.vz[i] / sp);
        _q.setFromUnitVectors(_z, _dir);
        _s.set(0.045, 0.045, 0.22);
        _m.compose(_p.set(pool.x[i], pool.y[i], pool.z[i]), _q, _s);
        nailMesh.setMatrixAt(i, _m);
        nailMesh.setColorAt(i, _c);
      } else {
        _s.set(0, 0, 0);
        _m.compose(_p.set(0, -20, 0), _q.identity(), _s);
        nailMesh.setMatrixAt(i, _m);
        const rad = kind === 2 ? 0.28 : kind === 3 ? 0.14 : 0.32;
        _s.set(rad, rad, rad);
        _m.compose(_p.set(pool.x[i], pool.y[i], pool.z[i]), _q.identity(), _s);
        orbMesh.setMatrixAt(i, _m);
        orbMesh.setColorAt(i, _c);
        if (reflected) burst(pool.x[i], pool.y[i], pool.z[i], 0x3ee0ff, 1, 0.4);
      }
    }
    orbMesh.instanceMatrix.needsUpdate = true;
    nailMesh.instanceMatrix.needsUpdate = true;
    if (orbMesh.instanceColor) orbMesh.instanceColor.needsUpdate = true;
    if (nailMesh.instanceColor) nailMesh.instanceColor.needsUpdate = true;

    let drawn = 0;
    for (let i = 0; i < P; i++) {
      if (sim.life[i] <= 0) continue;
      sim.life[i] -= realDt;
      sim.vy[i] -= 8 * realDt;
      sim.x[i] += sim.vx[i] * realDt;
      sim.y[i] += sim.vy[i] * realDt;
      sim.z[i] += sim.vz[i] * realDt;
      if (sim.life[i] <= 0) continue;
      pPos[drawn * 3] = sim.x[i];
      pPos[drawn * 3 + 1] = sim.y[i];
      pPos[drawn * 3 + 2] = sim.z[i];
      pCol[drawn * 3] = sim.cr[i];
      pCol[drawn * 3 + 1] = sim.cg[i];
      pCol[drawn * 3 + 2] = sim.cb[i];
      drawn += 1;
    }
    pGeo.setDrawRange(0, drawn);
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;

    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      if (b.life <= 0) continue;
      b.life -= realDt;
      b.mesh.material.opacity = Math.max(0, b.life / b.max);
      b.mesh.visible = b.life > 0;
    }
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (r.life <= 0) continue;
      r.life -= realDt;
      const k = 1 - r.life / 0.38;
      r.mesh.scale.setScalar(1 + k * 9);
      r.mesh.material.opacity = Math.max(0, r.life / 0.38) * 0.85;
      r.mesh.visible = r.life > 0;
    }
    if (boomLife > 0) {
      boomLife -= realDt;
      const k = 1 - boomLife / 0.22;
      boom.scale.setScalar(0.4 + k * 2.4);
      boom.material.opacity = Math.max(0, boomLife / 0.22) * 0.5;
      boom.visible = boomLife > 0;
    }
  }

  return {
    feel,
    update,
    addTrauma,
    kickFov,
    burst,
    beam,
    muzzle() {
      feel.kick = Math.min(1, feel.kick + 0.55);
      const g = guns[activeGun];
      const fl = g && g.userData.flash;
      if (fl) {
        fl.visible = true;
        fl.userData.life = 0.05;
        fl.scale.setScalar(0.14);
      }
    },
    shockwave(x, y, z) {
      const r = rings[ringCursor % rings.length];
      ringCursor += 1;
      r.life = 0.38;
      r.mesh.visible = true;
      r.mesh.position.set(x, y + 0.08, z);
      r.mesh.scale.setScalar(1);
      r.mesh.material.opacity = 0.85;
    },
    explode(x, y, z) {
      boom.visible = true;
      boom.position.set(x, y, z);
      boomLife = 0.22;
      burst(x, y, z, 0xff6a22, 16, 7);
    },
    setFov(fov) {
      feel.baseFov = fov;
      camera.fov = fov;
      camera.updateProjectionMatrix();
    },
    setShake(on) { feel.shake = on ? 1 : 0; },
  };
}

function variantMats(bodyHex, eyeHex) {
  return {
    body: new THREE.MeshStandardMaterial({
      color: bodyHex, roughness: 0.55, metalness: 0.35, emissive: 0x000000, emissiveIntensity: 0,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1a1614, roughness: 0.7, metalness: 0.25 }),
    eye: new THREE.MeshStandardMaterial({
      color: eyeHex, emissive: eyeHex, emissiveIntensity: 1.6, roughness: 0.3,
    }),
  };
}

function makeFilth(box, mats) {
  const g = new THREE.Group();
  g.add(part(box, mats.body, 0, 0.38, 0, 0.7, 0.42, 1.15));
  g.add(part(box, mats.dark, 0, 0.55, -0.55, 0.28, 0.22, 0.28));
  g.add(part(box, mats.eye, 0, 0.58, -0.7, 0.12, 0.08, 0.06));
  g.add(part(box, mats.dark, 0.22, 0.16, 0.3, 0.1, 0.28, 0.1));
  g.add(part(box, mats.dark, -0.22, 0.16, 0.3, 0.1, 0.28, 0.1));
  g.add(part(box, mats.dark, 0.22, 0.16, -0.3, 0.1, 0.28, 0.1));
  g.add(part(box, mats.dark, -0.22, 0.16, -0.3, 0.1, 0.28, 0.1));
  g.visible = false;
  return { group: g, body: mats.body, eye: mats.eye };
}

function makeStray(box, sphere, mats) {
  const g = new THREE.Group();
  g.add(part(box, mats.body, 0, 1.05, 0, 0.55, 0.7, 0.4));
  g.add(part(sphere, mats.eye, 0, 1.15, -0.22, 0.16, 0.16, 0.1));
  g.add(part(box, mats.dark, 0, 0.95, -0.38, 0.1, 0.1, 0.28));
  g.add(part(box, mats.dark, 0, 0.45, 0, 0.12, 0.7, 0.12));
  g.visible = false;
  return { group: g, body: mats.body, eye: mats.eye };
}

function makeSoldier(box, mats) {
  const g = new THREE.Group();
  g.add(part(box, mats.body, 0, 1.05, 0, 0.62, 0.9, 0.38));
  g.add(part(box, mats.dark, 0, 1.62, 0, 0.32, 0.28, 0.3));
  g.add(part(box, mats.eye, 0, 1.62, -0.16, 0.22, 0.06, 0.04));
  g.add(part(box, mats.dark, 0.42, 1.2, -0.1, 0.28, 0.16, 0.5));
  g.add(part(box, mats.dark, 0, 0.4, 0, 0.16, 0.7, 0.16));
  g.visible = false;
  return { group: g, body: mats.body, eye: mats.eye };
}

function buildEnemy(box, sphere) {
  const group = new THREE.Group();
  const filth = makeFilth(box, variantMats(0x7a3030, 0xff3a2f));
  const stray = makeStray(box, sphere, variantMats(0x8a4038, 0xffb000));
  const soldier = makeSoldier(box, variantMats(0x5c403c, 0x9fd7ff));
  group.add(filth.group, stray.group, soldier.group);
  const bar = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.06),
    new THREE.MeshBasicMaterial({ color: 0x2a1210, depthTest: false }),
  );
  const hp = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.045),
    new THREE.MeshBasicMaterial({ color: 0xff3a2f, depthTest: false }),
  );
  hp.position.z = 0.01;
  bar.add(bg);
  bar.add(hp);
  bar.position.y = 1.9;
  group.add(bar);
  group.visible = false;
  return { group, filth, stray, soldier, bar, hp };
}
