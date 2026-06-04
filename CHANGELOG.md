# Changelog

All notable changes to `@cottagehop/here-be-dragons`.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.8.0 — mobile quality tier + GPU-memory wins

### Added

- **`quality: 'mobile'` tier + auto-detection** — the most capable map a phone-class GPU (e.g. an iPhone 8, A11 / PowerVR GT7600, 2 GB shared RAM) can sustain. It keeps the full real-estate feature set — extruded 3D buildings, labels, tags/markers + clustering, the parcels overlay, comp-radius polygons, and tap-select + hover popups — and drops only the cinematic dressing a phone can't afford: the volumetric clouds, the sketch-outline pipeline, and the ambient decoration layers (trees, grass, shoreline waves, shop signs, traffic cars, drifting spores, painterly surface wash), forced off regardless of theme. It caps `pixelRatio` to 1.5, disables the z11 low-res underlay (saves 10–30 MB of GPU memory on a device with a tight WebGL budget), tightens the resident tile window, and caps tilt at 60°. Under `quality: 'auto'` (the default) phones and tablets are detected at construction — by platform, since iOS Safari redacts the GPU string — and start on `'mobile'` so a 2 GB device never spikes through the full retina chain and loses its WebGL context. A phone too weak even for this auto-downgrades to `'low'`. Exposed as an explicit `quality: 'mobile'` for forcing, and `getQualityTier()` / `setQualityTier()` now report and accept it.
- **Studio: `Mobile` quality tier control + `quality` round-trip.** The Studio's Quality section gains a third `Mobile` tier button alongside `Low` / `High`, and switching tiers now resyncs the whole panel (the mobile/low tiers flip ambient-FX and building toggles that other controls mirror). The chosen tier is written into the exported JSON `quality` field so a config round-trips its render tier; an untouched `'auto'` map deliberately omits `quality` so a phone re-detects to `'mobile'` on reload instead of inheriting a baked-in desktop tier. `setConfig()` now also accepts `quality: 'mobile'` on import.
- **Docs: completed the options reference.** The README's options table now documents every `HereBeDragonsOptions` field (previously `msaa`, `dynamicResolution`, `parcels`, `scaleBar`, `fog`, `labelHeight`, `tileSpawnDurationMs`, and `lowResUnderlay` were undocumented), grouped into Required / Camera / Theme / Atmosphere / Overlays / Performance sections, and corrects the theme list (15 themes, incl. `greyscaledark`) and a broken anchor link.

### Performance

- **Lazy-allocated the outline + cloud render targets.** The normal target, outline target, and half-res cloud target are now materialized on first use instead of eagerly in the constructor. The sketch-outline pipeline and volumetric clouds are off on every default quality tier, so most maps never needed these full-resolution HalfFloat targets at all — eager allocation was burning roughly 130 MB of GPU memory at 4K × DPR 2 (and ~10 MB on a phone) for buffers that never got drawn into. They allocate (and resize) on demand exactly like the existing noise target; no change to the rendered image. This is the single biggest memory win for the new mobile tier, and it benefits the desktop `'high'` tier just as much.
- **Dropped MSAA on the default framebuffer.** The renderer is a multi-pass pipeline — all 3D geometry is drawn into offscreen render targets and the canvas only ever receives the final full-screen FXAA blit, which has no internal primitive edges for MSAA to anti-alias. The WebGL context now requests `antialias: false`, removing a multisampled backbuffer allocation and an MSAA resolve on every presented frame. Scene anti-aliasing is unchanged (handled by FXAA and the offscreen targets' own samples), so the rendered image is pixel-identical. An explicit `antialias` option still overrides.
- **Removed redundant per-pass framebuffer clears.** `WebGLRenderer.autoClear` is now off; the Composer already issues an explicit `clear()` for every pass that needs one, so the default auto-clear was clearing each target a second time (plus a wholly redundant canvas clear before the fullscreen blit). This trims one full-target clear per pass across the whole chain. Visual-neutral.

## 0.7.0 — studio toggles + config round-trip

### Added

- **Grass and Waves Studio toggles** — the **Layers** section now exposes `grass` (wind-blown meadow tufts) and `waves` (animated shoreline foam) as on/off checkboxes. Both are off by default; flipping one on re-decodes the visible tiles to build its geometry, then round-trips through the exported JSON `layers` map like every other layer.

### Fixed

- **Config export was lossy** — `fog`, `labelHeight`, and `tileSpawnDurationMs` were applied on `setConfig` (import) but never written by `getConfig` (export), so they silently reset to defaults on an export → import round-trip. They are now exported, making the Studio JSON a faithful, complete snapshot of the live map.

### Changed

- **Street labels are far more legible** — road-name labels (painted flat on the ground plane) now bake at higher resolution, render with max anisotropic filtering, and carry a bolder near-black fill with a thicker warm-white halo, so they read against dark roads at the zoom levels where they first appear.

### Notes

- `quality` is still intentionally **not** exported: `getQualityTier()` returns the resolved tier, and pinning it into a config would disable per-device auto-downgrade for anyone importing it. `setConfig` still honors an explicit `quality` in hand-authored configs.

## 0.6.1 — ship-to-clients

### Added

- **`professional` theme** — clean, neutral palette tuned for client-facing real-estate maps: soft grey buildings, calm blue water, restrained outlines, a strong professional-blue building/floor highlight (`#2563eb`) for picking out listings and comps. Every Ghibli FX field is deliberately omitted so `applyMergedPalette` resets them to off.
- **`REAL_ESTATE_TAG_PRESETS`** — seven frozen, opinionated tag styling defaults (`forSale`, `pending`, `sold`, `newListing`, `openHouse`, `comp`, `subject`) covering the standard listing states. Spread into `map.addTag` for a polished one-liner marker. Exported types: `RealEstateMarker`, `RealEstateTagPreset`.
- **`makeRadiusPolygon(lat, lon, radiusMeters, segments?)`** — geodesic-circle helper for comp radii, walkability buffers, service areas. Sub-metre accurate at city scale (spherical destination-point formula, verified by haversine round-trip in tests). Wraps the antimeridian, clamps `segments` to ≥ 3.
- **Public perf-metrics API**: `getFps()` and `getFrameMs()` so consumers can wire their own perf HUDs without depending on the demo. Joins the existing `getQualityTier`, `getPixelRatio`, `getDynamicResolution`.
- **Demo `?investor=1` flag** — wires the seeded listings to `REAL_ESTATE_TAG_PRESETS` and draws a `makeRadiusPolygon`-based comp-radius around the subject property. Combined with `?theme=professional`, one URL showcases the clean theme + tag presets + radius helper to a prospective client.
- **Hover-cursor on buildings**. The canvas cursor swaps from `grab` to `pointer` the moment a user hovers a building, signalling clickability — the property-shopping UX clients reach for. The raycast is RAF-throttled inside BuildingsManager so a fast-moving pointer can't burn dozens of raycasts per second, and it's idempotent (only touches the cursor when the hovered state actually flips) so it doesn't step on the drag `grabbing` cursor.
- **Hover building highlight**. Pairs with the cursor swap: the actually-hovered building gets a subtle warm brighten (per-fragment, gated by a new `uHoveredBuildingIndex` uniform driven by `BuildingsLayer.onBeforeRender` — same per-mesh-push pattern the click selection uses). The pointer raycast now resolves the hit triangle to its `buildingIndex` and only triggers a redraw when the hovered (mesh, index) pair actually changes, so a pointer drifting across a single building costs nothing.
- **Scale-bar overlay**. A small `100 ft / 50 m` ribbon pinned bottom-right of the map. Investors think in distances ("are these comps within walking distance?"), and every print real-estate map has one. Click to toggle units. Defaults to imperial (the primary audience is US real-estate); pass `scaleBar: { units: 'metric' }` for international maps, or `scaleBar: false` to suppress. Picked from a fixed round-number progression (1/2/5/10/25/50/100/250/500/1000 ft, then miles) so the label is always the kind of number a human reads on a printed plan. Recomputes on `viewchange` (not RAF) so an idle bar costs zero. Paired with a public `getMetersPerPixel()` on the map so consumers can wire their own distance overlays.
- **Public `getMetersPerPixel()`**. Ground meters per CSS pixel at the camera's current lat + zoom (Web Mercator scale). Powers the scale-bar internally; exposed so consumer apps can drive their own measurement UIs without duplicating projection logic.
- **`snapshot()` API**. Capture the current map view as a data URL — synchronous, no extra render-target plumbing. The trick: render and read the canvas in the same JS tick (no awaits between), which preserves the framebuffer even with the default `preserveDrawingBuffer: false` (which is much faster for the normal render loop). Pass `{ pixelRatio: 2 }` for HiDPI print/PDF exports; the override is temporary, the live render loop is undisturbed. PNG by default, JPEG / WebP supported with `mimeType` + `quality`.

### Performance / resilience

- **WebGL context-loss survival**. The canvas now `preventDefault`s `webglcontextlost` so three's `WebGLRenderer` can re-upload its textures, programs, and buffers on the matching `webglcontextrestored` event. The map nudges `needsRender` via a new `onContextRestored` callback so the next RAF repaints. Without this, a long tab background or GPU driver reset permanently killed the canvas.
- **Idle-tab pause**. The render loop drops itself entirely when `document.hidden` (zero CPU/GPU in a backgrounded tab) and re-kicks on `visibilitychange` with a fresh tick closure so the first resumed dt isn't a giant jump that snaps the camera damping. Cleanly unregistered in `destroy()`.
- **Bundle size baseline tracked** across each slice (see PR diffs). Total v0.6.0 cost: **+17.07 kB raw / +4.83 kB gzip** over v0.5.0 (711.58 → 728.65 kB raw; 183.21 → 188.04 kB gzip) for the entire client-ship set.

### Documentation

- README `Themes` section calls out `ghibli` and `professional` as the two preset spotlights.
- New README subsections under `Tags` and `Polygons` for the real-estate presets and comp-radius helper.
- Lifecycle section documents WebGL context-loss survival + idle-tab pause as client-shipping features.

## 0.5.0

- Optional parcels overlay layer (second PMTiles source).
- Pitched Ghibli rooflines + chimneys + full painterly FX configurable + Map Studio coverage for every Ghibli feature (see git history).

## 0.4.0

- See git history.

## 0.3.0

- See git history.
