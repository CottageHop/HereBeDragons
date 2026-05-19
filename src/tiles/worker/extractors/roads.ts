import { VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

const ROAD_LAYER_NAMES = ['roads', 'osm_lines'];

export enum RoadClass {
  Major = 0,
  Minor = 1,
  Path = 2
}

const WIDTH_M: Record<RoadClass, number> = {
  [RoadClass.Major]: 12,
  [RoadClass.Minor]: 7,
  [RoadClass.Path]: 3
};

// Stagger Y so a path crossing a road doesn't z-fight with it. Visual order:
// major roads on top (most important), paths underneath where they overlap.
const ROAD_Y_BY_CLASS: Record<RoadClass, number> = {
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
      const half = WIDTH_M[cls] * 0.5;
      const lines = f.loadGeometry();
      for (const line of lines) {
        if (line.length < 2) continue;
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

  if (indices.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: makeFlatUpNormals(positions.length / 3),
    attributes: { class: new Uint8Array(classes) },
    lines: {
      positions: new Float32Array(linePositions),
      ranges: new Uint32Array(lineRanges),
      classes: new Uint8Array(lineClasses)
    }
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
  classes: number[]
): void {
  const n = line.length;
  const wx: number[] = new Array(n);
  const wz: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = line[i];
    wx[i] = t.worldOffsetX + p.x * t.scalePerExtentX;
    wz[i] = -(t.worldOffsetY - p.y * t.scalePerExtentY);
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
