/**
 * arenaData.js
 * Collider layout for the pit. Meshes in arena.js are built from the same
 * boxes so the visible walls and the things you bump into cannot drift.
 */
import { createBox } from './collision.js';

export const INNER = 17;
export const WALL_H = 5.6;
export const THICK = 1.4;
export const PLAYER_SPAWN = { x: 0, y: 0, z: 9, yaw: 0 };

/** Low overhang. Standing height does not fit; a slide does. Filth does. */
export const TUNNEL = { minX: -14, maxX: -5, minZ: 12, maxZ: 16.6, lipY: 1.08 };

export const SPAWNS = [
  [0, 14.6],
  [-12.2, -12.2],
  [11.2, 12.4],
  [-13.2, 1.5],
  [11.4, -12.4],
  [5.2, 13.2],
  [-6.4, -13.2],
  [6.5, -8.2],
  [-2.2, 14.2],
  [9.2, 5.4],
];

export function createArenaColliders() {
  const inner = INNER;
  const outer = inner + THICK;
  const H = WALL_H;
  const boxes = [
    createBox(-outer, 0, -outer, -inner, H, outer, 'wall'),
    createBox(inner, 0, -outer, outer, H, outer, 'wall'),
    createBox(-inner, 0, -outer, inner, H, -inner, 'wall'),
    createBox(-inner, 0, inner, inner, H, outer, 'wall'),
    createBox(-8.1, 0, -8.1, -5.9, H, -5.9, 'pillar'),
    createBox(6.6, 0, -7.2, 8.8, H, -5.0, 'pillar'),
    createBox(-7.1, 0, 7.4, -5.1, H, 9.6, 'pillar'),
    createBox(7.6, 0, 6.8, 10.0, H, 9.2, 'pillar'),
    createBox(-1.15, 0, -1.15, 1.15, H, 1.15, 'pillar'),
    createBox(-4.2, 0, -14.2, 4.2, 1.12, -9.2, 'platform'),
    createBox(12.7, 0, -3.3, inner, 2.32, 3.3, 'platform'),
    createBox(-14.4, 0, 2.1, -11.2, 0.86, 5.4, 'crate'),
    createBox(-11.3, 0, 6.0, -8.6, 0.7, 8.3, 'crate'),
    createBox(3.1, 0, 2.2, 4.6, 1.0, 3.7, 'crate'),
    createBox(-3.9, 0, -3.4, -2.4, 0.75, -1.9, 'crate'),
    createBox(1.4, 0, -8.0, 3.3, 0.9, -6.1, 'crate'),
    createBox(TUNNEL.minX, TUNNEL.lipY, TUNNEL.minZ, TUNNEL.maxX, H, TUNNEL.maxZ, 'overhang'),
  ];
  return boxes;
}
