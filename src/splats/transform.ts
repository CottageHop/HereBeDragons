/**
 * Placement maths for one splat tile in the HereBeDragons scene. Pure — no
 * THREE, no DOM — so it can be unit-tested and reused by tooling.
 *
 * Splat tiles (see SplatMap's `splat/tiler.py`) are authored in a TILE-LOCAL
 * frame: origin at the tile's south-west corner, x = east, y = north, z = up,
 * every axis in Web-Mercator metres (heights are pre-multiplied by
 * 1 / cos(lat_tile) so the frame is isotropic).
 *
 * The HereBeDragons scene (see `core/Projection.ts`) is Web-Mercator metres
 * DIVIDED by sec(originLat) — so 1 unit ≈ 1 true metre near the map origin —
 * with scene X = east, scene Y = up, scene Z = −mercatorY (south is +Z).
 *
 * So a tile is placed as one Object3D at its SW corner with
 *
 *   rotation.x = −π/2      (tile z_up → scene +Y, tile y_north → scene −Z)
 *   scale      = cos(originLat)   (mercator metres → scene units, uniform)
 *
 * and Spark loads the file's coordinates verbatim underneath it.
 */

import { EARTH_CIRCUMFERENCE_M, buildTileToWorld } from '../tiles/worker/extractors/shared/mercator.js';

export interface SplatTileTransform {
  /** Scene position of the tile's SW corner (`[x, y, z]`, y = 0 = ground). */
  position: [number, number, number];
  /** Uniform scale applied to the tile's mercator-metre coordinates. */
  scale: number;
  /** Rotation about scene X that maps the z-up tile frame onto Y-up. */
  rotationX: number;
  /** Tile edge length in scene units (mercator size × scale). */
  sizeScene: number;
}

/**
 * Compute where tile `z/x/y` sits in a scene whose projection origin is
 * `(originLat, originLon)`.
 */
export function splatTileTransform(
  z: number,
  x: number,
  y: number,
  originLat: number,
  originLon: number
): SplatTileTransform {
  // extent = 1 → `worldOffsetX/Y` is the tile's NW corner in scene units.
  const t = buildTileToWorld(z, x, y, 1, originLat, originLon);
  const k = 1 / t.mercatorScale; // = cos(originLat)
  const tileMercator = EARTH_CIRCUMFERENCE_M / 2 ** z;
  const sizeScene = tileMercator * k;
  // SW corner = NW corner moved one tile south. Mercator north is scene −Z,
  // so moving south INCREASES scene Z: z = −(worldOffsetY − sizeScene).
  return {
    position: [t.worldOffsetX, 0, -(t.worldOffsetY - sizeScene)],
    scale: k,
    rotationX: -Math.PI / 2,
    sizeScene
  };
}

/**
 * Apply a tile transform to a tile-local point by hand (what the Object3D
 * hierarchy does on the GPU). Handy for tests and debugging.
 *
 *   scene = position + scale · R_x(−π/2) · local
 *         = (px + s·lx,  py + s·lz,  pz − s·ly)
 */
export function splatLocalToScene(
  t: SplatTileTransform,
  lx: number,
  ly: number,
  lz: number
): [number, number, number] {
  const s = t.scale;
  return [t.position[0] + s * lx, t.position[1] + s * lz, t.position[2] - s * ly];
}

/**
 * Enumerate the square tile window of Chebyshev radius `radius` around
 * `(centerX, centerY)` at zoom `z`, clamped to the pyramid, ordered
 * nearest-first (so the tile under the camera streams before the corners).
 * Returns `[x, y]` pairs.
 */
export function enumerateTileWindow(
  z: number,
  centerX: number,
  centerY: number,
  radius: number
): Array<[number, number]> {
  const n = 2 ** z;
  const out: { x: number; y: number; d: number }[] = [];
  for (let x = centerX - radius; x <= centerX + radius; x++) {
    for (let y = centerY - radius; y <= centerY + radius; y++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const dx = x - centerX;
      const dy = y - centerY;
      out.push({ x, y, d: dx * dx + dy * dy });
    }
  }
  out.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return out.map((c) => [c.x, c.y]);
}

/** Expand a `{z}/{x}/{y}` URL template. */
export function expandTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y));
}
