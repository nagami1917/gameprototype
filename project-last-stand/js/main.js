/**
 * main.js
 * ------------------------------------------------------------------
 * Entry point. Checks browser support, creates the UI, audio and game,
 * wires the menu buttons to game actions, and reports fatal errors in
 * the page instead of leaving a blank screen.
 */
import { UI } from './ui.js';
import { AudioManager } from './audio.js';
import { Game } from './game.js';
import { loadStorage } from './storage.js';

function showFatal(message) {
  const box = document.getElementById('fatal-error');
  const text = document.getElementById('fatal-text');
  if (text) text.textContent = message;
  if (box) box.classList.remove('hidden');
  document.getElementById('screen-menu')?.classList.add('hidden');
  document.getElementById('hud')?.classList.add('hidden');
}

function hasWebGL() {
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    return false;
  }
}

function boot() {
  if (!window.WebGLRenderingContext || !hasWebGL()) {
    showFatal('This game needs WebGL. Enable hardware acceleration in your browser or try another browser.');
    return;
  }

  const canvas = document.getElementById('game-canvas');
  const ui = new UI(document);
  const storage = loadStorage();
  const audio = new AudioManager({ volume: storage.settings.volume });
  const game = new Game({ canvas, ui, audio, storage });

  try {
    game.init();
  } catch (err) {
    console.error('[main] initialisation failed', err);
    showFatal(`Initialisation failed: ${err?.message || err}. Check the browser console for details.`);
    return;
  }

  ui.bind({
    onPlay: () => game.startRun(),
    onResume: () => game.resume(),
    onRestart: () => game.startRun(),
    onRetry: () => game.startRun(),
    onMainMenu: () => game.toMainMenu(),
    onSettingsChange: (s) => game.updateSettings(s),
    onSettingsReset: () => game.resetSettings(),
    onLoadoutChange: (ids) => game.setLoadout(ids),
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[main] unhandled rejection', e.reason);
  });
  window.addEventListener('pagehide', () => game.dispose());

  const params = new URLSearchParams(window.location.search);

  // Debug hook for development: add ?debug to the URL.
  if (params.has('debug')) {
    window.lastStand = game;
  }

  // Debug loadout: ?weapons=smg,dmr fills slot 1/2 and keeps the melee kit.
  // Not persisted, so the saved loadout survives a debug run.
  const weapons = params.get('weapons');
  if (weapons) {
    const ids = weapons.split(',').map((id) => id.trim()).filter(Boolean);
    const applied = game.setLoadout(ids, false);
    console.info(`[main] debug loadout: ${applied.join(', ')}`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
