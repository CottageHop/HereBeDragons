import type { RoundedUnionOptions } from './roundedUnion.js';
import type { GovernorState } from './governor.js';

/**
 * Configuration for the optional Gaussian-splat tile overlay. When
 * `urlTemplate` is set (and `enabled` is not explicitly false) the map streams
 * pre-tiled 3D Gaussian splats (`.spz` / `.ply`) over the vector basemap and
 * draws them with Spark (`@sparkjsdev/spark`), which is loaded lazily the
 * first time the overlay opens.
 *
 * Off by default: a map constructed without a `splats` option behaves
 * exactly as before, never imports Spark, and pays zero cost for this
 * feature.
 */
export interface SplatsConfig {
  /**
   * Tile URL template with `{z}`, `{x}` and `{y}` placeholders, e.g.
   * `https://tiles.example.com/splats/{z}/{x}/{y}.spz`. Its presence is what
   * turns the overlay on. Tiles are expected in the SplatMap tile-local frame:
   * origin at the tile's SOUTH-WEST corner, x = east, y = north, z = up, all in
   * Web-Mercator metres (heights pre-multiplied by 1 / cos(lat_tile)). The
   * file format is taken from the template's extension (`.spz` or `.ply`);
   * with any other extension Spark sniffs the bytes.
   */
  urlTemplate: string;
  /**
   * Tile template used instead of `urlTemplate` on the `'low'` / `'mobile'` quality tiers:
   * the same pyramid built with fewer, larger surfels (`splatmap tiles --spacing 0.7` is
   * ~165k splats per z16 tile against ~280k at the default 0.45 m), so a phone or an
   * integrated GPU gets whole tiles inside `lowTierMaxSplats` instead of a budget-starved
   * window. Same file type as `urlTemplate`. Unset: every tier fetches `urlTemplate`.
   */
  lowTierUrlTemplate?: string;
  /**
   * URL template for the per-tile satellite imagery (`{z}/{x}/{y}.png`, north
   * up, covering exactly the tile) drawn as a textured ground plane under each
   * splat tile. Defaults to `urlTemplate` with its extension swapped for
   * `.png`. Set to `null` to skip the imagery ground entirely.
   */
  imageryTemplate?: string | null;
  /**
   * Master on/off switch. Defaults to `true` when `urlTemplate` is set — pass
   * `false` to construct the overlay machinery but keep it inactive (toggle
   * later with `map.setSplatsEnabled(true)`). On the `'mobile'` / `'low'`
   * quality tiers the overlay runs with the smaller `lowTierMaxSplats`
   * budget (and is forced off when that is `0`).
   */
  enabled?: boolean;
  /**
   * Minimum CAMERA zoom at which splat tiles are fetched and drawn. Below this
   * the overlay loads nothing, renders nothing, and drops any resident tiles.
   * Default 13 (the coarsest default pyramid level).
   */
  minZoom?: number;
  /**
   * Coarsest / finest level of the splat TILE PYRAMID. The finest level
   * carries the full-detail surfels; every coarser level merges its four
   * children and thins them back to the same per-tile splat budget. The
   * overlay picks the level from the camera zoom —
   *
   *   tileZ = clamp(floor(cameraZoom + lodBias), minTileZoom, maxTileZoom)
   *
   * with ±0.15 of hysteresis so a camera parked on a boundary doesn't flap —
   * and keeps its window `radius` tiles of THAT level wide, so the tiles on
   * screen and the resident splats stay roughly constant from street level
   * out to the whole town. When the level changes the new level streams in
   * nearest-first while the old level's tiles stay until the new tiles over
   * them have landed and grown, then shrink away. If a level turns out to be
   * missing under the camera (every tile of its window 404s) the next finer
   * (then coarser) level is used instead, so a tile set that ships only part
   * of the pyramid still shows. Applied live. Defaults 13 / 16.
   */
  minTileZoom?: number;
  maxTileZoom?: number;
  /**
   * Added to the camera zoom before the tile level is picked: `-1` runs one
   * level coarser everywhere (a quarter of the detail per screen pixel — and
   * the same tile count covering four times the ground), `+1` one finer.
   * Fractions shift the switch-over points. Default `1.5`: one level finer
   * than the camera zoom, switching half a zoom early — a smaller, sharper
   * satellite patch around where the camera looks, with the vector map
   * (`hideBasemap: 'covered'`) carrying the rest of the view. The frame-time
   * `governor` may lower the bias in effect by up to 1 on a GPU that cannot
   * hold `targetFrameMs` even at a quarter of the splat budget.
   */
  lodBias?: number;
  /**
   * How the pyramid level is chosen.
   *
   * `'bias'` (default) keys off camera zoom: `floor(cameraZoom + lodBias)`.
   * `'resolution'` picks the coarsest level whose imagery still out-resolves the screen by
   * `resolutionMargin`, with `lodBias` as a whole-level nudge on top. Measured on this map at
   * camera zoom 14.6 the screen shows 5.16 m/px while a level-16 tile's imagery is 0.49 m/px —
   * 10x finer than the display, for 16x the tiles per unit ground. Resolution mode spends the
   * splat budget on AREA instead; at the zoom cap both rules pick the same level.
   */
  levelSelection?: 'bias' | 'resolution';
  /**
   * `levelSelection: 'resolution'` only. How much finer than the screen a level's imagery must
   * be: 1 = exactly matched, 0.5 (default) = 2x oversampled, which keeps the near field crisp
   * under tilt.
   */
  resolutionMargin?: number;
  /**
   * `levelSelection: 'resolution'` only. Choose the level from the resolution at the NEAR edge of
   * a tilted view rather than at the camera target, so the foreground stays crisp when the camera
   * is pitched over. Default `true`; `false` reverts to judging by the target alone.
   */
  resolutionTiltAware?: boolean;
  /** `lodBias` used on the `'low'` / `'mobile'` quality tiers. Default `0.5`
   *  (one level coarser than the `'high'` default). */
  lowTierLodBias?: number;
  /**
   * Camera max zoom while the overlay is enabled — up close the surfels read
   * as blobs and the satellite ground (NAIP, ~0.6 m) smears, so the camera is
   * kept out of that range (eased out if it is already closer when the overlay
   * comes on). The map's previous zoom limit returns when the overlay is
   * disabled. Default 16.5: at a typical 62° tilt the near edge of the frame is
   * then ~0.7 m per screen pixel, coarser than both the 0.45 m surfels and the
   * ground texels, so nothing on screen is magnified (at 17 it was ~0.47 m/px:
   * blurred roads and cars, visible surfel dots on roofs).
   */
  maxCameraZoom?: number;
  /**
   * Camera tilt cap while the overlay is on, degrees from straight down (default `45`; values
   * ≥ 89 = none). Laid over the map's own tilt range like `maxCameraZoom` over its zoom range;
   * a camera tilted further when the overlay arrives is eased up to it, and the range is put back
   * when the overlay goes. Seen from steeper angles the satellite layer runs into its far field —
   * many tiles, sub-pixel splats, the horizon — and out of the miniature look.
   */
  maxCameraTilt?: number;
  /**
   * @deprecated Use `minTileZoom` / `maxTileZoom`. Pins BOTH to this level —
   * the old fixed-zoom behaviour (one authored level, requested whatever the
   * camera zoom). Either new key, when present, wins over it.
   */
  zoomLevel?: number;
  /**
   * Chebyshev radius (in tiles) of the square load window around the camera
   * target. `1` (the default) covers a 3×3 block, `0` just the tile under the
   * camera; tiles further than `radius + 1` from the centre are evicted as
   * the camera moves. The window is only an upper bound — `maxSplats` decides
   * how much of it is actually resident, nearest-first. Capped at `1` on the
   * `'low'` / `'mobile'` tiers.
   */
  radius?: number;
  /** Cap on concurrent tile fetch + decodes. Default `4` — Spark decodes in a pool of four
   *  workers, so four in flight lets fetches overlap decodes; at `1` every tile loaded strictly in
   *  series (measured: the first detail tile of a view started 700 ms after the first fetch and
   *  three detail tiles landed 380 ms apart). Landings are batched at rest (one re-sort for the
   *  batch) and one per frame in motion. */
  maxInFlight?: number;
  /**
   * Resident-splat budget for the `'high'` tier. Every resident splat is
   * transformed, depth-read-back, sorted and rasterised on each camera move,
   * so this — not `radius` — is what bounds the per-frame cost. Tiles are
   * loaded nearest-first and loading stops once the next tile would exceed
   * the budget; when the view moves, the farthest tiles are evicted to make
   * room for nearer ones. The first tile always loads even if it is alone
   * over budget. Default `1_200_000`.
   */
  maxSplats?: number;
  /**
   * Budget used instead of `maxSplats` on the `'low'` / `'mobile'` quality
   * tiers (integrated / phone GPUs), where the window is also capped at
   * radius 1. `0` disables the overlay on those tiers outright. Default
   * `400_000`.
   */
  lowTierMaxSplats?: number;
  /**
   * How far out (in standard deviations) each Gaussian is rasterised —
   * Spark's `maxStdDev`. Lower trims the near-invisible fringe of every
   * splat quad and with it fill cost; Spark's own default is `√8`. Default
   * `√5`.
   */
  maxStdDev?: number;
  /**
   * Spark's minimum on-screen size for a splat, in pixels (its `lodRenderScale`). Spark's LoD
   * tree will not pick splats smaller than this, so raising it spends rendering capacity on
   * splats you can actually see. Spark documents values as high as 5 as "often
   * indistinguishable".
   *
   * Default 1 (Spark's own default). Measured on the reference hardware at 2.4-2.7M resident
   * splats, raising it to 2 or 4 produced NO reproducible frame-time change — most likely because
   * Spark's LoD tree serves its paged/streaming splat path, while these tiles are whole `.spz`
   * meshes loaded in one piece. It is exposed because it may still help fill-rate-bound devices
   * (phones), but do not expect it to earn its keep on desktop without measuring.
   */
  lodRenderScale?: number;
  /**
   * Hide resident tiles that fall outside the view. Spark has no per-mesh frustum test, so an
   * off-screen tile costs exactly what an on-screen one does; measured at high tilt, 3 of 17
   * resident tiles were outside the view and hiding them took the 95th-percentile frame from
   * 58 ms to 46 ms. Default `true`.
   */
  frustumCull?: boolean;
  /**
   * Start loading tiles that are inside the view before ones outside it. Affects load ORDER only:
   * once every visible tile is resident the budget still fills with off-screen tiles, which is
   * useful prefetch when `frustumCull` keeps them from costing frame time. Default `true`.
   */
  visibleFirst?: boolean;
  /**
   * Distance in scene metres beyond which a tile's SPLATS are hidden while its imagery ground
   * plane keeps drawing. Both come from the same photograph, and past a few hundred metres an
   * individual splat is under a pixel, so what is lost is relief rather than detail — while the
   * saving is the whole splat count of every distant tile. `0` disables the cutoff.
   *
   * Rendering here is bound by splat count, not fill rate, so this is one of the few levers that
   * actually moves frame time. Default `0` until it has been measured on your content.
   */
  splatMaxDistance?: number;
  /**
   * `splatMaxDistance` floor applied on the `'low'` / `'mobile'` tiers even when the governor is
   * idle, mirroring `lowTierMaxSplats`. Phones pay the most for distant relief and show it on the
   * fewest pixels. Default `1200`; `0` opts out.
   */
  lowTierSplatMaxDistance?: number;
  /**
   * How long a tile's splats take to fade when they cross `splatMaxDistance`, ms. The cutoff
   * moves on its own when the FrameGovernor tightens it, so a hard switch would blink whole
   * tiles out mid-pan. `0` snaps. Default `350`.
   */
  splatFadeMs?: number;
  /**
   * Minimum spacing between Spark's depth-sort passes in milliseconds. Each
   * pass costs a GPU→CPU readback that stalls the main thread until the GPU
   * has drained, so during a continuous camera move this bounds how much
   * time is spent in those stalls (`0` = sort as fast as the previous sort
   * finishes, Spark's default). Default `100`; the `'low'` / `'mobile'`
   * tiers use at least `250`.
   */
  sortIntervalMs?: number;
  /**
   * How the vector basemap gives way to the satellite.
   *
   *  - `'covered'` (default) — per region: the basemap stays everywhere
   *    EXCEPT under splat tiles that have landed. The overlay's rounded union
   *    (every resident level, growth animation and ripple front included) is
   *    baked into the second channel of the tile-reveal coverage texture and
   *    every basemap material is cut by its complement, so houses, trees,
   *    grass, signs, cars, bridges, roads and foam disappear exactly where
   *    — and as — the satellite grows in, and the two soft edges dissolve
   *    into each other without a gap. Buildings under the satellite cannot
   *    be hovered or clicked. Street and place labels stay on top (see
   *    `keepLabels`). Nothing is hidden or suspended globally.
   *  - `true` — the old global hide: the `buildings`, `roads`, `landuse`,
   *    `water`, `waves`, `trees`, `grass` and `labels` layers are hidden (and
   *    their animations suspended) while at least one splat tile is showing,
   *    and return the moment the last one leaves.
   *  - `false` — never hide anything (debugging the alignment).
   *
   * The caller's own `setLayerEnabled()` choices are preserved underneath in
   * every mode. Applied live.
   */
  hideBasemap?: boolean | 'covered';
  /**
   * With `hideBasemap: 'covered'`: keep street and place labels visible over
   * the satellite (the "hybrid map" look). `false` cuts them out with the
   * rest of the basemap. Default `true`.
   */
  keepLabels?: boolean;
  /**
   * Hold HereBeDragons' post-processing at a neutral grade while the overlay is showing:
   * saturation 1.0 (themes default to a 1.5x vibrance boost), no shine highlight, no paper
   * grain. Captured imagery and splats then keep the colours they were authored with. The
   * theme's look is restored when the overlay is disabled. Default `true`.
   *
   * The grade is a full-screen post-process, so it cannot follow the
   * satellite's outline: with `hideBasemap: 'covered'` it engages while the
   * VIEW CENTRE is over landed satellite (and releases when the camera pans
   * off it), easing between the theme's look and neutral over 400 ms rather
   * than snapping.
   */
  neutralGrade?: boolean;
  /**
   * Frame-time governor. While the picture is moving (camera motion, tiles
   * or a ripple animating) a smoothed frame time is tracked; when it is over
   * `targetFrameMs` the resident-splat budget in effect is scaled down
   * (`maxSplats × scale`, floor 0.25 — farthest tiles are evicted and nothing
   * more is admitted), and if frames are still over target on that floor the
   * `lodBias` in effect steps down by 0.5 (at most 1 below the configured
   * value). It recovers slowly — a step back up only after 4 s of moving
   * frames under 0.7 × target, and twice as reluctantly after a raise that
   * had to be taken back — so it never oscillates. The state is reported in
   * `getSplatsStats().governor`. Default `true`.
   */
  governor?: boolean;
  /** Frame time the governor holds while moving, ms. Default `33` (30 fps);
   *  values under 8 are raised to 8. */
  targetFrameMs?: number;
  /**
   * How far ABOVE the configured `maxSplats` the governor may grow the budget on a
   * device that has proven it has headroom. Default `1` = never, i.e. the budget is
   * a hard ceiling and the governor can only cut.
   *
   * A cut-only governor makes `maxSplats` a number that has to be safe on the
   * weakest device it will ever run on, so every device above that line leaves its
   * headroom permanently unused — measured on the reference machine, the shipping
   * default settles at 3 tiles / 944k splats holding a 95th-percentile frame of
   * 19-22 ms with the governor never engaging, while the same machine renders 2.15M
   * splats at 23 ms. Above 1 the budget becomes a starting point and the device
   * finds its own level, by the same evidence rule as every other raise: 4 s of
   * moving frames under 0.7 x target buys one x1.25 step, and a step that has to be
   * taken back doubles the wait before the next. Growth is the LAST raise in the
   * order, so the budget never grows while any degradation is still in effect.
   * Costs memory as well as frame time (more resident tiles); capped at 4.
   */
  budgetGrowth?: number;
  /**
   * Length of the CROSS-DISSOLVE between pyramid levels, ms. A level change
   * is a change of detail in place, so the incoming tile does not "grow" like
   * new ground: it appears at its full rounded-union shape and its splats
   * (opacity, and scale 0.6 → 1) and imagery fade in while the tile(s) it
   * replaces fade out over the same window; the vector cut-out holds the max
   * of both levels, so the basemap never flashes through. Zooming back across
   * the boundary mid-fade reverses the fades from where they got to. `0` =
   * instant swap (use it for `prefers-reduced-motion`). Default `350` (the motion system's base duration, `DURATION.base`),
   * capped at 5000.
   */
  levelFadeMs?: number;
  /**
   * How far over the (governed) splat budget a dissolve may go while both
   * levels overlap: one tile's worth — the incoming tile's splat count —
   * capped at this fraction of `maxSplats` (the configured one, not the
   * governor-scaled one), for at most `levelFadeMs + 250` ms; the outgoing
   * tile's splats are released the moment its fade completes. Without it a
   * budget of about one tile (an integrated GPU under the governor) turns
   * every level change into a hard swap. `0` = never exceed the budget.
   * Default `0.35`, range 0‥1.
   */
  transitionOvershoot?: number;
  /**
   * Prefetch across the level threshold: while the camera zoom is within this
   * distance of the zoom at which the level will switch, the next level's
   * tile under the camera target is fetched and decoded in the background
   * (never attached to the scene, at most two held, `maxInFlight` respected,
   * dropped when the camera leaves the band), so the dissolve starts the
   * moment the threshold is crossed instead of after a fetch + decode.
   * `0` = off. Default `0.2`, capped at 0.5.
   */
  prefetchBand?: number;
  /**
   * Show the loaded tiles as their ROUNDED UNION instead of hard squares —
   * "like a Bootstrap button group": one tile is a circle (one tile across,
   * ≈ 610 m at z16 — also what a one-tile low-tier budget looks like), two
   * edge-adjacent tiles a pill with the shared side fully joined, a complete
   * 2×2 block a rounded square; outer corners always round, interior joins
   * seamless. Applied identically to the splats (a per-tile Spark
   * `objectModifier`) and the imagery ground, and animated: a tile that lands
   * grows from its centre over `growMs`, then its neighbours' joins grow out
   * toward it; a tile that drifts out of range shrinks away over 300 ms
   * (evictions that free budget are immediate). Multiplies with the ripple
   * reveal. `feather` is the soft edge's half-width in tile units (default
   * `0.03`), `growMs` the grow-in length (default `700`; `0` = no animation).
   * Default `true`; `false` restores square tiles.
   */
  roundedUnion?: boolean | RoundedUnionOptions;
  /**
   * Default transition for `map.setSplatsEnabled(on)`: the reveal style, its
   * length and front speed (and, optionally, a fixed `origin` — default the
   * view centre at the moment of the toggle). Options passed to
   * `setSplatsEnabled(on, opts)` are laid over these field by field, so
   * `reveal: { reveal: 'ripple' }` makes every plain toggle ripple while
   * `setSplatsEnabled(on, { reveal: 'none' })` still switches at once. Lives
   * in the config so a Studio export reproduces the toggle behaviour.
   * Default `{ reveal: 'none', durationMs: 1800, speedMps: 250 }`.
   */
  reveal?: SplatsRevealOptions;
  /**
   * Lean map while the overlay is on. Every resident splat is re-rasterised on
   * every rendered frame, so while splats are showing the map should spend the
   * GPU on nothing else: the outline pipeline (a second full-scene render + a
   * Sobel pass), the cloud raymarch and the tilt-shift blur are switched off,
   * the ambient animations (trees, grass, foam, signs) are frozen so they stop
   * requesting frames, and dynamic resolution renders the moving picture at
   * 1× on a Retina display. Everything is put back the moment the overlay is
   * disabled. Default `true`; `false` leaves the map's own settings alone.
   */
  leanMap?: boolean;
  /**
   * Motion LoD. With a lite pyramid (`lowTierUrlTemplate`) on the `'high'` tier, every resident
   * tile also loads its lite version and draws it while the camera moves, back to full detail
   * once the map settles — a visibility flip, nothing refetched. The frame cost is per splat,
   * not per pixel, so fewer splats in motion is what keeps a pan smooth: measured on an Intel
   * Iris, one full z16 tile pans at 28 fps, one lite tile at 52–58. Costs ~45 % more splat
   * memory per tile. Default `true`; `false` draws the full tiles throughout.
   */
  motionLod?: boolean;
  /**
   * Motion thinning, the governor's FIRST rung: when moving frames run over `targetFrameMs`, keep
   * only a hashed fraction of each tile's splats while the camera moves (0.7, then 0.5, then
   * 0.35), the survivors grown by 1/sqrt(keep) so the surface stays covered; every splat is
   * back at rest. Only then does the governor drop distant relief or evict tiles. Dropped splats
   * leave Spark's sort and draw entirely, and splat cost is per splat, so this buys frame time
   * without losing coverage: measured on an Intel Iris (3 interleaved rounds), a pan went from
   * 24–29 to 48–49 drawn fps, p95 92–94 → 33–34 ms, and the budget was never cut (without it the
   * governor evicted tiles down to ×0.6–0.8). Default `true`; `false` skips the rung.
   */
  motionThin?: boolean;
  /**
   * Screen-space density LOD: the target spacing between drawn splats, in DEVICE pixels (default
   * `2`; `0` = off). Splat cost is per splat, not per pixel, and in a tilted view most of the frame
   * is far ground where several surfels land on one pixel. Each splat's sampling spacing (about
   * twice its scale) is projected to the screen; where it falls under the target, only a hashed
   * fraction is kept and the survivors grow to keep the surface covered — the far field looks the
   * same with a fraction of the splats, and the depth sort has fewer to order. Near splats, whose
   * spacing projects wider than the target, are untouched. Follows the drawing-buffer size, so the
   * 1× motion resolution thins further than the 2× rest picture on a Retina display. Measured on
   * the CdA demo at a 62° tilt: at rest 28 % fewer splats drawn on a 2× buffer (mean pixel change
   * 0.17/255), 54 % fewer on 1× (0.67/255), neither visible side by side; in a pan, frames over
   * 50 ms 8 → 5, the sort's readback 22 → 17 ms, and the governor thins the NEAR field less. `1.5`
   * is the conservative setting (15 % / 0.06 on 2×).
   */
  densityLod?: number;
  /**
   * Miniature look while satellite tiles are on screen (default `true`): the map's tilt-shift
   * runs with an imagery preset (`MINIATURE_IMAGERY_TILT_SHIFT`: the same shallow focus band on
   * the point the camera looks at, a calmer grade than the vector map's), eased in as the first
   * tile lands and out when the last one goes, whatever the map's own `tiltShift` setting. The
   * lean map, which otherwise parks the blur while splats show, makes way for it. Settings given
   * to `setTiltShift({ … })` are honoured instead of the preset. `false` leaves the tilt-shift to
   * the map's own setting.
   */
  miniature?: boolean;
  /**
   * Cover level (default `true`): keep the next coarser pyramid level resident under the detail
   * window — the whole view in coarse splats, loaded FIRST and from the lite pyramid when one is
   * configured — and spend `maxSplats` on detail tiles ranked from the view centre outward, each
   * dissolving in over its parent's quadrant (the parent's splats under a landed child cost
   * nothing). Where the detail budget runs out the view shows the cover instead of the vector
   * map, and a pan shows coarse splats where detail has not landed yet rather than nothing. Cover
   * tiles sit outside the splat budget (memory, not frame time: the far field they mostly are is
   * thinned by the density LOD, and covered quadrants are inactive). Off on the low tiers.
   */
  cover?: boolean;
  /**
   * Animation clock used by the reveal animations (milliseconds, monotonic).
   * Defaults to `performance.now`. Injectable so tools and tests can freeze or
   * scrub the ripple.
   */
  clock?: () => number;
}

/**
 * How `map.setSplatsEnabled()` transitions the overlay in / out.
 *
 * - `'none'` (default) — instant.
 * - `'ripple'` — an expanding circular front from `origin`: splats inside the
 *   front pop up (scale 0 → 1 with an overshoot) and a ±10 % sine ring rides
 *   the front; splats beyond it stay collapsed. The imagery ground fades in
 *   under the same front with a bright wave. Disabling plays it backwards and
 *   unloads the tiles once the front has collapsed.
 */
export interface SplatsRevealOptions {
  reveal?: 'none' | 'ripple';
  /** Centre of the ripple. Default: the current view centre. */
  origin?: { lat: number; lon: number };
  /** Ripple length in ms. Default 1800. */
  durationMs?: number;
  /** Front speed in metres per second. Default 250. */
  speedMps?: number;
}

/** Snapshot returned by `map.getSplatsStats()`. */
export interface SplatsStats {
  /** Number of splat tiles currently resident in the scene (both levels
   *  while a level transition is in progress). */
  tiles: number;
  /** Active level of the tile pyramid — the `{z}` being requested right now
   *  (`maxTileZoom` until the first tick picks one; 0 with no overlay). */
  tileZoom: number;
  /** Total number of Gaussian splats across those tiles. */
  splats: number;
  /** Of `tiles` / `splats`, the resident COVER-level tiles and their splats (see `cover`). */
  coverTiles?: number;
  coverSplats?: number;
  /** Resident-splat budget in effect (`maxSplats`, or `lowTierMaxSplats` on
   *  the `'low'` / `'mobile'` tiers). */
  maxSplats: number;
  /** Reveal animation in progress: `'in'`, `'out'`, or `'none'`. */
  reveal: 'in' | 'out' | 'none';
  /** Whether the vector basemap layers are currently hidden GLOBALLY by the
   *  overlay (`hideBasemap: true`). */
  basemapHidden: boolean;
  /** Whether the overlay is currently cutting the basemap out under its
   *  landed tiles (`hideBasemap: 'covered'` with ≥ 1 tile resident). */
  basemapCovered: boolean;
  /** Frame-time governor: smoothed moving-frame time, target, the budget
   *  scale and `lodBias` reduction in effect (`maxSplats` and `tileZoom`
   *  above already include them). */
  governor: GovernorState;
}
