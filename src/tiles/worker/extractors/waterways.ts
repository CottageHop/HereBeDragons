import { VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

/**
 * Linear waterway extractor — rivers, canals, streams.
 *
 * Polygon water (lakes, oceans, harbor) is handled by water.ts; this extractor
 * picks up the LINE features tagged with `waterway=*` in `osm_lines` (and in
 * `physical_line` for Protomaps-schema tiles). Each line becomes a thin ribbon
 * of width proportional to the waterway kind, drawn just above the polygon
 * water plane so a river entering a lake reads as a continuous blue channel.
 *
 * Widths are deliberately wider than real-world dimensions — at zoom 15 a
 * 3 m-wide canal renders sub-pixel and disappears. We use ribbon widths
 * that read at a glance.
 */

const WATERWAY_LAYER_NAMES = ['osm_lines', 'physical_line', 'waterway'];

/** Centerline ribbon width (m) per waterway kind. */
const WIDTH_BY_KIND: Record<string, number> = {
  river: 12,
  canal: 6,
  stream: 2.5,
  ditch: 1.0,
  drain: 1.0
};

// Sit just above the polygon water plane (water.ts uses Y = -1.0). Pairs
// with `Palette.waterway`'s polygonOffsetUnits = -26 to draw over the water
// polygon when the waterway crosses one.
const WATERWAY_Y = -0.95;

export function extractWaterways(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const name of WATERWAY_LAYER_NAMES) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('LineString')) continue;
      const width = classifyWaterway(f.properties);
      if (width === null) continue;
      const half = width * 0.5;

      const lines = f.loadGeometry();
      for (const line of lines) {
        if (line.length < 2) continue;
        buildRibbon(line, t, half, WATERWAY_Y, positions, indices);
      }
    }
  }

  if (indices.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: makeFlatUpNormals(positions.length / 3)
  };
}

/**
 * Determine the ribbon width for a feature based on its OSM `waterway` tag.
 * Returns `null` to skip the feature — i.e. it's a non-waterway line that
 * happened to land in `osm_lines` (tree rows, hedges, etc.).
 */
function classifyWaterway(props: VectorTileFeature['properties']): number | null {
  const waterway = String(props.waterway ?? props['waterway'] ?? '').toLowerCase();
  if (!waterway) {
    // Some schemas use `kind` instead.
    const kind = String(props.kind ?? props['pmap:kind'] ?? '').toLowerCase();
    if (kind && WIDTH_BY_KIND[kind] !== undefined) return WIDTH_BY_KIND[kind];
    return null;
  }
  return WIDTH_BY_KIND[waterway] ?? null;
}

/**
 * Ribbon construction with miter joins — same approach as roads.ts's
 * buildRibbon, just without the per-class branching since waterways all share
 * one material. Kept inlined here so the extractor has no cross-file deps
 * besides the worker-safe `mercator` helper.
 */
function buildRibbon(
  line: Array<{ x: number; y: number }>,
  t: ReturnType<typeof buildTileToWorld>,
  halfWidth: number,
  yPlane: number,
  positions: number[],
  indices: number[]
): void {
  const n = line.length;
  const wx: number[] = new Array(n);
  const wz: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = line[i];
    wx[i] = t.worldOffsetX + p.x * t.scalePerExtentX;
    wz[i] = -(t.worldOffsetY - p.y * t.scalePerExtentY);
  }

  const MITER_LIMIT = 4;
  const leftIdx: number[] = new Array(n);
  const rightIdx: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    let dx: number;
    let dz: number;
    if (i === 0) {
      dx = wx[1] - wx[0];
      dz = wz[1] - wz[0];
    } else if (i === n - 1) {
      dx = wx[n - 1] - wx[n - 2];
      dz = wz[n - 1] - wz[n - 2];
    } else {
      const dx0 = wx[i] - wx[i - 1];
      const dz0 = wz[i] - wz[i - 1];
      const dx1 = wx[i + 1] - wx[i];
      const dz1 = wz[i + 1] - wz[i];
      const l0 = Math.hypot(dx0, dz0) || 1;
      const l1 = Math.hypot(dx1, dz1) || 1;
      dx = dx0 / l0 + dx1 / l1;
      dz = dz0 / l0 + dz1 / l1;
    }
    const len = Math.hypot(dx, dz) || 1;
    let nx = -dz / len;
    let nz = dx / len;

    let miterScale = 1;
    if (i > 0 && i < n - 1) {
      const segDx = wx[i + 1] - wx[i];
      const segDz = wz[i + 1] - wz[i];
      const segLen = Math.hypot(segDx, segDz) || 1;
      const segNx = -segDz / segLen;
      const segNz = segDx / segLen;
      const dot = nx * segNx + nz * segNz;
      if (Math.abs(dot) > 1e-6) {
        miterScale = Math.min(MITER_LIMIT, 1 / dot);
      }
    }
    nx *= halfWidth * miterScale;
    nz *= halfWidth * miterScale;

    const baseVertex = positions.length / 3;
    positions.push(wx[i] + nx, yPlane, wz[i] + nz);
    positions.push(wx[i] - nx, yPlane, wz[i] - nz);
    leftIdx[i] = baseVertex;
    rightIdx[i] = baseVertex + 1;
  }

  for (let i = 0; i < n - 1; i++) {
    const a = leftIdx[i], b = rightIdx[i], c = leftIdx[i + 1], d = rightIdx[i + 1];
    indices.push(a, c, b, c, d, b);
  }
}

function makeFlatUpNormals(vertexCount: number): Float32Array {
  const n = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) n[i * 3 + 1] = 1;
  return n;
}
