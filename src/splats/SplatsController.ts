import type { SplatsConfig, SplatsRevealOptions, SplatsStats } from './types.js';
import {
  type ResolvedSplatsOptions,
  type SplatsUpdatePlan,
  mergeSplatsOptions,
  planSplatsUpdate,
  resolveRevealCall,
  resolveSplatsOptions
} from './options.js';

/** The slice of `SplatsLayer` the controller drives (tests stub this). */
export interface SplatsLayerLike {
  open(): Promise<void>;
  setEnabled(on: boolean, opts?: SplatsRevealOptions): void;
  isEnabled(): boolean;
  getStats(): SplatsStats;
  applyOptions(options: ResolvedSplatsOptions): void;
  rebuild(options: ResolvedSplatsOptions): void;
  setQualityTier(tier: 'low' | 'mobile' | 'high'): void;
  update(): void;
  /** Feed the frame-time governor (see `SplatsLayer.reportFrame`). */
  reportFrame?(dtMs: number, moving: boolean): void;
  /** Whether the camera is moving — motion LoD (see `SplatsLayer.setCameraMoving`). */
  setCameraMoving?(moving: boolean): void;
  /** Skip drawing this frame: a motion-LoD swap is sorting (see `SplatsLayer.holdForSwap`). */
  holdForSwap?(gpuIdle: boolean): boolean;
  /** Motion LoD is drawing the lite meshes. */
  isDrawingLite?(): boolean;
  /** The composer's internal render scale (see `SplatsLayer.setRenderScale`). */
  setRenderScale?(scale: number): void;
  /** At-rest detail to draw while moving, 0‥1 (see `SplatsLayer.setMotionDetail`). */
  setMotionDetail?(detail: number): void;
  /** Spark is drawing full detail (see `SplatsLayer.isDetailSettled`). */
  isDetailSettled?(): boolean;
  /** `hideBasemap: 'covered'` is cutting the basemap out right now. */
  isCovering?(): boolean;
  /** `hideBasemap: true` is hiding the basemap layers right now. */
  isHidingBasemap?(): boolean;
  /** Splat tiles are resident. */
  hasTiles?(): boolean;
  /** World height of the tallest resident building mesh, 0 with none. */
  tallestBuilding?(): number;
  /** Tiles are landing or dissolving (see `SplatsLayer.isLandingOrFading`). */
  isLandingOrFading?(): boolean;
  /** The governor's smoothed moving-frame time, ms (0 before any sample). */
  governorFrameMs?(): number;
  dispose(): void;
}

export interface SplatsControllerDeps {
  /** Construct a layer for `config` (which always carries a `urlTemplate`). */
  createLayer(config: SplatsConfig): SplatsLayerLike;
  /**
   * `neutralGrade` was flipped while the overlay holds the basemap hidden:
   * apply (`true`) or release (`false`) the neutral grade right away.
   */
  onNeutralGradeChange?(on: boolean): void;
  /**
   * The camera zoom cap the overlay wants: `maxCameraZoom` while the overlay
   * is in effect (enabled and allowed by the quality tier), `null` when it
   * is not — the map then restores its previous zoom limit. Called only when
   * the value changes.
   */
  onCameraZoomCapChange?(maxZoom: number | null): void;
  /** The camera tilt cap the overlay wants (degrees), `null` to lift it — see `maxCameraTilt`. */
  onCameraTiltCapChange?(maxTilt: number | null): void;
  /** Something changed that needs a frame. */
  onChange?(): void;
}

const EMPTY_STATS: SplatsStats = Object.freeze({
  tiles: 0,
  tileZoom: 0,
  splats: 0,
  maxSplats: 0,
  reveal: 'none',
  basemapHidden: false,
  basemapCovered: false,
  governor: Object.freeze({ enabled: false, frameMs: 0, targetFrameMs: 0, scale: 1, maxScale: 1, biasDrop: 0, splatMaxDistance: 0, thinKeep: 1 })
});

/**
 * Owns the splats overlay's CONFIG and the lifetime of its `SplatsLayer` for
 * the map: `map.setSplatsOptions()` lands here, is merged into the stored
 * config, and is then applied to the running layer (`applyOptions`), or — for
 * the options that define the tile set — answered by REBUILDING it
 * (`SplatsLayer.rebuild`: every tile dropped, the loop refilled from the new
 * source; the single Spark renderer is reused), or, when there was no layer
 * because no URL had been configured, by CREATING one. A map constructed
 * without `splats` holds a controller with no layer: nothing is imported and
 * nothing ticks until a `urlTemplate` arrives; clearing the URL disposes it.
 */
export class SplatsController {
  private config: Partial<SplatsConfig>;
  private resolved: ResolvedSplatsOptions;
  private current: SplatsLayerLike | null = null;
  private tier: 'low' | 'mobile' | 'high' = 'high';
  /** Set by `open()` — layers created afterwards are opened on the spot. */
  private opened = false;
  private disposed = false;
  /** Last value handed to `onCameraTiltCapChange`. */
  private tiltCapSent: number | null = null;
  /** Last value handed to `onCameraZoomCapChange`. */
  private zoomCap: number | null = null;

  constructor(
    private readonly deps: SplatsControllerDeps,
    initial?: Partial<SplatsConfig>
  ) {
    this.config = { ...(initial ?? {}) };
    this.resolved = resolveSplatsOptions(this.config);
    if (this.resolved.urlTemplate) this.current = this.build();
    this.syncZoomCap();
  }

  /** Up close the surfels read as blobs: while the overlay is on, the camera
   *  is held at `maxCameraZoom`; off (or tier-suppressed, or gone) lifts it. */
  private syncZoomCap(): void {
    const on = !!this.current?.isEnabled();
    const tilt = on && this.resolved.maxCameraTilt < 89 ? this.resolved.maxCameraTilt : null;
    if (tilt !== this.tiltCapSent) {
      this.tiltCapSent = tilt;
      this.deps.onCameraTiltCapChange?.(tilt);
    }
    const want = on ? this.resolved.maxCameraZoom : null;
    if (want === this.zoomCap) return;
    this.zoomCap = want;
    this.deps.onCameraZoomCapChange?.(want);
  }

  /** The live layer, or null while no `urlTemplate` is configured. */
  get layer(): SplatsLayerLike | null {
    return this.current;
  }

  /** Import Spark for the current layer (if any) and for every later one. */
  async open(): Promise<void> {
    this.opened = true;
    await this.current?.open();
  }

  /** The options in effect, defaults filled in (`urlTemplate: ''` = none). */
  getOptions(): ResolvedSplatsOptions {
    const o = this.resolved;
    return { ...o, roundedUnion: { ...o.roundedUnion }, reveal: { ...o.reveal } };
  }

  /**
   * Merge `patch` into the config and bring the overlay in line. Returns what
   * had to happen (`planSplatsUpdate`), mostly for tests and tooling.
   */
  setOptions(patch: Partial<SplatsConfig>): SplatsUpdatePlan {
    if (this.disposed || !patch || typeof patch !== 'object') return { kind: 'none', changed: [] };
    const prev = this.resolved;
    this.config = mergeSplatsOptions(this.config, patch);
    const next = (this.resolved = resolveSplatsOptions(this.config));
    const plan = planSplatsUpdate(prev, next, this.current !== null);
    switch (plan.kind) {
      case 'none':
        break;
      case 'dispose':
        this.current?.dispose();
        this.current = null;
        break;
      case 'create':
        // Starts from `config.enabled`; nothing to replay (the render scale is).
        this.current = this.build();
        this.current.setRenderScale?.(this.renderScaleV);
        if (this.opened) void this.current.open();
        break;
      case 'rebuild':
      case 'live': {
        const layer = this.current;
        if (!layer) break;
        if (plan.kind === 'rebuild') layer.rebuild(next);
        else layer.applyOptions(next);
        if (plan.changed.includes('neutralGrade') && layer.getStats().basemapHidden) {
          this.deps.onNeutralGradeChange?.(next.neutralGrade);
        }
        // `enabled` through the options goes the same way as the toggle, so
        // it uses the configured reveal.
        if (plan.changed.includes('enabled')) {
          layer.setEnabled(next.enabled, resolveRevealCall(next.reveal, undefined));
        }
        break;
      }
    }
    this.syncZoomCap();
    if (plan.kind !== 'none') this.deps.onChange?.();
    return plan;
  }

  /**
   * Toggle the overlay. `opts` are laid over the configured `reveal`
   * defaults field by field, so a plain `setEnabled(on)` transitions the way
   * the config says. The choice is remembered in the config (`enabled`), so
   * it shows up in an export and seeds a layer created later.
   */
  setEnabled(on: boolean, opts?: SplatsRevealOptions): void {
    if (this.disposed) return;
    this.config = { ...this.config, enabled: on };
    this.resolved = { ...this.resolved, enabled: on };
    this.current?.setEnabled(on, resolveRevealCall(this.resolved.reveal, opts));
    this.syncZoomCap();
    this.deps.onChange?.();
  }

  isEnabled(): boolean {
    return this.current?.isEnabled() ?? false;
  }

  getStats(): SplatsStats {
    return this.current?.getStats() ?? { ...EMPTY_STATS };
  }

  setQualityTier(tier: 'low' | 'mobile' | 'high'): void {
    this.tier = tier;
    this.current?.setQualityTier(tier);
    this.syncZoomCap();
  }

  update(): void {
    this.current?.update();
  }

  /** Feed the frame-time governor: ms since the previous rendered frame, and
   *  whether the camera is moving. */
  reportFrame(dtMs: number, moving: boolean): void {
    this.current?.reportFrame?.(dtMs, moving);
  }

  setCameraMoving(moving: boolean): void {
    this.current?.setCameraMoving?.(moving);
  }

  /** The overlay asks the map to hold its picture this frame (motion-LoD swap in flight).
   *  `gpuIdle`: the map has no unfinished frame on the GPU (a hold only starts from one). */
  holdForSwap(gpuIdle: boolean): boolean {
    return this.current?.holdForSwap?.(gpuIdle) ?? false;
  }

  /** At-rest detail to draw while the camera still moves, 0‥1 (the end of a glide). */
  setMotionDetail(detail: number): void {
    this.current?.setMotionDetail?.(detail);
  }

  /** The composer's internal render scale, for Spark's splat sizing. */
  setRenderScale(scale: number): void {
    this.renderScaleV = scale;
    this.current?.setRenderScale?.(scale);
  }
  private renderScaleV = 1;

  /** Motion LoD is drawing the lite meshes (false with no layer). */
  isDrawingLite(): boolean {
    return this.current?.isDrawingLite?.() ?? false;
  }

  /** The overlay draws full detail (true with no layer: nothing to wait for). */
  isDetailSettled(): boolean {
    return this.current?.isDetailSettled?.() ?? true;
  }

  /** The `neutralGrade` option in effect (read every frame — no copy). */
  get neutralGrade(): boolean {
    return this.resolved.neutralGrade;
  }

  /** The `miniature` option in effect (read every frame — no copy). */
  get miniature(): boolean {
    return this.resolved.miniature;
  }

  /** Smoothed moving-frame time the governor is working from, ms (0 = none). */
  get governorFrameMs(): number {
    return this.current?.governorFrameMs?.() ?? 0;
  }

  /** Splat tiles are resident (any `hideBasemap` mode). */
  hasTiles(): boolean {
    return this.current?.hasTiles?.() ?? false;
  }

  /** World height of the tallest resident building mesh (`buildingMeshes`), 0 with none. */
  tallestBuilding(): number {
    return this.current?.tallestBuilding?.() ?? 0;
  }

  /** Splat tiles are landing or dissolving (see `SplatsLayer.isLandingOrFading`). */
  isLandingOrFading(): boolean {
    return this.current?.isLandingOrFading?.() ?? false;
  }

  /** `hideBasemap: true` is hiding the basemap layers right now. */
  isHidingBasemap(): boolean {
    return this.current?.isHidingBasemap?.() ?? false;
  }

  /** `hideBasemap: 'covered'` is cutting the basemap out right now. */
  isCovering(): boolean {
    return this.current?.isCovering?.() ?? false;
  }

  dispose(): void {
    this.disposed = true;
    this.current?.dispose();
    this.current = null;
    this.syncZoomCap();
  }

  private build(): SplatsLayerLike {
    const layer = this.deps.createLayer({ ...this.config, urlTemplate: this.resolved.urlTemplate });
    layer.setQualityTier(this.tier);
    return layer;
  }
}
