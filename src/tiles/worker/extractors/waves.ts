import { VectorTileFeature, type VectorTileLayer, classifyRings } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

/**
 * Shoreline foam. There's no source feature for "the coast" — it's the boundary
 * of the water polygons. So we walk each water ring and emit a ribbon
 * straddling every boundary edge, sloped from the water surface on the seaward
 * side UP to land level on the landward side. That beach slope bridges the 1 m
 * step between the water plane and the ground plane (instead of foam floating
 * above the water), and the {@link WavesLayer} animates white-capped waves
 * breaking up it. Two per-vertex coords drive the look: `shoreV` across the
 * ribbon (0 = seaward edge, 1 = landward edge; the real waterline sits mid-slope)
 * and `shoreU` along the coast (metres) for the rolling-swell phase.
 *
 * Tile-clip seams are skipped: where a water polygon is cut by the tile
 * boundary it makes straight edges along the tile border that are NOT real
 * coast — drawing foam there would put surf in the open ocean.
 */
const WATER_LAYER_NAMES = ['water', 'osm_natural_areas'];

/** Half-width of the foam ribbon in metres (so a ~12 m wet beach band). */
const SHORE_HALF_W = 6;
/**
 * Seaward edge height. The water plane is at y = -1 (see water.ts WATER_Y); we
 * sit the ramp's seaward edge a touch ABOVE it (0.25 m) so the foam wins the
 * depth test geometrically rather than relying on polygon-offset alone — on a
 * sloped ribbon the offset's slope term is uneven and the water was z-fighting
 * the seaward half away, slicing the band off at the waterline.
 */
const SHORE_WATER_Y = -0.75;
/** Landward edge height — just above the ground plane (y = 0), same idea. */
const SHORE_LAND_Y = 0.1;

interface Pt { x: number; z: number; }

export function extractWaves(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const shoreV: number[] = [];
  const shoreU: number[] = [];

  for (const name of WATER_LAYER_NAMES) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('Polygon')) continue;
      if (name === 'osm_natural_areas') {
        const kind = (f.properties.natural ?? f.properties.kind ?? '').toString();
        if (kind !== 'water' && kind !== 'bay' && kind !== '') continue;
      }

      const grouped = classifyRings(f.loadGeometry());
      for (const polygon of grouped) {
        // Project every ring to world coords once; keep the MVT rings for the
        // clip-seam test (which is in tile/extent space).
        const worldRings: Pt[][] = polygon.map((ring) =>
          ring.map((p) => ({
            x: t.worldOffsetX + p.x * t.scalePerExtentX,
            z: -(t.worldOffsetY - p.y * t.scalePerExtentY)
          }))
        );
        for (let r = 0; r < polygon.length; r++) {
          buildShoreRibbon(
            polygon[r], worldRings[r], worldRings, extent,
            positions, indices, normals, shoreV, shoreU
          );
        }
      }
    }
  }

  if (indices.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
    attributes: {
      shoreV: new Float32Array(shoreV),
      shoreU: new Float32Array(shoreU)
    }
  };
}

/** An edge running along a tile boundary is a clip seam, not real coast. */
function isClipSeam(
  ax: number, ay: number, bx: number, by: number, extent: number
): boolean {
  const lo = 1;
  const hi = extent - 1;
  return (
    (ax <= lo && bx <= lo) ||
    (ax >= hi && bx >= hi) ||
    (ay <= lo && by <= lo) ||
    (ay >= hi && by >= hi)
  );
}

/** Ray-cast point-in-ring on the world (x, z) plane. */
function pointInRing(x: number, z: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, zi = ring[i].z;
    const xj = ring[j].x, zj = ring[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the polygon's outer ring AND outside every hole = water. */
function pointInWater(x: number, z: number, rings: Pt[][]): boolean {
  if (!pointInRing(x, z, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(x, z, rings[h])) return false;
  }
  return true;
}

function buildShoreRibbon(
  mvtRing: Array<{ x: number; y: number }>,
  ring: Pt[],
  polygonRings: Pt[][],
  extent: number,
  positions: number[],
  indices: number[],
  normals: number[],
  shoreV: number[],
  shoreU: number[]
): void {
  if (ring.length < 2) return;
  const lastIdx = ring.length - 1;
  const closed = ring[0].x === ring[lastIdx].x && ring[0].z === ring[lastIdx].z;
  // Unique vertex count (drop the closing duplicate on closed rings).
  const n = closed ? lastIdx : ring.length;
  if (n < 2) return;

  // The perpendicular n = (dz, -dx)/len is "right of travel"; whether that
  // points toward the water is constant for the whole ring (winding is
  // consistent), so resolve it ONCE with a point-in-polygon test rather than
  // per edge or via fragile winding math.
  const waterSign = resolveWaterSign(ring, n, polygonRings);
  if (waterSign === 0) return; // couldn't resolve (degenerate ring)

  // Per-vertex offset direction = the average ("miter") of the two adjacent
  // edge perpendiculars. Building the ribbon as a continuous strip with these
  // shared vertex offsets — instead of an independent quad per edge — is what
  // kills the sunburst at sharp turns: neighbouring edges share one offset
  // vertex, so they join smoothly instead of fanning out. We DON'T scale the
  // offset by the miter length (which would spike at acute corners like a pier
  // tip); the ribbon just pinches a little at sharp turns, which reads fine.
  const offX = new Array<number>(n);
  const offZ = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const cur = ring[i];
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    let pinx = 0, pinz = 0, poutx = 0, poutz = 0;
    if (hasPrev) {
      const prev = ring[(i - 1 + n) % n];
      const dx = cur.x - prev.x, dz = cur.z - prev.z;
      const l = Math.hypot(dx, dz);
      if (l > 1e-6) { pinx = dz / l; pinz = -dx / l; }
    }
    if (hasNext) {
      const next = ring[(i + 1) % n];
      const dx = next.x - cur.x, dz = next.z - cur.z;
      const l = Math.hypot(dx, dz);
      if (l > 1e-6) { poutx = dz / l; poutz = -dx / l; }
    }
    let mx = pinx + poutx, mz = pinz + poutz;
    let ml = Math.hypot(mx, mz);
    if (ml < 1e-3) {
      // ~180° turn (pier tip) — the two perpendiculars cancel. Fall back to
      // whichever single edge perpendicular we have so the offset is finite.
      mx = poutx || pinx;
      mz = poutz || pinz;
      ml = Math.hypot(mx, mz);
    }
    if (ml < 1e-6) { offX[i] = 0; offZ[i] = 0; } else { offX[i] = mx / ml; offZ[i] = mz / ml; }
  }

  const hw = SHORE_HALF_W;
  const segCount = closed ? n : n - 1;
  let u = 0;
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const aMvt = mvtRing[i];
    const bMvt = mvtRing[j];
    const a = ring[i];
    const b = ring[j];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    // Skip clip seams, but still advance the along-coast distance so the swell
    // phase stays continuous across the gap.
    if (isClipSeam(aMvt.x, aMvt.y, bMvt.x, bMvt.y, extent)) { u += len; continue; }

    // Seaward offset per vertex (its mitered direction × waterSign).
    const wax = offX[i] * waterSign, waz = offZ[i] * waterSign;
    const wbx = offX[j] * waterSign, wbz = offZ[j] * waterSign;

    const base = positions.length / 3;
    // a-sea, a-land, b-land, b-sea. Sea verts sit on the water plane, land
    // verts on the ground plane → the quad is a beach slope.
    positions.push(
      a.x + wax * hw, SHORE_WATER_Y, a.z + waz * hw,
      a.x - wax * hw, SHORE_LAND_Y, a.z - waz * hw,
      b.x - wbx * hw, SHORE_LAND_Y, b.z - wbz * hw,
      b.x + wbx * hw, SHORE_WATER_Y, b.z + wbz * hw
    );
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    shoreV.push(0, 1, 1, 0);
    shoreU.push(u, u, u + len, u + len);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    u += len;
  }
}

/** +1 if the (dz,-dx) perpendicular points into the water, -1 if it points to
 *  land, 0 if it couldn't be resolved. Tests one representative edge. */
function resolveWaterSign(ring: Pt[], n: number, polygonRings: Pt[][]): number {
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const mx = (a.x + b.x) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    const nx = dz / len;
    const nz = -dx / len;
    const eps = 1.5; // metres off the edge to sample
    return pointInWater(mx + nx * eps, mz + nz * eps, polygonRings) ? 1 : -1;
  }
  return 0;
}
