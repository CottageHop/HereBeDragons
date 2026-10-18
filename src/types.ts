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
  | 'signs'
  | 'cars';

export interface LayerConfig {
  enabled?: boolean;
}

/**
 * The illustrated outline/ink look + color saturation. Every field optional —
 * omitted fields are left unchanged. `strength` thickens edges, `darkness`
 * tunes how dark an edged pixel goes (0 = pure black, 1 = unaltered),
 * `halftone`/`hatching` add comic-style dot/line shading, and `saturation`
 * boosts overall vibrancy (the Ghibli theme runs ~1.75).
 */
export interface OutlineConfig {
  strength?: number;
  darkness?: number;
  halftone?: number;
  halftoneScale?: number;
  hatching?: number;
  hatchingScale?: number;
  saturation?: number;
}

/** Inclusive geographic bounding box. Latitude in [-90, 90], lon in [-180, 180]. */
export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface HereBeDragonsOptions {
  center: { lat: number; lon: number };
  zoom: number;
  tilt?: number;
  bearing?: number;
  pmtiles_url: string;
  layers?: Partial<Record<LayerName, boolean | LayerConfig>>;
  pixelRatio?: number;
  /**
   * MSAA sample count on the color/normal render targets, overriding the
   * quality tier's default (4 on `'high'`, 0 on `'low'`). 0 disables MSAA
   * (FXAA-only AA). Fixed at construction — it can't change at runtime. Mainly
   * useful for isolating MSAA's cost when tuning performance.
   */
  msaa?: number;
  background?: string;
  /**
   * Render-quality tier.
   *   - `'auto'` (default): detect the device. Phones/tablets start on
   *     `'mobile'`; everything else starts on `'high'` (the cheap FXAA-only
   *     3D path that suits almost every desktop) and lets the runtime watcher
   *     drop to `'low'` if frame time stays bad (default ≥ 67 ms ≈ 15 FPS
   *     sustained). Downgrade is one-shot so the map can't oscillate. More
   *     reliable than keyword-matching the GPU renderer string, which Safari
   *     and other browsers redact for privacy.
   *   - `'mobile'`: the most capable map a phone-class GPU (e.g. an iPhone 8)
   *     can sustain. Keeps 3D buildings, labels, tags, parcels, comp radius,
   *     and tap-select/hover; caps `pixelRatio` to 1.5, drops the low-res
   *     underlay (saves GPU memory), tightens the tile window, and forces off
   *     the ambient decoration (trees, grass, waves, signs, cars, spores,
   *     painterly wash) regardless of theme. A phone too weak even for this
   *     auto-downgrades to `'low'`.
   *   - `'low'`: cap `pixelRatio` to 1, disable MSAA (FXAA-only AA), skip
   *     the volumetric clouds and sketch-outline passes, flatten buildings to
   *     a top-down 2D view, and tighten the tile-load window. Makes the map
   *     playable on integrated GPUs / Retina laptops like a 2019 MacBook Pro.
   *   - `'high'`: full desktop quality — `pixelRatio` up to 2, clouds +
   *     outlines available per theme.
   *
   * An explicit `pixelRatio` or `performance.*` option always overrides the
   * value the profile would have set.
   */
  quality?: 'low' | 'mobile' | 'high' | 'auto';
  /**
   * Dynamic resolution. Default `false`. The renderer is render-on-demand, so
   * the only times it draws are while the camera moves and while tiles stream
   * in. When enabled, the map renders at a cheaper `pixelRatio` (capped to 1)
   * during those moments and snaps to the full tier resolution the instant
   * motion settles — cheaper mid-pan, but the image visibly softens in motion
   * and pops crisp on settle. Left off, the map stays at full resolution
   * throughout (smoothness during gestures is handled by the interaction gate,
   * which defers tile-mesh builds and needs no resolution drop). Turn it on for
   * fill-rate-bound devices that can't hold frame rate at full Retina mid-pan.
   *
   * No effect on a 1× (non-Retina) display, where the motion ratio already
   * equals the rest ratio. Ignored when an explicit `pixelRatio` is set — that
   * option means "render at exactly this ratio, always."
   */
  dynamicResolution?: boolean;
  /**
   * Prioritize scroll/zoom smoothness over tile loading. Default `false`.
   *
   * Building a decoded tile into a mesh forces a synchronous GPU buffer upload
   * on the next render — a few-millisecond main-thread spike. When enabled, the
   * map suspends all tile-mesh construction for as long as a gesture is live
   * (drag, pinch, wheel, and the inertia glide that follows), so a pan or zoom
   * never competes with an upload and stays glass-smooth. Tiles keep fetching
   * and decoding in the background the whole time, then build in a quick burst
   * the instant motion settles. The trade-off: when panning into never-loaded
   * territory, fresh tiles appear a beat after you stop rather than streaming in
   * mid-drag.
   *
   * Left at the default `false`, tiles build continuously during motion (gated
   * only by the per-frame build cap), so fresh detail streams in mid-pan and
   * mid-zoom at the cost of occasional upload hitches. Enable it to trade that
   * mid-gesture detail for maximally smooth scroll/zoom.
   */
  interactionTilePriority?: boolean;
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
  /**
   * Optional parcels overlay. Set `parcels.pmtilesUrl` to load county parcel
   * boundary polygons from a SECOND PMTiles archive (separate from
   * `pmtiles_url`) and render them as clickable outline "boxes" above the
   * basemap. Omit entirely to leave the overlay off — existing single-source
   * maps behave exactly as before. See `ParcelsConfig` for the full shape.
   */
  parcels?: import('./parcels/types.js').ParcelsConfig;
  /**
   * Optional Gaussian-splat tile overlay. Set `splats.urlTemplate` to stream
   * pre-tiled 3D Gaussian splats (`{z}/{x}/{y}.spz` or `.ply`, in the SplatMap
   * tile-local frame) over the vector basemap, drawn with `@sparkjsdev/spark`
   * — an OPTIONAL peer dependency that is dynamically imported only when this
   * option is present. Omit entirely to leave the overlay off — existing maps
   * behave exactly as before and never load Spark. Residency is bounded by a
   * splat budget (`maxSplats`, or `lowTierMaxSplats` on the `'mobile'` /
   * `'low'` tiers). See `SplatsConfig` for the full shape.
   */
  splats?: import('./splats/types.js').SplatsConfig;
  /** Show the compass overlay. Default true. Click resets bearing to north. */
  compass?: boolean;
  /**
   * Scale-bar overlay (default `true`). Pass an object to customise units
   * or target pixel width, or `false` to suppress entirely. Click toggles
   * units. Most real-estate UIs default to imperial; pass
   * `{ units: 'metric' }` for international maps.
   */
  scaleBar?: boolean | {
    units?: import('./studio/ScaleBar.js').ScaleBarUnits;
    targetWidthPx?: number;
  };
  /**
   * Name of a built-in theme to apply on construction (e.g. `'cottagecore'`,
   * `'concretejungle'`). Equivalent to calling `map.applyTheme(name)` right
   * after `createHereBeDragons` resolves — included on the options object so
   * exported Studio JSON drops straight into `createHereBeDragons()` without
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
   * Tile reveal: how newly loaded VECTOR basemap tiles appear. Instead of
   * whole squares popping / rising in, the basemap is only drawn inside the
   * "rounded union" of the loaded tiles — the morphological opening (radius
   * half a tile) of their squares: one tile shows as a circle, two adjacent
   * tiles as a pill with the shared side fully joined, a 2×2 block as a
   * rounded square — and the shape grows as tiles land (the same look as
   * the splats overlay's `roundedUnion`). Outside it the ground plane and
   * the low-res underlay show, as before.
   *
   *  - `true` / omitted → on, with the defaults below;
   *  - `false` → off: square tiles and the rise-from-below animation,
   *    exactly the old behaviour;
   *  - `{ growMs, feather, rise }` → `growMs` (default 700; 0 = no
   *    animation) is how long a tile takes to grow from its centre and a
   *    join to close; `feather` (default 0.03, tile units) is the half-width
   *    of the soft edge — an ordered dither on opaque geometry, alpha on
   *    transparent layers; `rise: true` also keeps the 30 m rise-from-below
   *    slab animation (off by default with the reveal: tiles land at ground
   *    level and buildings grow out of it over `tileSpawnDurationMs`).
   *
   * Overlays (parcels, polygons, tags, splats) are never masked. Toggle at
   * runtime with `setTileReveal()`.
   */
  tileReveal?: boolean | import('./tiles/CoverageField.js').TileRevealOptions;
  /**
   * Tilt-shift "miniature" look: a sharp band across the point the camera looks at with blur
   * growing above and below it, plus a saturated model-photography grade — towns read as scale
   * models. `true` for the defaults or an object to tune it (`radius` CSS px, `band`, `falloff`
   * as fractions of screen height, `saturation`, `contrast`, `vignette`). Runs on the `'high'`
   * quality tier only; free while off. Default off. Toggle at runtime with `setTiltShift()`.
   */
  tiltShift?: boolean | Partial<import('./rendering/TiltShiftPass.js').TiltShiftSettings>;
  /**
   * Cloud pass settings. Accepts a boolean for the simple "on / off" case
   * or an object to set opacity at the same time.
   *   - `true`  → enable at full opacity
   *   - `false` → disable
   *   - `{ enabled, opacity }` → fine-grained control (default opacity 1.0)
   */
  clouds?: boolean | { enabled?: boolean; opacity?: number };
  /**
   * Painterly watercolor-wash strength on flat surfaces (ground/water/landuse/
   * beach), 0..1. Overrides the active theme's value. Omit to inherit it.
   */
  surfacePainterly?: number;
  /** Screen-space paper-grain strength in the final pass, 0..1. Overrides the
   *  theme (which seeds it from `surfacePainterly`). */
  paperGrain?: number;
  /** Procedural road-surfacing strength, 0..1 (cobblestone roads + dirt paths).
   *  Overrides the active theme's value. */
  roadTexture?: number;
  /** Drifting spore/pollen motes in the air. Overrides the theme's value. */
  spores?: boolean;
  /** Peaked (tented) roofs on low/mid-rise buildings instead of flat caps.
   *  Overrides the active theme's value (only Ghibli enables it by default). */
  pitchedRoofs?: boolean;
  /** Painterly building treatment (plaster walls, glowing windows, tiled roofs).
   *  Overrides the active theme's `buildingStyle`. */
  buildingStyle?: import('./themes.js').ThemeBuildingStyle;
  /** Volumetric-cloud look (coverage, density, altitude, colors). Overrides the
   *  active theme's `clouds` preset. Separate from the `clouds` on/off+opacity. */
  cloudPreset?: import('./themes.js').CloudPreset;
  /** Lighting look (sun, fill, ambient, hemisphere). Overrides the active
   *  theme's `light` preset. */
  lightPreset?: import('./themes.js').LightPreset;
  /** Global wind-sway multiplier for grass + tree billboards (1 = default). */
  windStrength?: number;
  /** Shop-sign banner density 0..1 (default 0.5). Needs the `signs` layer on. */
  signsDensity?: number;
  /** Camera zoom at/above which shop-sign banners appear (default 15). */
  signsMinZoom?: number;
  /** Outline/ink look + saturation. Overrides the active theme's `outline` /
   *  `saturation`. */
  outline?: OutlineConfig;
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
   *   - `maxTileApplyMsPerFrame`: 3 (per-frame ms budget for applying
   *     decoded tiles to the scene; the loop applies tiles closest to the
   *     camera first and yields once the budget is spent)
   *
   * Reducing `tileWindowRadius` from 10 → 6 cuts buffer tile count from
   * 441 → 169 (faster first paint, more pop-in when panning). Raising
   * `maxTileApplyMsPerFrame` makes the map fill faster at the cost of
   * input smoothness during the initial load burst.
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
    maxTileApplyMsPerFrame?: number;
    /**
     * Run the heavy visibility/dispatch/evict pass every N-th RAF tick.
     * Default 4 (≈ 15 Hz at 60 FPS). The apply queue + tile spawn
     * animations still drain every frame; only the per-frame cost of
     * recomputing "what tiles do I need?" is throttled. Borrowed from
     * PolyMap's approach (which runs at 6 Hz).
     */
    dispatchInterval?: number;
    /**
     * Camera zoom below which the main (z14) tile grid is suspended: its
     * tiles are ejected and no new ones load until the camera zooms back in.
     * Below this the viewport is so wide that the z14 grid is a tiny island
     * of detail and the low-res underlay already covers the ground, so
     * loading 100+ tiny tiles is wasted work. Default ≈ 9.5 (the zoom at
     * which the loaded ring stops filling the screen).
     *
     * Only takes effect when the low-res underlay is enabled (otherwise the
     * map would go blank when zoomed out). Pass `-Infinity` to force the
     * feature off even with an underlay present.
     */
    mainTileMinZoom?: number;
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
     * GPU frame pacing while splat tiles are resident. Default `true`. Splats make the frame
     * GPU-bound; a loop that submits a frame on every rAF queues frames faster than the GPU
     * drains them, and the splat sort's synchronous depth readback then waits behind the whole
     * queue. With pacing a new frame is only submitted once the GPU has finished the previous one
     * (one frame in flight; reprojection presents the camera's motion on the held ticks). Measured on an Intel Iris with motion LoD (3 interleaved rounds): frames over
     * 50 ms 43 → 17 per pan, the readback stall 58 → 28 ms, p95 57 → 50 ms, for 3 % fewer frames
     * drawn. (Before motion LoD, with heavier frames, it was a trade — see
     * docs/splats-performance.md §5.) `false` submits a frame every tick.
     */
    framePacing?: boolean;
    /**
     * Settle dissolve, ms (default `400`; `0` = snap). When the picture sharpens at rest — dynamic
     * resolution returning to full, the splat overlay swapping its motion LoD for full detail —
     * the last moving frame is held on screen while the sharp one gets ready, then cross-fades
     * into it (a focus pull instead of a pop). A brief pause in a gesture shows nothing: the swap
     * happens behind the held frame. The fade frames only blend two images, so they run at display
     * rate however heavy the scene is. Any camera motion cancels it at once. Off under
     * `prefers-reduced-motion`.
     */
    settleFadeMs?: number;
    /**
     * Reprojection on held ticks (default `true`). While splat tiles are resident the frame is
     * GPU-bound and ticks get held back (GPU frame pacing, the motion-LoD swap hold); with this on,
     * such a tick presents the last frame warped to the current camera — a ground-plane
     * reprojection, exact for the ground, ~0.2 px out for a 10 m roof 300 m away — so every vsync
     * shows the camera's motion and a gesture starts moving on its first frame. One full-screen
     * pass. `false` repeats the last frame on held ticks, as before.
     */
    reprojection?: boolean;
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
    /**
     * Smoothed MOVING-frame threshold (ms) of the plain map above which moving frames switch to
     * 1× rendering (dynamic resolution) for the rest of the session, while the picture at rest
     * keeps the full pixel ratio. Default 25 ms (≈ 40 FPS). The gentle first step for a slow GPU
     * behind a HiDPI screen — e.g. an Intel Iris MacBook in Safari, which redacts the GPU name so
     * `quality: 'auto'` starts it on `'high'` — before the `autoDowngradeFrameMs` fall to the
     * flat `'low'` tier. Fires once, only under `quality: 'auto'` with neither
     * `dynamicResolution` nor `pixelRatio` given, and only on a display above 1×.
     * `setDynamicResolution()` takes over from it.
     */
    autoMotionResFrameMs?: number;
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

export type HereBeDragonsEventName =
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

export type HereBeDragonsEventPayload =
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

/**
 * Render-loop counters from `map.getRenderStats()`: RAF ticks seen, how many
 * rendered, and which dirty source asked for each render (a render can have
 * several reasons, so the reasons can sum to more than `renders`).
 */
export interface RenderStats {
  /** RAF ticks since the previous call. */
  frames: number;
  /** Ticks that drew a frame. Near zero on a still scene. */
  renders: number;
  /** Camera moved or a scene-mutating API call. */
  needsRender: number;
  /** Basemap tiles landed, faded or were evicted. */
  tileDirty: number;
  /** An animated layer (trees, grass, waves, signs, cars) reported a change. */
  layersDirty: number;
  bridgesDirty: number;
  sporesDirty: number;
  /** The cloud pass is on (it drifts, so it is dirty every frame). */
  cloudsDirty: number;
  noiseDirty: number;
  /** The safety-net redraw every `RENDER_HEARTBEAT_FRAMES` ticks. */
  heartbeat: number;
  /** Renders drawn at the dynamic-resolution motion ratio. */
  lowRes: number;
  /** Ticks that wanted to render but were held back one tick because the GPU had not
   *  finished the previous frame (GPU frame pacing, while splat tiles are resident). */
  paced: number;
  /** Ticks that held the picture while a motion-LoD swap sorted the lite splat set (gesture
   *  start, at most ~200 ms) instead of drawing the full set behind it. */
  swapHeld: number;
  /** Settle-dissolve frames presented WITHOUT re-rendering the scene (a blend of the held
   *  frame and the last render — see `performance.settleFadeMs`). */
  dissolveFrames: number;
  /** Held ticks that presented the last frame reprojected to the current camera instead of
   *  repeating it (see `performance.reprojection`). */
  reprojected: number;
}

export type Unsubscribe = () => void;

export interface SnapshotOptions {
  /**
   * Override the renderer's pixel ratio for this capture only. Useful for
   * print/PDF exports — pass `2` (or `3`) to get a HiDPI image without
   * permanently raising the live-render DPR. Restored when `snapshot()`
   * returns.
   */
  pixelRatio?: number;
  /** Output MIME type. Defaults to `'image/png'`. */
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** JPEG/WebP quality 0..1. Ignored for PNG. */
  quality?: number;
}

export interface HereBeDragons {
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
  /** The render-quality tier currently in effect ('low', 'mobile', or 'high'). */
  getQualityTier(): 'low' | 'mobile' | 'high';
  /**
   * The device-pixel-ratio the WebGL renderer is using *right now*. With
   * dynamic resolution on this drops to the motion ratio (≤1) while panning /
   * streaming and returns to the tier's rest ratio once the view settles.
   */
  getPixelRatio(): number;
  /** Smoothed RAF-to-RAF frame time in milliseconds (render frames only). */
  getFrameMs(): number;
  /** Smoothed frames-per-second derived from {@link getFrameMs}. */
  getFps(): number;
  /**
   * Ground meters per CSS pixel at the camera's current latitude + zoom.
   * Web Mercator scale — accurate horizontally through the screen centre.
   * Used by the scale-bar widget; exported so consumers can build their own
   * distance overlays.
   */
  getMetersPerPixel(): number;
  /**
   * Capture the current map view as a data URL. Synchronous (the render
   * and canvas read happen in the same JS tick — that's required for the
   * default `preserveDrawingBuffer: false` to still produce a readable
   * frame). DOM overlays (compass, scale-bar, tag popups) are not in
   * the canvas and so not captured.
   */
  snapshot(options?: SnapshotOptions): string;
  /**
   * Toggle dynamic resolution at runtime (see `dynamicResolution` option).
   * No-op when an explicit `pixelRatio` was supplied at construction.
   */
  setDynamicResolution(on: boolean): void;
  /** Whether dynamic resolution is currently active. */
  getDynamicResolution(): boolean;
  /**
   * Toggle prioritizing scroll/zoom smoothness over tile loading at runtime
   * (see the `interactionTilePriority` option). Turning it off immediately
   * flushes any builds that were suspended.
   */
  setInteractionTilePriority(on: boolean): void;
  /** Whether scroll/zoom is currently prioritized over tile loading. */
  getInteractionTilePriority(): boolean;
  /**
   * Switch render-quality tier at runtime. Applies the profile's
   * runtime-safe levers: pixelRatio, the cloud pass, the outline pipeline,
   * flat-building / tilt / label / ambient-FX structure, and the tile zoom
   * offset. MSAA + tile-window radii are fixed at construction.
   */
  setQualityTier(tier: 'low' | 'mobile' | 'high'): void;
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
  /**
   * Subscribe to parcel click events. Fires with the clicked parcel feature's
   * MVT properties (notably `parcel_id`). No-op when no parcels overlay is
   * configured. Returns an unsubscribe function.
   */
  onParcelClick(
    cb: (parcel: import('./parcels/types.js').ParcelClickEvent) => void
  ): Unsubscribe;
  /** Toggle the parcels overlay on/off (no-op when none is configured). */
  setParcelsEnabled(on: boolean): void;
  /** Whether the parcels overlay is currently enabled. */
  getParcelsEnabled(): boolean;
  /**
   * Toggle the Gaussian-splat overlay on/off (no-op when none is configured,
   * or on the `'mobile'` / `'low'` tiers when `lowTierMaxSplats` is `0`).
   * Pass `{ reveal: 'ripple', origin?, durationMs?, speedMps? }`
   * to animate the transition as an expanding (or, on disable, collapsing)
   * front — see `SplatsRevealOptions`. `opts` are laid over the configured
   * `splats.reveal` defaults field by field, so a plain `setSplatsEnabled(on)`
   * transitions the way the config says (instant unless configured).
   */
  setSplatsEnabled(on: boolean, opts?: import('./splats/types.js').SplatsRevealOptions): void;
  /** Whether the splats overlay is currently in effect (false if unconfigured
   *  or suppressed by the quality tier). */
  getSplatsEnabled(): boolean;
  /** Whether the lean map is in effect: the overlay is on and `splats.leanMap`
   *  (default `true`) has parked the map's outlines, clouds, tilt-shift and
   *  ambient animation for the splats' sake. */
  getSplatsLeanMapActive(): boolean;
  /** Render-loop counters since the previous call (which resets them). See `RenderStats`. */
  getRenderStats(): RenderStats;
  /** Resident splat-tile count, total splat count, reveal animation state and
   *  whether the basemap is currently hidden (zeros / `'none'` / `false` if
   *  unconfigured). */
  getSplatsStats(): import('./splats/types.js').SplatsStats;
  /**
   * Change splat-overlay options at runtime. Applied live where that is
   * cheap — `minZoom`, the tile-pyramid options (`minTileZoom` /
   * `maxTileZoom` / `lodBias` / `lowTierLodBias`: the active level is
   * re-evaluated, nothing is rebuilt), `maxCameraZoom`, `radius`,
   * `maxSplats`, `lowTierMaxSplats`, `maxInFlight`, `hideBasemap`,
   * `neutralGrade`, `roundedUnion.feather` / `.growMs`, `maxStdDev`,
   * `sortIntervalMs`, the `reveal` defaults, and `enabled` (same as
   * `setSplatsEnabled(on)`). Changing `urlTemplate`, `imageryTemplate` or
   * switching `roundedUnion` on / off
   * transparently rebuilds the layer, and a first `urlTemplate` on a map
   * that was constructed without `splats` CREATES the overlay (Spark is
   * imported then). An empty `urlTemplate` removes it. A key present with
   * the value `undefined` resets that option to its default; absent keys
   * are left alone.
   */
  setSplatsOptions(options: Partial<import('./splats/types.js').SplatsConfig>): void;
  /** The splat-overlay options in effect, every default filled in
   *  (`urlTemplate: ''` when no overlay is configured; no `clock`). */
  getSplatsOptions(): import('./splats/options.js').ResolvedSplatsOptions;
  /** Enumerate all buildings in currently-loaded tiles. */
  getLoadedBuildings(): import('./buildings/types.js').BuildingInfo[];
  /** Convert scene-world meters (x, z) → geographic (lat, lon). */
  unproject(x: number, z: number): { lat: number; lon: number };
  /** Show/hide the compass overlay. */
  setCompassVisible(on: boolean): void;
  /** Whether the compass overlay is currently visible. */
  isCompassVisible(): boolean;
  /** Show/hide the scale-bar overlay. No-op when the bar was disabled at construction. */
  setScaleBarVisible(on: boolean): void;
  /** Whether the scale-bar overlay is currently visible. */
  isScaleBarVisible(): boolean;
  /** Switch the scale-bar between metric and imperial. No-op when disabled at construction. */
  setScaleBarUnits(units: import('./studio/ScaleBar.js').ScaleBarUnits): void;
  /** The scale-bar's current unit system, or `null` when disabled at construction. */
  getScaleBarUnits(): import('./studio/ScaleBar.js').ScaleBarUnits | null;
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
  /** Turn the basemap tile reveal (rounded-union mask) on / off at runtime
   *  (turning it on shows the settled union of whatever is loaded), or pass
   *  the option's object form — `{ growMs?, feather?, rise? }` — to retune it
   *  live (which also switches it on, as the same value would at
   *  construction). */
  /** Turn the tilt-shift miniature look on / off (eased), or pass settings to tune it and turn it on. */
  setTiltShift(on: boolean | Partial<import('./rendering/TiltShiftPass.js').TiltShiftSettings>): void;
  /** Whether tilt-shift is requested (the quality tier may be holding it off). */
  getTiltShift(): boolean;
  getTiltShiftSettings(): import('./rendering/TiltShiftPass.js').TiltShiftSettings;
  setTileReveal(reveal: boolean | import('./tiles/CoverageField.js').TileRevealOptions): void;
  getTileReveal(): boolean;
  /** The tile reveal's settings in effect: `{ enabled, growMs, feather, rise }`. */
  getTileRevealOptions(): import('./tiles/CoverageField.js').ResolvedTileReveal;
  /** Collapse extruded buildings to the ground plane (or restore them). */
  setBuildingsFlat(flat: boolean): void;
  getBuildingsFlat(): boolean;
  /**
   * Painterly watercolor-wash strength on flat surfaces (ground/water/landuse/
   * beach), 0..1. 0 = flat toon fills; ~0.9 = the Ghibli hand-painted look.
   */
  setSurfacePainterly(strength: number): void;
  getSurfacePainterly(): number;
  /** Screen-space paper-grain strength in the final pass, 0..1 (0 = off). */
  setPaperGrain(strength: number): void;
  getPaperGrain(): number;
  /** Procedural road surfacing 0..1: cobblestone setts on roads, mottled earth
   *  on paths (0 = plain ribbons). */
  setRoadTexture(strength: number): void;
  getRoadTexture(): number;
  /** Toggle the drifting spore/pollen motes (atmospheric). */
  setSporesEnabled(on: boolean): void;
  getSporesEnabled(): boolean;
  /** Toggle peaked (tented) roofs on low/mid-rise buildings (re-decodes the
   *  visible tiles). Only Ghibli enables it by default. */
  setPitchedRoofsEnabled(on: boolean): void;
  getPitchedRoofsEnabled(): boolean;
  /**
   * Painterly storybook building treatment — warm plaster walls, glowing
   * windows, terracotta/tiled roofs, per-building variety. Pass `null` to
   * clear it (flat toon buildings).
   */
  setBuildingStyle(style: import('./themes.js').ThemeBuildingStyle | null): void;
  /** The resolved painterly-building look currently in effect. */
  getBuildingStyle(): import('./themes.js').ThemeBuildingStyle;
  /**
   * Set the volumetric-cloud look (coverage, density, altitude band, noise
   * scale, wind speed, cloud + shadow colors). Pass `null` to restore the
   * neutral default clouds. Independent of the clouds on/off + opacity.
   */
  setCloudPreset(preset: import('./themes.js').CloudPreset | null): void;
  /** The resolved cloud look currently in effect. */
  getCloudPreset(): import('./themes.js').CloudPreset;
  /**
   * Set the lighting look (sun color/intensity, fill, ambient, hemisphere
   * sky/ground/intensity). Pass `null` to restore the neutral default rig.
   */
  setLightPreset(preset: import('./themes.js').LightPreset | null): void;
  /** The resolved lighting look currently in effect. */
  getLightPreset(): import('./themes.js').LightPreset;
  /** Global wind-sway multiplier for grass + tree billboards. 1 = default,
   *  0 = still, >1 = breezier. */
  setWindStrength(multiplier: number): void;
  getWindStrength(): number;
  /** Shop-sign banner density 0..1 (0 = none, 1 = all candidates). Only takes
   *  effect when the `signs` layer is enabled. */
  setSignsDensity(density: number): void;
  getSignsDensity(): number;
  /** Camera zoom at/above which shop-sign banners appear (default 15). */
  setSignsMinZoom(zoom: number): void;
  getSignsMinZoom(): number;
  /** Set the illustrated outline/ink look + saturation. Only provided fields
   *  change. See {@link OutlineConfig}. */
  setOutline(config: OutlineConfig): void;
  /** The resolved outline/ink look currently in effect. */
  getOutline(): Required<OutlineConfig>;
  /** Override the building / floor highlight colors at runtime. */
  setBuildingHighlightColors(buildingColor: string, floorColor: string): void;
  getBuildingHighlightColor(): string;
  getFloorHighlightColor(): string;
  on(event: HereBeDragonsEventName, cb: (e: HereBeDragonsEventPayload) => void): Unsubscribe;
  resize(): void;
  destroy(): void;
}
