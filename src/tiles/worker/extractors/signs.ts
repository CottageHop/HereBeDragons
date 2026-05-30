import { VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

/**
 * Sparse Japanese shop-sign banners. There's no "shop sign" feature in the
 * data, so we place them ourselves — but SPARSELY: only a small fraction of
 * buildings get one, capped per tile, so they read as the occasional storefront
 * banner (like the reference's single ramen shop) rather than spamming every
 * roof in a financial district. Each sign is a ground point pushed just in
 * front of a building (away from its centroid, toward its longest edge); the
 * {@link SignsLayer} grows it into an upright nobori banner billboard and picks
 * one of a few Japanese words by the per-sign `variant`.
 */
const BUILDING_LAYER_NAMES = ['buildings', 'osm_buildings'];

/**
 * Hard cap on candidate banners emitted per tile. We over-emit (vs. what shows
 * by default) and tag each with a stable `rank` ∈ [0,1] so the SignsLayer can
 * thin them at render time via a runtime density knob — tunable up or down
 * without re-decoding the tile. The default density shows roughly the original
 * ~half of these.
 */
const MAX_SIGNS_PER_TILE = 30;
/** Fraction of buildings that earn a candidate banner. */
const SIGN_FRACTION = 0.2;
/** How far (m) to push the banner out in front of the wall. */
const SIGN_OFFSET_M = 2.5;
/** Number of distinct banner words (must match the SignsLayer texture atlas). */
const SIGN_VARIANTS = 4;

function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h % 10000) / 10000;
}

export function extractSigns(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const xs: number[] = [];
  const zs: number[] = [];
  const variants: number[] = [];
  const ranks: number[] = [];

  for (const name of BUILDING_LAYER_NAMES) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    for (let i = 0; i < layer.length && xs.length < MAX_SIGNS_PER_TILE; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('Polygon')) continue;
      if (hash(i + 1, tx * 31 + ty) > SIGN_FRACTION) continue;

      const rings = f.loadGeometry();
      if (rings.length === 0 || rings[0].length < 3) continue;
      const ring = rings[0];

      // Centroid + longest-edge midpoint, in world meters.
      let cx = 0, cz = 0, count = 0;
      const last = ring.length - 1;
      const closed = ring[0].x === ring[last].x && ring[0].y === ring[last].y;
      const limit = closed ? last : ring.length;
      for (let k = 0; k < limit; k++) {
        cx += t.worldOffsetX + ring[k].x * t.scalePerExtentX;
        cz += -(t.worldOffsetY - ring[k].y * t.scalePerExtentY);
        count++;
      }
      if (count < 3) continue;
      cx /= count;
      cz /= count;

      let bestLen = -1, mx = cx, mz = cz;
      for (let k = 0; k < limit; k++) {
        const ax = t.worldOffsetX + ring[k].x * t.scalePerExtentX;
        const az = -(t.worldOffsetY - ring[k].y * t.scalePerExtentY);
        const bn = ring[(k + 1) % limit];
        const bx = t.worldOffsetX + bn.x * t.scalePerExtentX;
        const bz = -(t.worldOffsetY - bn.y * t.scalePerExtentY);
        const len = Math.hypot(bx - ax, bz - az);
        if (len > bestLen) { bestLen = len; mx = (ax + bx) * 0.5; mz = (az + bz) * 0.5; }
      }
      // Push the banner outward (from centroid through the edge midpoint) so it
      // stands in front of the building rather than inside it.
      const dx = mx - cx, dz = mz - cz;
      const dl = Math.hypot(dx, dz) || 1;
      xs.push(mx + (dx / dl) * SIGN_OFFSET_M);
      zs.push(mz + (dz / dl) * SIGN_OFFSET_M);
      variants.push(Math.floor(hash(i + 7, tx + ty) * SIGN_VARIANTS) % SIGN_VARIANTS);
      ranks.push(hash(i + 3, tx * 7 + ty)); // stable [0,1] for the density cull
    }
  }

  const n = xs.length;
  if (n === 0) return null;
  const positions = new Float32Array(n * 3);
  const variant = new Float32Array(n);
  const rank = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    positions[i * 3 + 0] = xs[i];
    positions[i * 3 + 1] = 0; // base on the ground; the billboard grows up
    positions[i * 3 + 2] = zs[i];
    variant[i] = variants[i];
    rank[i] = ranks[i];
  }
  return { positions, indices: new Uint32Array(0), attributes: { variant, rank } };
}
