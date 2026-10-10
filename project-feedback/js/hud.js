/**
 * hud.js
 * DOM readout. Continuous values are polled from a reused snapshot.
 * Flashes and style lines arrive on the bus and copy their strings immediately.
 */
import { EV } from './bus.js';
import { SLOT_LABELS } from './config.js';

export function createHud() {
  const $ = (id) => document.getElementById(id);
  const segs = [...document.querySelectorAll('#dash-segs .seg i')];
  const slots = [...document.querySelectorAll('#slots button')];
  const lines = [...document.querySelectorAll('#style-log li')];
  const hud = {
    root: $('hud'),
    hpNum: $('hp-num'),
    hpFill: $('hp-fill'),
    healPop: $('heal-pop'),
    kills: $('kills'),
    parries: $('parries'),
    dodges: $('dodges'),
    timer: $('timer'),
    rank: $('rank'),
    combo: $('combo'),
    styleFill: $('style-fill'),
    lines,
    segs,
    slots,
    wall: $('wallkicks'),
    wName: $('w-name'),
    wVar: $('w-var'),
    wAmmo: $('w-ammo'),
    wFill: $('w-fill'),
    speed: $('speed'),
    charge: $('charge-meter'),
    cross: $('crosshair'),
    hint: $('hint'),
    capture: $('capture-hint'),
    flash: $('flash'),
    hurt: $('hurt'),
    menu: $('menu'),
    pause: $('pause'),
    dead: $('dead'),
    menuBest: $('menu-best'),
    fatal: $('fatal'),
    _hp: '',
    _rank: '',
    _ammo: '',
    _hint: '',
  };
  return hud;
}

export function bindHud(hud, bus, onSlot) {
  hud.slots.forEach((btn) => {
    btn.addEventListener('click', () => onSlot(Number(btn.dataset.slot)));
  });
  bus.on(EV.PARRY_OK, () => flash(hud, 'rgba(62, 224, 255, 0.85)'));
  bus.on(EV.HURT, () => flash(hud, 'rgba(255, 40, 30, 0.55)'));
  bus.on(EV.HEAL, (e) => {
    const n = Math.round(e.amount);
    if (n <= 0) return;
    hud.healPop.textContent = '+' + n;
    hud.healPop.classList.remove('pop');
    void hud.healPop.offsetWidth;
    hud.healPop.classList.add('pop');
  });
  bus.on(EV.STYLE, (e) => pushLine(hud, e.tag));
  bus.on(EV.RANK, (e) => {
    if (e.tag === 'S' || e.tag === 'A') flash(hud, e.tag === 'S' ? 'rgba(255, 59, 47, 0.35)' : 'rgba(255, 193, 74, 0.28)');
  });
  bus.on(EV.SLAM, () => flash(hud, 'rgba(255, 176, 0, 0.28)'));
}

function flash(hud, color) {
  const el = hud.flash;
  el.style.background = color;
  el.style.transition = 'none';
  el.style.opacity = '1';
  requestAnimationFrame(() => {
    el.style.transition = 'opacity 0.28s linear';
    el.style.opacity = '0';
  });
}

function pushLine(hud, tag) {
  if (!tag) return;
  const lines = hud.lines;
  for (let i = lines.length - 1; i > 0; i--) lines[i].textContent = lines[i - 1].textContent;
  lines[0].textContent = tag;
  lines[0].classList.remove('pop');
  void lines[0].offsetWidth;
  lines[0].classList.add('pop');
}

export function updateHud(hud, s) {
  const hp = Math.ceil(s.hp);
  const hpText = hp + ' / ' + s.maxHp;
  if (hud._hp !== hpText) {
    hud._hp = hpText;
    hud.hpNum.textContent = hpText;
  }
  hud.hpFill.style.transform = 'scaleX(' + Math.max(0, s.hp / s.maxHp) + ')';
  hud.hpFill.classList.toggle('low', s.hp < s.maxHp * 0.3);
  if (hud.kills.textContent !== String(s.kills)) hud.kills.textContent = String(s.kills);
  if (hud.parries.textContent !== String(s.parries)) hud.parries.textContent = String(s.parries);
  if (hud.dodges.textContent !== String(s.dodges)) hud.dodges.textContent = String(s.dodges);
  if (hud.timer.textContent !== s.timeText) hud.timer.textContent = s.timeText;

  if (hud._rank !== s.rank) {
    hud._rank = s.rank;
    hud.rank.textContent = s.rank;
    hud.rank.dataset.rank = s.rank;
  }
  hud.styleFill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, s.meter / 100)) + ')';
  const combo = s.combo > 1 ? 'x' + s.combo : '';
  if (hud.combo.textContent !== combo) hud.combo.textContent = combo;

  for (let i = 0; i < 3; i++) {
    let pct = 0;
    if (i < s.charges) pct = 1;
    else if (i === s.charges) pct = s.chargeFrac;
    hud.segs[i].style.transform = 'scaleX(' + pct + ')';
  }
  const wall = s.airborne ? 'WALL ' + s.wallLeft : '';
  if (hud.wall.textContent !== wall) hud.wall.textContent = wall;

  if (hud.wName.textContent !== s.weaponName) hud.wName.textContent = s.weaponName;
  if (hud.wVar.textContent !== s.variantName) hud.wVar.textContent = s.variantName;
  if (hud._ammo !== s.ammo) {
    hud._ammo = s.ammo;
    hud.wAmmo.textContent = s.ammo;
  }
  hud.wFill.style.transform = 'scaleX(' + s.ammoFrac + ')';
  hud.slots.forEach((btn, i) => {
    btn.classList.toggle('on', i === s.slot);
    const pips = btn.querySelectorAll('i');
    pips.forEach((pip, v) => pip.classList.toggle('on', i === s.slot && v === s.variant));
    if (!btn.dataset.ready) {
      btn.dataset.ready = '1';
      const label = btn.querySelector('span');
      if (label) label.textContent = SLOT_LABELS[i];
    }
  });

  const spd = String(Math.round(s.speed));
  if (hud.speed.textContent !== spd) hud.speed.textContent = spd;

  hud.charge.style.transform = 'scaleX(' + s.charge + ')';
  hud.charge.classList.toggle('show', s.charge > 0.02);
  hud.cross.classList.toggle('parry', s.parry === 'active');
  hud.cross.classList.toggle('on-target', s.onTarget);
  hud.cross.style.setProperty('--gap', (6 + s.spreadPx) + 'px');
  hud.root.classList.toggle('iframes', s.iframes);
  hud.hurt.style.opacity = String(Math.min(0.65, s.hurt));
  if (hud._hint !== s.hint) {
    hud._hint = s.hint;
    hud.hint.textContent = s.hint;
  }
  hud.capture.hidden = !s.showCapture;
}

export function showScreen(hud, name) {
  hud.menu.classList.toggle('hidden', name !== 'menu');
  hud.pause.classList.toggle('hidden', name !== 'pause');
  hud.dead.classList.toggle('hidden', name !== 'dead');
  hud.root.classList.toggle('hidden', name === 'menu');
}

export function setMenuBest(hud, text) {
  hud.menuBest.textContent = text;
}

export function fillDeath(hud, stats) {
  document.getElementById('go-rank').textContent = stats.rank;
  document.getElementById('go-kills').textContent = String(stats.kills);
  document.getElementById('go-parries').textContent = String(stats.parries);
  document.getElementById('go-dodges').textContent = String(stats.dodges);
  document.getElementById('go-time').textContent = stats.timeText;
  document.getElementById('go-note').textContent = stats.note;
}

export function showFatal(hud, message) {
  if (!hud.fatal) return;
  hud.fatal.hidden = false;
  hud.fatal.textContent = message;
}
