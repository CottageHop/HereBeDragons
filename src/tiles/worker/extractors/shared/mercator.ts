/**
 * Tile-local MVT coordinates -> world meters relative to a projection origin.
 *
 * This is a self-contained Mercator implementation (no THREE, no @types/three)
 * so it can be imported inside Web Workers.
 */

export const EARTH_RADIUS_M = 6378137;
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;
const MAX_LAT = 85.0511287798;
const DEG = Math.PI / 180;

function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export interface TileToWorld {
  /** Tile size in fractional global mercator (1/2^z). */
  tileFracSize: number;
  /** Tile origin in global mercator meters (top-left corner). */
  originGlobalX: number;
  originGlobalY: number;
  /** Mercator stretch factor at the projection origin's latitude. */
  mercatorScale: number;
  /** Per-MVT-unit scale: (1 / extent) * tileFracSize * EARTH_CIRCUMFERENCE / mercatorScale. */
  scalePerExtentX: number;
  scalePerExtentY: number;
  /** World-meter offset of the tile's NW corner from the projection origin. */
  worldOffsetX: number;
  worldOffsetY: number;
}

/**
 * Precompute the linear transform from MVT-local coords to world meters.
 *
 * For an MVT vertex (mx, my) in [0..extent], world meters relative to origin are:
 *   worldX = worldOffsetX + mx * scalePerExtentX
 *   worldY = worldOffsetY - my * scalePerExtentY   (mvt y goes down, mercator y goes up)
 */
export function buildTileToWorld(
  z: number,
  x: number,
  y: number,
  extent: number,
  originLat: number,
  originLon: number
): TileToWorld {
  const tileFracSize = 1 / 2 ** z;

  // Global mercator meters of the tile's NW corner (top-left in MVT space).
  const u0 = x / 2 ** z;
  const v0 = y / 2 ** z;
  const originGlobalTileX = (u0 - 0.5) * EARTH_CIRCUMFERENCE_M;
  const originGlobalTileY = (0.5 - v0) * EARTH_CIRCUMFERENCE_M;

  const originGlobalX = EARTH_RADIUS_M * originLon * DEG;
  const originGlobalY = EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + clampLat(originLat) * DEG / 2));

  const mercatorScale = 1 / Math.cos(clampLat(originLat) * DEG);

  const tileMetersGlobal = EARTH_CIRCUMFERENCE_M * tileFracSize;
  const scalePerExtentX = tileMetersGlobal / extent / mercatorScale;
  const scalePerExtentY = tileMetersGlobal / extent / mercatorScale;

  const worldOffsetX = (originGlobalTileX - originGlobalX) / mercatorScale;
  const worldOffsetY = (originGlobalTileY - originGlobalY) / mercatorScale;

  return {
    tileFracSize,
    originGlobalX,
    originGlobalY,
    mercatorScale,
    scalePerExtentX,
    scalePerExtentY,
    worldOffsetX,
    worldOffsetY
  };
}

/** Project an MVT-local vertex into world meters relative to the projection origin. */
export function projectMvtVertex(t: TileToWorld, mx: number, my: number): { x: number; y: number } {
  return {
    x: t.worldOffsetX + mx * t.scalePerExtentX,
    y: t.worldOffsetY - my * t.scalePerExtentY
  };
}
