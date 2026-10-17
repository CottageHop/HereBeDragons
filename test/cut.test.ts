import { describe, it, expect } from 'vitest';
import { quadtreeCut, levelForDistance, cellKey, cellDistanceMeters, type CutParams, type CutCell } from '../src/splats/cut.js';

const P = (o: Partial<CutParams> = {}): CutParams => ({
  zNear: 16, minTileZoom: 0, maxLevelDrop: 2, dropDistance: 800, hysteresis: 0.15, ...o
});
/** The window at the coarsest level: radius cells around (cx, cy) at zFloor. */
const window14 = (cx: number, cy: number, r: number, z = 14): CutCell[] => {
  const out: CutCell[] = [];
  for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) out.push({ z, x, y });
  return out;
};
/** Ground a tile covers, in units of the finest level, as [x0,x1)x[y0,y1). */
const ground = (c: CutCell, zFine: number): [number, number, number, number] => {
  const s = 2 ** (zFine - c.z);
  return [c.x * s, (c.x + 1) * s, c.y * s, (c.y + 1) * s];
};

describe('levelForDistance', () => {
  it('holds at the finest level inside d0, then drops one level per doubling', () => {
    const p = P();
    expect(levelForDistance(0, p)).toBe(16);
    expect(levelForDistance(799, p)).toBe(16);
    expect(levelForDistance(1200, p)).toBe(15);   // past d0
    expect(levelForDistance(2000, p)).toBe(14);   // past 2 x d0
    expect(levelForDistance(9999, p)).toBe(14);   // clamped by maxLevelDrop
  });
  it('respects minTileZoom over maxLevelDrop', () => {
    expect(levelForDistance(1e9, P({ zNear: 3, minTileZoom: 2, maxLevelDrop: 9 }))).toBe(2);
  });
  it('dropDistance 0 means no cut at all', () => {
    expect(levelForDistance(1e9, P({ dropDistance: 0 }))).toBe(16);
  });
});

describe('quadtreeCut', () => {
  it('covers every point of the window EXACTLY once', () => {
    // Distance grows with |x| so the cut is genuinely mixed-level, not uniform.
    const p = P();
    const cells = window14(4000, 3000, 1);
    const out = quadtreeCut(cells, (z, x) => Math.abs(x * 2 ** (14 - z) - 4000 * 1) * 900, p);
    expect(out.length).toBeGreaterThan(cells.length);         // something subdivided
    expect(new Set(out.map((c) => c.z)).size).toBeGreaterThan(1); // more than one level in play

    // Tile the finest-level grid and count how many emitted cells claim each unit of ground.
    const counts = new Map<string, number>();
    for (const c of out) {
      const [x0, x1, y0, y1] = ground(c, 16);
      for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) {
        const k = `${x}/${y}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const total = cells.length * 4 ** (16 - 14);
    expect(counts.size).toBe(total);                       // no gaps
    expect([...counts.values()].every((n) => n === 1)).toBe(true);  // no overlaps
  });

  it('near cells end up finer than far ones', () => {
    const p = P();
    const cells = window14(4000, 3000, 1);
    // Distance measured from the centre cell, in cell units scaled to metres.
    const out = quadtreeCut(cells, (z, x, y) => {
      const s = 2 ** (14 - z);
      return Math.hypot(x * s - 4000, y * s - 3000) * 1500;
    }, p);
    const centre = out.filter((c) => Math.hypot(c.x * 2 ** (14 - c.z) - 4000, c.y * 2 ** (14 - c.z) - 3000) < 0.5);
    expect(Math.max(...centre.map((c) => c.z))).toBe(16);   // centre refined to the finest level
    expect(Math.min(...out.map((c) => c.z))).toBeLessThan(16); // periphery left coarse
  });

  it('dropDistance 0 returns the input untouched — the cut is genuinely off', () => {
    const cells = window14(4000, 3000, 1, 16);
    const out = quadtreeCut(cells, () => 1e9, P({ dropDistance: 0 }));
    expect(out).toEqual(cells);
  });

  it('hysteresis holds a cell on a threshold instead of flipping it', () => {
    const p = P({ hysteresis: 0.3 });
    const sticky = new Map<string, number>();
    const cells = [{ z: 14, x: 4000, y: 3000 }];
    // Park the cell exactly on the d0 boundary and jitter it by a hair, repeatedly.
    const levels = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const d = 800 * (i % 2 === 0 ? 1.02 : 0.98);
      levels.add(quadtreeCut(cells, () => d, p, sticky)[0].z);
    }
    expect(levels.size).toBe(1);   // never flipped
  });

  it('without hysteresis the same jitter DOES flip it — proving the band is what holds it', () => {
    const p = P({ hysteresis: 0 });
    const cells = [{ z: 15, x: 8000, y: 6000 }];
    const levels = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const d = 800 * (i % 2 === 0 ? 1.4 : 0.7);
      levels.add(quadtreeCut(cells, () => d, p, new Map())[0].z);
    }
    expect(levels.size).toBeGreaterThan(1);
  });

  it('cellKey identifies ground, not level choice', () => {
    expect(cellKey(14, 1, 2)).toBe('14/1/2');
    expect(cellKey(14, 1, 2)).not.toBe(cellKey(15, 1, 2));
  });
});

describe('cellDistanceMeters', () => {
  const F = (o = {}) => ({ cx: 0.5, cy: 0.5, dist: 0.0001, bearingDeg: 0, tiltDeg: 0, ...o });

  it('a cell under a straight-down camera is at least the camera HEIGHT away, never zero', () => {
    // Ground distance alone would say ~0 and call it maximally near, which is backwards. The
    // nearest possible cell still sits up to half a tile off the camera axis, so the exact value
    // is height + that offset — assert the property, not a number I would have to hand-fit.
    const f = F({ tiltDeg: 0 });
    const n = 2 ** 16;
    const height = f.dist * 40075016.686;
    const tile = 40075016.686 / n;
    const d = cellDistanceMeters(16, Math.round(0.5 * n) - 1, Math.round(0.5 * n) - 1, f, 0);
    expect(d).toBeGreaterThanOrEqual(height);
    expect(d).toBeLessThan(Math.hypot(height, tile));
  });

  it('grows with ground offset', () => {
    const f = F();
    const n = 2 ** 16;
    const c = Math.round(0.5 * n);
    const near = cellDistanceMeters(16, c, c, f, 0);
    const far = cellDistanceMeters(16, c + 40, c, f, 0);
    expect(far).toBeGreaterThan(near);
  });

  it('shrinks with latitude, because mercator units cover less ground there', () => {
    const f = F();
    const n = 2 ** 16;
    const c = Math.round(0.5 * n) + 40;
    expect(cellDistanceMeters(16, c, c, f, 60)).toBeLessThan(cellDistanceMeters(16, c, c, f, 0));
  });
});

describe('rankCellsByRelevance — one list across several levels', () => {
  const F = { cx: 0.5, cy: 0.5, dist: 0.0005, bearingDeg: 0, tiltDeg: 0 };

  it('ranks a near fine tile ahead of a far coarse one', async () => {
    const { rankCellsByRelevance } = await import('../src/splats/lod.js');
    const n16 = 2 ** 16, n14 = 2 ** 14;
    const near = { z: 16, x: Math.round(0.5 * n16), y: Math.round(0.5 * n16) };
    const far = { z: 14, x: Math.round(0.5 * n14) + 3, y: Math.round(0.5 * n14) + 3 };
    expect(rankCellsByRelevance([far, near], F)[0]).toEqual(near);
  });

  it('prefers the FINER level when a parent and its child tie', async () => {
    const { rankCellsByRelevance } = await import('../src/splats/lod.js');
    // A cell and one of its own children share a nearest point, so they score identically.
    const parent = { z: 15, x: 16384, y: 16384 };
    const child = { z: 16, x: 32768, y: 32768 };
    expect(rankCellsByRelevance([parent, child], F)[0]).toEqual(child);
  });

  it('is a total order — no pair is left to insertion order', async () => {
    const { rankCellsByRelevance } = await import('../src/splats/lod.js');
    const cells = [
      { z: 15, x: 16384, y: 16384 }, { z: 16, x: 32768, y: 32768 },
      { z: 16, x: 32769, y: 32768 }, { z: 14, x: 8192, y: 8192 }
    ];
    const a = rankCellsByRelevance(cells, F).map((c) => `${c.z}/${c.x}/${c.y}`);
    const b = rankCellsByRelevance([...cells].reverse(), F).map((c) => `${c.z}/${c.x}/${c.y}`);
    expect(a).toEqual(b);
  });
});
