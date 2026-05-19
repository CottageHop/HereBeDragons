import { describe, it, expect } from 'vitest';
import { Projection, lonLatToGlobalMercator, globalMercatorToLonLat } from '../src/core/Projection.js';

describe('Projection', () => {
  it('round-trips lon/lat through global mercator', () => {
    const cases: Array<[number, number]> = [
      [-122.4194, 37.7749], // SF
      [-74.006, 40.7128], // NYC
      [0, 0],
      [139.6917, 35.6895] // Tokyo
    ];
    for (const [lon, lat] of cases) {
      const m = lonLatToGlobalMercator(lon, lat);
      const r = globalMercatorToLonLat(m.x, m.y);
      expect(r.lon).toBeCloseTo(lon, 6);
      expect(r.lat).toBeCloseTo(lat, 6);
    }
  });

  it('places origin at world (0, 0)', () => {
    const p = new Projection(37.7749, -122.4194);
    const o = p.project(-122.4194, 37.7749);
    expect(o.x).toBeCloseTo(0, 6);
    expect(o.y).toBeCloseTo(0, 6);
  });

  it('produces ~111km per degree of longitude at equator', () => {
    const p = new Projection(0, 0);
    const onedeg = p.project(1, 0);
    // At the equator, 1 degree of longitude ≈ 111,320 m. Allow 1% tolerance.
    expect(onedeg.x).toBeGreaterThan(110_000);
    expect(onedeg.x).toBeLessThan(112_500);
    expect(Math.abs(onedeg.y)).toBeLessThan(1);
  });

  it('rebase shifts origin and reports the meter delta', () => {
    const p = new Projection(37.7749, -122.4194);
    // Project a downtown point (a small offset east-north).
    const before = p.project(-122.41, 37.78);
    const delta = p.rebase(37.78, -122.41);
    // After rebase, the same lon/lat should be ~origin (0, 0).
    const after = p.project(-122.41, 37.78);
    expect(after.x).toBeCloseTo(0, 4);
    expect(after.y).toBeCloseTo(0, 4);
    // Delta magnitude roughly matches the "before" distance.
    const beforeDist = Math.hypot(before.x, before.y);
    const deltaDist = Math.hypot(delta.x, delta.y);
    expect(deltaDist).toBeCloseTo(beforeDist, -1); // within 10 m
  });

  it('round-trips project/unproject for a city offset', () => {
    const p = new Projection(37.7749, -122.4194);
    const lon = -122.39;
    const lat = 37.80;
    const m = p.project(lon, lat);
    const back = p.unproject(m.x, m.y);
    expect(back.lon).toBeCloseTo(lon, 5);
    expect(back.lat).toBeCloseTo(lat, 5);
  });
});
