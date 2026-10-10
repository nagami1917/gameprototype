# Task: Fix floating bullet marks on opening doors + give decals a lifetime

Repo: `gameprototype` → game lives in `project-last-stand/` (Three.js 0.186.1, plain ES modules,
no build step, Node 18+). Run with `npm start`, test with `npm test`.

---

## The two bugs

### 1. Bullet holes stay floating in an open doorway (primary visual bug)

Shoot a closed blast door, then step away so it opens. The bullet hole keeps rendering at its
original world position — suspended in mid-air in the doorway, with no surface behind it.

**Root cause (already traced, please confirm before changing anything):**

- `DecalPool.place()` (`js/effects.js:201`) bakes a **world-space** matrix into a single
  `InstancedMesh`. The decal has no owner, no parent transform and no lifetime, so nothing ever
  moves or removes it.
- Door panels are animated by shrinking them into the ceiling in `Level.update()`
  (`js/level.js:887-894`):
  ```js
  const h = Math.max(0.02, WALL_HEIGHT * (1 - d.openAmount));
  d.panel.scale.y = h;
  d.panel.position.y = WALL_HEIGHT - h / 2;
  d.panel.visible = h > 0.05;
  ```
  and the collider is switched off once mostly open (`js/level.js:889`):
  `d.collider.active = d.openAmount < 0.6;`
- So the geometry the mark was placed on physically leaves, but the mark does not. Once the
  collider deactivates, rays pass straight through the doorway while the old mark still renders —
  it reads as a hole in thin air.

### 2. Decals never expire (they only get overwritten)

`DecalPool` is a ring buffer of 70 holes / 24 blood pools (`js/effects.js:250-251`). Slots are
recycled **only** when the cursor wraps (`js/effects.js:203`) or when `clearDecals()` is called on
run start / restart (`js/game.js:251`, `js/game.js:410`). In a long run the level slowly fills
with permanent marks, and the oldest marks pop out of existence mid-fight when the buffer wraps.

---

## What to build

### A. Decals must die with the surface they are on

1. Plumb the hit surface identity from the raycast through to the decal. Today it is dropped:
   - `raycastBoxes()` already returns the hit `box` (`js/collision.js:199-206`).
   - `WeaponSystem.traceRay()` throws it away and keeps only a `surface` string
     (`js/weapon.js:518-526`). Add the owning box (or a stable surface id) to the returned
     `type: 'world'` result.
   - `fire()` calls `this.effects.spawnImpact(res.point, res.normal, res.surface)`
     (`js/weapon.js:440`). Pass the owner along, e.g.
     `spawnImpact(point, normal, surface, owner)`.
   - Floor/ceiling plane hits return early with no box (`js/weapon.js:513-516`) — those get a
     lifetime but no owner. That is correct.
2. Give each pool slot per-slot metadata: `life`, `maxLife`, `baseScale`, `rotation`, position,
   quaternion and `owner`. Keep it in plain typed arrays / parallel arrays like the existing
   `ParticleSystem` does (`js/effects.js:60-100`) — no per-slot objects.
3. Cull a door's decals **the moment the door starts to move**, not when the collider deactivates:
   hide any slot whose owner door has `d.openAmount > 0.02`. Use `openAmount`, not
   `collider.active`, otherwise marks linger through the first 60 % of the slide.
4. Wiring: `game.update()` already calls `this.level.update(dt, this.actorCache)` immediately
   before `this.effects.update(dt, this.time)` (`js/game.js:725-726`). Pass the door list in —
   `this.effects.update(dt, this.time, this.level.doors)` — and let `EffectsManager` hide the
   owned slots. Do **not** give `EffectsManager` a reference to `Level`; keep the dependency one
   way via the argument.
5. Culling must be repeatable: marks placed while the door was closing, then reopened, must be
   culled again. Culling must not touch floor blood pools or marks on walls/crates.

### B. Decal lifetime + fade (the "cooldown")

1. Every decal gets a lifetime. Suggested tunables as named constants at the top of
   `js/effects.js`: bullet holes ~12 s, blood pools ~30 s, with a short fade tail (~0.4 s).
2. Fade visually over the tail. `MeshBasicMaterial` has no per-instance alpha, so pick one and
   say which you chose in the PR description:
   - **(preferred)** shrink the instance scale to 0 over the last ~0.4 s — no shader work, keeps
     exactly one draw call;
   - or add an `InstancedBufferAttribute` alpha and patch the material via `onBeforeCompile`.
3. On expiry, write the zero-scale `_decalHidden` matrix (`js/effects.js:177`) and return the slot
   to a free-list, so recycling prefers genuinely free slots instead of always overwriting the
   cursor. Oldest-alive should expire first in practice; never pop a mark that was placed this
   second while free slots exist.
4. Set `instanceMatrix.needsUpdate = true` **once per frame** when anything changed, not once per
   decal.
5. `clearDecals()` (`js/effects.js:361-364`) must also reset lifetimes and the free-list, so a
   restart starts clean.

---

## Hard constraints

- **No allocation in the per-frame path.** No `new THREE.Vector3/Matrix4/Quaternion/Object` inside
  `update()` or `place()`. Reuse module-level scratch objects the way the existing `_decal*`
  constants do (`js/effects.js:170-177`).
- **Keep one draw call per pool.** Both pools stay a single `InstancedMesh` each; keep
  `frustumCulled = false`, `renderOrder = 2`, `depthWrite: false`, `polygonOffset` and the shared
  module-scope material. Do not add a mesh per decal.
- **Do not rename `effects.holes` or `effects.bloodDecals`.** `prewarmShaders()` reveals
  `this.effects.holes.mesh` and `this.effects.bloodDecals.mesh` (`js/game.js:206-231`) and would
  break silently.
- **No gameplay changes.** Door open/close timing, `d.hold`, `collider.active` threshold, damage,
  spread and raycast ordering must be byte-for-byte identical in behaviour. Door hits keep
  mapping to the `metal` surface so sparks still play (`js/weapon.js:523`).
- Keep the existing code style: JSDoc block comments on public methods, short inline comments
  explaining *why*, ES modules, no new dependencies.

---

## Acceptance criteria

1. Shoot a closed door 10 times, step back so it opens → every mark on that door is gone by the
   frame the panel starts moving. Nothing is left floating in the doorway.
2. Marks on walls, crates and the floor are unaffected by doors and survive their full lifetime.
3. Stand still and do nothing: marks fade out and disappear after their lifetime, oldest first.
4. Fire ~200 rounds over a couple of minutes: live decal count never exceeds the pool size,
   recycling is smooth, no visible popping of recent marks.
5. Restart a run → no stale marks anywhere.
6. Draw calls unchanged. Verify with `?debug` in the URL (exposes `window.lastStand`) and compare
   `lastStand.renderer.info.render.calls` before and after the change.
7. `npm test` still passes. Current baseline is **37 passed, 0 failed** — do not regress it.

## Verification to run and report

```bash
cd project-last-stand
npm install   # three is a real dependency; the suite imports it
npm test
```

If the lifetime/free-list logic can be expressed as pure, import-free math, add Node tests for it
in `tests/run-tests.mjs` following the existing `test(name, fn)` / `assert*` helpers. If it cannot
be tested without a browser/WebGL context, say so explicitly in the PR description and cover it
with the manual steps 1-6 above instead — do not write a test that stubs out the real logic.

Report back with: the files changed, the fade approach chosen (scale vs. per-instance alpha), the
`npm test` result line, and the draw-call numbers from step 6.
