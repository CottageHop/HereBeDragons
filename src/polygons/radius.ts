import type { PolygonPoint } from './types.js';

/** WGS84 mean Earth radius in metres. */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Approximate a geodesic circle around a (lat, lon) centre as a polygon of
 * `segments` evenly-spaced vertices. Drop straight into `map.addPolygon`:
 *
 * @example
 *   import { makeRadiusPolygon } from '@cottagehop/here-be-dragons';
 *   map.addPolygon({
 *     id: 'comp-radius',
 *     color: '#3b82f6',
 *     opacity: 0.20,
 *     points: makeRadiusPolygon(subject.lat, subject.lon, 800)  // 800 m
 *   });
 *
 * Real-estate flows lean on this constantly: a comparables radius around a
 * subject property, a walkability buffer, a service area, a school zone, a
 * 1-mile flood plain rim. Uses the spherical destination-point formula —
 * accurate to sub-metre for radii well past anything useful on a city map.
 */
export function makeRadiusPolygon(
  centerLat: number,
  centerLon: number,
  radiusMeters: number,
  segments: number = 64
): PolygonPoint[] {
  const points: PolygonPoint[] = [];
  const angDist = Math.max(0, radiusMeters) / EARTH_RADIUS_M;
  const latRad = (centerLat * Math.PI) / 180;
  const lonRad = (centerLon * Math.PI) / 180;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinAng = Math.sin(angDist);
  const cosAng = Math.cos(angDist);
  const n = Math.max(3, Math.floor(segments));
  for (let i = 0; i < n; i++) {
    const bearing = (i / n) * Math.PI * 2;
    const sinLat2 = sinLat * cosAng + cosLat * sinAng * Math.cos(bearing);
    const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
    const y = Math.sin(bearing) * sinAng * cosLat;
    const x = cosAng - sinLat * sinLat2;
    const lon2 = lonRad + Math.atan2(y, x);
    points.push({
      lat: (lat2 * 180) / Math.PI,
      // Wrap longitude into [-180, 180] (atan2 already returns in [-π, π]).
      lon: ((lon2 * 180) / Math.PI + 540) % 360 - 180
    });
  }
  return points;
}
