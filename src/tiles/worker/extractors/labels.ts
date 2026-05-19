import { VectorTileFeature, type VectorTileLayer } from '@mapbox/vector-tile';
import type { LayerGeometry } from '../decodeProtocol.js';
import { buildTileToWorld } from './shared/mercator.js';

/**
 * Place-label hierarchy. Lower values = higher priority (drawn first, biggest).
 * Matches the priority order requested: state > city > suburb > business > street.
 * Phase 1 covers only the `places` MVT layer (cities + neighborhoods).
 */
export enum LabelKind {
  /** Country / state-level (largest, lowest min_zoom). */
  Region = 0,
  /** Cities (kind: 'locality', kind_detail: 'city'). */
  City = 1,
  /** Districts within a city (kind: 'macrohood'). */
  Macrohood = 2,
  /** Suburbs / neighborhoods (kind: 'neighbourhood', also locality+locality). */
  Neighbourhood = 3,
  /** POI / business (deferred to phase 2). */
  Business = 4,
  /** Street label (deferred to phase 3 — curved along road). */
  Street = 5
}

/**
 * Anchor place labels at ground level (y = 0). The shader projects the screen
 * position from this Y but uses a separate, higher elevation for the depth
 * test (so tall buildings can occlude the label without the label visually
 * drifting upward on tilted cameras). See PLACE_VERT in LabelsLayer.ts.
 */
const LABEL_Y = 0;

/** Cap on POI labels emitted per tile. Tiles can contain 800+ named POIs; we
 *  only need the most important ones since collision will hide most anyway,
 *  and creating thousands of canvas textures per tile is expensive. */
const MAX_POIS_PER_TILE = 40;

/** POIs whose min_zoom is past this are skipped entirely (not relevant at any
 *  visible zoom in this app — max camera zoom feeds tile-zoom 15). */
const POI_MAX_MIN_ZOOM = 16;

/** Cap on named-road street labels per tile. Each label creates one character
 *  mesh per character so 50 streets × avg 12 chars = 600 meshes per tile;
 *  enough roads at typical zooms without blowing the draw call budget. */
const MAX_STREETS_PER_TILE = 50;

/** Carried in `metadata.streets` for the LabelsLayer to build curved labels. */
export interface StreetLabelData {
  text: string;
  /** Flat array [x0, z0, x1, z1, ...] of world-space polyline points. */
  polyline: number[];
  minZoom: number;
  /** Kind weight: 0 = highway / major (largest), 1 = minor, 2 = path. */
  weight: number;
}

interface LabelCandidate {
  worldX: number;
  worldZ: number;
  kind: LabelKind;
  minZoom: number;
  priority: number;
  text: string;
}

export function extractLabels(
  z: number,
  tx: number,
  ty: number,
  layersByName: Record<string, VectorTileLayer>,
  originLat: number,
  originLon: number
): LayerGeometry | null {
  const candidates: LabelCandidate[] = [];

  collectPlaces(z, tx, ty, layersByName.places, originLat, originLon, candidates);
  collectPois(z, tx, ty, layersByName.pois, originLat, originLon, candidates);

  const streets = collectStreets(z, tx, ty, layersByName.roads, originLat, originLon);

  if (candidates.length === 0 && streets.length === 0) return null;

  const positions: number[] = [];
  const kinds: number[] = [];
  const minZooms: number[] = [];
  const priorities: number[] = [];
  const texts: string[] = [];

  for (const c of candidates) {
    positions.push(c.worldX, LABEL_Y, c.worldZ);
    kinds.push(c.kind);
    minZooms.push(c.minZoom);
    priorities.push(c.priority);
    texts.push(c.text);
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(0),
    attributes: {
      kind: new Uint8Array(kinds),
      minZoom: new Uint8Array(minZooms),
      priority: new Uint32Array(priorities)
    },
    metadata: { texts, streets }
  };
}

function collectPlaces(
  z: number,
  tx: number,
  ty: number,
  layer: VectorTileLayer | undefined,
  originLat: number,
  originLon: number,
  out: LabelCandidate[]
): void {
  if (!layer) return;
  const extent = layer.extent ?? 4096;
  const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== VectorTileFeature.types.indexOf('Point')) continue;
    const name = f.properties.name;
    if (!name || typeof name !== 'string') continue;

    const kind = classifyPlace(
      String(f.properties.kind ?? ''),
      String(f.properties.kind_detail ?? '')
    );
    if (kind === null) continue;

    const minZoom = Math.max(0, Math.min(22, Math.floor(Number(f.properties.min_zoom ?? 0))));
    const priority = Math.min(0xffffffff, Math.floor(Math.abs(Number(f.properties.population ?? 0))));

    const rings = f.loadGeometry();
    if (rings.length === 0 || rings[0].length === 0) continue;
    const p = rings[0][0];

    out.push({
      worldX: t.worldOffsetX + p.x * t.scalePerExtentX,
      worldZ: -(t.worldOffsetY - p.y * t.scalePerExtentY),
      kind,
      minZoom,
      priority,
      text: name
    });
  }
}

function collectPois(
  z: number,
  tx: number,
  ty: number,
  layer: VectorTileLayer | undefined,
  originLat: number,
  originLon: number,
  out: LabelCandidate[]
): void {
  if (!layer) return;
  const extent = layer.extent ?? 4096;
  const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

  // Pre-collect, sort by importance (lower min_zoom = more important), keep top N.
  const buf: LabelCandidate[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== VectorTileFeature.types.indexOf('Point')) continue;
    const name = f.properties.name;
    if (!name || typeof name !== 'string') continue;

    const minZoom = Math.max(0, Math.min(22, Math.floor(Number(f.properties.min_zoom ?? 0))));
    if (minZoom > POI_MAX_MIN_ZOOM) continue;

    const rings = f.loadGeometry();
    if (rings.length === 0 || rings[0].length === 0) continue;
    const p = rings[0][0];

    // POIs don't have population. Use inverse min_zoom as a priority proxy:
    // earlier-appearing POIs (lower min_zoom) get higher priority value so the
    // collision step keeps them. Tie-break by sort_key if present.
    const sortKey = Number(f.properties.sort_key ?? 0);
    const priority = (POI_MAX_MIN_ZOOM - minZoom) * 1000 + Math.max(0, Math.min(999, Math.abs(sortKey) % 1000));

    buf.push({
      worldX: t.worldOffsetX + p.x * t.scalePerExtentX,
      worldZ: -(t.worldOffsetY - p.y * t.scalePerExtentY),
      kind: LabelKind.Business,
      minZoom,
      priority,
      text: name
    });
  }

  buf.sort((a, b) => b.priority - a.priority);
  for (let i = 0; i < Math.min(MAX_POIS_PER_TILE, buf.length); i++) out.push(buf[i]);
}

function classifyPlace(kind: string, detail: string): LabelKind | null {
  if (kind === 'region' || kind === 'country' || kind === 'state') return LabelKind.Region;
  if (kind === 'locality') {
    if (detail === 'city' || detail === 'town') return LabelKind.City;
    return LabelKind.Neighbourhood;
  }
  if (kind === 'macrohood') return LabelKind.Macrohood;
  if (kind === 'neighbourhood') return LabelKind.Neighbourhood;
  return null;
}

/**
 * Pull named roads as polylines for the layer to turn into curved street
 * labels. Each ring of a LineString feature becomes one StreetLabelData entry;
 * a road with multiple parts gets a label per segment, each placed along its
 * own polyline.
 */
function collectStreets(
  z: number,
  tx: number,
  ty: number,
  layer: VectorTileLayer | undefined,
  originLat: number,
  originLon: number
): StreetLabelData[] {
  if (!layer) return [];
  const extent = layer.extent ?? 4096;
  const t = buildTileToWorld(z, tx, ty, extent, originLat, originLon);

  const out: StreetLabelData[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== VectorTileFeature.types.indexOf('LineString')) continue;
    const name = f.properties.name;
    if (!name || typeof name !== 'string') continue;

    const kind = String(f.properties.kind ?? f.properties.highway ?? '').toLowerCase();
    const classified = classifyRoad(kind);
    if (!classified) continue; // skip paths/service/unnamed kinds

    const lines = f.loadGeometry();
    for (const line of lines) {
      if (line.length < 2) continue;
      // Project to world coords + flatten.
      const polyline: number[] = [];
      for (const p of line) {
        polyline.push(
          t.worldOffsetX + p.x * t.scalePerExtentX,
          -(t.worldOffsetY - p.y * t.scalePerExtentY)
        );
      }
      // Skip very short polylines that won't fit any reasonable label.
      if (polylineLength(polyline) < 40) continue;

      out.push({
        text: name,
        polyline,
        minZoom: classified.minZoom,
        weight: classified.weight
      });
    }
  }

  // Keep the most important first; cap to avoid draw-call explosion.
  out.sort((a, b) => a.weight - b.weight);
  return out.slice(0, MAX_STREETS_PER_TILE);
}

function classifyRoad(kind: string): { minZoom: number; weight: number } | null {
  if (kind === 'highway' || kind === 'motorway' || kind === 'trunk' ||
      kind === 'major_road' || kind === 'primary') {
    return { minZoom: 12, weight: 0 };
  }
  if (kind === 'secondary' || kind === 'tertiary' ||
      kind === 'medium_road' || kind === 'minor_road' ||
      kind === 'residential' || kind === 'unclassified') {
    return { minZoom: 14, weight: 1 };
  }
  // Paths / service / others: skip — they're too small to label cleanly.
  return null;
}

function polylineLength(flat: number[]): number {
  let total = 0;
  for (let i = 2; i < flat.length; i += 2) {
    const dx = flat[i] - flat[i - 2];
    const dz = flat[i + 1] - flat[i - 1];
    total += Math.hypot(dx, dz);
  }
  return total;
}
