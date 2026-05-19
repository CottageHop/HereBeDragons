<img width="1408" height="768" alt="HereBeDragons_github_header" src="https://github.com/user-attachments/assets/bef38dbb-cb00-4f38-8521-c7c05e87fe32" />

A 3D vector map for the web. Stylized buildings, animated water, drifting volumetric clouds, raymarched lighting. Reads PMTiles vector archives, renders with three.js. Drops into a single `<div>` with one function call.

**[Live demo →](https://cottagehop.github.io/HereBeDragons/)** &nbsp;·&nbsp; [with Studio](https://cottagehop.github.io/HereBeDragons/?studio=1) &nbsp;·&nbsp; [with demo polygons](https://cottagehop.github.io/HereBeDragons/?polygons=1)

```
npm install @cottagehop/here-be-dragons three
```

`three` is a peer dependency install it explicitly so your bundler dedupes it with anything else that uses three.

---

## 30-second quickstart

```html
<!doctype html>
<html>
  <body>
    <div id="app" style="position: fixed; inset: 0;"></div>
    <script type="module">
      import { createHereBeDragons } from '@cottagehop/here-be-dragons';

      const map = await createHereBeDragons(document.getElementById('app'), {
        center: { lat: 40.7065, lon: -74.009 },
        zoom: 15,
        pmtiles_url: 'https://your-tiles.example.com/tiles.pmtiles'
      });
    </script>
  </body>
</html>
```

That's it. You get a 3D map with stylized buildings, roads, water, and labels. The map sizes to fill its container give that container a width and height (the `position: fixed; inset: 0;` snippet above is the simplest "fill the page" recipe).

---

## Use it without writing code (Studio → JSON → embed)

The fastest workflow:

1. Open the demo with `?studio=1` (or call `createMapStudio(map, ...)` in your code).
2. Pick a theme, drag the camera sliders, tweak colors, toggle layers everything is live.
3. Click **Export JSON**. The browser downloads `here-be-dragons.config.json`.
4. On your real site, fetch that JSON and pass it straight to `createHereBeDragons`:

```js
import { createHereBeDragons } from '@cottagehop/here-be-dragons';

const config = await fetch('/map-config.json').then((r) => r.json());
await createHereBeDragons(document.getElementById('app'), config);
```

The exported JSON is a literal `HereBeDragonsOptions` value `theme`, `customColors`, `clouds`, `compass`, layer toggles, camera position, all of it. `createHereBeDragons` applies the declarative fields automatically. **No imperative `applyTheme` / `setCloudsOpacity` / etc. calls are needed.**

---

## Options reference (`HereBeDragonsOptions`)

| Field | Type | Default | Description |
|---|---|---|---|
| `center` | `{ lat, lon }` | required | Initial geographic center. |
| `zoom` | `number` | required | Initial zoom (sane range 4–20). |
| `pmtiles_url` | `string` | required | PMTiles archive URL (or local path). |
| `tilt` | `number` | `55` | Camera pitch in degrees (0 = top-down). |
| `bearing` | `number` | `0` | Camera rotation from north, +CW. |
| `theme` | `ThemeName \| string` | `undefined` | Apply a named theme on load. Autocompletes the built-ins. |
| `customColors` | `Partial<ThemeColors>` | `undefined` | Per-color overrides on top of the theme. |
| `clouds` | `boolean \| { enabled?, opacity? }` | `true` | Volumetric cloud pass settings. |
| `compass` | `boolean` | `true` | Show the compass overlay. Click to reset bearing. |
| `layers` | `Partial<Record<LayerName, boolean>>` | most on | Per-layer enable/disable. See [Layers](#layers). |
| `tags` | `TagsConfig` | `{}` | Tag overlay configuration (clustering, default styles). |
| `buildings` | `BuildingPopupConfig` | `{}` | Building picker + popup settings. |
| `bounds` | `BoundingBox` | `undefined` | Geographic box that clamps camera panning. Use `COMMON_BOUNDS` for presets. |
| `tiltRange` | `{ min, max }` | `0–75°` | Clamp the allowed tilt range. Initial value still comes from `tilt`. |
| `bearingRange` | `{ min, max }` | full 360° | Clamp the allowed bearing range. Initial value still comes from `bearing`. |
| `zoomRange` | `{ min, max }` | `~4–22` | Clamp the allowed zoom range. Initial value still comes from `zoom`. |
| `useUserLocation` | `boolean` | `false` | Request `navigator.geolocation` and fly there on resolve. |
| `quality` | `'low' \| 'high' \| 'auto'` | `'auto'` | Render-quality tier. `'auto'` detects the GPU and downgrades integrated graphics to `'low'`. See [Performance](#performance-tuning). |
| `pixelRatio` | `number` | quality-capped `devicePixelRatio` | Override render resolution. Always wins over the `quality` tier's cap. |
| `background` | `string` | theme sky | Canvas background color. |
| `performance` | `{ workerPoolSize?, visibleRadius?, tileWindowRadius?, tileWindowRadiusFar?, maxTileApplyMsPerFrame? }` | auto | Tile-pipeline tuning. See [Performance](#performance-tuning). |

### Layers

`LayerName` values: `'buildings'`, `'roads'`, `'rails'`, `'water'`, `'waterways'`, `'landuse'`, `'labels'`, `'cars'`. Each defaults to enabled (except `'cars'`, which is opt-in).

```js
layers: {
  buildings: true,
  roads: true,
  rails: false,        // hide subway lines
  cars: true,          // opt into animated traffic
}
```

### Themes

Built-in `ThemeName` values: `'cottagecore'`, `'cottagecoredark'`, `'modern'`, `'greyscale'`, `'dark'`, `'cyberpunk'`, `'eighties'`, `'seventies'`, `'oldworld'`, `'middleearth'`, `'concretejungle'`, `'comic'`.

```js
import { createHereBeDragons, THEMES } from '@cottagehop/here-be-dragons';

// As an option:
await createHereBeDragons(el, {
  center, zoom, pmtiles_url,
  theme: 'concretejungle',
  customColors: { building: '#222', water: '#0a2030' }
});

// At runtime:
map.applyTheme('comic');
map.setCustomColors({ road: '#000' });

// Register your own theme:
THEMES.myCustom = { land: '#fff', building: '#333', park: '#7cc', water: '#08f', road: '#222' };
map.applyTheme('myCustom');
```

A `ThemeColors` object has five required keys (`land`, `building`, `park`, `water`, `road`) plus optional `beach`, `sky`, `highlight`, `outline`, `saturation`.

---

## Instance API (`HereBeDragons`)

### View

```ts
map.setView(lat, lon, zoom?)
map.setBearing(deg)
map.setTilt(deg)
map.getView()                   // { lat, lon, zoom, tilt, bearing }
await map.flyTo({ lat, lon, zoom?, tilt?, bearing?, durationMs? })
await map.resetView(durationMs?)

// Clamp how far the user can drag past the initial value.
// Pass null to release a clamp.
map.setTiltRange({ min: 20, max: 50 })
map.setBearingRange({ min: -45, max: 45 })
map.setZoomRange({ min: 12, max: 18 })
```

### Layers + appearance

```ts
map.setLayerEnabled('roads', false)
map.getLayerEnabled('cars')
map.applyTheme('concretejungle')
map.setCustomColors({ water: '#1a3a4a' })
map.getCurrentTheme()
map.getCustomColors()
map.setBuildingsFlat(true)      // collapse extrusions to footprints
map.setCloudsEnabled(false)
map.setCloudsOpacity(0.6)
```

### Tags (interactive markers)

```ts
const tag = map.addTag({
  id: 'home',
  lat: 40.7065, lon: -74.009,
  icon: '🏠',
  text: '$1.2M',
  badge: '3 BR',
  color: '#10b981',
  modal: { title: 'Trinity Church Condo', body: '<p>South-facing 3 BR…</p>' },
  onClick: (handle, evt) => { console.log('clicked', handle.id); }
});

tag.setText('$1.4M');
tag.setColor('#f59e0b');
tag.open();         // open the modal programmatically
tag.close();
tag.remove();

map.removeTag('home');
map.clearTags();
```

Tags within `mergeDistancePx` of each other automatically collapse into a count cluster; clicking the cluster zooms toward its centroid.

### Polygons (custom filled regions)

```ts
const poly = map.addPolygon({
  id: 'demo-zone',
  color: '#22c55e',
  opacity: 0.4,
  points: [
    { lat: 40.7070, lon: -74.0120 },
    { lat: 40.7080, lon: -74.0080 },
    { lat: 40.7060, lon: -74.0060 }
  ]
});
map.removePolygon('demo-zone');
```

### Buildings

```ts
map.onBuildingClick((info) => {
  console.log(info.id, info.height, info.properties);
});
const info = map.selectBuilding('osm:way/12345', /*floor*/ 12);
map.clearBuildingSelection();
map.setBuildingPopup({ popupEnabled: false });   // disable the auto popup
map.setBuildingHighlightColors('#ffe600', '#7ec8ff');
const all = map.getLoadedBuildings();            // BuildingInfo[]
```

### Events

```ts
const off = map.on('ready', () => console.log('first tile request queued'));
map.on('tileload', (e) => console.log('tile', e.z, e.x, e.y));
map.on('tileerror', (e) => console.warn(e.error));
map.on('viewchange', (v) => console.log(v.lat, v.lon, v.zoom));
off();          // unsubscribe
```

### Lifecycle

```ts
map.resize();          // call from your window.resize handler
map.destroy();         // releases GPU resources + DOM
```

---

## The Studio (`createMapStudio`)

The Studio is an in-browser control panel for designing a map without writing code. It edits a live `HereBeDragons` and exports its state as a JSON config.

```js
import { createHereBeDragons, createMapStudio } from '@cottagehop/here-be-dragons';

const initialConfig = {
  center: { lat: 40.7065, lon: -74.009 },
  zoom: 15,
  pmtiles_url: '/tiles.pmtiles'
};

const map = await createHereBeDragons(document.getElementById('app'), initialConfig);

createMapStudio(map, {
  initialConfig,                  // round-trips pmtiles_url / pixelRatio / etc.
  onExport: (cfg) => {
    // Optional: intercept the export. Return `false` to suppress the default
    // file download (e.g. POST the config to your backend instead).
    console.log('exported', cfg);
  }
});
```

### What the Studio panel exposes

- **Theme picker** visual grid of every registered theme (filterable via the `themes: [...]` option)
- **Custom colors** `land`, `building`, `park`, `water`, `road` color pickers (applied on top of the active theme)
- **Selection highlight** popup toggle + building/floor color pickers
- **Camera** tilt, bearing, zoom sliders, kept in sync as the user drags on the canvas. Each slider has a `↔` toggle that opens a **Min / Max** sub-editor: turn it on to limit how far the camera can move on that axis. The exported JSON includes `tiltRange` / `bearingRange` / `zoomRange` only for axes whose toggle is active.
- **Layers** per-layer checkboxes + a "flatten buildings" toggle
- **Clouds** enable/disable + opacity slider
- **Compass** show/hide overlay toggle
- **Export JSON** button downloads `here-be-dragons.config.json`

### `StudioOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `container` | `HTMLElement` | `document.body` | Mount point. |
| `open` | `boolean` | `true` | Initial expanded state. |
| `injectDefaultStyles` | `boolean` | `true` | Inject the panel's CSS into `<head>`. |
| `themes` | `string[]` | all registered | Subset of theme names to show. `[]` hides the section. |
| `compass` | `boolean` | inherit | Force the compass overlay on / off at construction. |
| `initialConfig` | `Partial<HereBeDragonsOptions>` | `{}` | Source of non-queryable fields (`pmtiles_url`, `pixelRatio`, `background`). |
| `onExport` | `(cfg) => boolean \| void` | `undefined` | Intercept the export. Return `false` to suppress the default download. |

### Studio handle

```ts
const studio = createMapStudio(map, { initialConfig });

studio.getConfig();    // read current config without exporting
studio.export();       // trigger the export flow programmatically
studio.setOpen(false); // collapse the panel
studio.destroy();      // remove DOM + listeners
```

### Adding a control that isn't there

The Studio's section list is currently hard-coded. To add a control not in the panel today, mount your own DOM next to the studio panel and call the map's API directly:

```js
const studio = createMapStudio(map, { initialConfig });

// Mount custom controls in your own panel.
const myPanel = document.createElement('div');
myPanel.innerHTML = `
  <label>Time of day
    <input id="tod" type="range" min="0" max="24" step="0.1" value="12" />
  </label>
`;
document.body.appendChild(myPanel);

document.getElementById('tod').addEventListener('input', (e) => {
  const hour = Number(e.target.value);
  // example: rotate the sun by tying it to bearing for a quick visual sweep
  map.setBearing((hour / 24) * 360 - 180);
});
```

If you need a control to round-trip through the exported JSON, write it into the JSON yourself after `studio.export()` returned its config or open an issue describing the use case and we'll add a first-class API.

---

## Config round-trip (the recommended workflow)

```js
// 1. Design the map in Studio. Click "Export JSON". You get something like:
{
  "center": { "lat": 40.7065, "lon": -74.009 },
  "zoom": 15.4,
  "tilt": 55,
  "bearing": 0,
  "pmtiles_url": "/tiles.pmtiles",
  "theme": "concretejungle",
  "customColors": { "water": "#0a2030" },
  "clouds": { "enabled": true, "opacity": 0.7 },
  "compass": true,
  "layers": { "water": true, "buildings": true, "rails": false, "cars": false }
}

// 2. Save that file alongside your site assets (e.g. /public/map-config.json).

// 3. Load it in a single fetch + createHereBeDragons call:
const cfg = await fetch('/map-config.json').then((r) => r.json());
const map = await createHereBeDragons(document.getElementById('app'), cfg);
```

The map renders identically to what you designed in Studio. No imperative setup. No `applyTheme` / `setCloudsOpacity` / `setLayerEnabled` calls.

---

## Performance tuning

### How tile decoding works

Every tile in the visible window goes through this pipeline:

1. **Fetch** PMTiles range-request returns the raw MVT bytes. Async, non-blocking.
2. **Worker decode** handed to one of the worker threads (round-robin). Inside the worker, decoding runs in **two phases**:
   - **Phase 1 (base)** water, waterways, landuse, roads, rails, labels. Cheap to extract (~5–15 ms). Posted back immediately.
   - **Phase 2 (buildings)** the heavy one. The union-find that groups multi-part buildings is O(n²) over features in the tile, so a dense Manhattan-scale tile spends 50–200 ms here. Posted back when it finishes.
3. **Scene update** the main thread builds three.js meshes from each phase's geometry and adds them to the tile's group as soon as they arrive. The base map appears within milliseconds; buildings fill in afterward.

The two-phase split means **users see streets, water, and labels almost instantly** even while building decoding is still grinding. Disabling the `buildings` layer entirely skips phase 2 in the worker.

### Default tile load (at z=15)

The dispatcher is **frustum-aware**: each frame, the camera's four screen corners are raycast onto the ground plane to compute a tile-coordinate bbox of what's actually visible. Only tiles inside that bbox (plus a 1-tile margin) get loaded. With a 55° camera tilt, the visible region is a trapezoid mostly in front of the camera target typically 20–40 tiles at z=15, not the symmetric square the older Chebyshev approach loaded.

| Knob | Default | Result |
|---|---|---|
| `visibleRadius` | `3` | tier-0 priority radius around camera target |
| `tileWindowRadius` / `tileWindowRadiusFar` | `6` / `6` | safety cap on tile count when the camera looks near horizon (radius from target) |
| `workerPoolSize` | `min(4, hardwareConcurrency − 1)` | 3–4 worker threads |
| `maxTileApplyMsPerFrame` | `3` | per-frame ms budget for applying decoded tiles to the scene |
| `dispatchInterval` | `4` | heavy visibility/dispatch pass runs every N-th RAF tick (≈ 15 Hz at 60 FPS) |

Two-tier within the bbox:

- **Tier 0** within `visibleRadius` of the camera target. These dispatch first.
- **Tier 1** the rest of the frustum bbox (with margin). Dispatched after tier 0.

The candidate set is the camera frustum's actual ground footprint a convex **trapezoid**, not its bounding box. Every candidate tile is point-in-quad tested against that trapezoid (inflated by a 1-tile margin for smooth panning), so the big off-screen triangles at the near-edge corners of the bounding rectangle never get loaded.

Within each tier the order is a **concentric ring expansion from the camera target** (the screen center) closest squared-Euclidean distance first. Same-ring tiles tiebreak right-before-left so the fan stays visually symmetric.

Tile builds are bounded by a per-frame ms budget (`maxTileApplyMsPerFrame`) so a burst of worker completions can't block pointer/wheel input. The drain loop applies tiles closest to the camera first and yields once the budget is spent (always applying at least one tile per frame so the queue can drain even when a single build exceeds the budget). The heavy "what's visible now?" recompute runs only every `dispatchInterval` frames (default 4 → ~15 Hz at 60 FPS), also borrowed from PolyMap tile fetches are network-bound and decodes take 50–200 ms in workers, so polling visibility at 60 Hz was wasted main-thread work that competed with input and rendering. **You can pan and zoom during the initial load.** As you pan, the frustum bbox shifts and new tiles are dispatched at the new viewport; tiles outside the new bbox stay in the LRU cache for a short grace period.

### Tuning options

Pass a `performance` object to `createHereBeDragons`:

```js
await createHereBeDragons(el, {
  center, zoom, pmtiles_url,
  performance: {
    visibleRadius: 3,             // smaller "in viewport" set (49 tiles)
    tileWindowRadius: 6,          // shrink the pre-loaded buffer (~169 tiles)
    tileWindowRadiusFar: 8,
    workerPoolSize: 2,
    maxTileApplyMsPerFrame: 3     // tighter budget = smoother input under load
  }
});
```

Concrete trade-offs (frustum-aware loading; "tiles loaded" is the typical count after the frustum-bbox intersection with the radius cap):

| Profile | `visible` / `window` / `far` | Typical tiles loaded | Behavior |
|---|---|---|---|
| Default | 3 / 6 / 6 | ~25–40 (frustum-clipped) | Tight viewport-only, snappy load, pop-in only on very fast pans |
| Buffered | 4 / 8 / 10 | ~60–120 | Wider buffer, smoother fast-pan, slower first paint |
| Mobile | 2 / 4 / 4 | ~12–25 | Strictest, fastest load, visible pop-in |
| Pre-cached | 5 / 12 / 14 | ~200–400 | Big buffer, almost no pop-in, slower initial load |

Other levers built into the library:

- **Disable layers you don't need** `layers: { rails: false, cars: false, labels: false }`. Disabled layers are now skipped at the worker level entirely (no decode cost), not just hidden post-render.
- **Disable buildings if you only need the base map** the heaviest single extractor. `layers: { buildings: false }`. Frees ~70% of worker CPU per tile.
- **Disable clouds** `clouds: false`. Saves a full-screen raymarch pass every frame.

### Quality tiers

On lower-end GPUs / integrated graphics / mobile, the per-frame rendering cost can dominate independent of tile loading. The map runs a multi-pass pipeline (color, normal-for-outlines, outline, clouds, FXAA) at the canvas's native pixel ratio, so a 2× Retina display means ~4× the pixel work of a 1× display.

The `quality` option handles this for you:

```js
await createHereBeDragons(el, {
  center, zoom, pmtiles_url,
  quality: 'auto'   // the default detects the GPU and downgrades if needed
});
```

- **`'auto'`** (default) probes the GPU via `WEBGL_debug_renderer_info`. Intel integrated graphics (e.g. the Iris Plus in a 2019 MacBook Pro 13"), software rasterizers, and "no WebGL" all resolve to `'low'`; discrete GPUs, Apple Silicon, and privacy-redacted renderers stay `'high'`. It only ever *downgrades* on a confident match, so a capable machine is never blurred by mistake.
- **`'low'`** `pixelRatio` capped to 1 (no Retina super-sampling the single biggest fill-rate win, ~4× fewer pixels), MSAA off (FXAA alone handles AA), and a tighter tile-load window (`visibleRadius` 2, `tileWindowRadius`/`Far` 4, `dispatchInterval` 6).
- **`'high'`** full desktop quality: `pixelRatio` up to 2, 4× MSAA, default tile window.

An explicit `pixelRatio` or any `performance.*` field always overrides what the tier would have set so you can force `quality: 'low'` but keep `pixelRatio: 1.5`, or stay on `'high'` but tighten the tile window.

If you want to go further than `'low'`, the individual knobs are still there:

```js
await createHereBeDragons(el, {
  center, zoom, pmtiles_url,
  quality: 'low',
  clouds: false,                  // skip the cloud raymarch pass
  layers: {
    rails: false,                 // skip ribbon + crosstie geometry
    labels: false,                // skip the sprite-text overlay
  },
  performance: { maxTileApplyMsPerFrame: 3, workerPoolSize: 2 }
});
```

## Hosting your tiles

`pmtiles_url` accepts any URL the browser can fetch absolute, relative, or `https://`. The library uses range requests, so your server must support `Range:` headers (S3, CloudFront, GCS, plain Apache/nginx all do).

For local development, drop a `.pmtiles` archive into your `public/` directory and reference it as `'/tiles.pmtiles'`. Build it from OpenStreetMap with [Planetiler](https://github.com/onthegomap/planetiler) or grab one from [Protomaps](https://protomaps.com/).

---

## Bundling notes

The decode worker is bundled automatically when you use Vite, Rollup, esbuild, or Webpack 5 `import.meta.url` resolution handles the worker file location for you. If you're on an older bundler that doesn't, file an issue with the bundler name.

The library injects its own CSS for tags, compass, building popup, and Studio. If you want to preload styles to avoid a flash, import them explicitly:

```js
import '@cottagehop/here-be-dragons/styles.css';   // (planned currently auto-injected)
```

---

## TypeScript

Everything is typed. The big ones to know:

```ts
import type {
  HereBeDragons,
  HereBeDragonsOptions,
  ThemeName,
  ThemeColors,
  LayerName,
  TagOptions,
  TagHandle,
  PolygonOptions,
  BuildingInfo,
  StudioConfig
} from '@cottagehop/here-be-dragons';
```

`ThemeName` autocompletes the built-in themes but accepts any string at runtime so you can register custom themes.

---

## Reference: full feature list

- **3D vector tile rendering** PMTiles + MVT, decoded in a Web Worker
- **Stylized shading** with multi-pass outline pass (depth + normals)
- **Volumetric raymarched clouds** that drift over the city
- **Animated traffic** along the road network (opt-in `layers: { cars: true }`)
- **Rail tracks** with crossties, drawn under the road layer (for "subway under street" effect)
- **Waterways** rivers/canals as continuous channels
- **Interactive building selection** click to highlight, optional floor band, blueprint mode
- **Tag overlay** with automatic clustering at distance
- **Custom polygons** with translucent fills
- **12 built-in themes** + custom theme support
- **Studio** for live editing + JSON export
- **Compass overlay** + camera flyTo + bounded panning
- **Optional Geolocation** integration

---

## License

See [LICENSE](LICENSE).
