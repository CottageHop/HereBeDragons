import earcut from 'earcut';
import { VectorTileFeature, type VectorTileLayer, classifyRings } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

const BUILDING_LAYER_NAMES = ['buildings', 'osm_buildings'];
const DEFAULT_HEIGHT = 6;
/**
 * Hard cap (m) on extruded building height. Burj Khalifa is 828 m, so any
 * single feature above this is almost certainly bad data — a `levels` tag
 * misread as meters, a `render_height` in the wrong unit, an antenna mast
 * filed under `building`, etc. Without the cap, a stray entry like that
 * extrudes a triangle several km tall that visually dominates the scene.
 */
const MAX_HEIGHT_M = 1000;

/** Per-building summary emitted alongside the merged tile mesh. Indexed by
 *  the per-vertex `buildingIndex` attribute so the picker can look up the
 *  building hit by a raycast. A single BuildingMeta may aggregate multiple
 *  overlapping MVT `building:part` features into one logical building. */
export interface BuildingMeta {
  id: string;
  /** Maximum height across all parts — used for popup anchoring + floor math. */
  height: number;
  levels?: number;
  /** Total footprint in m² (sum across all parts). */
  footprintArea: number;
  /** Area-weighted centroid across all parts. */
  centroidX: number;
  centroidZ: number;
  /** Outer-ring vertices in world meters as flat (x, z) pairs across all
   *  member parts. `outerRingRanges` slices the buffer; `outerRingHeights`
   *  is the extrusion height of each ring's source part. */
  outerRings: Float32Array;
  outerRingRanges: Uint32Array;
  outerRingHeights: Float32Array;
  /** Properties of the largest (by area) constituent part. */
  properties: Record<string, string | number | boolean>;
}

/** Intermediate per-feature record collected before grouping. */
interface FeatureRecord {
  id: string;
  height: number;
  levels?: number;
  properties: Record<string, string | number | boolean>;
  /** Already in scene-meter coords. */
  polygons: { x: number; z: number }[][][];
  area: number;
  centroidX: number;
  centroidZ: number;
  // World-meter bbox (used for overlap-based grouping).
  minX: number; minZ: number; maxX: number; maxZ: number;
  /**
   * True iff this feature is an OSM `building:part` (tag-based detection).
   * When a group of overlapping features contains any parts, the non-part
   * features in the group are treated as the building's outer ENVELOPE and
   * have their geometry suppressed — otherwise the envelope's full-height
   * extrusion swallows the per-part architecture inside it.
   */
  isPart: boolean;
}


export function extractBuildings(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  /** Per-vertex group index (NOT per-feature) — clicking any building:part
   *  selects the whole physical building it belongs to. */
  const buildingIndex: number[] = [];
  /** Per-group data, indexed by `buildingIndex`. */
  const buildings: BuildingMeta[] = [];
  let totalVolume = 0;

  // ---- Pass 1: collect features in scene-coords ------------------------
  const features: FeatureRecord[] = [];
  for (const name of BUILDING_LAYER_NAMES) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    // Reject buildings whose MVT bbox is larger than half a tile.
    const MAX_FOOTPRINT_MVT = extent * 0.5;

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('Polygon')) continue;
      const height = pickHeight(f.properties);
      if (height <= 0) continue;
      const rings = f.loadGeometry();
      if (rings.length === 0) continue;

      let minMx = Infinity, minMy = Infinity, maxMx = -Infinity, maxMy = -Infinity;
      for (const ring of rings) for (const p of ring) {
        if (p.x < minMx) minMx = p.x;
        if (p.x > maxMx) maxMx = p.x;
        if (p.y < minMy) minMy = p.y;
        if (p.y > maxMy) maxMy = p.y;
      }
      if (maxMx - minMx > MAX_FOOTPRINT_MVT || maxMy - minMy > MAX_FOOTPRINT_MVT) continue;

      const grouped = classifyRings(rings);
      const polygons: { x: number; z: number }[][][] = grouped.map((polygon) =>
        polygon.map((ring) =>
          ring.map((p) => ({
            x: t.worldOffsetX + p.x * t.scalePerExtentX,
            z: -(t.worldOffsetY - p.y * t.scalePerExtentY)
          }))
        )
      );

      let area = 0;
      let cx = 0;
      let cz = 0;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const polygon of polygons) {
        if (polygon.length === 0) continue;
        const outer = polygon[0];
        const a = polygonArea(outer);
        area += a;
        const c = polygonCentroid(outer);
        cx += c.x * a;
        cz += c.z * a;
        for (const p of outer) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.z < minZ) minZ = p.z;
          if (p.z > maxZ) maxZ = p.z;
        }
      }
      if (area <= 0) continue;

      const levelsRaw = f.properties.levels ?? f.properties['building:levels'];
      const levels = typeof levelsRaw === 'number'
        ? levelsRaw
        : (levelsRaw !== undefined ? Number(levelsRaw) : undefined);
      const featureId = (f.id !== undefined && f.id !== null && f.id !== 0)
        ? String(f.id)
        : `${z}/${tx}/${ty}/${i}`;

      features.push({
        id: featureId,
        height,
        levels: levels !== undefined && Number.isFinite(levels) ? levels : undefined,
        properties: serializeProperties(f.properties),
        polygons,
        area,
        centroidX: cx / area,
        centroidZ: cz / area,
        minX, minZ, maxX, maxZ,
        isPart: isPartFeature(f.properties)
      });
    }
  }

  if (features.length === 0) return null;

  // ---- Pass 2: union-find groups by centroid-in-polygon ----------------
  // bbox overlap is too coarse — L-shaped buildings have AABBs that include
  // empty space, so two neighbours' bboxes can overlap heavily without the
  // polygons touching. Real test: does one feature's centroid actually fall
  // inside the other's outer ring? Building:part features sit inside their
  // base's footprint, so the part's centroid is contained in the base; two
  // independent neighbours' centroids are in separate polygons → no merge.
  const parent = features.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i: number, j: number): void {
    const a = find(i), b = find(j);
    if (a !== b) parent[a] = b;
  }
  for (let i = 0; i < features.length; i++) {
    for (let j = i + 1; j < features.length; j++) {
      const a = features[i], b = features[j];
      // Quick bbox reject first — point-in-polygon is the expensive step.
      if (a.maxX < b.minX || a.minX > b.maxX || a.maxZ < b.minZ || a.minZ > b.maxZ) continue;
      if (
        pointInAnyOuter(a.centroidX, a.centroidZ, b.polygons) ||
        pointInAnyOuter(b.centroidX, b.centroidZ, a.polygons)
      ) {
        union(i, j);
      }
    }
  }

  // Defuse runaway groups. A complex like Grand Central can chain together
  // dozens of unrelated buildings via a giant concourse / rail-yard deck
  // feature that overlaps many neighbors — clicking any one of them would
  // select the whole block. Real buildings have footprints ≤ ~300 m; any
  // group whose combined bbox exceeds that almost certainly chained through
  // such a hub. Treat each member of such a group as its own root so
  // selection / picking falls back to the natural per-feature granularity.
  const MAX_GROUP_DIM = 300;
  const groupBbox = new Map<number, { minX: number; minZ: number; maxX: number; maxZ: number }>();
  for (let fi = 0; fi < features.length; fi++) {
    const root = find(fi);
    const f = features[fi];
    let box = groupBbox.get(root);
    if (!box) {
      box = { minX: f.minX, minZ: f.minZ, maxX: f.maxX, maxZ: f.maxZ };
      groupBbox.set(root, box);
    } else {
      if (f.minX < box.minX) box.minX = f.minX;
      if (f.minZ < box.minZ) box.minZ = f.minZ;
      if (f.maxX > box.maxX) box.maxX = f.maxX;
      if (f.maxZ > box.maxZ) box.maxZ = f.maxZ;
    }
  }
  const oversizedRoots = new Set<number>();
  for (const [root, box] of groupBbox) {
    if (Math.max(box.maxX - box.minX, box.maxZ - box.minZ) > MAX_GROUP_DIM) {
      oversizedRoots.add(root);
    }
  }
  // Wrap `find` — members of oversized groups become their own root, which
  // splits the group into singletons everywhere downstream (skip mask,
  // geometry emission, BuildingMeta aggregation).
  const rootOf = (i: number): number => {
    const r = find(i);
    return oversizedRoots.has(r) ? i : r;
  };

  // Determine which features are envelope outlines whose geometry should be
  // hidden inside their group (their parts are rendered instead).
  const skipFeature = computeSkipMask(features, rootOf);

  // ---- Pass 3: emit geometry per group + build aggregate BuildingMeta --
  // Map root → dense group index (0..N-1).
  const groupIndexOf = new Map<number, number>();
  /** Accumulators per group, in parallel arrays. */
  const groupOuterPairs: number[][] = [];
  const groupOuterRanges: number[][] = [];
  const groupOuterHeights: number[][] = [];
  const groupHeight: number[] = [];
  const groupArea: number[] = [];
  const groupCentroidSumX: number[] = [];
  const groupCentroidSumZ: number[] = [];
  /** Properties + id + levels are taken from the LARGEST part. */
  const groupBestPart: number[] = []; // featureIndex of biggest part
  const groupBestArea: number[] = [];

  for (let fi = 0; fi < features.length; fi++) {
    const root = rootOf(fi);
    let gIdx = groupIndexOf.get(root);
    if (gIdx === undefined) {
      gIdx = groupIndexOf.size;
      groupIndexOf.set(root, gIdx);
      groupOuterPairs.push([]);
      groupOuterRanges.push([]);
      groupOuterHeights.push([]);
      groupHeight.push(0);
      groupArea.push(0);
      groupCentroidSumX.push(0);
      groupCentroidSumZ.push(0);
      groupBestPart.push(fi);
      groupBestArea.push(0);
    }

    const fr = features[fi];

    // Aggregate group stats.
    if (fr.height > groupHeight[gIdx]) groupHeight[gIdx] = fr.height;
    groupArea[gIdx] += fr.area;
    groupCentroidSumX[gIdx] += fr.centroidX * fr.area;
    groupCentroidSumZ[gIdx] += fr.centroidZ * fr.area;
    if (fr.area > groupBestArea[gIdx]) {
      groupBestArea[gIdx] = fr.area;
      groupBestPart[gIdx] = fi;
    }
    totalVolume += fr.area * fr.height;

    // Stamp outer rings into the group's ring buffer + emit geometry. The
    // ring buffer is used by the selection wireframe — include envelope rings
    // there so the highlight shows the building's overall footprint even when
    // the envelope's solid extrusion is suppressed.
    for (const polygon of fr.polygons) {
      if (polygon.length > 0) {
        const outer = polygon[0];
        const start = groupOuterPairs[gIdx].length / 2;
        for (const p of outer) groupOuterPairs[gIdx].push(p.x, p.z);
        const end = groupOuterPairs[gIdx].length / 2;
        groupOuterRanges[gIdx].push(start, end);
        groupOuterHeights[gIdx].push(fr.height);
      }
      if (skipFeature[fi]) continue;
      buildRoof(polygon, fr.height, positions, normals, indices, buildingIndex, gIdx);
      for (const ring of polygon) {
        buildWalls(ring, fr.height, positions, normals, indices, buildingIndex, gIdx);
      }
    }
  }

  // ---- Pass 4: finalize BuildingMeta per group -------------------------
  for (let g = 0; g < groupIndexOf.size; g++) {
    const bestPart = features[groupBestPart[g]];
    const area = Math.max(groupArea[g], 1e-6);
    buildings.push({
      id: bestPart.id,
      height: groupHeight[g],
      levels: bestPart.levels,
      footprintArea: groupArea[g],
      centroidX: groupCentroidSumX[g] / area,
      centroidZ: groupCentroidSumZ[g] / area,
      outerRings: new Float32Array(groupOuterPairs[g]),
      outerRingRanges: new Uint32Array(groupOuterRanges[g]),
      outerRingHeights: new Float32Array(groupOuterHeights[g]),
      properties: bestPart.properties
    });
  }

  if (indices.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
    // Float32 matches the shader's `attribute float buildingIndex` exactly,
    // so the main thread can wrap this in a BufferAttribute with zero copy.
    // Building indices fit well within Float32's 24-bit mantissa precision.
    attributes: { buildingIndex: new Float32Array(buildingIndex) },
    metadata: { totalVolume, buildings }
  };
}

/** Shoelace formula — returns the absolute area of a closed XZ ring. */
/** Ray-cast point-in-polygon. `ring` is closed CCW or CW; either works. */
function pointInRing(x: number, z: number, ring: { x: number; z: number }[]): boolean {
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

/** Tests against the outer ring of every polygon (multi-polygon support). */
function pointInAnyOuter(x: number, z: number, polygons: { x: number; z: number }[][][]): boolean {
  for (const polygon of polygons) {
    if (polygon.length > 0 && pointInRing(x, z, polygon[0])) return true;
  }
  return false;
}

function polygonArea(ring: { x: number; z: number }[]): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) * 0.5;
}

/** Average vertex position of a ring. Cheap centroid; good enough for popup. */
function polygonCentroid(ring: { x: number; z: number }[]): { x: number; z: number } {
  if (ring.length === 0) return { x: 0, z: 0 };
  let sx = 0, sz = 0;
  for (const p of ring) { sx += p.x; sz += p.z; }
  return { x: sx / ring.length, z: sz / ring.length };
}

function serializeProperties(
  props: VectorTileFeature['properties']
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Detect whether a feature represents an OSM `building:part` rather than a
 * whole-building outline. Tag schemas vary across producers — Protomaps may
 * use `kind=building_part`, raw OSM uses `building:part=*` directly — so we
 * check all of them. Returns false on the empty / "no" sentinel values OSM
 * editors sometimes emit.
 */
function isPartFeature(props: VectorTileFeature['properties']): boolean {
  const bp = String(props['building:part'] ?? '').toLowerCase();
  if (bp && bp !== 'no') return true;
  const kind = String(props.kind ?? '').toLowerCase();
  if (kind === 'building_part') return true;
  const pmapKind = String(props['pmap:kind'] ?? '').toLowerCase();
  if (pmapKind === 'building_part') return true;
  return false;
}

/**
 * For each multi-feature group, determine which features represent the outer
 * envelope and should have their geometry suppressed.
 *
 * Two strategies, in order:
 *   1. Tag-based — if any feature in the group is explicitly an OSM
 *      `building:part`, treat the non-part features as envelopes.
 *   2. Geometric fallback — if NO tags exist (Protomaps strips them), look
 *      for a single feature whose footprint contains every other feature's
 *      centroid and whose area is meaningfully (≥ 1.3×) larger than the
 *      biggest sub-feature. Only fires for groups with ≥ 3 members so a
 *      simple two-feature overlap (e.g. a house with one attached porch)
 *      doesn't get its main outline hidden.
 *
 * BuildingMeta aggregation (height, area, outerRings) still uses ALL features
 * including envelopes — the selection wireframe is allowed to show the
 * envelope's bounding outline alongside the inner parts.
 */
function computeSkipMask(features: FeatureRecord[], find: (i: number) => number): boolean[] {
  const skip = new Array<boolean>(features.length).fill(false);
  const groups = new Map<number, number[]>();
  for (let fi = 0; fi < features.length; fi++) {
    const root = find(fi);
    let bucket = groups.get(root);
    if (!bucket) { bucket = []; groups.set(root, bucket); }
    bucket.push(fi);
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;

    // Strategy 1: tag-based.
    let hasExplicitPart = false;
    for (const fi of members) {
      if (features[fi].isPart) { hasExplicitPart = true; break; }
    }
    if (hasExplicitPart) {
      for (const fi of members) {
        if (!features[fi].isPart) skip[fi] = true;
      }
      continue;
    }

    // Strategy 2: geometric envelope detection. Require ≥ 3 members so we
    // don't mis-fire on a simple "house + attached porch" two-feature group.
    if (members.length < 3) continue;
    let envelope = -1;
    let envelopeArea = -Infinity;
    for (const fi of members) {
      const a = features[fi];
      let containsAll = true;
      for (const fj of members) {
        if (fi === fj) continue;
        const b = features[fj];
        if (!pointInAnyOuter(b.centroidX, b.centroidZ, a.polygons)) {
          containsAll = false;
          break;
        }
      }
      if (containsAll && a.area > envelopeArea) {
        envelope = fi;
        envelopeArea = a.area;
      }
    }
    if (envelope < 0) continue;
    let othersMaxArea = 0;
    for (const fi of members) {
      if (fi === envelope) continue;
      if (features[fi].area > othersMaxArea) othersMaxArea = features[fi].area;
    }
    // Envelope must be a clear dominant outline, not just "the biggest of
    // a few similar-sized features that happen to nest."
    if (envelopeArea > othersMaxArea * 1.3) skip[envelope] = true;
  }
  return skip;
}

function pickHeight(props: VectorTileFeature['properties']): number {
  const candidates = [
    props.render_height,
    props['pmap:render_height'],
    props.height,
    props.building_height,
    props.levels !== undefined ? Number(props.levels) * 3 : undefined,
    props['building:levels'] !== undefined ? Number(props['building:levels']) * 3 : undefined
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') {
      const n = typeof c === 'number' ? c : Number(c);
      if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_HEIGHT_M);
    }
  }
  return DEFAULT_HEIGHT;
}

function buildRoof(
  rings: { x: number; z: number }[][],
  height: number,
  positions: number[],
  normals: number[],
  indices: number[],
  buildingIndex: number[],
  myIndex: number
): void {
  const flat: number[] = [];
  const holeIndices: number[] = [];
  let vertexCount = 0;
  const baseVertex = positions.length / 3;

  // Compute world-space bbox while collecting vertices — used below to drop
  // triangles whose projected area is enormous (earcut can produce garbage
  // triangles for self-intersecting or near-degenerate input).
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(vertexCount);
    const ring = rings[r];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      flat.push(p.x, p.z);
      positions.push(p.x, height, p.z);
      normals.push(0, 1, 0);
      buildingIndex.push(myIndex);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
      vertexCount++;
    }
  }

  const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  // Reverse winding so the roof faces +Y. Earcut emits CCW in input space; the
  // MVT→world y-flip makes that point -Y in 3D.
  const bboxArea = Math.max(1, (maxX - minX) * (maxZ - minZ));
  for (let k = 0; k < tris.length; k += 3) {
    const i0 = tris[k], i1 = tris[k + 1], i2 = tris[k + 2];
    // Compute triangle area in (x, z) — flat is 2 floats per vertex.
    const ax = flat[i0 * 2], az = flat[i0 * 2 + 1];
    const bx = flat[i1 * 2], bz = flat[i1 * 2 + 1];
    const cx = flat[i2 * 2], cz = flat[i2 * 2 + 1];
    const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    if (!Number.isFinite(area) || area < 1e-6) continue;
    if (area > bboxArea) continue; // earcut garbage — triangle exceeds the polygon's footprint
    indices.push(baseVertex + i0, baseVertex + i2, baseVertex + i1);
  }
}

function buildWalls(
  ring: { x: number; z: number }[],
  height: number,
  positions: number[],
  normals: number[],
  indices: number[],
  buildingIndex: number[],
  myIndex: number
): void {
  if (ring.length < 2) return;

  const last = ring.length - 1;
  const closed = ring[0].x === ring[last].x && ring[0].z === ring[last].z;
  const limit = closed ? last : last + 1;

  for (let i = 0; i < limit; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    // Right of edge direction in XZ (with X right, Z forward) = (dz, -dx). For
    // both CCW outer rings (interior on left) and CW inner rings (hole on right),
    // "right of edge" is the correct outward direction for the wall surface.
    const nx = dz / len;
    const nz = -dx / len;

    const baseVertex = positions.length / 3;
    // Four vertices: a-bottom (0), b-bottom (1), b-top (2), a-top (3).
    positions.push(a.x, 0, a.z, b.x, 0, b.z, b.x, height, b.z, a.x, height, a.z);
    normals.push(nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz);
    buildingIndex.push(myIndex, myIndex, myIndex, myIndex);
    // Wind so geometric normal matches the assigned shading normal: outward.
    indices.push(baseVertex, baseVertex + 2, baseVertex + 1, baseVertex, baseVertex + 3, baseVertex + 2);
  }
}
