import { createHereBeDragons, createMapStudio, THEMES, THEME_NAMES } from '../../src/index.js';

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
const initialTheme = url.searchParams.get('theme') ?? 'cottagecore';
// `?quality=low|high` forces the render-quality tier; otherwise auto-detect
// (downgrades to 'low' on Intel integrated graphics + software rasterizers).
// Use this to A/B-test what tier the slow machine is actually getting.
const qualityParam = url.searchParams.get('quality');
const quality: 'low' | 'high' | undefined =
  qualityParam === 'low' || qualityParam === 'high' ? qualityParam : undefined;

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
    labels: true
  }
};

// `theme` + `clouds` are now declarative on the options object — no need to
// call `applyTheme` / `setCloudsEnabled` after construction. Demonstrates the
// "exported Studio JSON drops straight in" workflow.
const map = await createHereBeDragons(container, {
  ...mapOptions,
  theme: initialTheme,
  clouds: false,
  quality
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
    // The Studio Quality buttons flip the tier — re-read every 500 ms so
    // the HUD stays in sync without us wiring an event.
    setInterval(refreshTier, 500);

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
  // A scatter of fake real-estate listings around Lower Manhattan. Several are
  // close together so the clustering logic has a chance to show — try zooming
  // out and the closer ones will absorb into a count bubble.
  const listings = [
    { id: 'l1', lat: 40.7080, lon: -74.0119, color: '#10b981', text: '$1.2M', badge: '3 BR',
      modal: { title: 'Trinity Church Condo', body: '<p>Renovated 3-bedroom condo in the heart of the Financial District. South-facing windows, doorman, gym.</p>' } },
    { id: 'l2', lat: 40.7065, lon: -74.0094, color: '#10b981', text: '$2.8M', badge: '4 BR',
      modal: { title: 'NYSE Loft', body: '<p>Industrial loft conversion with 12-ft ceilings. Steps from Wall Street. Includes one parking spot.</p>' } },
    { id: 'l3', lat: 40.7064, lon: -74.0090, color: '#f59e0b', text: '$950K', badge: '2 BR',
      modal: { title: 'Pine St. Co-op', body: '<p>Charming pre-war co-op with original details. Pet-friendly building. Monthly maintenance $1,840.</p>' } },
    { id: 'l4', lat: 40.7067, lon: -74.0092, color: '#10b981', text: '$1.5M', badge: '3 BR',
      modal: { title: 'Wall St. Apartment', body: '<p>Recently renovated, in-unit washer/dryer, building has rooftop deck and 24-hr concierge.</p>' } },
    { id: 'l5', lat: 40.7044, lon: -74.0170, color: '#3b82f6', text: '$3.4M', badge: '5 BR',
      modal: { title: 'Battery Park Penthouse', body: '<p>5-bedroom penthouse with private terrace overlooking the harbor. New construction, smart-home wired.</p>' } },
    { id: 'l6', lat: 40.7127, lon: -74.0134, color: '#10b981', text: '$1.8M', badge: '3 BR',
      modal: { title: 'WTC Tower Residence', body: '<p>High-floor 3-bedroom in the World Trade Center complex. Spectacular views, full-service building.</p>' } },
    { id: 'l7', lat: 40.7071, lon: -74.0024, color: '#f59e0b', text: '$720K', badge: '1 BR',
      modal: { title: 'Seaport Studio+', body: '<p>Loft-style one-bedroom in the South Street Seaport area. Original tin ceilings. Excellent value for the neighborhood.</p>' } }
  ];
  for (const l of listings) {
    map.addTag({
      id: l.id,
      lat: l.lat,
      lon: l.lon,
      icon: '🏠',
      color: l.color,
      text: l.text,
      badge: l.badge,
      modal: l.modal
    });
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
    cottagecore: 'Cottage Core',
    cottagecoredark: 'Cottage Core Dark',
    middleearth: 'Middle Earth',
    oldworld: 'Old World',
    concretejungle: 'Concrete Jungle'
  };
  if (SPECIALS[key]) return SPECIALS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}
