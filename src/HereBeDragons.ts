import type {
  HereBeDragons,
  HereBeDragonsOptions,
  CameraView,
  FlyToOptions,
  LayerName,
  HereBeDragonsEventName,
  HereBeDragonsEventPayload,
  NoiseSource,
  Unsubscribe
} from './types.js';
import { EventBus } from './core/EventBus.js';
import { Projection } from './core/Projection.js';
import { Renderer } from './rendering/Renderer.js';
import { SceneRoot } from './scene/SceneRoot.js';
import { MapCameraController } from './controls/MapCameraController.js';
import { Composer } from './rendering/Composer.js';
import { resolveQualityProfile } from './rendering/quality.js';
import { PMTilesSource } from './tiles/PMTilesSource.js';
import { TileWorkerPool } from './tiles/TileWorkerPool.js';
import { TileManager } from './tiles/TileManager.js';
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
import { Palette } from './materials/Palette.js';
import { THEMES, themeToPaletteOverrides, themeSky, type ThemeColors } from './themes.js';
import { TagsManager } from './tags/TagsManager.js';
import type { TagOptions, TagHandle } from './tags/types.js';
import { PolygonsManager } from './polygons/PolygonsManager.js';
import type { PolygonOptions, PolygonHandle } from './polygons/types.js';
import { BuildingsManager } from './buildings/BuildingsManager.js';
import type {
  BuildingInfo,
  BuildingPopupConfig
} from './buildings/types.js';
import { Compass } from './studio/Compass.js';
import * as THREE from 'three';
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
  /** Optional low-res underlay (only constructed if `options.lowResUnderlay`). */
  private readonly baseTileManager: BaseTileManager | null;
  /** Direct handle to the labels layer for setting place-label elevation. */
  private readonly labelsLayer: LabelsLayer;
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
  private compass: Compass;
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
  /** Most-recently-applied theme name (via applyTheme). Empty if never set. */
  private currentTheme = '';
  /** Active custom color overrides layered on top of the current theme. */
  private customColors: Partial<ThemeColors> = {};
  /** Current cloud opacity (0..1). Tracked so the studio can read it back. */
  private cloudsOpacity = 1;
  /** Whether the cloud pass is currently enabled. */
  private cloudsEnabled = true;
  /** Whether the dB heat-map overlay pass is currently enabled. */
  private noiseEnabled = false;
  /**
   * Smoothed frame time (ms) above which the tile manager throttles mesh
   * building so the camera stays smooth. Default ~22 ms (≈ 45 FPS floor).
   */
  private readonly frameBudgetMs: number;
  /** Resolved render-quality tier — exposed via `getQualityTier()` so apps
   *  (and the demo HUD) can see whether auto-detect picked 'low' or 'high'.
   *  Mutable: `setQualityTier()` flips it at runtime. */
  private qualityTier: 'low' | 'high';
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
  /** Unregister hook for the `matchMedia` DPR-change listener. */
  private dprWatcherCleanup?: () => void;
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
    const initialQualityOption: 'low' | 'high' = isAuto
      ? 'high'
      : (options.quality as 'low' | 'high');
    const quality = resolveQualityProfile(initialQualityOption);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    const effectivePixelRatio = options.pixelRatio ?? Math.min(dpr, quality.pixelRatioCap);
    this.qualityTier = quality.level;
    this.effectivePixelRatio = effectivePixelRatio;
    this.pixelRatioCap = quality.pixelRatioCap;
    this.pixelRatioExplicit = options.pixelRatio;
    this.renderer = new Renderer(container, {
      pixelRatio: effectivePixelRatio,
      background: options.background
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
    if (options.bounds) this.camera.setBounds(options.bounds);
    // Save the developer's chosen tilt range BEFORE any tier-imposed cap so
    // setQualityTier can restore it when switching back from `'low'` to
    // `'high'`. (`'low'` clamps tilt to 0 to enforce the top-down view.)
    this.originalTiltRange = options.tiltRange ?? null;
    if (options.tiltRange) this.camera.setTiltRange(options.tiltRange);
    if (options.bearingRange) this.camera.setBearingRange(options.bearingRange);
    if (options.zoomRange) this.camera.setZoomRange(options.zoomRange);
    // MSAA sample count comes from the quality profile — 4 on desktop, 0 on
    // the 'low' tier (FXAA-only AA) so integrated GPUs skip the per-pixel
    // multisample cost.
    this.composer = new Composer(
      this.renderer,
      this.scene.three,
      this.camera.three,
      quality.msaaSamples
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
    this.composer.setSaturation(quality.outlines ? 1.0 : 1.5);

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
    this.tileManager = new TileManager({
      source: this.source,
      workerPool: this.workerPool,
      projection: this.projection,
      scene: this.scene,
      layers: this.layers,
      camera: this.camera,
      tileWindowRadius: options.performance?.tileWindowRadius ?? qtile?.tileWindowRadius,
      tileWindowRadiusFar: options.performance?.tileWindowRadiusFar ?? qtile?.tileWindowRadiusFar,
      visibleRadius: options.performance?.visibleRadius ?? qtile?.visibleRadius,
      maxTileBuildsPerFrame: options.performance?.maxTileBuildsPerFrame,
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
    // blank canvas. Cost is minimal (4-9 z11 tiles loaded, base layers only,
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

    this.camera.onChange = () => {
      // Any camera mutation (pan/zoom/rotate, including the per-frame damping
      // settle) makes the frame dirty — render-on-demand keys off this.
      this.needsRender = true;
      const view = this.getView();
      this.bus.emit('viewchange', { type: 'viewchange', ...view });
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
        onSceneChange: () => { this.needsRender = true; }
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
          if (this.savedViewForFloorBadge === null) return;
          const restore = this.savedViewForFloorBadge;
          this.savedViewForFloorBadge = null;
          void this.camera.flyTo({
            lat: restore.lat,
            lon: restore.lon,
            zoom: restore.zoom,
            tilt: restore.tilt,
            bearing: restore.bearing,
            durationMs: 600
          });
        }
      },
      options.tags ?? {}
    );

    this.polygonsManager = new PolygonsManager({
      scene: this.scene.three,
      projection: this.projection
    });

    // Compass overlay — mounted on the same container as the canvas. Visible
    // by default unless the developer opts out via `options.compass === false`.
    this.compass = new Compass(this, container);
    this.compass.setVisible(options.compass !== false);

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
      this.precompileShaders()
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

    const warmup = new THREE.Group();
    warmup.name = 'ShaderWarmup';
    for (const slot of Object.values(Palette)) {
      const mat = this.scene.materials.get(slot);
      warmup.add(new THREE.Mesh(geo, mat));
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
    let smoothedFrameMs = 1000 / 60;
    let lastFrameRendered = false;
    const tick = (): void => {
      if (this.destroyed) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      // frameBudgetOk uses the latest movement-derived smoothedFrameMs. On
      // an idle frame this might be stale (last value from when we last
      // rendered) — that's fine, it represents the latest known actual
      // workload and is the right value for throttling decisions.
      const frameBudgetOk = smoothedFrameMs < this.frameBudgetMs;

      // --- per-frame state updates (cheap; always run) -------------------
      // camera.update fires onChange → sets needsRender while damping.
      this.camera.update(dt);
      // tileManager / layers report whether they changed the rendered scene.
      const tileDirty = this.tileManager.update(false, frameBudgetOk);
      this.baseTileManager?.update(false);
      const layersDirty = this.layers.update(dt);
      this.cloudTime += dt;

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
      const heartbeat = this.framesSinceRender >= HereBeDragonsImpl.RENDER_HEARTBEAT_FRAMES;
      const willRender =
        this.needsRender || tileDirty || layersDirty ||
        cloudsDirty || noiseDirty || heartbeat;

      // --- FPS measurement + auto-tier watchers (movement frames only) ---
      // Only update when THIS frame and the PREVIOUS frame both rendered.
      // `dt` between two render frames reflects actual render workload;
      // anything else (idle skip, just-resumed-from-idle) doesn't.
      if (willRender && lastFrameRendered) {
        smoothedFrameMs = smoothedFrameMs * 0.9 + (dt * 1000) * 0.1;

        // Auto-upgrade: 'auto' mode starts on 'low' and promotes once we
        // see sustained fast frames AFTER the warmup. Counters advance only
        // on rendering frames so the warmup is "120 frames of real work,"
        // not "120 RAFs that may have been mostly idle."
        if (this.autoUpgradeAllowed) {
          this.autoUpgradeFrameCount++;
          if (this.autoUpgradeFrameCount > HereBeDragonsImpl.AUTO_UPGRADE_WARMUP_FRAMES) {
            if (smoothedFrameMs <= this.autoUpgradeFrameMs) {
              this.autoUpgradeStreak++;
              if (this.autoUpgradeStreak >= HereBeDragonsImpl.AUTO_UPGRADE_STREAK_FRAMES) {
                logger.info(
                  `auto-upgrade: smoothed frame ${smoothedFrameMs.toFixed(1)} ms ` +
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
            if (smoothedFrameMs >= this.autoDowngradeFrameMs) {
              this.autoDowngradeStreak++;
              if (this.autoDowngradeStreak >= HereBeDragonsImpl.AUTO_DOWNGRADE_STREAK_FRAMES) {
                logger.info(
                  `auto-downgrade: smoothed frame ${smoothedFrameMs.toFixed(1)} ms ` +
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

      // --- Render (or skip) -----------------------------------------------
      if (willRender) {
        this.composer.setCloudTime(this.cloudTime);
        this.composer.setNoiseTime(this.cloudTime);
        this.updateFogForTilt();
        this.composer.render();
        // Tag/popup DOM overlays only need repositioning when something
        // moved — gate them with the render so a static idle scene does
        // zero per-frame work.
        this.tagsManager.update();
        this.buildingsManager.update();
        this.needsRender = false;
        this.framesSinceRender = 0;
      } else {
        this.framesSinceRender++;
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
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

  /** The render-quality tier currently in effect ('low' or 'high'). */
  getQualityTier(): 'low' | 'high' {
    return this.qualityTier;
  }

  /** Effective device-pixel-ratio handed to the WebGL renderer. */
  getPixelRatio(): number {
    return this.effectivePixelRatio;
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
  setQualityTier(tier: 'low' | 'high'): void {
    if (tier === this.qualityTier) return;
    const profile = resolveQualityProfile(tier);
    this.qualityTier = tier;
    this.pixelRatioCap = profile.pixelRatioCap;

    // pixelRatio — recompute against the device DPR (now under the new
    // tier's cap) and re-size the whole render chain.
    this.updateDevicePixelRatio();

    // Cloud raymarch + outline pipeline — both runtime-toggleable.
    this.setCloudsEnabled(profile.clouds);
    this.composer.setOutlineEnabled(profile.outlines);
    // FXAA → passthrough (or back) on tier swap. `'low'` skips FXAA math.
    this.composer.setFxaaEnabled(profile.fxaa);
    // Keep the FxaaPass saturation in sync with the tier so a runtime swap
    // doesn't leave low tier monochrome or high tier double-saturated.
    this.composer.setSaturation(profile.outlines ? 1.0 : 1.5);
    // Structural toggles: flat buildings + tilt cap + labels + tile zoom.
    this.applyQualityStructure(profile);
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
    this.effectivePixelRatio = pr;
    this.renderer.three.setPixelRatio(pr);
    // composer.resize() reads renderer.getPixelRatio() — running it without
    // a fresh canvas size still re-allocates the targets at the new ratio.
    this.composer.resize(this.renderer.width, this.renderer.height);
    this.needsRender = true;
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
    outline.applySettings();
    // Theme/colour/sky/fog/outline all just changed — repaint next frame.
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
    this.dprWatcherCleanup?.();
    if (this.onPointerMove) this.renderer.dom.removeEventListener('pointermove', this.onPointerMove);
    if (this.onPointerLeave) this.renderer.dom.removeEventListener('pointerleave', this.onPointerLeave);
    if (this.onDblClick) this.renderer.dom.removeEventListener('dblclick', this.onDblClick);
    this.tagsManager.dispose();
    this.polygonsManager.dispose();
    this.buildingsManager.dispose();
    this.compass.destroy();
    this.tileManager.dispose();
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
  const map = new HereBeDragonsImpl(container, options);
  await map.init();
  return map;
}
