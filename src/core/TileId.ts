import { EARTH_CIRCUMFERENCE_M } from './Projection.js';

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export interface TileBoundsLonLat {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const MAX_LAT = 85.0511287798;

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

export function parseTileKey(key: string): TileId {
  const [z, x, y] = key.split('/').map(Number);
  return { z, x, y };
}

export function lonLatToTile(lon: number, lat: number, z: number): TileId {
  const n = 2 ** z;
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = clampedLat * DEG;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x: clampInt(x, 0, n - 1), y: clampInt(y, 0, n - 1) };
}

/**
 * Like `lonLatToTile` but returns FRACTIONAL, unfloored, unclamped tile
 * coordinates. Used to project the camera frustum's ground footprint into
 * tile space precisely — flooring would collapse the trapezoid's corners
 * onto integer tiles and lose the sub-tile precision a point-in-quad test
 * needs.
 */
export function lonLatToTileFractional(
  lon: number,
  lat: number,
  z: number
): { x: number; y: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = ((lon + 180) / 360) * n;
  const latRad = clampedLat * DEG;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileToLonLat(z: number, x: number, y: number): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: latRad * RAD };
}

export function tileBounds(z: number, x: number, y: number): TileBoundsLonLat {
  const nw = tileToLonLat(z, x, y);
  const se = tileToLonLat(z, x + 1, y + 1);
  return {
    minLon: nw.lon,
    minLat: se.lat,
    maxLon: se.lon,
    maxLat: nw.lat
  };
}

/** Approximate tile edge length in meters at the tile's center latitude. */
export function tileSizeMeters(z: number, y: number): number {
  const lat = tileToLonLat(z, 0, y + 0.5).lat;
  return (EARTH_CIRCUMFERENCE_M * Math.cos(lat * DEG)) / 2 ** z;
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value | 0));
}
