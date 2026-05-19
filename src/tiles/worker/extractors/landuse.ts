import earcut from 'earcut';
import { VectorTileFeature, type VectorTileLayer, classifyRings } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

const LANDUSE_LAYERS = ['landuse', 'osm_landuse_detail'];

// Stack landuse classes at clearly different Y values so the depth buffer
// can resolve them at any view distance. Total range is ~1.2m — invisible
// when looking straight down, mild stepping at extreme tilt at high zoom.
// Combined with palette polygonOffset, this fully decouples landuse layers.
// Order (top → bottom): grass, park, wood, urban; sand sits below water for
// the wet-sand-under-water beach effect.
const LANDUSE_Y_BY_CLASS: Record<number, number> = {
  0: -2.20, // Other (unused)
  1: -1.90, // Park
  2: -1.10, // Wood (under park)
  3: -1.60, // Grass (above park, just below water)
  4: -1.30, // Sand (just below water at -1.0)
  5: -2.20  // Urban (lowest landuse — generic fill)
};

/** Encoded class id per vertex — read by the layer to choose palette / shade. */
export enum LanduseClass {
  Other = 0,
  Park = 1,
  Wood = 2,
  Grass = 3,
  Sand = 4,
  Urban = 5
}

export function extractLanduse(
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

  for (const name of LANDUSE_LAYERS) {
    const layer = layersByName[name];
    if (!layer) continue;
    const extent = layer.extent ?? 4096;
    const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('Polygon')) continue;

      const cls = classify(f.properties);
      if (cls === LanduseClass.Other) continue;

      const rings = f.loadGeometry();
      const grouped = classifyRings(rings);
      const yPlane = LANDUSE_Y_BY_CLASS[cls] ?? -1.5;
      for (const polygon of grouped) {
        triangulatePolygon(polygon, t, positions, indices, classes, yPlane, cls);
      }
    }
  }

  if (indices.length === 0) return null;
  const vertexCount = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: makeFlatUpNormals(vertexCount),
    attributes: {
      class: new Uint8Array(classes)
    }
  };
}

function classify(props: VectorTileFeature['properties']): LanduseClass {
  const kindRaw = props.kind ?? props.landuse ?? props.leisure ?? props.natural ?? '';
  const kind = String(kindRaw).toLowerCase();
  if (kind === 'park' || kind === 'garden' || kind === 'cemetery') return LanduseClass.Park;
  if (kind === 'wood' || kind === 'forest' || kind === 'scrub') return LanduseClass.Wood;
  if (kind === 'grass' || kind === 'meadow' || kind === 'pitch') return LanduseClass.Grass;
  if (kind === 'sand' || kind === 'beach') return LanduseClass.Sand;
  if (kind === 'residential' || kind === 'commercial' || kind === 'industrial' || kind === 'retail') return LanduseClass.Urban;
  return LanduseClass.Other;
}

function triangulatePolygon(
  polygon: Array<Array<{ x: number; y: number }>>,
  t: ReturnType<typeof buildTileToWorld>,
  positions: number[],
  indices: number[],
  classes: number[],
  yPlane: number,
  cls: LanduseClass
): void {
  const flat: number[] = [];
  const holeIndices: number[] = [];
  const baseVertexIndex = positions.length / 3;
  let vertexCount = 0;

  for (let r = 0; r < polygon.length; r++) {
    if (r > 0) holeIndices.push(vertexCount);
    const ring = polygon[r];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const x = t.worldOffsetX + p.x * t.scalePerExtentX;
      const z = -(t.worldOffsetY - p.y * t.scalePerExtentY);
      flat.push(x, z);
      positions.push(x, yPlane, z);
      classes.push(cls);
      vertexCount++;
    }
  }

  const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  // Reverse winding — see comment in water.ts.
  for (let i = 0; i < tris.length; i += 3) {
    indices.push(
      baseVertexIndex + tris[i],
      baseVertexIndex + tris[i + 2],
      baseVertexIndex + tris[i + 1]
    );
  }
}

function makeFlatUpNormals(vertexCount: number): Float32Array {
  const n = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) n[i * 3 + 1] = 1;
  return n;
}
