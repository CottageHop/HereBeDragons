import * as THREE from 'three';
import type { Projection } from '../core/Projection.js';
import type { SceneRoot } from '../scene/SceneRoot.js';
import type { LayerRegistry } from '../scene/LayerRegistry.js';
import type { PMTilesSource } from './PMTilesSource.js';
import type { TileWorkerPool } from './TileWorkerPool.js';
import type { MapCameraController } from '../controls/MapCameraController.js';
import { TileCache } from './TileCache.js';
import { TileGroup } from '../scene/TileGroup.js';
import { lonLatToTile, tileKey } from '../core/TileId.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from './worker/decodeProtocol.js';
import { logger } from '../util/log.js';

/**
 * Low-resolution base-layer tile manager. Loads coarse tiles (default z=11)
 * from the same PMTiles archive and renders them BENEATH the high-resolution
 * z14 tile plane so the screen is never blank while z14 streams in.
 *
 * Mirrors PolyMap's `BaseTileManager` (src/tiles.rs). Differences from the
 * main TileManager:
 *   - Fixed zoom (default 11) rather than zoom-tracking.
 *   - Only base layers (water / waterways / landuse / roads) are requested
 *     from the worker — buildings, rails and labels are skipped. Decode is
 *     ~5–15 ms per tile vs. ~50–200 ms for a full z14 tile.
 *   - Far smaller cache (16 tiles) — a z11 tile covers ~25× the area of a
 *     z14, so a 3×3 working set already covers a tilted viewport with pad.
 *   - Concurrent fetch cap of 2, so the underlay never starves the main
 *     z14 fetch budget.
 *   - No per-tile spawn animation. The underlay should appear as fast as
 *     possible; the z14 plane animates in over it.
 *   - Tiles attach to a separate scene root parented at y = -0.5 m so they
 *     sit cleanly below the z14 plane and the depth test naturally occludes
 *     them anywhere z14 has rendered.
 */

/** Layers requested from the worker for base tiles. Equivalent to PolyMap's
 *  DetailLevel::Low. Buildings/rails/labels are intentionally omitted. */
const BASE_LAYERS: LayerName[] = ['water', 'waterways', 'landuse', 'roads'];

const DEFAULT_BASE_ZOOM = 11;
const DEFAULT_BASE_CACHE_CAP = 16;
const MAX_IN_FLIGHT = 2;
/** Working-set padding around the camera target tile, in z-tile units. */
const PAD = 1;
/** Y-offset for the base scene root. Far below the z14 plane (whose deepest
 *  features sit ~y = −0.005) so depth-test occlusion is unambiguous from
 *  any reasonable tilt, and well above any underground feature so we don't
 *  poke through. */
const BASE_Y_OFFSET = -0.5;
/**
 * Run the dispatch / evict pass every Nth RAF tick. Z11 tiles cover ~25× the
 * area of a z14, so the working set really does change slowly — but we want
 * the FIRST dispatch out the door fast so the underlay paints before the
 * z14 stream arrives. 10 ≈ 6 Hz at 60 FPS: snappy on initial paint and
 * during long pans, still well under the main TileManager's rate so it
 * doesn't compete for main-thread time. (Was 30 ≈ 2 Hz — adequate but the
 * initial paint cost a noticeable ~500 ms before the first underlay tile
 * was even fetched.)
 */
const DISPATCH_INTERVAL = 10;
/** Retry / backoff parameters mirror TileManager but at a smaller scale. */
const MAX_TILE_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;

export interface BaseTileManagerDeps {
  source: PMTilesSource;
  workerPool: TileWorkerPool;
  projection: Projection;
  scene: SceneRoot;
  layers: LayerRegistry;
  camera: MapCameraController;
  /** Zoom level for base tiles. Default 11. Clamped to the archive's
   *  [minZoom, maxZoom] range so we don't ask for tiles that don't exist. */
  zoom?: number;
  /** Called when a base tile has been attached to the scene. The host uses
   *  this to bump its render-on-demand flag — without it, the new base mesh
   *  would sit in the scene graph until something else (a camera move, a
   *  z14 tile build) triggered a render. */
  onSceneChange?: () => void;
}

interface PendingState {
  status: 'fetching' | 'decoding';
}

export class BaseTileManager {
  private cache: TileCache;
  private pending = new Map<string, PendingState>();
  private missing = new Set<string>();
  private failCounts = new Map<string, number>();
  private retryAfter = new Map<string, number>();
  private disposed = false;
  private readonly zoom: number;
  private inFlightFetches = 0;
  private frameCount = 0;
  /** Scene group that holds every base tile. Parented under SceneRoot.three. */
  private readonly root: THREE.Group;

  constructor(private deps: BaseTileManagerDeps) {
    this.cache = new TileCache(DEFAULT_BASE_CACHE_CAP, (tile) => {
      this.root.remove(tile);
      tile.dispose();
    });
    const requested = deps.zoom ?? DEFAULT_BASE_ZOOM;
    this.zoom = Math.min(
      Math.max(requested, deps.source.minZoom),
      deps.source.maxZoom
    );
    this.root = new THREE.Group();
    this.root.name = 'BaseTilesRoot';
    this.root.position.y = BASE_Y_OFFSET;
    deps.scene.three.add(this.root);
  }

  /** Force a first dispatch on construction so the underlay is in-flight
   *  before the first tile of the main pipeline returns. */
  start(): void {
    this.update(true);
  }

  /**
   * Per-frame tick. Most frames are no-ops: the heavy visibility recompute
   * runs every DISPATCH_INTERVAL frames because a z11 working set changes
   * slowly. Returns false — base-tile arrival is signalled via the worker
   * pool's onPhase, which calls into the parent's needsRender path itself.
   */
  update(forced = false): void {
    if (this.disposed) return;
    this.frameCount++;
    if (!forced && this.frameCount % DISPATCH_INTERVAL !== 0) return;

    const view = this.deps.camera.getView();
    const center = lonLatToTile(view.lon, view.lat, this.zoom);
    const n = 2 ** this.zoom;
    const xLo = Math.max(0, center.x - PAD);
    const xHi = Math.min(n - 1, center.x + PAD);
    const yLo = Math.max(0, center.y - PAD);
    const yHi = Math.min(n - 1, center.y + PAD);

    const now = performance.now();
    for (let x = xLo; x <= xHi; x++) {
      for (let y = yLo; y <= yHi; y++) {
        const key = tileKey(this.zoom, x, y);
        if (this.missing.has(key)) continue;
        if (this.cache.has(this.zoom, x, y)) continue;
        if (this.pending.has(key)) continue;
        const attempts = this.failCounts.get(key) ?? 0;
        if (attempts >= MAX_TILE_RETRIES) continue;
        const wait = this.retryAfter.get(key);
        if (wait != null && wait > now) continue;
        if (this.inFlightFetches >= MAX_IN_FLIGHT) {
          this.evict(center.x, center.y);
          return;
        }
        void this.loadTile(this.zoom, x, y);
      }
    }

    this.evict(center.x, center.y);
  }

  private async loadTile(z: number, x: number, y: number): Promise<void> {
    const key = tileKey(z, x, y);
    this.pending.set(key, { status: 'fetching' });
    this.inFlightFetches++;
    try {
      const data = await this.deps.source.getTile(z, x, y);
      if (this.disposed) return;
      if (!data) {
        this.pending.delete(key);
        this.missing.add(key);
        return;
      }
      this.pending.set(key, { status: 'decoding' });
      this.failCounts.delete(key);
      this.retryAfter.delete(key);
      const { lat: originLat, lon: originLon } = this.deps.projection.origin;
      await this.deps.workerPool.decode(
        z, x, y, data, originLat, originLon, BASE_LAYERS,
        (response) => {
          if (this.disposed) return;
          this.applyPhase(response.z, response.x, response.y, response.geometries);
        }
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const attempts = (this.failCounts.get(key) ?? 0) + 1;
      this.failCounts.set(key, attempts);
      const backoff = BACKOFF_BASE_MS * Math.pow(2, Math.min(attempts - 1, 5));
      this.retryAfter.set(key, performance.now() + backoff);
      this.pending.delete(key);
      logger.warn(`base tile ${key} failed (attempt ${attempts}/${MAX_TILE_RETRIES}):`, error.message);
    } finally {
      this.inFlightFetches = Math.max(0, this.inFlightFetches - 1);
    }
  }

  private applyPhase(
    z: number, x: number, y: number,
    geometries: Partial<Record<LayerName, LayerGeometry | null>>
  ): void {
    const key = tileKey(z, x, y);
    let tile = this.cache.get(z, x, y);
    if (!tile) {
      tile = new TileGroup(z, x, y);
      this.cache.set(z, x, y, tile);
      this.root.add(tile);
    }
    for (const layerName of BASE_LAYERS) {
      const geom = geometries[layerName];
      if (!geom) continue;
      const layer = this.deps.layers.get(layerName);
      if (!layer) continue;
      const obj = layer.build(geom);
      // Render BEFORE z14 tiles (renderOrder defaults to 0). Combined with
      // the BASE_Y_OFFSET, this guarantees z14 painted pixels overwrite the
      // base anywhere they overlap, while gaps in the streaming z14 grid
      // show the base color.
      obj.traverse((node) => { node.renderOrder = -1; });
      tile.setLayer(layerName, obj);
    }
    this.pending.delete(key);
    this.deps.onSceneChange?.();
  }

  /** Drop cached base tiles whose Chebyshev distance from the camera target
   *  exceeds the working-set window. Z11 tiles are big, so the keep window
   *  is correspondingly small — we don't pay to retain tiles for fast re-pan. */
  private evict(centerX: number, centerY: number): void {
    const keep = PAD + 1;
    const drop: { z: number; x: number; y: number }[] = [];
    for (const [k] of this.cache.entries()) {
      const [zStr, xStr, yStr] = k.split('/');
      const tz = Number(zStr);
      const tx = Number(xStr);
      const ty = Number(yStr);
      if (tz !== this.zoom) {
        drop.push({ z: tz, x: tx, y: ty });
        continue;
      }
      const d = Math.max(Math.abs(tx - centerX), Math.abs(ty - centerY));
      if (d > keep) drop.push({ z: tz, x: tx, y: ty });
    }
    for (const t of drop) this.cache.delete(t.z, t.x, t.y);
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.pending.clear();
    this.missing.clear();
    this.failCounts.clear();
    this.retryAfter.clear();
    this.inFlightFetches = 0;
    this.deps.scene.three.remove(this.root);
  }
}
