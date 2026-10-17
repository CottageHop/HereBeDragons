import { describe, expect, it } from 'vitest';
import { THIN_MAX_GROW, THIN_MIN_KEEP, clampThinKeep, densityFor, densityKeep, thinGrow, thinWeights } from '../src/splats/thin.js';

const N = 200_000;

function keptFraction(keep: number, from = 0, n = N): number {
  let k = 0;
  for (let i = from; i < from + n; i++) if (thinGrow(i, keep) > 0) k++;
  return k / n;
}

describe('motion thinning', () => {
  it('keep 1 is a no-op: every splat kept at scale 1', () => {
    for (let i = 0; i < 1000; i++) expect(thinGrow(i, 1)).toBe(1);
  });

  it('keeps the requested fraction, also over consecutive index runs (one roof, one crown)', () => {
    for (const keep of [0.25, 0.5, 0.75]) {
      expect(keptFraction(keep)).toBeCloseTo(keep, 2);
      // a contiguous run of 2,000 splats (one building) is thinned evenly, not in stripes
      expect(Math.abs(keptFraction(keep, 123_456, 2000) - keep)).toBeLessThan(0.04);
    }
  });

  it('is nested: everything kept at a lower keep is kept at a higher one', () => {
    for (let i = 0; i < 20_000; i++) {
      if (thinGrow(i, 0.3) > 0) expect(thinGrow(i, 0.5)).toBeGreaterThan(0);
    }
  });

  it('grows kept splats by 1/sqrt(keep) so covered area is preserved, capped', () => {
    const g = thinGrow([...Array(100).keys()].find((i) => thinGrow(i, 0.5) > 0)!, 0.5);
    expect(g).toBeCloseTo(Math.SQRT2, 6);
    // area kept = keep * grow^2 = 1
    expect(0.5 * g * g).toBeCloseTo(1, 6);
    const tiny = [...Array(1000).keys()].map((i) => thinGrow(i, 0.01)).find((v) => v > 0)!;
    expect(tiny).toBe(THIN_MAX_GROW);
  });

  it('soft band: splats just above keep are drawn faded, so a rising keep fades them in', () => {
    let banded = 0;
    for (let i = 0; i < 20_000; i++) {
      const [g0, a0] = thinWeights(i, 0.4, 0);
      const [g, a] = thinWeights(i, 0.4, 0.15);
      if (g0 > 0) expect([g, a]).toEqual([g0, 1]);          // the kept set is unchanged
      else if (g > 0) {
        banded++;
        expect(a).toBeGreaterThan(0);
        expect(a).toBeLessThanOrEqual(1);
        // the same splat a little further up the ramp is more opaque — no step at a sort
        expect(thinWeights(i, 0.45, 0.15)[1]).toBeGreaterThan(a);
      } else expect(a0).toBe(0);
    }
    expect(banded / 20_000).toBeCloseTo(0.15, 1);
  });

  it('clamps the keep fraction to the range where coverage still holds', () => {
    expect(clampThinKeep(1.5)).toBe(1);
    expect(clampThinKeep(Number.NaN)).toBe(1);
    expect(clampThinKeep(0.01)).toBe(THIN_MIN_KEEP);
    expect(clampThinKeep(0.5)).toBe(0.5);
    expect(THIN_MIN_KEEP * THIN_MAX_GROW * THIN_MAX_GROW).toBeCloseTo(1, 9);
  });
});

describe('screen-space density LOD', () => {
  // focal 800 px, target 1 px: keep everything whose spacing projects wider than a pixel

  const density = densityFor(800, 1);

  it('keeps near splats whole and thins far ones by the square of their projected spacing', () => {
    const scales = [0.225, 0.225, 0.05] as const; // a 0.45 m roof surfel (σ = ½ spacing)
    const at = (d: number) => densityKeep([0, 0, 0], [0, 0, -d], scales, density);
    expect(at(100)).toBe(1);            // spacing 0.45 m projects to 3.6 px
    expect(at(360)).toBeCloseTo(1, 6);  // ≈ 1 px: the threshold
    expect(at(720)).toBeCloseTo(0.25, 6);
    expect(at(1440)).toBeCloseTo(1 / 16, 6);
  });

  it('bigger splats (trees, lite tiles) keep their count further out — spacing, not distance, decides', () => {
    const d = 1000;
    const small = densityKeep([0, 0, 0], [0, 0, -d], [0.225, 0.225, 0.05], density);
    const big = densityKeep([0, 0, 0], [0, 0, -d], [0.5, 0.5, 0.5], density);
    expect(big).toBeGreaterThan(small);
  });

  it('density 0 is off; the 1× motion buffer thins four times harder than the 2× rest buffer', () => {
    expect(densityKeep([0, 0, 0], [0, 0, -5000], [0.2, 0.2, 0.2], 0)).toBe(1);
    expect(densityFor(0, 1)).toBe(0);
    expect(densityFor(800, 1) / densityFor(400, 1)).toBeCloseTo(4, 9);
  });
});
