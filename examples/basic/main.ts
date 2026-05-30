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
const initialTheme = url.searchParams.get('theme') ?? 'ghibli';
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

const mapOptions = {
  center: { lat, lon },
  zoom,
  tilt: 55,
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
const map = await createHereBeDragons(container, {
  ...mapOptions,
  theme: initialTheme,
  // Clouds are off by default (the raymarch is the heaviest per-frame GPU
  // cost). Flip to `true` — or `{ enabled: true, opacity }` — to bring back
  // the towering gold cumulus of the Ghibli sky; on the auto quality tier
  // the raymarch self-disables if the GPU can't keep up.
  clouds: false,
  quality,
  pixelRatio,
  dynamicResolution,
  msaa
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
      tierEl.textContent =
        `tier: ${map.getQualityTier()} · ${map.getPixelRatio().toFixed(2)}× px`;
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
if (url.searchParams.get('studio') === '1') {
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

// Expose for ad-hoc debugging.
(window as unknown as { map: typeof map }).map = map;

function buildThemeMenu(activeName: string): void {
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
