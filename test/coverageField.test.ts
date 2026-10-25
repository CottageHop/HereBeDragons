import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Projection } from '../src/core/Projection.js';
import { tileWorldRect, lonLatToTile } from '../src/core/TileId.js';
import {
  ALL_NEIGHBOURS,
  NO_NEIGHBOURS,
  UNION_LEAVE_MS,
  type UnionPresence,
  type UnionWeights,
  roundedUnionMask,
  roundedUnionSigned,
  roundedUnionSignedPacked,
  unionSettleMs,
  unionTileValues
} from '../src/core/roundedUnion.js';
import { CoverageField, resolveTileReveal } from '../src/tiles/CoverageField.js';
import { createCoverageUniforms, patchCoverage } from '../src/materials/coverageShader.js';
import { StylizedMaterials } from '../src/materials/StylizedMaterials.js';
import { Palette } from '../src/materials/Palette.js';

const LAT = 35.1222;
const LON = -80.8237;
const Z = 14;
const C = lonLatToTile(LON, LAT, Z);
const FEATHER = 0.03;
const GROW = 700;
/** Quantisation of the 8-bit distance, seen through the feather's steepest
 *  slope (1.5 / 2f), plus rounding. */
const MASK_TOL = 0.03;

function make(opt: Parameters<typeof resolveTileReveal>[0] = true, radius = 3) {
  let now = 1000;
  const projection = new Projection(LAT, LON);
  const uniforms = createCoverageUniforms();
  const field = new CoverageField(projection, uniforms, resolveTileReveal(opt), () => now);
  field.setWindowRadius(radius);
  field.setCentre(Z, C.x, C.y);
  return {
    field,
    uniforms,
    projection,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    settle: () => { now += unionSettleMs(GROW) + 1; field.tick(); }
  };
}

/** Mask the field stores at texel (tx, ty) of window cell (i, j). */
function maskAtTexel(field: CoverageField, i: number, j: number, tx: number, ty: number): number {
  const { texelsPerTile: p } = field.layoutInfo;
  const s = field.signedAtTexel(i * p + tx, j * p + ty);
  const t = Math.min(Math.max(s / (2 * FEATHER), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Compare every texel of cell (i, j) with `roundedUnionMask`. */
function expectCellMatches(
  field: CoverageField, i: number, j: number,
  w: UnionWeights, g: number, ng: UnionWeights
): void {
  const { texelsPerTile: p } = field.layoutInfo;
  let worst = 0;
  for (let ty = 0; ty < p; ty++) {
    for (let tx = 0; tx < p; tx++) {
      const u = (tx + 0.5) / p;
      const v = 1 - (ty + 0.5) / p; // rows run south, v runs north
      const want = roundedUnionMask(u, v, w, g, FEATHER, ng);
      worst = Math.max(worst, Math.abs(maskAtTexel(field, i, j, tx, ty) - want));
    }
  }
  expect(worst).toBeLessThan(MASK_TOL);
}

describe('resolveTileReveal', () => {
  it('defaults on, 700 ms, feather 0.03, no slab rise', () => {
    expect(resolveTileReveal(undefined)).toEqual({ enabled: true, growMs: 700, feather: 0.03, rise: false });
    expect(resolveTileReveal(true).enabled).toBe(true);
    expect(resolveTileReveal(false).enabled).toBe(false);
  });
  it('takes overrides and caps the feather so interiors stay exact', () => {
    const r = resolveTileReveal({ growMs: 0, feather: 0.4, rise: true });
    expect(r).toEqual({ enabled: true, growMs: 0, feather: 0.2, rise: true });
    expect(resolveTileReveal({ growMs: -5, feather: NaN }).growMs).toBe(700);
  });
});

describe('roundedUnionSignedPacked', () => {
  it('equals roundedUnionSigned for any weights / growths, inside and outside the square', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    // Weights / growths hit the corners 0 and 1 often — that is where tiles rest.
    const val = (): number => { const r = rnd(); return r < 0.25 ? 0 : r > 0.75 ? 1 : rnd(); };
    for (let n = 0; n < 4000; n++) {
      const vals = Array.from({ length: 16 }, val);
      const g = val();
      const w = { e: vals[0], w: vals[1], n: vals[2], s: vals[3], ne: vals[4], nw: vals[5], se: vals[6], sw: vals[7] };
      const ng = { e: vals[8], w: vals[9], n: vals[10], s: vals[11], ne: vals[12], nw: vals[13], se: vals[14], sw: vals[15] };
      const u = rnd() * 1.6 - 0.3;
      const v = rnd() * 1.6 - 0.3;
      expect(roundedUnionSignedPacked(u, v, vals, g)).toBeCloseTo(roundedUnionSigned(u, v, w, g, ng), 12);
    }
  });
});

describe('tileWorldRect', () => {
  const projection = new Projection(LAT, LON);
  it('is an exact square with the north edge at zMin, tiling seamlessly', () => {
    const a = tileWorldRect(projection, Z, C.x, C.y);
    const e = tileWorldRect(projection, Z, C.x + 1, C.y);
    const s = tileWorldRect(projection, Z, C.x, C.y + 1);
    const size = a.xMax - a.xMin;
    expect(size).toBeGreaterThan(1000);
    expect(a.zMax - a.zMin).toBeCloseTo(size, 6);
    expect(e.xMin).toBeCloseTo(a.xMax, 6);
    expect(s.zMin).toBeCloseTo(a.zMax, 6); // tile y + 1 is further SOUTH = +Z
    // The projection origin lies inside its own tile.
    expect(a.xMin).toBeLessThanOrEqual(0);
    expect(a.xMax).toBeGreaterThan(0);
    expect(a.zMin).toBeLessThanOrEqual(0);
    expect(a.zMax).toBeGreaterThan(0);
  });
});

describe('CoverageField baking', () => {
  it('gives every tile a whole number of texels and publishes the window rect', () => {
    const { field, uniforms, projection } = make();
    field.tick();
    const { size, texelsPerTile, x0, y0 } = field.layoutInfo;
    expect(size).toBe(256);
    expect(texelsPerTile).toBe(Math.floor(256 / 7));
    expect(x0).toBe(C.x - 3);
    expect(y0).toBe(C.y - 3);
    const nw = tileWorldRect(projection, Z, x0, y0);
    const rect = uniforms.uCoverageRect.value;
    expect(rect.x).toBeCloseTo(nw.xMin, 6);
    expect(rect.y).toBeCloseTo(nw.zMin, 6);
    expect(1 / rect.z).toBeCloseTo(((nw.xMax - nw.xMin) * size) / texelsPerTile, 4);
    expect(uniforms.uCoverageParams.value.x).toBe(1);
  });

  it('one settled tile bakes as a circle (= roundedUnionMask, no neighbours)', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.settle();
    expectCellMatches(t.field, 3, 3, NO_NEIGHBOURS, 1, ALL_NEIGHBOURS);
  });

  it('two adjacent tiles bake as a pill with the shared side fully joined', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.field.addTile(Z, C.x + 1, C.y);
    t.settle();
    expectCellMatches(t.field, 3, 3, { ...NO_NEIGHBOURS, e: 1 }, 1, ALL_NEIGHBOURS);
    expectCellMatches(t.field, 4, 3, { ...NO_NEIGHBOURS, w: 1 }, 1, ALL_NEIGHBOURS);
    // Mid-height on the shared side: fully inside on both sides of the seam.
    const p = t.field.layoutInfo.texelsPerTile;
    const mid = Math.floor(p / 2);
    expect(maskAtTexel(t.field, 3, 3, p - 1, mid)).toBe(1);
    expect(maskAtTexel(t.field, 4, 3, 0, mid)).toBe(1);
    // …while the pill's outer corners are cut away.
    expect(maskAtTexel(t.field, 3, 3, 0, 0)).toBe(0);
  });

  it('a mid-growth frame matches roundedUnionMask with the animated values', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.advance(500);
    t.field.addTile(Z, C.x + 1, C.y);
    t.advance(450); // first tile grown, second mid-growth, bridge part-way
    t.field.tick();
    const a: UnionPresence = { x: C.x, y: C.y, inMs: 1000, outMs: null };
    const b: UnionPresence = { x: C.x + 1, y: C.y, inMs: 1500, outMs: null };
    const at = (x: number, y: number) => (y !== C.y ? undefined : x === a.x ? a : x === b.x ? b : undefined);
    for (const [p, i] of [[a, 3], [b, 4]] as const) {
      const out = new Float64Array(16);
      const g = unionTileValues(p, at, t.now(), GROW, out);
      const w = { e: out[0], w: out[1], n: out[2], s: out[3], ne: out[4], nw: out[5], se: out[6], sw: out[7] };
      const ng = { e: out[8], w: out[9], n: out[10], s: out[11], ne: out[12], nw: out[13], se: out[14], sw: out[15] };
      expect(g).toBeGreaterThan(0);
      if (p === b) expect(g).toBeLessThan(1);
      expect(w[p === a ? 'e' : 'w']).toBeGreaterThan(0);
      expect(w[p === a ? 'e' : 'w']).toBeLessThan(1);
      expectCellMatches(t.field, i, 3, w, g, ng);
    }
  });

  it('a settled interior tile is exactly 1.0 everywhere (no dither crawl)', () => {
    const t = make();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) t.field.addTile(Z, C.x + dx, C.y + dy);
    t.settle();
    const p = t.field.layoutInfo.texelsPerTile;
    for (let ty = 0; ty < p; ty++) {
      for (let tx = 0; tx < p; tx++) {
        expect(t.field.signedAtTexel(3 * p + tx, 3 * p + ty)).toBeGreaterThanOrEqual(2 * FEATHER);
        expect(maskAtTexel(t.field, 3, 3, tx, ty)).toBe(1);
      }
    }
    // Seams between settled tiles: exactly 1 across every interior join.
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    const size = r.xMax - r.xMin;
    for (let k = 0; k <= 20; k++) {
      const f = k / 20;
      expect(t.field.coverageAt(r.xMax, r.zMin + f * size)).toBe(1); // east seam
      expect(t.field.coverageAt(r.xMin + f * size, r.zMax)).toBe(1); // south seam
    }
  });

  it('an absent tile beside a tile holds a 2-texel fringe of the extended field', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.field.addTile(Z, C.x, C.y + 1); // vertical pill: straight east side at x = xMax
    t.settle();
    const p = t.field.layoutInfo.texelsPerTile;
    const mid = Math.floor(p / 2);
    // East neighbour cell (4, 3) is absent. Its first column continues the
    // pill's field past the side (s = −(u − 1) just outside)…
    const just = t.field.signedAtTexel(4 * p, 3 * p + p - 1);
    expect(just).toBeCloseTo(-0.5 / p, 2);
    // …and beyond the fringe the cell is blank (clamped far-outside).
    const far = t.field.signedAtTexel(4 * p + 3, 3 * p + mid);
    expect(far).toBeLessThan(-1 / p);
    // So the straight side sits ON the tile boundary: mask 0 there, rising
    // to 1 one feather-ramp inside.
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    const size = r.xMax - r.xMin;
    expect(t.field.coverageAt(r.xMax - 1e-3, r.zMax)).toBeLessThan(0.02);
    expect(t.field.coverageAt(r.xMax - 2.5 * FEATHER * size, r.zMax)).toBeGreaterThan(0.98);
  });
});

describe('CoverageField animation + idling', () => {
  it('grows from the centre, then goes idle and stops baking', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    const size = r.xMax - r.xMin;
    const cx = (r.xMin + r.xMax) / 2;
    const cz = (r.zMin + r.zMax) / 2;
    expect(t.field.tick()).toBe(true);
    // Just landed: nothing visible yet, not even the centre.
    expect(t.field.coverageAt(cx, cz)).toBe(0);
    t.advance(120);
    expect(t.field.tick()).toBe(true);
    expect(t.field.coverageAt(cx, cz)).toBe(1);
    expect(t.field.coverageAt(cx + 0.45 * size, cz)).toBe(0); // rim not reached yet
    t.advance(GROW);
    t.field.tick();
    expect(t.field.coverageAt(cx + 0.4 * size, cz)).toBe(1);

    t.settle();
    expect(t.field.tick()).toBe(false);
    expect(t.field.active).toBe(false);
    const bakes = t.field.bakeCount;
    for (let k = 0; k < 10; k++) { t.advance(16); expect(t.field.tick()).toBe(false); }
    expect(t.field.bakeCount).toBe(bakes);

    // A new tile wakes it up again.
    t.field.addTile(Z, C.x + 1, C.y);
    expect(t.field.active).toBe(true);
    expect(t.field.tick()).toBe(true);
    expect(t.field.bakeCount).toBe(bakes + 1);
  });

  it('growMs: 0 applies membership at once', () => {
    const t = make({ growMs: 0 });
    t.field.addTile(Z, C.x, C.y);
    t.field.tick();
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    expect(t.field.coverageAt((r.xMin + r.xMax) / 2 + 0.4 * (r.xMax - r.xMin), (r.zMin + r.zMax) / 2)).toBe(1);
    expect(t.field.tick()).toBe(false);
    t.field.removeTile(Z, C.x, C.y);
    t.field.tick();
    expect(t.field.coverageAt((r.xMin + r.xMax) / 2, (r.zMin + r.zMax) / 2)).toBe(0);
  });

  it('an evicted tile is gone at once; the join toward it retracts over the leave time', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.field.addTile(Z, C.x + 1, C.y);
    t.settle();
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    const size = r.xMax - r.xMin;
    const cz = (r.zMin + r.zMax) / 2;
    const nearSide = r.xMax - 0.02 * size; // inside tile A, by the shared side
    const upperCorner = [r.xMax - 0.06 * size, r.zMin + 0.12 * size] as const; // pill-only area
    expect(t.field.coverageAt(...upperCorner)).toBe(1);

    t.field.removeTile(Z, C.x + 1, C.y);
    expect(t.field.tileCount).toBe(1); // never blocks the eviction
    t.advance(UNION_LEAVE_MS / 2);
    expect(t.field.tick()).toBe(true);
    const mid = t.field.coverageAt(...upperCorner);
    t.advance(UNION_LEAVE_MS);
    t.field.tick();
    // Back to a lone circle: the pill's corner area is cut, the point on the
    // circle's east rim is on the soft edge.
    expect(t.field.coverageAt(...upperCorner)).toBe(0);
    expect(mid).toBeLessThanOrEqual(1);
    expect(t.field.coverageAt(nearSide, cz)).toBeLessThan(1);
    t.advance(16);
    expect(t.field.tick()).toBe(false); // ghost retired → idle
  });

  it('a tile that comes back while leaving regrows from its current size', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.settle();
    t.field.removeTile(Z, C.x, C.y);
    t.advance(UNION_LEAVE_MS / 2);
    t.field.tick();
    t.field.addTile(Z, C.x, C.y);
    expect(t.field.tileCount).toBe(1);
    t.field.tick();
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    // Half-grown, not restarted from zero: the centre is still covered.
    expect(t.field.coverageAt((r.xMin + r.xMax) / 2, (r.zMin + r.zMax) / 2)).toBe(1);
  });
});

describe('CoverageField window', () => {
  it('does not re-anchor while the centre tile is unchanged', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.settle();
    const rect = t.uniforms.uCoverageRect.value.clone();
    const bakes = t.field.bakeCount;
    t.field.setCentre(Z, C.x, C.y); // camera moved inside the same tile
    expect(t.field.tick()).toBe(false);
    expect(t.uniforms.uCoverageRect.value.equals(rect)).toBe(true);
    expect(t.field.bakeCount).toBe(bakes);
  });

  it('re-anchors by whole tiles, shifting the baked content with it', () => {
    const t = make({ growMs: 0 });
    t.field.addTile(Z, C.x, C.y);
    t.field.addTile(Z, C.x + 1, C.y);
    t.field.tick();
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    const size = r.xMax - r.xMin;
    const probes: Array<[number, number]> = [];
    for (let k = 0; k < 40; k++) probes.push([r.xMin + (k / 20) * size, r.zMin + ((k * 7) % 20) / 20 * size]);
    const before = probes.map(([x, z]) => t.field.coverageAt(x, z));
    const rect = t.uniforms.uCoverageRect.value.clone();

    t.field.setCentre(Z, C.x + 1, C.y - 1);
    expect(t.field.tick()).toBe(true);
    const moved = t.uniforms.uCoverageRect.value;
    expect(moved.x - rect.x).toBeCloseTo(size, 4);
    expect(moved.y - rect.y).toBeCloseTo(-size, 4); // north = −Z
    expect(t.field.layoutInfo.x0).toBe(C.x + 1 - 3);
    const after = probes.map(([x, z]) => t.field.coverageAt(x, z));
    after.forEach((v, k) => expect(v).toBeCloseTo(before[k], 6));
    expect(t.field.tick()).toBe(false);
  });

  it('treats tiles outside the window as absent, and grows them in when they scroll in', () => {
    const t = make(true, 1); // 3×3 window
    t.field.addTile(Z, C.x + 2, C.y); // resident but outside
    t.settle();
    const r = tileWorldRect(t.projection, Z, C.x + 2, C.y);
    const cx = (r.xMin + r.xMax) / 2;
    const cz = (r.zMin + r.zMax) / 2;
    expect(t.field.coverageAt(cx, cz)).toBe(0);
    t.field.setCentre(Z, C.x + 1, C.y);
    expect(t.field.tick()).toBe(true);
    expect(t.field.coverageAt(cx + 0.4 * (r.xMax - r.xMin), cz)).toBe(0); // growing, not popped
    t.settle();
    expect(t.field.coverageAt(cx + 0.4 * (r.xMax - r.xMin), cz)).toBe(1);
  });

  it('a jump further than the window re-bakes from scratch', () => {
    const t = make({ growMs: 0 });
    t.field.addTile(Z, C.x, C.y);
    t.field.tick();
    t.field.setCentre(Z, C.x + 50, C.y);
    t.field.addTile(Z, C.x + 50, C.y);
    t.field.tick();
    const far = tileWorldRect(t.projection, Z, C.x + 50, C.y);
    const near = tileWorldRect(t.projection, Z, C.x, C.y);
    expect(t.field.coverageAt((far.xMin + far.xMax) / 2, (far.zMin + far.zMax) / 2)).toBe(1);
    expect(t.field.coverageAt((near.xMin + near.xMax) / 2, (near.zMin + near.zMax) / 2)).toBe(0);
  });

  it('grows the texture rather than starve tiles of texels in a huge window', () => {
    const t = make(true, 20); // 41 tiles across
    expect(t.field.layoutInfo.size).toBe(512);
    expect(t.field.layoutInfo.texelsPerTile).toBe(12);
  });
});

describe('CoverageField invalidation + opt-out', () => {
  it('a tile-zoom change (quality tier flip) drops the old grid', () => {
    const t = make({ growMs: 0 });
    t.field.addTile(Z, C.x, C.y);
    t.field.tick();
    const old = tileWorldRect(t.projection, Z, C.x, C.y);
    expect(t.field.coverageAt((old.xMin + old.xMax) / 2, (old.zMin + old.zMax) / 2)).toBe(1);

    const c13 = lonLatToTile(LON, LAT, 13);
    t.field.setCentre(13, c13.x, c13.y);
    expect(t.field.tileCount).toBe(0);
    t.field.removeTile(Z, C.x, C.y); // stale evictions are ignored
    t.field.addTile(13, c13.x, c13.y);
    t.field.tick();
    expect(t.field.layoutInfo.z).toBe(13);
    const r13 = tileWorldRect(t.projection, 13, c13.x, c13.y);
    const size13 = r13.xMax - r13.xMin;
    expect(size13).toBeCloseTo(2 * (old.xMax - old.xMin), 3); // radius follows the tile size
    expect(1 / t.uniforms.uCoverageRect.value.z).toBeCloseTo((size13 * 256) / t.field.layoutInfo.texelsPerTile, 3);
    // A z13 circle: its rim reaches 0.4 of the BIGGER tile.
    expect(t.field.coverageAt((r13.xMin + r13.xMax) / 2 + 0.4 * size13, (r13.zMin + r13.zMax) / 2)).toBe(1);
  });

  it('tileReveal: false → coverage is 1 everywhere, the uniform switch is off, no baking', () => {
    const t = make(false);
    t.field.addTile(Z, C.x, C.y);
    expect(t.field.tick()).toBe(false);
    expect(t.field.bakeCount).toBe(0);
    expect(t.uniforms.uCoverageParams.value.x).toBe(0);
    expect(t.field.coverageAt(1e6, -1e6)).toBe(1);
    expect(t.field.slabRise).toBe(true); // legacy spawn animation untouched
    // Membership was still tracked: switching on shows the settled state.
    t.field.setEnabled(true);
    expect(t.uniforms.uCoverageParams.value.x).toBe(1);
    expect(t.field.tick()).toBe(true);
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    expect(t.field.coverageAt((r.xMin + r.xMax) / 2 + 0.4 * (r.xMax - r.xMin), (r.zMin + r.zMax) / 2)).toBe(1);
    expect(t.field.slabRise).toBe(false);
  });

  it('setOptions retunes growMs / feather / rise live (feather re-bakes with a new encoding)', () => {
    const t = make();
    t.field.addTile(Z, C.x, C.y);
    t.settle();
    const r = tileWorldRect(t.projection, Z, C.x, C.y);
    const size = r.xMax - r.xMin;
    const cx = (r.xMin + r.xMax) / 2;
    const cz = (r.zMin + r.zMax) / 2;
    // A point 0.47 tile from the centre of a lone circle (radius 0.5): inside
    // the 0.03 feather's ramp it is nearly opaque…
    const near = (): number => t.field.coverageAt(cx + 0.47 * size, cz);
    const before = near();
    expect(before).toBeGreaterThan(0.4);
    const invBefore = t.uniforms.uCoverageParams.value.w;

    t.field.setOptions({ feather: 0.15, growMs: 0, rise: true });
    expect(t.field.config).toMatchObject({ enabled: true, feather: 0.15, growMs: 0, rise: true });
    expect(t.field.slabRise).toBe(true);
    expect(t.uniforms.uCoverageParams.value.w).toBeCloseTo(1 / 0.3, 6);
    expect(t.uniforms.uCoverageParams.value.w).toBeLessThan(invBefore);
    expect(t.field.tick()).toBe(true); // re-baked
    // …with a 0.15 feather the same point is early on a much wider ramp.
    expect(near()).toBeLessThan(before);
    expect(t.field.coverageAt(cx, cz)).toBe(1);

    // Capped like the constructor option; garbage and no-ops are ignored.
    t.field.setOptions({ feather: 5 });
    expect(t.field.config.feather).toBe(0.2);
    t.field.tick();
    const bakes = t.field.bakeCount;
    t.field.setOptions({ feather: 0.2, growMs: NaN, rise: undefined });
    expect(t.field.config).toMatchObject({ feather: 0.2, growMs: 0, rise: true });
    expect(t.field.tick()).toBe(false);
    expect(t.field.bakeCount).toBe(bakes);
  });

  it('ground plane / underlay twins compile WITHOUT the mask; tile materials with it', () => {
    const m = new StylizedMaterials();
    const compile = (mat: THREE.Material) => {
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.toon.vertexShader,
        fragmentShader: THREE.ShaderLib.toon.fragmentShader
      };
      mat.onBeforeCompile(shader as never, null as never);
      return shader;
    };
    for (const slot of [Palette.ground, Palette.road_minor, Palette.rail_strip, Palette.building]) {
      const masked = m.get(slot);
      const plain = m.getUnmasked(slot);
      expect(plain).not.toBe(masked);
      expect(m.getUnmasked(slot)).toBe(plain);
      expect(m.unmaskedTwin(masked)).toBe(plain);
      const a = compile(masked);
      const b = compile(plain);
      expect(a.fragmentShader).toContain('hbdCoverageDiscard(vHbdCoverXZ)');
      expect(a.vertexShader).toContain('vHbdCoverXZ =');
      expect(a.uniforms.uCoverageTex).toBe(m.coverage.uCoverageTex);
      expect(b.fragmentShader).not.toContain('hbdCoverage');
      expect(b.vertexShader).not.toContain('vHbdCoverXZ');
      expect(b.uniforms.uCoverageTex).toBeUndefined();
      // Same onBeforeCompile source → the program cache key must differ.
      expect(masked.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
    }
    // Twins follow theme colours and the bulk setters.
    m.setColors({ ground: '#123456' });
    expect(m.getUnmasked(Palette.ground).color.getHexString()).toBe(m.get(Palette.ground).color.getHexString());
    m.setPainterlySurface(0.5);
    expect((m.getUnmasked(Palette.ground).userData.uPainterlySurface as { value: number }).value).toBe(0.5);
    // Tunnels: a define-gated ShaderMaterial twin.
    const tunnel = m.getTunnelMaterial();
    expect(tunnel.defines.HBD_COVERAGE).toBeDefined();
    expect((m.unmaskedTwin(tunnel) as THREE.ShaderMaterial).defines.HBD_COVERAGE).toBeUndefined();
    // Unknown materials pass through.
    const other = new THREE.MeshBasicMaterial();
    expect(m.unmaskedTwin(other)).toBe(other);
    m.dispose();
  });

  it('patchCoverage modes: alpha for transparent, flat normal for the outline override', () => {
    const cov = createCoverageUniforms();
    const basic = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader
    };
    patchCoverage(basic, cov, 'alpha');
    expect(basic.fragmentShader).toContain('gl_FragColor.a *= hbdCoverage(vHbdCoverXZ);');
    expect(basic.fragmentShader).not.toContain('discard;\n}'); // no dither on transparent
    const normal = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.normal.vertexShader,
      fragmentShader: THREE.ShaderLib.normal.fragmentShader
    };
    patchCoverage(normal, cov, 'flatNormal');
    expect(normal.fragmentShader).toContain('normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)');
    expect(normal.vertexShader).toContain('USE_INSTANCING');
    // MeshNormalMaterial's fragment shader has no <common>: the declarations
    // must still land (before main).
    expect(normal.fragmentShader.indexOf('float hbdCoverage(')).toBeGreaterThan(-1);
    expect(normal.fragmentShader.indexOf('float hbdCoverage(')).toBeLessThan(normal.fragmentShader.indexOf('void main()'));
    expect(normal.fragmentShader).toContain('varying vec2 vHbdCoverXZ;');
  });
});

// ---------------------------------------------------------------------------
// Second channel — the satellite cut-out (`hideBasemap: 'covered'`)
// ---------------------------------------------------------------------------

describe('CoverageField cut-out channel (G)', () => {
  const SZ = 16; // splat tiles live on their own, finer grid
  const S = lonLatToTile(LON, LAT, SZ);
  /** The 16 packed values of a settled tile with the given neighbours. */
  const settled = (at: (x: number, y: number) => UnionPresence | undefined, x: number, y: number) => {
    const out = new Float64Array(16);
    const g = unionTileValues({ x, y, inMs: -Infinity, outMs: null }, at, 0, 0, out);
    return { g, values: out };
  };
  const lone = settled(() => undefined, S.x, S.y);
  const smooth01 = (t: number): number => { const c = Math.min(Math.max(t, 0), 1); return c * c * (3 - 2 * c); };

  function makeCut(opt: Parameters<typeof resolveTileReveal>[0] = true, radius = 7) {
    const t = make(opt, radius);
    t.field.setCutoutReserved(true);
    t.field.setCutoutMode(1);
    t.field.setCentre(Z, C.x, C.y);
    return t;
  }

  it('reserving the cut-out doubles the texture; the reveal (R) is unaffected by it', () => {
    // The default keep zone (15 × 15 basemap tiles): 17 texels per z14 tile is
    // 4 per z16 splat tile — too few for a round outline, so the edge doubles.
    const a = make(true, 7);
    a.field.addTile(Z, C.x, C.y);
    a.settle();
    const b = makeCut();
    b.field.addTile(Z, C.x, C.y);
    b.settle();
    expect(a.field.layoutInfo.size).toBe(256);
    expect(b.field.layoutInfo.size).toBe(512);
    const r = tileWorldRect(a.projection, Z, C.x, C.y);
    for (const [fx, fz] of [[0.5, 0.5], [0.2, 0.7], [0.93, 0.5], [0.85, 0.15], [0.5, 0.985]]) {
      const x = r.xMin + fx * (r.xMax - r.xMin);
      const z = r.zMin + fz * (r.zMax - r.zMin);
      expect(b.field.coverageAt(x, z)).toBeCloseTo(a.field.coverageAt(x, z), 1);
    }
    // No cut-out pushed yet: G is empty, nothing is cut.
    expect(b.field.cutoutAt((r.xMin + r.xMax) / 2, (r.zMin + r.zMax) / 2)).toBe(0);
    expect(b.uniforms.uCoverageCut.value.x).toBe(1);
  });

  it('bakes a splat tile as the mask its GPU twin draws (vs roundedUnionMask)', () => {
    const t = makeCut();
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, ...lone }], FEATHER);
    expect(t.field.tick()).toBe(true);
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    let worst = 0;
    for (let k = 0; k < 400; k++) {
      const u = ((k * 37) % 100) / 100;
      const v = ((k * 61) % 100) / 100;
      const want = roundedUnionMask(u, v, NO_NEIGHBOURS, 1, FEATHER);
      const got = t.field.cutoutAt(r.xMin + u * (r.xMax - r.xMin), r.zMax - v * (r.zMax - r.zMin));
      worst = Math.max(worst, Math.abs(got - want));
    }
    // A z16 tile gets ~8 texels across a 512² field: the round outline is
    // reconstructed to within a fraction of the feather band.
    expect(worst).toBeLessThan(0.12);
    // …and exactly at rest where it matters: deep inside 1, well outside 0.
    const cx = (r.xMin + r.xMax) / 2;
    const cz = (r.zMin + r.zMax) / 2;
    expect(t.field.cutoutAt(cx, cz)).toBe(1);
    expect(t.field.cutoutAt(r.xMin + 0.02 * (r.xMax - r.xMin), r.zMin + 0.02 * (r.zMax - r.zMin))).toBe(0); // round corner
    expect(t.field.cutoutAt(r.xMax + (r.xMax - r.xMin), cz)).toBe(0);
  });

  it('the vector mask is the exact COMPLEMENT of the cut: reveal · (1 − cut)', () => {
    const t = makeCut();
    // The whole basemap window revealed, one splat tile landed in the middle.
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) t.field.addTile(Z, C.x + dx, C.y + dy);
    t.settle();
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, ...lone }], FEATHER);
    t.field.tick();
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    const cz = (r.zMin + r.zMax) / 2;
    const size = r.xMax - r.xMin;
    let ramp = 0;
    for (let k = 0; k <= 60; k++) {
      // Walk east across the rim of the disc (radius half a tile).
      const x = (r.xMin + r.xMax) / 2 + (0.38 + (k / 60) * 0.16) * size;
      const cut = t.field.cutoutAt(x, cz);
      const vec = t.field.coverageAt(x, cz);
      expect(vec + cut).toBeCloseTo(1, 12); // no gap, no doubly-covered band
      if (cut > 0.02 && cut < 0.98) ramp++;
    }
    expect(ramp).toBeGreaterThan(3); // a soft edge, not a step
    // Cut labels too? Only a mode flag — the field is the same.
    t.field.setCutoutMode(2);
    expect(t.uniforms.uCoverageCut.value.x).toBe(2);
  });

  it('joins neighbouring splat tiles seamlessly and takes the max over two LEVELS', () => {
    const t = makeCut();
    const pres = new Map<string, UnionPresence>();
    for (const [x, y] of [[S.x, S.y], [S.x + 1, S.y]]) pres.set(`${x}/${y}`, { x, y, inMs: -Infinity, outMs: null });
    const at = (x: number, y: number): UnionPresence | undefined => pres.get(`${x}/${y}`);
    const a = settled(at, S.x, S.y);
    const b = settled(at, S.x + 1, S.y);
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, ...a }, { z: SZ, x: S.x + 1, y: S.y, ...b }], FEATHER);
    t.field.tick();
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    const cz = (r.zMin + r.zMax) / 2;
    // The shared side of the pill is fully inside…
    for (const f of [0.9, 0.97, 1.0, 1.03, 1.1]) expect(t.field.cutoutAt(r.xMin + f * (r.xMax - r.xMin), cz)).toBe(1);
    // …and a coarser tile of a level transition adds its own ground (max).
    const parent = { x: S.x >> 1, y: S.y >> 1 };
    const far = tileWorldRect(t.projection, SZ - 1, parent.x, parent.y);
    // The quarter of the parent diagonally opposite the two z16 tiles.
    const px = S.x % 2 === 0 ? far.xMax - 0.3 * (far.xMax - far.xMin) : far.xMin + 0.3 * (far.xMax - far.xMin);
    const pz = S.y % 2 === 0 ? far.zMax - 0.3 * (far.zMax - far.zMin) : far.zMin + 0.3 * (far.zMax - far.zMin);
    expect(t.field.cutoutAt(px, pz)).toBe(0);
    const p = settled(() => undefined, parent.x, parent.y);
    t.field.setCutout(
      [{ z: SZ, x: S.x, y: S.y, ...a }, { z: SZ, x: S.x + 1, y: S.y, ...b }, { z: SZ - 1, x: parent.x, y: parent.y, ...p }],
      FEATHER
    );
    t.field.tick();
    expect(t.field.cutoutAt(px, pz)).toBe(1);
    expect(t.field.cutoutAt(r.xMin + 0.5 * (r.xMax - r.xMin), cz)).toBe(1); // still cut under the fine tiles
  });

  it('level dissolve: a fading tile cuts only as far as its fade; the max over levels keeps covered ground cut', () => {
    const t = makeCut();
    const parent = { x: S.x >> 1, y: S.y >> 1 };
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    const cx = (r.xMin + r.xMax) / 2;
    const cz = (r.zMin + r.zMax) / 2;
    const far = tileWorldRect(t.projection, SZ - 1, parent.x, parent.y);
    // A point of the parent well inside its circle but outside the z16 tile's.
    const px = (far.xMin + far.xMax) / 2 + (S.x % 2 === 0 ? 0.15 : -0.15) * (far.xMax - far.xMin);
    const pz = (far.zMin + far.zMax) / 2 + (S.y % 2 === 0 ? 0.15 : -0.15) * (far.zMax - far.zMin);
    const p = settled(() => undefined, parent.x, parent.y);
    for (const fade of [0, 0.25, 0.5, 0.75, 1]) {
      t.field.setCutout(
        [{ z: SZ, x: S.x, y: S.y, ...lone }, { z: SZ - 1, x: parent.x, y: parent.y, ...p, fade }],
        FEATHER
      );
      t.field.tick();
      // Under the (whole) z16 tile the basemap never comes back …
      expect(t.field.cutoutAt(cx, cz)).toBe(1);
      // … on the parent's NEW ground it fades out as the imagery fades in.
      expect(t.field.cutoutAt(px, pz)).toBeCloseTo(fade, 1);
    }
    // `fade` omitted = 1 (every pre-existing caller).
    t.field.setCutout([{ z: SZ - 1, x: parent.x, y: parent.y, ...p }], FEATHER);
    t.field.tick();
    expect(t.field.cutoutAt(px, pz)).toBe(1);
  });

  it('follows a growing tile and the ripple front, like the imagery alpha', () => {
    const t = makeCut();
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    const size = r.xMax - r.xMin;
    const cx = (r.xMin + r.xMax) / 2;
    const cz = (r.zMin + r.zMax) / 2;
    // Half grown: a disc of radius 0.25 tiles.
    const half = new Float64Array(16);
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, g: 0.5, values: half }], FEATHER);
    t.field.tick();
    expect(t.field.cutoutAt(cx, cz)).toBe(1);
    expect(t.field.cutoutAt(cx + 0.4 * size, cz)).toBe(0);
    // Fully grown, but the ripple front (origin = tile centre) is only 100 m out.
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, ...lone }], FEATHER);
    t.field.setCutoutRipple(true, cx, cz, 100, 40);
    t.field.tick();
    expect(t.field.cutoutAt(cx + 30, cz)).toBe(1); // behind the band
    expect(t.field.cutoutAt(cx + 80, cz)).toBeCloseTo(smooth01((100 - 80) / 40), 6);
    expect(t.field.cutoutAt(cx + 120, cz)).toBe(0); // the front has not got there
    expect(t.field.coverageAt(cx + 120, cz)).toBe(t.field.coverageAt(cx + 5 * size, cz)); // basemap still whole
    t.field.setCutoutRipple(false);
    expect(t.field.cutoutAt(cx + 120, cz)).toBe(1);
  });

  it('a plain square tile (rounded union off) cuts its square, no more', () => {
    const t = makeCut();
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, g: 1 }], FEATHER);
    t.field.tick();
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    const size = r.xMax - r.xMin;
    expect(t.field.cutoutAt(r.xMin + 0.1 * size, r.zMin + 0.1 * size)).toBe(1); // corners are not rounded
    expect(t.field.cutoutAt(r.xMin - 0.2 * size, r.zMin + 0.5 * size)).toBe(0);
  });

  it('works with the tile reveal switched OFF (the chunk then only cuts)', () => {
    const t = makeCut(false);
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, ...lone }], FEATHER);
    expect(t.field.tick()).toBe(true);
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    const cx = (r.xMin + r.xMax) / 2;
    const cz = (r.zMin + r.zMax) / 2;
    expect(t.uniforms.uCoverageParams.value.x).toBe(0);
    expect(t.field.coverageAt(cx, cz)).toBe(0); // under the satellite
    expect(t.field.coverageAt(cx + 3 * (r.xMax - r.xMin), cz)).toBe(1); // everywhere else, untouched
    // The cut survives a reveal toggle (the window is re-anchored and re-baked).
    t.field.setEnabled(true);
    t.field.tick();
    expect(t.field.cutoutAt(cx, cz)).toBe(1);
  });

  it('is cheap: G is re-baked only when the pushed tiles change or the window moves, never R', () => {
    const t = makeCut();
    t.field.addTile(Z, C.x, C.y);
    t.settle();
    const bakes = t.field.bakeCount;
    const cuts = t.field.cutBakeCount;
    expect(t.field.tick()).toBe(false); // idle: nothing at all
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, ...lone }], FEATHER);
    expect(t.field.active).toBe(true);
    expect(t.field.tick()).toBe(true);
    expect(t.field.cutBakeCount).toBe(cuts + 1);
    expect(t.field.bakeCount).toBe(bakes + 1); // one upload…
    const { texelsPerTile: p } = t.field.layoutInfo;
    expect(t.field.signedAtTexel(7 * p + (p >> 1), 7 * p + (p >> 1))).toBeGreaterThan(2 * FEATHER); // …R intact
    for (let k = 0; k < 5; k++) { t.advance(16); expect(t.field.tick()).toBe(false); }
    expect(t.field.cutBakeCount).toBe(cuts + 1);
    // The window moves one basemap tile east: G is re-baked in the new frame.
    const r = tileWorldRect(t.projection, SZ, S.x, S.y);
    t.field.setCentre(Z, C.x + 1, C.y);
    expect(t.field.tick()).toBe(true);
    expect(t.field.cutBakeCount).toBe(cuts + 2);
    expect(t.field.cutoutAt((r.xMin + r.xMax) / 2, (r.zMin + r.zMax) / 2)).toBe(1);
    // Emptied: the basemap is whole again, and mode 0 stops the baking.
    t.field.setCutout([], FEATHER);
    t.field.setCutoutMode(0);
    t.field.tick();
    expect(t.field.cutoutAt((r.xMin + r.xMax) / 2, (r.zMin + r.zMax) / 2)).toBe(0);
    expect(t.uniforms.uCoverageCut.value.x).toBe(0);
  });

  it('the shader chunk carries both channels and the label entry point', () => {
    const cov = createCoverageUniforms();
    const basic = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader
    };
    patchCoverage(basic, cov, 'labelAlpha');
    expect(basic.fragmentShader).toContain('gl_FragColor.a *= hbdCoverageLabel(vHbdCoverXZ);');
    expect(basic.fragmentShader).toContain('texture2D(uCoverageTex, uv).rg'); // one fetch, two channels
    expect(basic.fragmentShader).toContain('c *= 1.0 - k;'); // the complement
    expect(basic.uniforms.uCoverageCut).toBe(cov.uCoverageCut);
    expect(basic.uniforms.uCoverageRipple).toBe(cov.uCoverageRipple);
    expect((cov.uCoverageTex.value as THREE.DataTexture).format).toBe(THREE.RGFormat);
  });
});

// ---------------------------------------------------------------------------
// Under the splat overlay: an instant reveal, and a cut-out pass of its own
// ---------------------------------------------------------------------------

describe('CoverageField under the splat overlay', () => {
  const SZ = 16;
  const S = lonLatToTile(LON, LAT, SZ);
  const settled = (at: (x: number, y: number) => UnionPresence | undefined, x: number, y: number) => {
    const out = new Float64Array(16);
    const g = unionTileValues({ x, y, inMs: -Infinity, outMs: null }, at, 0, 0, out);
    return { g, values: out };
  };
  const lone = settled(() => undefined, S.x, S.y);
  const centre = (p: Projection, z: number, x: number, y: number): [number, number] => {
    const r = tileWorldRect(p, z, x, y);
    return [(r.xMin + r.xMax) / 2, (r.zMin + r.zMax) / 2];
  };
  function makeCut(radius = 7) {
    const t = make(true, radius);
    t.field.setCutoutReserved(true);
    t.field.setCutoutMode(1);
    t.field.setCentre(Z, C.x, C.y);
    return t;
  }

  it('setInstant: tiles land at full size and leave at once; growth resumes when it lifts', () => {
    const t = make(true);
    t.field.setInstant(true);
    t.field.addTile(Z, C.x, C.y);
    expect(t.field.tick()).toBe(true);      // one bake…
    expect(t.field.active).toBe(false);     // …and nothing animating
    expect(t.field.coverageAt(...centre(t.projection, Z, C.x, C.y))).toBeCloseTo(1, 1);
    t.advance(16);
    expect(t.field.tick()).toBe(false);
    t.field.removeTile(Z, C.x, C.y);
    expect(t.field.tileCount).toBe(0);      // gone, no leaving ghost to animate
    t.field.tick();
    expect(t.field.active).toBe(false);
    t.field.setInstant(false);
    t.field.addTile(Z, C.x + 1, C.y);
    expect(t.field.tick()).toBe(true);
    expect(t.field.active).toBe(true);      // growing again, as configured
  });

  it('setInstant mid-animation snaps what is growing to full size and drops what is leaving', () => {
    const t = make(true);
    t.field.addTile(Z, C.x, C.y);
    t.field.tick();
    t.field.addTile(Z, C.x + 1, C.y);
    t.field.tick();
    t.field.removeTile(Z, C.x + 1, C.y);
    t.field.tick();
    expect(t.field.active).toBe(true);
    t.field.setInstant(true);
    expect(t.field.tick()).toBe(true);
    expect(t.field.active).toBe(false);
    expect(t.field.tileCount).toBe(1);
    expect(t.field.coverageAt(...centre(t.projection, Z, C.x, C.y))).toBeCloseTo(1, 1);
    expect(t.field.coverageAt(...centre(t.projection, Z, C.x + 1, C.y))).toBe(0);
  });

  it('tickCutout bakes a freshly pushed cut-out and never advances the reveal', () => {
    const t = makeCut();
    t.field.addTile(Z, C.x, C.y);
    expect(t.field.tick()).toBe(true);       // the reveal starts growing
    expect(t.field.active).toBe(true);
    expect(t.field.tickCutout()).toBe(false); // nothing pushed since: nothing to bake
    t.field.setCutout([{ z: SZ, x: S.x, y: S.y, ...lone }], FEATHER);
    expect(t.field.tickCutout()).toBe(true);
    expect(t.field.cutoutAt(...centre(t.projection, SZ, S.x, S.y))).toBe(1);
    expect(t.field.tickCutout()).toBe(false); // clean again
    expect(t.field.active).toBe(true);        // the growing tile was left to the full tick
    t.field.setCutout([], FEATHER);
    expect(t.field.tickCutout()).toBe(true);
    expect(t.field.cutoutAt(...centre(t.projection, SZ, S.x, S.y))).toBe(0);
  });
});
