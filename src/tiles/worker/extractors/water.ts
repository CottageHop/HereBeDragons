import earcut from 'earcut';
import { VectorTileFeature, type VectorTileLayer, classifyRings } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

const WATER_LAYER_NAMES = ['water', 'osm_natural_areas'];
const WATER_Y = -1.0;

export function extractWater(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const positions: number[] = [];
  const indices: number[] = [];

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
        if (kind !== 'water' && kind !== 'bay' && kind !== 'beach' && kind !== '') continue;
        if (kind === 'beach') continue; // handled by future BeachesLayer
      }

      const rings = f.loadGeometry();
      const grouped = classifyRings(rings);
      for (const polygon of grouped) {
        triangulatePolygon(polygon, t, positions, indices, WATER_Y);
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

function triangulatePolygon(
  polygon: Array<Array<{ x: number; y: number }>>,
  t: ReturnType<typeof buildTileToWorld>,
  positions: number[],
  indices: number[],
  yPlane: number
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
      // Pass scene_z to earcut so winding convention matches building roofs.
      flat.push(x, z);
      positions.push(x, yPlane, z);
      vertexCount++;
    }
  }

  const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
  // Earcut output is always CCW in input plane → faces -Y in 3D when input is
  // (x, scene_z). Reverse winding so the polygon faces +Y.
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
