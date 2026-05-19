export type LayerName =
  | 'buildings'
  | 'roads'
  | 'rails'
  | 'water'
  | 'waterways'
  | 'landuse'
  | 'labels'
  | 'trees'
  | 'grass'
  | 'shrubs'
  | 'fountains'
  | 'beaches'
  | 'waves'
  | 'cars';

export interface LayerConfig {
  enabled?: boolean;
}

/** Inclusive geographic bounding box. Latitude in [-90, 90], lon in [-180, 180]. */
export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface DragonMapOptions {
  center: { lat: number; lon: number };
  zoom: number;
  tilt?: number;
  bearing?: number;
  pmtiles_url: string;
  layers?: Partial<Record<LayerName, boolean | LayerConfig>>;
  pixelRatio?: number;
  background?: string;
  /**
   * Render-quality tier.
   *   - `'auto'` (default): start on `'high'` (the cheap FXAA-only 3D
   *     path that suits almost every device) and let the runtime watcher
   *     drop to `'low'` if frame time stays bad (default ≥ 67 ms ≈ 15
   *     FPS sustained). Downgrade is one-shot so the map can't oscillate.
   *     More reliable than keyword-matching the GPU renderer string,
   *     which Safari and other browsers redact for privacy.
   *   - `'low'`: cap `pixelRatio` to 1, disable MSAA (FXAA-only AA), skip
   *     the volumetric clouds and sketch-outline passes, and tighten the
   *     tile-load window. Makes the map playable on integrated GPUs /
   *     Retina laptops like a 2019 MacBook Pro 13".
   *   - `'high'`: full desktop quality — `pixelRatio` up to 2, 4× MSAA,
   *     clouds + outlines on.
   *
   * An explicit `pixelRatio` or `performance.*` option always overrides the
   * value the profile would have set.
   */
  quality?: 'low' | 'high' | 'auto';
  /**
   * Restrict camera panning to this geographic box. The camera target's
   * lat/lon is clamped on every frame; the user can still zoom freely.
   * Combine with `COMMON_BOUNDS` for country/state presets.
   */
  bounds?: BoundingBox;
  /**
   * If true, request the browser's Geolocation API on construction and fly
   * to the user's coordinates when it resolves. The map starts at `center`
   * while the request is pending and silently falls back to `center` if the
   * user denies permission or the lookup times out.
   */
  useUserLocation?: boolean;
  /** Tag overlay configuration (clustering, default styles). */
  tags?: import('./tags/types.js').TagsConfig;
  /** Building picker + popup configuration. */
  buildings?: import('./buildings/types.js').BuildingPopupConfig;
  /** Show the compass overlay. Default true. Click resets bearing to north. */
  compass?: boolean;
  /**
   * Name of a built-in theme to apply on construction (e.g. `'cottagecore'`,
   * `'concretejungle'`). Equivalent to calling `map.applyTheme(name)` right
   * after `createDragonMap` resolves — included on the options object so
   * exported Studio JSON drops straight into `createDragonMap()` without
   * any post-construction setup.
   *
   * The TS shape is `ThemeName | (string & {})`, which keeps autocomplete
   * for built-ins while still permitting any other string at runtime (in
   * case the developer registered a custom theme).
   */
  theme?: import('./themes.js').ThemeName | (string & {});
  /**
   * Per-color overrides applied on top of the active theme. Same shape as
   * what `map.setCustomColors()` accepts. Combined with `theme`, this gives
   * a fully declarative way to ship a styled map without imperative setup.
   */
  customColors?: Partial<import('./themes.js').ThemeColors>;
  /**
   * Atmospheric fog overrides. Fog only kicks in when the camera tilts past
   * `tiltStart` (degrees), reaches full strength at `tiltEnd`, and is then
   * scaled by `strength`. Omit any field to inherit the default.
   *   - `tiltStart` (default 30) — tilt where fog begins ramping in
   *   - `tiltEnd`   (default 40) — tilt where fog is at full strength
   *   - `strength`  (default 1.0) — multiplier on the authored density
   *     (>1 thickens, closer horizon; <1 thins, farther horizon)
   */
  fog?: { tiltStart?: number; tiltEnd?: number; strength?: number };
  /**
   * Visual elevation (meters above ground) for place-name labels — Region /
   * City / Macrohood / Neighbourhood / Business. 0 (default) pins each
   * label to the actual place coords. Raising the value lifts labels
   * upward on screen so they read above the skyline at tilted views.
   * Doesn't change occlusion (a tall building still hides the label as if
   * it were 500 m up — that threshold is separate, see depth-anchor).
   */
  labelHeight?: number;
  /**
   * Duration (ms) of the per-tile "rise from below ground" animation that
   * plays when a new tile loads. 0 disables the animation entirely
   * (tiles snap in instantly). Default 3000 ms. Studio slider ranges
   * 0–3000 ms but any positive value is accepted programmatically.
   */
  tileSpawnDurationMs?: number;
  /**
   * Cloud pass settings. Accepts a boolean for the simple "on / off" case
   * or an object to set opacity at the same time.
   *   - `true`  → enable at full opacity
   *   - `false` → disable
   *   - `{ enabled, opacity }` → fine-grained control (default opacity 1.0)
   */
  clouds?: boolean | { enabled?: boolean; opacity?: number };
  /**
   * Allowed range (in degrees) for camera tilt. The initial value still
   * comes from `tilt`; this just clamps how far the user can drag past it.
   * Omit to use the default `0–75°`.
   */
  tiltRange?: { min: number; max: number };
  /**
   * Allowed range (in degrees) for camera bearing. Omit to allow
   * unconstrained 360° rotation.
   */
  bearingRange?: { min: number; max: number };
  /**
   * Allowed range for camera zoom. Omit to use the default range (~4–22).
   */
  zoomRange?: { min: number; max: number };
  /**
   * Performance tuning knobs. Tweak when the defaults aren't right for the
   * target device (mobile, low-bandwidth, etc.).
   *
   * Defaults:
   *   - `workerPoolSize`: `min(4, navigator.hardwareConcurrency − 1)`
   *   - `visibleRadius`: 4 (tiles within Chebyshev distance 4 of the camera
   *     target dispatch first — roughly the on-screen viewport at z=15)
   *   - `tileWindowRadius`: 10 (21×21 pre-loaded buffer for fast panning)
   *   - `tileWindowRadiusFar`: 14 (peripheral ring; ~777 tiles total)
   *   - `maxTileBuildsPerFrame`: 2 (worker results are queued; this many
   *     get built into three.js meshes per RAF so pointer/wheel input
   *     always has a frame to run)
   *
   * Reducing `tileWindowRadius` from 10 → 6 cuts buffer tile count from
   * 441 → 169 (faster first paint, more pop-in when panning). Raising
   * `maxTileBuildsPerFrame` makes the map fill faster at the cost of input
   * smoothness during the initial load burst.
   */
  /**
   * Low-resolution underlay. When enabled, a small set of lower-zoom tiles
   * (default z=11) loads from the same PMTiles archive and renders BENEATH
   * the high-resolution z14 plane — the screen is never blank while z14
   * streams in. Buildings / rails / labels are skipped on the underlay so
   * its per-tile decode is ~10× cheaper than a full z14 tile.
   *   - omit / `undefined` → enabled at default zoom (11) — DEFAULT
   *   - `false` → disabled
   *   - `true` → enabled at default zoom (11)
   *   - `{ enabled, zoom }` → fine-grained control
   *
   * Enabled by default because the cost is small (~4–9 z11 tiles loaded
   * total at any time, base layers only) and the UX win is significant —
   * no blank canvas during initial load or fast panning. Mirrors PolyMap's
   * `low_res_underlay` config. Opt out with `lowResUnderlay: false`.
   */
  lowResUnderlay?: boolean | { enabled?: boolean; zoom?: number };
  performance?: {
    workerPoolSize?: number;
    visibleRadius?: number;
    tileWindowRadius?: number;
    tileWindowRadiusFar?: number;
    maxTileBuildsPerFrame?: number;
    /**
     * Run the heavy visibility/dispatch/evict pass every N-th RAF tick.
     * Default 4 (≈ 15 Hz at 60 FPS). The apply queue + tile spawn
     * animations still drain every frame; only the per-frame cost of
     * recomputing "what tiles do I need?" is throttled. Borrowed from
     * PolyMap's approach (which runs at 6 Hz).
     */
    dispatchInterval?: number;
    /**
     * Smoothed frame-time threshold (ms) above which the tile manager
     * stops building new tile meshes — framerate is prioritized over
     * loading. Default 22 ms (≈ a 45 FPS floor). Building a mesh triggers
     * a synchronous GPU buffer upload on the next render, so under load
     * it's the single biggest controllable per-frame cost; deferring it
     * keeps the camera smooth. Tiles still decode in the workers and
     * catch up the moment frames recover (e.g. when the camera goes idle).
     */
    frameBudgetMs?: number;
    /**
     * Smoothed frame-time threshold (ms) BELOW which the map auto-upgrades
     * itself from `'low'` to `'high'` (only fires when `quality: 'auto'`).
     * Default 12 ms (≈ 83 FPS). Conservative on purpose: we want low tier
     * running with real headroom before paying high's 3–4× cost. At ~80 FPS
     * on low the system can absorb the upgrade and still clear the 15 FPS
     * floor with margin. Lower the number to upgrade only when even faster
     * (rare); raise it (e.g. 22 ≈ 45 FPS) to upgrade more eagerly at the
     * risk of immediately triggering the downgrade if high is too slow.
     */
    autoUpgradeFrameMs?: number;
    /**
     * Smoothed frame-time threshold (ms) above which the map auto-downgrades
     * itself from `quality: 'high'` to `'low'` once, after a warmup period.
     * Default 67 ms (≈ a 15 FPS floor) — `'high'` stays in effect down to
     * single-digit framerates on the assumption that the prettier render is
     * still worth it at 20–30 FPS; only below 15 does panning feel genuinely
     * broken. Pass a lower number (e.g. 33 for a 30 FPS floor) if you'd
     * rather downgrade earlier. Only fires when the developer didn't
     * explicitly pin `quality` — `quality: 'auto'` (the default) opts in;
     * `quality: 'low'` or `'high'` disables the auto-downgrade. Catches the
     * common case where GPU-string detection failed (browser redacted the
     * renderer) but the machine is genuinely too slow for the desktop tier.
     */
    autoDowngradeFrameMs?: number;
  };
}

export interface CameraView {
  lat: number;
  lon: number;
  zoom: number;
  tilt: number;
  bearing: number;
}

export interface FlyToOptions {
  lat: number;
  lon: number;
  zoom?: number;
  /** Absolute tilt in degrees (0 = top-down). Animated if provided. */
  tilt?: number;
  /** Absolute bearing in degrees from north, +CW. Animated if provided. */
  bearing?: number;
  durationMs?: number;
}

export type DragonMapEventName =
  | 'ready'
  | 'tileload'
  | 'tileerror'
  | 'viewchange';

export interface TileLoadEvent {
  z: number;
  x: number;
  y: number;
}

export interface TileErrorEvent {
  z: number;
  x: number;
  y: number;
  error: Error;
}

export type DragonMapEventPayload =
  | { type: 'ready' }
  | ({ type: 'tileload' } & TileLoadEvent)
  | ({ type: 'tileerror' } & TileErrorEvent)
  | ({ type: 'viewchange' } & CameraView);

/**
 * A point sound source for the dB heat-map overlay. `db` is the source
 * level at 1 world-unit (~1 m) distance; attenuation in the shader is
 * standard inverse-square (`dB(d) = source.db − 20·log10(d)`). The shader
 * sums contributions across all sources and maps the total to a green →
 * yellow → red ramp with animated ring bands.
 */
export interface NoiseSource {
  lat: number;
  lon: number;
  db: number;
}

export type Unsubscribe = () => void;

export interface DragonMap {
  setView(lat: number, lon: number, zoom?: number): void;
  /** Absolute bearing (deg from north, +CW). Preserves target + distance. */
  setBearing(degrees: number): void;
  /** Absolute tilt (deg from +Y, 0 = top-down). Preserves target + distance. */
  setTilt(degrees: number): void;
  /** Animate zoom/tilt/bearing back to the values passed at construction. */
  resetView(durationMs?: number): Promise<void>;
  getView(): CameraView;
  flyTo(opts: FlyToOptions): Promise<void>;
  setLayerEnabled(name: LayerName, on: boolean): void;
  getLayerEnabled(name: LayerName): boolean;
  /** Toggle the volumetric clouds pass on/off. */
  setCloudsEnabled(on: boolean): void;
  /** Set cloud opacity 0..1 (1 = full, 0 = invisible). */
  setCloudsOpacity(opacity: number): void;
  getCloudsEnabled(): boolean;
  getCloudsOpacity(): number;
  /**
   * Toggle the dB heat-map overlay pass. Off by default; enable it AFTER
   * you've supplied sources via `setNoiseSources()`. The pass is a no-op
   * with zero sources, so the order of these two calls doesn't matter for
   * correctness — it only matters for whether the pass actually fires.
   */
  setNoiseEnabled(on: boolean): void;
  /** Whether the dB heat-map pass is currently enabled. */
  getNoiseEnabled(): boolean;
  /**
   * Replace the dB heat-map source list. Accepts up to 128 sources; extras
   * are silently dropped — callers with denser datasets should cull to the
   * 128 closest to the camera on the CPU before calling.
   */
  setNoiseSources(sources: ReadonlyArray<NoiseSource>): void;
  /** The render-quality tier currently in effect ('low' or 'high'). */
  getQualityTier(): 'low' | 'high';
  /** Effective device-pixel-ratio handed to the WebGL renderer. */
  getPixelRatio(): number;
  /**
   * Switch render-quality tier at runtime. Applies the profile's
   * runtime-safe levers: pixelRatio, the cloud pass, and the outline
   * pipeline. MSAA + tile-window radii are fixed at construction.
   */
  setQualityTier(tier: 'low' | 'high'): void;
  /**
   * Apply a named theme. The TS shape is `ThemeName | (string & {})` so
   * VSCode autocompletes the built-in theme names while still permitting
   * any other string at runtime (e.g. for custom themes the developer
   * has merged into `THEMES`). Unknown names are a no-op.
   */
  applyTheme(name: import('./themes.js').ThemeName | (string & {})): void;
  /** Override individual theme colors on top of the active theme. */
  setCustomColors(colors: Partial<import('./themes.js').ThemeColors>): void;
  getCurrentTheme(): string;
  getCustomColors(): Partial<import('./themes.js').ThemeColors>;
  /** Add an interactive tag at a (lat, lon). Returns a handle for later updates. */
  addTag(options: import('./tags/types.js').TagOptions): import('./tags/types.js').TagHandle;
  /** Remove a tag by id. */
  removeTag(id: string): void;
  /** Remove every tag. */
  clearTags(): void;
  /** Look up a previously-added tag's handle by id. */
  getTag(id: string): import('./tags/types.js').TagHandle | undefined;
  /** Draw a custom filled polygon from (lat, lon) points. */
  addPolygon(options: import('./polygons/types.js').PolygonOptions): import('./polygons/types.js').PolygonHandle;
  removePolygon(id: string): void;
  clearPolygons(): void;
  getPolygon(id: string): import('./polygons/types.js').PolygonHandle | undefined;
  /** Merge a building picker / popup configuration patch at runtime. */
  setBuildingPopup(config: import('./buildings/types.js').BuildingPopupConfig): void;
  /** Whether the building popup is currently enabled. */
  isBuildingPopupEnabled(): boolean;
  /** Programmatically highlight a building (and optional floor). */
  selectBuilding(id: string, floor?: number): import('./buildings/types.js').BuildingInfo | null;
  /** Clear any active building highlight + popup. */
  clearBuildingSelection(): void;
  /** Subscribe to building click events. */
  onBuildingClick(cb: (info: import('./buildings/types.js').BuildingInfo) => void): Unsubscribe;
  /** Enumerate all buildings in currently-loaded tiles. */
  getLoadedBuildings(): import('./buildings/types.js').BuildingInfo[];
  /** Convert scene-world meters (x, z) → geographic (lat, lon). */
  unproject(x: number, z: number): { lat: number; lon: number };
  /** Show/hide the compass overlay. */
  setCompassVisible(on: boolean): void;
  /** Whether the compass overlay is currently visible. */
  isCompassVisible(): boolean;
  /** Restrict (or release with `null`) camera panning to a geographic box. */
  setBounds(bounds: BoundingBox | null): void;
  /**
   * Clamp the allowed tilt to `[min, max]` degrees. The user can drag the
   * camera anywhere inside this range; values outside it are blocked. Pass
   * `null` to restore the default `0–75°`.
   */
  setTiltRange(range: { min: number; max: number } | null): void;
  /**
   * Clamp the allowed bearing to `[min, max]` degrees from north (+CW).
   * Pass `null` to restore unconstrained 360° rotation.
   */
  setBearingRange(range: { min: number; max: number } | null): void;
  /**
   * Clamp the allowed zoom to `[min, max]`. Pass `null` to restore the
   * default range (~4–22).
   */
  setZoomRange(range: { min: number; max: number } | null): void;
  /** Tilt (deg) below which fog is fully off. Default 30. */
  setFogTiltStart(deg: number): void;
  getFogTiltStart(): number;
  /** Tilt (deg) at and above which fog is at full strength. Default 40. */
  setFogTiltEnd(deg: number): void;
  getFogTiltEnd(): number;
  /** Multiplier on the authored fog density. 1.0 = unchanged, >1 thicker. */
  setFogStrength(strength: number): void;
  getFogStrength(): number;
  /**
   * Visual elevation (meters) for place-name labels. 0 = pinned to ground
   * (default). Raise to lift labels visually above the skyline.
   */
  setLabelHeight(meters: number): void;
  getLabelHeight(): number;
  /**
   * Duration (ms) of the rise-from-below tile spawn animation. 0 = instant.
   */
  setTileSpawnDurationMs(ms: number): void;
  getTileSpawnDurationMs(): number;
  /** Collapse extruded buildings to the ground plane (or restore them). */
  setBuildingsFlat(flat: boolean): void;
  getBuildingsFlat(): boolean;
  /** Override the building / floor highlight colors at runtime. */
  setBuildingHighlightColors(buildingColor: string, floorColor: string): void;
  getBuildingHighlightColor(): string;
  getFloorHighlightColor(): string;
  on(event: DragonMapEventName, cb: (e: DragonMapEventPayload) => void): Unsubscribe;
  resize(): void;
  destroy(): void;
}
