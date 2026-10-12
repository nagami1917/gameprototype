# Multiplayer plan — PROJECT: LAST STAND

Status: **design / not started**. This document is the roadmap for turning the
single-player wave survival shooter in `project-last-stand/` into a co-op game.
Nothing here is built yet; the code references are the seams we will use.

---

## 1. Goal and scope

**Target: 1–4 player online co-op survival.** Same map, same waves, same infected;
extra players add firepower and (optionally) more enemies. Everything else —
lobby, ping, scoreboard, revive — exists to serve that.

Explicitly out of scope for v1:

- PvP / deathmatch (needs a different mode layer — see `Game_Modes_Plan.md`,
  phase 5).
- Voice chat (start with text-less ping wheel + kill feed).
- Cross-platform matchmaking / account system.
- Console or mobile clients.

Design pillars:

1. **The server is authoritative.** Clients never decide damage, deaths or pickups.
2. **The simulation must be able to run without a browser.** Today `Level`, `Enemy`
   and `EffectsManager` all build Three.js objects; we need a headless slice that
   Node can tick (see §4).
3. **No build step, no framework.** The project is plain ES modules + `three`.
   Multiplayer keeps that: one extra npm dependency (`ws`) and one new folder.

---

## 2. What exists today (the important seams)

| System | File | Multiplayer relevance |
| --- | --- | --- |
| Game loop / state machine | `js/game.js` | `frame()` clamps `dt` to 50 ms; `update(dt)` drives every system. Needs a fixed-step sim tick. |
| Player movement & camera | `js/player.js` | `player.update(dt, input, colliders, bounds)` is a pure-ish step → good fit for prediction + replay. |
| Collision | `js/collision.js` | Already allocation-free and dependency-free. Shared verbatim by client and server. |
| Level plan (pure data) | `js/level.js` → `planLayout()` | Colliders, doors, spawns, nav grid. **Runs in Node already** (the test suite does it). |
| Level meshes | `js/level.js` → `Level` | Browser-only. Split from the plan (§4). |
| Weapons / hitscan | `js/weapon.js` | `traceRay()` uses collision boxes + Three.js raycaster for hitboxes. Damage must move server-side. |
| Enemies | `js/enemy.js`, `js/enemyAI.js` | Visuals (`Enemy`) vs. brain (`EnemyAI` + `NavGrid`). The brain must run headless. |
| Waves | `js/waveManager.js` | `getWaveConfig()` / `buildWaveQueue()` are pure → trivially server-owned. |
| Effects | `js/effects.js` | Purely cosmetic. Client-only, driven by server events. |
| UI / HUD | `js/ui.js`, `index.html` | Needs lobby, scoreboard, teammate markers, netgraph. |
| Dev server | `server.mjs` | Zero-dependency static server; grows a WebSocket endpoint. |

---

## 3. Architecture decision

**Chosen: authoritative Node server + WebSockets, client-side prediction, server
snapshot interpolation.**

| Option | Verdict |
| --- | --- |
| **A. Authoritative Node server, WebSocket transport** | ✅ **Chosen.** One binary serves the game *and* the room. Matches the existing zero-build setup, easy to run locally (`npm start`), easy to host, trivial to unit-test the sim in Node. |
| B. Host-authoritative P2P (WebRTC) | ❌ No signalling/TURN infrastructure, host migration pain, and a browser host has to run the full enemy AI anyway. |
| C. Deterministic lockstep | ❌ Floating-point determinism across browsers/JITs is a research project; one desync kills the session. |
| D. Client-trust "position relay" | ❌ Trivial to cheat, and enemy behaviour would disagree between clients. |

Transport notes:

- v1 uses **WebSocket** (`ws`, the only new dependency) at **20 Hz server tick**,
  binary frames, unreliable-ordered semantics are emulated by simply sending the
  newest snapshot (a dropped snapshot is harmless — the next one supersedes it).
- Later: `WebTransport` (QUIC datagrams) for unreliable delivery, and WebRTC
  data channels for P2P voice — both are drop-in transport swaps behind the
  `NetClient` interface (§5).

Room model: **one Node process = lobby + N rooms**, up to 4 players per room,
no persistence. Room codes are 6-character strings held in memory.

---

## 4. Milestone 0 — make the simulation headless (prerequisite)

This is the real work. Everything else is plumbing on top of it.

1. **Split `Level` into `LevelPlan` (pure) + `LevelView` (Three.js).**
   - `planLayout()` already returns colliders, doors, spawns, pickups and builds
     the nav grid; move it (and `parseLayout`, `buildNavGrid`, `makeRng`) into
     `js/sim/levelPlan.js` — no `import * as THREE`.
   - `Level` keeps the meshes and consumes a plan. `Game` and the server both
     create the plan; only the client creates the view.
2. **Split `Enemy` into `EnemySim` (position, state, health, AI) and
   `EnemyView` (meshes).** `EnemyAI` + `NavGrid` move to `js/sim/` and become
   Three-free (`EnemyAI` currently stores vectors; keep it to plain `{x,y,z}`).
3. **Introduce `js/sim/world.js`** — a `SimWorld` that owns the plan, players,
   enemies, doors, pickups and wave manager, and exposes
   `step(dt, inputsByPlayer)`. It never touches the DOM, Three.js, `window` or
   `performance`.
4. **Fixed timestep.** `SimWorld.step()` always advances `1/60 s`. `Game.frame()`
   accumulates `dt` and calls `step()` 0–3 times per rendered frame (max 3 to
   avoid death spirals), then renders interpolated state. In single-player this
   also fixes the current variable-`dt` jitter in movement and AI.
5. **Event bus out of the sim.** The sim emits an ordered event list per tick
   (`shot`, `hit`, `kill`, `pickup`, `door`, `wavePhase`, ...) that the client
   turns into effects/audio/HUD and the server forwards as unreliable deltas.
   This replaces the direct `this.effects.*` / `this.audio.*` calls from
   `game.js`, `weapon.js` and `enemy.js`.

**Exit criteria:** `npm test` can boot a `SimWorld`, run 60 simulated seconds of
a wave with scripted inputs, and assert deterministic results (same seed → same
final state hash). That test is the backbone of every later milestone.

---

## 5. Networking layer

```
js/net/
  protocol.md     message table (the contract)
  codec.js        binary pack/unpack (DataView), quantised, no allocation churn
  netClient.js    browser: connect, send input, apply snapshots, clock sync
  room.js         server: players, slots, authority, tick loop
  server.mjs      room/lobby HTTP+WS endpoints (extends the existing server)
```

### Tick rates

| Layer | Rate | Notes |
| --- | --- | --- |
| Client render | display (60–144 Hz) | unchanged |
| Client input sampling | 60 Hz | one `InputCmd` per sim step |
| Client → server input | 30 Hz | each packet carries the last 3 commands (redundancy against loss) |
| Server sim | 60 Hz | matches the fixed step from §4 |
| Server → client snapshot | 20 Hz | 50 ms apart; clients interpolate 100 ms behind |

### Message contract (v1)

| # | Name | Dir | Reliability | Payload |
| --- | --- | --- | --- | --- |
| 1 | `hello` | C→S | reliable | name, client version, preferred slot |
| 2 | `welcome` | S→C | reliable | yourPlayerId, roomCode, mapId, tickRate, full snapshot |
| 3 | `join` / `leave` | S→C | reliable | playerId, name, slot |
| 4 | `input` | C→S | unreliable | ackTick, 3× `{ tick, moveX, moveZ, yaw, pitch, buttons, weapon }` |
| 5 | `snapshot` | S→C | unreliable | serverTick, ackTick, entity array (delta-compressed vs last ack) |
| 6 | `event` | S→C | unreliable | ordered sim events since last snapshot |
| 7 | `rpc` | C→S | reliable | `fire`, `reload`, `switch`, `interact`, `revive`, `ping` |
| 8 | `chat` / `ping` | both | reliable | text or ping id + world position |
| 9 | `stateChange` | S→C | reliable | `countdown`, `waveStart`, `waveClear`, `gameOver`, `scoreboard` |

Quantisation: positions `int16` at 1/64 m within map bounds, yaw/pitch `int16`
at 1/182 rad, health/ammo `uint8`. A full 4-player + 30-enemy snapshot is well
under 1 KB; at 20 Hz that is < 20 KB/s per client.

### Clock and interpolation

- Client keeps `serverTime ≈ localTime - rtt/2 + offset`, smoothed with a
  simple PLL (no NTP needed).
- Snapshots are buffered ~100 ms and rendered with **entity interpolation**
  (enemies, remote players, doors). The local player is **predicted**, never
  interpolated.

---

## 6. Client prediction and reconciliation

| Action | Client does | Server does | On mismatch |
| --- | --- | --- | --- |
| Move / jump / dash | simulate immediately with `moveCylinder` on the local collider copy | re-simulate from the acked input; authoritative position in snapshot | rewind to the server state, replay unacked inputs (max 150 ms), smooth the residual error over ~200 ms |
| Look | yaw/pitch applied locally, sent in every input | authoritative only for shot direction | n/a |
| Fire (hitscan) | plays FX instantly, spawns a **cosmetic** tracer/decal | resolves `traceRay()` server-side against authoritative enemy positions and applies damage | cosmetic only — no correction needed |
| Damage / death | never simulated locally; waits for server events | authoritative | n/a |
| Doors | predicted open (same `openAmount` rules) | authoritative `openAmount` in snapshot | snap over 100 ms |
| Pickups | optimistic "taken" fade | authoritative; rejections are rare and shown as a re-materialising pickup | revert |

Anti-cheat (pragmatic, not bulletproof): server clamps speed/position deltas per
tick, validates fire rate against `WEAPON_DEFS.fireRate`, rejects shots fired
while dead/reloading, and ignores inputs more than 250 ms in the future.

---

## 7. Feature milestones

| Phase | Deliverable | Depends on | Acceptance |
| --- | --- | --- | --- |
| **0** | Headless sim (`js/sim/`), fixed timestep, sim event bus | — | 60 s simulated wave is deterministic; single-player feels identical; `npm test` green |
| **1** | `ws` server + room join; two browsers see each other's capsule moving | 0 | Two clients, one room, remote movement interpolated, ping shown |
| **2** | Shooting sync: server-authoritative damage, hit markers, kill feed, headshots | 1 | Client-side FX only; server damage; no double-kills; 150 ms added latency is playable |
| **3** | Enemies + waves on the server; difficulty scales with player count | 2 | Same wave on 1 and 4 players; enemy positions match within interpolation error |
| **4** | Doors, pickups, score, shared wave flow, death → spectate → respawn at next wave | 3 | 4 players can finish 5 waves; scores agree on all clients |
| **5** | Lobby UX: create/join by code, ready-up, name entry, scoreboard, ping wheel, disconnect handling + host migration-free reconnect | 4 | Drop a client mid-wave: others keep playing; it can rejoin into the running wave |
| **6** | Polish: lag compensation for hitscan (server rewinds enemy hitboxes by the shooter's RTT), netgraph, bandwidth tuning | 5 | 120 ms RTT: point-blank shotgun kills register first try |

Difficulty scaling with players (start here, tune later):
`enemyCount × (1 + 0.6 × (players - 1))`, `enemyHealth × (1 + 0.25 × (players - 1))`,
`maxAlive × (1 + 0.5 × (players - 1))`, pickups respawn faster.

---

## 8. Testing strategy

- **Pure sim tests** (in `tests/run-tests.mjs`, no browser): determinism hash,
  input replay, server-authoritative damage resolution, wave scaling maths,
  codec round-trips (`encode(decode(x)) === x` for every message).
- **Network harness** (`tests/net-sim.mjs`, run manually): two headless
  `SimWorld`s connected through a fake channel with configurable latency, jitter
  and packet loss. Assert convergence after N ticks with 10 % loss.
- **Manual browser matrix**: two tabs + `?debug` (exposes `window.lastStand`) to
  compare `renderer.info` and snapshot sizes; Chrome throttling set to "Slow 3G"
  as a worst case.
- **Regression guard**: single-player must stay bit-identical in feel — the
  phase-0 fixed-step change is the riskiest refactor, so keep the old
  `update(dt)` path behind a flag until phase 4 is done.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Phase-0 refactor breaks single-player feel | Keep a `SINGLEPLAYER_LEGACY_LOOP` flag until phase 4; A/B the movement feel before deleting it |
| Headless sim drifts from the client (two copies of the rules) | One `js/sim/` module imported by both; the client view layer is strictly dumb |
| 30 enemies × 4 players of snapshot traffic | Delta compression against the last acked snapshot + interest management (skip enemies > 40 m or behind a wall via `hasLineOfSight`) |
| Cheating in a co-op PvE game | Low stakes; do the cheap checks in §6 and move on |
| Hosting cost / ops | Rooms are in-memory and short-lived; a single small VPS handles dozens of rooms; document `docker`-less deploy with `systemd` |

---

## 10. Open questions

1. Revive/downed state (co-op staple) or instant death + respawn next wave?
   *Recommendation: downed-and-crawl with a 20 s bleed-out, revived by a teammate
   holding E for 3 s — it is the single biggest co-op feel win.*
2. Friendly fire off (recommended) or on with reduced damage?
3. Server in the same repo (`server.mjs` grows) or a separate `packages/server`?
   *Recommendation: same repo, keep the static-file server and the room server in
   one process for `npm start` simplicity.*
4. Do enemies target the nearest player or keep the current "nearest actor"?
   *Recommendation: nearest, with a 1.5 s aggro-commit so players can kite.*
