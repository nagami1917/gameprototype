/**
 * ui.js
 * ------------------------------------------------------------------
 * DOM user interface: menus, HUD, feedback overlays and keyboard navigation.
 *
 * The UI never owns game state. The game pushes snapshots in (updateHud,
 * showGameOver, setMode...) and the UI reports user actions back through
 * the hooks object passed to bind().
 *
 * HUD updates are diffed: a value is only written to the DOM when it changes.
 */

const SCREEN_IDS = ['menu', 'loadout', 'settings', 'controls', 'credits', 'pause', 'gameover', 'loading'];

export class UI {
  constructor(root = document) {
    this.root = root;
    this.el = {};
    this.lastHud = {};
    this.screen = null;
    this.settingsFrom = 'menu';
    this.hooks = {};
    this.cacheElements();
  }

  $(id) {
    return this.root.getElementById(id);
  }

  cacheElements() {
    const ids = [
      'hud', 'hud-wave', 'hud-remaining', 'hud-phase', 'hud-score', 'hud-kills',
      'hud-health-text', 'hud-health-fill', 'hud-weapon', 'hud-ammo', 'hud-reserve', 'hud-status',
      'hud-stamina-text', 'hud-stamina-bar', 'hud-stamina-fill', 'dash-effect',
      'crosshair', 'hitmarker', 'flash-damage', 'low-health', 'damage-indicator',
      'banner', 'banner-title', 'banner-sub', 'countdown', 'toasts',
      'hud-slots',
      'menu-high-score', 'menu-high-wave', 'go-score', 'go-kills', 'go-wave', 'go-headshots', 'go-record',
      'set-sensitivity', 'out-sensitivity', 'set-fov', 'out-fov', 'set-volume', 'out-volume',
      'set-invert', 'set-shadows', 'set-shake', 'loading-text', 'pause-note',
      'loadout-grid', 'fatal-error', 'fatal-text',
    ];
    for (const id of ids) this.el[id] = this.$(id);
    this.slotEls = Array.from(this.root.querySelectorAll('[data-slot]'));
  }

  /**
   * Connects buttons and inputs to callbacks.
   * hooks: onPlay, onResume, onRestart, onMainMenu, onRetry,
   *        onSettingsChange(settings), onSettingsReset(), onSettingsOpened(), onSettingsClosed()
   */
  bind(hooks) {
    this.hooks = hooks;
    const on = (id, fn) => {
      const el = this.$(id);
      if (el) el.addEventListener('click', fn);
    };
    on('btn-play', () => hooks.onPlay?.());
    on('btn-loadout', () => this.showScreen('loadout'));
    on('btn-loadout-back', () => this.showScreen('menu'));
    on('btn-settings', () => this.openSettings('menu'));
    on('btn-controls', () => this.showScreen('controls'));
    on('btn-credits', () => this.showScreen('credits'));
    on('btn-controls-back', () => this.showScreen('menu'));
    on('btn-credits-back', () => this.showScreen('menu'));
    on('btn-settings-back', () => this.closeSettings());
    on('btn-resume', () => hooks.onResume?.());
    on('btn-restart', () => hooks.onRestart?.());
    on('btn-pause-settings', () => this.openSettings('pause'));
    on('btn-main-menu-pause', () => hooks.onMainMenu?.());
    on('btn-retry', () => hooks.onRetry?.());
    on('btn-main-menu-over', () => hooks.onMainMenu?.());
    on('btn-settings-reset', () => {
      hooks.onSettingsReset?.();
    });

    const sliderHandler = () => {
      const settings = this.readSettingsControls();
      this.writeSettingsOutputs(settings);
      hooks.onSettingsChange?.(settings);
    };
    for (const id of ['set-sensitivity', 'set-fov', 'set-volume', 'set-invert', 'set-shadows', 'set-shake']) {
      const el = this.$(id);
      if (el) el.addEventListener('input', sliderHandler);
      if (el) el.addEventListener('change', sliderHandler);
    }

    // The loadout screen reports the whole five-slot kit on every change; the
    // game sanitizes it and writes the accepted loadout straight back.
    const loadoutGrid = this.el['loadout-grid'];
    if (loadoutGrid) {
      loadoutGrid.addEventListener('change', () => {
        hooks.onLoadoutChange?.(this.readLoadoutControls());
      });
    }

    this.root.addEventListener('keydown', (e) => this.handleKey(e));
  }

  /* ------------------------------------------------------------------ *
   * Screens
   * ------------------------------------------------------------------ */
  /** Shows one overlay screen (ids map to `screen-<id>`) and hides the rest. */
  showScreen(id) {
    this.hideAllScreens();
    this.screen = id;
    this.$(`screen-${id}`)?.classList.remove('hidden');
    this.focusFirst(id);
  }

  /** Shows the requested screen; keeps `hud` untouched. */
  setMode(mode) {
    const hud = this.el.hud;
    switch (mode) {
      case 'menu':
        hud.classList.add('hidden');
        this.showScreen('menu');
        break;
      case 'playing':
        this.hideAllScreens();
        hud.classList.remove('hidden');
        hud.classList.remove('dimmed');
        break;
      case 'paused':
        hud.classList.remove('hidden');
        hud.classList.add('dimmed');
        this.showScreen('pause');
        break;
      case 'gameover':
        hud.classList.remove('hidden');
        hud.classList.add('dimmed');
        break;
      case 'loading':
        hud.classList.add('hidden');
        this.showScreen('loading');
        break;
      default:
        break;
    }
  }

  hideAllScreens() {
    this.screen = null;
    for (const s of SCREEN_IDS) this.$(`screen-${s}`)?.classList.add('hidden');
  }

  openSettings(from) {
    this.settingsFrom = from;
    this.showScreen('settings');
    this.hooks.onSettingsOpened?.(from);
  }

  closeSettings() {
    this.hooks.onSettingsClosed?.();
    this.showScreen(this.settingsFrom === 'pause' ? 'pause' : 'menu');
  }

  /** Shows the game-over panel with final numbers. */
  showGameOver({ score, kills, wave, headshots, recordText }) {
    this.setText(this.el['go-score'], score.toLocaleString());
    this.setText(this.el['go-kills'], String(kills));
    this.setText(this.el['go-wave'], String(wave));
    this.setText(this.el['go-headshots'], String(headshots));
    this.setText(this.el['go-record'], recordText || '\u00a0');
    this.hideAllScreens();
    this.screen = 'gameover';
    this.$('screen-gameover')?.classList.remove('hidden');
    this.focusFirst('gameover');
  }

  showPause(note) {
    if (note) this.setText(this.el['pause-note'], note);
    this.setMode('paused');
  }

  setLoadingText(text) {
    this.setText(this.el['loading-text'], text);
  }

  /**
   * Rebuilds the HUD slot chips from the live loadout (index i = key i + 1),
   * so the HUD lists what the player actually carries instead of a fixed set.
   * @param {string[]} labels  e.g. ['1 RIFLE', '2 SHOTGUN', '3 KNIFE', ...]
   */
  setLoadout(labels) {
    const container = this.el['hud-slots'];
    if (!container) return;
    container.textContent = '';
    labels.forEach((label, i) => {
      const span = this.root.createElement('span');
      span.className = 'slot';
      span.dataset.slot = String(i + 1);
      span.textContent = label;
      container.appendChild(span);
    });
    this.slotEls = Array.from(container.querySelectorAll('[data-slot]'));
    // The chips are new elements, so the active-slot diff must repaint them.
    delete this.lastHud.slot;
  }

  /**
   * Fills the loadout screen: one select per key, listing the weapons that fit
   * that slot. The rows are only rebuilt when the offered options change, so
   * writing a rejected (duplicate) loadout back does not steal focus.
   *
   * @param {string[]} loadout  weapon id per key
   * @param {Array<{index:number,name:string,options:Array<{id:string,name:string}>}>} slots
   */
  writeLoadoutControls(loadout, slots = []) {
    const grid = this.el['loadout-grid'];
    if (!grid || slots.length === 0) return;
    const signature = slots.map((slot) => slot.options.map((option) => option.id).join('|')).join(';');
    if (grid.dataset.options !== signature) {
      grid.textContent = '';
      for (const slot of slots) {
        const row = this.root.createElement('label');
        row.className = 'setting loadout-row';
        const name = this.root.createElement('span');
        name.className = 'setting-name';
        name.textContent = slot.name;
        const select = this.root.createElement('select');
        select.className = 'loadout-select';
        select.dataset.loadoutSlot = String(slot.index);
        for (const option of slot.options) {
          const el = this.root.createElement('option');
          el.value = option.id;
          // Weapons that unlock later are listed but flagged, so the screen
          // stays honest about what a fresh save can actually pick.
          el.textContent = option.unlockWave > 1 ? `${option.name} (WAVE ${option.unlockWave})` : option.name;
          select.appendChild(el);
        }
        row.appendChild(name);
        row.appendChild(select);
        grid.appendChild(row);
      }
      grid.dataset.options = signature;
    }
    for (const select of grid.querySelectorAll('[data-loadout-slot]')) {
      select.value = loadout[Number(select.dataset.loadoutSlot)] ?? select.value;
    }
  }

  /** Reads the five selects back into a weapon id per key. */
  readLoadoutControls() {
    const grid = this.el['loadout-grid'];
    if (!grid) return [];
    return Array.from(grid.querySelectorAll('[data-loadout-slot]'))
      .sort((a, b) => Number(a.dataset.loadoutSlot) - Number(b.dataset.loadoutSlot))
      .map((select) => select.value);
  }

  /** Sets menu records from storage. */
  setRecords({ highScore, highWave }) {
    this.setText(this.el['menu-high-score'], highScore.toLocaleString());
    this.setText(this.el['menu-high-wave'], String(highWave));
  }

  /** Fills the settings controls with the current values. */
  writeSettingsControls(settings) {
    this.el['set-sensitivity'].value = String(settings.sensitivity);
    this.el['set-fov'].value = String(settings.fov);
    this.el['set-volume'].value = String(Math.round(settings.volume * 100));
    this.el['set-invert'].checked = !!settings.invertY;
    this.el['set-shadows'].checked = !!settings.shadows;
    this.el['set-shake'].checked = !!settings.screenShake;
    this.writeSettingsOutputs(settings);
  }

  writeSettingsOutputs(settings) {
    this.setText(this.el['out-sensitivity'], Number(settings.sensitivity).toFixed(2));
    this.setText(this.el['out-fov'], String(settings.fov));
    this.setText(this.el['out-volume'], `${Math.round(settings.volume * 100)}%`);
  }

  readSettingsControls() {
    return {
      sensitivity: Number(this.el['set-sensitivity'].value),
      fov: Number(this.el['set-fov'].value),
      volume: Number(this.el['set-volume'].value) / 100,
      invertY: this.el['set-invert'].checked,
      shadows: this.el['set-shadows'].checked,
      screenShake: this.el['set-shake'].checked,
    };
  }

  /* ------------------------------------------------------------------ *
   * Keyboard navigation for menus
   * ------------------------------------------------------------------ */
  activeFocusables() {
    const screenEl = this.screen ? this.$(`screen-${this.screen}`) : null;
    if (!screenEl || screenEl.classList.contains('hidden')) return [];
    return Array.from(screenEl.querySelectorAll('button:not([disabled]), input:not([disabled])'))
      .filter((el) => el.getClientRects().length > 0);
  }

  focusFirst(screenId) {
    const list = this.activeFocusables();
    const primary = list.find((el) => el.classList.contains('btn-primary'));
    const target = primary || list[0];
    if (target && screenId !== 'loading') {
      // Defer one frame so the element is visible before focusing.
      requestAnimationFrame(() => target.focus({ preventScroll: true }));
    }
  }

  handleKey(e) {
    if (!this.screen || this.screen === 'loading') return;
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      // Range sliders keep their own arrow-key behaviour.
      if (document.activeElement && document.activeElement.type === 'range') return;
      const list = this.activeFocusables().filter((el) => el.tagName === 'BUTTON' || el.type === 'checkbox');
      if (list.length === 0) return;
      e.preventDefault();
      const idx = list.indexOf(document.activeElement);
      const step = e.code === 'ArrowDown' ? 1 : -1;
      const next = list[(idx + step + list.length) % list.length];
      next.focus();
    }
    if (e.code === 'Escape') {
      if (this.screen === 'settings') {
        e.preventDefault();
        this.closeSettings();
      } else if (this.screen === 'controls' || this.screen === 'credits' || this.screen === 'loadout') {
        e.preventDefault();
        this.showScreen('menu');
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * HUD
   * ------------------------------------------------------------------ */
  setText(el, value) {
    if (el && el.textContent !== value) el.textContent = value;
  }

  /** Writes a value only when it changed since the last frame. */
  diff(key, value, write) {
    if (this.lastHud[key] === value) return;
    this.lastHud[key] = value;
    write(value);
  }

  /**
   * @param {object} s  snapshot:
   *   health, maxHealth, stamina, maxStamina, weapon {name, ammo, reserve, reloading, switching, slot},
   *   kills, score, wave, remaining, phase ('countdown'|'active'|'intermission'|...), phaseText
   */
  updateHud(s) {
    this.diff('wave', s.wave, (v) => this.setText(this.el['hud-wave'], String(v)));
    this.diff('remaining', s.remaining, (v) => this.setText(this.el['hud-remaining'], String(v)));
    this.diff('phase', s.phaseText, (v) => this.setText(this.el['hud-phase'], v));
    this.diff('score', s.score, (v) => this.setText(this.el['hud-score'], v.toLocaleString()));
    this.diff('kills', s.kills, (v) => this.setText(this.el['hud-kills'], String(v)));

    const hp = Math.max(0, Math.ceil(s.health));
    this.diff('health', hp, (v) => {
      this.setText(this.el['hud-health-text'], `${v} / ${s.maxHealth}`);
      const pct = Math.max(0, Math.min(100, (v / s.maxHealth) * 100));
      this.el['hud-health-fill'].style.width = `${pct}%`;
      this.el['hud-health-fill'].classList.toggle('low', pct < 30);
      this.el['low-health'].classList.toggle('active', pct < 30 && pct > 0);
    });

    const stamina = Math.max(0, Math.min(100, Math.ceil((s.stamina / s.maxStamina) * 100)));
    this.diff('stamina', stamina, (v) => {
      this.setText(this.el['hud-stamina-text'], `${v}%`);
      this.el['hud-stamina-fill'].style.width = `${v}%`;
      this.el['hud-stamina-fill'].classList.toggle('low', v < 25);
      this.el['hud-stamina-bar'].setAttribute('aria-valuenow', String(v));
    });

    const w = s.weapon;
    this.diff('weaponName', w.name, (v) => this.setText(this.el['hud-weapon'], v));
    this.diff('hasAmmo', w.hasAmmo, (v) => {
      this.el['hud-ammo']?.parentElement?.classList.toggle('hidden', !v);
    });
    if (w.hasAmmo) {
      this.diff('ammo', w.ammo, (v) => this.setText(this.el['hud-ammo'], String(v)));
      this.diff('reserve', w.reserve, (v) => this.setText(this.el['hud-reserve'], String(v)));
    }
    const status = w.switching
      ? 'DRAWING'
      : w.melee
        ? (w.attacking ? 'SWINGING' : 'NO AMMO REQUIRED')
        : w.reloading
          ? 'RELOADING'
          : w.ammo === 0
            ? 'EMPTY - PRESS R'
            : '';
    const warning = w.hasAmmo && (w.reloading || w.ammo === 0);
    this.diff('status', status, (v) => this.setText(this.el['hud-status'], v));
    this.diff('statusWarning', warning, (v) => this.el['hud-status'].classList.toggle('warn', v));
    this.diff('slot', w.slot, (v) => {
      for (const el of this.slotEls) el.classList.toggle('active', Number(el.dataset.slot) === v);
    });
  }

  /** Ring-style crosshair pulse when a shot leaves the gun. */
  crosshairFire() {
    const ch = this.el.crosshair;
    ch.classList.remove('fire');
    void ch.offsetWidth; // restart the CSS animation
    ch.classList.add('fire');
  }

  /** Brief speed-line flash when the player dashes. */
  dashEffect(direction) {
    const el = this.el['dash-effect'];
    el.dataset.direction = direction.z < 0 ? 'back' : direction.x < 0 ? 'left' : 'right';
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
  }

  /** Hit marker: `kill` shows red, `headshot` adds a flourish. */
  hitMarker({ kill = false, headshot = false } = {}) {
    const hm = this.el.hitmarker;
    hm.classList.remove('show', 'kill', 'headshot');
    void hm.offsetWidth;
    hm.classList.add('show');
    if (kill) hm.classList.add('kill');
    if (headshot) hm.classList.add('headshot');
  }

  /** Full-screen red flash when the player is hit. */
  flashDamage() {
    const el = this.el['flash-damage'];
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
  }

  /**
   * Directional damage indicator.
   * @param {number} degrees  CSS rotation: 0 = attacker straight ahead, negative = left, positive = right
   */
  showDamageDirection(degrees) {
    const el = this.el['damage-indicator'];
    el.style.transform = `rotate(${degrees.toFixed(1)}deg)`;
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
  }

  /** Big centred message (wave start, cleared, death, etc.). */
  showBanner(title, sub = '', tone = 'normal') {
    const b = this.el.banner;
    this.setText(this.el['banner-title'], title);
    this.setText(this.el['banner-sub'], sub);
    b.classList.remove('show', 'danger', 'good');
    if (tone !== 'normal') b.classList.add(tone);
    void b.offsetWidth;
    b.classList.add('show');
  }

  /** Large countdown digits in the centre of the screen. */
  setCountdown(text) {
    const el = this.el.countdown;
    this.setText(el, text);
    el.classList.toggle('visible', !!text);
  }

  /** Small notification in the lower-left stack. */
  toast(text, tone = 'info') {
    const container = this.el.toasts;
    const item = this.root.createElement('div');
    item.className = `toast ${tone}`;
    item.textContent = text;
    container.appendChild(item);
    // Keep the stack short.
    while (container.children.length > 4) container.firstElementChild.remove();
    // Remove only when the fade-out finishes (the fade-in also fires animationend).
    item.addEventListener('animationend', (e) => {
      if (e.animationName === 'toast-out') item.remove();
    });
  }

  clearToasts() {
    this.el.toasts.innerHTML = '';
  }

  /** Resets per-run HUD state (so the next run repaints every value). */
  resetHud() {
    this.lastHud = {};
    this.el['hud-stamina-fill'].style.width = '100%';
    this.el['hud-stamina-fill'].classList.remove('low');
    this.el['hud-stamina-bar'].setAttribute('aria-valuenow', '100');
    this.setText(this.el['hud-stamina-text'], '100%');
    this.el['dash-effect'].classList.remove('active');
    this.el['low-health'].classList.remove('active');
    this.el['flash-damage'].classList.remove('active');
    this.setCountdown('');
    this.clearToasts();
    this.el.banner.classList.remove('show');
  }
}
