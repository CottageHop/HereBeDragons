import { VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

/**
 * Rail track extractor.
 *
 * Produces dual-rail-with-crossties geometry per rail line:
 *   - Two thin parallel ribbons (the rails) offset ±GAUGE/2 from the centerline.
 *   - A short cross-bar (a tie) every TIE_SPACING meters along the path,
 *     sticking out past each rail.
 *
 * Class attribute distinguishes strips from ties so RailsLayer can render
 * them with separate materials (dark steel + creosoted-tie brown).
 */

const RAIL_LAYER_NAMES = ['roads', 'osm_lines'];

/** OSM `kind` / `kind_detail` / `railway` values that mean "rail track." */
const RAIL_KINDS = new Set([
  'rail', 'subway', 'light_rail', 'tram', 'narrow_gauge', 'monorail', 'funicular', 'railway'
]);

// Visual exaggeration of real-world dimensions so a single rail line reads
// at typical map zoom (~15). Real standard gauge is 1.435 m and rails are
// ~70 mm wide — invisible at the screen-space resolution this map renders at.
const GAUGE = 2.0;        // rail-to-rail center-to-center (m)
const RAIL_WIDTH = 0.40;  // each rail strip's width (m)
const TIE_LENGTH = 0.60;  // along-track tie length (m)
const TIE_WIDTH  = 3.20;  // cross-track tie width — sticks past both rails (m)
const TIE_SPACING = 4.0;  // along-track distance between consecutive ties (m)
// Buried below parks (Y = -1.90), water (Y = -1.0), and roads (Y down to
// -0.50) so any of those surfaces visually cover the rail at intersections.
// Stays above landuse_urban (Y = -2.20) so rails remain visible in the
// dominant urban fill. Pairs with Palette.rail_* polygonOffsetUnits = -5/-7
// for fine-grained depth-buffer ordering against landuse_urban.
const RAIL_Y = -2.05;

/** Per-vertex class. Matches RailsLayer's `splitByClass` consumer. */
export enum RailPart {
  Strip = 0,
  Tie = 1
}

export function extractRails(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const positions: number[] = [];
  const indices: number[] = [];
  const classes: number[] = [];

  for (const name of RAIL_LAYER_NAMES) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('LineString')) continue;
      if (!isRail(f.properties)) continue;

      const lines = f.loadGeometry();
      for (const line of lines) {
        if (line.length < 2) continue;
        const n = line.length;
        const wx = new Array<number>(n);
        const wz = new Array<number>(n);
        for (let j = 0; j < n; j++) {
          const p = line[j];
          wx[j] = t.worldOffsetX + p.x * t.scalePerExtentX;
          wz[j] = -(t.worldOffsetY - p.y * t.scalePerExtentY);
        }
        emitDualRail(wx, wz, positions, indices, classes);
        emitTies(wx, wz, positions, indices, classes);
      }
    }
  }

  if (indices.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: makeFlatUpNormals(positions.length / 3),
    attributes: { class: new Uint8Array(classes) }
  };
}

function isRail(props: VectorTileFeature['properties']): boolean {
  const kindDetail = String(props.kind_detail ?? props['pmap:kind_detail'] ?? '').toLowerCase();
  if (kindDetail && RAIL_KINDS.has(kindDetail)) return true;
  const kind = String(props.kind ?? props['pmap:kind'] ?? '').toLowerCase();
  if (kind && RAIL_KINDS.has(kind)) return true;
  const railway = String(props.railway ?? '').toLowerCase();
  if (railway && RAIL_KINDS.has(railway)) return true;
  return false;
}

/**
 * Build the two rail strips. Per centerline vertex we emit 4 verts laid out as:
 *   0: leftOuter, 1: leftInner, 2: rightInner, 3: rightOuter
 * Then for each segment we triangulate two ribbons (left rail and right rail).
 * Wound +Y up to match the rest of the ground layers — geometric-normal-up
 * means the stylized shader lights them correctly without recomputing normals.
 */
function emitDualRail(
  wx: number[],
  wz: number[],
  positions: number[],
  indices: number[],
  classes: number[]
): void {
  const n = wx.length;
  const baseIdx = positions.length / 3;
  const halfRail = RAIL_WIDTH * 0.5;
  const halfGauge = GAUGE * 0.5;
  for (let i = 0; i < n; i++) {
    let dx: number, dz: number;
    if (i === 0) {
      dx = wx[1] - wx[0]; dz = wz[1] - wz[0];
    } else if (i === n - 1) {
      dx = wx[n - 1] - wx[n - 2]; dz = wz[n - 1] - wz[n - 2];
    } else {
      // Average the incoming + outgoing unit tangents — bisector miter, same
      // approach as the road ribbon. Sharp corners distort the strip width
      // but rail lines rarely bend sharply.
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
    // Perpendicular (90° rotation in XZ): (-dz, dx).
    const nx = -dz / len;
    const nz = dx / len;

    const leftCenterX  = wx[i] + nx * halfGauge;
    const leftCenterZ  = wz[i] + nz * halfGauge;
    const rightCenterX = wx[i] - nx * halfGauge;
    const rightCenterZ = wz[i] - nz * halfGauge;

    // Left rail: outer (further from centerline), then inner.
    positions.push(leftCenterX + nx * halfRail, RAIL_Y, leftCenterZ + nz * halfRail);
    positions.push(leftCenterX - nx * halfRail, RAIL_Y, leftCenterZ - nz * halfRail);
    // Right rail: inner first (closer to centerline), then outer.
    positions.push(rightCenterX + nx * halfRail, RAIL_Y, rightCenterZ + nz * halfRail);
    positions.push(rightCenterX - nx * halfRail, RAIL_Y, rightCenterZ - nz * halfRail);
    classes.push(RailPart.Strip, RailPart.Strip, RailPart.Strip, RailPart.Strip);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = baseIdx + i * 4;
    const b = baseIdx + (i + 1) * 4;
    // Left rail ribbon — verts (a+0, a+1) and (b+0, b+1). Winding matches
    // RoadsLayer's buildRibbon: (left[i], left[i+1], right[i]), then
    // (left[i+1], right[i+1], right[i]). Normals point +Y.
    indices.push(a + 0, b + 0, a + 1, b + 0, b + 1, a + 1);
    // Right rail ribbon — verts (a+2, a+3) and (b+2, b+3).
    indices.push(a + 2, b + 2, a + 3, b + 2, b + 3, a + 3);
  }
}

/**
 * Place ties uniformly along the polyline's arc length so they don't bunch up
 * at sharp corners or stretch over long straights. Each tie is a flat quad
 * lying in the XZ plane, oriented perpendicular to the local track tangent.
 */
function emitTies(
  wx: number[],
  wz: number[],
  positions: number[],
  indices: number[],
  classes: number[]
): void {
  const n = wx.length;
  if (n < 2) return;
  // Offset the first tie a half-spacing in so the leading tie isn't flush
  // with the line endpoint.
  let nextTieAt = TIE_SPACING * 0.5;
  let arcSoFar = 0;
  const halfL = TIE_LENGTH * 0.5;
  const halfW = TIE_WIDTH * 0.5;

  for (let seg = 0; seg < n - 1; seg++) {
    const sx = wx[seg];
    const sz = wz[seg];
    const ex = wx[seg + 1];
    const ez = wz[seg + 1];
    const dx = ex - sx;
    const dz = ez - sz;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-3) continue;
    const ux = dx / segLen;
    const uz = dz / segLen;
    // Cross-track unit perpendicular (90° CCW from along-track).
    const px = -uz;
    const pz = ux;

    while (nextTieAt <= arcSoFar + segLen) {
      const tAlong = nextTieAt - arcSoFar;
      const cx = sx + ux * tAlong;
      const cz = sz + uz * tAlong;
      const baseIdx = positions.length / 3;
      // 4 corners ordered: -along/-cross, +along/-cross, +along/+cross, -along/+cross
      positions.push(cx - ux * halfL - px * halfW, RAIL_Y, cz - uz * halfL - pz * halfW);
      positions.push(cx + ux * halfL - px * halfW, RAIL_Y, cz + uz * halfL - pz * halfW);
      positions.push(cx + ux * halfL + px * halfW, RAIL_Y, cz + uz * halfL + pz * halfW);
      positions.push(cx - ux * halfL + px * halfW, RAIL_Y, cz - uz * halfL + pz * halfW);
      classes.push(RailPart.Tie, RailPart.Tie, RailPart.Tie, RailPart.Tie);
      // Two triangles, both wound +Y up (verified by edge cross product).
      indices.push(baseIdx + 0, baseIdx + 2, baseIdx + 1);
      indices.push(baseIdx + 0, baseIdx + 3, baseIdx + 2);
      nextTieAt += TIE_SPACING;
    }
    arcSoFar += segLen;
  }
}

function makeFlatUpNormals(vertexCount: number): Float32Array {
  const n = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) n[i * 3 + 1] = 1;
  return n;
}
