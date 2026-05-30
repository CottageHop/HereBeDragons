import { describe, it, expect } from 'vitest';
import { makeRadiusPolygon } from '../src/polygons/radius.js';

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres (haversine). */
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

describe('makeRadiusPolygon', () => {
  it('returns the requested number of vertices', () => {
    expect(makeRadiusPolygon(40.7065, -74.009, 800).length).toBe(64);
    expect(makeRadiusPolygon(40.7065, -74.009, 800, 32).length).toBe(32);
  });

  it('every vertex sits within 1 m of the requested radius (mid-latitudes, 800 m)', () => {
    const lat = 40.7065, lon = -74.009;
    const r = 800;
    const pts = makeRadiusPolygon(lat, lon, r, 96);
    for (const p of pts) {
      const d = haversine(lat, lon, p.lat, p.lon);
      expect(Math.abs(d - r)).toBeLessThan(1);
    }
  });

  it('holds at a tropical latitude and at a much larger radius (10 km, equator)', () => {
    const lat = 0, lon = 0;
    const r = 10_000;
    for (const p of makeRadiusPolygon(lat, lon, r, 64)) {
      expect(Math.abs(haversine(lat, lon, p.lat, p.lon) - r)).toBeLessThan(2);
    }
  });

  it('clamps `segments` to a minimum of 3', () => {
    expect(makeRadiusPolygon(40, -74, 100, 1).length).toBe(3);
    expect(makeRadiusPolygon(40, -74, 100, 0).length).toBe(3);
  });

  it('wraps longitude across the antimeridian cleanly', () => {
    // Centre right on the antimeridian — every vertex should be in [-180, 180]
    // (a point exactly on the seam may report either -180 or 180; both are
    // the same physical longitude).
    for (const p of makeRadiusPolygon(0, 180, 1000, 24)) {
      expect(p.lon).toBeGreaterThanOrEqual(-180);
      expect(p.lon).toBeLessThanOrEqual(180);
    }
  });
});
