/**
 * waveManager.js
 * ------------------------------------------------------------------
 * Wave-based survival flow:
 *
 *   countdown (5 s) -> active (spawn queue, kill everything) ->
 *   intermission (15 s supply break) -> countdown -> ...
 *
 * Enemy composition, counts and stat scaling come from getWaveConfig(),
 * which is a pure function so it can be unit-tested. The manager does not
 * touch the scene: it asks the game to spawn through `spawnEnemy(typeId)`
 * and receives events through `onEvent(name, payload)`.
 */

export const COUNTDOWN_SECONDS = 5;
export const INTERMISSION_SECONDS = 15;
/** After this many seconds of a wave, every remaining enemy starts hunting. */
export const HUNT_ALL_AFTER = 14;

/** Difficulty for a given wave number (1-based). Pure and deterministic. */
export function getWaveConfig(wave) {
  const w = Math.max(1, wave);
  const runnerWeight = w >= 2 ? Math.min(0.6, 0.25 + (w - 2) * 0.08) : 0;
  const armoredWeight = w >= 3 ? Math.min(0.5, 0.12 + (w - 3) * 0.07) : 0;
  return {
    wave: w,
    total: Math.min(60, Math.round(5 + (w - 1) * 2.5)),
    maxAlive: Math.min(12, 4 + w),
    spawnInterval: Math.max(0.9, 2.2 - 0.08 * (w - 1)),
    weights: { infected: 1, runner: runnerWeight, armored: armoredWeight },
    // Every fifth wave includes a reinforced group of armored enemies.
    eliteBonus: w % 5 === 0 ? 2 : 0,
    multipliers: {
      health: Math.min(2.2, 1 + 0.1 * (w - 1)),
      damage: Math.min(1.6, 1 + 0.05 * (w - 1)),
      speed: Math.min(1.35, 1 + 0.03 * (w - 1)),
    },
    clearBonus: 500 + w * 100,
  };
}

/**
 * Builds the spawn queue for a wave from the weights.
 * @param {ReturnType<typeof getWaveConfig>} config
 * @param {() => number} rng
 * @returns {string[]} enemy type ids in spawn order
 */
export function buildWaveQueue(config, rng = Math.random) {
  const { weights, total, eliteBonus } = config;
  const types = Object.keys(weights);
  const sum = types.reduce((s, t) => s + weights[t], 0);
  const queue = [];
  for (let i = 0; i < total; i++) {
    let r = rng() * sum;
    let chosen = types[0];
    for (const t of types) {
      if (r < weights[t]) { chosen = t; break; }
      r -= weights[t];
    }
    queue.push(chosen);
  }
  for (let i = 0; i < eliteBonus; i++) queue.push('armored');
  return queue;
}

export class WaveManager {
  /**
   * @param {object} opts
   * @param {(typeId: string, config: object) => boolean} opts.spawnEnemy  returns false if no spawn spot was free
   * @param {(name: string, payload?: object) => void} [opts.onEvent]
   * @param {() => number} [opts.rng]
   */
  constructor({ spawnEnemy, onEvent = () => {}, rng = Math.random }) {
    this.spawnEnemy = spawnEnemy;
    this.onEvent = onEvent;
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.wave = 0;
    this.phase = 'idle'; // idle | countdown | active | intermission | stopped
    this.timer = 0;
    this.spawnTimer = 0;
    this.waveTime = 0;
    this.queue = [];
    this.config = getWaveConfig(1);
    this.huntAll = false;
    this.lastCountdownSecond = -1;
    this.totalSpawned = 0;
  }

  /** Starts the first countdown (wave 1). */
  start() {
    this.reset();
    this.beginCountdown();
  }

  stop() {
    this.phase = 'stopped';
  }

  beginCountdown() {
    this.wave += 1;
    this.config = getWaveConfig(this.wave);
    this.phase = 'countdown';
    this.timer = COUNTDOWN_SECONDS;
    this.lastCountdownSecond = -1;
    this.onEvent('countdown', { wave: this.wave, seconds: COUNTDOWN_SECONDS });
  }

  startWave() {
    this.phase = 'active';
    this.queue = buildWaveQueue(this.config, this.rng);
    this.spawnTimer = 0.5;
    this.waveTime = 0;
    this.huntAll = false;
    this.totalSpawned = 0;
    this.waveTotal = this.queue.length;
    this.onEvent('waveStart', { wave: this.wave, total: this.queue.length });
  }

  /**
   * Advances the wave state machine.
   * @param {number} dt
   * @param {number} aliveCount  enemies currently alive (not dying)
   */
  update(dt, aliveCount) {
    switch (this.phase) {
      case 'countdown': {
        this.timer -= dt;
        const sec = Math.max(0, Math.ceil(this.timer));
        if (sec !== this.lastCountdownSecond && this.timer > 0) {
          this.lastCountdownSecond = sec;
          this.onEvent('countdown', { wave: this.wave, seconds: sec });
        }
        if (this.timer <= 0) this.startWave();
        break;
      }
      case 'active': {
        this.waveTime += dt;
        if (!this.huntAll && this.waveTime >= HUNT_ALL_AFTER) {
          this.huntAll = true;
          this.onEvent('huntAll', { wave: this.wave });
        }
        this.spawnTimer -= dt;
        if (this.queue.length > 0 && aliveCount < this.config.maxAlive && this.spawnTimer <= 0) {
          const typeId = this.queue[0];
          if (this.spawnEnemy(typeId, this.config)) {
            this.queue.shift();
            this.totalSpawned++;
            this.spawnTimer = this.config.spawnInterval;
          } else {
            this.spawnTimer = 0.25; // no free spawn point right now; retry soon
          }
        }
        if (this.queue.length === 0 && aliveCount === 0) {
          this.phase = 'intermission';
          this.timer = INTERMISSION_SECONDS;
          this.lastCountdownSecond = -1;
          this.onEvent('waveCleared', { wave: this.wave, bonus: this.config.clearBonus });
        }
        break;
      }
      case 'intermission': {
        this.timer -= dt;
        const sec = Math.max(0, Math.ceil(this.timer));
        if (sec !== this.lastCountdownSecond && this.timer > 0) {
          this.lastCountdownSecond = sec;
          this.onEvent('intermission', { wave: this.wave, seconds: sec });
        }
        if (this.timer <= 0) this.beginCountdown();
        break;
      }
      default:
        break;
    }
  }

  /** Enemies not yet spawned plus enemies still alive. */
  remaining(aliveCount) {
    return this.queue.length + aliveCount;
  }
}
