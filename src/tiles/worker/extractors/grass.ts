import earcut from 'earcut';
import { VectorTileFeature, type VectorTileLayer, classifyRings } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

/**
 * Wind-blown grass blades. Unlike trees (point POIs in the data), grass has no
 * source features — there's nothing in OSM that says "a tuft of grass is here."
 * So we *scatter* it ourselves: triangulate the green landuse polygons (parks,
 * gardens, meadows, sports pitches) and sprinkle blade points across them at a
 * roughly constant density, jittered by a tile-seeded PRNG so a field stays put
 * across reloads instead of shimmering. The {@link GrassLayer} expands each
 * point into a camera-facing billboard tuft and the vertex shader bends the
 * tips in a travelling wind wave.
 */
const LANDUSE_LAYERS = ['landuse', 'osm_landuse_detail'];

/** One blade per this many m² of green space. Lower = lusher + heavier. */
const AREA_PER_BLADE = 9;

/** Hard cap so a giant park doesn't spawn a quarter-million billboards. */
const MAX_GRASS_PER_TILE = 4000;

/** Deterministic PRNG (mulberry32) so scatter is stable across tile reloads. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Metres of bare margin kept clear of grass along every polygon edge, so a
 *  field stops short of the water/beach/road boundaries instead of spilling
 *  right up to them. */
const GRASS_EDGE_INSET = 5;

interface Pt { x: number; z: number; }
/** A paved/walkable area grass must avoid, with a bbox for a cheap pre-test. */
interface Exclusion { rings: Pt[][]; minX: number; minZ: number; maxX: number; maxZ: number; }

/** Green landuse kinds that earn a grass scatter. */
function isGrassy(props: VectorTileFeature['properties']): boolean {
  const kind = String(props.kind ?? props.landuse ?? props.leisure ?? props.natural ?? '').toLowerCase();
  return (
    kind === 'grass' ||
    kind === 'meadow' ||
    kind === 'pitch' ||
    kind === 'park' ||
    kind === 'garden' ||
    kind === 'cemetery' ||
    kind === 'scrub'
  );
}

/** Paved/walkable kinds that grass should stay OFF (plazas, paths, platforms). */
function isPedestrian(props: VectorTileFeature['properties']): boolean {
  const kind = String(props.kind ?? props.landuse ?? props.leisure ?? props.natural ?? props.highway ?? '').toLowerCase();
  return (
    kind === 'pedestrian' ||
    kind === 'footway' ||
    kind === 'path' ||
    kind === 'platform' ||
    kind === 'plaza'
  );
}

/** Project an MVT polygon (rings of {x,y}) into world {x,z} rings. */
function toWorldRings(
  polygon: Array<Array<{ x: number; y: number }>>,
  t: ReturnType<typeof buildTileToWorld>
): Pt[][] {
  return polygon.map((ring) =>
    ring.map((p) => ({
      x: t.worldOffsetX + p.x * t.scalePerExtentX,
      z: -(t.worldOffsetY - p.y * t.scalePerExtentY)
    }))
  );
}

export function extractGrass(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const rand = mulberry32((z * 73856093) ^ (tx * 19349663) ^ (ty * 83492791));

  const xs: number[] = [];
  const zs: number[] = [];
  const scales: number[] = [];
  const phases: number[] = [];

  // First gather the grassy fields and the paved exclusion zones, so a single
  // pass can scatter grass while avoiding the boundaries AND the walkways.
  const fields: Pt[][][] = [];
  const exclusions: Exclusion[] = [];
  for (const name of LANDUSE_LAYERS) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('Polygon')) continue;
      const grassy = isGrassy(f.properties);
      const paved = !grassy && isPedestrian(f.properties);
      if (!grassy && !paved) continue;

      const grouped = classifyRings(f.loadGeometry());
      for (const polygon of grouped) {
        const rings = toWorldRings(polygon, t);
        if (grassy) {
          fields.push(rings);
        } else {
          const outer = rings[0];
          if (!outer || outer.length < 3) continue;
          let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
          for (const p of outer) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
          }
          exclusions.push({ rings, minX, minZ, maxX, maxZ });
        }
      }
    }
  }

  for (const rings of fields) {
    if (xs.length >= MAX_GRASS_PER_TILE) break;
    scatterPolygon(rings, exclusions, rand, xs, zs, scales, phases);
  }

  const count = xs.length;
  if (count === 0) return null;

  const positions = new Float32Array(count * 3);
  const scaleAttr = new Float32Array(count);
  const phaseAttr = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = xs[i];
    positions[i * 3 + 1] = 0; // base on the ground; the billboard grows up
    positions[i * 3 + 2] = zs[i];
    scaleAttr[i] = scales[i];
    phaseAttr[i] = phases[i];
  }

  return {
    positions,
    indices: new Uint32Array(0),
    attributes: { scale: scaleAttr, phase: phaseAttr }
  };
}

/**
 * Triangulate one (world-coord) polygon and scatter blade points across its
 * triangles at AREA_PER_BLADE density. Each candidate is rejected if it falls
 * within GRASS_EDGE_INSET of the field's boundary (keeps grass off the
 * water/beach/road edges) or inside any paved exclusion zone (walking paths /
 * plazas).
 */
function scatterPolygon(
  rings: Pt[][],
  exclusions: Exclusion[],
  rand: () => number,
  xs: number[],
  zs: number[],
  scales: number[],
  phases: number[]
): void {
  const flat: number[] = [];
  const holeIndices: number[] = [];
  let vertexCount = 0;
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(vertexCount);
    for (const p of rings[r]) {
      flat.push(p.x, p.z);
      vertexCount++;
    }
  }
  if (vertexCount < 3) return;

  const insetSq = GRASS_EDGE_INSET * GRASS_EDGE_INSET;
  const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  for (let k = 0; k < tris.length; k += 3) {
    if (xs.length >= MAX_GRASS_PER_TILE) return;
    const i0 = tris[k] * 2;
    const i1 = tris[k + 1] * 2;
    const i2 = tris[k + 2] * 2;
    const ax = flat[i0], az = flat[i0 + 1];
    const bx = flat[i1], bz = flat[i1 + 1];
    const cx = flat[i2], cz = flat[i2 + 1];
    const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) * 0.5;
    if (!Number.isFinite(area) || area <= 0) continue;

    // Expected blade count for this triangle; fractional part handled
    // stochastically so small triangles still occasionally get a blade.
    const n = area / AREA_PER_BLADE;
    let whole = Math.floor(n);
    if (rand() < n - whole) whole++;
    for (let j = 0; j < whole; j++) {
      if (xs.length >= MAX_GRASS_PER_TILE) return;
      // Uniform random point in the triangle via reflected barycentric coords.
      let u = rand();
      let v = rand();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const px = ax + u * (bx - ax) + v * (cx - ax);
      const pz = az + u * (bz - az) + v * (cz - az);
      if (nearBoundary(px, pz, rings, insetSq)) continue; // keep off the edges
      if (insideAnyExclusion(px, pz, exclusions)) continue; // keep off walkways
      xs.push(px);
      zs.push(pz);
      scales.push(0.7 + rand() * 0.8); // size variety
      phases.push(rand() * Math.PI * 2); // desync the wind sway per blade
    }
  }
}

/** Squared distance from a point to a segment. */
function distPointSegSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + t * dx);
  const ez = pz - (az + t * dz);
  return ex * ex + ez * ez;
}

/** True if the point is within `insetSq` (squared metres) of any ring edge. */
function nearBoundary(px: number, pz: number, rings: Pt[][], insetSq: number): boolean {
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (distPointSegSq(px, pz, ring[j].x, ring[j].z, ring[i].x, ring[i].z) < insetSq) {
        return true;
      }
    }
  }
  return false;
}

/** Ray-cast point-in-ring on the (x, z) plane. */
function pointInRing(px: number, pz: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, zi = ring[i].z;
    const xj = ring[j].x, zj = ring[j].z;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** True if the point lies inside any paved exclusion polygon (outer ∧ ¬holes). */
function insideAnyExclusion(px: number, pz: number, exclusions: Exclusion[]): boolean {
  for (const ex of exclusions) {
    if (px < ex.minX || px > ex.maxX || pz < ex.minZ || pz > ex.maxZ) continue;
    if (!pointInRing(px, pz, ex.rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < ex.rings.length; h++) {
      if (pointInRing(px, pz, ex.rings[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}
