/**
 * Mercator projection scaled so that 1 unit ≈ 1 meter near the world origin.
 *
 * Implementation: global Web Mercator in meters, divided by the secant of the
 * origin's latitude. This gives a locally-isotropic meters-scale frame within
 * ~hundreds of kilometers of the origin. Beyond that, rebase() shifts the
 * origin and the caller translates live tile groups by the inverse delta to
 * stay in float32-safe territory.
 *
 * Scene convention: Mercator X → scene X (east+), Mercator Y → scene Z (south+).
 * Y is up. Building heights extrude along +Y.
 */

export const EARTH_RADIUS_M = 6378137;
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;

export interface MercatorMeters {
  x: number;
  y: number;
}

export interface LonLat {
  lon: number;
  lat: number;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const MAX_LAT = 85.0511287798;

function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export function lonLatToGlobalMercator(lon: number, lat: number): MercatorMeters {
  const x = EARTH_RADIUS_M * lon * DEG;
  const y = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + clampLat(lat) * DEG / 2));
  return { x, y };
}

export function globalMercatorToLonLat(x: number, y: number): LonLat {
  const lon = (x / EARTH_RADIUS_M) * RAD;
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * RAD;
  return { lon, lat };
}

export class Projection {
  private originLat: number;
  private originLon: number;
  private originGlobal: MercatorMeters;
  /** 1 / cos(originLat) — Mercator stretch factor at origin latitude. */
  private mercatorScale: number;

  constructor(lat: number, lon: number) {
    this.originLat = lat;
    this.originLon = lon;
    this.originGlobal = lonLatToGlobalMercator(lon, lat);
    this.mercatorScale = 1 / Math.cos(clampLat(lat) * DEG);
  }

  get origin(): LonLat {
    return { lat: this.originLat, lon: this.originLon };
  }

  /** Returns meters east/north of origin (E = +X, N = +Y_mercator). */
  project(lon: number, lat: number): MercatorMeters {
    const g = lonLatToGlobalMercator(lon, lat);
    return {
      x: (g.x - this.originGlobal.x) / this.mercatorScale,
      y: (g.y - this.originGlobal.y) / this.mercatorScale
    };
  }

  unproject(x: number, y: number): LonLat {
    const gx = x * this.mercatorScale + this.originGlobal.x;
    const gy = y * this.mercatorScale + this.originGlobal.y;
    return globalMercatorToLonLat(gx, gy);
  }

  /**
   * Move the origin to a new lon/lat. Returns the delta in world-meters that
   * existing geometry must be translated by to preserve its visual position.
   *
   * Example: const delta = projection.rebase(newLat, newLon);
   *          tilesRoot.position.x -= delta.x;
   *          tilesRoot.position.z -= delta.y; (Y is up, Z is mercator-south)
   */
  rebase(lat: number, lon: number): MercatorMeters {
    const newGlobal = lonLatToGlobalMercator(lon, lat);
    const newScale = 1 / Math.cos(clampLat(lat) * DEG);

    const blendedScale = (this.mercatorScale + newScale) / 2;
    const delta: MercatorMeters = {
      x: (newGlobal.x - this.originGlobal.x) / blendedScale,
      y: (newGlobal.y - this.originGlobal.y) / blendedScale
    };

    this.originLat = lat;
    this.originLon = lon;
    this.originGlobal = newGlobal;
    this.mercatorScale = newScale;
    return delta;
  }

  /** Approximate meters-per-pixel at the given zoom level (Mercator standard). */
  static metersPerPixel(lat: number, zoom: number): number {
    return (EARTH_CIRCUMFERENCE_M * Math.cos(clampLat(lat) * DEG)) / (256 * 2 ** zoom);
  }
}
