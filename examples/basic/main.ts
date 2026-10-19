import {
  createHereBeDragons,
  createMapStudio,
  THEMES,
  THEME_NAMES,
  REAL_ESTATE_TAG_PRESETS,
  makeRadiusPolygon
} from '../../src/index.js';

const container = document.getElementById('app');
if (!container) throw new Error('#app not found');

// Served by Vite from public/tiles.pmtiles. Override with ?pmtiles=URL for
// a remote source. BASE_URL ensures the path works under GitHub Pages where
// the site is mounted at /HereBeDragons/.
const url = new URL(window.location.href);
const pmtilesUrl =
  url.searchParams.get('pmtiles') ?? `${import.meta.env.BASE_URL}tiles.pmtiles`;

// Default: Lower Manhattan — matches PolyMap's tiles.pmtiles coverage.
const lat = Number(url.searchParams.get('lat') ?? '40.7065');
const lon = Number(url.searchParams.get('lon') ?? '-74.009');
const zoom = Number(url.searchParams.get('zoom') ?? '15');
const initialTheme = url.searchParams.get('theme') ?? 'concretejungle';
// `?quality=low|high` forces the render-quality tier; otherwise auto-detect
// (downgrades to 'low' on Intel integrated graphics + software rasterizers).
// Use this to A/B-test what tier the slow machine is actually getting.
const qualityParam = url.searchParams.get('quality');
const quality: 'low' | 'high' | undefined =
  qualityParam === 'low' || qualityParam === 'high' ? qualityParam : undefined;
// `?pixelRatio=N` overrides the tier's DPR cap (fractional OK, e.g. 1.5). The
// renderer is render-on-demand, so the cost of Retina rendering is only paid
// while the camera moves or tiles stream — scroll the map at different values
// and watch the HUD's "worst ms" to feel the fill-rate cost of the DPR lever.
const pixelRatioParam = url.searchParams.get('pixelRatio');
const pixelRatio =
  pixelRatioParam != null && Number.isFinite(Number(pixelRatioParam))
    ? Number(pixelRatioParam)
    : undefined;
// `?dynamicResolution=0` disables the motion downscale so you can A/B it
// against the default (on). Watch the HUD's px readout drop while you drag and
// snap back crisp when you stop. (No effect alongside an explicit pixelRatio.)
const dynResParam = url.searchParams.get('dynamicResolution');
const dynamicResolution =
  dynResParam == null ? undefined : dynResParam !== '0' && dynResParam !== 'false';
// `?msaa=0|2|4` overrides the tier's MSAA sample count (fixed at construction).
// Lets you isolate MSAA's per-frame cost when A/B-testing pan smoothness.
const msaaParam = url.searchParams.get('msaa');
const msaa =
  msaaParam != null && Number.isFinite(Number(msaaParam)) ? Number(msaaParam) : undefined;

// `?splats=<urlTemplate>` streams Gaussian-splat tiles (`{z}/{x}/{y}.spz`,
// imagery from the same template as `.png`) over the basemap — e.g.
// `?splats=http://localhost:8790/{z}/{x}/{y}.spz&pmtiles=…&lat=35.10&lon=-80.80&zoom=16`.
// By default the vector map is cut out only under satellite tiles that have
// landed (`hideBasemap: 'covered'`); `&hideBasemap=1` hides the basemap layers
// globally instead (the old behaviour) and `&hideBasemap=0` keeps them visible
// under the splats (handy for checking that the houses sit on their
// footprints). `&keepLabels=0` cuts the labels out too, `&governor=0` turns
// the frame-time governor off, `&targetFrameMs=` moves its target and
// `&budgetGrowth=2` lets it grow the budget past `maxSplats`, not only cut. `&tilt=0`
// looks straight down. The ripple clock is exposed on `window.__splatsSetTime(ms)`
// (`null` to resume real time) so tooling can scrub the reveal frame by frame.
// `&maxSplats=`, `&lowTierMaxSplats=` and `&radius=` override the resident
// budget / window for A/B-ing weight on a given GPU. `&roundedUnion=0` shows
// the tiles as plain squares; `&unionGrowMs=` / `&unionFeather=` tune the
// rounded-union mask, `&splatsMinZoom=` lets the overlay show further out.
// `&splatsReveal=ripple|none` sets the default transition of a plain
// `setSplatsEnabled(on)` (`splats.reveal`); with `&studio=1` it defaults to
// the ripple so the Studio's Enabled toggle shows it off. With `?studio=1`
// and NO `splats=` the Studio's "3D Satellite" section starts empty — paste a
// template there and the overlay is created at runtime.
// The overlay's tile source: `?splats=` wins; otherwise a build-time default
// (`VITE_SPLATS_TEMPLATE` in `.env.local`, e.g. a local tile server during
// development) which starts OFF and is switched on with the "3D Satellite"
// button, so the plain demo stays the plain demo. `?splatsLite=` /
// `VITE_SPLATS_LITE_TEMPLATE` name a lighter pyramid for the low quality tiers
// (`lowTierUrlTemplate`).
const envTemplate = (import.meta.env.VITE_SPLATS_TEMPLATE as string | undefined)?.trim() || null;
const splatsFromUrl = url.searchParams.get('splats');
const splatsTemplate = splatsFromUrl ?? envTemplate;
const splatsLiteTemplate =
  url.searchParams.get('splatsLite')?.trim() ||
  (import.meta.env.VITE_SPLATS_LITE_TEMPLATE as string | undefined)?.trim() ||
  undefined;
// Where the build-time tiles are: `VITE_SPLATS_REGION` = "lat,lon,zoom" or "lat,lon,zoom,<basemap>"
// (a .pmtiles file next to the page), several separated by ";" — the GitHub Pages demo ships Lower
// Manhattan and Coeur d'Alene. Pressing "3D Satellite" far from all of them opens the nearest
// with the overlay on (`?satellite=1`) instead of switching on an overlay with nothing to show.
type SplatsRegion = { lat: number; lon: number; zoom: number; basemap?: string };
const splatsRegions: SplatsRegion[] = ((): SplatsRegion[] => {
  const raw = (import.meta.env.VITE_SPLATS_REGION as string | undefined)?.trim();
  if (!raw) return [];
  return raw.split(';').flatMap((part): SplatsRegion[] => {
    const [la, lo, zo, basemap] = part.split(',').map((v) => v.trim());
    const region = { lat: Number(la), lon: Number(lo), zoom: Number(zo) };
    if (![region.lat, region.lon, region.zoom].every(Number.isFinite)) return [];
    return [basemap ? { ...region, basemap } : region];
  });
})();
// `VITE_SPLATS_BUILDING_MESHES=1`: the build-time tiles carry building meshes (`{y}.bldg`), so
// the overlay draws them (the URL's `&buildingMeshes=0|1` still decides).
const envBuildingMeshes = (import.meta.env.VITE_SPLATS_BUILDING_MESHES as string | undefined)?.trim() === '1';
const satelliteOn = url.searchParams.get('satellite') === '1';
/** Great-circle-ish distance in km — plenty for "is the view anywhere near the region". */
const kmBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  return 6371 * Math.hypot(x, (b.lat - a.lat) * rad);
};
const studioMode = url.searchParams.get('studio') === '1';
const splatsRevealParam = url.searchParams.get('splatsReveal');
const splatsReveal: 'none' | 'ripple' | undefined =
  splatsRevealParam === 'ripple' || splatsRevealParam === 'none'
    ? splatsRevealParam
    : studioMode
      ? 'ripple'
      : undefined;
const splatsClock = (): number => splatsTimeOverride ?? performance.now();
let splatsTimeOverride: number | null = null;
const numParam = (name: string): number | undefined => {
  const raw = url.searchParams.get(name);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : undefined;
};
const splats = splatsTemplate
  ? {
      urlTemplate: splatsTemplate,
      lowTierUrlTemplate: splatsLiteTemplate,
      // a configured default is an OFFER, not a decision: the button turns it on (and
      // `?satellite=1` — what the button opens when it jumps to the region — starts it on)
      ...(splatsFromUrl || satelliteOn ? {} : { enabled: false }),
      ...(url.searchParams.get('frustumCull') === '0' ? { frustumCull: false } : {}),
      splatMaxDistance: numParam('splatMaxDistance'),
      // `&levelSelection=resolution` matches the pyramid level to what the screen can show,
      // instead of keying off camera zoom (`&resolutionMargin=` tunes the oversampling).
      ...((): Record<string, unknown> => {
        const m = url.searchParams.get('levelSelection');
        const margin = Number(url.searchParams.get('resolutionMargin'));
        const ta = url.searchParams.get('resolutionTiltAware');
        return {
          ...(m === 'resolution' || m === 'bias' ? { levelSelection: m } : {}),
          ...(Number.isFinite(margin) && margin > 0 ? { resolutionMargin: margin } : {}),
          ...(ta === '0' ? { resolutionTiltAware: false } : {})
        };
      })(),
      maxSplats: numParam('maxSplats'),
      // `&maxInFlight=` caps concurrent tile fetches + decodes (default 4).
      maxInFlight: numParam('maxInFlight'),
      // `&engineLod=1` (experimental): Spark's own LoD — tiles load with an LoD tree and Spark
      // draws `&lodSplats=` splats a frame across all of them (0 / absent = Spark's default).
      ...(url.searchParams.get('engineLod') === '1' ? { engineLod: true } : {}),
      engineLodSplats: numParam('lodSplats'),
      // `&buildingMeshes=1|0` (experimental): buildings as textured meshes from `{y}.bldg` tiles
      // (default: VITE_SPLATS_BUILDING_MESHES). `&cover=0` drops the coarse cover level under the
      // detail window.
      ...(url.searchParams.get('cover') === '0' ? { cover: false } : {}),
      ...((): Record<string, unknown> => {
        const bm = url.searchParams.get('buildingMeshes');
        if (bm === '1' || (bm === null && envBuildingMeshes)) return { buildingMeshes: true };
        return bm === '0' ? { buildingMeshes: false } : {};
      })(),
      // `&sortIntervalMs=` spaces Spark's depth re-sorts (default 100; the low tiers use >= 250)
      sortIntervalMs: numParam('sortIntervalMs'),
      // `&budgetGrowth=2` lets the governor grow the budget past `maxSplats` on a device
      // that holds well under target — `maxSplats` becomes a starting point, not a ceiling.
      budgetGrowth: numParam('budgetGrowth'),
      lowTierMaxSplats: numParam('lowTierMaxSplats'),
      radius: numParam('radius'),
      minZoom: numParam('splatsMinZoom'),
      // Tile pyramid: `&minTileZoom=` / `&maxTileZoom=` bound the levels,
      // `&lodBias=-1` runs one level coarser, `&maxCameraZoom=` moves the
      // zoom-in stop.
      minTileZoom: numParam('minTileZoom'),
      maxTileZoom: numParam('maxTileZoom'),
      lodBias: numParam('lodBias'),
      maxCameraZoom: numParam('maxCameraZoom'),
      maxCameraTilt: numParam('maxCameraTilt'),
      hideBasemap:
        url.searchParams.get('hideBasemap') === '0'
          ? false
          : url.searchParams.get('hideBasemap') === '1'
            ? true
            : undefined,
      keepLabels: url.searchParams.get('keepLabels') === '0' ? false : undefined,
      // `&leanMap=0` keeps the map's outlines / clouds / tilt-shift / ambient animation
      // running while splats are on (the default switches them off — see `leanMap`).
      leanMap: url.searchParams.get('leanMap') === '0' ? false : undefined,
      // `&motionLod=1` brings back the lite twins in motion (off by default since 0.12).
      motionLod: url.searchParams.get('motionLod') === '1' ? true : url.searchParams.get('motionLod') === '0' ? false : undefined,
      governor: url.searchParams.get('governor') === '0' ? false : undefined,
      targetFrameMs: numParam('targetFrameMs'),
      // Level cross-dissolve: `&levelFadeMs=0` swaps instantly (the old
      // behaviour), `&transitionOvershoot=0` forbids the brief over-budget
      // overlap, `&prefetchBand=0` turns the prefetch across the threshold off.
      levelFadeMs: numParam('levelFadeMs'),
      transitionOvershoot: numParam('transitionOvershoot'),
      prefetchBand: numParam('prefetchBand'),
      roundedUnion:
        url.searchParams.get('roundedUnion') === '0'
          ? false
          : { growMs: numParam('unionGrowMs'), feather: numParam('unionFeather') },
      reveal: splatsReveal ? { reveal: splatsReveal } : undefined,
      clock: splatsClock
    }
  : undefined;
const tiltParam = Number(url.searchParams.get('tilt') ?? '55');
// Basemap tile reveal (rounded union of the loaded tiles): `&tileReveal=0`
// turns it off (square tiles + rise-from-below, the old behaviour);
// `&revealGrowMs=` / `&revealFeather=` tune it, `&revealRise=1` keeps the slab
// rise as well.
const tileReveal =
  url.searchParams.get('tileReveal') === '0'
    ? false
    : {
        growMs: numParam('revealGrowMs'),
        feather: numParam('revealFeather'),
        rise: url.searchParams.get('revealRise') === '1'
      };

const mapOptions = {
  center: { lat, lon },
  zoom,
  tilt: Number.isFinite(tiltParam) ? tiltParam : 55,
  splats,
  tileReveal,
  pmtiles_url: pmtilesUrl,
  layers: {
    water: true,
    waterways: true,
    landuse: true,
    roads: true,
    rails: true,
    buildings: true,
    labels: true,
    trees: true,
    grass: true,
    waves: true,
    signs: true
  }
};

// `theme` + `clouds` are now declarative on the options object — no need to
// call `applyTheme` / `setCloudsEnabled` after construction. Demonstrates the
// "exported Studio JSON drops straight in" workflow.
// `&tiltShift=1` turns on the miniature look (high tier only); tune it in the Studio.
const tiltShiftParam = url.searchParams.get('tiltShift') === '1';

const map = await createHereBeDragons(container, {
  ...mapOptions,
  ...(tiltShiftParam ? { tiltShift: true } : {}),
  theme: initialTheme,
  // Clouds are off by default (the raymarch is the heaviest per-frame GPU
  // cost). Flip to `true` — or `{ enabled: true, opacity }` — to bring back
  // the towering gold cumulus of the Ghibli sky; on the auto quality tier
  // the raymarch self-disables if the GPU can't keep up.
  clouds: false,
  quality,
  pixelRatio,
  dynamicResolution,
  msaa,
  // `&framePacing=0` submits a frame every tick even while splats are resident (A/B only);
  // `&workers=N` sizes the vector-tile worker pool (default min(4, cores − 1)).
  performance: {
    ...(url.searchParams.get('framePacing') === '0' ? { framePacing: false } : {}),
    ...(numParam('workers') ? { workerPoolSize: numParam('workers') } : {})
  }
});

// --- live HUD: FPS + active quality tier + pixelRatio --------------------
// Stop guessing whether the page is slow because of fill-rate or geometry.
// The HUD measures real frame time and shows whether auto-detect picked
// 'low' or 'high'. Frame timing uses its own RAF (cheap — just a delta).
{
  const fpsEl = document.getElementById('hud-fps');
  const tierEl = document.getElementById('hud-tier');
  if (fpsEl && tierEl) {
    const refreshTier = (): void => {
      const s = map.getSplatsStats();
      const splatsInfo = map.getSplatsOptions().urlTemplate
        ? ` · splats z${s.tileZoom} ${s.tiles - (s.coverTiles ?? 0)}t${s.coverTiles ? `+${s.coverTiles}c` : ''}/${s.splats.toLocaleString()} of ${s.maxSplats.toLocaleString()}${s.reveal !== 'none' ? ` (${s.reveal})` : ''}`
        : '';
      tierEl.textContent =
        `tier: ${map.getQualityTier()} · ${map.getPixelRatio().toFixed(2)}× px${splatsInfo}` +
        (map.getSplatsLeanMapActive() ? ' · lean' : '');
    };
    refreshTier();
    // Re-read often (150 ms) so two live signals show without wiring events:
    // the Studio Quality buttons flipping the tier, and dynamic resolution
    // dropping the px ratio mid-pan then snapping back crisp on settle.
    setInterval(refreshTier, 150);

    let lastFpsUpdate = performance.now();
    let frames = 0;
    let worstMs = 0;
    let prev = performance.now();
    const tick = (): void => {
      const now = performance.now();
      const ms = now - prev;
      prev = now;
      if (ms > worstMs) worstMs = ms;
      frames++;
      if (now - lastFpsUpdate >= 500) {
        const fps = (frames * 1000) / (now - lastFpsUpdate);
        fpsEl.textContent = `${fps.toFixed(0)} fps · worst ${worstMs.toFixed(0)} ms`;
        frames = 0;
        worstMs = 0;
        lastFpsUpdate = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

buildThemeMenu(initialTheme);
seedRealEstateTags();
seedFloorDemoTag();

// Demo polygon: a translucent green park-like fill around a few Wall St. blocks.
if (url.searchParams.get('polygons') === '1') {
  map.addPolygon({
    id: 'demo-zone',
    color: '#22c55e',
    opacity: 0.45,
    points: [
      { lat: 40.7070, lon: -74.0120 },
      { lat: 40.7080, lon: -74.0080 },
      { lat: 40.7060, lon: -74.0060 },
      { lat: 40.7045, lon: -74.0100 }
    ]
  });
}

// Studio is opt-in via ?studio=1 so the standard demo stays clean.
if (studioMode) {
  // An overlay the Studio creates from a pasted URL should still run on the
  // scrubbable demo clock (stored now; no layer exists until a URL arrives).
  if (!splats) map.setSplatsOptions({ clock: splatsClock });
  // Studio has its own theme picker — hide the corner dock to avoid duplication.
  document.querySelector<HTMLElement>('.theme-dock')?.style.setProperty('display', 'none');
  createMapStudio(map, {
    container,
    initialConfig: mapOptions,
    onExport: (cfg) => {
      console.log('[studio] export', cfg);
    }
  });
}

map.on('ready', () => console.log('[demo] ready'));
map.on('tileerror', (e) => console.warn('[demo] tileerror', e));

window.addEventListener('resize', () => map.resize());

// Expose the map (and the splat clock) for tooling / the console.
declare global {
  interface Window {
    map: typeof map;
    __splatsSetTime: (ms: number | null) => void;
  }
}
window.map = map;
window.__splatsSetTime = (ms) => { splatsTimeOverride = ms; };

// Expose for ad-hoc debugging.
(window as unknown as { map: typeof map }).map = map;

function buildThemeMenu(activeName: string): void {
  // --- "3D Satellite" toggle: present whenever a tile source is configured ---
  const splatsDock = document.getElementById('splats-dock') as HTMLDivElement | null;
  const splatsBtn = document.getElementById('splats-toggle') as HTMLButtonElement | null;
  if (splatsDock && splatsBtn && map.getSplatsOptions().urlTemplate) {
    splatsDock.hidden = false;
    const reflect = (): void => {
      const on = map.getSplatsOptions().enabled;
      splatsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      splatsBtn.dataset.on = on ? 'true' : 'false';
    };
    splatsBtn.addEventListener('click', () => {
      const turningOn = !map.getSplatsOptions().enabled;
      const view = map.getView();
      const nearest = splatsRegions.reduce<SplatsRegion | null>(
        (best, r) => (!best || kmBetween(view, r) < kmBetween(view, best) ? r : best), null);
      if (turningOn && nearest && !splatsFromUrl && kmBetween(view, nearest) > 3) {
        const q = new URLSearchParams({
          lat: String(nearest.lat),
          lon: String(nearest.lon),
          zoom: String(nearest.zoom),
          tilt: '45',
          satellite: '1'
        });
        if (nearest.basemap) q.set('pmtiles', `${import.meta.env.BASE_URL}${nearest.basemap}`);
        window.location.search = q.toString();
        return;
      }
      map.setSplatsEnabled(turningOn);
      reflect();
    });
    reflect();
  }

  const dock = document.getElementById('theme-dock') as HTMLDivElement | null;
  const trigger = document.getElementById('theme-trigger') as HTMLButtonElement | null;
  const grid = document.getElementById('theme-grid') as HTMLDivElement | null;
  const triggerSwatches = document.getElementById('theme-trigger-swatches');
  if (!dock || !trigger || !grid || !triggerSwatches) return;
  grid.innerHTML = '';

  const updateTrigger = (name: string): void => {
    const theme = THEMES[name];
    if (!theme) return;
    triggerSwatches.innerHTML = `
      <span style="background:${theme.land}"></span>
      <span style="background:${theme.building}"></span>
      <span style="background:${theme.park}"></span>
      <span style="background:${theme.water}"></span>
      <span style="background:${theme.road}"></span>
    `;
  };

  for (const name of THEME_NAMES) {
    const theme = THEMES[name];
    if (!theme) continue;

    const btn = document.createElement('button');
    btn.className = 'theme-btn' + (name === activeName ? ' active' : '');
    btn.dataset.theme = name;

    // Swatch order matches PolyMap: land, building, park, water, road.
    btn.innerHTML = `
      <div class="theme-swatches">
        <span style="background:${theme.land}"></span>
        <span style="background:${theme.building}"></span>
        <span style="background:${theme.park}"></span>
        <span style="background:${theme.water}"></span>
        <span style="background:${theme.road}"></span>
      </div>
      <div class="theme-label">${formatLabel(name)}</div>
    `;

    btn.addEventListener('click', () => {
      map.applyTheme(name);
      document.querySelectorAll('.theme-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateTrigger(name);
      // Stay expanded so the user can browse multiple themes — only the
      // chevron, an outside click, or Escape collapses the dock.
    });

    grid.appendChild(btn);
  }

  updateTrigger(activeName);

  const setExpanded = (open: boolean): void => {
    dock.dataset.expanded = open ? 'true' : 'false';
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(dock.dataset.expanded !== 'true');
  });
  // Click anywhere outside the dock (including on the map canvas) collapses.
  document.addEventListener('pointerdown', (e) => {
    if (dock.dataset.expanded !== 'true') return;
    const target = e.target as Node | null;
    if (!target || dock.contains(target)) return;
    setExpanded(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dock.dataset.expanded === 'true') setExpanded(false);
  });
}

function seedRealEstateTags(): void {
  // A scatter of fake real-estate listings around Lower Manhattan. Each listing
  // is mapped to one of REAL_ESTATE_TAG_PRESETS (forSale / pending / subject)
  // so the markers get the polished, on-brand styling consumers would get from
  // the public preset map. The badge stays the bedroom count (more useful for
  // an investor scanning the map than repeating the preset's "For Sale" badge).
  type Status = 'forSale' | 'pending' | 'subject';
  const listings: Array<{
    id: string; lat: number; lon: number; preset: Status;
    text: string; badge: string;
    modal: { title: string; body: string };
  }> = [
    { id: 'l1', lat: 40.7080, lon: -74.0119, preset: 'forSale', text: '$1.2M', badge: '3 BR',
      modal: { title: 'Trinity Church Condo', body: '<p>Renovated 3-bedroom condo in the heart of the Financial District. South-facing windows, doorman, gym.</p>' } },
    { id: 'l2', lat: 40.7065, lon: -74.0094, preset: 'forSale', text: '$2.8M', badge: '4 BR',
      modal: { title: 'NYSE Loft', body: '<p>Industrial loft conversion with 12-ft ceilings. Steps from Wall Street. Includes one parking spot.</p>' } },
    { id: 'l3', lat: 40.7064, lon: -74.0090, preset: 'pending', text: '$950K', badge: '2 BR',
      modal: { title: 'Pine St. Co-op', body: '<p>Charming pre-war co-op with original details. Pet-friendly building. Monthly maintenance $1,840.</p>' } },
    { id: 'l4', lat: 40.7067, lon: -74.0092, preset: 'forSale', text: '$1.5M', badge: '3 BR',
      modal: { title: 'Wall St. Apartment', body: '<p>Recently renovated, in-unit washer/dryer, building has rooftop deck and 24-hr concierge.</p>' } },
    { id: 'l5', lat: 40.7044, lon: -74.0170, preset: 'subject', text: '$3.4M', badge: '5 BR',
      modal: { title: 'Battery Park Penthouse (Subject)', body: '<p>5-bedroom penthouse with private terrace overlooking the harbor. Subject of this investor view.</p>' } },
    { id: 'l6', lat: 40.7127, lon: -74.0134, preset: 'forSale', text: '$1.8M', badge: '3 BR',
      modal: { title: 'WTC Tower Residence', body: '<p>High-floor 3-bedroom in the World Trade Center complex. Spectacular views, full-service building.</p>' } },
    { id: 'l7', lat: 40.7071, lon: -74.0024, preset: 'pending', text: '$720K', badge: '1 BR',
      modal: { title: 'Seaport Studio+', body: '<p>Loft-style one-bedroom in the South Street Seaport area. Original tin ceilings. Excellent value for the neighborhood.</p>' } }
  ];
  for (const l of listings) {
    const style = REAL_ESTATE_TAG_PRESETS[l.preset];
    map.addTag({
      id: l.id, lat: l.lat, lon: l.lon,
      color: style.color, icon: style.icon,
      text: l.text, badge: l.badge, modal: l.modal
    });
  }

  // Investor mode: `?investor=1` paints a comp-radius circle around the subject
  // property — a one-URL showcase of the professional theme + tag presets +
  // makeRadiusPolygon helper together.
  if (url.searchParams.get('investor') === '1') {
    const subject = listings.find((l) => l.preset === 'subject');
    if (subject) {
      map.addPolygon({
        id: 'comp-radius',
        color: '#3b82f6',
        opacity: 0.18,
        points: makeRadiusPolygon(subject.lat, subject.lon, 400)
      });
    }
  }
}

/**
 * Demo of the badge↔floor association: poll loaded buildings until a tall
 * one shows up, then pin a tag to its mid-floor. Clicking the tag opens its
 * modal AND highlights the building with an orange floor band.
 */
function seedFloorDemoTag(): void {
  let spawned = false;
  const tryPlace = (): boolean => {
    if (spawned) return true;
    const buildings = map.getLoadedBuildings();
    if (buildings.length === 0) return false;
    // Pick the tallest building globally; require ≥30m so the floor band is visible.
    let tallest = buildings[0];
    for (const b of buildings) if (b.height > tallest.height) tallest = b;
    if (tallest.height < 30) return false;
    const { lat, lon } = map.unproject(tallest.centroid.x, tallest.centroid.z);
    const totalLevels = tallest.levels ?? Math.floor(tallest.height / 3);
    const floor = Math.max(2, Math.floor(totalLevels * 0.6));
    const floorHeight = tallest.levels && tallest.levels > 0
      ? tallest.height / tallest.levels
      : 3;
    // Anchor the badge at the floor's mid-Y so it sits next to the floor box
    // instead of covering it (the underlying tag anchor is at street level).
    const elevation = Math.min(
      tallest.height,
      Math.max(0, (floor - 0.5) * floorHeight)
    );
    spawned = true;
    map.addTag({
      id: 'floor-demo',
      lat, lon,
      buildingId: tallest.id,
      floor,
      elevation,
      color: '#9333ea',
      icon: '🏙️',
      text: `Floor ${floor}`,
      modal: {
        title: `Floor ${floor} demo`,
        body:
          `<p>This badge is anchored to floor ${floor} of a building ` +
          `${Math.round(tallest.height)} m tall.</p>` +
          `<p>The building turns into a blueprint and the orange band shows the floor.</p>`
      }
    });
    return true;
  };
  if (tryPlace()) return;
  const id = window.setInterval(() => {
    if (tryPlace()) window.clearInterval(id);
  }, 250);
  // Bail after 10s if no tall building ever loads (e.g. user moved the URL).
  window.setTimeout(() => window.clearInterval(id), 10_000);
}

function formatLabel(key: string): string {
  // "cottagecoredark" → "Cottage Core Dark", "middleearth" → "Middle Earth", etc.
  const SPECIALS: Record<string, string> = {
    ghibli: 'Ghibli',
    cottagecore: 'Cottage Core',
    cottagecoredark: 'Cottage Core Dark',
    middleearth: 'Middle Earth',
    oldworld: 'Old World',
    concretejungle: 'Concrete Jungle',
    greyscaledark: 'Greyscale (Dark)'
  };
  if (SPECIALS[key]) return SPECIALS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}
