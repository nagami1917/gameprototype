# PROJECT: LAST STAND

A first-person survival shooter that runs in the browser. Fight through waves of
infected in a dark research facility, scavenge supplies between waves, and survive as
long as you can. Built with plain HTML, CSS and JavaScript modules on top of Three.js.

## Requirements

- Node.js 18 or newer (for the dev server and `npm install`)
- A desktop browser with WebGL 2 and Pointer Lock support (Chrome, Edge, Firefox, Safari)

## Install

```bash
cd project-last-stand
npm install
```

## Run the development server

```bash
npm start            # same as: npm run dev / node server.mjs
```

Then open <http://localhost:3000>. To use another port:

```bash
PORT=8080 npm start
```

The server binds to `0.0.0.0`, so other devices on your network can reach it at
`http://<your-machine-address>:3000`.

## Run the tests

```bash
npm test
```

The test suite runs in Node (no browser needed). It checks every module for syntax
errors, collision, A* pathfinding, map connectivity and spawn validity, wave
composition, shotgun falloff and LocalStorage handling.

## Controls

| Input | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Look (Pointer Lock) |
| Left click | Fire (hold the automatic rifle); one swing per click with a melee weapon |
| Right click | Aim down sights (firearms only) |
| R | Reload |
| Shift | Sprint (forward only) |
| Space | Jump; with a melee weapon drawn, swing instead (no jump) |
| 1–5 | Draw the weapon in that slot (firearms on 1–2, melee on 3–5; see LOADOUT in the menu) |

Melee swings: hold A or D while attacking (or flick the mouse) for a backhand or
forehand swing. Each swing has a wind-up, a strike and a recovery, and hits each enemy
at most once.
| Esc | Pause and release the mouse |

Menus can be navigated with the mouse or with &uarr; &darr; and Enter.

## Gameplay

- **Assault Rifle**: medium damage, fully automatic, 30-round magazine.
- **Shotgun**: nine pellets, high damage at close range, falls off with distance,
  8-round magazine, slow fire, reloads one shell at a time (firing cancels a reload).
- **S-9 Viper SMG**: 35-round magazine at 14 rounds a second, light damage per round,
  heavy bloom while the trigger is held, fastest draw in the game; halved damage past
  45 m. Shares rifle ammunition.
- **MKR-1 Marksman**: 68 damage per semi-automatic round, x2.5 headshots, 12-round
  magazine, no distance falloff, and the round penetrates one body for 60% damage.
  Shares rifle ammunition and is the reason to keep a lane open.
- **Loadout**: the LOADOUT screen in the main menu picks which weapon sits in each of
  the five keys. It is saved with the settings.
- **Field Knife**: quick, short-range single-target slash; no ammunition required.
- **Steel Pipe**: wider, two-target sweep with moderate damage and reach.
- **Fire Axe**: slow, heavy close-range strike with high damage.
  Melee hits respect walls and doors, can stagger susceptible infected, and inherit
  the existing armored-enemy damage reduction.
- **Infected**: Basic (moderate HP and speed), Runner (fast, low HP), Armored (slow,
  high HP, reduces body-shot damage; headshots ignore the armour).
- **Waves** grow in size and difficulty. Each wave is preceded by a countdown and is
  followed by a supply break where pickups respawn. Every fifth wave adds an elite
  armored group.
- **Score**: kills award points, headshots add a bonus, and each cleared wave gives a
  bonus. High score, best wave and best kills are saved in this browser's LocalStorage.
- The game continues until your health reaches zero.

## Project layout

```
project-last-stand/
├── index.html          page shell, menus and HUD markup
├── style.css           styles, HUD and responsive layout
├── server.mjs          zero-dependency static dev server
├── package.json
├── js/
│   ├── main.js         entry point and menu wiring
│   ├── game.js         state machine, systems and rules
│   ├── player.js       movement, health, camera
│   ├── weapon.js       weapons, hitscan, melee state machine, viewmodels
│   ├── meleeAnim.js    melee arm rig, swing poses and easing, blade trail
│   ├── enemy.js        enemy types, states, visuals
│   ├── enemyAI.js      perception, A* nav grid, behaviour
│   ├── level.js        map layout, geometry, doors, lights, pickups
│   ├── collision.js    AABB and cylinder collision, raycasts
│   ├── waveManager.js  wave composition and flow
│   ├── effects.js      particles, tracers, decals
│   ├── textures.js     procedural canvas textures
│   ├── input.js        keyboard, mouse and pointer lock
│   ├── ui.js           DOM menus, HUD and keyboard navigation
│   ├── audio.js        procedural Web Audio sound
│   └── storage.js      LocalStorage save data and settings
├── tests/run-tests.mjs
└── assets/             audio and texture folders (audio is procedural)
```

## Debugging

Add `?debug` to the URL to expose the running game as `window.lastStand` in the console.

Add `?weapons=smg,dmr` to override the firearm slots for one session (nothing is saved),
which is the quick way to test a new gun without touching the menu.
