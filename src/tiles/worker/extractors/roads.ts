import { VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

const ROAD_LAYER_NAMES = ['roads', 'osm_lines'];

export enum RoadClass {
  Major = 0,
  Minor = 1,
  Path = 2
}

export const WIDTH_M: Record<RoadClass, number> = {
  [RoadClass.Major]: 12,
  [RoadClass.Minor]: 7,
  [RoadClass.Path]: 3
};

// Stagger Y so a path crossing a road doesn't z-fight with it. Visual order:
// major roads on top (most important), paths underneath where they overlap.
// Also the deck base for arched bridges (the BridgesManager adds the arch on
// top of this) so a bridge meets its connecting flat road at the same height.
export const ROAD_Y_BY_CLASS: Record<RoadClass, number> = {
  [RoadClass.Major]: -0.30,
  [RoadClass.Minor]: -0.40,
  [RoadClass.Path]:  -0.50
};

export function extractRoads(
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

  // Parallel collection of road centerlines for downstream consumers (cars).
  const linePositions: number[] = [];   // flat XZ pairs
  const lineRanges: number[] = [];      // (startPairIdx, endPairIdx) per polyline
  const lineClasses: number[] = [];

  // Bridge centerlines, split out of the flat ribbon. The BridgesManager
  // stitches these across tiles and builds the arched decks (see protocol).
  const bridgePositions: number[] = [];
  const bridgeRanges: number[] = [];
  const bridgeClasses: number[] = [];

  // Tunnel ribbons, split out of the flat ribbon and drawn dashed + faded so an
  // underground roadway reads as "below" rather than as a normal surface road.
  // `dashU` is per-vertex distance along the centerline (metres), which the
  // tunnel material uses to stripe the deck into dashes.
  const tunnelPositions: number[] = [];
  const tunnelIndices: number[] = [];
  const tunnelDashU: number[] = [];
  const tunnelDashV: number[] = [];
  const tunnelScratchClasses: number[] = []; // buildRibbon needs a sink; unused

  for (const name of ROAD_LAYER_NAMES) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('LineString')) continue;
      const cls = classifyRoad(f.properties);
      if (cls === null) continue;
      const isBridge = f.properties.is_bridge === true;
      const isTunnel = f.properties.is_tunnel === true;
      const half = WIDTH_M[cls] * 0.5;
      const lines = f.loadGeometry();
      for (const line of lines) {
        if (line.length < 2) continue;
        if (isTunnel && !isBridge) {
          // Tunnels: own dashed/faded ribbon, never the flat surface ribbon or
          // the car path (cars shouldn't drive an underground segment on top).
          buildRibbon(
            line, t, half, ROAD_Y_BY_CLASS[cls], cls,
            tunnelPositions, tunnelIndices, tunnelScratchClasses, tunnelDashU, tunnelDashV
          );
          continue;
        }
        if (isBridge) {
          // Hand bridges to the BridgesManager as centerlines only — they're
          // rebuilt as arched decks on the main thread, not as flat ribbons
          // here. Excluded from `lines` too so cars don't drive the flat span.
          const startPair = bridgePositions.length / 2;
          for (let j = 0; j < line.length; j++) {
            const p = line[j];
            bridgePositions.push(
              t.worldOffsetX + p.x * t.scalePerExtentX,
              -(t.worldOffsetY - p.y * t.scalePerExtentY)
            );
          }
          bridgeRanges.push(startPair, bridgePositions.length / 2);
          bridgeClasses.push(cls);
          continue;
        }
        const lineStartPair = linePositions.length / 2;
        // Project the centerline points alongside ribbon construction so we
        // don't duplicate work.
        for (let j = 0; j < line.length; j++) {
          const p = line[j];
          const wx = t.worldOffsetX + p.x * t.scalePerExtentX;
          const wz = -(t.worldOffsetY - p.y * t.scalePerExtentY);
          linePositions.push(wx, wz);
        }
        const lineEndPair = linePositions.length / 2;
        lineRanges.push(lineStartPair, lineEndPair);
        lineClasses.push(cls);

        buildRibbon(line, t, half, ROAD_Y_BY_CLASS[cls], cls, positions, indices, classes);
      }
    }
  }

  const hasRibbon = indices.length > 0;
  const hasBridges = bridgeRanges.length > 0;
  const hasTunnels = tunnelIndices.length > 0;
  if (!hasRibbon && !hasBridges && !hasTunnels) return null;
  return {
    // A bridges/tunnels-only tile still needs valid (empty) ribbon arrays.
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: makeFlatUpNormals(positions.length / 3),
    attributes: { class: new Uint8Array(classes) },
    lines: {
      positions: new Float32Array(linePositions),
      ranges: new Uint32Array(lineRanges),
      classes: new Uint8Array(lineClasses)
    },
    bridges: hasBridges
      ? {
          positions: new Float32Array(bridgePositions),
          ranges: new Uint32Array(bridgeRanges),
          classes: new Uint8Array(bridgeClasses)
        }
      : undefined,
    tunnels: hasTunnels
      ? {
          positions: new Float32Array(tunnelPositions),
          indices: new Uint32Array(tunnelIndices),
          dashU: new Float32Array(tunnelDashU),
          dashV: new Float32Array(tunnelDashV)
        }
      : undefined
  };
}

function classifyRoad(props: VectorTileFeature['properties']): RoadClass | null {
  const kindRaw = props.kind ?? props.highway ?? props['pmap:kind'] ?? '';
  const kind = String(kindRaw).toLowerCase();
  if (!kind) return null;
  if (kind === 'highway' || kind === 'motorway' || kind === 'trunk' || kind === 'major_road' || kind === 'primary')
    return RoadClass.Major;
  if (kind === 'secondary' || kind === 'tertiary' || kind === 'medium_road' || kind === 'minor_road')
    return RoadClass.Minor;
  if (kind === 'residential' || kind === 'unclassified' || kind === 'service' || kind === 'living_street')
    return RoadClass.Minor;
  if (kind === 'path' || kind === 'footway' || kind === 'cycleway' || kind === 'pedestrian')
    return RoadClass.Path;
  return null;
}

function buildRibbon(
  line: Array<{ x: number; y: number }>,
  t: ReturnType<typeof buildTileToWorld>,
  halfWidth: number,
  yPlane: number,
  cls: RoadClass,
  positions: number[],
  indices: number[],
  classes: number[],
  /** Optional per-vertex dash coordinates for the tunnel material, pushed in
   *  lockstep with `positions` (left edge then right edge per station):
   *   - `dashUOut`: distance along the centerline (metres) → dash along length.
   *   - `dashVOut`: 0 at the left edge, 1 at the right → lets the shader draw
   *     only the road's outline rather than filling its width. */
  dashUOut?: number[],
  dashVOut?: number[]
): void {
  const n = line.length;
  const wx: number[] = new Array(n);
  const wz: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = line[i];
    wx[i] = t.worldOffsetX + p.x * t.scalePerExtentX;
    wz[i] = -(t.worldOffsetY - p.y * t.scalePerExtentY);
  }
  // Cumulative distance along the centerline for the dash coordinate.
  const dist: number[] = new Array(n);
  dist[0] = 0;
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + Math.hypot(wx[i] - wx[i - 1], wz[i] - wz[i - 1]);
  }

  // Miter normal at each vertex; clamp to avoid spike artifacts at sharp corners.
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
    // Perpendicular (rotate 90° in XZ plane): (-dz, dx)
    let nx = -dz / len;
    let nz = dx / len;

    // Miter scale to keep ribbon width along bisector
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
    classes.push(cls, cls);
    if (dashUOut) dashUOut.push(dist[i], dist[i]);
    if (dashVOut) dashVOut.push(0, 1);
    leftIdx[i] = baseVertex;
    rightIdx[i] = baseVertex + 1;
  }

  for (let i = 0; i < n - 1; i++) {
    const a = leftIdx[i], b = rightIdx[i], c = leftIdx[i + 1], d = rightIdx[i + 1];
    // Triangles wound so geometric normal is +Y (face up).
    indices.push(a, c, b, c, d, b);
  }
}

function makeFlatUpNormals(vertexCount: number): Float32Array {
  const n = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) n[i * 3 + 1] = 1;
  return n;
}
