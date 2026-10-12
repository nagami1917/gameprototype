# Game modes plan — PROJECT: LAST STAND

Status: **design / not started**. Today the game has exactly one mode: endless
wave survival (`js/waveManager.js`: countdown → active → intermission → …). This
document defines a mode layer and the modes to build on it.

---

## 1. Current state

```
Game (js/game.js)
 ├── state machine: loading → menu → playing ⇄ paused → gameover
 ├── WaveManager   : phases, spawn queue, per-wave scaling (pure: getWaveConfig)
 ├── Level         : spawn points, pickups, doors
 ├── Player / WeaponSystem / Enemy+EnemyAI / Effects / UI / Audio
 └── scoring       : kills, headshots, wave clear bonus → storage records
```

The wave flow is hard-coded in `game.js` (`updatePlaying`, `onWaveEvent`) and the
HUD has one fixed layout (`index.html`). To add modes we need three seams:

1. **A mode object** the game delegates to (phases, win/lose, scoring, HUD
   extras).
2. **A modifiers block** applied to player/enemies/waves.
3. **World volumes** (zones) for anything positional: defend, capture, extract.

---

## 2. The mode interface

New file `js/modes.js` (pure data + pure helpers, unit-testable), plus a small
`GameMode` runtime object the game drives. No DOM, no Three.js in `modes.js`.

```js
/**
 * A mode is a plain object. Everything is optional except id/name.
 * ctx gives access to: { world, wave, level, player, enemies, ui, audio, effects, stats, time }
 */
const MODE = {
  id: 'survival',
  name: 'SURVIVAL',
  blurb: 'Hold Sector 7. Waves get harder forever.',
  modifiers: {                 // applied once when a run starts
    playerHealth: 100, enemyHealth: 1, enemySpeed: 1, enemyDamage: 1,
    pickupRate: 1, ammoFromPickups: 1, startWeapon: 'rifle', flashlightDrain: 0,
  },
  waveConfig(wave) { return getWaveConfig(wave); },   // may override entirely
  onStart(ctx) {},
  update(dt, ctx) {},          // objectives, timers, zone progress
  onEvent(name, payload, ctx) {},   // 'kill', 'waveClear', 'playerDamaged', …
  isOver(ctx) { return ctx.player.health <= 0; },
  outcome(ctx) { return { won: false, score: ctx.stats.score }; },
  hud(ctx) { return {}; },     // merged into buildHudSnapshot()
  recordKey: 'highScore',      // which storage record this mode writes
};
```

`game.js` changes: `this.mode` replaces the hard-coded wave handling in
`updatePlaying()`; `startRun(modeId)` picks the mode; `buildHudSnapshot()`
merges `mode.hud(ctx)`; storage keeps **one record set per mode id**.

---

## 3. The modes

### Tier 1 — cheap, high value

| # | Mode | Rules | New systems | Feel |
| --- | --- | --- | --- | --- |
| 1 | **SURVIVAL** (current) | Endless waves, 15 s supply breaks | — | baseline |
| 2 | **HARDCORE** | Survival + 60 HP, no health pickups, enemies +15 % speed/damage, one life, no hit-direction indicator, no crosshair on hipfire | modifiers only | "one mistake" run, separate leaderboard |
| 3 | **ENDLESS RUSH** | No intermission: spawning never stops, `spawnInterval` shrinks with time, pickups respawn on a timer, score = survival time × kills | `waveConfig` override + continuous spawner | Pure pressure, no breather |
| 4 | **TIME ATTACK — 5:00** | Five minutes, fixed wave schedule, kill-chain multiplier (×1→×5, resets after 3 s without a kill), ammo drops from kills | combo timer + score rules | Speedrun-y, replays well |

### Tier 2 — objectives (needs zones)

| # | Mode | Rules | New systems |
| --- | --- | --- | --- |
| 5 | **DEFEND: COOLANT PUMP** | A zone around a console prop must stay clear; a progress bar drains while infected stand in it and refills while you do. Survive 5 waves with integrity > 0 | `js/zones.js` (AABB volumes, occupancy, progress), world beacon + HUD bar, "objective under attack" callout |
| 6 | **EXTRACTION** | Survive 4 waves, then a 90 s escape: an extraction marker opens on the far side of the map (a `D` door unlocks), the map keeps spawning while you run | zone + door unlock + end condition other than death |
| 7 | **HOLD-OUT / HARDPORT** | Three zones activate one at a time every 60 s; standing in the active zone earns score ×3 but draws every enemy to you | zone rotation + AI retarget hint |

### Tier 3 — content-heavy

| # | Mode | Rules | Depends on |
| --- | --- | --- | --- |
| 8 | **JUGGERNAUT HUNT** | Every third wave spawns a mini-boss (new enemy type: 3× health, armoured plate that must be broken, drops a health pack) | new enemy type + boss HP bar |
| 9 | **DEMOLITION** | Between waves, plant charges on marked consoles and survive the timer; needs explosives | `Weapons_Roadmap.md` §3.1 (projectiles) |
| 10 | **CO-OP CAMPAIGN** | The tier-1/2 modes, 2–4 players, with revive and shared score | `Multiplayer_Plan.md` phase 4 |
| 11 | **DAILY RUN** | Seeded map+mode+modifier combo, one attempt per day, shared leaderboard string | seeds (`?seed=`), storage per-day key |

---

## 4. Shared systems to build

### 4.1 `js/zones.js`

```
ZoneVolume { id, box:{minX,minZ,maxX,maxZ}, progress, rate, captureMask }
  contains(pos)                       // XZ test, ignores Y (matches the 2.5D world)
  update(dt, actors)                 // who is inside -> progress moves at `rate`
  projection(camera)                 // for the HUD marker
```

- Rendered as a thin floor decal (reuse `DecalPool` with a new texture) + a
  vertical "beam" the way beacons are done today in `js/level.js`.
- HUD: a progress ring/bar in the banner area plus an off-screen arrow
  (`camera.project()`), both added to `js/ui.js`.

### 4.2 Modifiers

A single `applyModifiers(mods)` call at run start that scales:
`player.maxHealth`, `ENEMY_TYPES[*].health/speed/damage` (through the existing
`multipliers` argument of `Enemy.spawn`), `PickupSystem` respawn rate, and
`WaveManager` config. Because `getWaveConfig()` is pure, modifiers compose
cleanly and stay testable.

### 4.3 Mode select + records

- `index.html`: a `MODE` row on the main menu (and a `screen-modes` panel with
  the blurb + best score for each). Reuse the existing menu navigation
  (arrow keys + Enter already work in `js/ui.js`).
- `storage.js`: records become `{ survival: {...}, hardcore: {...}, ... }`;
  migrate the existing flat record on load so nobody loses their high score.
- HUD extras: objective bar, mode timer, combo multiplier — all optional fields
  merged in `buildHudSnapshot()`.

### 4.4 Events the modes need

Extend the existing event flow with: `zoneEntered`, `zoneLost`,
`objectiveProgress`, `comboChanged`, `timerExpired`, `extracted`. These ride the
same bus that `Multiplayer_Plan.md` §4 introduces, so modes work in co-op
without a second implementation.

---

## 5. Testing

Everything in `js/modes.js` is pure:

- `getModeConfig(modeId, wave)` returns a valid wave config for every mode.
- Zone maths: progress clamps at 0/100, two actors capture twice as fast,
  `contains()` matches the collision convention (XZ only).
- Scoring: kill chains multiply correctly and reset after the timeout; time
  attack ends exactly at 300 s.
- Storage migration: an old flat record loads into the new per-mode shape with
  the same high score.

Plus one integration test per tier-1 mode: boot a `SimWorld` (from the
multiplayer refactor) or a headless `WaveManager`, run 3 simulated minutes with
scripted input, and assert the mode reaches a terminal state (death, timer, or
objective failure).

---

## 6. Milestones

| # | Milestone | Deliverable | Acceptance |
| --- | --- | --- | --- |
| 0 | Mode layer | `js/modes.js`, `Game.mode`, mode select UI, per-mode records | Survival plays exactly as before with `mode = survival`; records migrated |
| 1 | Modifiers + HARDCORE | `applyModifiers`, Hardcore + Endless Rush | Both playable end-to-end; separate leaderboards; tests green |
| 2 | Zones | `js/zones.js`, beacon + HUD bar + off-screen arrow | A zone can be held/lost; visuals are one extra draw call |
| 3 | DEFEND + EXTRACTION | Two objective modes with real win conditions | Both winnable and losable; extraction unlocks a door and ends the run |
| 4 | Combo scoring + TIME ATTACK | Kill-chain multiplier, 5-minute mode, end-of-run summary | Multiplier behaves; summary lists mode-specific stats |
| 5 | HARDPORT | Rotating zones + AI retargeting | Enemies converge on the active zone |
| 6 | JUGGERNAUT / DEMOLITION | Boss enemy or charge-planting | Depends on the enemy-type or projectile work respectively |

Suggested order if everything is on the table at once:
**decals/flashlight fix → weapons phase 0–1 → modes phase 0–1 → multiplayer
phase 0 → modes phase 2–3 → weapons phase 3 (projectiles) → modes phase 6.**
Modes 0–1 need no new art and no networking, which makes them the best value
per hour; zone-based modes need the zones that co-op also wants.

---

## 7. Open questions

1. Per-mode leaderboards, or one board with a mode filter? (Recommendation:
   per-mode records in storage, filter in the UI.)
2. Should Hardcore hide the HUD? (Recommendation: hide ammo and the hit
   indicator, keep health — a black screen is not fun.)
3. Do objective modes replay on both maps? (Recommendation: yes, with per-map
   zone placement in the map manifest — see `New_Map_Plan.md` §4.)
4. Unlock gating — should modes unlock by best wave, or all be open from the
   start? (Recommendation: Survival + Time Attack open; the rest unlock at wave
   5 / wave 10 so new players are not overwhelmed.)
