import type {
  HereBeDragons,
  HereBeDragonsOptions,
  CameraView,
  FlyToOptions,
  LayerName,
  HereBeDragonsEventName,
  HereBeDragonsEventPayload,
  NoiseSource,
  SnapshotOptions,
  Unsubscribe
} from './types.js';
import type { RenderStats } from './types.js';

function emptyRenderStats(): RenderStats {
  return {
    frames: 0, renders: 0, needsRender: 0, tileDirty: 0, layersDirty: 0, bridgesDirty: 0,
    sporesDirty: 0, cloudsDirty: 0, noiseDirty: 0, heartbeat: 0, lowRes: 0, paced: 0, swapHeld: 0, dissolveFrames: 0, reprojected: 0
  };
}
import { EventBus } from './core/EventBus.js';
import { Projection } from './core/Projection.js';
import { Renderer } from './rendering/Renderer.js';
import { SceneRoot } from './scene/SceneRoot.js';
import { GLIDE_STOP_PX, MapCameraController } from './controls/MapCameraController.js';
import { createMotionDetail, stepMotionDetail } from './core/motionDetail.js';
import { shouldSuspendBuilds } from './controls/interactionGate.js';
import { Composer } from './rendering/Composer.js';
import { resolveQualityProfile, isMobileDevice } from './rendering/quality.js';
import type { QualityLevel } from './rendering/quality.js';
import { PMTilesSource } from './tiles/PMTilesSource.js';
import { TileWorkerPool } from './tiles/TileWorkerPool.js';
import {
  CoverageField,
  resolveTileReveal,
  type ResolvedTileReveal,
  type TileRevealOptions
} from './tiles/CoverageField.js';
import { TileManager, DEFAULT_MAIN_TILE_MIN_ZOOM } from './tiles/TileManager.js';
import { BaseTileManager } from './tiles/BaseTileManager.js';
import { LayerRegistry } from './scene/LayerRegistry.js';
import { WaterLayer } from './layers/WaterLayer.js';
import { WaterwaysLayer } from './layers/WaterwaysLayer.js';
import { LanduseLayer } from './layers/LanduseLayer.js';
import { RoadsLayer } from './layers/RoadsLayer.js';
import { RailsLayer } from './layers/RailsLayer.js';
import { BuildingsLayer, BUILDING_THREE_LAYER } from './layers/BuildingsLayer.js';
import { LabelsLayer, LABEL_THREE_LAYER } from './layers/LabelsLayer.js';
import { CarsLayer } from './layers/CarsLayer.js';
import { TreesLayer, TREE_THREE_LAYER } from './layers/TreesLayer.js';
import { GrassLayer, GRASS_THREE_LAYER } from './layers/GrassLayer.js';
import { WavesLayer, WAVES_THREE_LAYER } from './layers/WavesLayer.js';
import { SporesField, SPORES_THREE_LAYER } from './scene/SporesField.js';
import { SignsLayer, SIGNS_THREE_LAYER } from './layers/SignsLayer.js';
import { BridgesManager } from './bridges/BridgesManager.js';
import { Palette } from './materials/Palette.js';
import { THEMES, themeToPaletteOverrides, themeSky, darken, lighten, type ThemeColors } from './themes.js';
import { TagsManager } from './tags/TagsManager.js';
import type { TagOptions, TagHandle } from './tags/types.js';
import { PolygonsManager } from './polygons/PolygonsManager.js';
import type { PolygonOptions, PolygonHandle } from './polygons/types.js';
import { BuildingsManager } from './buildings/BuildingsManager.js';
import type {
  BuildingInfo,
  BuildingPopupConfig
} from './buildings/types.js';
import { ParcelsManager } from './parcels/ParcelsManager.js';
import { SplatsLayer, SPLAT_THREE_LAYER, SPLATS_HIDDEN_BASEMAP_LAYERS, type SparkModule } from './splats/SplatsLayer.js';
import type { SplatsConfig, SplatsRevealOptions, SplatsStats } from './splats/types.js';
import { SplatsController } from './splats/SplatsController.js';
import type { ResolvedSplatsOptions } from './splats/options.js';
import type { ParcelClickEvent } from './parcels/types.js';
import { Compass } from './studio/Compass.js';
import { ScaleBar, type ScaleBarUnits } from './studio/ScaleBar.js';
import * as THREE from 'three';
import { MINIATURE_IMAGERY_TILT_SHIFT, resolveTiltShift, type TiltShiftSettings } from './rendering/TiltShiftPass.js';
import { approach, prefersReducedMotion, tauFor, DURATION, EASE, progress } from './core/motion.js';
import { logger } from './util/log.js';

type EventMap = {
  ready: HereBeDragonsEventPayload;
  tileload: HereBeDragonsEventPayload;
  tileerror: HereBeDragonsEventPayload;
  viewchange: HereBeDragonsEventPayload;
};

class HereBeDragonsImpl implements HereBeDragons {
  private readonly bus = new EventBus<EventMap>();
  private readonly renderer: Renderer;
  private readonly scene: SceneRoot;
  private readonly camera: MapCameraController;
  private readonly composer: Composer;
  private readonly projection: Projection;
  private readonly source: PMTilesSource;
  private readonly workerPool: TileWorkerPool;
  private readonly layers: LayerRegistry;
  private readonly tileManager: TileManager;
  /** Tile reveal: the rounded-union coverage field the basemap materials
   *  sample (always present; `tileReveal: false` just leaves it switched off). */
  private readonly coverage: CoverageField;
  /** Optional low-res underlay (only constructed if `options.lowResUnderlay`). */
  private readonly baseTileManager: BaseTileManager | null;
  /** Direct handle to the labels layer for setting place-label elevation. */
  private readonly labelsLayer: LabelsLayer;
  private readonly treesLayer: TreesLayer;
  private readonly grassLayer: GrassLayer;
  private readonly wavesLayer: WavesLayer;
  private readonly signsLayer: SignsLayer;
  /** Drifting pollen motes (atmospheric; theme-gated). Added straight to the
   *  scene, ticked from the RAF loop — not a tile layer. */
  private readonly sporesField: SporesField;
  private readonly bridgesManager: BridgesManager;
  private rafHandle = 0;
  private destroyed = false;
  private cloudTime = 0;
  /**
   * Render-on-demand flag. The RAF loop only runs the (expensive, 5-pass)
   * `composer.render()` when something that affects the rendered image
   * changed — camera moved, a tile built, an overlay/theme/highlight
   * mutated. Set true here on construction so the first frame always paints.
   * On a static scene this drops the GPU from a continuous ~100% to ~0%,
   * which is the difference between a passively-cooled laptop thermal-
   * throttling within a minute and staying cool indefinitely.
   */
  private needsRender = true;
  /**
   * Observes the container so the renderer / camera / composer track its size.
   * Critically covers the case where the container has no layout size yet at
   * construction (CSS/fonts not applied): the renderer would init at 0×0 and
   * the composer at a 1×1 target, so the first frame blits a single stretched
   * sky-blue pixel across the canvas and — with no resize ever firing — stays
   * that way until a manual refresh. The observer's callback fires when the
   * real size lands and re-renders correctly.
   */
  private resizeObserver?: ResizeObserver;
  /**
   * Smoothed (EMA) RAF-to-RAF delta in milliseconds, sampled on render frames
   * only — see the comment block in `start()` for why idle frames are excluded.
   * Hoisted from a closure local so the public `getFrameMs()` / `getFps()` can
   * read it without owning the RAF loop. Reset to vsync (16.7 ms) at the start
   * of every `start()` call so a visibility-resume gets a fresh measurement.
   */
  private smoothedFrameMs = 1000 / 60;
  /**
   * Frames elapsed since the last actual `composer.render()`. A safety-net
   * heartbeat: even with `needsRender` false we force a render every
   * `RENDER_HEARTBEAT_FRAMES` so any dirty source we forgot to wire up
   * self-corrects within ~0.5 s instead of leaving a permanently stale
   * frame. Idle cost is then ~2 fps, not 60 — still cool, still correct.
   */
  private framesSinceRender = 0;
  private static readonly RENDER_HEARTBEAT_FRAMES = 30;
  /**
   * Frames to ignore before the FPS-based auto-downgrade starts watching.
   * The first second or two of operation is always slow — shader compile,
   * initial tile mesh builds, GPU buffer uploads — and that's NOT the
   * steady-state cost we want to react to. 120 frames ≈ 2 s at 60 FPS or
   * 4 s at 30 FPS, both long enough for the warmup spike to subside.
   */
  private static readonly AUTO_DOWNGRADE_WARMUP_FRAMES = 120;
  /**
   * Consecutive over-budget frames (post-warmup) needed to trigger the
   * auto-downgrade. 60 frames ≈ 1 s sustained slowness — long enough that
   * a single GC pause or first-time tile build doesn't trip it, short
   * enough that genuine slow hardware downgrades quickly.
   */
  private static readonly AUTO_DOWNGRADE_STREAK_FRAMES = 60;
  /**
   * Frames to ignore before the auto-upgrade watcher considers a promotion.
   * Same role as AUTO_DOWNGRADE_WARMUP_FRAMES but for the inverse direction
   * (low → high). 120 frames ≈ 2 s on low tier where the per-frame cost is
   * minimal — long enough for the system to settle, short enough that the
   * "first paint = low / upgrade visible ~2 s later" experience is snappy.
   */
  private static readonly AUTO_UPGRADE_WARMUP_FRAMES = 120;
  /** Consecutive under-threshold frames needed to trigger an auto-upgrade. */
  private static readonly AUTO_UPGRADE_STREAK_FRAMES = 60;
  private onPointerMove?: (e: PointerEvent) => void;
  private onPointerLeave?: () => void;
  private onDblClick?: (e: MouseEvent) => void;
  private tagsManager: TagsManager;
  private polygonsManager: PolygonsManager;
  private buildingsManager: BuildingsManager;
  /** Optional parcels overlay (second PMTiles source). Null when no
   *  `parcels` option was supplied — keeps existing maps zero-cost. */
  private parcelsManager: ParcelsManager | null = null;
  /** Optional Gaussian-splat tile overlay (Spark). The controller always
   *  exists but holds NO layer until a `splats.urlTemplate` is configured —
   *  at construction or later through `setSplatsOptions()` — so existing
   *  maps stay zero-cost and Spark is never imported for them. */
  private splats!: SplatsController;
  private compass: Compass;
  /** Scale-bar overlay. Null when the caller passed `scaleBar: false`. */
  private scaleBar: ScaleBar | null = null;
  /** Initial zoom/tilt/bearing — used by resetView() / double-click reset. */
  private readonly defaultZoom: number;
  private readonly defaultTilt: number;
  private readonly defaultBearing: number;
  /**
   * Base FogExp2 density captured at construction (from SceneRoot). Each
   * frame the active density is set to:
   *   baseFogDensity × fogStrength × smoothstep(fogTiltStart, fogTiltEnd, tilt)
   * so looking straight down doesn't fog the whole map, and the studio /
   * developer can dial intensity + tilt thresholds at runtime.
   */
  private baseFogDensity = 0;
  /** Tilt (deg) below which fog is fully off. Default 30. Runtime-tunable. */
  private fogTiltStart = 30;
  /** Tilt (deg) at and above which fog is at full strength. Default 40. */
  private fogTiltEnd = 40;
  /** Multiplier on the per-frame fog density. 1.0 = the scene's authored
   *  density; >1 thickens (closer horizon); <1 thins (farther horizon). */
  private fogStrength = 1;
  /** Whether buildings are currently flattened to ground (Y collapse). */
  private buildingsFlat = false;
  /** Painterly watercolor-wash strength on flat surfaces (0..1). Theme-seeded,
   *  runtime-tunable via setSurfacePainterly. */
  private surfacePainterlyValue = 0;
  /** Screen-space paper-grain strength in the final pass (0..1). */
  private paperGrainValue = 0;
  /** Tilt-shift miniature: where the eased strength is heading (0 / 1) and where it is. */
  /**
   * The user's reduced-motion preference, cached and kept live. Every eased effect reads it:
   * with it on, animations jump to their end state rather than merely running faster (which is
   * what the media query actually asks for).
   */
  private reducedMotion = prefersReducedMotion();
  private tiltShiftTarget = 0;
  private tiltShiftStrength = 0;
  /** `setTiltShift({ … })` has been called: those settings beat the overlay's imagery preset. */
  private tiltShiftCustomized = false;
  /** The splat overlay's miniature look is driving the tilt-shift (see syncMiniature), and the
   *  settings to hand back when it stops. */
  private miniatureActive = false;
  private miniatureSaved: TiltShiftSettings | null = null;
  private readonly tiltShiftNdc = new THREE.Vector3();
  /** True while the splats overlay holds the post chain at (or on the way to
   *  / from) a neutral grade. */
  private splatsNeutralGrade = false;
  /** How far the grade has eased toward neutral: 0 = the theme's look,
   *  1 = neutral (linear time; `applySplatsGrade` smooths it). */
  private splatsGradeT = 0;
  /** Theme look saved while the neutral grade is active (restored on exit). */
  private savedGrade: { saturation: number; shine: number } | null = null;
  /** Procedural road surfacing (cobblestone/dirt) strength (0..1). */
  private roadTextureValue = 0;
  /** Whether drifting spore/pollen motes are enabled. */
  private sporesEnabledValue = false;
  /** Whether low/mid-rise buildings get peaked roofs. Theme-seeded (only Ghibli
   *  enables it), runtime-tunable via setPitchedRoofsEnabled. */
  private pitchedRoofsEnabledValue = false;
  /** Global wind-sway multiplier for grass + tree billboards (1 = default). */
  private windStrengthValue = 1;
  /** Most-recently-applied theme name (via applyTheme). Empty if never set. */
  private currentTheme = '';
  /** Active custom color overrides layered on top of the current theme. */
  private customColors: Partial<ThemeColors> = {};
  /** Current cloud opacity (0..1). Tracked so the studio can read it back. */
  private cloudsOpacity = 1;
  /** Whether the cloud pass is currently enabled. Off by default; the
   *  constructor opts in only via an explicit `clouds` option or a quality
   *  tier whose `clouds` flag is set (both tiers ship it off). */
  private cloudsEnabled = false;
  /** Whether the dB heat-map overlay pass is currently enabled. */
  private noiseEnabled = false;
  /**
   * Smoothed frame time (ms) above which the tile manager throttles mesh
   * building so the camera stays smooth. Default ~22 ms (≈ 45 FPS floor).
   */
  private readonly frameBudgetMs: number;
  /** `performance.framePacing` (default true): see gpuStillBusy. */
  private readonly framePacing: boolean;
  /** `performance.settleFadeMs` (default 400, 0 = snap): see beginSettleFade. */
  private readonly settleFadeMs: number;
  /** `performance.reprojection` (default true): held ticks present the last frame warped to the
   *  current camera (Composer.presentReprojected) instead of repeating it. */
  private readonly reprojection: boolean;
  /** Projection × view the last real frame was rendered with (valid once one has been). */
  private readonly renderedViewProj = new THREE.Matrix4();
  private renderedValid = false;
  private readonly scratchViewProj = new THREE.Matrix4();
  /**
   * Settle dissolve state. `hold`: the captured moving frame stays on screen (renders go on
   * behind it) until full detail has been drawn (`ready`) or `SETTLE_HOLD_MAX_MS` passes;
   * `fade`: the screen blends from that frame into the live picture over `settleFadeMs`.
   */
  private settle: { phase: 'idle' | 'hold' | 'fade'; since: number; fadeStart: number; ready: boolean } =
    { phase: 'idle', since: 0, fadeStart: 0, ready: false };
  /** Motion LoD was drawing the lite splats on the previous tick (a flip back = detail rising). */
  private lastSplatsLite = false;
  /** Detail ramp over the second half of a glide (see core/motionDetail), and the camera pose of
   *  the previous tick it measures the on-screen step from. */
  private readonly motionDetail = createMotionDetail();
  private readonly lastCamPos = new THREE.Vector3(Number.NaN, 0, 0);
  private readonly lastCamQuat = new THREE.Quaternion();
  /** Longest the settle dissolve holds the moving frame waiting for full detail, ms. */
  private static readonly SETTLE_HOLD_MAX_MS = 700;
  /** Resolved render-quality tier — exposed via `getQualityTier()` so apps
   *  (and the demo HUD) can see whether auto-detect picked 'low', 'mobile',
   *  or 'high'. Mutable: `setQualityTier()` flips it at runtime. */
  private qualityTier: QualityLevel;
  /** Effective device-pixel-ratio actually handed to the renderer. */
  private effectivePixelRatio: number;
  /**
   * Active cap on `window.devicePixelRatio`. Tracks the quality profile's
   * `pixelRatioCap` so `updateDevicePixelRatio()` can re-derive the effective
   * value whenever the window moves to a different-DPR monitor.
   */
  private pixelRatioCap: number;
  /**
   * User-pinned pixel ratio, if any. When set we never auto-adjust on DPR
   * change — the developer asked for a specific value.
   */
  private readonly pixelRatioExplicit: number | undefined;
  /**
   * The pixel ratio last pushed to the renderer. Differs from
   * `effectivePixelRatio` while dynamic resolution is rendering at the cheaper
   * motion ratio: `effectivePixelRatio` is the *rest* target, this is what's
   * actually live on the GPU right now. Surfaced by `getPixelRatio()`.
   */
  private appliedPixelRatio: number;
  /**
   * Whether dynamic resolution is enabled. Forced off when the developer
   * pinned an explicit `pixelRatio` (they asked for an exact ratio). See the
   * `dynamicResolution` option.
   */
  private dynamicResolutionEnabled: boolean;
  /** Render-loop counters since the last `getRenderStats()` (see that method). */
  private renderStats: RenderStats = emptyRenderStats();
  /** GPU frame pacing: fences of the frames submitted while splats were resident, oldest
   *  first, with their submit times. */
  private frameFences: { sync: WebGLSync; at: number }[] = [];
  /** Frames allowed on the GPU at once under pacing (see gpuStillBusy). */
  private static readonly FRAMES_IN_FLIGHT = 1;
  /** Motion LoD: full-detail splat tiles come back this long after the camera's last move. */
  private static readonly MOTION_LOD_SETTLE_MS = 250;
  /** Never hold a frame back longer than this, whatever the fence says (lost context, driver). */
  private static readonly PACING_MAX_HOLD_MS = 100;
  /** `splats.leanMap` in effect right now: splats showing, the map's own effects parked. */
  private leanMapActive = false;
  /** What lean mode switched off, to put back when the splats go. */
  private leanSaved: { clouds: boolean; dynamicResolution: boolean } | null = null;
  /**
   * Pixel-ratio cap applied while the view is moving or tiles are streaming —
   * 1 (no Retina super-sampling during motion). The rest ratio is
   * `effectivePixelRatio`; on a 1× display the two are equal so dynamic res is
   * a no-op.
   */
  private static readonly MOTION_PIXEL_RATIO_CAP = 1;
  /** True while currently rendering at the motion (low) ratio. */
  private renderingLowRes = false;
  /** `performance.now()` of the last frame that moved the camera or streamed a tile. */
  private lastInteractionMs = 0;
  /**
   * Set by the camera `onChange` callback, consumed once per RAF tick. A
   * dedicated flag (not the shared `needsRender`) so the one-frame render we
   * force to redraw at full resolution on settle isn't mistaken for camera
   * motion — which would flip us straight back to low res and thrash.
   */
  private cameraDirty = false;
  /**
   * How long after the last camera move / tile stream to wait before snapping
   * back to full resolution. Long enough that the damping inertia tail and the
   * brief gaps between tile builds don't trigger a premature (and costly)
   * re-allocation to full res mid-interaction.
   */
  private static readonly DYNAMIC_RES_SETTLE_MS = 180;
  /**
   * Whether scroll/zoom smoothness is prioritized over tile loading by
   * suspending mesh construction during a gesture. See the
   * `interactionTilePriority` option.
   */
  private interactionTilePriorityEnabled: boolean;
  /**
   * True between a MapControls `start` and `end` — the user has the map
   * physically grabbed (drag / pinch / wheel). Set even before the camera has
   * moved, so the gate closes on frame one of a gesture.
   */
  private gesturePressed = false;
  /**
   * `performance.now()` of the last frame the camera actually moved. Combined
   * with `gesturePressed` and a settle window this keeps the tile-build gate
   * closed through the damping inertia glide after the user lets go.
   */
  private lastCameraMotionMs = 0;
  /** Unregister hook for the `matchMedia` DPR-change listener. */
  private dprWatcherCleanup?: () => void;
  /** Tab-visibility listener — re-kicks the RAF loop when the tab returns
   *  from a backgrounded state (the loop drops itself when `document.hidden`). */
  private visibilityHandler?: () => void;
  /**
   * Whether the RAF loop is allowed to call `setQualityTier('low')` after
   * observing sustained slow frames. True only when the developer didn't
   * pin the quality tier explicitly — `quality: 'auto'` (the default) opts
   * in; `quality: 'high'` or `'low'` opts out (the developer asked for a
   * specific tier, we don't second-guess them).
   */
  private autoDowngradeAllowed: boolean;
  /** FPS threshold (smoothed frame ms) below which auto-downgrade fires. */
  private readonly autoDowngradeFrameMs: number;
  /**
   * Frames-since-start counter for the FPS sampling window. We ignore the
   * first warmup frames (shader compile, initial tile builds — those are
   * legitimately slow but not steady-state), then watch for a sustained
   * over-budget run before triggering the downgrade.
   */
  private autoDowngradeFrameCount = 0;
  /** Consecutive over-budget frames since the warmup ended. */
  private autoDowngradeStreak = 0;
  /**
   * Whether the RAF loop is allowed to call `setQualityTier('high')` after
   * observing sustained fast frames on `'low'`. True for `quality: 'auto'`
   * starts (the default), false for explicit `'low'` / `'high'`. Reset to
   * false after a successful upgrade so we don't toggle back and forth.
   */
  private autoUpgradeAllowed: boolean;
  /** FPS threshold (smoothed frame ms) BELOW which auto-upgrade fires. */
  private readonly autoUpgradeFrameMs: number;
  /** Same role as autoDowngradeFrameCount but for the upgrade direction. */
  private autoUpgradeFrameCount = 0;
  /** Consecutive under-threshold frames since the warmup ended. */
  private autoUpgradeStreak = 0;
  /**
   * Target camera tilt (deg) when a floor-tagged badge opens. Tilting down
   * to ~60° reveals the highlighted floor band on the side of the building
   * — anything shallower hides building height. Camera moves to MAX of
   * current tilt and this value (so already-tilted views aren't reduced).
   */
  private static readonly FLOOR_BADGE_TILT = 60;
  /**
   * Target logical zoom when a floor-tagged badge opens. The model is
   * 2^-zoom distance from target, so z=14 ≈ 1024 m out — far enough back
   * that the building and its surroundings are clearly visible without
   * the building filling the screen. Was 15 (~512 m) — that still felt
   * "too zoomed in." Camera moves to MAX of current zoom and this value
   * (so already-close views aren't pulled BACK against the user's wishes).
   */
  private static readonly FLOOR_BADGE_ZOOM = 14;
  /**
   * Full camera view (lat/lon/zoom/tilt/bearing) captured at the moment
   * `onFloorBadgeOpen` fired. `null` when no restore is pending (either
   * no floor badge is currently open, or the camera was already at the
   * target view so we didn't move it).
   */
  private savedViewForFloorBadge: CameraView | null = null;
  /**
   * Developer-supplied tilt range from construction, retained so a tier
   * switch from `'low'` (which clamps tilt to 0) back to `'high'` can
   * restore whatever range the developer originally specified instead of
   * clearing the tilt constraint outright.
   */
  private readonly originalTiltRange: { min: number; max: number } | null;

  constructor(container: HTMLElement, options: HereBeDragonsOptions) {
    this.projection = new Projection(options.center.lat, options.center.lon);
    // Resolve the render-quality tier first — it caps pixelRatio (the single
    // biggest fill-rate lever on integrated GPUs), the MSAA sample count, and
    // contributes conservative tile-load defaults. An explicit `pixelRatio`
    // or `performance.*` option still overrides whatever the profile sets.
    //
    // `'auto'` (or undefined) starts the map on `'high'` and lets the RAF-loop
    // watcher drop to `'low'` if frame time stays bad. `'high'` is the
    // appropriate default now that its profile is the cheap FXAA-only path
    // (what was previously labeled `'low'`); only devices that genuinely
    // struggle with it should fall back to the new top-down `'low'` tier.
    const isAuto = options.quality === undefined || options.quality === 'auto';
    // Auto mode: phones/tablets start on the 'mobile' ceiling (detected from
    // the platform — Safari redacts the GPU string on iOS, so we can't probe
    // it). Detecting at CONSTRUCTION (not via the runtime frame watcher) is
    // deliberate: starting a 2 GB iPhone on the full 'high' retina chain can
    // exhaust the WebGL memory budget and lose the context before any
    // downgrade could fire. Desktops still start on 'high' and rely on the
    // watcher to drop to 'low' if needed. An explicit `quality` always wins.
    const initialQualityOption: QualityLevel = isAuto
      ? (isMobileDevice() ? 'mobile' : 'high')
      : (options.quality as QualityLevel);
    const quality = resolveQualityProfile(initialQualityOption);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    const effectivePixelRatio = options.pixelRatio ?? Math.min(dpr, quality.pixelRatioCap);
    this.qualityTier = quality.level;
    this.effectivePixelRatio = effectivePixelRatio;
    this.appliedPixelRatio = effectivePixelRatio;
    this.pixelRatioCap = quality.pixelRatioCap;
    this.pixelRatioExplicit = options.pixelRatio;
    // Dynamic resolution defaults OFF: the map stays at full resolution during
    // pans, zooms, and tile streaming so it never goes soft and then snaps crisp
    // on settle. Smoothness during gestures is carried by the interaction gate
    // (tile-build deferral) instead, which needs no resolution drop. Opt back in
    // with `dynamicResolution: true` for fill-rate-bound devices. A pinned
    // `pixelRatio` ("exactly this, always") also forces the downscale off.
    this.dynamicResolutionEnabled =
      (options.dynamicResolution ?? false) && options.pixelRatio === undefined;
    // Tile-build deferral during gestures — OFF by default so tiles keep
    // building (streaming in fresh detail) while you pan and zoom, rather than
    // bursting in only once motion settles. Per-frame build caps still throttle
    // the GPU uploads. Opt in with `interactionTilePriority: true` to trade
    // mid-gesture detail for maximally glass-smooth scroll/zoom.
    this.interactionTilePriorityEnabled = options.interactionTilePriority ?? false;
    this.renderer = new Renderer(container, {
      pixelRatio: effectivePixelRatio,
      background: options.background,
      // GPU context can drop on a long tab background / driver crash. The
      // Renderer preventDefault's the lost event; on restore we force a
      // redraw — Three re-uploads textures + programs + buffers itself.
      onContextRestored: () => { this.needsRender = true; }
    });
    this.scene = new SceneRoot();
    this.defaultZoom = options.zoom;
    this.defaultTilt = options.tilt ?? 55;
    this.defaultBearing = options.bearing ?? 0;
    this.camera = new MapCameraController(this.renderer.dom, this.projection, {
      zoom: this.defaultZoom,
      tilt: this.defaultTilt,
      bearing: this.defaultBearing
    });
    // Labels sit on their own THREE layer so the normal pass can exclude them.
    // The camera needs that layer enabled here so they still appear in the
    // color pass and FXAA composite. Same for buildings, which the normal
    // pass excludes only when they're flattened (suppresses footprint
    // outlines that would otherwise be drawn around every building).
    this.camera.three.layers.enable(LABEL_THREE_LAYER);
    this.camera.three.layers.enable(BUILDING_THREE_LAYER);
    // Trees are billboards (custom vertex shader) — always excluded from the
    // normal pass, so the camera just keeps this layer on for the color pass.
    this.camera.three.layers.enable(TREE_THREE_LAYER);
    // Grass billboards: same deal as trees — excluded from the normal pass,
    // present in the color pass.
    this.camera.three.layers.enable(GRASS_THREE_LAYER);
    // Shoreline waves: custom animated shader, also excluded from the normal pass.
    this.camera.three.layers.enable(WAVES_THREE_LAYER);
    // Drifting spores: custom billboard shader, also excluded from normal pass.
    this.camera.three.layers.enable(SPORES_THREE_LAYER);
    // Shop-sign banners: billboard shader, also excluded from normal pass.
    this.camera.three.layers.enable(SIGNS_THREE_LAYER);
    // Gaussian splats (optional overlay): Spark's renderer mesh + per-tile
    // SplatMeshes sit on their own layer so the normal pass can exclude them.
    this.camera.three.layers.enable(SPLAT_THREE_LAYER);
    if (options.bounds) this.camera.setBounds(options.bounds);
    // Save the developer's chosen tilt range BEFORE any tier-imposed cap so
    // setQualityTier can restore it when switching back from `'low'` to
    // `'high'`. (`'low'` clamps tilt to 0 to enforce the top-down view.)
    this.originalTiltRange = options.tiltRange ?? null;
    if (options.tiltRange) this.camera.setTiltRange(options.tiltRange);
    if (options.bearingRange) this.camera.setBearingRange(options.bearingRange);
    if (options.zoomRange) this.camera.setZoomRange(options.zoomRange);
    // MSAA sample count comes from the quality profile (4 on 'high', 0 on
    // 'low'), unless the developer overrides it with the `msaa` option. Fixed
    // at construction — the render targets are allocated with this sample count.
    this.composer = new Composer(
      this.renderer,
      this.scene.three,
      this.camera.three,
      options.msaa ?? quality.msaaSamples
    );
    // The 'low' tier skips the normal + outline passes entirely — that's a
    // whole second scene render plus a full-screen Sobel shader gone, the
    // biggest fixed per-frame GPU saving on an integrated GPU.
    this.composer.setOutlineEnabled(quality.outlines);
    // Saturation lives in OutlinePass on `'high'` (via theme settings, default
    // 1.5) and in FxaaPass on `'low'` so the saturation-less look that low
    // tier used to ship with gets equivalent vibrance for free. FxaaPass runs
    // on every tier so this knob is safe to set unconditionally; on high we
    // hold it at 1.0 to avoid compounding with the outline pass's own boost.
    this.composer.setSaturation(this.splatsNeutralGrade || quality.outlines ? 1.0 : 1.5);

    // Note: `applyQualityStructure` would normally fire here, but several
    // of its targets (LayerRegistry, TileManager) don't exist yet at this
    // point in construction. The call has been moved to AFTER tileManager
    // is built (see below). The early subset of toggles that the composer
    // needs (FXAA passthrough, outlines, saturation) is applied inline
    // around the Composer construction above.
    this.composer.setFxaaEnabled(quality.fxaa);

    // Push the scene's fog config into the clouds pass so distant clouds fade
    // into the sky on the same exponential curve as scene geometry.
    const fog = this.scene.three.fog;
    if (fog && 'color' in fog && 'density' in fog) {
      this.baseFogDensity = (fog as THREE.FogExp2).density;
      this.composer.setFog(fog.color as THREE.Color, this.baseFogDensity);
    }
    // Sun direction from Lights.ts (sun.position = (800, 1200, 600)) normalized.
    this.composer.setSunDirection(new THREE.Vector3(800, 1200, 600).normalize());

    this.layers = new LayerRegistry();
    this.layers.register('water', new WaterLayer(this.scene.materials));
    this.layers.register('waterways', new WaterwaysLayer(this.scene.materials));
    this.layers.register('landuse', new LanduseLayer(this.scene.materials));
    this.layers.register('roads', new RoadsLayer(this.scene.materials));
    this.layers.register('rails', new RailsLayer(this.scene.materials));
    this.layers.register('buildings', new BuildingsLayer(this.scene.materials));
    this.labelsLayer = new LabelsLayer(this.scene.materials, {
      getCameraZoom: () => this.camera.getView().zoom,
      camera: this.camera.three,
      getViewport: () => ({ width: this.renderer.width, height: this.renderer.height })
    });
    this.layers.register('labels', this.labelsLayer);
    this.layers.register(
      'cars',
      new CarsLayer(this.scene.materials, {
        scene: this.scene.three,
        getCameraZoom: () => this.camera.getView().zoom
      })
    );
    // Cars are opt-in — keep the default scene quiet. The user options loop
    // below can flip this back on via `layers: { cars: true }`.
    this.layers.setEnabled('cars', false);
    this.treesLayer = new TreesLayer(this.scene.materials, {
      getCameraZoom: () => this.camera.getView().zoom
    });
    this.layers.register('trees', this.treesLayer);
    // Trees are opt-in too — thousands of billboards per tile is a deliberate
    // choice. Enable via `layers: { trees: true }`.
    this.layers.setEnabled('trees', false);

    // Wind-blown grass — scattered billboard tufts over green landuse that
    // ripple in a travelling wind wave. Opt-in (dense + animates every frame
    // while in view); enable via `layers: { grass: true }`.
    this.grassLayer = new GrassLayer(this.scene.materials, {
      getCameraZoom: () => this.camera.getView().zoom
    });
    this.layers.register('grass', this.grassLayer);
    this.layers.setEnabled('grass', false);

    // Shoreline foam — animated white-capped waves breaking along the coast.
    // Opt-in (animates every frame while a coast is in view); enable via
    // `layers: { waves: true }`.
    this.wavesLayer = new WavesLayer(this.scene.materials, {
      getCameraZoom: () => this.camera.getView().zoom
    });
    this.layers.register('waves', this.wavesLayer);
    this.layers.setEnabled('waves', false);

    // Sparse Japanese shop-sign banners — opt-in; enable via `layers: { signs: true }`.
    this.signsLayer = new SignsLayer(this.scene.materials, {
      getCameraZoom: () => this.camera.getView().zoom
    });
    this.layers.register('signs', this.signsLayer);
    this.layers.setEnabled('signs', false);

    // Drifting pollen motes — a scene-level atmospheric effect (not a tile
    // layer). Enabled per theme in applyMergedPalette, ticked in the RAF loop.
    this.sporesField = new SporesField();
    this.scene.three.add(this.sporesField.mesh);

    // Arched bridge decks. Not a registry layer: it consumes the bridge
    // centerlines the roads extractor split out, stitches them across tiles,
    // and rebuilds the decks globally (ticked from the RAF loop below).
    this.bridgesManager = new BridgesManager(this.scene.materials, {
      scene: this.scene.three
    });

    for (const [name, cfg] of Object.entries(options.layers ?? {})) {
      const enabled = typeof cfg === 'boolean' ? cfg : cfg?.enabled !== false;
      this.layers.setEnabled(name as LayerName, enabled);
    }

    // Frame-budget threshold: above this smoothed frame time, the tile
    // manager throttles mesh building so panning stays smooth. Default
    // ~22 ms ≈ a 45 FPS floor. The EMA self-corrects, so a single flat
    // value works across GPU tiers — a slow machine simply spends more
    // time over budget and throttles harder.
    this.frameBudgetMs = options.performance?.frameBudgetMs ?? 22;
    this.framePacing = options.performance?.framePacing !== false;
    this.reprojection = options.performance?.reprojection !== false;
    const settleFade = options.performance?.settleFadeMs;
    this.settleFadeMs = typeof settleFade === 'number' && Number.isFinite(settleFade) && settleFade >= 0
      ? settleFade
      : 400;

    // Auto-tier watchers. In auto mode we start at `'high'` (the cheap
    // FXAA-only 3D path is the right default for almost everything), then:
    //   - autoDowngrade: enabled at start, watches for sustained slow
    //     frames (≥ 67 ms = 15 FPS by default) and drops to `'low'` once.
    //   - autoUpgrade: disabled at start; only meaningful if we'd been
    //     downgraded and want to try recovering. We DON'T re-enable it
    //     after downgrade, to avoid oscillation — once we've dropped to
    //     `'low'`, we lock in.
    // After at most one downgrade both watchers are off.
    this.autoUpgradeAllowed = false;
    this.autoDowngradeAllowed = isAuto;
    // ~12 ms ≈ 80+ FPS while on low. Conservative on purpose: low tier has
    // to be running with real headroom (not just "fine") before we risk
    // the 3–4× cost of high — that headroom is what keeps high above the
    // 15 FPS floor on this hardware. If 'low' is sitting at 30–60 FPS we
    // stay there; you get the prettier render only when the system can
    // clearly afford it.
    this.autoUpgradeFrameMs = options.performance?.autoUpgradeFrameMs ?? 12;
    // ~67 ms ≈ 15 FPS floor. Sustained below this for AUTO_DOWNGRADE_STREAK
    // frames after the warmup → flip to 'low' once. We keep 'high' all the
    // way down to 15 FPS on the principle that the prettier render is still
    // worth it at 20–30 FPS — only below 15 does panning feel genuinely
    // broken, at which point dropping pixelRatio + clouds + outlines is a
    // better trade-off than continuing to crawl. Much more lenient than
    // `frameBudgetMs` (22 ms, ~45 FPS) which only throttles tile loading.
    this.autoDowngradeFrameMs = options.performance?.autoDowngradeFrameMs ?? 67;

    this.source = new PMTilesSource(options.pmtiles_url);
    this.workerPool = new TileWorkerPool({ size: options.performance?.workerPoolSize });
    // Tile-pipeline params: an explicit `performance.*` option always wins;
    // otherwise the quality profile's `tile` overrides apply (only the 'low'
    // tier sets them — 'high' leaves them undefined so the TileManager's own
    // desktop defaults take over).
    const qtile = quality.tile;
    // Tile reveal: the basemap is drawn inside the rounded union of the
    // loaded tiles. The field writes the coverage uniforms every basemap
    // material shares; the TileManager feeds it tile membership.
    this.coverage = new CoverageField(
      this.projection,
      this.scene.materials.coverage,
      // Reduced motion: keep the rounded-union SHAPE but drop its grow animation.
      ((r) => (this.reducedMotion ? { ...r, growMs: 0 } : r))(resolveTileReveal(options.tileReveal))
    );
    this.composer.setCoverageUniforms(this.scene.materials.coverage);
    this.tileManager = new TileManager({
      source: this.source,
      workerPool: this.workerPool,
      projection: this.projection,
      scene: this.scene,
      layers: this.layers,
      camera: this.camera,
      coverage: this.coverage,
      tileWindowRadius: options.performance?.tileWindowRadius ?? qtile?.tileWindowRadius,
      tileWindowRadiusFar: options.performance?.tileWindowRadiusFar ?? qtile?.tileWindowRadiusFar,
      visibleRadius: options.performance?.visibleRadius ?? qtile?.visibleRadius,
      maxTileApplyMsPerFrame: options.performance?.maxTileApplyMsPerFrame,
      dispatchInterval: options.performance?.dispatchInterval ?? qtile?.dispatchInterval,
      onTileLoad: (z, x, y) => {
        // New tile means new buildings — auto-elevations on tags hovering
        // over this region may need to update.
        this.tagsManager.invalidateAutoElevations();
        this.bus.emit('tileload', { type: 'tileload', z, x, y });
      },
      onTileError: (z, x, y, error) =>
        this.bus.emit('tileerror', { type: 'tileerror', z, x, y, error })
    });

    // NOW that LayerRegistry + TileManager + scene materials exist, apply
    // the tier's full structural profile in one place — flat buildings,
    // tilt cap, label visibility, requested zoom offset. The same call
    // fires from setQualityTier so a runtime tier flip applies the same
    // set of toggles consistently. (Composer-side toggles — FXAA, outlines,
    // saturation — already fired earlier where they belong.)
    this.applyQualityStructure(quality);

    // Low-res underlay. Enabled by default — opt out via
    // `lowResUnderlay: false`. When on, a small set of coarse tiles paints
    // the ground beneath the z14 grid so panning / first-paint never shows
    // blank canvas. It also becomes the ONLY content once the main z14 grid
    // is suspended at far zoom (see TileManager's far-zoom cutoff below).
    // Cost is modest (a 5×5 z12 working set, ground + road layers only,
    // shares the worker pool); UX win is significant.
    const underlayCfg = options.lowResUnderlay;
    const underlayEnabledByOption =
      underlayCfg === undefined ||
      underlayCfg === true ||
      (typeof underlayCfg === 'object' && underlayCfg?.enabled !== false);
    // The quality tier can FORCE the underlay off (`'low'` does this — saves
    // the extra z11 tile decode + GPU memory on weak devices). An explicit
    // `lowResUnderlay: true` from the developer still wins, but the default
    // / undefined case respects the tier preference.
    const underlayEnabled =
      underlayEnabledByOption && (underlayCfg === true || quality.underlay);
    if (underlayEnabled) {
      const underlayZoom = typeof underlayCfg === 'object' ? underlayCfg.zoom : undefined;
      this.baseTileManager = new BaseTileManager({
        source: this.source,
        workerPool: this.workerPool,
        projection: this.projection,
        scene: this.scene,
        layers: this.layers,
        camera: this.camera,
        zoom: underlayZoom,
        onSceneChange: () => { this.needsRender = true; }
      });
    } else {
      this.baseTileManager = null;
    }

    // Far-zoom cutoff for the main z14 grid. Only enabled when the underlay is
    // present — suspending the main grid swaps the wide-view content over to
    // the underlay, so without one the map would go blank when zoomed out. An
    // explicit `performance.mainTileMinZoom` overrides the default threshold;
    // pass it as `-Infinity` to force the feature off even with an underlay.
    if (underlayEnabled) {
      this.tileManager.setMainTileMinZoom(
        options.performance?.mainTileMinZoom ?? DEFAULT_MAIN_TILE_MIN_ZOOM
      );
    }

    // Track the preference live — a user can flip it without reloading the page.
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener?.('change', (e) => {
        this.reducedMotion = e.matches;
        // Snap anything mid-flight straight to where it was heading.
        if (e.matches) {
          this.tiltShiftStrength = this.tiltShiftTarget;
          this.composer.tiltShift.setStrength(this.tiltShiftStrength);
          this.needsRender = true;
        }
      });
    }

    this.camera.onChange = () => {
      // Any camera mutation (pan/zoom/rotate, including the per-frame damping
      // settle) makes the frame dirty — render-on-demand keys off this.
      this.needsRender = true;
      // Separate signal for dynamic resolution: this fires only on real camera
      // motion, never on the synthetic full-res redraw we trigger on settle.
      this.cameraDirty = true;
      // Timestamp real motion so the build gate stays closed through the
      // damping inertia glide after the user lets go (read in the RAF tick).
      this.lastCameraMotionMs = performance.now();
      const view = this.getView();
      this.bus.emit('viewchange', { type: 'viewchange', ...view });
    };
    // Proactive gesture signal: close the build gate the instant the user
    // grabs the map (before the camera even moves), reopen it a settle window
    // after they release and the inertia glide stops.
    this.camera.onInteractionStart = () => {
      this.gesturePressed = true;
    };
    this.camera.onInteractionEnd = () => {
      this.gesturePressed = false;
    };

    // Push pointer position into the clouds pass — clouds dissipate in a
    // circular region around the cursor, giving a reactive "pushed away"
    // feel as the user moves the mouse over the map.
    this.composer.setMouseUv(-10, -10);
    const canvas = this.renderer.dom;
    this.onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const u = (e.clientX - rect.left) / rect.width;
      // Three.js / WebGL UV: y=0 is bottom; DOM y=0 is top. Flip.
      const v = 1 - (e.clientY - rect.top) / rect.height;
      this.composer.setMouseUv(u, v);
    };
    this.onPointerLeave = () => {
      this.composer.setMouseUv(-10, -10);
    };
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);

    // Double-click anywhere on the canvas flies the camera back to the
    // original zoom/tilt/bearing (center stays put — users typically dblclick
    // because they spun the camera and want to reorient, not relocate).
    this.onDblClick = () => {
      void this.resetView();
    };
    canvas.addEventListener('dblclick', this.onDblClick);

    // Seed aspect ratio for the cloud shader's circular pointer disk.
    this.composer.resize(this.renderer.width, this.renderer.height);

    this.buildingsManager = new BuildingsManager(
      {
        container,
        renderer: this.renderer,
        camera: this.camera,
        scene: this.scene.three,
        // Canvas building clicks change the highlight overlay without
        // touching the camera or a public setter — nudge render-on-demand.
        onSceneChange: () => { this.needsRender = true; },
        // Tile reveal: no hover / click / elevation hits on masked-out geometry.
        coverageAt: (x, z) => this.coverage.coverageAt(x, z)
      },
      options.buildings ?? {}
    );

    this.tagsManager = new TagsManager(
      {
        container,
        renderer: this.renderer,
        camera: this.camera,
        projection: this.projection,
        // A tag with `buildingId` triggers the building's highlight overlay
        // (and optional floor band) when its modal opens.
        onBuildingHighlight: (id, floor) => {
          if (id === null) this.buildingsManager.clearSelection();
          else this.buildingsManager.selectBuilding(id, floor);
        },
        // Default tag anchor = top of the building underneath (if any). When
        // the buildings layer is disabled, return null so tags fall back to
        // ground level.
        resolveAutoElevation: (lon, lat) => {
          if (!this.layers.isEnabled('buildings')) return null;
          const m = this.projection.project(lon, lat);
          const y = this.buildingsManager.getElevationAt(m.x, -m.y);
          return y > 0 ? y : null;
        },
        // Floor-tagged badges fly the camera to: (1) center on the badge,
        // (2) zoom in to at least FLOOR_BADGE_ZOOM, and (3) tilt down to at
        // least FLOOR_BADGE_TILT. Each axis uses MAX(current, target) so a
        // user already zoomed in past the target keeps their closer view.
        // Full pre-open camera view is saved and restored on close so the
        // user returns to exactly where they were before clicking.
        onFloorBadgeOpen: ({ lat, lon, elevation }) => {
          const view = this.camera.getView();
          const targetZoom = Math.max(view.zoom, HereBeDragonsImpl.FLOOR_BADGE_ZOOM);
          const targetTilt = Math.max(view.tilt, HereBeDragonsImpl.FLOOR_BADGE_TILT);

          // The camera's target is always on the ground plane (y = 0), so
          // pointing it directly at (lat, lon) leaves an elevated badge
          // projecting above screen center under tilt. The math to put the
          // badge exactly on the look-axis: offset the ground target in
          // the camera's forward direction by `elevation × tan(tilt)`.
          //
          // Forward direction in mercator XY: derived from the camera-pose
          // math in MapCameraController.setOrientation, which puts the
          // camera at +X_scene_offset at bearing=90 (looking WEST). In
          // mercator coords (X = east, Y = north) the unit FORWARD vector
          // from camera→target is (-sin(b), cos(b)) — negative on X.
          //
          // CLAMP: the ideal offset `H × tan(T)` can exceed the camera's
          // own back-distance from the target (`R × sin(T)`) on tall
          // buildings at close zoom — in which case the camera position
          // lands NORTH of the badge (literally past it). We cap the
          // offset at 50 % of the back-distance, so the camera always
          // stays at least half its usual remove behind the badge. The
          // badge ends up not-quite-centered but still well-framed instead
          // of fully overshot. R formula matches `zoomToDistance` in the
          // camera controller (base 512 m at zoom 15).
          const tiltRad = (targetTilt * Math.PI) / 180;
          const bearingRad = (view.bearing * Math.PI) / 180;
          const cameraDistance = 512 * Math.pow(2, 15 - targetZoom);
          const idealOffset = elevation * Math.tan(tiltRad);
          const maxOffset = cameraDistance * Math.sin(tiltRad) * 0.5;
          const offsetDist = Math.min(idealOffset, maxOffset);
          const badgeMerc = this.projection.project(lon, lat);
          const targetMercX = badgeMerc.x - Math.sin(bearingRad) * offsetDist;
          const targetMercY = badgeMerc.y + Math.cos(bearingRad) * offsetDist;
          const targetLL = this.projection.unproject(targetMercX, targetMercY);

          // Skip the fly + save if everything's already at or past the
          // target. ~0.0001° is roughly 11 m at the equator, well below
          // a typical building footprint — a smaller delta isn't worth
          // a 600 ms animation.
          const needsCenter =
            Math.abs(targetLL.lat - view.lat) > 0.0001 ||
            Math.abs(targetLL.lon - view.lon) > 0.0001;
          const needsZoom = targetZoom > view.zoom + 0.1;
          const needsTilt = targetTilt > view.tilt + 0.5;
          if (!needsCenter && !needsZoom && !needsTilt) return;
          this.savedViewForFloorBadge = view;
          // Lift the tilt/zoom limits for as long as this floor badge stays
          // open so the reveal can reach FLOOR_BADGE_TILT / FLOOR_BADGE_ZOOM
          // even when the developer (or a quality tier) clamped the range
          // tighter. Reinstated in onFloorBadgeClose, after the camera has
          // flown back inside the original limits.
          this.camera.suspendLimits();
          // Suppress TagsManager's per-frame "anchor drifted out of view →
          // close modal" check for the ENTIRE duration this floor-badge
          // modal is open, not just the open-fly. The badge can intermit-
          // tently fall outside the visibility predicate (off-screen during
          // mid-animation OR clustered with neighbours at the destination
          // zoom), and that auto-close fires onFloorBadgeClose → restore
          // flight → visible "zoom in then immediately zoom back out".
          // Manual close paths (close button, click-outside, switch tag)
          // still go through closeModal and run our restore correctly.
          // Released in onFloorBadgeClose below.
          this.tagsManager.setModalAutoCloseSuppressed(true);
          void this.camera.flyTo({
            lat: targetLL.lat,
            lon: targetLL.lon,
            zoom: targetZoom,
            tilt: targetTilt,
            bearing: view.bearing,
            durationMs: 600
          });
        },
        onFloorBadgeClose: () => {
          // Always release the auto-close suppression on close, even if we
          // didn't move the camera on open (no saved view): symmetry keeps
          // the flag from getting stuck on across edge cases like rapid
          // open/close.
          this.tagsManager.setModalAutoCloseSuppressed(false);
          if (this.savedViewForFloorBadge === null) {
            // Nothing was moved on open (so no limits were lifted) — but
            // reinstate defensively in case a suspend ever outlived its
            // saved view. No-op when nothing is suspended.
            this.camera.restoreLimits();
            return;
          }
          const restore = this.savedViewForFloorBadge;
          this.savedViewForFloorBadge = null;
          void this.camera
            .flyTo({
              lat: restore.lat,
              lon: restore.lon,
              zoom: restore.zoom,
              tilt: restore.tilt,
              bearing: restore.bearing,
              durationMs: 600
            })
            .then(() => {
              // Reinstate the tilt/zoom limits only after the camera has flown
              // back inside them — and only if no new floor badge opened while
              // we flew. Switching straight from one floor badge to another
              // keeps a floor selected (it sets savedViewForFloorBadge again),
              // so the limits must stay lifted for the new reveal; restoring
              // here would clamp it into a visible jump.
              if (this.savedViewForFloorBadge === null) this.camera.restoreLimits();
            });
        }
      },
      options.tags ?? {}
    );

    this.polygonsManager = new PolygonsManager({
      scene: this.scene.three,
      projection: this.projection
    });

    // Optional parcels overlay — only constructed when a `parcels.pmtilesUrl`
    // is supplied, so existing single-source maps allocate nothing for it.
    // The archive is opened in `init()` (alongside the basemap source).
    if (options.parcels?.pmtilesUrl) {
      this.parcelsManager = new ParcelsManager(
        {
          renderer: this.renderer,
          scene: this.scene.three,
          camera: this.camera,
          projection: this.projection,
          // A parcel load / click changes the scene without a camera move or
          // public setter — nudge render-on-demand so it paints immediately.
          onSceneChange: () => { this.needsRender = true; }
        },
        options.parcels
      );
    }

    // Optional Gaussian-splat overlay — a layer is only constructed once a
    // `splats.urlTemplate` is known (here, or later via `setSplatsOptions`).
    // Spark itself is imported lazily (see SplatsLayer.open). The quality
    // tier picks the resident-splat budget: 'high' gets `maxSplats`,
    // 'mobile' / 'low' the smaller `lowTierMaxSplats` (0 = off) — an
    // integrated GPU can show a few hundred thousand splats, not the
    // millions a 5×5 window holds.
    // Spark's module is imported lazily by the layer; kick the import NOW when a tile source is
    // configured, so it overlaps the map's own start-up instead of beginning when the overlay
    // opens (measured under the dev server: ~1.8 s before the first tile could be fetched).
    if (options.splats?.urlTemplate) void HereBeDragonsImpl.sparkImport();
    this.splats = new SplatsController(
      {
        createLayer: (config) => this.createSplatsLayer(config),
        // `maxCameraZoom`: a cap laid over the map's own zoom range while
        // the overlay is on, lifted (previous limit back) when it goes off.
        onCameraTiltCapChange: (maxTilt) => {
          this.camera.setMaxTiltCap(maxTilt);
          this.needsRender = true;
        },
        onCameraZoomCapChange: (maxZoom) => {
          this.camera.setMaxZoomCap(maxZoom);
          this.needsRender = true;
        },
        onChange: () => { this.needsRender = true; }
      },
      options.splats
    );
    this.splats.setQualityTier(this.qualityTier);

    // Compass overlay — mounted on the same container as the canvas. Visible
    // by default unless the developer opts out via `options.compass === false`.
    this.compass = new Compass(this, container);
    this.compass.setVisible(options.compass !== false);

    // Scale-bar overlay — mounted bottom-right (compass takes bottom-left).
    // Suppressed only when the caller explicitly passes `scaleBar: false`;
    // a config object opts in with customisations.
    if (options.scaleBar !== false) {
      const scaleBarOpts = typeof options.scaleBar === 'object' ? options.scaleBar : {};
      this.scaleBar = new ScaleBar(this, container, scaleBarOpts);
    }

    // Watch for `window.devicePixelRatio` changes (e.g. dragging the window
    // between monitors with different DPI). Without this the renderer stays
    // pinned to the DPR captured at construction and the canvas gets up- or
    // down-scaled by the display — which manifests as blurry outlines and
    // softer text. The watcher re-derives the effective pixel ratio whenever
    // DPR changes; if the developer pinned `pixelRatio` explicitly we leave
    // it alone (they asked for a specific value).
    this.installDprWatcher();

    // Apply fog overrides early so the very first updateFogForTilt() in the
    // RAF loop sees the developer's chosen thresholds. Undefined fields
    // leave the defaults intact (30 / 40 / 1.0).
    if (options.fog) {
      if (options.fog.tiltStart !== undefined) this.setFogTiltStart(options.fog.tiltStart);
      if (options.fog.tiltEnd !== undefined) this.setFogTiltEnd(options.fog.tiltEnd);
      if (options.fog.strength !== undefined) this.setFogStrength(options.fog.strength);
    }
    if (options.labelHeight !== undefined) this.setLabelHeight(options.labelHeight);
    if (options.tileSpawnDurationMs !== undefined) this.setTileSpawnDurationMs(options.tileSpawnDurationMs);

    if (options.useUserLocation) this.requestUserLocation(options);

    // Apply the declarative "look" fields BEFORE starting the render loop so
    // the very first frame paints with the requested theme — without this,
    // there's a visible flash from the default (light-blue cottagecore sky)
    // to whatever theme the user actually asked for, ~50–100 ms later.
    if (options.theme) this.applyTheme(options.theme);
    if (options.customColors && Object.keys(options.customColors).length > 0) {
      this.setCustomColors(options.customColors);
    }
    if (options.clouds !== undefined) {
      if (typeof options.clouds === 'boolean') {
        this.setCloudsEnabled(options.clouds);
      } else {
        if (options.clouds.enabled !== undefined) this.setCloudsEnabled(options.clouds.enabled);
        if (options.clouds.opacity !== undefined) this.setCloudsOpacity(options.clouds.opacity);
      }
    } else {
      // No explicit `clouds` option — fall back to the quality tier's
      // default. The 'low' tier turns clouds OFF: the cloud pass is a
      // full-screen raymarch that costs the same every frame regardless of
      // scene content, the heaviest fixed per-frame GPU cost on weak GPUs.
      this.setCloudsEnabled(quality.clouds);
    }
    // Painterly FX overrides on top of the theme (each defaults to the theme's
    // value when omitted). Applied after the theme so an explicit option wins.
    if (options.surfacePainterly !== undefined) this.setSurfacePainterly(options.surfacePainterly);
    if (options.paperGrain !== undefined) this.setPaperGrain(options.paperGrain);
    if (options.tiltShift) this.setTiltShift(options.tiltShift === true ? true : options.tiltShift);
    if (options.roadTexture !== undefined) this.setRoadTexture(options.roadTexture);
    if (options.spores !== undefined) this.setSporesEnabled(options.spores);
    if (options.pitchedRoofs !== undefined) this.setPitchedRoofsEnabled(options.pitchedRoofs);
    if (options.buildingStyle !== undefined) this.setBuildingStyle(options.buildingStyle);
    if (options.cloudPreset !== undefined) this.setCloudPreset(options.cloudPreset);
    if (options.lightPreset !== undefined) this.setLightPreset(options.lightPreset);
    if (options.windStrength !== undefined) this.setWindStrength(options.windStrength);
    if (options.signsDensity !== undefined) this.setSignsDensity(options.signsDensity);
    if (options.signsMinZoom !== undefined) this.setSignsMinZoom(options.signsMinZoom);
    if (options.outline !== undefined) this.setOutline(options.outline);

    // Track the container's size for the lifetime of the map. Besides handling
    // ordinary layout changes (so consumers don't need their own resize wiring),
    // this self-heals the first-paint race where the container had no size yet
    // at construction — see the field comment.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }

    // Idle-tab pause: when the tab is hidden, `tick` drops the loop instead
    // of re-arming RAF; this listener re-kicks `start()` once the tab is
    // visible again. The guard against double-start covers the case where a
    // visibilitychange fires while `rafHandle` is already armed.
    if (typeof document !== 'undefined') {
      this.visibilityHandler = (): void => {
        if (this.destroyed) return;
        if (!document.hidden && this.rafHandle === 0) this.start();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    this.start();
  }

  /**
   * Fire-and-forget geolocation request. The map continues to render at
   * `options.center` while the request is pending; on success it flies to
   * the user's coordinates. Permission denial / timeout is logged but
   * otherwise silent — the developer-supplied `center` remains in effect.
   */
  private requestUserLocation(options: HereBeDragonsOptions): void {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      logger.warn('geolocation unavailable in this environment');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Respect bounds — if the developer restricted the map and the user
        // is outside that region, skip rather than yanking them away.
        if (options.bounds) {
          const { latitude: lat, longitude: lon } = pos.coords;
          const b = options.bounds;
          if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) {
            logger.info('user location outside configured bounds; keeping default center');
            return;
          }
        }
        void this.flyTo({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          zoom: options.zoom,
          durationMs: 1200
        });
      },
      (err) => logger.warn(`geolocation failed: ${err.message}`),
      { timeout: 10_000, maximumAge: 60_000 }
    );
  }

  async init(): Promise<void> {
    // Run shader pre-compile in parallel with the PMTiles archive open. Both
    // are async and have no ordering dependency, so this saves one stage.
    await Promise.all([
      this.source.open(),
      this.precompileShaders(),
      // Open the parcels archive in parallel; its own `open()` swallows
      // failures so a broken parcel source can never block the basemap.
      this.parcelsManager?.open() ?? Promise.resolve(),
      // Lazily import Spark for the splats overlay; its `open()` swallows
      // failures (missing optional peer dep → overlay stays inert).
      this.splats.open()
    ]);
    await this.tileManager.start();
    // Kick the underlay dispatcher synchronously so its first fetches go out
    // alongside the z14 burst rather than after a 0.5 s delay.
    this.baseTileManager?.start();
    this.bus.emit('ready', { type: 'ready' });
  }

  /**
   * Walk every palette material once through the renderer so its shader
   * program compiles AHEAD of the first tile that needs it. Without this,
   * the first tile carrying each material variant (water, road_major,
   * road_minor, building, ...) triggers a 50–200 ms shader compile during
   * its first render — which is exactly the spot where the user is trying
   * to pan and the main thread feels frozen.
   *
   * Uses `compileAsync` when available (three.js r158+, KHR_parallel_shader
   * _compile extension) so the compile happens off the JS main thread.
   * Falls back to the synchronous `compile()` otherwise.
   */
  private async precompileShaders(): Promise<void> {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array([0,1,0, 0,1,0, 0,1,0]), 3));
    geo.setIndex([0, 1, 2]);
    // The building material's onBeforeCompile patches read a buildingIndex
    // attribute — provide a dummy so the patched shader compiles cleanly.
    geo.setAttribute('buildingIndex', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 1));
    geo.setAttribute('buildingRoof', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 1));

    const warmup = new THREE.Group();
    warmup.name = 'ShaderWarmup';
    for (const slot of Object.values(Palette)) {
      const mat = this.scene.materials.get(slot);
      warmup.add(new THREE.Mesh(geo, mat));
    }
    // The underlay draws with the materials' UNMASKED twins (it opts out of
    // the tile reveal) — separate programs, so warm those too. Buildings
    // never appear in the underlay; the ground plane's twin compiles with
    // the first frame anyway.
    if (this.baseTileManager) {
      for (const slot of Object.values(Palette)) {
        if (slot === Palette.building || slot === Palette.building_top) continue;
        warmup.add(new THREE.Mesh(geo, this.scene.materials.getUnmasked(slot)));
      }
    }
    // Live lights influence shader specialization (light count is part of
    // the program key for MeshToonMaterial). Add to the real scene so the
    // compiled programs match what tile meshes will actually run.
    this.scene.three.add(warmup);
    try {
      const r = this.renderer.three as THREE.WebGLRenderer & {
        compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown>;
      };
      if (typeof r.compileAsync === 'function') {
        await r.compileAsync(this.scene.three, this.camera.three);
      } else {
        r.compile(this.scene.three, this.camera.three);
      }
    } finally {
      this.scene.three.remove(warmup);
      geo.dispose();
    }
  }

  /**
   * Modulate fog density by camera tilt. With a near-top-down view there's
   * no horizon to fade into, so fog just blankets the visible map — bad
   * UX especially when zoomed out. Below `fogTiltStart` the density is zero,
   * between `fogTiltStart` and `fogTiltEnd` it ramps via smoothstep, at or
   * above `fogTiltEnd` it's full. The final density also gets multiplied by
   * `fogStrength` (1.0 = authored, >1 thicker, <1 thinner).
   */
  private updateFogForTilt(): void {
    if (this.baseFogDensity === 0) return;
    const tilt = this.camera.getView().tilt;
    const start = this.fogTiltStart;
    const end = this.fogTiltEnd;
    // Degenerate / inverted ranges collapse to a hard step at `start` rather
    // than producing NaN from the divide-by-zero. Same end-state behavior.
    const span = end > start ? end - start : 1e-6;
    const t = Math.max(0, Math.min(1, (tilt - start) / span));
    const factor = t * t * (3 - 2 * t); // smoothstep
    const density = this.baseFogDensity * this.fogStrength * factor;
    const fog = this.scene.three.fog;
    if (fog && 'density' in fog) {
      (fog as THREE.FogExp2).density = density;
      if ('color' in fog) {
        this.composer.setFog(fog.color as THREE.Color, density);
      }
    }
  }

  /**
   * Recompute the thin-ribbon sub-pixel fade for the current view. Replaces the
   * MSAA we dropped for performance: roads/rails dissolve into the ground as
   * they shrink below ~a pixel so they stop crawling/shimmering when zoomed out.
   *
   * `metersPerPixel` is the ground-plane span of one CSS pixel at the camera
   * target — `(2 * distance * tan(fov/2)) / cssHeight`. CSS height (not the
   * device drawing buffer) so the fade thresholds don't shift when dynamic
   * resolution flips the pixel ratio mid-pan.
   */
  private updateSubpixelFade(): void {
    const cam = this.camera.three;
    const distance = cam.position.distanceTo(this.camera.controls.target);
    const cssHeight = Math.max(1, this.renderer.height);
    const halfFov = (cam.fov * Math.PI) / 360; // fov is the full vertical FOV in deg
    const metersPerPixel = (2 * distance * Math.tan(halfFov)) / cssHeight;
    this.scene.materials.setSubpixelFade(metersPerPixel);
  }

  private start(): void {
    let last = performance.now();
    // EMA of the RAF-to-RAF delta on RENDER frames only. ~16.7 ms = "keeping
    // up with vsync." Sustained higher = dropping frames. Seeded at 16.7 so
    // the first slow load frames don't instantly trip the budget.
    //
    // Idle-frame measurement was misleading: when render-on-demand skipped
    // composer.render() the RAF callback was still running at vsync (~16.7
    // ms), which got averaged into smoothedFrameMs even though no real GPU
    // work happened. That made `autoUpgradeFrameMs = 12 ms` effectively
    // impossible to satisfy (you can't be faster than vsync on an idle
    // scene). We now only update the EMA + watchers when the user is
    // actually rendering — see `lastFrameRendered` below.
    // Reset the live FPS EMA on every start() — visibility-resume re-enters
    // here, and a fresh measurement window is what consumers' perf HUDs
    // (reading via getFps/getFrameMs) should see after a pause.
    this.smoothedFrameMs = 1000 / 60;
    let lastFrameRendered = false;
    // GPU frame pacing (see gpuStillBusy): a tick that wanted to draw but was held back
    // because the GPU had not finished the previous frame, and when the last real render
    // happened — the frame cost the governors read is render-to-render, not tick-to-tick.
    let lastTickPaced = false;
    let lastRenderAt = performance.now();
    const tick = (): void => {
      if (this.destroyed) return;
      // Idle-tab pause: if the document is hidden, drop the loop entirely so
      // the map uses zero CPU/GPU in a background tab. The visibilitychange
      // listener installed in the constructor re-kicks `start()` (with a
      // fresh closure + fresh `last` timestamp) once the tab is visible
      // again, so the first resumed dt isn't a huge jump.
      if (typeof document !== 'undefined' && document.hidden) {
        this.rafHandle = 0;
        return;
      }
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      // frameBudgetOk uses the latest movement-derived smoothedFrameMs. On
      // an idle frame this might be stale (last value from when we last
      // rendered) — that's fine, it represents the latest known actual
      // workload and is the right value for throttling decisions.
      const frameBudgetOk = this.smoothedFrameMs < this.frameBudgetMs;

      // --- per-frame state updates (cheap; always run) -------------------
      // camera.update fires onChange → sets needsRender + cameraDirty while
      // damping.
      this.camera.update(dt);
      // Consume the real-motion signal (set by camera.onChange just above) —
      // a dedicated flag so the synthetic settle redraw isn't read as motion.
      const cameraMoved = this.cameraDirty;
      this.cameraDirty = false;
      // Any motion ends a settle dissolve at once: the moving picture is what should show.
      if (cameraMoved && this.settle.phase !== 'idle') this.cancelSettleFade();
      // --- gesture tile-priority gate -----------------------------------
      // Suspend mesh construction while a gesture is live so scroll/zoom owns
      // the main thread. "Live" = the map is physically grabbed (gesturePressed,
      // set on MapControls start/end) OR the camera moved within the last
      // GESTURE_SETTLE_MS (covers the inertia glide after release). When the
      // gate falls open (motion just settled), kick a burst flush so the
      // backlog that piled up snaps in while the camera is at rest.
      // When the gate opens after a gesture, the suspended backlog drains a
      // couple of tiles per frame (TileManager's per-frame build cap), so
      // uploads spread across frames instead of spiking the settle render.
      const suspendBuilds = shouldSuspendBuilds({
        // Lean map (splats on): always — a basemap mesh upload mid-pan only competes with
        // the splats for the GPU; the backlog lands the moment the camera settles.
        enabled: this.interactionTilePriorityEnabled || this.leanMapActive,
        gesturePressed: this.gesturePressed,
        msSinceMotion: now - this.lastCameraMotionMs
      });
      // tileManager / layers report whether they changed the rendered scene.
      const tileDirty = this.tileManager.update(false, frameBudgetOk, suspendBuilds);
      this.baseTileManager?.update(false);
      const layersDirty = this.layers.update(dt);
      // Recompute the parcels overlay's visible tile window + kick loads.
      // Cheap when no overlay is configured (null), disabled, or below its
      // minZoom; new tiles flag `needsRender` via the onSceneChange nudge.
      this.parcelsManager?.update();
      // Same for the Gaussian-splat overlay (tile-pyramid window; the level
      // follows the camera zoom).
      // Motion LoD: lite tiles while the camera moves, full detail once it has settled.
      const atRest = now - this.lastCameraMotionMs >= HereBeDragonsImpl.MOTION_LOD_SETTLE_MS;
      this.splats.setCameraMoving(!atRest);
      // Detail comes back over the second half of a scroll / fling, not after it.
      this.splats.setMotionDetail(stepMotionDetail(this.motionDetail, {
        stepPx: this.cameraStepPx(dt),
        gestureLive: this.camera.isGestureLive(),
        atRest,
        stopPx: GLIDE_STOP_PX
      }));
      this.splats.update();
      // Lite → full detail at rest: dissolve into it rather than pop (see beginSettleFade).
      const splatsLite = this.splats.isDrawingLite();
      if (this.lastSplatsLite && !splatsLite && !cameraMoved) this.beginSettleFade(now);
      this.lastSplatsLite = splatsLite;
      this.syncLeanMap();
      // `hideBasemap: 'covered'`: the overlay has just reported this frame's
      // rounded union — bake it NOW (a no-op when nothing moved), so the
      // vector map's cut and the imagery it complements are drawn from the
      // same instant rather than a frame apart.
      if (this.coverage.tick()) this.needsRender = true;
      this.syncMiniature();
      if (this.tickTiltShift(dt)) this.needsRender = true;
      this.updateSplatsGrade(dt * 1000);
      this.updateAmbientThrottle();
      // Bridge decks rebuild (debounced) when the loaded bridge-tile set
      // changes; a rebuild is a visible scene change.
      const bridgesDirty = this.bridgesManager.update(dt);
      // Drifting spores animate while visible (gated by theme + zoom inside).
      const sporesDirty = this.sporesField.update(
        dt,
        this.camera.controls.target,
        this.camera.getView().zoom
      );
      this.cloudTime += dt;

      // --- dynamic resolution -------------------------------------------
      // Drop to the cheap motion pixel ratio while the camera moves or tiles
      // stream, snap back to full res on settle.
      this.updateDynamicResolution(
        now,
        cameraMoved,
        tileDirty || this.tileManager.isStreaming()
      );

      // --- render-on-demand decision ------------------------------------
      // Only run the (expensive, 5-pass) render when something actually
      // changed. `needsRender` covers camera moves + scene-mutating API
      // calls; tile/layer dirty cover async loading + traffic; clouds drift
      // continuously so an enabled cloud pass is dirty every frame; and the
      // heartbeat is a safety net for any dirty source we didn't wire up.
      const cloudsDirty = this.cloudsEnabled;
      // The heat-map's ring bands animate, so treat its enabled state as
      // perpetually dirty like clouds. With zero sources the pass is a
      // no-op so this is free in practice.
      const noiseDirty = this.noiseEnabled;
      // No heartbeat while splat tiles are resident: each of those forced redraws
      // re-rasterises every splat from a cold GPU — measured 100–150 ms, twice a
      // second, on a map that is standing still. The overlay nudges needsRender
      // itself for everything that changes its picture (sorts, landings, fades).
      const heartbeat =
        this.framesSinceRender >= HereBeDragonsImpl.RENDER_HEARTBEAT_FRAMES && !this.splats.hasTiles();
      let willRender =
        this.needsRender || tileDirty || layersDirty || bridgesDirty ||
        sporesDirty || cloudsDirty || noiseDirty || heartbeat;
      // Settle dissolve: hold → fade once full detail has been drawn (or the hold times out),
      // then a blend step every tick. The fade owns the frame: the camera is still, so whatever
      // else asks for a render meanwhile (tiles landing after the gesture, their reveal) waits the
      // few hundred ms and is drawn right after — otherwise every blend step is a full-detail scene
      // render (measured: 4 steps ~110 ms apart instead of a fade). Not when the hold timed out:
      // then the live picture still has detail to gain and must keep rendering.
      let presentOnly = false;
      if (this.settle.phase === 'hold'
        && (this.settle.ready || now - this.settle.since > HereBeDragonsImpl.SETTLE_HOLD_MAX_MS)) {
        this.settle.phase = 'fade';
        this.settle.fadeStart = now;
      }
      if (this.settle.phase === 'fade') {
        const t = progress(now - this.settle.fadeStart, this.settleFadeMs, EASE.inOut);
        this.composer.setDissolveT(t);
        if (t >= 1) {
          this.composer.endDissolve();
          this.settle.phase = 'idle';
        }
        if (willRender && this.settle.ready && t < 1) {
          willRender = false;
          this.needsRender = true;
        }
        presentOnly = !willRender;
      }
      // Why this frame rendered (see getRenderStats): the counters that tell a
      // "why is the GPU busy while nothing moves?" investigation where to look.
      const rs = this.renderStats;
      rs.frames++;
      // GPU frame pacing: while splat tiles are resident, never queue a frame behind one the
      // GPU has not finished. Held back, the frame is drawn on the next tick with whatever
      // changed in between (needsRender carries the dirty state over).
      const paced = willRender && this.gpuStillBusy(now);
      if (paced) {
        willRender = false;
        this.needsRender = true;
        rs.paced++;
      }
      // Motion-LoD swap: hold the picture while the lite set sorts rather than draw the full set
      // a few more times behind it (see SplatsLayer.holdForSwap). Bounded by the layer, and only
      // started with no frame left unfinished on the GPU (pacing has just retired the done ones).
      let swapHeld = false;
      if (willRender && this.splats.holdForSwap(this.frameFences.length === 0)) {
        willRender = false;
        this.needsRender = true;
        rs.swapHeld++;
        swapHeld = true;
      }
      if (willRender) {
        rs.renders++;
        if (this.needsRender) rs.needsRender++;
        if (tileDirty) rs.tileDirty++;
        if (layersDirty) rs.layersDirty++;
        if (bridgesDirty) rs.bridgesDirty++;
        if (sporesDirty) rs.sporesDirty++;
        if (cloudsDirty) rs.cloudsDirty++;
        if (noiseDirty) rs.noiseDirty++;
        if (heartbeat) rs.heartbeat++;
        if (this.renderingLowRes) rs.lowRes++;
      }

      // --- FPS measurement + auto-tier watchers (movement frames only) ---
      // Only update when THIS frame and the PREVIOUS one both wanted to render
      // (a tick held back by GPU pacing still wanted to). The cost is the time
      // between two real renders: under pacing a render can follow a held-back
      // tick, and the tick interval alone would read as a fast frame.
      // Anything else (idle skip, just-resumed-from-idle) doesn't count.
      const frameMs = now - lastRenderAt;
      if (willRender && (lastFrameRendered || lastTickPaced)) {
        this.smoothedFrameMs = this.smoothedFrameMs * 0.9 + frameMs * 0.1;
        // Splats frame-time governor: the same render-to-render delta, but it
        // only counts frames drawn while the picture moves (it filters the
        // rest itself) — that is when every resident splat is re-rasterised.
        this.splats.reportFrame(
          frameMs,
          now - this.lastCameraMotionMs < HereBeDragonsImpl.SPLATS_MOTION_WINDOW_MS
        );

        // Auto-upgrade: 'auto' mode starts on 'low' and promotes once we
        // see sustained fast frames AFTER the warmup. Counters advance only
        // on rendering frames so the warmup is "120 frames of real work,"
        // not "120 RAFs that may have been mostly idle."
        if (this.autoUpgradeAllowed) {
          this.autoUpgradeFrameCount++;
          if (this.autoUpgradeFrameCount > HereBeDragonsImpl.AUTO_UPGRADE_WARMUP_FRAMES) {
            if (this.smoothedFrameMs <= this.autoUpgradeFrameMs) {
              this.autoUpgradeStreak++;
              if (this.autoUpgradeStreak >= HereBeDragonsImpl.AUTO_UPGRADE_STREAK_FRAMES) {
                logger.info(
                  `auto-upgrade: smoothed frame ${this.smoothedFrameMs.toFixed(1)} ms ` +
                  `≤ ${this.autoUpgradeFrameMs} ms for ${this.autoUpgradeStreak} frames → quality='high'`
                );
                this.autoUpgradeAllowed = false;
                // Reset the downgrade counters so the warmup period restarts
                // from zero on high. The first ~2 s after the tier flip are
                // expected to be slow (shader compile for the outline pass,
                // first cloud raymarch frame, etc.) — we don't want those
                // legitimate one-time spikes counted as "high is too slow."
                this.autoDowngradeAllowed = true;
                this.autoDowngradeFrameCount = 0;
                this.autoDowngradeStreak = 0;
                this.setQualityTier('high');
              }
            } else {
              this.autoUpgradeStreak = 0;
            }
          }
        }

        // Auto-downgrade: after a successful upgrade (or on a pinned-high
        // start), watch for sustained slow frames and flip back to 'low'.
        // One-shot: once we downgrade we lock in.
        if (this.autoDowngradeAllowed) {
          this.autoDowngradeFrameCount++;
          if (this.autoDowngradeFrameCount > HereBeDragonsImpl.AUTO_DOWNGRADE_WARMUP_FRAMES) {
            if (this.smoothedFrameMs >= this.autoDowngradeFrameMs) {
              this.autoDowngradeStreak++;
              if (this.autoDowngradeStreak >= HereBeDragonsImpl.AUTO_DOWNGRADE_STREAK_FRAMES) {
                logger.info(
                  `auto-downgrade: smoothed frame ${this.smoothedFrameMs.toFixed(1)} ms ` +
                  `≥ ${this.autoDowngradeFrameMs} ms for ${this.autoDowngradeStreak} frames → quality='low'`
                );
                this.autoDowngradeAllowed = false;
                this.setQualityTier('low');
              }
            } else {
              this.autoDowngradeStreak = 0;
            }
          }
        }
      }
      lastFrameRendered = willRender;
      lastTickPaced = paced;

      // --- Render (or skip) -----------------------------------------------
      if (willRender) {
        lastRenderAt = now;
        this.composer.setCloudTime(this.cloudTime);
        this.composer.setNoiseTime(this.cloudTime);
        this.updateFogForTilt();
        this.updateSubpixelFade();
        this.updateTiltShiftFocus();
        this.composer.render();
        this.fenceFrame(now);
        // The camera this frame was drawn with — what a reprojected present on a later held tick
        // warps FROM. three has just refreshed matrixWorldInverse inside render().
        const cam = this.camera.three;
        this.renderedViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        this.renderedValid = true;
        // The held frame may give way once full detail is what was just drawn.
        if (this.settle.phase === 'hold' && !this.renderingLowRes && this.splats.isDetailSettled()) {
          this.settle.ready = true;
        }
        // Tag/popup DOM overlays only need repositioning when something
        // moved — gate them with the render so a static idle scene does
        // zero per-frame work.
        this.tagsManager.update();
        this.buildingsManager.update();
        this.needsRender = false;
        this.framesSinceRender = 0;
      } else {
        this.framesSinceRender++;
        if (presentOnly) {
          if (this.composer.present()) rs.dissolveFrames++;
          else this.needsRender = true;   // the last picture is gone (a resize): render instead
        } else if ((paced || swapHeld) && this.reprojection && this.renderedValid && this.splats.hasTiles()) {
          // Held back with the camera moving: show the motion anyway, from the last frame.
          const cam = this.camera.three;
          cam.updateMatrixWorld();
          this.scratchViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
          if (!this.scratchViewProj.equals(this.renderedViewProj)) {
            this.scratchViewProj.invert();
            if (this.composer.presentReprojected(this.scratchViewProj, this.renderedViewProj, cam.position)) {
              rs.reprojected++;
              this.tagsManager.update();
            }
          }
        }
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /** On-screen camera movement since the previous tick, CSS px per REFERENCE frame (1/60 s) —
   *  translation over distance plus rotation, times the focal length in CSS px, scaled by the
   *  tick's length so a long frame does not read as a fast camera. */
  private cameraStepPx(dtS: number): number {
    const cam = this.camera.three;
    const first = Number.isNaN(this.lastCamPos.x);
    const dist = Math.max(1e-6, cam.position.distanceTo(this.camera.controls.target));
    const focalPx = this.renderer.height / 2 / Math.tan((cam.fov * Math.PI) / 360);
    const step = first
      ? 0
      : (cam.position.distanceTo(this.lastCamPos) / dist
        + 2 * Math.acos(Math.min(1, Math.abs(cam.quaternion.dot(this.lastCamQuat))))) * focalPx;
    this.lastCamPos.copy(cam.position);
    this.lastCamQuat.copy(cam.quaternion);
    return step * (1 / 60) / Math.max(dtS, 1 / 240);
  }

  /**
   * Start a settle dissolve: the picture is about to get sharper while the camera is still (dynamic
   * resolution coming back, the splat overlay leaving its motion LoD). The last presented frame is
   * captured and stays on screen while the sharp picture gets ready behind it, then fades into it
   * — one smooth focus pull instead of a resolution pop followed by a detail pop. Cheap: the fade
   * frames are a blend of two textures (see Composer.present).
   */
  private beginSettleFade(now: number): void {
    if (this.settleFadeMs <= 0 || this.settle.phase !== 'idle' || prefersReducedMotion()) return;
    if (!this.composer.beginDissolve()) return;
    this.settle = { phase: 'hold', since: now, fadeStart: 0, ready: false };
  }

  private cancelSettleFade(): void {
    this.composer.endDissolve();
    this.settle.phase = 'idle';
  }

  setView(lat: number, lon: number, zoom?: number): void {
    this.camera.setView(lat, lon, zoom);
  }

  getView(): CameraView {
    return this.camera.getView();
  }

  async flyTo(opts: FlyToOptions): Promise<void> {
    await this.camera.flyTo(opts);
  }

  async resetView(durationMs = 500): Promise<void> {
    const cur = this.getView();
    await this.camera.flyTo({
      lat: cur.lat,
      lon: cur.lon,
      zoom: this.defaultZoom,
      tilt: this.defaultTilt,
      bearing: this.defaultBearing,
      durationMs
    });
  }

  setLayerEnabled(name: LayerName, on: boolean): void {
    this.layers.setEnabled(name, on);
    this.tileManager.setLayerEnabled(name, on);
    // Toggling buildings on/off changes the resolver's answer for every tag
    // — drop the cached auto-elevations so they recompute next frame.
    if (name === 'buildings') this.tagsManager.invalidateAutoElevations();
    this.needsRender = true;
  }

  getLayerEnabled(name: LayerName): boolean {
    return this.layers.isEnabled(name);
  }

  applyTheme(name: import('./themes.js').ThemeName | (string & {})): void {
    const theme = THEMES[name];
    if (!theme) {
      logger.warn(`unknown theme "${name}"`);
      return;
    }
    this.currentTheme = name;
    // Applying a named theme clears any per-color overrides — the studio
    // re-applies its overrides on top via setCustomColors after a theme swap.
    this.customColors = {};
    this.applyMergedPalette(theme);
  }

  /**
   * Apply per-color overrides on top of the current theme. Pass an empty object
   * to clear all overrides. Keys correspond to ThemeColors (water, park, ...).
   */
  setCustomColors(colors: Partial<ThemeColors>): void {
    this.customColors = { ...colors };
    const base = THEMES[this.currentTheme];
    if (!base) {
      // No theme has been applied yet; treat the overrides as a partial theme
      // by falling back to defaults from any theme. cottagecore is a safe one.
      const fallback: ThemeColors = THEMES.cottagecore;
      this.applyMergedPalette({ ...fallback, ...this.customColors });
      return;
    }
    this.applyMergedPalette({ ...base, ...this.customColors });
  }

  /** Returns the active theme name (last applyTheme() argument), or ''. */
  getCurrentTheme(): string {
    return this.currentTheme;
  }

  /** Returns a copy of the active per-color overrides. */
  getCustomColors(): Partial<ThemeColors> {
    return { ...this.customColors };
  }

  setBearing(degrees: number): void {
    this.camera.setOrientation(undefined, degrees);
  }

  setTilt(degrees: number): void {
    this.camera.setOrientation(degrees, undefined);
  }

  setCloudsEnabled(on: boolean): void {
    if (this.leanMapActive && this.leanSaved) {
      // Lean map (splats on): remember the wish; it takes effect when the splats go.
      this.leanSaved.clouds = on;
      return;
    }
    this.cloudsEnabled = on;
    this.composer.setCloudsEnabled(on);
    this.needsRender = true;
  }

  setCloudsOpacity(opacity: number): void {
    this.cloudsOpacity = Math.max(0, Math.min(1, opacity));
    this.composer.setCloudsOpacity(this.cloudsOpacity);
    this.needsRender = true;
  }

  getCloudsEnabled(): boolean {
    return this.cloudsEnabled;
  }

  getCloudsOpacity(): number {
    return this.cloudsOpacity;
  }

  setNoiseEnabled(on: boolean): void {
    this.noiseEnabled = on;
    this.composer.setNoiseEnabled(on);
    this.needsRender = true;
  }

  getNoiseEnabled(): boolean {
    return this.noiseEnabled;
  }

  setNoiseSources(sources: ReadonlyArray<NoiseSource>): void {
    // Convert geographic → scene-world. The shader operates on the ground
    // plane (y = 0), so we only need (x, z): mercator-east becomes scene X,
    // mercator-north becomes scene -Z (matching the project / unproject
    // convention used elsewhere — see HereBeDragons.unproject for the inverse).
    const scene = sources.map((s) => {
      const m = this.projection.project(s.lon, s.lat);
      return { x: m.x, z: -m.y, db: s.db };
    });
    this.composer.setNoiseSources(scene);
    this.needsRender = true;
  }

  /** The render-quality tier currently in effect ('low', 'mobile', or 'high'). */
  getQualityTier(): QualityLevel {
    return this.qualityTier;
  }

  /**
   * The device-pixel-ratio the renderer is using right now. With dynamic
   * resolution active this is the motion ratio (≤1) while panning / streaming
   * and the tier's rest ratio once the view settles.
   */
  getPixelRatio(): number {
    return this.appliedPixelRatio;
  }

  /** Smoothed RAF-to-RAF frame time in milliseconds, sampled on render frames
   *  only (idle / hidden-tab frames don't pollute it). Reset on every
   *  visibility-resume. Useful for consumers to wire their own perf HUDs. */
  getFrameMs(): number {
    return this.smoothedFrameMs;
  }

  /** Smoothed frames-per-second derived from {@link getFrameMs}. */
  getFps(): number {
    return this.smoothedFrameMs > 0 ? 1000 / this.smoothedFrameMs : 0;
  }

  /**
   * Ground meters per CSS pixel at the camera's current latitude + zoom.
   * Standard Web Mercator scale (cos(lat) shrink) — accurate for a horizontal
   * line through the screen centre. Drives the scale-bar widget and is
   * exported so consumers can build their own distance overlays.
   */
  getMetersPerPixel(): number {
    const v = this.camera.getView();
    return Projection.metersPerPixel(v.lat, v.zoom);
  }

  /**
   * Capture the current map view as a data URL. The render is done
   * synchronously and the canvas read in the same JS tick — that's the
   * trick that makes capture work even though we use the default
   * `preserveDrawingBuffer: false` (which is much faster for the normal
   * render loop). The DOM overlays — compass, scale-bar, tag popups —
   * are not included; they're standalone HTML.
   *
   * Pass `pixelRatio` to override the renderer's current DPR — 2 or 3 is
   * a good choice for print/PDF exports. The override is temporary and
   * is restored before this method returns; the user's normal render loop
   * is undisturbed.
   *
   * @example
   *   const dataUrl = map.snapshot({ pixelRatio: 2 });
   *   const link = document.createElement('a');
   *   link.href = dataUrl;
   *   link.download = 'property.png';
   *   link.click();
   */
  snapshot(opts: SnapshotOptions = {}): string {
    const mime = opts.mimeType ?? 'image/png';
    // Save the current renderer state so we can fully restore.
    const prevPixelRatio = this.renderer.three.getPixelRatio();
    const overridePixelRatio = opts.pixelRatio;
    if (overridePixelRatio !== undefined && overridePixelRatio !== prevPixelRatio) {
      // setPixelRatio triggers an internal resize of the drawing buffer to
      // match width * pixelRatio; the canvas's CSS size is unaffected.
      this.renderer.three.setPixelRatio(overridePixelRatio);
      this.renderer.three.setSize(this.renderer.width, this.renderer.height, false);
      this.composer.resize(this.renderer.width, this.renderer.height);
    }
    // Synchronous render, then immediate readback. Any await between these
    // two calls would let the browser composite and clear the framebuffer.
    this.composer.setCloudTime(this.cloudTime);
    this.composer.setNoiseTime(this.cloudTime);
    this.composer.render();
    const dataUrl =
      opts.quality !== undefined
        ? this.renderer.dom.toDataURL(mime, opts.quality)
        : this.renderer.dom.toDataURL(mime);
    // Restore: revert pixel-ratio override and nudge needsRender so the
    // next user-driven RAF redraws at the original quality if needed.
    if (overridePixelRatio !== undefined && overridePixelRatio !== prevPixelRatio) {
      this.renderer.three.setPixelRatio(prevPixelRatio);
      this.renderer.three.setSize(this.renderer.width, this.renderer.height, false);
      this.composer.resize(this.renderer.width, this.renderer.height);
      this.needsRender = true;
    }
    return dataUrl;
  }

  setDynamicResolution(on: boolean): void {
    // A pinned `pixelRatio` means "exactly this, always" — honour it.
    if (this.pixelRatioExplicit !== undefined) return;
    if (on === this.dynamicResolutionEnabled) return;
    this.dynamicResolutionEnabled = on;
    if (!on) {
      // Turning it off: drop the motion-low state and restore full resolution,
      // redrawing crisp if we were mid-pan at the low ratio.
      this.renderingLowRes = false;
      if (this.syncPixelRatio()) this.needsRender = true;
    }
  }

  getDynamicResolution(): boolean {
    return this.dynamicResolutionEnabled;
  }

  setInteractionTilePriority(on: boolean): void {
    if (on === this.interactionTilePriorityEnabled) return;
    this.interactionTilePriorityEnabled = on;
    // Turning it off reopens the gate on the next tick; any backlog drains at
    // the normal per-frame build cap. Nothing else to do.
  }

  getInteractionTilePriority(): boolean {
    return this.interactionTilePriorityEnabled;
  }

  /**
   * Switch render-quality tier at runtime. Re-applies the profile's
   * runtime-safe levers — pixelRatio (the big fill-rate cut), the cloud
   * raymarch pass, and the outline pipeline (a whole second scene render).
   *
   * MSAA sample count is fixed at construction (it would need render-target
   * reallocation) and the tile-window radii likewise stay as set — switch
   * tiers via the `quality` option + a reload if you need those too. For
   * the purpose of "make this machine playable" the three live levers here
   * are the ones that matter.
   */
  setQualityTier(tier: QualityLevel): void {
    if (tier === this.qualityTier) return;
    const profile = resolveQualityProfile(tier);
    this.qualityTier = tier;
    this.pixelRatioCap = profile.pixelRatioCap;

    // pixelRatio — recompute against the device DPR (now under the new
    // tier's cap) and re-size the whole render chain.
    this.updateDevicePixelRatio();

    // Cloud raymarch + outline pipeline — both runtime-toggleable.
    this.setCloudsEnabled(profile.clouds);
    // Lean map (splats on) keeps the outline pipeline off whatever the tier says.
    this.composer.setOutlineEnabled(profile.outlines && !this.leanMapActive);
    // FXAA → passthrough (or back) on tier swap. `'low'` skips FXAA math.
    this.composer.setFxaaEnabled(profile.fxaa);
    // Keep the FxaaPass saturation in sync with the tier so a runtime swap
    // doesn't leave low tier monochrome or high tier double-saturated.
    this.composer.setSaturation(profile.outlines ? 1.0 : 1.5);
    if (this.splatsNeutralGrade) this.applySplatsGrade(this.splatsGradeT);
    // Structural toggles: flat buildings + tilt cap + labels + tile zoom.
    this.applyQualityStructure(profile);
    // Splats overlay: swap to the tier's resident-splat budget (evicts at
    // once when it shrinks; the user's enabled choice is preserved).
    this.splats.setQualityTier(tier);
    this.needsRender = true;
  }

  /**
   * Apply the tier's structural toggles. Called from construction (after
   * the layers + tile manager exist) and from setQualityTier so the two
   * paths stay in lock-step. The composer-side toggles (`fxaa`, outlines,
   * saturation) are NOT applied here — they fire earlier in construction
   * because they only depend on the Composer, which is built first.
   */
  private applyQualityStructure(profile: import('./rendering/quality.js').QualityProfile): void {
    // Flat buildings (collapse extrusions to footprints on `'low'`).
    this.setBuildingsFlat(profile.flatBuildings);
    // Tilt cap (clamp to 0 on `'low'` = top-down only; restore developer
    // option on `'high'`).
    if (profile.maxTilt !== undefined) {
      this.camera.setTiltRange({ min: 0, max: profile.maxTilt });
    } else {
      this.camera.setTiltRange(this.originalTiltRange);
    }
    // Labels layer (off on `'low'` — skips worker label decode AND the
    // per-frame screen-space collision pass for label meshes).
    this.layers.setEnabled('labels', profile.labels);
    this.tileManager.setLayerEnabled('labels', profile.labels);
    // Tile request zoom offset (-1 on `'low'` = z13 from a z14 archive;
    // ~3× less total geometry across the viewport).
    this.tileManager.setRequestedZoomOffset(profile.tileZoomOffset);
    // Ambient decoration suppression (`'mobile'` sets ambientFX:false). Force
    // the billboard/animation layers off and zero the painterly surface FX so
    // a phone-class GPU isn't paying for trees, grass, waves, signs, traffic,
    // spores, or a watercolor wash. `undefined`/`true` leaves everything as the
    // developer configured it, so 'low'/'high' are unaffected. The surface-FX
    // zeroing is re-asserted after every theme swap in applyMergedPalette so a
    // runtime `applyTheme` on mobile can't re-introduce the wash.
    if (profile.ambientFX === false) {
      this.suppressAmbientFX();
    }
  }

  /**
   * Force off all ambient decoration — the billboard/animated layers (trees,
   * grass, shoreline waves, shop signs, traffic cars), the drifting-spore
   * field, and the painterly surface wash / paper grain / road texturing.
   * Driven by the `'mobile'` tier (profile.ambientFX === false). Idempotent:
   * safe to call repeatedly (e.g. on each theme swap). Building extrusions,
   * labels, roads, water, tags, parcels — the realty essentials — are left on.
   */
  private suppressAmbientFX(): void {
    for (const name of ['trees', 'grass', 'waves', 'signs', 'cars'] as const) {
      if (this.layers.isEnabled(name)) this.setLayerEnabled(name, false);
    }
    // Zero the theme-seeded surface FX (these are tracked values + uniforms,
    // not layers — a theme re-seeds them, so this also runs post-applyTheme).
    if (this.surfacePainterlyValue !== 0) this.setSurfacePainterly(0);
    if (this.paperGrainValue !== 0) this.setPaperGrain(0);
    if (this.roadTextureValue !== 0) this.setRoadTexture(0);
    if (this.sporesEnabledValue) this.setSporesEnabled(false);
  }

  /**
   * Re-derive the effective pixel ratio from the current `window.device
   * PixelRatio` (capped by `pixelRatioCap`) and apply it to the renderer +
   * composer if it changed. Bails when the developer pinned `pixelRatio`
   * explicitly — they asked for a specific value, so we leave it alone.
   *
   * Triggered from the matchMedia DPR watcher (window moved to a different-
   * DPR monitor) and from `setQualityTier()` (cap changed).
   */
  private updateDevicePixelRatio(): void {
    if (this.pixelRatioExplicit !== undefined) return;
    if (typeof window === 'undefined') return;
    const dpr = window.devicePixelRatio;
    const pr = Math.min(dpr, this.pixelRatioCap);
    if (Math.abs(pr - this.effectivePixelRatio) < 1e-6) return;
    // `effectivePixelRatio` is the REST target; `syncPixelRatio()` re-derives
    // the value actually pushed to the GPU (which may be the motion ratio if
    // we're mid-pan) and re-allocates the targets only if it changed.
    this.effectivePixelRatio = pr;
    this.syncPixelRatio();
    this.needsRender = true;
  }

  /**
   * The pixel ratio that *should* be live right now: the cheaper motion cap
   * while dynamic resolution is rendering low-res, otherwise the rest target.
   */
  private desiredPixelRatio(): number {
    if (this.dynamicResolutionEnabled && this.renderingLowRes) {
      return Math.min(this.effectivePixelRatio, HereBeDragonsImpl.MOTION_PIXEL_RATIO_CAP);
    }
    return this.effectivePixelRatio;
  }

  /**
   * Push `desiredPixelRatio()` to the renderer + composer, re-allocating the
   * render targets, but only when the value actually changed. The single choke
   * point for every pixel-ratio change — dynamic-res flips, DPR-monitor
   * changes, and tier switches all funnel through here so `appliedPixelRatio`
   * stays the source of truth for what's live on the GPU. Returns whether the
   * ratio (and therefore the targets) actually changed.
   */
  private syncPixelRatio(): boolean {
    const pr = this.desiredPixelRatio();
    if (Math.abs(pr - this.appliedPixelRatio) < 1e-6) return false;
    this.appliedPixelRatio = pr;
    // The canvas keeps the display's ratio; a cheaper motion picture is rendered INTERNALLY at
    // pr / effective and upscaled by the final pass. Resizing the canvas's drawing buffer along
    // with the targets cost ~20 ms of main thread on the first moving tick of every gesture
    // (measured) — the frame the user is waiting for. Only a real DPR change touches the canvas.
    if (Math.abs(this.renderer.three.getPixelRatio() - this.effectivePixelRatio) > 1e-6) {
      this.renderer.three.setPixelRatio(this.effectivePixelRatio);
      this.composer.resize(this.renderer.width, this.renderer.height);
    }
    const scale = pr / this.effectivePixelRatio;
    this.composer.setRenderScale(scale);
    this.splats.setRenderScale(scale);
    return true;
  }

  /**
   * Dynamic-resolution decision, run once per RAF tick before the render.
   * Renders at the cheap motion ratio while the camera is moving or tiles are
   * streaming, then snaps back to the full rest ratio (and forces one redraw)
   * once both have been quiet for `DYNAMIC_RES_SETTLE_MS`.
   *
   * @param now           `performance.now()` for this tick.
   * @param cameraMoved   The camera moved this frame (real motion, not our
   *                      own settle redraw — see `cameraDirty`).
   * @param tilesStreaming Tiles are still fetching / decoding / building.
   */
  private updateDynamicResolution(now: number, cameraMoved: boolean, tilesStreaming: boolean): void {
    if (!this.dynamicResolutionEnabled) return;
    if (cameraMoved || tilesStreaming) this.lastInteractionMs = now;
    const active = (now - this.lastInteractionMs) < HereBeDragonsImpl.DYNAMIC_RES_SETTLE_MS;
    if (active === this.renderingLowRes) return;
    // Back to the full ratio: capture the moving frame BEFORE the targets are reallocated at the
    // new size, and dissolve into the sharp picture rather than pop (see beginSettleFade).
    if (!active && Math.abs(this.effectivePixelRatio - this.appliedPixelRatio) > 1e-6) {
      this.beginSettleFade(now);
    }
    // Into motion: the resize below destroys the last frame, which reprojection needs to show the
    // first ticks of the gesture while the swap hold waits — keep a copy (see captureHeldFrame).
    if (active && this.reprojection && this.splats.hasTiles()
      && Math.abs(this.effectivePixelRatio - this.appliedPixelRatio) < 1e-6
      && Math.abs(this.effectivePixelRatio - HereBeDragonsImpl.MOTION_PIXEL_RATIO_CAP) > 1e-6) {
      this.composer.captureHeldFrame();
    }
    this.renderingLowRes = active;
    const changed = this.syncPixelRatio();
    // Settling back to full res: the scene is otherwise idle, so force the one
    // crisp frame that replaces the low-res image left on screen. Only when the
    // ratio actually moved (a no-op on 1× displays, where rest === motion).
    if (!active && changed) this.needsRender = true;
  }

  /**
   * Install a self-rearming `matchMedia` listener on `(resolution: <dpr>dppx)`
   * so we get notified the instant the window moves to a different-DPI
   * monitor. The query string changes when DPR changes, so the listener has
   * to re-register against the new DPR each time it fires — otherwise it
   * would only catch the FIRST transition.
   */
  private installDprWatcher(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let current: MediaQueryList | null = null;
    const onChange = (): void => {
      this.updateDevicePixelRatio();
      register();
    };
    const register = (): void => {
      current?.removeEventListener('change', onChange);
      const dpr = window.devicePixelRatio;
      current = window.matchMedia(`(resolution: ${dpr}dppx)`);
      current.addEventListener('change', onChange);
    };
    register();
    this.dprWatcherCleanup = (): void => {
      current?.removeEventListener('change', onChange);
      current = null;
    };
  }

  private applyMergedPalette(theme: ThemeColors): void {
    this.scene.materials.setColors(themeToPaletteOverrides(theme));
    // Trees track the theme: canopy from the park colour (darkened a touch so
    // they read deeper than the flat park/grass fill), trunk from the building
    // colour darkened — so a greyscale theme gives a dark-grey trunk, an earthy
    // theme a brown one, rather than a fixed wood brown that clashes.
    this.treesLayer.setColors(darken(theme.park, 0.12), darken(theme.building, 0.5));
    // Grass base/tip derived from the park colour, both shifted darker for a
    // deeper, less acid green: a very dark base and a tip just under the park
    // tone (rather than lightened above it).
    this.grassLayer.setColors(darken(theme.park, 0.45), darken(theme.park, 0.1));
    // Shore waves: shallow water from a lightened water colour, wet sand from
    // the theme's beach colour, foam a warm near-white.
    this.wavesLayer.setColors(
      lighten(theme.water, 0.4),
      theme.beach ?? '#e8d8b0',
      lighten(theme.beach ?? '#fbf6ec', 0.55)
    );
    // Refresh the building / floor highlight overlay colors. Themes that
    // omit `highlight` reset to the cyan/orange defaults so a previous
    // theme's choices don't leak.
    this.buildingsManager.setHighlightColors(
      theme.highlight?.building ?? '#00d4ff',
      theme.highlight?.floor ?? '#f97316'
    );
    const skyHex = themeSky(theme);
    const sky = new THREE.Color(skyHex);
    this.scene.three.background = sky;
    const fog = this.scene.three.fog;
    if (fog && 'color' in fog) {
      (fog.color as THREE.Color).set(sky);
      if ('density' in fog) {
        this.composer.setFog(sky, (fog as THREE.FogExp2).density);
      }
    }
    this.renderer.three.setClearColor(sky, 1);

    // Push outline / saturation overrides if the theme specifies them; restore
    // the default tone otherwise so switching out of a comic theme actually
    // returns to the standard sketch look.
    const outline = this.composer.outlinePass;
    outline.settings.outlineStrength = theme.outline?.strength ?? 1.0;
    outline.settings.outlineDarkness = theme.outline?.darkness ?? 0.6;
    outline.settings.halftone = theme.outline?.halftone ?? 0;
    outline.settings.halftoneScale = theme.outline?.halftoneScale ?? 8;
    outline.settings.hatching = theme.outline?.hatching ?? 0;
    outline.settings.hatchingScale = theme.outline?.hatchingScale ?? 14;
    outline.settings.saturation = theme.saturation ?? 1.5;
    if (this.splatsNeutralGrade) {
      // A theme switch while the overlay is up: remember the new look, stay
      // where the grade is.
      this.savedGrade = { saturation: outline.settings.saturation, shine: outline.settings.shine };
      this.applySplatsGrade(this.splatsGradeT);
    }
    outline.applySettings();

    // Atmosphere: a theme can own its sky + light. Apply its cloud/light
    // presets (or reset to neutral defaults with null) so switching themes
    // can't leak one theme's towering gold cumulus or golden-hour key light
    // into the next. The cloud *look* updates even while the pass is toggled
    // off, so enabling clouds later shows the right style immediately.
    this.composer.applyCloudPreset(theme.clouds ?? null);
    this.scene.applyLightPreset(theme.light ?? null);
    // Painterly building treatment (warm walls + glowing windows + terracotta
    // roofs). Null resets to plain toon buildings for themes that don't ask
    // for it, so the look never leaks across a theme swap.
    this.scene.materials.setPainterly(theme.buildingStyle ?? null);
    // Watercolor wash on flat surfaces (ground/water/landuse/beach), the paper
    // grain that unifies it, cobblestone/dirt roads, and drifting pollen — all
    // theme-seeded here but individually runtime-tunable via their setters. We
    // track the live values so the getters + studio resync stay accurate.
    this.surfacePainterlyValue = theme.surfacePainterly ?? 0;
    this.paperGrainValue = theme.surfacePainterly ?? 0;
    this.roadTextureValue = theme.roadTexture ?? 0;
    this.sporesEnabledValue = theme.spores === true;
    this.scene.materials.setPainterlySurface(this.surfacePainterlyValue);
    this.composer.setPaperGrain(this.paperGrainValue * (1 - this.splatsGradeAmount()));
    this.scene.materials.setRoadTexture(this.roadTextureValue);
    this.sporesField.setEnabled(this.sporesEnabledValue);
    // Peaked roofs are a building-geometry choice baked in the tile worker, so
    // a change re-decodes the visible tiles. Only themes that opt in (Ghibli)
    // turn it on; everything else gets flat-capped buildings.
    this.pitchedRoofsEnabledValue = theme.pitchedRoofs === true;
    this.tileManager.setPitchedRoofs(this.pitchedRoofsEnabledValue);

    // On the 'mobile' tier, the theme may have just re-seeded the painterly
    // wash / spores / road texturing that the tier suppresses. Re-assert the
    // suppression so a runtime `applyTheme()` on a phone can't quietly bring
    // the ambient FX (and their per-frame GPU cost) back. No-op on other tiers.
    if (this.qualityTier === 'mobile') {
      this.suppressAmbientFX();
    }

    // Theme/colour/sky/fog/outline/atmosphere all just changed — repaint.
    this.needsRender = true;
  }

  addTag(options: TagOptions): TagHandle {
    const handle = this.tagsManager.addTag(options);
    // The tag's DOM element exists now but isn't positioned until the next
    // tagsManager.update(), which is gated behind a render frame.
    this.needsRender = true;
    return handle;
  }

  removeTag(id: string): void {
    this.tagsManager.removeTag(id);
    this.needsRender = true;
  }

  clearTags(): void {
    this.tagsManager.clearTags();
    this.needsRender = true;
  }

  getTag(id: string): TagHandle | undefined {
    return this.tagsManager.getTag(id);
  }

  addPolygon(options: PolygonOptions): PolygonHandle {
    const handle = this.polygonsManager.addPolygon(options);
    this.needsRender = true;
    return handle;
  }

  removePolygon(id: string): void {
    this.polygonsManager.removePolygon(id);
    this.needsRender = true;
  }

  clearPolygons(): void {
    this.polygonsManager.clearPolygons();
    this.needsRender = true;
  }

  getPolygon(id: string): PolygonHandle | undefined {
    return this.polygonsManager.getPolygon(id);
  }

  /** Merge a building popup configuration patch at runtime. */
  setBuildingPopup(config: BuildingPopupConfig): void {
    this.buildingsManager.setPopupConfig(config);
    this.needsRender = true;
  }

  isBuildingPopupEnabled(): boolean {
    return this.buildingsManager.isPopupEnabled();
  }

  /**
   * Programmatically highlight a building (and an optional floor) — same
   * effect as clicking it. Returns the resolved BuildingInfo, or null if
   * the building isn't loaded in any currently visible tile.
   */
  selectBuilding(id: string, floor?: number): BuildingInfo | null {
    const info = this.buildingsManager.selectBuilding(id, floor);
    this.needsRender = true;
    return info;
  }

  /** Clear any active building highlight + popup. */
  clearBuildingSelection(): void {
    this.buildingsManager.clearSelection();
    this.needsRender = true;
  }

  /**
   * Subscribe to building click events. Returns an unsubscribe function.
   * Fires after the popup has been rendered (or skipped if `render` returned null).
   */
  onBuildingClick(cb: (info: BuildingInfo) => void): Unsubscribe {
    return this.buildingsManager.on('buildingclick', cb);
  }

  /**
   * Subscribe to parcel click events. Fires with the clicked parcel feature's
   * MVT properties (notably `parcel_id`) plus the ground point's lat/lon.
   * No-op (returns a no-op unsubscribe) when no `parcels` overlay is
   * configured. Returns an unsubscribe function.
   */
  onParcelClick(cb: (parcel: ParcelClickEvent) => void): Unsubscribe {
    if (!this.parcelsManager) return () => {};
    return this.parcelsManager.onParcelClick(cb);
  }

  /** Toggle the parcels overlay on/off. No-op when none is configured. */
  setParcelsEnabled(on: boolean): void {
    if (!this.parcelsManager) return;
    this.parcelsManager.setEnabled(on);
    this.needsRender = true;
  }

  /** Whether the parcels overlay is currently enabled (false if unconfigured). */
  getParcelsEnabled(): boolean {
    return this.parcelsManager?.isEnabled() ?? false;
  }

  /**
   * Toggle the Gaussian-splat overlay on/off. No-op when none is configured.
   * On the 'mobile' / 'low' tiers the overlay runs under the smaller
   * `lowTierMaxSplats` budget (with `0` it is forced off there — the choice
   * is remembered and applies once back on 'high').
   * `{ reveal: 'ripple' }` animates the transition (see `SplatsRevealOptions`).
   */
  /**
   * Hold the post chain at a neutral grade while the splats overlay is showing: saturation
   * 1.0 in both the outline pass and the final pass (themes default to a 1.5x vibrance
   * boost, which turns captured imagery neon), no shine highlight, no paper grain. The
   * theme's own values are saved and restored when the overlay lets go.
   *
   * The grade is a full-screen post-process — it cannot follow the satellite's outline. So
   * it is EASED (400 ms, smoothstep) rather than snapped, and what it follows depends on
   * `hideBasemap`: with `true` (the basemap is gone wherever a tile shows) it is on while
   * tiles are resident; with `'covered'` (the vector map still fills the rest of the view)
   * it is on while the VIEW CENTRE is over landed satellite — what the camera is looking at
   * decides the look, and panning off the patch hands the theme its colours back.
   */
  private updateSplatsGrade(dtMs: number): void {
    let want = 0;
    if (this.splats.neutralGrade) {
      if (this.splats.isHidingBasemap()) want = 1;
      else if (this.splats.isCovering()) {
        const t = this.camera.controls.target;
        // Hysteresis on the rim so a camera parked on it doesn't pump the look.
        want = this.coverage.cutoutAt(t.x, t.z) >= (this.splatsGradeT > 0.5 ? 0.25 : 0.75) ? 1 : 0;
      }
    }
    if (want === this.splatsGradeT) return;
    if (this.reducedMotion) {
      this.applySplatsGrade(want); // reduced motion: straight to the end state
      return;
    }
    const step = Math.min(dtMs, 50) / HereBeDragonsImpl.SPLATS_GRADE_EASE_MS;
    const t = want > this.splatsGradeT
      ? Math.min(1, this.splatsGradeT + step)
      : Math.max(0, this.splatsGradeT - step);
    this.applySplatsGrade(t);
  }

  private static readonly SPLATS_GRADE_EASE_MS = 400;
  /** The camera counts as moving (for the splats governor) this long after
   *  its last change — covers the damping glide between input events. */
  private static readonly SPLATS_MOTION_WINDOW_MS = 250;
  /** Ambient layers (always-dirty wind / foam animations) throttled while
   *  splat tiles share the frame. */
  private static readonly AMBIENT_LAYERS: readonly LayerName[] = ['trees', 'grass', 'waves'];
  /** Fastest the ambient layers tick while splats are resident (15 fps)… */
  private static readonly AMBIENT_MIN_INTERVAL_MS = 1000 / 15;
  /** …the share of GPU time they may claim (interval ≥ frame cost / share)… */
  private static readonly AMBIENT_GPU_SHARE = 0.25;
  /** …and past this interval a stutter looks worse than a still tree: freeze. */
  private static readonly AMBIENT_FREEZE_INTERVAL_MS = 150;
  /** How often a frozen ambient layer still runs its zoom gate (`dt = 0`). */
  private static readonly AMBIENT_FROZEN_TICK_MS = 1000;
  /** Ambient throttle interval in force (0 = none), to skip no-op writes. */
  private ambientIntervalMs = 0;

  /**
   * Idle cost. Trees, grass and shoreline foam animate continuously, so while
   * they are on screen the map renders EVERY frame — and with splat tiles
   * resident every render re-rasterises every splat (the whole frame's cost
   * on an integrated GPU). With the basemap no longer hidden globally
   * (`hideBasemap: 'covered'` / `false`) that would turn an idle map into a
   * permanently saturated GPU for the sake of some swaying leaves. So while
   * splats are resident the ambient layers tick at 15 fps at most, never
   * claim more than a quarter of the GPU (interval ≥ 4 × the measured frame
   * cost), and freeze outright once that interval would pass 150 ms — a
   * still tree beats a stuttering one. Camera moves and tile landings render
   * at full rate as always; the limit lifts when the last splat tile leaves.
   */
  private updateAmbientThrottle(): void {
    let interval = 0;
    if (this.splats.hasTiles() && !this.splats.isHidingBasemap()) {
      const cost = Math.max(this.splats.governorFrameMs, this.smoothedFrameMs);
      interval = Math.max(
        HereBeDragonsImpl.AMBIENT_MIN_INTERVAL_MS,
        cost / HereBeDragonsImpl.AMBIENT_GPU_SHARE
      );
      // Quantise so a drifting frame time doesn't rewrite the throttle per frame.
      interval = Math.round(interval / 16) * 16;
      if (interval > HereBeDragonsImpl.AMBIENT_FREEZE_INTERVAL_MS) interval = Infinity;
      // Lean map: frozen outright — a swaying tree is not worth re-rasterising
      // every resident splat.
      if (this.leanMapActive) interval = Infinity;
    }
    if (interval === this.ambientIntervalMs) return;
    this.ambientIntervalMs = interval;
    for (const name of HereBeDragonsImpl.AMBIENT_LAYERS) {
      if (interval === 0) this.layers.setThrottle(name, null);
      else if (interval === Infinity) {
        this.layers.setThrottle(name, HereBeDragonsImpl.AMBIENT_FROZEN_TICK_MS, false);
      } else this.layers.setThrottle(name, interval, true);
    }
  }

  /**
   * Lean map while the splats overlay is on (`splats.leanMap`, default on).
   * Every resident splat is re-rasterised on every rendered frame, so while
   * they show the GPU goes to nothing else: the outline pipeline (a second
   * full-scene render + Sobel), the cloud raymarch and the tilt-shift blur
   * are off, the ambient animations are frozen (updateAmbientThrottle) and
   * dynamic resolution renders the moving picture at 1×. All of it comes
   * back when the overlay goes off. Runs every frame; a no-op unless the
   * overlay's active state flipped.
   */
  private syncLeanMap(): void {
    const want = this.splats.isEnabled() && this.getSplatsOptions().leanMap;
    if (want === this.leanMapActive) return;
    this.leanMapActive = want;
    if (want) {
      this.leanSaved = {
        clouds: this.cloudsEnabled,
        dynamicResolution: this.dynamicResolutionEnabled
      };
      this.cloudsEnabled = false;
      this.composer.setCloudsEnabled(false);
      this.composer.setOutlineEnabled(false);
      this.setDynamicResolution(true);
    } else {
      const saved = this.leanSaved;
      this.leanSaved = null;
      this.composer.setOutlineEnabled(resolveQualityProfile(this.qualityTier).outlines);
      if (saved) {
        this.cloudsEnabled = saved.clouds;
        this.composer.setCloudsEnabled(saved.clouds);
        this.setDynamicResolution(saved.dynamicResolution);
      }
    }
    // The neutral grade's base saturation depends on whether outlines run.
    if (this.splatsNeutralGrade) this.applySplatsGrade(this.splatsGradeT);
    this.needsRender = true;
  }

  /**
   * GPU frame pacing, while splat tiles are resident. Splats make the frame GPU-bound, and a
   * render loop that submits a frame every rAF regardless queues frames in the GPU process
   * faster than they drain. Nothing on screen gets faster, but every synchronous GPU call —
   * Spark's per-sort depth readback above all (`getBufferSubData`, after its fence has already
   * signalled) — now waits behind the whole queue: measured 90–120 ms per sort, the pan
   * stutter. So a frame is only submitted once the GPU has finished the one before it (a
   * fence polled with `getSyncParameter`, which never blocks). The frame rate is what the GPU
   * can do either way; what changes is that the queue stays shallow, so input latency and those
   * stalls stay short.
   *
   * ONE frame in flight (was two): with reprojection presenting on every held tick the frames
   * not drawn cost nothing visible, and the sort's readback — which waits for every frame queued
   * ahead of it — halves. Measured interleaved on an Intel Iris: presented p95 32–39 → 20–21 ms,
   * interval sd 10–11 → 7, readback stall 7–9 → 4 ms mean; a gesture starting mid-landing
   * 86 → 50–67 ms worst frame.
   */
  private gpuStillBusy(now: number): boolean {
    const fences = this.frameFences;
    if (fences.length === 0) return false;
    const gl = this.renderer.three.getContext() as WebGL2RenderingContext;
    if (gl.isContextLost()) {
      this.frameFences = [];
      return false;
    }
    // retire every finished frame (they finish in order)
    while (fences.length && gl.getSyncParameter(fences[0].sync, gl.SYNC_STATUS) === gl.SIGNALED) {
      gl.deleteSync(fences.shift()!.sync);
    }
    if (fences.length < HereBeDragonsImpl.FRAMES_IN_FLIGHT) return false;
    if (now - fences[0].at < HereBeDragonsImpl.PACING_MAX_HOLD_MS) return true;
    gl.deleteSync(fences.shift()!.sync);          // stuck fence: never hold the map hostage
    return false;
  }

  /** After a render: fence it if splats are resident (see gpuStillBusy). */
  private fenceFrame(now: number): void {
    const gl = this.renderer.three.getContext() as WebGL2RenderingContext;
    if (!this.framePacing || !this.splats.hasTiles() || gl.isContextLost()) {
      for (const f of this.frameFences) gl.deleteSync(f.sync);
      this.frameFences = [];
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync) this.frameFences.push({ sync, at: now });
  }

  /** Whether the lean map is in effect (splats on and `leanMap` not disabled). */
  getSplatsLeanMapActive(): boolean {
    return this.leanMapActive;
  }

  /**
   * Render-loop counters since the previous call (which resets them): how many
   * RAF ticks there were, how many of them rendered, and which dirty source
   * asked for each render. The map is render-on-demand, so on a still scene
   * `renders` should be near zero; when it is not, the non-zero reason names
   * the layer that keeps the GPU busy. `lowRes` counts renders drawn at the
   * dynamic-resolution motion ratio.
   */
  getRenderStats(): RenderStats {
    const out = this.renderStats;
    this.renderStats = emptyRenderStats();
    return out;
  }

  /** Eased neutral amount for the linear ease position (smoothstep). */
  private splatsGradeAmount(): number {
    const t = this.splatsGradeT;
    return t * t * (3 - 2 * t);
  }

  /** Put the post chain `t` of the way (linear time) from the theme's look to neutral. */
  private applySplatsGrade(t: number): void {
    this.splatsGradeT = t;
    const a = this.splatsGradeAmount();
    const outline = this.composer.outlinePass;
    if (t > 0 && !this.savedGrade) {
      this.savedGrade = { saturation: outline.settings.saturation, shine: outline.settings.shine };
    }
    this.splatsNeutralGrade = t > 0;
    const theme = this.savedGrade;
    if (theme) {
      outline.settings.saturation = theme.saturation + (1.0 - theme.saturation) * a;
      outline.settings.shine = theme.shine * (1 - a);
      outline.applySettings();
      if (t === 0) this.savedGrade = null;
    }
    const base = this.composer.outlinesEnabled ? 1.0 : 1.5;
    this.composer.setSaturation(base + (1.0 - base) * a);
    this.composer.setPaperGrain(this.paperGrainValue * (1 - a));
    this.needsRender = true;
  }

  /**
   * Build a `SplatsLayer` wired to this map (the controller calls this at
   * construction and again whenever `setSplatsOptions` needs a rebuild).
   */
  /** The one Spark import, shared by the early kick above and the layer (`loadSpark`). */
  private static sparkPromise: Promise<unknown> | null = null;
  private static sparkImport(): Promise<unknown> {
    return (HereBeDragonsImpl.sparkPromise ??= import('@sparkjsdev/spark'));
  }

  private createSplatsLayer(config: SplatsConfig): SplatsLayer {
    return new SplatsLayer(
      {
        renderer: this.renderer.three,
        // the import kicked at construction (sparkImport), so a tile source never waits for it
        loadSpark: () => HereBeDragonsImpl.sparkImport() as Promise<SparkModule>,
        scene: this.scene.three,
        camera: this.camera,
        projection: this.projection,
        // A tile landing (or Spark finishing an async sort) changes the
        // scene without a camera move — nudge render-on-demand.
        onSceneChange: () => { this.needsRender = true; },
        // `hideBasemap: 'covered'` (the default): the overlay reports its
        // rounded union to the tile-reveal coverage field, whose second
        // channel cuts every basemap material out under the landed tiles —
        // nothing is hidden or suspended globally.
        cutout: this.coverage,
        // One source of truth for the whole map (see core/motion.ts).
        prefersReducedMotion: () => this.reducedMotion,
        getMetersPerPixel: () => this.getMetersPerPixel(),
        getCamera: () => this.camera.three,
        renderHeightPx: () => this.composer.internalHeight(),
        getAspect: () => this.renderer.width / Math.max(1, this.renderer.height),
        // `hideBasemap: true`: mask the vector basemap layers out of the drawn
        // scene while splat tiles (and their imagery ground) are showing.
        // A per-layer visibility mask in the TileManager — nothing is
        // rebuilt, decode carries on, and the caller's own
        // `setLayerEnabled` choices are untouched underneath.
        setBasemapHidden: (hidden) => {
          for (const name of SPLATS_HIDDEN_BASEMAP_LAYERS) {
            this.tileManager.setLayerHidden(name, hidden);
            // …and stop ticking them: an invisible grass-wind / foam
            // animation reporting "dirty" every frame would pin the render
            // loop and re-rasterise every resident splat for nothing.
            this.layers.setSuspended(name, hidden);
          }
          // (The neutral grade follows from the RAF loop — `updateSplatsGrade`.)
          this.needsRender = true;
        }
      },
      config
    );
  }

  setSplatsEnabled(on: boolean, opts?: SplatsRevealOptions): void {
    this.splats.setEnabled(on, opts);
    this.needsRender = true;
  }

  /** Whether the splats overlay is currently in effect (false if unconfigured
   *  or suppressed by the quality tier). */
  getSplatsEnabled(): boolean {
    return this.splats.isEnabled();
  }

  /** Resident splat-tile count + total splat count (zeros if unconfigured). */
  getSplatsStats(): SplatsStats {
    return this.splats.getStats();
  }

  /**
   * Change splat-overlay options at runtime. Cheap ones are applied to the
   * running layer (the tile-pyramid bounds, `lodBias` and `maxCameraZoom`
   * included); `urlTemplate` / `imageryTemplate` / rounded union on-off
   * rebuild it, and a first `urlTemplate` on a map constructed
   * without `splats` CREATES it (importing Spark on the spot). A key present
   * with the value `undefined` resets that option to its default.
   */
  setSplatsOptions(patch: Partial<SplatsConfig>): void {
    this.splats.setOptions(patch);
    this.needsRender = true;
  }

  /** The splat-overlay options in effect, defaults filled in
   *  (`urlTemplate: ''` when no overlay is configured). */
  getSplatsOptions(): ResolvedSplatsOptions {
    return this.splats.getOptions();
  }

  /** Snapshot of every building currently loaded across visible tiles. */
  getLoadedBuildings(): BuildingInfo[] {
    const out: BuildingInfo[] = [];
    this.buildingsManager.forEachBuilding((info) => out.push(info));
    return out;
  }

  /** Convert scene-world meters (x, z) back to geographic (lat, lon). */
  unproject(x: number, z: number): { lat: number; lon: number } {
    // Scene Z is `-mercatorY`, so flip back when handing off to Projection.
    const ll = this.projection.unproject(x, -z);
    return { lat: ll.lat, lon: ll.lon };
  }

  setCompassVisible(on: boolean): void {
    this.compass.setVisible(on);
  }

  isCompassVisible(): boolean {
    return !this.compass.element.hidden;
  }

  setScaleBarVisible(on: boolean): void {
    this.scaleBar?.setVisible(on);
  }

  isScaleBarVisible(): boolean {
    return this.scaleBar !== null && !this.scaleBar.element.hidden;
  }

  setScaleBarUnits(units: ScaleBarUnits): void {
    this.scaleBar?.setUnits(units);
  }

  getScaleBarUnits(): ScaleBarUnits | null {
    return this.scaleBar?.getUnits() ?? null;
  }

  /** Restrict (or release) camera panning to a geographic box. */
  setBounds(bounds: import('./types.js').BoundingBox | null): void {
    this.camera.setBounds(bounds);
  }

  /** Clamp (or release) the allowed camera tilt. See HereBeDragons.setTiltRange. */
  setTiltRange(range: { min: number; max: number } | null): void {
    this.camera.setTiltRange(range);
  }

  /** Clamp (or release) the allowed camera bearing. See HereBeDragons.setBearingRange. */
  setBearingRange(range: { min: number; max: number } | null): void {
    this.camera.setBearingRange(range);
  }

  /** Clamp (or release) the allowed camera zoom. See HereBeDragons.setZoomRange. */
  setZoomRange(range: { min: number; max: number } | null): void {
    this.camera.setZoomRange(range);
  }

  /**
   * Override the building selection highlight colors at runtime. The active
   * theme's highlight colors (if any) re-assert themselves on the next
   * applyTheme() — call this AFTER applyTheme to keep a custom choice.
   */
  setBuildingHighlightColors(buildingColor: string, floorColor: string): void {
    this.buildingsManager.setHighlightColors(buildingColor, floorColor);
    this.needsRender = true;
  }

  getBuildingHighlightColor(): string {
    return this.buildingsManager.getBuildingHighlightColor();
  }

  getFloorHighlightColor(): string {
    return this.buildingsManager.getFloorHighlightColor();
  }

  /** Painterly watercolor-wash strength on flat surfaces (ground/water/landuse/
   *  beach). 0 = flat toon fills, ~0.9 = the Ghibli hand-painted look. */
  setSurfacePainterly(strength: number): void {
    this.surfacePainterlyValue = Math.max(0, Math.min(1, strength));
    this.scene.materials.setPainterlySurface(this.surfacePainterlyValue);
    this.needsRender = true;
  }

  getSurfacePainterly(): number {
    return this.surfacePainterlyValue;
  }

  /** Screen-space paper-grain strength in the final pass (0..1). 0 = off. */
  setPaperGrain(strength: number): void {
    this.paperGrainValue = Math.max(0, Math.min(1, strength));
    this.composer.setPaperGrain(this.paperGrainValue * (1 - this.splatsGradeAmount()));
    this.needsRender = true;
  }

  getPaperGrain(): number {
    return this.paperGrainValue;
  }

  /** Procedural road surfacing strength (0..1): cobblestone setts on roads,
   *  mottled earth on paths. 0 = plain ribbons. */
  setRoadTexture(strength: number): void {
    this.roadTextureValue = Math.max(0, Math.min(1, strength));
    this.scene.materials.setRoadTexture(this.roadTextureValue);
    this.needsRender = true;
  }

  getRoadTexture(): number {
    return this.roadTextureValue;
  }

  /** Toggle the drifting spore/pollen motes (atmospheric). */
  setSporesEnabled(on: boolean): void {
    this.sporesEnabledValue = on;
    this.sporesField.setEnabled(on);
    this.needsRender = true;
  }

  getSporesEnabled(): boolean {
    return this.sporesEnabledValue;
  }

  /** Toggle peaked (tented) roofs on low/mid-rise buildings. Re-decodes the
   *  visible tiles, since the roof shape is baked into the mesh in the worker. */
  setPitchedRoofsEnabled(on: boolean): void {
    this.pitchedRoofsEnabledValue = on;
    this.tileManager.setPitchedRoofs(on);
    this.needsRender = true;
  }

  getPitchedRoofsEnabled(): boolean {
    return this.pitchedRoofsEnabledValue;
  }

  /** Global wind-sway multiplier for the grass + tree billboards. 1 = default,
   *  0 = still, >1 = breezier. Persists across theme changes. */
  setWindStrength(multiplier: number): void {
    this.windStrengthValue = Math.max(0, Math.min(3, multiplier));
    this.grassLayer.setWindStrength(this.windStrengthValue);
    this.treesLayer.setWindStrength(this.windStrengthValue);
    this.needsRender = true;
  }

  getWindStrength(): number {
    return this.windStrengthValue;
  }

  /** Shop-sign banner density 0..1 — thins the over-emitted candidate set
   *  (0 = none, 1 = all). Only matters when the `signs` layer is enabled. */
  setSignsDensity(density: number): void {
    this.signsLayer.setDensity(density);
    this.needsRender = true;
  }

  getSignsDensity(): number {
    return this.signsLayer.getDensity();
  }

  /** Camera zoom at/above which shop-sign banners appear (default 15). */
  setSignsMinZoom(zoom: number): void {
    this.signsLayer.setMinZoom(zoom);
    this.needsRender = true;
  }

  getSignsMinZoom(): number {
    return this.signsLayer.getMinZoom();
  }

  /** Set the illustrated outline/ink look + saturation (strength, darkness,
   *  halftone, hatching, saturation). Only the provided fields change. */
  setOutline(config: import('./types.js').OutlineConfig): void {
    this.composer.setOutlineLook(config);
    this.needsRender = true;
  }

  /** The resolved outline/ink look currently in effect. */
  getOutline(): Required<import('./types.js').OutlineConfig> {
    return this.composer.getOutlineLook();
  }

  /** Painterly storybook building treatment — warm plaster walls, glowing
   *  windows, terracotta/tiled roofs, per-building variety. Pass `null` to
   *  clear it (flat toon buildings). See {@link ThemeBuildingStyle}. */
  setBuildingStyle(style: import('./themes.js').ThemeBuildingStyle | null): void {
    this.scene.materials.setPainterly(style);
    this.needsRender = true;
  }

  /** The resolved painterly-building look currently in effect. */
  getBuildingStyle(): import('./themes.js').ThemeBuildingStyle {
    return this.scene.materials.getPainterly();
  }

  /** Set the volumetric-cloud look (coverage, density, altitude band, noise
   *  scale, wind speed, cloud + shadow colors). Pass `null` to restore the
   *  neutral default clouds. Independent of the on/off + opacity controls. */
  setCloudPreset(preset: import('./themes.js').CloudPreset | null): void {
    this.composer.applyCloudPreset(preset);
    this.needsRender = true;
  }

  /** The resolved cloud look currently in effect. */
  getCloudPreset(): import('./themes.js').CloudPreset {
    return this.composer.getCloudPreset();
  }

  /** Set the lighting look (sun color/intensity, fill, ambient, hemisphere
   *  sky/ground/intensity). Pass `null` to restore the neutral default rig. */
  setLightPreset(preset: import('./themes.js').LightPreset | null): void {
    this.scene.applyLightPreset(preset);
    this.needsRender = true;
  }

  /** The resolved lighting look currently in effect. */
  getLightPreset(): import('./themes.js').LightPreset {
    return this.scene.getLightPreset();
  }

  /** Tilt (deg) below which atmospheric fog is fully off. Default 30. */
  setFogTiltStart(deg: number): void {
    this.fogTiltStart = Math.max(0, Math.min(90, deg));
    this.needsRender = true;
  }

  getFogTiltStart(): number {
    return this.fogTiltStart;
  }

  /** Tilt (deg) at and above which fog is at full strength. Default 40.
   *  Should be ≥ `fogTiltStart`; if not, the ramp collapses to a hard step. */
  setFogTiltEnd(deg: number): void {
    this.fogTiltEnd = Math.max(0, Math.min(90, deg));
    this.needsRender = true;
  }

  getFogTiltEnd(): number {
    return this.fogTiltEnd;
  }

  /**
   * Multiplier on the scene's authored fog density. 1.0 = the value baked
   * into `SceneRoot` (≈ 99% opacity at 10 km), >1 thickens (closer horizon),
   * <1 thins (farther horizon). Combined with the tilt ramp so density per
   * frame is `baseDensity × strength × smoothstep(tilt)`.
   */
  setFogStrength(strength: number): void {
    this.fogStrength = Math.max(0, Math.min(10, strength));
    this.needsRender = true;
  }

  getFogStrength(): number {
    return this.fogStrength;
  }

  /**
   * Visual elevation (meters above ground) for place-name labels —
   * Region / City / Macrohood / Neighbourhood / Business. 0 (default) pins
   * labels to their geographic ground position. Raising it lifts the labels
   * upward on screen; useful for keeping city names readable above the
   * skyline at zoomed-in tilted views. Doesn't affect occlusion (which is
   * controlled by the separate depth-anchor uniform).
   */
  setLabelHeight(meters: number): void {
    this.labelsLayer.setPlaceLabelElevation(meters);
    this.needsRender = true;
  }

  getLabelHeight(): number {
    return this.labelsLayer.getPlaceLabelElevation();
  }

  /**
   * Duration (ms) of the "rise from below ground" animation on newly loaded
   * tiles. 0 disables the animation entirely (tiles snap in instantly).
   * Default 3000 ms. Useful values 0–3000 ms — beyond that the lag between
   * a tile arriving and being in its final position starts to feel like
   * a bug.
   */
  setTileSpawnDurationMs(ms: number): void {
    this.tileManager.setSpawnDurationMs(ms);
    this.needsRender = true;
  }

  getTileSpawnDurationMs(): number {
    return this.tileManager.getSpawnDurationMs();
  }

  /**
   * Turn the basemap tile reveal (rounded-union mask) on / off. The field
   * keeps tracking tiles while off, so switching on shows the settled union
   * of whatever is loaded; tiles that land afterwards grow in.
   */
  /**
   * Tilt-shift "miniature" look: a sharp band across the point the camera looks at, blur growing
   * above and below it, and a saturated model-photography grade. Eases in and out (~450 ms,
   * critically-damped feel); costs nothing while off. Only runs on the `'high'` quality tier —
   * on lower tiers the request is remembered and applies if the tier rises.
   */
  setTiltShift(on: boolean | Partial<TiltShiftSettings>): void {
    if (typeof on === 'object' && on !== null) {
      this.composer.tiltShift.settings = resolveTiltShift({ ...this.composer.tiltShift.settings, ...on });
      this.composer.tiltShift.applySettings();
      this.tiltShiftCustomized = true;
      // The overlay has the pass: its hand-back must carry this change too.
      if (this.miniatureSaved) this.miniatureSaved = resolveTiltShift({ ...this.miniatureSaved, ...on });
      this.tiltShiftTarget = 1;
    } else {
      this.tiltShiftTarget = on ? 1 : 0;
    }
    this.needsRender = true;
  }

  /** Whether the tilt-shift look is requested (it may be held off by the quality tier). */
  getTiltShift(): boolean {
    return this.tiltShiftTarget > 0;
  }

  getTiltShiftSettings(): TiltShiftSettings {
    return { ...this.composer.tiltShift.settings };
  }

  /**
   * The splat overlay's miniature look (`splats.miniature`): while satellite tiles are on screen
   * the overlay drives the tilt-shift — on, with the imagery preset unless `setTiltShift({ … })`
   * chose settings — and hands it back, previous settings restored, when the last tile goes. The
   * ease in and out is `tickTiltShift`'s. Runs every tick; a no-op unless the state flipped.
   */
  private syncMiniature(): void {
    const want = this.splats.miniature && this.splats.isEnabled() && this.splats.hasTiles();
    if (want === this.miniatureActive) return;
    this.miniatureActive = want;
    const ts = this.composer.tiltShift;
    if (want) {
      this.miniatureSaved = { ...ts.settings };
      if (!this.tiltShiftCustomized) {
        ts.settings = { ...MINIATURE_IMAGERY_TILT_SHIFT };
        ts.applySettings();
      }
    } else if (this.miniatureSaved) {
      ts.settings = this.miniatureSaved;
      ts.applySettings();
      this.miniatureSaved = null;
    }
    this.needsRender = true;
  }

  /** Ease the effect strength toward its target. Returns true while it is still moving. */
  private tickTiltShift(dt: number): boolean {
    // Lean map (splats on): the blur eases out and comes back when they go — unless the overlay's
    // own miniature look is what wants it (syncMiniature), which the lean map makes way for.
    const allowed = this.qualityTier === 'high' && (!this.leanMapActive || this.miniatureActive);
    const goal = allowed ? (this.miniatureActive ? 1 : this.tiltShiftTarget) : 0;
    const cur = this.tiltShiftStrength;
    if (Math.abs(goal - cur) < 1e-3) {
      if (cur !== goal) {
        this.tiltShiftStrength = goal;
        this.composer.tiltShift.setStrength(goal);
        return true;
      }
      return false;
    }
    if (this.reducedMotion) {
      this.tiltShiftStrength = goal; // reduced motion: no ramp, just the end state
      this.composer.tiltShift.setStrength(goal);
      return true;
    }
    // Exponential approach: starts fast, lands softly, and a reversal mid-way simply heads back
    // from wherever it is (frame-rate independent — see core/motion.ts).
    const k = approach(dt * 1000, tauFor(DURATION.base));
    this.tiltShiftStrength = cur + (goal - cur) * k;
    this.composer.tiltShift.setStrength(this.tiltShiftStrength);
    return true;
  }

  /** Keep the sharp band on the point the camera looks at. */
  private updateTiltShiftFocus(): void {
    if (this.tiltShiftStrength <= 0.001) return;
    this.tiltShiftNdc.copy(this.camera.controls.target).project(this.camera.three);
    this.composer.tiltShift.setFocusY(this.tiltShiftNdc.y * 0.5 + 0.5);
  }

  setTileReveal(reveal: boolean | TileRevealOptions): void {
    if (typeof reveal === 'boolean') {
      this.coverage.setEnabled(reveal);
    } else if (reveal && typeof reveal === 'object') {
      // Object form: tune `growMs` / `feather` / `rise` live (and switch the
      // reveal on, as the same value would at construction).
      this.coverage.setOptions(reveal);
      this.coverage.setEnabled(true);
    }
    this.needsRender = true;
  }

  /** The tile reveal's settings in effect (`enabled` + resolved params). */
  getTileRevealOptions(): ResolvedTileReveal {
    return { ...this.coverage.config };
  }

  getTileReveal(): boolean {
    return this.coverage.enabled;
  }

  setBuildingsFlat(flat: boolean): void {
    this.buildingsFlat = flat;
    this.scene.materials.setBuildingsFlat(flat);
    // Skip building meshes during the normal pass when flat so OutlinePass
    // doesn't draw a sketch ring around every flattened footprint.
    this.composer.setBuildingsInNormalPass(!flat);
    this.needsRender = true;
  }

  getBuildingsFlat(): boolean {
    return this.buildingsFlat;
  }

  on(event: HereBeDragonsEventName, cb: (e: HereBeDragonsEventPayload) => void): Unsubscribe {
    return this.bus.on(event, cb);
  }

  resize(): void {
    // Apply any pending DPR change BEFORE the renderer size update so the
    // new drawing-buffer dimensions go through `setPixelRatio + setSize` in
    // one consistent step. A pure CSS-size resize (no DPR change) early-outs
    // inside updateDevicePixelRatio and the rest of this method still runs.
    this.updateDevicePixelRatio();
    this.renderer.resize();
    this.camera.resize(this.renderer.width, this.renderer.height);
    this.composer.resize(this.renderer.width, this.renderer.height);
    this.needsRender = true;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafHandle);
    this.resizeObserver?.disconnect();
    this.dprWatcherCleanup?.();
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    if (this.onPointerMove) this.renderer.dom.removeEventListener('pointermove', this.onPointerMove);
    if (this.onPointerLeave) this.renderer.dom.removeEventListener('pointerleave', this.onPointerLeave);
    if (this.onDblClick) this.renderer.dom.removeEventListener('dblclick', this.onDblClick);
    this.tagsManager.dispose();
    this.polygonsManager.dispose();
    this.buildingsManager.dispose();
    this.parcelsManager?.dispose();
    this.splats.dispose();
    this.bridgesManager.dispose();
    this.sporesField.dispose();
    this.compass.destroy();
    this.scaleBar?.destroy();
    this.tileManager.dispose();
    this.coverage.dispose();
    this.baseTileManager?.dispose();
    this.workerPool.dispose();
    this.layers.dispose();
    this.composer.dispose();
    this.camera.dispose();
    this.scene.dispose();
    this.renderer.dispose();
    this.bus.clear();
    logger.info('destroyed');
  }
}

/**
 * One-call entry point. The constructor applies the declarative "look" fields
 * (`theme`, `customColors`, `clouds`, `compass`) BEFORE the render loop
 * starts, so an exported Studio JSON drops straight in and the very first
 * frame paints with the requested theme — no color flash, no imperative
 * setup. The async resolution fires after the first tile request has been
 * queued; listen for `map.on('ready', ...)` if you need to wait for tiles.
 */
export async function createHereBeDragons(
  container: HTMLElement,
  options: HereBeDragonsOptions
): Promise<HereBeDragons> {
  // Check what the caller passed BEFORE anything touches it. These three mistakes otherwise
  // surface far from their cause — a missing `center` as "Cannot read properties of undefined
  // (reading 'lat')" from inside the camera, and a missing `pmtiles_url` as a network error about
  // the string "undefined". Both send people looking in the wrong place on their first run.
  if (!container || typeof (container as HTMLElement).appendChild !== 'function') {
    throw new Error(
      `createHereBeDragons(container, options): the first argument must be an element, got ${
        container === null ? 'null' : typeof container
      }. A common cause is document.getElementById('…') not matching any element.`
    );
  }
  if (!options || typeof options !== 'object') {
    throw new Error('createHereBeDragons(container, options): the second argument must be an options object.');
  }
  if (!options.pmtiles_url) {
    throw new Error(
      'createHereBeDragons: `pmtiles_url` is required — it must point at a .pmtiles archive the browser can read over HTTP range requests.'
    );
  }
  const c = options.center as { lat?: unknown; lon?: unknown } | undefined;
  if (!c || typeof c.lat !== 'number' || typeof c.lon !== 'number') {
    throw new Error(
      'createHereBeDragons: `center` is required and must be `{ lat: number, lon: number }`' +
        (c ? ` — got ${JSON.stringify(options.center)}.` : '.')
    );
  }
  const map = new HereBeDragonsImpl(container, options);
  await map.init();
  return map;
}
