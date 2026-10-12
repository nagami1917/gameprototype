# New map plan — SUBLEVEL 4: COOLANT INTAKE

Status: **design / not started**. Goal: a second playable map that plays
*differently* from Sector 7, without touching the engine's core.

---

## 1. Why a second map

Sector 7 (`js/level.js` → `LAYOUT`) is a **3×3 grid of rooms joined by two
horizontal corridors**. That produces one kind of fight: short sightlines,
doorway chokepoints, shotgun-friendly. A second map should force the other
half of the arsenal to matter.

Design targets for map 2:

| Axis | Sector 7 (now) | Sublevel 4 (target) |
| --- | --- | --- |
| Layout | 9 small rooms, 2 corridors | One big central hall + a full ring corridor |
| Sightlines | 8–14 m | 25–45 m across the hall |
| Chokepoints | 6 doors, all interior | 10 doors on the ring→hall boundary; the hall itself is open |
| Flow | Clear the room, move on | Kite in circles, get flanked from the ring |
| Best weapon | Shotgun, axe | Rifle, (future) DMR |
| Pacing | Stop-start | Sustained pressure with escape routes |

---

## 2. How maps work today (and what is already reusable)

```
ASCII rows  ->  parseLayout()  ->  planLayout()  ->  { colliders, doors, spawns,
   (LAYOUT)      (validation)       (pure data)       nav grid, lights, signs }
                                                            |
                                                            v
                                              Level(scene, { rows }) -> meshes
```

- `Level` already accepts `rows` (`constructor(scene, { renderer, rows = LAYOUT })`),
  so a second map is *almost* a one-line change today.
- `planLayout()` is pure and already exercised by `npm test`, including A*
  connectivity and spawn validity — every new layout gets those checks for free.
- `MAX_POINT_LIGHTS = 8` caps how many fixtures actually emit light; extra `l`/`E`
  cells still render as panels, they just do not light.
- Textures, fog, ceiling height and prop palettes are **hard-coded** in `Level`
  and `game.js` — that is the main thing to make data-driven.

---

## 3. The map

**SUBLEVEL 4: COOLANT INTAKE** — a flooded pump hall under Sector 7. The player
starts in the outer ring, breaks into the hall through blast doors, and has to
keep moving because the infected can enter from four directions at once.

Legend is unchanged (`#` wall, `.` floor, `D` blast door, `C` crate, `L` bench,
`T` coolant tank, `M` console, `S` spawn, `P` player start, `H` health, `A` ammo,
`l` ceiling light, `E` emergency beacon).

```
##############################
#S.........P.................#
#.....l.........A......l.....#
#..####D######D#######D####..#
#..#..TT..........TT......#..#
#..#......................#..#
#..#S...M...........M....S#..#
#..D......................D..#
#..#S..........l.........S#..#
#.A#......................#A.#
#..#....CC........CC......#..#
#S.#..........E...........#.S#
#..D......................D..#
#..#S..........l.........S#..#
#..#......................#..#
#..#S...M...........M....S#..#
#..#S.TT..........TT.....S#..#
#..#......................#..#
#..####D######D#######D####..#
#...S..............S.........#
#..H.......A.......H......S..#
##############################
```

**Validated already** (run through `parseLayout` → `planLayout` → `NavGrid` with
the repo's own code):

- 30 × 22 cells (60 × 44 m) — same footprint as Sector 7.
- 494 open cells, **494 reachable** from the player start: no sealed pockets.
- 16 spawn points, all on walkable nav cells, none within 8 m of the start.
- 10 blast doors, 2 health spots, 4 ammo spots, 4 ceiling lights, 1 beacon.
- Fixture count (5) stays inside the `MAX_POINT_LIGHTS + 2` budget the tests assert.

---

## 4. Work breakdown

### Phase 1 — map data (small, safe)

1. New file `js/maps/coolantIntake.js` exporting `COOLANT_INTAKE_LAYOUT` (the
   grid above) and a **`MAP_MANIFEST`**:
   ```js
   export const MAP_MANIFEST = {
     id: 'coolant-intake',
     name: 'SUBLEVEL 4: COOLANT INTAKE',
     rows: COOLANT_INTAKE_LAYOUT,
     theme: 'industrial',          // selects textures/palette in Level
     fog: { color: 0x061014, density: 0.026 },
     wallHeight: 4.5,              // taller hall, more vertical space
     startYaw: -Math.PI * 0.5,
     waveOverrides: { maxAliveBonus: 3, spawnIntervalScale: 0.9 },
     music: 'hum',                 // ambient bed (see audio.js)
   };
   ```
2. `js/maps/index.js` exports `MAPS` (array) + `getMap(id)`. `Level` keeps its
   `rows` argument and gains `theme` / `fog` / `wallHeight`.
3. Layout tests move into a loop over `MAPS` so both maps are checked for
   rectangularity, enclosure, connectivity, spawn reachability and light budget.
   **This is the acceptance gate for any future map.**

### Phase 2 — theming (the part that makes it feel new)

`Level` currently hard-codes five procedural textures (`createConcreteTexture`,
`createFloorTexture`, …). Add a **theme table** instead of new files:

| Slot | Sector 7 (`lab`) | Sublevel 4 (`industrial`) |
| --- | --- | --- |
| Floor | polished lab floor | wet metal grating (darker, higher roughness, reflective streaks) |
| Walls | concrete panels | riveted steel + painted hazard stripes near doors |
| Ceiling | tile | open trusses (mesh) + pipes |
| Crates | supply crates | tool cases / fuel drums |
| Doors | grey blast door | yellow/black hazard shutter |
| Light colour | `0xc4dcff` cool white | `0x9fd8d0` cyan-green |
| Emergency | red `0xff3322` | amber `0xffa022` |
| Fog | `0x050709` @ 0.03 | `0x061014` @ 0.026 |

All of these are procedural canvas textures in `js/textures.js`, so a theme is a
set of parameters to the existing generators plus 2–3 new generators
(`createGrateTexture`, `createHazardStripeTexture`, `createRivetPanelTexture`).
No binary assets, consistent with the rest of the project.

### Phase 3 — new props (optional, adds cover variety)

New one-character props, each with a collider in `planLayout()` and a mesh
builder in `Level.buildProps()`:

| Char | Prop | Size (m) | Cover height |
| --- | --- | --- | --- |
| `V` | Coolant vat (round, tall) | ⌀1.4 × 3.0 | full (blocks sight) |
| `R` | Pipe railing | 2.0 × 1.1 | half — shoot over, not through |
| `X` | Forklift / cart | 2.2 × 1.5 | half |
| `W` | Water pool (decal, no collider) | 2 × 2 | none, slows nothing (visual) |

Keep the total draw calls flat by merging props per material, as `buildProps()`
already does with `BatchBuilder`.

### Phase 4 — map selection

- `index.html`: a `MAP` row in the main menu (Sector 7 / Sublevel 4 / Random).
- `game.js`: `startRun()` takes a `mapId`; `Level` is rebuilt instead of reused
  when the id changes (`level.dispose()` then `new Level(...)`), or better: keep
  both `Level` instances alive and toggle `group.visible` + `pickups` to make
  switching instant (memory cost is small — a few MB of merged geometry).
- `storage.js`: remember the last played map; keep **per-map records** (best
  score/wave) so the two maps do not share a leaderboard.
- Wave feel: `getWaveConfig()` stays pure; a map can pass a modifier object
  (`spawnIntervalScale`, `maxAliveBonus`) rather than forking the curve.

### Phase 5 — stretch: procedural variation

Once two hand-made maps exist, add a `seed` to the manifest and let
`planLayout()` jitter prop placement/rotation (it already uses a seeded
`makeRng`). Room *structure* stays hand-authored; only dressing varies. Switch
on with `?seed=1234` for testing.

---

## 5. Performance budget

Sector 7 renders roughly: 1 floor + 1 ceiling + wall runs (merged) + props
(merged) + doors (one mesh each) + signs (one per kind) + pickups + enemies.
Sublevel 4 is **more open**, which is the risky part: fewer walls means more of
the level is on screen at once.

Targets to hold:

- Draw calls ≤ Sector 7 + 10 % (verify with `?debug` →
  `lastStand.renderer.info.render.calls`).
- Doors stay ≤ 12 meshes; if a map needs more, merge door panels into one
  `InstancedMesh` the way `DecalPool` does.
- Lights: ≤ 8 point-light fixtures in the plan, 1 shadow-casting spot.
- Enemies: unchanged (`maxAlive` ≤ 12 + map bonus).

---

## 6. Milestones & acceptance

| # | Milestone | Acceptance |
| --- | --- | --- |
| 1 | `js/maps/` + manifest + layout | `npm test` validates both maps (connectivity, spawns, light budget) |
| 2 | Theme table + 3 new procedural textures | Sublevel 4 is visually distinct at a glance; no new network/asset deps |
| 3 | Map select UI + per-map records | Switch maps from the menu; high scores are tracked separately |
| 4 | Map-specific wave modifiers | Hall map sustains more simultaneous enemies without hurting the frame rate |
| 5 | New props (`V`, `R`, `X`, `W`) | Cover variety in both maps; colliders + nav grid + tests updated |
| 6 | Procedural dressing seed (stretch) | Same seed → same map; different seed → different dressing, same connectivity |

**Definition of done for a map:** it passes every check in
`tests/run-tests.mjs` (which becomes map-parameterised), it is completable to
wave 10 in playtesting, and draw calls stay inside the budget above.

---

## 7. Open questions

1. Rebuild `Level` on map change, or keep both loaded? (Recommendation: keep
   both loaded — instant switching, ~2× level memory which is small.)
2. Does the hall need a raised catwalk? That means **verticality**, which the
   engine does not have: collision is 2.5D (`moveCylinder` ignores Y), the nav
   grid is 2D, and `WALL_HEIGHT`/ceiling planes are single-valued. Verticality
   is a separate, much larger project (see §8).
3. Shared leaderboard or per-map? (Recommendation: per-map.)

## 8. Note on verticality (do not bundle with this work)

A catwalk/second floor would require: per-actor floor height in
`resolveCylinder`, a multi-level nav grid (one `NavGrid` per floor + link
nodes), hitscan floor/ceiling tests per level, and enemy AI that can path
between levels. That is a multi-week engine change and should be its own plan —
it also multiplies the multiplayer refactor in `Multiplayer_Plan.md` §4.
