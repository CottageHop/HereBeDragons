import { describe, it, expect } from 'vitest';
import { lonLatToTile, tileToLonLat, tileBounds, tileSizeMeters, tileKey, parseTileKey } from '../src/core/TileId.js';

describe('TileId', () => {
  it('produces a valid tile for SF coordinates at z=15', () => {
    const t = lonLatToTile(-122.4194, 37.7749, 15);
    expect(t.z).toBe(15);
    // At z=15 the world is 32768x32768 tiles; SF is in the western US.
    expect(t.x).toBeGreaterThan(5000);
    expect(t.x).toBeLessThan(5500);
    expect(t.y).toBeGreaterThan(12000);
    expect(t.y).toBeLessThan(13000);
  });

  it('round-trips a tile id through lon/lat', () => {
    const t = lonLatToTile(-122.4194, 37.7749, 15);
    const ll = tileToLonLat(t.z, t.x, t.y);
    const back = lonLatToTile(ll.lon, ll.lat, 15);
    expect(back.x).toBe(t.x);
    expect(back.y).toBe(t.y);
  });

  it('tileBounds wraps the lon/lat used to derive the tile', () => {
    const lon = -122.4194;
    const lat = 37.7749;
    const t = lonLatToTile(lon, lat, 15);
    const b = tileBounds(t.z, t.x, t.y);
    expect(b.minLat).toBeLessThanOrEqual(lat);
    expect(b.maxLat).toBeGreaterThan(lat);
    expect(b.minLon).toBeLessThanOrEqual(lon);
    expect(b.maxLon).toBeGreaterThan(lon);
  });

  it('tileSizeMeters is ~1 km at z=15 near 37.8 N', () => {
    const t = lonLatToTile(-122.4194, 37.7749, 15);
    const m = tileSizeMeters(15, t.y);
    expect(m).toBeGreaterThan(800);
    expect(m).toBeLessThan(1500);
  });

  it('tileKey + parseTileKey round-trip', () => {
    const k = tileKey(15, 5241, 12666);
    const t = parseTileKey(k);
    expect(t).toEqual({ z: 15, x: 5241, y: 12666 });
  });
});
