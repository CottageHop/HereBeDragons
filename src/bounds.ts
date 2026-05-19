import type { BoundingBox } from './types.js';

/**
 * Common country and US-state bounding boxes for use with
 * `HereBeDragonsOptions.bounds`. Values are approximate, sourced from public
 * GIS bounding-box data, and rounded to 1 decimal so the table stays small.
 *
 * Countries that cross the antimeridian (e.g. Russia, New Zealand, Fiji) are
 * intentionally omitted — the inclusive `west <= east` model in `BoundingBox`
 * can't express them without a special-case.
 */
export const COMMON_BOUNDS: Record<string, BoundingBox> = {
  // Countries
  US:     { north: 49.4, south: 24.5, east:  -66.9, west: -125.0 }, // continental
  'US-ALL': { north: 71.5, south: 18.9, east: -66.9, west: -171.7 }, // incl. AK, HI
  CA:     { north: 83.1, south: 41.7, east:  -52.6, west: -141.0 },
  MX:     { north: 32.7, south: 14.5, east:  -86.7, west: -118.4 },
  BR:     { north:  5.3, south: -33.7, east: -34.8, west:  -74.0 },
  UK:     { north: 60.9, south: 49.9, east:    2.0, west:   -8.6 },
  IE:     { north: 55.4, south: 51.4, east:   -6.0, west:  -10.6 },
  FR:     { north: 51.1, south: 41.3, east:    9.6, west:   -5.1 },
  DE:     { north: 55.0, south: 47.3, east:   15.0, west:    5.9 },
  IT:     { north: 47.1, south: 36.6, east:   18.5, west:    6.6 },
  ES:     { north: 43.8, south: 27.6, east:    4.3, west:  -18.2 }, // incl Canaries
  PT:     { north: 42.2, south: 36.8, east:   -6.2, west:   -9.5 },
  NL:     { north: 53.6, south: 50.8, east:    7.2, west:    3.4 },
  CH:     { north: 47.8, south: 45.8, east:   10.5, west:    5.9 },
  AU:     { north: -10.7, south: -43.6, east: 153.6, west:  113.3 },
  JP:     { north: 45.6, south: 24.0, east:  145.8, west:  122.9 },
  KR:     { north: 38.6, south: 33.1, east:  129.6, west:  124.6 },
  CN:     { north: 53.6, south: 18.2, east:  134.8, west:   73.5 },
  IN:     { north: 35.5, south:  6.7, east:   97.4, west:   68.1 },
  ZA:     { north: -22.1, south: -34.8, east:  32.9, west:   16.3 },
  AR:     { north: -21.8, south: -55.1, east: -53.6, west:  -73.6 },
  EG:     { north: 31.7, south: 22.0, east:   36.9, west:   24.7 },

  // US states (sample — extend as needed)
  'US-CA': { north: 42.0, south: 32.5, east: -114.1, west: -124.4 },
  'US-NY': { north: 45.0, south: 40.5, east:  -71.8, west:  -79.8 },
  'US-TX': { north: 36.5, south: 25.8, east:  -93.5, west: -106.6 },
  'US-FL': { north: 31.0, south: 24.5, east:  -80.0, west:  -87.6 },
  'US-WA': { north: 49.0, south: 45.5, east: -116.9, west: -124.8 },
  'US-OR': { north: 46.3, south: 41.9, east: -116.5, west: -124.6 },
  'US-IL': { north: 42.5, south: 36.9, east:  -87.0, west:  -91.5 },
  'US-MA': { north: 42.9, south: 41.2, east:  -69.9, west:  -73.5 },
  'US-CO': { north: 41.0, south: 37.0, east: -102.0, west: -109.1 },
  'US-AZ': { north: 37.0, south: 31.3, east: -109.0, west: -114.8 },
  'US-NV': { north: 42.0, south: 35.0, east: -114.0, west: -120.0 },
  'US-PA': { north: 42.3, south: 39.7, east:  -74.7, west:  -80.5 },
  'US-OH': { north: 42.0, south: 38.4, east:  -80.5, west:  -84.8 },
  'US-MI': { north: 48.3, south: 41.7, east:  -82.4, west:  -90.4 },
  'US-GA': { north: 35.0, south: 30.4, east:  -80.8, west:  -85.6 },
  'US-NC': { north: 36.6, south: 33.8, east:  -75.5, west:  -84.3 }
};

/** Convenience aliases — feel free to add more for niche jurisdictions. */
export type CommonBoundsKey = keyof typeof COMMON_BOUNDS;
