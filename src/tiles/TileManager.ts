import * as THREE from 'three';
import type { Projection } from '../core/Projection.js';
import type { SceneRoot } from '../scene/SceneRoot.js';
import type { LayerRegistry } from '../scene/LayerRegistry.js';
import type { PMTilesSource } from './PMTilesSource.js';
import type { TileWorkerPool } from './TileWorkerPool.js';
import type { MapCameraController } from '../controls/MapCameraController.js';
import { TileCache } from './TileCache.js';
import { TileGroup } from '../scene/TileGroup.js';
import { lonLatToTile, lonLatToTileFractional, tileKey } from '../core/TileId.js';
import type { LayerName } from '../types.js';
import { logger } from '../util/log.js';

const DEFAULT_ACTIVE_LAYERS: LayerName[] = ['water', 'waterways', 'landuse', 'roads', 'rails', 'buildings', 'labels'];
/**
 * Safety cap (Chebyshev distance) on tiles loaded around the camera target,
 * regardless of frustum size. Acts as a fallback for near-horizon views
 * where the frustum projection would otherwise want to load very far.
 *
 * 5 z14 tiles ≈ 12 km from the camera target. Paired with the SceneRoot
 * fog density (0.00022, which reaches 99% opacity at ~10 km) the final
 * ring sits well inside the fog so its absence isn't visible — even at
 * extreme tilt-down to the horizon. Was 6 (~14.7 km) → load count drops
 * from up to 169 tiles to up to 121 (~28% fewer tiles per session).
 */
const DEFAULT_TILE_WINDOW_RADIUS = 5;
const DEFAULT_TILE_WINDOW_RADIUS_FAR = 5;
/** Tiles within this Chebyshev distance of camera target dispatch FIRST. */
const DEFAULT_VISIBLE_RADIUS = 3;
/**
 * Max tile builds to apply to the scene per RAF tick. Caps main-thread cost.
 *
 * With 4 workers feeding the apply queue, the front-end build rate is the
 * dominant bottleneck on visible fill time. Each build is a BufferGeometry
 * allocation + ~1–2 ms synchronous GPU buffer upload (bufferData()) on the
 * next render. At 4/frame and 60 FPS that's ~4–8 ms of main-thread time
 * per RAF, comfortably under the 22 ms default `frameBudgetMs` — and when
 * frames DO go over budget the apply queue gates itself automatically.
 *
 * Was 3 → 4: marginal 33% extra fill rate for one more bufferData() per
 * frame. On a slow machine the budget throttle picks up the slack.
 */
const DEFAULT_MAX_BUILDS_PER_FRAME = 4;
/**
 * Run the heavy visibility/dispatch/evict pass every N-th RAF tick.
 *
 * 2 ≈ 30 Hz at 60 FPS — fast enough that a pan dispatches new tiles within
 * ~33 ms of the camera moving (one frame), so peripheral tiles come into
 * view with minimal lag. The previous default of 4 (≈ 15 Hz) meant up to
 * 67 ms of pan latency before new tiles even started fetching. Cost: the
 * visibility recompute (frustum quad + candidate sort + missing/pending
 * skip) runs ~2× as often — but it's a few hundred microseconds per call,
 * still under 1% of the main-thread frame budget.
 */
const DEFAULT_DISPATCH_INTERVAL = 2;
/**
 * Max simultaneous fetches in flight. Without this, the first dispatch sweep
 * after a large pan can fire 30–50 range requests before any complete — the
 * browser's per-host connection limit then serializes them anyway, but with
 * none of them surfacing as cancellable when the camera moves further.
 *
 * 8 (was 6): leaves enough headroom for the 4-worker pool to never sit idle
 * waiting on fetch. With 4 workers + 8 fetches, the worker queue is always
 * ~2 deep — decode starts the instant the previous tile finishes instead of
 * waiting for the next response. PMTiles range requests are tiny (~10–50
 * KB each), so 8 concurrent requests are ~400 KB peak — well within
 * HTTP/2 multiplex limits even on slow connections.
 */
const MAX_IN_FLIGHT = 8;
/**
 * Per-tile retry cap. After this many failures, the tile is parked
 * indefinitely — repeated retries against a broken or missing source just
 * waste bandwidth and obscure real failures in the network panel.
 */
const MAX_TILE_RETRIES = 3;
/**
 * Backoff base (ms). Each retry waits `BACKOFF_BASE_MS * 2^(attempts - 1)`,
 * so attempts 1 / 2 / 3 wait 2s / 4s / 8s respectively. Matches PolyMap's
 * `FAIL_BACKOFF_BASE_SECS = 2.0`.
 */
const BACKOFF_BASE_MS = 2000;
/**
 * Cooldown applied to ALL tile dispatches when a fetch surfaces a 429
 * response. The pmtiles library doesn't expose status codes directly, so
 * we pattern-match the thrown error message for "429" / "rate limit".
 * Matches PolyMap's `RATE_LIMIT_COOLDOWN_SECS = 2.0`.
 */
const RATE_LIMIT_COOLDOWN_MS = 2000;
const RATE_LIMIT_RE = /\b429\b|rate.?limit/i;
/** Tile margin added around the projected camera frustum (in tile units). */
const FRUSTUM_TILE_MARGIN = 1;
/**
 * When the frame budget is blown, the apply queue normally pauses entirely
 * (framerate is prioritized over loading). But a machine slow enough to be
 * over budget even at idle would then never fill the map at all — so we
 * still allow one drain every Nth RAF as a guaranteed trickle.
 *
 * 6 (was 12): drains at ~10 builds/sec on a 60 FPS RAF (was ~5/sec). The
 * frame-budget gate already pauses the FULL `maxBuildsPerFrame` rate; this
 * trickle is just to keep visible progress during sustained over-budget
 * load (e.g. initial load on a weak GPU). Halving the interval means
 * recovery from a budget blip is roughly twice as fast.
 */
const BUDGET_THROTTLE_INTERVAL = 6;
const ZOOM_HYSTERESIS = 0.4;

/**
 * Tile spawn animation — how far below ground each tile/mesh starts (m).
 * 30 m is comfortably visible at typical map zooms (camera at 500–2000 m
 * altitude). Was 8 — almost imperceptible, which made the duration slider
 * feel like it did nothing because you couldn't see the rise either way.
 */
const TILE_SPAWN_DROP = 30;
/**
 * Default tile spawn animation duration (ms) — how long it takes for a
 * newly loaded tile (buildings + roads + landuse + water) to ease from
 * `TILE_SPAWN_DROP` below ground back up to y = 0. Runtime-tunable per
 * map via `TileManager.setSpawnDurationMs()` (and surfaced as
 * `DragonMap.setTileSpawnDurationMs()` / the studio "Pop-up" slider).
 * 0 disables the animation entirely → tiles snap in instantly.
 */
const DEFAULT_TILE_SPAWN_MS = 3000;

export interface TileManagerDeps {
  source: PMTilesSource;
  workerPool: TileWorkerPool;
  projection: Projection;
  scene: SceneRoot;
  layers: LayerRegistry;
  camera: MapCameraController;
  onTileLoad?: (z: number, x: number, y: number) => void;
  onTileError?: (z: number, x: number, y: number, err: Error) => void;
  /**
   * Inner half-width of the visible tile window (square 2r+1 across). Default
   * 10 → 21×21 = 441 tiles always loaded. Reduce on slower devices to cut
   * decode load; expand if you want a wider buffer for fast panning.
   */
  tileWindowRadius?: number;
  /**
   * Outer ring radius for the peripheral buffer (loaded but only edge-corner
   * tiles get clipped). Default 14. Total worst-case tile count is roughly
   * `(2*tileWindowRadiusFar + 1)² − 4 * (tileWindowRadiusFar − tileWindowRadius)²`.
   */
  tileWindowRadiusFar?: number;
  /**
   * Tiles within this Chebyshev distance of the camera target dispatch with
   * top priority — they're the ones actually on screen. Peripheral tiles
   * (beyond this radius but inside `tileWindowRadius`) wait until the
   * visible set is in flight. Default 4. The visible set is also what gets
   * decoded inside the same RAF where the camera is being dragged.
   */
  visibleRadius?: number;
  /**
   * Cap on tiles whose meshes get built and added to the scene each RAF
   * tick. The decode happens off-thread; mesh creation + GPU upload still
   * costs main-thread time, so a burst of 4–8 simultaneous worker phase
   * completions can stall pointer/wheel input for a frame. Throttling to
   * 1/frame (default) means input handlers always get a slot. Raise it for
   * faster fill at the cost of input smoothness; lower it for smoother
   * input at the cost of slower fill.
   */
  maxTileBuildsPerFrame?: number;
  /**
   * Run the heavy visibility/dispatch/evict pass every N-th RAF tick.
   * Default 4 (≈ 15 Hz at 60 FPS). The apply queue + tile spawn animations
   * still drain every frame; only the per-frame fixed cost of recomputing
   * what's visible is throttled. Lower = more responsive to fast pans;
   * higher = more main-thread time for input + render.
   */
  dispatchInterval?: number;
}

interface PendingState {
  status: 'fetching' | 'decoding';
}

/** One worker-phase response queued for off-thread mesh construction. */
interface PendingApply {
  key: string;
  z: number;
  x: number;
  y: number;
  /**
   * Whichever layers were requested for the tile (mirrors the worker's
   * `wantedLayers`). Used to know which entries in `geometries` to read.
   */
  layers: LayerName[];
  geometries: Partial<Record<LayerName, import('./worker/decodeProtocol.js').LayerGeometry | null>>;
}

export class TileManager {
  private cache: TileCache;
  private pending = new Map<string, PendingState>();
  private missing = new Set<string>();
  private currentZoom = 0;
  private disposed = false;
  /**
   * Tile spawn animation duration (ms). Mutable: DragonMap exposes a
   * setter so the studio (and apps) can dial this between 0 (instant) and
   * a few seconds for a more dramatic "rise in" effect.
   */
  private spawnDurationMs = DEFAULT_TILE_SPAWN_MS;
  /**
   * Offset applied to the archive's `maxZoom` in `chooseZoom`. Set by
   * quality tier (low = -1, high = 0) or directly by the developer.
   * Negative values trade detail for performance by requesting larger
   * tiles (covering more area, less total geometry).
   */
  private requestedZoomOffset = 0;

  /**
   * Number of fetches currently in flight (status: 'fetching'). Decoding
   * tiles don't count — they're worker-bound, not network-bound, and the
   * worker pool already serializes them. Capped at MAX_IN_FLIGHT so the
   * dispatch loop respects on-the-wire concurrency.
   */
  private inFlightFetches = 0;
  /** Attempts so far for tiles that failed at least once. Cleared on success. */
  private failCounts = new Map<string, number>();
  /** Earliest `performance.now()` at which a failed tile may be retried. */
  private retryAfter = new Map<string, number>();
  /**
   * If non-null, ALL dispatches are skipped until this `performance.now()`.
   * Set after a 429 to give the upstream a chance to recover before we
   * resume hammering it.
   */
  private rateLimitedUntil: number | null = null;

  /**
   * Camera-target tile coords from the most recent `update()`. Eviction and
   * the in-flight abort checks key off Chebyshev distance from here — NOT
   * off the precise frustum quad — so a tile sitting on the frustum edge
   * (which flickers in/out of the quad as the camera jitters) can never be
   * spuriously evicted while it's still on screen. `hasCenter` guards the
   * pre-first-update state.
   */
  private lastCenterX = 0;
  private lastCenterY = 0;
  private hasCenter = false;

  private readonly tileWindowRadius: number;
  private readonly tileWindowRadiusFar: number;
  private readonly visibleRadius: number;
  private readonly maxBuildsPerFrame: number;
  private readonly dispatchInterval: number;
  private frameCount = 0;

  /**
   * Phase responses awaiting mesh construction. The decode worker may finish
   * several phases in the same JS task — adding all of them to the scene
   * synchronously stalls input. Instead `onPhase` enqueues here, and
   * `update()` drains up to `maxBuildsPerFrame` items per RAF.
   */
  private applyQueue: PendingApply[] = [];

  constructor(private deps: TileManagerDeps) {
    this.cache = new TileCache(1024, (tile) => deps.scene.removeTile(tile));
    this.tileWindowRadius = Math.max(0, deps.tileWindowRadius ?? DEFAULT_TILE_WINDOW_RADIUS);
    this.tileWindowRadiusFar = Math.max(
      this.tileWindowRadius,
      deps.tileWindowRadiusFar ?? DEFAULT_TILE_WINDOW_RADIUS_FAR
    );
    this.visibleRadius = Math.max(
      0,
      Math.min(this.tileWindowRadius, deps.visibleRadius ?? DEFAULT_VISIBLE_RADIUS)
    );
    this.maxBuildsPerFrame = Math.max(1, deps.maxTileBuildsPerFrame ?? DEFAULT_MAX_BUILDS_PER_FRAME);
    this.dispatchInterval = Math.max(1, deps.dispatchInterval ?? DEFAULT_DISPATCH_INTERVAL);
  }

  async start(): Promise<void> {
    // First update triggers an initial batch of fetches.
    this.update(true);
  }

  /**
   * Per-frame: advance spawn animations, recompute visible tiles, kick off
   * loads.
   *
   * @param frameBudgetOk false when the smoothed frame time is over budget —
   *   the GPU/CPU is saturated. Building a tile mesh forces a synchronous GPU
   *   buffer upload on the next render, so when frames are slow we pause the
   *   apply-queue drain and let the camera stay smooth. Tiles keep decoding
   *   in the workers and pile up in `applyQueue`; they get built the moment
   *   frames recover (typically the instant the camera goes idle and the
   *   scene stops changing). Framerate is prioritized over loading.
   */
  /**
   * @returns true if anything that affects the rendered scene changed this
   *   frame (a tile was built, or a spawn animation is mid-flight). The RAF
   *   loop uses this to drive render-on-demand — when nothing changed and
   *   the camera is idle, the loop skips `composer.render()` entirely so the
   *   GPU isn't pegged on a static scene.
   */
  update(forced = false, frameBudgetOk = true): boolean {
    if (this.disposed) return false;

    // Spawn animations are cheap (a few position writes) and matter for
    // visual smoothness — always advance them. The apply-queue drain builds
    // meshes (expensive: GPU upload next render), so it's gated on the frame
    // budget: under load it pauses so panning doesn't stutter. The exception
    // is a slow guaranteed trickle (BUDGET_THROTTLE_INTERVAL) so a machine
    // that's over budget even at idle still fills the map instead of
    // staying blank forever.
    let dirty = false;
    if (frameBudgetOk || this.frameCount % BUDGET_THROTTLE_INTERVAL === 0) {
      if (this.drainApplyQueue()) dirty = true;
    }
    if (this.advanceSpawnAnimations()) dirty = true;

    // PolyMap pattern: the heavy visibility recompute + dispatch + evict
    // doesn't need to run at 60 Hz. Tile fetches are network-bound and
    // decodes are 50–200 ms in workers, so the dispatcher only needs to
    // notice "what should I be loading?" a few times a second. Running the
    // logic at 15 Hz frees ~75% of the main-thread cost it used to spend
    // recomputing the same answer every frame.
    this.frameCount++;
    if (!forced && this.frameCount % this.dispatchInterval !== 0) return dirty;

    const view = this.deps.camera.getView();
    const centerLat = view.lat;
    const centerLon = view.lon;

    const desiredZoom = this.chooseZoom(view.zoom);
    if (forced || Math.abs(desiredZoom - this.currentZoom) > ZOOM_HYSTERESIS) {
      this.currentZoom = desiredZoom;
    }
    const z = Math.round(this.currentZoom);

    const center = lonLatToTile(centerLon, centerLat, z);
    const radius = this.tileWindowRadius;
    const radiusFar = this.tileWindowRadiusFar;

    // Record the camera target — eviction + in-flight abort checks key off
    // distance from here, decoupled from the precise frustum `wanted` set.
    this.lastCenterX = center.x;
    this.lastCenterY = center.y;
    this.hasCenter = true;

    // The camera frustum's ground footprint is a convex TRAPEZOID, not a
    // rectangle. The bounding box of that trapezoid re-introduces big
    // off-screen triangular regions at the near-edge corners — that was the
    // "still loading tiles outside the view" bug. We inflate the quad by a
    // 1-tile margin (for smooth panning) and then point-in-quad test every
    // candidate so only tiles that actually fall within the visible
    // trapezoid get loaded.
    const frustumQuad = TileManager.inflateQuad(
      this.computeFrustumQuad(z, center.x, center.y),
      FRUSTUM_TILE_MARGIN
    );

    // Iteration bounds: the integer bbox of the inflated quad, intersected
    // with the safety-cap radius around the camera target (near-horizon
    // views can project to enormous quads — the radius keeps it bounded).
    let qxLo = Infinity, qxHi = -Infinity, qyLo = Infinity, qyHi = -Infinity;
    for (const p of frustumQuad) {
      if (p.x < qxLo) qxLo = p.x;
      if (p.x > qxHi) qxHi = p.x;
      if (p.y < qyLo) qyLo = p.y;
      if (p.y > qyHi) qyHi = p.y;
    }
    const xLo = Math.max(center.x - radius, Math.floor(qxLo));
    const xHi = Math.min(center.x + radius, Math.ceil(qxHi));
    const yLo = Math.max(center.y - radius, Math.floor(qyLo));
    const yHi = Math.min(center.y + radius, Math.ceil(qyHi));

    // Camera-right axis (from bearing) — only used for the same-distance
    // tiebreak so tiles in a concentric ring fan L → R symmetrically.
    const bearingRad = view.bearing * Math.PI / 180;
    const rightX = Math.cos(bearingRad);
    const rightY = Math.sin(bearingRad);

    // Two-tier dispatch:
    //   Tier 0 (visible): Chebyshev distance ≤ visibleRadius from target.
    //   Tier 1 (margin):  everything else inside the frustum quad.
    // Within each tier, concentric-ring expansion from the camera TARGET
    // (the screen center) — closest squared-Euclidean distance first, with
    // L/R alternation as a tiebreak so same-radius tiles fan symmetrically.
    const candidates: {
      x: number; y: number; tier: number;
      targetDistSq: number; rightDot: number;
    }[] = [];
    const n = 2 ** z;
    for (let x = xLo; x <= xHi; x++) {
      for (let y = yLo; y <= yHi; y++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        // THE KEY FILTER: the tile's center must fall inside the visible
        // trapezoid, not just its bounding box. This is what excludes the
        // off-screen near-corner triangles.
        if (!TileManager.pointInQuad(x + 0.5, y + 0.5, frustumQuad)) continue;
        const dxTarget = x - center.x;
        const dyTarget = y - center.y;
        const distTarget = Math.max(Math.abs(dxTarget), Math.abs(dyTarget));
        if (distTarget > radiusFar) continue;
        const targetDistSq = dxTarget * dxTarget + dyTarget * dyTarget;
        const rightDot = dxTarget * rightX + dyTarget * rightY;
        candidates.push({
          x, y,
          tier: distTarget <= this.visibleRadius ? 0 : 1,
          targetDistSq,
          rightDot
        });
      }
    }
    // Sort: tier, then squared-Euclidean distance from the camera target
    // (concentric rings from the screen center outward), then alternating
    // L/R (right side first) within same-distance ties for visual symmetry.
    candidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.targetDistSq !== b.targetDistSq) return a.targetDistSq - b.targetDistSq;
      return b.rightDot - a.rightDot;
    });
    // Skip the whole dispatch sweep while we're cooling down from a 429.
    // The eviction pass below still runs — old tiles can age out even while
    // we're parked.
    const now = performance.now();
    const cooling = this.rateLimitedUntil != null && this.rateLimitedUntil > now;
    if (this.rateLimitedUntil != null && !cooling) {
      this.rateLimitedUntil = null;
    }

    for (const c of candidates) {
      const key = tileKey(z, c.x, c.y);
      if (this.missing.has(key)) continue;
      if (this.cache.has(z, c.x, c.y) || this.pending.has(key)) continue;
      // Skip permanently-failed tiles and ones still inside their backoff window.
      const attempts = this.failCounts.get(key) ?? 0;
      if (attempts >= MAX_TILE_RETRIES) continue;
      const wait = this.retryAfter.get(key);
      if (wait != null && wait > now) continue;
      if (cooling) break; // park the rest of the sweep until cooldown ends
      if (this.inFlightFetches >= MAX_IN_FLIGHT) break;
      void this.loadTile(z, c.x, c.y);
    }

    this.evictUnwanted();
    return dirty;
  }

  private chooseZoom(_cameraZoom: number): number {
    // Default: request the archive's maxZoom tiles. Protomaps applies
    // feature-count simplification at lower zooms — z=14 drops many small
    // buildings, z=13 keeps only large ones, etc. Sticking with maxZoom keeps
    // every feature in the data visible at any camera distance.
    //
    // `requestedZoomOffset` lets quality tiers trade detail for performance
    // by stepping the requested zoom down. The `'low'` tier uses -1
    // (zoom 13 from a z14 archive) → each tile covers 4× the area, so
    // ~3× less total geometry across the visible viewport. Clamped to the
    // archive's minZoom so a too-aggressive offset doesn't request tiles
    // that don't exist.
    const target = this.deps.source.maxZoom + this.requestedZoomOffset;
    return Math.max(this.deps.source.minZoom, Math.min(this.deps.source.maxZoom, target));
  }

  /**
   * Set the offset applied to the archive's `maxZoom` when choosing which
   * tile zoom to request. Negative values pull the requested zoom level
   * down (less detail, fewer tiles + less geometry per view). Clamped to
   * the archive's [minZoom, maxZoom] range at request time so an extreme
   * offset can't request unavailable tiles. Triggers a tile-cache rebuild
   * on the next `update()` because the new zoom level produces a
   * different set of tile coordinates.
   */
  setRequestedZoomOffset(offset: number): void {
    if (offset === this.requestedZoomOffset) return;
    this.requestedZoomOffset = offset;
    // Force the dispatch sweep to re-pick `currentZoom` next frame.
    this.currentZoom = 0;
    // Drop tiles from the OLD zoom; they'll re-request at the new zoom.
    this.cache.clear();
    this.pending.clear();
    this.missing.clear();
  }

  private async loadTile(z: number, x: number, y: number): Promise<void> {
    const key = tileKey(z, x, y);
    this.pending.set(key, { status: 'fetching' });
    this.inFlightFetches++;
    let stillFetching = true;
    const releaseFetch = () => {
      if (!stillFetching) return;
      stillFetching = false;
      this.inFlightFetches = Math.max(0, this.inFlightFetches - 1);
    };

    try {
      const data = await this.deps.source.getTile(z, x, y);
      releaseFetch();
      if (this.disposed) return;
      if (!data) {
        // Archive doesn't have this tile — remember so we don't keep retrying.
        this.pending.delete(key);
        this.missing.add(key);
        return;
      }
      if (!this.isInKeepZone(x, y)) {
        // Camera moved far away while the fetch was in flight — drop it.
        this.pending.delete(key);
        return;
      }

      // Tile fetched successfully — clear any prior failure bookkeeping.
      this.failCounts.delete(key);
      this.retryAfter.delete(key);

      this.pending.set(key, { status: 'decoding' });
      const { lat: originLat, lon: originLon } = this.deps.projection.origin;
      // Only ask the worker to decode layers that are currently enabled —
      // a disabled `buildings` layer skips the O(n²) extraction entirely
      // rather than decoding then hiding the result.
      const wantedLayers = this.activeLayerSubset();

      // The decode worker may finish multiple phases in the same JS task —
      // building meshes synchronously from each callback would block input
      // for the whole burst. Instead, every phase enqueues onto applyQueue
      // and `update()` drains a bounded number per RAF tick.
      await this.deps.workerPool.decode(
        z, x, y, data, originLat, originLon, wantedLayers,
        (response) => {
          if (this.disposed) return;
          if (!this.isInKeepZone(x, y)) return;
          this.applyQueue.push({
            key,
            z: response.z,
            x: response.x,
            y: response.y,
            layers: wantedLayers,
            geometries: response.geometries
          });
        }
      );
      if (this.disposed) return;
      // NOTE: the tile is intentionally LEFT in `pending` here. Its phases
      // are now sitting in `applyQueue` waiting to be built — possibly for
      // many frames if the frame budget is throttling builds. Keeping it
      // `pending` stops the dispatch loop from seeing `!cache && !pending`
      // and re-fetching a tile that's already decoded and queued. The
      // entry is removed in `applyPhase` (built) or `drainApplyQueue`
      // (dropped because the camera moved away).
      this.deps.onTileLoad?.(z, x, y);
    } catch (err) {
      // Always release the fetch slot — both fetch errors (pre-`releaseFetch`)
      // and decode errors (post-`releaseFetch`) land here.
      releaseFetch();
      this.pending.delete(key);
      const error = err instanceof Error ? err : new Error(String(err));

      // Pattern-match 429s — the pmtiles library doesn't expose status codes,
      // so the error message text is the only signal. On a hit, park ALL
      // dispatches for RATE_LIMIT_COOLDOWN_MS so we don't keep firing at a
      // throttled upstream.
      if (RATE_LIMIT_RE.test(error.message)) {
        const until = performance.now() + RATE_LIMIT_COOLDOWN_MS;
        if (this.rateLimitedUntil == null || until > this.rateLimitedUntil) {
          this.rateLimitedUntil = until;
        }
        logger.warn(`tile ${key} rate-limited; cooling down ${RATE_LIMIT_COOLDOWN_MS}ms`);
      } else {
        // Per-tile exponential backoff. The dispatch loop skips entries whose
        // `retryAfter` hasn't elapsed yet, and gives up entirely once
        // `failCounts >= MAX_TILE_RETRIES`.
        const attempts = (this.failCounts.get(key) ?? 0) + 1;
        this.failCounts.set(key, attempts);
        const backoff = BACKOFF_BASE_MS * Math.pow(2, Math.min(attempts - 1, 20));
        this.retryAfter.set(key, performance.now() + backoff);
        logger.warn(`tile ${key} failed (attempt ${attempts}/${MAX_TILE_RETRIES}):`, error.message);
      }
      this.deps.onTileError?.(z, x, y, error);
    }
  }

  /**
   * Chebyshev radius from the camera target inside which a tile is never
   * evicted and an in-flight load is never aborted. Deliberately LARGER
   * than the load radius (`tileWindowRadiusFar`) so the keep zone fully
   * contains everything the dispatcher loads, with headroom — a tile can
   * never be loaded and then immediately evicted, and a tile sitting on the
   * frustum edge can't flicker out.
   */
  private get keepRadius(): number {
    return this.tileWindowRadiusFar + 2;
  }

  /**
   * Is tile (x, y) close enough to the camera target to keep / keep loading?
   * Used by eviction and the in-flight abort checks INSTEAD of the precise
   * frustum `wanted` set — the frustum quad test is the right tool for
   * deciding what to *load* (tight, no off-screen tiles) but the wrong tool
   * for deciding what to *keep*: it's recomputed at 15 Hz and is sensitive
   * to sub-tile camera jitter, so an on-screen tile on the frustum edge
   * would flicker in/out and get spuriously evicted. Distance from the
   * camera target is jitter-proof.
   */
  private isInKeepZone(x: number, y: number): boolean {
    if (!this.hasCenter) return true; // before first update, keep everything
    const d = Math.max(
      Math.abs(x - this.lastCenterX),
      Math.abs(y - this.lastCenterY)
    );
    return d <= this.keepRadius;
  }

  /**
   * Drop tiles the camera has moved away from. Eviction is driven purely by
   * Chebyshev distance from the camera TARGET — NOT by frustum membership.
   * Any tile within `keepRadius` is retained ("in view or surrounding
   * area"). Beyond that, a small grace pool of the CLOSEST tiles is kept for
   * fast re-pan and the rest are evicted farthest-first.
   *
   * This is the fix for "ejecting tiles within view": the previous version
   * evicted anything not in the precise `wanted` frustum set, so a tile on
   * the frustum edge — still clearly on screen — would get dropped the
   * moment camera jitter nudged its center just outside the quad.
   */
  private evictUnwanted(): void {
    if (!this.hasCenter) return;
    const currentZ = Math.round(this.currentZoom);
    const cx = this.lastCenterX;
    const cy = this.lastCenterY;
    const keep = this.keepRadius;

    const farTiles: { z: number; x: number; y: number; dist: number }[] = [];
    for (const [key] of this.cache.entries()) {
      const parts = key.split('/');
      const tz = Number(parts[0]);
      const tx = Number(parts[1]);
      const ty = Number(parts[2]);
      // Cross-zoom tiles cover the same ground at a different LOD and
      // z-fight the current set — always drop them.
      if (tz !== currentZ) {
        this.cache.delete(tz, tx, ty);
        continue;
      }
      const dist = Math.max(Math.abs(tx - cx), Math.abs(ty - cy));
      if (dist <= keep) continue; // keep zone — never evict
      farTiles.push({ z: tz, x: tx, y: ty, dist });
    }

    // Grace pool: keep the CLOSEST KEEP_OUTSIDE far-tiles for fast re-pan,
    // evict the rest farthest-first.
    const KEEP_OUTSIDE = 32;
    if (farTiles.length > KEEP_OUTSIDE) {
      farTiles.sort((a, b) => b.dist - a.dist); // farthest first
      const dropCount = farTiles.length - KEEP_OUTSIDE;
      for (let i = 0; i < dropCount; i++) {
        const t = farTiles[i];
        this.cache.delete(t.z, t.x, t.y);
      }
    }
  }

  setLayerEnabled(layerName: LayerName, enabled: boolean): void {
    for (const [, tile] of this.cache.entries()) {
      tile.setLayerVisible(layerName, enabled);
    }
  }

  /**
   * Project the camera's four screen corners onto the y=0 ground plane and
   * return them as fractional tile coords — a convex quadrilateral (the
   * actual on-screen ground footprint). Corner order follows the NDC
   * corners: bottom-left, bottom-right, top-right, top-left.
   *
   * IMPORTANT: this is a QUAD, not a bbox. A tilted camera's footprint is a
   * trapezoid; the bounding *rectangle* of that trapezoid re-introduces big
   * off-screen triangular regions at the near-edge corners. Callers must
   * use `pointInQuad` against this shape, not just iterate its bbox.
   *
   * Near-horizon top corners whose rays never hit the ground get pushed to
   * a forward fallback at the camera's half-far-plane so the quad stays a
   * sensible (if elongated) trapezoid. The radius cap in the caller bounds
   * anything excessive.
   */
  private computeFrustumQuad(
    z: number,
    centerTileX: number,
    centerTileY: number
  ): { x: number; y: number }[] {
    const cam = this.deps.camera.three;
    cam.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // NDC corners of the screen — bottom-left, bottom-right, top-right, top-left.
    const ndcCorners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const quad: { x: number; y: number }[] = [];
    const v = new THREE.Vector2();
    const hit = new THREE.Vector3();

    for (const [nx, ny] of ndcCorners) {
      v.set(nx, ny);
      raycaster.setFromCamera(v, cam);
      const ray = raycaster.ray;
      const point = new THREE.Vector3();
      const intersected = ray.intersectPlane(groundPlane, point);
      let mx: number;
      let mz: number;
      if (intersected && Number.isFinite(point.x) && Number.isFinite(point.z)) {
        mx = point.x;
        mz = point.z;
      } else {
        // Ray didn't hit the ground (near-horizon top corners). Fall back to
        // a forward sample at half the far plane.
        hit.copy(ray.origin).addScaledVector(ray.direction, cam.far * 0.5);
        mx = hit.x;
        mz = hit.z;
      }
      // Project hit back to lat/lon → fractional tile coords. (Scene
      // convention: world Z = -mercator Y; unproject expects mercator Y.)
      const ll = this.deps.projection.unproject(mx, -mz);
      quad.push(lonLatToTileFractional(ll.lon, ll.lat, z));
    }

    // Defensive fallback: if any projection produced a non-finite value,
    // collapse to a tight 1-tile quad around the camera target.
    if (quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      return [
        { x: centerTileX - 0.5, y: centerTileY - 0.5 },
        { x: centerTileX + 1.5, y: centerTileY - 0.5 },
        { x: centerTileX + 1.5, y: centerTileY + 1.5 },
        { x: centerTileX - 0.5, y: centerTileY + 1.5 }
      ];
    }
    return quad;
  }

  /**
   * Push each quad corner `margin` tiles outward from the quad's centroid —
   * gives a uniform-ish loading buffer around the visible trapezoid so a
   * small pan doesn't immediately expose unloaded ground.
   */
  private static inflateQuad(
    quad: { x: number; y: number }[],
    margin: number
  ): { x: number; y: number }[] {
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    return quad.map((p) => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * margin, y: p.y + (dy / len) * margin };
    });
  }

  /**
   * Convex point-in-quad test. Winding-agnostic: a point is inside iff every
   * edge's cross product against (point − edgeStart) has the same sign.
   * Works for any convex quad regardless of CW/CCW vertex order, which
   * matters because the ground projection's winding flips with the
   * mercator Y-axis inversion.
   */
  private static pointInQuad(
    px: number,
    py: number,
    quad: { x: number; y: number }[]
  ): boolean {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) & 3];
      const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if (cross !== 0) {
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else if (sign !== s) return false;
      }
    }
    return true;
  }

  /**
   * Pop up to `maxBuildsPerFrame` pending phase responses off the queue and
   * actually build their meshes / add them to the scene. Keeps the
   * synchronous per-RAF main-thread cost bounded — without this, a burst of
   * worker completions would block pointer/wheel events for ~30–80 ms.
   *
   * Items are processed CLOSEST-TO-CAMERA-TARGET FIRST, not FIFO. The
   * dispatch sweep already prioritizes close tiles for fetching, but
   * parallel HTTP fetches + a single worker mean responses can arrive out
   * of order — without this sort, a peripheral tile that happened to fetch
   * first would "appear" before the center tile. Sorting on drain
   * guarantees the order the user sees matches the priority order, no
   * matter what the network did.
   *
   * The sort is O(N) per drain (find-min, not full re-sort) and runs once
   * per frame with maxBuildsPerFrame = 1, so the cost is trivial — apply
   * queue depth is typically < 20.
   */
  /** @returns true if at least one tile mesh was built (scene changed). */
  private drainApplyQueue(): boolean {
    let processed = 0;
    while (processed < this.maxBuildsPerFrame && this.applyQueue.length > 0) {
      // Pick the item whose tile is closest to the camera target, instead
      // of the front of the queue. `lastCenterX/Y` is the screen-center
      // tile coord (refreshed by the dispatch sweep ≥ once every
      // dispatchInterval frames — stale by at most ~4 frames, negligible
      // for ranking sub-tile distances).
      const cx = this.lastCenterX;
      const cy = this.lastCenterY;
      let bestIdx = 0;
      let bestDistSq = Infinity;
      for (let i = 0; i < this.applyQueue.length; i++) {
        const it = this.applyQueue[i];
        const dx = it.x - cx;
        const dy = it.y - cy;
        const d = dx * dx + dy * dy;
        if (d < bestDistSq) {
          bestDistSq = d;
          bestIdx = i;
        }
      }
      const item = this.applyQueue.splice(bestIdx, 1)[0];
      if (this.disposed) return processed > 0;
      // Skip only if the camera has moved FAR from the tile while it sat in
      // the queue — distance-based, not frustum-based, so an on-screen tile
      // on the frustum edge still gets built.
      if (!this.isInKeepZone(item.x, item.y)) {
        // Drop the now-stale pending entry so a future pass over this area
        // can re-dispatch the tile cleanly.
        this.pending.delete(item.key);
        continue;
      }
      this.applyPhase(item);
      processed++;
    }
    return processed > 0;
  }

  /**
   * Build meshes for one phase response and attach them to the tile group.
   * Creates the group + adds it to the scene on first sight; subsequent
   * phases for the same tile find the cached group and add into it in place.
   */
  private applyPhase(item: PendingApply): void {
    let tile = this.cache.get(item.z, item.x, item.y);
    if (!tile) {
      tile = new TileGroup(item.z, item.x, item.y);
      // Spawn below ground; the per-frame animation below eases it back to
      // y=0 over spawnDurationMs so tiles "rise in" instead of snapping in.
      // A spawnDurationMs of 0 means the user has disabled the animation —
      // snap directly to y=0 without bookkeeping.
      if (this.spawnDurationMs > 0) {
        tile.position.y = -TILE_SPAWN_DROP;
        tile.userData.spawnStartMs = performance.now();
      } else {
        tile.position.y = 0;
      }
      this.cache.set(item.z, item.x, item.y, tile);
      this.deps.scene.addTile(tile);
    }
    for (const layerName of item.layers) {
      const geom = item.geometries[layerName];
      if (!geom) continue;
      const layer = this.deps.layers.get(layerName);
      if (!layer) continue;
      const obj = layer.build(geom);
      tile.setLayer(layerName, obj);
      // Buildings arrive in phase 2 of the two-phase decode — typically
      // 50–200 ms AFTER the tile-level spawn animation has already
      // finished. Without this, buildings would snap in at final y while
      // the user's "Pop-up time" slider does nothing visible. If the
      // tile-level animation is already done OR the duration is long
      // enough that we're past its end, give the building mesh ITS OWN
      // spawn animation so it visibly rises from below ground.
      if (
        layerName === 'buildings' &&
        this.spawnDurationMs > 0 &&
        tile.userData.spawnStartMs === undefined
      ) {
        obj.position.y = -TILE_SPAWN_DROP;
        obj.userData.spawnStartMs = performance.now();
      }
      if (!this.deps.layers.isEnabled(layerName)) {
        tile.setLayerVisible(layerName, false);
      }
    }
    // The tile now has a cache entry (created above on the first phase) and
    // real geometry — it's no longer "pending". Clear the entry so the
    // dispatch loop's `!pending.has(key)` check works. Harmless no-op on the
    // second phase of a two-phase tile (already deleted by the first).
    this.pending.delete(item.key);
  }

  /**
   * Per-frame tick of the tile rise-in animation. Each tile is spawned at
   * `y = -TILE_SPAWN_DROP` and eased back to `y = 0` over `spawnDurationMs`
   * with an ease-out cubic curve. Tiles whose animation is complete are
   * snapped to 0 and their `spawnStartMs` userData is cleared so the loop
   * does no further work for them.
   */
  /** @returns true if at least one tile or per-mesh spawn animation is still running. */
  private advanceSpawnAnimations(): boolean {
    const now = performance.now();
    const duration = this.spawnDurationMs;
    let active = false;
    for (const [, tile] of this.cache.entries()) {
      // Tile-level animation (covers phase-1 layers — water, landuse, roads).
      const tileStart = tile.userData.spawnStartMs as number | undefined;
      if (tileStart !== undefined) {
        const elapsed = now - tileStart;
        if (duration <= 0 || elapsed >= duration) {
          tile.position.y = 0;
          tile.userData.spawnStartMs = undefined;
          active = true;
        } else {
          const t = elapsed / duration;
          const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
          tile.position.y = -TILE_SPAWN_DROP * (1 - eased);
          active = true;
        }
      }
      // Per-child-mesh animation — used when buildings arrive in phase 2
      // after the tile-level animation is already over. Each mesh that has
      // its own spawnStartMs in userData rises independently.
      for (const child of tile.children) {
        const meshStart = child.userData.spawnStartMs as number | undefined;
        if (meshStart === undefined) continue;
        const elapsed = now - meshStart;
        if (duration <= 0 || elapsed >= duration) {
          child.position.y = 0;
          child.userData.spawnStartMs = undefined;
          active = true;
        } else {
          const t = elapsed / duration;
          const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
          child.position.y = -TILE_SPAWN_DROP * (1 - eased);
          active = true;
        }
      }
    }
    return active;
  }

  /**
   * Set the spawn animation duration in milliseconds. 0 disables the
   * animation entirely (tiles snap in at y=0). Tiles already mid-animation
   * keep their current start time but use the new duration on subsequent
   * frames — so a shrink in the middle of an animation can cause a small
   * jump, but it's stable on the very next frame.
   */
  setSpawnDurationMs(ms: number): void {
    this.spawnDurationMs = Math.max(0, ms);
  }

  getSpawnDurationMs(): number {
    return this.spawnDurationMs;
  }

  /**
   * Subset of `DEFAULT_ACTIVE_LAYERS` that the registry currently has
   * enabled. Sent to the worker so it skips decoding for layers that
   * wouldn't render anyway — e.g. disabling buildings cuts the heaviest
   * extractor entirely.
   */
  private activeLayerSubset(): LayerName[] {
    const out: LayerName[] = [];
    for (const name of DEFAULT_ACTIVE_LAYERS) {
      if (this.deps.layers.isEnabled(name)) out.push(name);
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.pending.clear();
    this.missing.clear();
    this.failCounts.clear();
    this.retryAfter.clear();
    this.inFlightFetches = 0;
    this.rateLimitedUntil = null;
  }
}

