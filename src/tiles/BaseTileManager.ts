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
 *   - Fixed zoom (default 12) rather than zoom-tracking.
 *   - Only ground + road layers (water / waterways / landuse / roads) are
 *     requested from the worker — buildings, rails, labels are skipped.
 *     Decode is ~10–25 ms per tile vs. ~50–200 ms for a full z14 tile.
 *   - Roads ARE included now (they used to be skipped). The road network is
 *     the single biggest readability win when the underlay is the only thing
 *     on screen — which happens when the main z14 grid is suspended at far
 *     zoom (see TileManager's far-zoom cutoff). The historical objection to
 *     base roads was z11-specific: the archive only tags `is_bridge` at z12+,
 *     so at z11 every bridge looked like a normal road and rendered flat
 *     (the road material's polygon-offset poking it through water) under the
 *     elevated decks the BridgesManager builds. At the z12 base zoom the
 *     roads extractor pulls every `is_bridge` segment OUT of the flat ribbons
 *     and hands it to the BridgesManager as a centerline (which the underlay
 *     ignores), so base roads leave a clean gap where a bridge would be
 *     instead of a flat ribbon under the deck — the objection no longer holds.
 *   - Small cache (32 tiles) — a z12 tile covers ~6× the area of a z14, so a
 *     5×5 working set covers a generously padded tilted viewport, and enough
 *     ground to back the main grid's far-zoom cutoff (when the z14 grid is
 *     ejected the underlay is all that fills the wide viewport).
 *   - Concurrent fetch cap of 2, so the underlay never starves the main
 *     z14 fetch budget.
 *   - No per-tile spawn animation. The underlay should appear as fast as
 *     possible; the z14 plane animates in over it.
 *   - Tiles attach to a separate scene root parented at y = -0.5 m so they
 *     sit cleanly below the z14 plane and the depth test naturally occludes
 *     them anywhere z14 has rendered.
 */

/** Layers requested from the worker for base tiles — ground fill + the road
 *  skeleton. Buildings/rails/labels are omitted for cost. Roads are included
 *  at the z12 base zoom because that's where the archive tags `is_bridge`, so
 *  the roads extractor cleanly separates bridge segments out (see the class
 *  comment) — base roads render correctly without flat ribbons under decks. */
const BASE_LAYERS: LayerName[] = ['water', 'waterways', 'landuse', 'roads'];

const DEFAULT_BASE_ZOOM = 12;
const DEFAULT_BASE_CACHE_CAP = 32;
const MAX_IN_FLIGHT = 4;
/** Working-set padding around the camera target tile, in z-tile units. A
 *  z12 tile is ~1/6 the ground footprint of a z11, so PAD 2 (5×5) restores
 *  the coverage the old z11 PAD 1 (3×3) gave AND extends it — enough to fill
 *  the wide viewport when the main grid is suspended at far zoom. */
const PAD = 2;
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
  /** `queued`: decoded, waiting in `applyQueue` for the next `update()` to build it. */
  status: 'fetching' | 'decoding' | 'queued';
}

/** A decoded base tile waiting to be built (see `update`). */
interface QueuedBuild {
  z: number;
  x: number;
  y: number;
  geometries: Partial<Record<LayerName, LayerGeometry | null>>;
  /** `performance.now()` when it was queued (the burst drain coalesces by age). */
  queuedAt: number;
}

/** Burst: how long a decoded tile waits for the rest of its streaming batch before building anyway.
 *  Long, because under the splat overlay the underlay is not seen at all. */
const BURST_COALESCE_MS = 1200;

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
  /** The last dispatch left wanted tiles unrequested (no free slot). */
  private moreToDispatch = false;
  /** `burst` on the last `update()`: slots are refilled as soon as a fetch completes, so the whole
   *  working set streams in one go and builds (and redraws) once. */
  private eager = false;
  /** Decoded tiles waiting to be built on the next `update()` (never from the worker callback:
   *  a build is a GPU upload and a redraw, and belongs to the frame, not to whenever a worker
   *  message happens to land). */
  private readonly applyQueue: QueuedBuild[] = [];
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
   * Per-frame tick. Decoded tiles are built here (every frame they are waiting), then — every
   * DISPATCH_INTERVAL frames, because a z11 working set changes slowly — the visibility recompute
   * and dispatch. A build calls the parent's `onSceneChange` (render-on-demand).
   *
   * `burst`: the splat overlay is resident, so every redraw re-rasterises a million splats — a
   * decoded tile then waits up to BURST_COALESCE_MS for the rest of its batch while fetches and
   * decodes are still in flight, and the batch builds (and redraws) once. Measured on an Intel Iris
   * at 2x: base tiles landing one at a time cost a 130–170 ms frame each, ~7 of them over the
   * seconds after a load, on a map standing still.
   */
  update(forced = false, burst = false): void {
    if (this.disposed) return;
    this.eager = burst;
    this.drainBuilds(burst);
    this.frameCount++;
    if (!forced && this.frameCount % DISPATCH_INTERVAL !== 0) return;
    this.dispatch();
  }

  /** The working-set recompute and fetch dispatch for the current view (see `update`). */
  private dispatch(): void {
    this.moreToDispatch = false;
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
          this.moreToDispatch = true;
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
        z, x, y, data, originLat, originLon, BASE_LAYERS, false,
        (response) => {
          if (this.disposed) return;
          this.pending.set(key, { status: 'queued' });
          this.applyQueue.push({
            z: response.z, x: response.x, y: response.y, geometries: response.geometries, queuedAt: performance.now()
          });
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
      // Eager (overlay resident): refill the slot now rather than at the next sweep, so the
      // working set arrives as one batch instead of two tiles every ten frames.
      if (this.eager && this.moreToDispatch && !this.disposed) this.dispatch();
    }
  }

  /** Build what has decoded (see `update`). */
  private drainBuilds(burst: boolean): void {
    if (this.applyQueue.length === 0) return;
    if (burst && this.decodesAhead() && performance.now() - this.applyQueue[0].queuedAt < BURST_COALESCE_MS) return;
    for (const item of this.applyQueue.splice(0)) this.applyPhase(item.z, item.x, item.y, item.geometries);
  }

  /** More builds are on their way to `applyQueue`: tiles fetching or decoding, or wanted tiles
   *  the last dispatch had no slot for yet. */
  private decodesAhead(): boolean {
    if (this.inFlightFetches > 0 || this.moreToDispatch) return true;
    for (const p of this.pending.values()) if (p.status !== 'queued') return true;
    return false;
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
      let geom = geometries[layerName];
      if (!geom) continue;
      const layer = this.deps.layers.get(layerName);
      if (!layer) continue;
      // The roads layer registers its centerlines into two GLOBAL pipelines
      // keyed off the geometry: `bridges` → the BridgesManager (BRIDGE_GROUPS
      // + bridgeVersion), and `lines` → ROAD_GROUPS, which the BridgesManager
      // reads to find where decks meet the ground AND the CarsLayer reads to
      // spawn traffic. The underlay must feed NEITHER: it would build arched
      // decks from coarse z12 tiles (duplicating / z-fighting the main z14
      // decks, and floating once the main grid is suspended at far zoom),
      // pollute the deck ground-connection search with z12 endpoints, and
      // spawn a second set of cars along the coarse roads. Strip both so base
      // roads are purely flat visual ribbons. (Ribbon rendering uses
      // `submeshes`, untouched — only the registration data is dropped;
      // bridges become small gaps, invisible at the wide zooms where the
      // underlay is the only content.)
      if (layerName === 'roads' && (geom.bridges || geom.lines)) {
        geom = { ...geom, bridges: undefined, lines: undefined };
      }
      const obj = layer.build(geom);
      // Render BEFORE z14 tiles (renderOrder defaults to 0). Combined with
      // the BASE_Y_OFFSET, this guarantees z14 painted pixels overwrite the
      // base anywhere they overlap, while gaps in the streaming z14 grid
      // show the base color.
      //
      // The underlay also opts OUT of the tile reveal: it is exactly what
      // should show where the main grid's rounded union has not reached yet,
      // so its meshes swap to the materials' unmasked twins (the layers hand
      // out the shared, masked ones).
      const materials = this.deps.scene.materials;
      obj.traverse((node) => {
        node.renderOrder = -1;
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => materials.unmaskedTwin(m))
          : materials.unmaskedTwin(mesh.material);
      });
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
    this.applyQueue.length = 0;
    this.pending.clear();
    this.missing.clear();
    this.failCounts.clear();
    this.retryAfter.clear();
    this.inFlightFetches = 0;
    this.deps.scene.three.remove(this.root);
  }
}
