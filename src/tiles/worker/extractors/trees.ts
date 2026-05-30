import { VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

/**
 * Individual trees are point features in Protomaps' `pois` layer with
 * `kind: 'tree'` — a dense Lower-Manhattan z15 tile carries ~1880 of them.
 * We emit one point per tree (base at y=0, in scene-world metres) plus a
 * per-tree `scale` attribute; the TreesLayer turns each into a camera-facing
 * billboard sprite, so the heavy lifting (expansion to a quad) happens on the
 * GPU and the worker only ships positions.
 */
const TREE_POI_LAYER = 'pois';

/**
 * Cap on trees emitted per tile. Dense urban tiles hold ~2k tree POIs; past a
 * point they read as a solid green mass anyway, so we stride-sample down to
 * this many to bound the instance count (and the per-tile billboard fill cost)
 * while keeping the trees spatially spread rather than clustered.
 */
const MAX_TREES_PER_TILE = 1500;

/** Stable per-tree size variety, derived from the tile-local integer coords so
 *  it doesn't shimmer between reloads. Returns a multiplier in [0.55, 1.85] —
 *  a wide spread so a stand of trees reads as clearly mixed sizes. */
function scaleFor(x: number, y: number): number {
  // Cheap integer hash → [0, 1). Mixes both coords so a row of street trees
  // doesn't all land on the same size.
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  const u = (h % 1000) / 1000;
  return 0.55 + u * 1.3;
}

/** Stable per-tree positional jitter in scene metres. Trees in a row or a
 *  tight cluster otherwise stack into doubled-bush clumps; nudging each one a
 *  few metres along a hashed angle staggers them so neighbouring canopies read
 *  as separate trees. Deterministic (keyed on tile-local coords) so it doesn't
 *  shimmer between reloads. Radius ~0–3.5 m. */
function jitterFor(x: number, y: number): { dx: number; dz: number } {
  let h = (x * 374761393) ^ (y * 668265263);
  h = (h ^ (h >>> 13)) >>> 0;
  const angle = ((h % 628) / 100); // 0..2π
  const radius = (((h >>> 9) % 100) / 100) * 3.5;
  return { dx: Math.cos(angle) * radius, dz: Math.sin(angle) * radius };
}

export function extractTrees(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const layer = layersByName[TREE_POI_LAYER];
  if (!layer) return null;
  const extent = layer.extent ?? 4096;
  const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

  const xs: number[] = [];
  const zs: number[] = [];
  const scales: number[] = [];

  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== VectorTileFeature.types.indexOf('Point')) continue;
    if (String(f.properties.kind ?? '') !== 'tree') continue;

    const rings = f.loadGeometry();
    if (rings.length === 0 || rings[0].length === 0) continue;
    const p = rings[0][0];

    const j = jitterFor(p.x, p.y);
    xs.push(t.worldOffsetX + p.x * t.scalePerExtentX + j.dx);
    zs.push(-(t.worldOffsetY - p.y * t.scalePerExtentY) + j.dz);
    scales.push(scaleFor(p.x, p.y));
  }

  const total = xs.length;
  if (total === 0) return null;

  // Stride-sample if the tile is over the cap, keeping spatial spread.
  const stride = total > MAX_TREES_PER_TILE ? Math.ceil(total / MAX_TREES_PER_TILE) : 1;
  const count = stride === 1 ? total : Math.ceil(total / stride);

  const positions = new Float32Array(count * 3);
  const scaleAttr = new Float32Array(count);
  let w = 0;
  for (let i = 0; i < total; i += stride) {
    positions[w * 3 + 0] = xs[i];
    positions[w * 3 + 1] = 0; // base sits on the ground; the billboard grows up
    positions[w * 3 + 2] = zs[i];
    scaleAttr[w] = scales[i];
    w++;
  }

  return {
    positions,
    indices: new Uint32Array(0),
    attributes: { scale: scaleAttr }
  };
}
