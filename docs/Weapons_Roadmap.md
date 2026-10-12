# Weapons roadmap — more guns for PROJECT: LAST STAND

Status: **milestones 0–2 landed** (schema + validation, loadouts, S-9 VIPER and
MKR-1 MARKSMAN). See "Implementation notes" at the bottom for the numbers that
were actually shipped and where they deviate from this document. Milestones 3–6
(projectiles, melee + pistol, ammo kinds, LMG + attachments) are still design.
Covers new firearms, new melee, throwables and the systems they need. Today the
game ships 7 weapons: MX-7 rifle, HB-12 shotgun, S-9 SMG, MKR-1 marksman, field
knife, steel pipe, fire axe (`js/weapon.js` → `WEAPON_DEFS`).

---

## 1. What is already data-driven (good news)

`WEAPON_DEFS` is a plain object; `WeaponState` holds ammo/timers per weapon;
`WeaponSystem.traceRay()` resolves hitscan for any `{ damage, pellets, spread,
range, falloff }`; melee uses `swingTimeline()` in `js/meleeAnim.js`. Adding a
**hitscan firearm** with existing behaviour is genuinely close to "add a def +
a viewmodel + a sound":

| Concern | Today | Gap for new weapons |
| --- | --- | --- |
| Stats | `WEAPON_DEFS[id]` | needs `ammoKind`, `unlockWave`, `moveSpeedMult`, `adsZoom` |
| Fire modes | `auto` boolean | no burst mode, no charge, no projectiles |
| Ammo | one pool per weapon, `reserve`/`maxReserve` | no shared ammo kinds; pickups fill *everything* |
| Slots | hard-wired 1–5 (`WEAPON_ORDER`, HUD in `index.html`) | no loadouts, no "which two do I bring" |
| Reload | `magazine` / `shell` | fine as-is |
| Audio | `playShot('shotgun' \| anything else)` — **two** sounds total | needs per-weapon shot/impact profiles |
| Viewmodels | hand-built per weapon in `weapon.js` | each new gun is ~40 lines of geometry |
| Effects | tracers, sparks, decals | no explosions, no fire, no penetration |

---

## 2. Proposed arsenal

DPS figures below are **sustained** (`magDamage / (magTime + reloadTime)`),
matching how `WEAPON_DEFS` and `computeFalloff()` behave today. Reference
points: rifle ≈ 142 dps sustained, shotgun ≈ 78 sustained / 936 per magazine at
point blank.

### 2.1 New firearms

| id | Name | Slot | Dmg | Rate | Mag | Reserve | Reload | Sustained DPS | Role |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `smg` | S-9 VIPER SMG | 1–2 | 15 | 14/s | 35 | 210 | 1.6 s | ~128 | Close–mid, best hipfire, fast swap (0.3 s), heavy bloom |
| `dmr` | MKR-1 MARKSMAN | 1–2 | 68 | 2.2/s semi | 12 | 72 | 2.4 s | ~104 (×2.5 head = ~260) | Long lanes, penetrates 1 enemy, one-shot runner headshots |
| `pistol` | MK2 SIDEARM | always | 30 | 5/s semi | 12 | ∞ (see below) | 1.3 s | ~97 | Never-empty backup, fast draw, weak vs armored |
| `lmg` | BZ-40 SUPPRESSOR | 1–2 | 22 | 8/s | 100 | 300 | 5.2 s | ~124 with 12 s of continuous fire | Horde clearing, −25 % move speed, massive recoil |
| `launcher` | GL-6 THUMPER | 1–2 | 140 splash (r 4.5 m) | 0.9/s | 1 | 6 | 2.8 s | burst only | Crowd delete; needs the projectile system (§3.1) |

Notes:

- **Pistol reserve** = "always available": it refills to 36 rounds at the start
  of every intermission instead of using pickups, so a dry player is never
  weaponless. Cheap to implement (`needsAmmo()` already skips melee).
- **DMR penetration**: `traceRay()` returns on the first valid hitbox — add
  `penetration: 1` to keep raycasting past a killed/penetrated target, applying
  `damage * 0.6` to each subsequent body. This also makes the LMG feel heavy.
- **`moveSpeedMult`** hooks into `player.update()`; the LMG is the first user.

### 2.2 New melee

| id | Name | Dmg | Reach | Arc | Targets | Speed | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `machete` | CLEAVER | 58 | 1.85 | 55° | 3 | fast (0.5 s cycle) | Crowd sweep, replaces pipe for hit-and-run players |
| `sledge` | SLEDGEHAMMER | 140 | 2.1 | 24° | 1 | very slow (1.3 s cycle) | Guaranteed stagger on anything but armored heads; knockback |

Both reuse `swingTimeline()` with new `swing` poses (`'sweep'`, `'smash'`) in
`meleeAnim.js` — no new animation system required.

### 2.3 Throwables / tactical slot (stretch)

One extra key (`G`) with a small stack, sharing the projectile system:

- `frag` — 3 s fuse, 5 m lethal radius, bounces off walls/doors.
- `flash` — blinds/staggers infected within 8 m for 2.5 s (`EnemyAI` gets a
  `stunTimer`).
- `molotov` — burning ground patch, damage over time (needs a new particle/decal
  surface on the floor).

---

## 3. Systems to build (in dependency order)

### 3.1 Projectiles (`js/projectiles.js`) — the big one

Everything explosive needs it. Design (pooled, allocation-free, same rules as
`ParticleSystem`):

```
ProjectileSystem
  spawn({ origin, dir, speed, gravity, radius, damage, fuse, owner })
  update(dt, colliders, enemies, hooks)   // swept sphere vs raycastBoxes, then enemy proximity
  onDetonate -> effects.spawnExplosion(), audio, AoE damage with falloff + LOS check
```

- Reuse `raycastBoxes()` for the swept step and `hasLineOfSight()` for splash.
- Visuals: one pooled `InstancedMesh` of small spheres + the existing
  particle pools for the blast; one new decal pool for scorch marks (reuse
  `DecalPool`, which now supports lifetimes — see the decal work in `js/effects.js`).
- Multiplayer: projectile *spawn* is an RPC, the sim owns physics (see
  `Multiplayer_Plan.md` §6).

### 3.2 Ammo kinds

Add `ammoKind: 'rifle' | 'shell' | 'heavy' | 'explosive'` to every def and to
the pickup system:

- `PickupSystem` (`js/level.js`) currently asks `weapons.needsAmmo()` and fills
  the current weapon. Change to: an ammo box carries a kind (or "current weapon's
  kind") and refills every carried weapon of that kind by a flat amount.
- HUD shows reserve per kind, not just per weapon.

### 3.3 Loadouts

`WEAPON_ORDER` is fixed at 5 slots today. Proposal:

- **Slot keys stay 1–5** (muscle memory, HUD in `index.html` already lists them),
  but become **rebindable**: `1`/`2` = the two firearms you brought, `3` = melee,
  `4` = tactical/stretch, `5` = pistol (always).
- Menu: a **loadout screen** (new `screen-loadout` section in `index.html`)
  listing unlocked weapons; pick two firearms + one melee. Stored in
  `storage.js` next to settings.
- Unlock by wave: `unlockWave: 3` on a def + a toast when it unlocks in a run.

### 3.4 Attachments / upgrade bench (stretch, high value)

Spend score during the 15 s intermission at one console prop in the map
(`M` cells):

| Attachment | Effect | Cost | Applies to |
| --- | --- | --- | --- |
| Extended mag | `magazineSize × 1.5` | 750 | firearms |
| Suppressor | −20 % damage, no enemy aggro on miss, softer sound | 500 | rifle/smg/pistol |
| Laser | −40 % hipfire spread | 400 | firearms (except shotgun) |
| Hollow point | +25 % damage, −1 penetration | 900 | dmr/pistol |
| Weighted head | +30 % stagger, −10 % swing speed | 600 | melee |

Implementation: an `attachments` map on `WeaponState` that patches a *derived*
def at switch time. Keep `WEAPON_DEFS` immutable so tests stay pure.

### 3.5 Audio

`audio.js` branches on `kind === 'shotgun'` and everything else. Add a
`SHOT_PROFILES` table keyed by `def.sound` with 3–4 parameters
(noise volume/filter/decay, body blip f0/f1), so a new gun is a few numbers
rather than new code. Same for `playReload` (already table-driven) and
`playHitFlesh`.

---

## 4. Balance guardrails

Pure functions + tests, so balance changes cannot silently break the suite:

1. `validateWeaponDef(def)` in `js/weapon.js` (exported) — required fields,
   unique slots, `reserve >= magazineSize`, `damage > 0`, `reloadTime > 0`,
   melee-only vs firearm-only field pairs.
2. A test that computes sustained DPS for every firearm and asserts it lands in
   a band (60–160 dps sustained; shotguns/LMG allowed to exceed on burst).
3. A test that no weapon one-shots an armored infected at wave 1 health with a
   body shot (`ENEMY_TYPES.armored`), so armour stays meaningful.
4. `computeFalloff()` is already tested — keep it the single source of distance
   damage.

---

## 5. Milestones

| # | Milestone | Deliverable | Acceptance |
| --- | --- | --- | --- |
| 0 | Schema + validation | `ammoKind`, `unlockWave`, `moveSpeedMult`, `validateWeaponDef()` + tests | `npm test` validates every def; no gameplay change |
| 1 | Two hitscan guns | SMG + DMR, new viewmodels, shot profiles | Both are pick-up-able and feel distinct; reload/HUD/decal behaviour identical to existing guns |
| 2 | Loadouts + slot rebind | Loadout screen, storage, dynamic HUD slots | Pick 2 of 4 firearms; HUD lists what you carry; keys 1–5 still work |
| 3 | Projectiles | `js/projectiles.js`, GL-6, scorch decals, AoE damage with LOS | Grenade launcher clears a clump; no self-damage through walls; pooled (no per-frame allocation) |
| 4 | Melee + pistol | Machete, sledge, always-available pistol | New swing poses; stagger works; pistol refills each intermission |
| 5 | Ammo kinds + pickups | Kind-aware `PickupSystem`, HUD | Ammo boxes state their kind; LMG ammo is rarer than rifle ammo |
| 6 | LMG + attachments (stretch) | BZ-40, upgrade bench, attachments on `WeaponState` | Bench usable in intermission; attachments persist for the run |

Ordering matters: **0 → 1 → 2** are low-risk and shippable on their own; **3**
is the largest single chunk of new code and should land before the mode work in
`Game_Modes_Plan.md` that depends on explosives (demolition objectives).

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Power creep makes wave 20 trivial | New guns unlock by wave and cost score; balance tests in §4 |
| Key bindings run out (5 slots + G + Q) | Loadouts, not more slots; the pistol is always slot 5 |
| Explosives tank the frame rate | One pooled `InstancedMesh`, particle budget shared with `EffectsManager`, cap 8 live projectiles |
| Viewmodel authoring cost per gun | Write a small parametric builder (body/receiver/mag/stock/grip primitives) instead of hand-built geometry per weapon |
| Multiplayer desync from new weapons | Everything new goes through the sim event bus designed in `Multiplayer_Plan.md` §4 — do **not** land projectiles before that refactor if multiplayer is next |

---

## 7. Implementation notes (milestones 0–2, shipped)

Milestone 0 — `js/weapon.js` exports `validateWeaponDef(def, allDefs?, loadout?)`,
`validateWeaponDefs()`, `SLOT_COUNT`, `SLOT_CATEGORIES`, `DEFAULT_LOADOUT`,
`WEAPON_IDS`, `AMMO_KINDS`, `sanitizeLoadout()`, `hudSlotLabels()`,
`loadoutSlotOptions()`, `magazineCycleTime()`, `magazineDamage()` and
`sustainedDps()`. Every def carries `shortName`, `unlockWave`,
`moveSpeedMult` and (firearms only) `ammoKind` / `adsZoom` / `penetration`.
`slot` is the *default* slot: two weapons may declare the same one (rifle and
SMG both default to 1), so uniqueness is only enforced inside the default
loadout. `unlockWave`, `moveSpeedMult` and `adsZoom` are inert until the waves,
LMG and attachment work lands.

Milestone 2 — slots are data: `loadout[i]` answers key `i + 1`. `Game.setLoadout()`
sanitizes, rebuilds the slots, repaints the HUD chips and saves it next to the
settings (`storage.js`). The LOADOUT screen builds its selects from
`WEAPON_DEFS`, and `?weapons=smg,dmr` overrides slots 1–2 for one session.

Milestone 1 — the shipped numbers (deviations from §2.1 in brackets):

| id | Damage | Rate | Mag | Reserve | Reload | Switch | Spread / bloom | Sustained DPS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `smg` | 15 (head ×1.6) | 14/s auto | 35 | 210 / 420 | 1.6 s | 0.3 s | 0.014 → 0.055 | 128 |
| `dmr` | 68 (head ×2.5) | 2.2/s semi | 12 | 72 / 144 | 2.4 s | 0.65 s | 0.0035 → 0.02 | 104 |

- The SMG gained a mild falloff (`16 m → 45 m, min 0.5`) and range 70 to make it
  a close–mid weapon rather than a worse rifle, and a ×1.6 headshot bonus.
- The DMR has `falloff: null` (the document implies no distance loss), range 200
  and `penetration: 1`; penetrated bodies take `PENETRATION_DAMAGE_MULT` (0.6)
  of the damage, compounding, and the wall behind them still takes the decal.
- Both use `ammoKind: 'rifle'` while the ammo-kind *pickups* of milestone 5 do
  not exist yet; `AMMO_PICKUP` has `smg: 90`, `dmr: 24`.
- Viewmodels come from `buildParametricFirearm(spec)` (receiver/barrel/magazine/
  stock/grip/rail/sight primitives, merged per material). Every viewmodel is
  built once per `WeaponSystem` and `prewarmShaders()` compiles all of them, so
  swapping a loadout in the menu never compiles a shader mid-run.
- Audio is table-driven: `SHOT_PROFILES[def.sound]` (noise layers + body blip)
  in `js/audio.js`; the rifle and shotgun rows are byte-for-byte the old sounds.
