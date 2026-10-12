# gameprototype

Game prototypes.

## Projects

- **[project-last-stand](project-last-stand/)** — PROJECT: LAST STAND, a
  browser first-person survival shooter built on Three.js (the main project).
  See its [README](project-last-stand/README.md) for install, controls and
  layout.
- **[project-feedback](project-feedback/)** — PROTOCOL: FEEDBACK, a 2D canvas
  arena movement/combat prototype.

## Docs

| Document | What it covers |
| --- | --- |
| [docs/Multiplayer_Plan.md](docs/Multiplayer_Plan.md) | Roadmap for 1–4 player co-op: headless sim refactor, authoritative server, protocol, prediction, milestones |
| [docs/New_Map_Plan.md](docs/New_Map_Plan.md) | Second map (Sublevel 4: Coolant Intake): validated layout, map manifest, theming, map select |
| [docs/Weapons_Roadmap.md](docs/Weapons_Roadmap.md) | New firearms, melee and throwables: defs, projectile system, loadouts, attachments, balance tests |
| [docs/Game_Modes_Plan.md](docs/Game_Modes_Plan.md) | Mode layer plus Hardcore, Endless Rush, Time Attack, Defend, Extraction, Hardport |

## Recent work

- **Decal fix**: bullet holes and blood pools now expire (12 s / 30 s, with a
  0.4 s shrink-out) and any mark shot into a blast door disappears the moment
  the panel starts to retract, instead of hanging in the open doorway.
- **Flashlight**: wider, softer and far-reaching beam (54° cone, 45 m reach,
  flatter falloff) plus a dim short-range spill so the area around the player is
  lit; shadow map raised to 2048 to keep the wider cone crisp.
