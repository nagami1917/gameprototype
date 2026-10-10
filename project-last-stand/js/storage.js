/**
 * storage.js
 * ------------------------------------------------------------------
 * LocalStorage persistence for high scores and player settings.
 * Every access is wrapped in try/catch: privacy modes or disabled storage
 * must never break the game; we simply fall back to defaults.
 */

export const STORAGE_KEY = 'project-last-stand:v1';

export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 1.0,   // multiplier, 0.2 - 3.0
  fov: 75,            // degrees, 60 - 100
  volume: 0.8,        // 0 - 1
  invertY: false,
  shadows: true,
  screenShake: true,
});

export const DEFAULT_DATA = Object.freeze({
  highScore: 0,
  highWave: 0,
  bestKills: 0,
  runs: 0,
});

/** Clamps settings to their allowed ranges and fills in defaults. */
export function sanitizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  s.sensitivity = num(input.sensitivity, 0.2, 3, DEFAULT_SETTINGS.sensitivity);
  s.fov = Math.round(num(input.fov, 60, 100, DEFAULT_SETTINGS.fov));
  s.volume = num(input.volume, 0, 1, DEFAULT_SETTINGS.volume);
  s.invertY = typeof input.invertY === 'boolean' ? input.invertY : DEFAULT_SETTINGS.invertY;
  s.shadows = typeof input.shadows === 'boolean' ? input.shadows : DEFAULT_SETTINGS.shadows;
  s.screenShake = typeof input.screenShake === 'boolean' ? input.screenShake : DEFAULT_SETTINGS.screenShake;
  return s;
}

/** Reads the saved record. Always returns a complete object. */
export function loadStorage() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[storage] localStorage unavailable, using defaults.', err);
  }
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) || {};
    } catch (err) {
      console.warn('[storage] Corrupt save data ignored.', err);
    }
  }
  return {
    highScore: Math.max(0, Number(parsed.highScore) || 0),
    highWave: Math.max(0, Number(parsed.highWave) || 0),
    bestKills: Math.max(0, Number(parsed.bestKills) || 0),
    runs: Math.max(0, Number(parsed.runs) || 0),
    settings: sanitizeSettings(parsed.settings),
  };
}

/** Writes the full record. Returns false if the write failed. */
export function saveStorage(data) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.warn('[storage] Could not save data.', err);
    return false;
  }
}

/**
 * Updates the best records after a run.
 * @returns {{record: object, newHighScore: boolean, newHighWave: boolean}}
 */
export function recordRun(current, { score, wave, kills }) {
  const next = { ...current };
  const newHighScore = score > (current.highScore || 0);
  const newHighWave = wave > (current.highWave || 0);
  if (newHighScore) next.highScore = score;
  if (newHighWave) next.highWave = wave;
  next.bestKills = Math.max(current.bestKills || 0, kills);
  next.runs = (current.runs || 0) + 1;
  saveStorage(next);
  return { record: next, newHighScore, newHighWave };
}
