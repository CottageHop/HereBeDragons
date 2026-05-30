# Changelog

All notable changes to `@cottagehop/here-be-dragons`.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased — v0.6.0 ship-to-clients

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
