import { describe, it, expect } from 'vitest';
import { enumerateTileWindow } from '../src/splats/transform.js';

/**
 * `desiredTiles()` is built from `enumerateTileWindow`, while the code it replaced walked the
 * clamped `windowRange`. Those are two different ways of saying "the window, inside the grid" —
 * one clamps the bounds, the other skips out-of-range tiles — so this pins that they describe the
 * SAME SET, including at the edges of the world where the two could plausibly disagree.
 */
const fromRange = (z: number, cx: number, cy: number, r: number): string[] => {
  const n = 2 ** z - 1;
  const out: string[] = [];
  for (let x = Math.max(0, cx - r); x <= Math.min(n, cx + r); x++) {
    for (let y = Math.max(0, cy - r); y <= Math.min(n, cy + r); y++) out.push(`${x}/${y}`);
  }
  return out.sort();
};
const fromWindow = (z: number, cx: number, cy: number, r: number): string[] =>
  enumerateTileWindow(z, cx, cy, r).map(([x, y]) => `${x}/${y}`).sort();

describe('desiredTiles: window enumeration matches the clamped range it replaced', () => {
  const cases: Array<[string, number, number, number, number]> = [
    ['middle of the grid', 16, 18057, 25935, 1],
    ['radius 0 (single tile)', 16, 18057, 25935, 0],
    ['radius 2', 16, 18057, 25935, 2],
    ['NW corner, clipped', 4, 0, 0, 1],
    ['SE corner, clipped', 4, 15, 15, 1],
    ['whole world at z1', 1, 0, 0, 3],
    ['z0 — one tile, big radius', 0, 0, 0, 4]
  ];
  for (const [label, z, cx, cy, r] of cases) {
    it(label, () => {
      expect(fromWindow(z, cx, cy, r)).toEqual(fromRange(z, cx, cy, r));
    });
  }

  it('never returns a tile outside the grid', () => {
    for (const z of [0, 1, 4, 16]) {
      const n = 2 ** z;
      for (const [x, y] of enumerateTileWindow(z, 0, 0, 3)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(n);
        expect(y).toBeLessThan(n);
      }
    }
  });
});
