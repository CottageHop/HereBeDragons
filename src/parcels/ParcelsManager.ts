import * as THREE from 'three';
import earcut from 'earcut';
import Pbf from 'pbf';
import { VectorTile, VectorTileFeature, type VectorTileLayer, classifyRings } from '@mapbox/vector-tile';
import type { Projection } from '../core/Projection.js';
import type { MapCameraController } from '../controls/MapCameraController.js';
import type { Renderer } from '../rendering/Renderer.js';
import { PMTilesSource } from '../tiles/PMTilesSource.js';
import { lonLatToTile, tileKey } from '../core/TileId.js';
import { buildTileToWorld } from '../tiles/worker/extractors/shared/mercator.js';
import type { ParcelClickEvent, ParcelClickListener, ParcelsConfig } from './types.js';
import { logger } from '../util/log.js';

/** MVT layer name carrying the parcel polygons (see the archive metadata). */
const PARCEL_MVT_LAYER = 'parcels';
/** Property whose value is the stable parcel identifier. */
const PARCEL_ID_KEY = 'parcel_id';

/** Defaults mirror the documented option defaults in types.ts. */
const DEFAULT_LINE_COLOR = '#374151';
const DEFAULT_FILL_OPACITY = 0;
const DEFAULT_MIN_ZOOM = 15;
/**
 * Elevation (m) of the parcel overlay above the ground plane. High enough to
 * clear water (y = -1) and landuse fills, low enough to read as
 * ground-attached. Outlines sit a hair above the fill so they never z-fight.
 */
const FILL_Y = 2.0;
const LINE_Y = 2.2;

/**
 * Chebyshev radius (in tiles) of the load window around the camera target.
 * Parcels are an overlay drawn only when zoomed in (minZoom default 15), so a
 * small window covers the viewport with headroom for a pan.
 */
const TILE_WINDOW_RADIUS = 3;
/** Cap on concurrent parcel-tile fetches. */
const MAX_IN_FLIGHT = 6;
/** How far the camera can drift before a queued / cached tile is dropped. */
const KEEP_RADIUS = TILE_WINDOW_RADIUS + 2;

const CLICK_PX_THRESHOLD = 5;
const CLICK_MS_THRESHOLD = 500;

/** Per-parcel record retained for picking. */
interface ParcelRecord {
  id: string;
  properties: Record<string, string | number | boolean>;
}

/** Everything one loaded parcel tile owns in the scene. */
interface ParcelTile {
  key: string;
  group: THREE.Group;
  fillMesh: THREE.Mesh | null;
  lineSegments: THREE.LineSegments | null;
  fillGeo: THREE.BufferGeometry | null;
  lineGeo: THREE.BufferGeometry | null;
  /** Parallel to the per-vertex `parcelIndex` attribute on the fill mesh. */
  records: ParcelRecord[];
  tileX: number;
  tileY: number;
}

export interface ParcelsManagerDeps {
  renderer: Renderer;
  scene: THREE.Scene;
  camera: MapCameraController;
  projection: Projection;
  /** Render-on-demand nudge — parcel loads/clicks change the scene without
   *  moving the camera, so the RAF loop needs a poke to repaint. */
  onSceneChange?: () => void;
}

/**
 * Self-contained overlay that streams parcel boundary polygons from a SECOND
 * PMTiles archive and renders them as outline "boxes" (optionally faintly
 * filled) above the basemap. Clickable: a pointer click raycasts the parcel
 * fill meshes and fires `onParcelClick` with the hit feature's MVT properties.
 *
 * Independent of the basemap TileManager / decode worker by design — those are
 * tuned for the single basemap source and discard per-feature MVT properties,
 * which parcel picking needs. Parcels are sparse (~tens of polygons per tile)
 * and only drawn when zoomed past `minZoom`, so a simpler main-thread decode
 * loop is the right cost/complexity trade-off.
 */
export class ParcelsManager {
  private readonly renderer: Renderer;
  private readonly scene: THREE.Scene;
  private readonly camera: MapCameraController;
  private readonly projection: Projection;
  private readonly onSceneChange: () => void;

  private readonly source: PMTilesSource;
  private readonly group: THREE.Group;

  private lineMaterial: THREE.LineBasicMaterial;
  private fillMaterial: THREE.MeshBasicMaterial;
  private fillColorExplicit = false;

  private enabled: boolean;
  private minZoom: number;
  private fillOpacity: number;

  private opened = false;
  private disposed = false;

  private readonly tiles = new Map<string, ParcelTile>();
  private readonly pending = new Set<string>();
  private readonly missing = new Set<string>();
  private inFlight = 0;
  private lastCenterX = 0;
  private lastCenterY = 0;
  private hasCenter = false;

  // Picking.
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly clickListeners = new Set<ParcelClickListener>();
  private pointerStartX = 0;
  private pointerStartY = 0;
  private pointerStartTime = 0;
  private pointerDownActive = false;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;

  constructor(deps: ParcelsManagerDeps, config: ParcelsConfig) {
    this.renderer = deps.renderer;
    this.scene = deps.scene;
    this.camera = deps.camera;
    this.projection = deps.projection;
    this.onSceneChange = deps.onSceneChange ?? (() => {});

    this.enabled = config.enabled !== false;
    this.minZoom = config.minZoom ?? DEFAULT_MIN_ZOOM;
    this.fillOpacity = config.fillOpacity ?? DEFAULT_FILL_OPACITY;
    this.fillColorExplicit = config.fillColor !== undefined;

    const lineColor = config.lineColor ?? DEFAULT_LINE_COLOR;
    const fillColor = config.fillColor ?? lineColor;

    this.source = new PMTilesSource(config.pmtilesUrl);

    this.group = new THREE.Group();
    this.group.name = 'hbd-parcels';
    this.group.visible = this.enabled;
    this.scene.add(this.group);

    this.lineMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(lineColor),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      fog: false,
      toneMapped: false
    });
    this.fillMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(fillColor),
      transparent: true,
      opacity: this.fillOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
      toneMapped: false
    });

    // Pointer handlers — distinguish a click from a pan/drag the same way
    // BuildingsManager does, so dragging the map never fires parcel clicks.
    this.onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      this.pointerStartX = e.clientX;
      this.pointerStartY = e.clientY;
      this.pointerStartTime = performance.now();
      this.pointerDownActive = true;
    };
    this.onPointerUp = (e: PointerEvent): void => {
      if (!this.pointerDownActive) return;
      this.pointerDownActive = false;
      if (!this.enabled || this.clickListeners.size === 0) return;
      const dx = e.clientX - this.pointerStartX;
      const dy = e.clientY - this.pointerStartY;
      if (Math.hypot(dx, dy) > CLICK_PX_THRESHOLD) return;
      if (performance.now() - this.pointerStartTime > CLICK_MS_THRESHOLD) return;
      this.handleClick(e);
    };
    this.renderer.dom.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.dom.addEventListener('pointerup', this.onPointerUp);
  }

  /** Open the parcels archive. Safe to call when disabled (it just no-ops
   *  the loop until enabled). Failure is logged, not thrown — a broken
   *  parcel source must never take the basemap down. */
  async open(): Promise<void> {
    try {
      await this.source.open();
      this.opened = true;
    } catch (err) {
      logger.warn('parcels source failed to open:', err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.group.visible = on;
    if (!on) this.clearTiles();
    this.onSceneChange();
  }

  onParcelClick(cb: ParcelClickListener): () => void {
    this.clickListeners.add(cb);
    return () => this.clickListeners.delete(cb);
  }

  setLineColor(color: string): void {
    this.lineMaterial.color.set(color);
    if (!this.fillColorExplicit) this.fillMaterial.color.set(color);
    this.onSceneChange();
  }

  setFillColor(color: string): void {
    this.fillColorExplicit = true;
    this.fillMaterial.color.set(color);
    this.onSceneChange();
  }

  setFillOpacity(opacity: number): void {
    this.fillOpacity = Math.max(0, Math.min(1, opacity));
    this.fillMaterial.opacity = this.fillOpacity;
    for (const t of this.tiles.values()) {
      if (t.fillMesh) t.fillMesh.visible = this.fillOpacity > 0;
    }
    this.onSceneChange();
  }

  setMinZoom(z: number): void {
    this.minZoom = z;
  }

  /**
   * Per-frame tick (called from the RAF loop). Recomputes the visible parcel
   * tile window and kicks off loads. Cheap when disabled, below minZoom, or
   * not yet opened.
   */
  update(): void {
    if (this.disposed || !this.enabled || !this.opened) return;
    const view = this.camera.getView();
    if (view.zoom < this.minZoom) {
      // Zoomed back out below the parcel threshold — drop everything so we
      // don't keep dense parcel geometry resident off-screen.
      if (this.tiles.size > 0) {
        this.clearTiles();
        this.onSceneChange();
      }
      return;
    }

    const z = this.chooseZoom(view.zoom);
    const center = lonLatToTile(view.lon, view.lat, z);
    this.lastCenterX = center.x;
    this.lastCenterY = center.y;
    this.hasCenter = true;

    const n = 2 ** z;
    const r = TILE_WINDOW_RADIUS;
    // Nearest-first so the tile under the camera streams before the corners.
    const candidates: { x: number; y: number; d: number }[] = [];
    for (let x = center.x - r; x <= center.x + r; x++) {
      for (let y = center.y - r; y <= center.y + r; y++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const dx = x - center.x;
        const dy = y - center.y;
        candidates.push({ x, y, d: dx * dx + dy * dy });
      }
    }
    candidates.sort((a, b) => a.d - b.d);

    for (const c of candidates) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      const key = tileKey(z, c.x, c.y);
      if (this.tiles.has(key) || this.pending.has(key) || this.missing.has(key)) continue;
      void this.loadTile(z, c.x, c.y, key);
    }

    this.evictFarTiles(z);
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.dom.removeEventListener('pointerup', this.onPointerUp);
    this.clearTiles();
    this.scene.remove(this.group);
    this.lineMaterial.dispose();
    this.fillMaterial.dispose();
    this.clickListeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internals — tile loading
  // -------------------------------------------------------------------------

  /** Clamp the camera zoom to the archive's available zoom range. */
  private chooseZoom(cameraZoom: number): number {
    const target = Math.round(cameraZoom);
    return Math.max(this.source.minZoom, Math.min(this.source.maxZoom, target));
  }

  private async loadTile(z: number, x: number, y: number, key: string): Promise<void> {
    this.pending.add(key);
    this.inFlight++;
    try {
      const data = await this.source.getTile(z, x, y);
      if (this.disposed) return;
      if (!data) {
        this.missing.add(key);
        return;
      }
      // Camera moved far away while the fetch was in flight — drop it.
      if (!this.isInKeepZone(x, y)) return;
      const tile = this.buildTile(z, x, y, key, data);
      if (tile) {
        this.tiles.set(key, tile);
        this.group.add(tile.group);
        this.onSceneChange();
      } else {
        this.missing.add(key);
      }
    } catch (err) {
      // A parcel-tile failure is non-fatal: log and let a later pass retry.
      logger.warn(`parcel tile ${key} failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      this.pending.delete(key);
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  /**
   * Decode one parcel MVT tile (already decompressed by PMTilesSource) into:
   *  - an outline LineSegments (the "boxes"),
   *  - a fill mesh carrying a per-vertex `parcelIndex` attribute for picking
   *    (visible only when fillOpacity > 0; still raycast either way).
   * Returns null if the tile has no parcel features.
   */
  private buildTile(
    z: number,
    x: number,
    y: number,
    key: string,
    data: ArrayBuffer
  ): ParcelTile | null {
    const tile = new VectorTile(new Pbf(new Uint8Array(data)));
    const layer: VectorTileLayer | undefined = tile.layers[PARCEL_MVT_LAYER];
    if (!layer || layer.length === 0) return null;

    const extent = layer.extent ?? 4096;
    const { lat: originLat, lon: originLon } = this.projection.origin;
    const t = buildTileToWorld(z, x, y, extent, originLat, originLon);

    const fillPositions: number[] = [];
    const fillIndices: number[] = [];
    const fillParcelIndex: number[] = [];
    const linePositions: number[] = [];
    const records: ParcelRecord[] = [];

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== VectorTileFeature.types.indexOf('Polygon')) continue;

      const props = f.properties as Record<string, string | number | boolean>;
      const idVal = props[PARCEL_ID_KEY];
      const id = idVal != null ? String(idVal) : `${key}#${i}`;
      const recordIndex = records.length;
      records.push({ id, properties: props });

      const rings = f.loadGeometry();
      const grouped = classifyRings(rings);
      for (const polygon of grouped) {
        this.addPolygon(polygon, t, recordIndex, fillPositions, fillIndices, fillParcelIndex, linePositions);
      }
    }

    if (records.length === 0 || (fillIndices.length === 0 && linePositions.length === 0)) {
      return null;
    }

    const group = new THREE.Group();
    group.name = `parcel-tile:${key}`;

    let fillMesh: THREE.Mesh | null = null;
    let fillGeo: THREE.BufferGeometry | null = null;
    if (fillIndices.length > 0) {
      fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fillPositions), 3));
      fillGeo.setAttribute('parcelIndex', new THREE.BufferAttribute(new Float32Array(fillParcelIndex), 1));
      fillGeo.setIndex(fillIndices);
      fillGeo.computeBoundingSphere();
      fillMesh = new THREE.Mesh(fillGeo, this.fillMaterial);
      fillMesh.name = `${group.name}:fill`;
      fillMesh.renderOrder = 2;
      // Always present (it's the pick target); only painted when fill is on.
      fillMesh.visible = this.fillOpacity > 0;
      fillMesh.userData.parcelRecords = records;
      group.add(fillMesh);
    }

    let lineSegments: THREE.LineSegments | null = null;
    let lineGeo: THREE.BufferGeometry | null = null;
    if (linePositions.length > 0) {
      lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePositions), 3));
      lineSegments = new THREE.LineSegments(lineGeo, this.lineMaterial);
      lineSegments.name = `${group.name}:lines`;
      lineSegments.renderOrder = 3;
      group.add(lineSegments);
    }

    return {
      key, group, fillMesh, lineSegments, fillGeo, lineGeo, records, tileX: x, tileY: y
    };
  }

  /**
   * Triangulate one polygon (outer ring + holes) into the fill buffers and
   * push its ring edges into the line buffer. `recordIndex` is stamped onto
   * every fill vertex so a raycast hit resolves back to the parcel record.
   */
  private addPolygon(
    polygon: Array<Array<{ x: number; y: number }>>,
    t: ReturnType<typeof buildTileToWorld>,
    recordIndex: number,
    fillPositions: number[],
    fillIndices: number[],
    fillParcelIndex: number[],
    linePositions: number[]
  ): void {
    const flat: number[] = [];
    const holeIndices: number[] = [];
    const baseVertex = fillPositions.length / 3;
    let vertexCount = 0;

    for (let r = 0; r < polygon.length; r++) {
      if (r > 0) holeIndices.push(vertexCount);
      const ring = polygon[r];
      // Outline: one LINE segment per ring edge (closed loop).
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const ax = t.worldOffsetX + a.x * t.scalePerExtentX;
        const az = -(t.worldOffsetY - a.y * t.scalePerExtentY);
        const bx = t.worldOffsetX + b.x * t.scalePerExtentX;
        const bz = -(t.worldOffsetY - b.y * t.scalePerExtentY);
        linePositions.push(ax, LINE_Y, az, bx, LINE_Y, bz);
      }
      // Fill: collect ring vertices for earcut (x, scene_z) + emit 3D verts.
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const x = t.worldOffsetX + p.x * t.scalePerExtentX;
        const zScene = -(t.worldOffsetY - p.y * t.scalePerExtentY);
        flat.push(x, zScene);
        fillPositions.push(x, FILL_Y, zScene);
        fillParcelIndex.push(recordIndex);
        vertexCount++;
      }
    }

    const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);
    // earcut output is CCW in the (x, scene_z) plane → faces -Y; reverse the
    // winding so the fill faces +Y (matches the other polygon extractors).
    for (let i = 0; i < tris.length; i += 3) {
      fillIndices.push(
        baseVertex + tris[i],
        baseVertex + tris[i + 2],
        baseVertex + tris[i + 1]
      );
    }
  }

  private isInKeepZone(x: number, y: number): boolean {
    if (!this.hasCenter) return true;
    const d = Math.max(Math.abs(x - this.lastCenterX), Math.abs(y - this.lastCenterY));
    return d <= KEEP_RADIUS;
  }

  private evictFarTiles(currentZ: number): void {
    if (!this.hasCenter) return;
    for (const [key, tile] of this.tiles) {
      const tz = Number(key.split('/')[0]);
      const far = Math.max(
        Math.abs(tile.tileX - this.lastCenterX),
        Math.abs(tile.tileY - this.lastCenterY)
      );
      if (tz === currentZ && far <= KEEP_RADIUS) continue;
      this.removeTile(key, tile);
    }
  }

  private removeTile(key: string, tile: ParcelTile): void {
    this.group.remove(tile.group);
    tile.fillGeo?.dispose();
    tile.lineGeo?.dispose();
    this.tiles.delete(key);
  }

  private clearTiles(): void {
    for (const [key, tile] of this.tiles) this.removeTile(key, tile);
    this.tiles.clear();
    this.pending.clear();
    // Keep `missing` — those tiles genuinely have no data; re-checking wastes
    // requests. (Cleared only on dispose, via the map's lifetime.)
  }

  // -------------------------------------------------------------------------
  // Internals — picking
  // -------------------------------------------------------------------------

  private handleClick(e: PointerEvent): void {
    if (this.tiles.size === 0) return;
    const rect = this.renderer.dom.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.ndc, this.camera.three);

    const meshes: THREE.Mesh[] = [];
    for (const t of this.tiles.values()) if (t.fillMesh) meshes.push(t.fillMesh);
    if (meshes.length === 0) return;

    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;
    const hit = hits[0];
    const mesh = hit.object as THREE.Mesh;
    const records = mesh.userData.parcelRecords as ParcelRecord[] | undefined;
    if (!records || !hit.face) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const idxAttr = geo.getAttribute('parcelIndex') as THREE.BufferAttribute | undefined;
    if (!idxAttr) return;
    const recordIndex = Math.round(idxAttr.getX(hit.face.a));
    const record = records[recordIndex];
    if (!record) return;

    // Scene world (x, z) → geographic. Scene Z is -mercatorY (see Projection).
    const ll = this.projection.unproject(hit.point.x, -hit.point.z);
    const payload: ParcelClickEvent = {
      id: record.id,
      properties: record.properties,
      lngLat: { lat: ll.lat, lon: ll.lon }
    };
    for (const cb of this.clickListeners) cb(payload);
  }
}
