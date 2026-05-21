/// <reference lib="webworker" />
import Pbf from 'pbf';
import { VectorTile, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerName } from '../../types.js';
import type {
  DecodePhase,
  DecodeRequest,
  DecodeResponse,
  DecodeErrorResponse,
  LayerGeometry
} from './decodeProtocol.js';
import { extractWater } from './extractors/water.js';
import { extractWaterways } from './extractors/waterways.js';
import { extractLanduse } from './extractors/landuse.js';
import { extractRoads } from './extractors/roads.js';
import { extractRails } from './extractors/rails.js';
import { extractBuildings } from './extractors/buildings.js';
import { extractLabels } from './extractors/labels.js';
import { extractTrees } from './extractors/trees.js';
import { splitByClass } from './shared/splitByClass.js';

/** Layers whose extractors emit a per-vertex `class` attribute. */
const CLASS_SPLIT_LAYERS: readonly LayerName[] = ['landuse', 'roads', 'rails'];

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const req = e.data;
  if (req.type !== 'decode') return;
  try {
    decodeTile(req);
  } catch (err) {
    const errResponse: DecodeErrorResponse = {
      type: 'error',
      requestId: req.requestId,
      z: req.z,
      x: req.x,
      y: req.y,
      message: err instanceof Error ? err.message : String(err)
    };
    ctx.postMessage(errResponse);
  }
};

/**
 * Decode a tile in TWO phases — base layers (cheap) first, buildings (slow)
 * second. Each phase posts its own message back to the main thread so the
 * scene can paint the base map without waiting on the building union-find.
 *
 * The MVT parse happens once and `layersByName` is reused across phases.
 * Both messages share the same `requestId`; `final: true` on the buildings
 * phase tells the pool to release the pending entry.
 */
function decodeTile(req: DecodeRequest): void {
  const pbf = new Pbf(new Uint8Array(req.data));
  const tile = new VectorTile(pbf);

  const layersByName: Record<string, VectorTileLayer> = {};
  for (const name of Object.keys(tile.layers)) {
    layersByName[name] = tile.layers[name];
  }

  const wanted = new Set<LayerName>(req.layers);
  const wantsBuildings = wanted.has('buildings');

  // ----- Phase 1: base layers (water, waterways, landuse, roads, rails, labels) -----
  const base: Partial<Record<LayerName, LayerGeometry | null>> = {};
  if (wanted.has('water')) {
    base.water = extractWater(req.z, req.x, req.y, layersByName, req.originLat, req.originLon);
  }
  if (wanted.has('waterways')) {
    base.waterways = extractWaterways(req.z, req.x, req.y, layersByName, req.originLat, req.originLon);
  }
  if (wanted.has('landuse')) {
    base.landuse = extractLanduse(req.z, req.x, req.y, layersByName, req.originLat, req.originLon);
  }
  if (wanted.has('roads')) {
    base.roads = extractRoads(req.z, req.x, req.y, layersByName, req.originLat, req.originLon);
  }
  if (wanted.has('rails')) {
    base.rails = extractRails(req.z, req.x, req.y, layersByName, req.originLat, req.originLon);
  }
  if (wanted.has('labels')) {
    base.labels = extractLabels(req.z, req.x, req.y, layersByName, req.originLat, req.originLon);
  }
  if (wanted.has('trees')) {
    base.trees = extractTrees(req.z, req.x, req.y, layersByName, req.originLat, req.originLon);
  }
  // Pre-split class-keyed layers in the worker so the main thread doesn't
  // have to walk the index buffer + remap vertices during apply.
  for (const name of CLASS_SPLIT_LAYERS) {
    const g = base[name];
    if (g) g.submeshes = splitByClass(g);
  }
  // `final: !wantsBuildings` — if buildings layer is disabled there's no
  // phase 2 to wait for, so the base message also doubles as the final one.
  postPhase(req, base, 'base', !wantsBuildings);

  // ----- Phase 2: buildings (the O(n²) one) -----
  if (wantsBuildings) {
    const buildings: Partial<Record<LayerName, LayerGeometry | null>> = {
      buildings: extractBuildings(req.z, req.x, req.y, layersByName, req.originLat, req.originLon)
    };
    postPhase(req, buildings, 'buildings', true);
  }
}

function postPhase(
  req: DecodeRequest,
  geometries: Partial<Record<LayerName, LayerGeometry | null>>,
  phase: DecodePhase,
  final: boolean
): void {
  const response: DecodeResponse = {
    type: 'decoded',
    requestId: req.requestId,
    z: req.z,
    x: req.x,
    y: req.y,
    phase,
    final,
    geometries
  };
  const transfers: Transferable[] = [];
  for (const g of Object.values(geometries)) {
    if (!g) continue;
    transfers.push(g.positions.buffer);
    transfers.push(g.indices.buffer);
    if (g.normals) transfers.push(g.normals.buffer);
    if (g.attributes) {
      for (const arr of Object.values(g.attributes)) transfers.push(arr.buffer);
    }
    if (g.submeshes) {
      for (const s of g.submeshes) {
        transfers.push(s.positions.buffer);
        transfers.push(s.indices.buffer);
        if (s.normals) transfers.push(s.normals.buffer);
      }
    }
    if (g.lines) {
      transfers.push(g.lines.positions.buffer);
      transfers.push(g.lines.ranges.buffer);
      transfers.push(g.lines.classes.buffer);
    }
    if (g.bridges) {
      transfers.push(g.bridges.positions.buffer);
      transfers.push(g.bridges.ranges.buffer);
      transfers.push(g.bridges.classes.buffer);
    }
    if (g.tunnels) {
      transfers.push(g.tunnels.positions.buffer);
      transfers.push(g.tunnels.indices.buffer);
      transfers.push(g.tunnels.dashU.buffer);
      transfers.push(g.tunnels.dashV.buffer);
    }
  }
  ctx.postMessage(response, transfers);
}
