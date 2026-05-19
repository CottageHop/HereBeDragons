import type { DragonMap, DragonMapOptions, LayerName } from '../types.js';
import { THEMES, THEME_NAMES, type ThemeColors } from '../themes.js';
import { injectDefaultStudioStylesOnce } from './styles.js';
import type { MapStudio as MapStudioHandle, StudioConfig, StudioOptions } from './types.js';

/** Color-valued ThemeColors keys (excludes non-color fields like `outline`). */
type ThemeColorKey = 'water' | 'park' | 'building' | 'road' | 'land' | 'beach' | 'sky';

/** Theme keys exposed as color-picker rows in the studio. */
const CUSTOM_COLOR_KEYS: ReadonlyArray<ThemeColorKey> = [
  'land',
  'building',
  'park',
  'water',
  'road',
  'sky'
];

const LAYER_KEYS: ReadonlyArray<LayerName> = [
  'water',
  'landuse',
  'roads',
  'buildings',
  'labels',
  'cars'
];

/**
 * Developer-facing control panel for live-editing map settings and exporting
 * a JSON config that can be passed back to `createDragonMap`.
 *
 * The studio reads queryable state directly from the map (camera, theme,
 * custom colors, clouds) and tracks its own state for non-queryable fields
 * (per-layer enabled flags, `pmtiles_url`). Pass the original
 * `DragonMapOptions` via `options.initialConfig` so the exported JSON
 * round-trips correctly.
 */
export class MapStudio implements MapStudioHandle {
  private readonly map: DragonMap;
  private readonly container: HTMLElement;
  private readonly initialConfig: Partial<DragonMapOptions>;
  private readonly onExport?: StudioOptions['onExport'];
  private readonly themeNames: string[];

  private readonly panel: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly themeGrid: HTMLDivElement;
  private themeToggle: HTMLButtonElement | null = null;
  private themeToggleSwatches: HTMLSpanElement | null = null;
  private themeToggleLabel: HTMLSpanElement | null = null;
  private readonly layerInputs = new Map<LayerName, HTMLInputElement>();
  private readonly colorInputs = new Map<ThemeColorKey, HTMLInputElement>();
  private buildingHighlightInput: HTMLInputElement | null = null;
  private floorHighlightInput: HTMLInputElement | null = null;
  private readonly tiltInput: HTMLInputElement;
  private readonly bearingInput: HTMLInputElement;
  private readonly zoomInput: HTMLInputElement;
  private readonly tiltValue: HTMLSpanElement;
  private readonly bearingValue: HTMLSpanElement;
  private readonly zoomValue: HTMLSpanElement;
  /** Per-axis range-mode state. Read by `getConfig` so disabled ranges
   *  stay out of the exported JSON (only an explicit user choice round-trips). */
  private tiltRange: RangeState;
  private bearingRange: RangeState;
  private zoomRange: RangeState;
  private readonly cloudsInput: HTMLInputElement;
  private readonly cloudsOpacityInput: HTMLInputElement;
  private readonly cloudsOpacityValue: HTMLSpanElement;
  private readonly compassInput: HTMLInputElement;

  private readonly layerState = new Map<LayerName, boolean>();
  private readonly cameraSyncHandle: number;
  private destroyed = false;

  constructor(map: DragonMap, options: StudioOptions = {}) {
    this.map = map;
    this.container = options.container ?? document.body;
    this.initialConfig = options.initialConfig ?? {};
    this.onExport = options.onExport;
    // The compass is owned by DragonMap; the studio just provides a UI
    // toggle. If the developer explicitly set the option, forward it to the
    // map; otherwise leave whatever state the map was constructed with.
    if (options.compass !== undefined) this.map.setCompassVisible(options.compass);
    // Filter out unknown names but preserve developer-specified order. When
    // `themes` is omitted, fall back to every registered theme.
    this.themeNames = options.themes
      ? options.themes.filter((name) => name in THEMES)
      : THEME_NAMES.slice();

    if (options.injectDefaultStyles !== false) injectDefaultStudioStylesOnce();

    // Seed layer state from initial config (defaults to enabled when omitted
    // so the studio's checkbox UI matches createDragonMap's behavior).
    // Read the live state from the map so opt-in layers (e.g. cars, default
    // off) show up correctly unchecked rather than getting forced on.
    for (const name of LAYER_KEYS) {
      this.layerState.set(name, this.map.getLayerEnabled(name));
    }

    // ----- Panel chrome --------------------------------------------------
    this.panel = document.createElement('div');
    this.panel.className = 'hbd-studio';
    this.panel.dataset.collapsed = options.open === false ? 'true' : 'false';

    const header = document.createElement('div');
    header.className = 'hbd-studio-header';
    const title = document.createElement('span');
    title.className = 'hbd-studio-title';
    title.textContent = 'Map Studio';
    const toggle = document.createElement('button');
    toggle.className = 'hbd-studio-toggle';
    toggle.type = 'button';
    toggle.textContent = '▾';
    toggle.setAttribute('aria-label', 'Toggle studio panel');
    header.appendChild(title);
    header.appendChild(toggle);
    header.addEventListener('click', () => {
      const collapsed = this.panel.dataset.collapsed === 'true';
      this.setOpen(collapsed);
    });
    this.panel.appendChild(header);

    this.body = document.createElement('div');
    this.body.className = 'hbd-studio-body';
    this.panel.appendChild(this.body);

    // ----- Theme section -------------------------------------------------
    // Detached when `themes: []` so the panel hides the picker entirely.
    // Otherwise: collapsed picker, expands on click — keeps the panel short.
    this.themeGrid = document.createElement('div');
    this.themeGrid.className = 'hbd-studio-theme-grid';
    if (this.themeNames.length > 0) {
      const themeSection = makeSection();
      const toggle = this.buildThemeToggle();
      themeSection.appendChild(toggle);
      this.themeGrid.hidden = true;
      themeSection.appendChild(this.themeGrid);
      this.body.appendChild(themeSection);
      this.buildThemeGrid();
    }

    // ----- Custom colors -------------------------------------------------
    this.body.appendChild(makeSectionHeader('Custom Colors'));
    const colorSection = makeSection();
    for (const key of CUSTOM_COLOR_KEYS) {
      const row = document.createElement('div');
      row.className = 'hbd-studio-row';
      const label = document.createElement('label');
      label.textContent = capitalize(key);
      const input = document.createElement('input');
      input.type = 'color';
      input.value = this.resolveColorForKey(key);
      input.addEventListener('input', () => {
        const overrides = this.collectCustomColors();
        this.map.setCustomColors(overrides);
      });
      row.appendChild(label);
      row.appendChild(input);
      colorSection.appendChild(row);
      this.colorInputs.set(key, input);
    }
    this.body.appendChild(colorSection);

    // ----- Highlight overlay colors -------------------------------------
    this.body.appendChild(makeSectionHeader('Selection Highlight'));
    const highlightSection = makeSection();
    // Popup-enable toggle.
    {
      const row = document.createElement('div');
      row.className = 'hbd-studio-row';
      const label = document.createElement('label');
      label.textContent = 'Show popup';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.map.isBuildingPopupEnabled();
      input.addEventListener('change', () => {
        this.map.setBuildingPopup({ popupEnabled: input.checked });
      });
      row.appendChild(label);
      row.appendChild(input);
      highlightSection.appendChild(row);
    }
    {
      const row = document.createElement('div');
      row.className = 'hbd-studio-row';
      const label = document.createElement('label');
      label.textContent = 'Building';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = this.map.getBuildingHighlightColor();
      input.addEventListener('input', () => {
        this.map.setBuildingHighlightColors(input.value, this.floorHighlightInput!.value);
      });
      row.appendChild(label);
      row.appendChild(input);
      highlightSection.appendChild(row);
      this.buildingHighlightInput = input;
    }
    {
      const row = document.createElement('div');
      row.className = 'hbd-studio-row';
      const label = document.createElement('label');
      label.textContent = 'Floor band';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = this.map.getFloorHighlightColor();
      input.addEventListener('input', () => {
        this.map.setBuildingHighlightColors(this.buildingHighlightInput!.value, input.value);
      });
      row.appendChild(label);
      row.appendChild(input);
      highlightSection.appendChild(row);
      this.floorHighlightInput = input;
    }
    this.body.appendChild(highlightSection);

    // ----- Camera --------------------------------------------------------
    this.body.appendChild(makeSectionHeader('Camera'));
    const camSection = makeSection();
    const view = this.map.getView();

    const tiltCtl = buildCameraControl({
      label: 'Tilt',
      min: 0,
      max: 75,
      step: 1,
      unit: '°',
      initial: view.tilt,
      onValueChange: (v) => this.map.setTilt(v),
      onRangeChange: (range) => this.map.setTiltRange(range)
    });
    camSection.appendChild(tiltCtl.row);
    camSection.appendChild(tiltCtl.rangeContainer);
    this.tiltInput = tiltCtl.input;
    this.tiltValue = tiltCtl.value;
    this.tiltRange = tiltCtl.state;

    const bearingCtl = buildCameraControl({
      label: 'Bearing',
      min: -180,
      max: 180,
      step: 1,
      unit: '°',
      initial: view.bearing,
      onValueChange: (v) => this.map.setBearing(v),
      onRangeChange: (range) => this.map.setBearingRange(range)
    });
    camSection.appendChild(bearingCtl.row);
    camSection.appendChild(bearingCtl.rangeContainer);
    this.bearingInput = bearingCtl.input;
    this.bearingValue = bearingCtl.value;
    this.bearingRange = bearingCtl.state;

    const zoomCtl = buildCameraControl({
      label: 'Zoom',
      min: 4,
      max: 20,
      step: 0.1,
      unit: '',
      initial: view.zoom,
      onValueChange: (v) => {
        const cur = this.map.getView();
        this.map.setView(cur.lat, cur.lon, v);
      },
      onRangeChange: (range) => this.map.setZoomRange(range)
    });
    camSection.appendChild(zoomCtl.row);
    camSection.appendChild(zoomCtl.rangeContainer);
    this.zoomInput = zoomCtl.input;
    this.zoomValue = zoomCtl.value;
    this.zoomRange = zoomCtl.state;

    this.body.appendChild(camSection);

    // ----- Layers --------------------------------------------------------
    this.body.appendChild(makeSectionHeader('Layers'));
    const layerSection = makeSection();
    for (const name of LAYER_KEYS) {
      const row = document.createElement('div');
      row.className = 'hbd-studio-row';
      const label = document.createElement('label');
      label.textContent = capitalize(name);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.layerState.get(name) ?? true;
      input.addEventListener('change', () => {
        this.layerState.set(name, input.checked);
        this.map.setLayerEnabled(name, input.checked);
      });
      row.appendChild(label);
      row.appendChild(input);
      layerSection.appendChild(row);
      this.layerInputs.set(name, input);
    }
    // Flatten-buildings toggle — sits in the Layers section since it's a
    // building-display tweak even though it isn't a separate layer.
    const flattenRow = document.createElement('div');
    flattenRow.className = 'hbd-studio-row';
    const flattenLabel = document.createElement('label');
    flattenLabel.textContent = 'Flatten buildings';
    const flattenInput = document.createElement('input');
    flattenInput.type = 'checkbox';
    flattenInput.checked = this.map.getBuildingsFlat();
    flattenInput.addEventListener('change', () => {
      this.map.setBuildingsFlat(flattenInput.checked);
    });
    flattenRow.appendChild(flattenLabel);
    flattenRow.appendChild(flattenInput);
    layerSection.appendChild(flattenRow);
    this.body.appendChild(layerSection);

    // ----- Quality --------------------------------------------------------
    // Live tier switch. Headline performance control: flipping to 'low'
    // caps pixelRatio to 1, kills the cloud raymarch, and skips the whole
    // outline pipeline (a full second scene render + a screen-space Sobel
    // shader). Big GPU wins on integrated graphics. MSAA + tile radii are
    // fixed at construction — those need a reload via the `quality` option.
    this.body.appendChild(makeSectionHeader('Quality'));
    const qualitySection = makeSection();
    const qualityRow = document.createElement('div');
    qualityRow.className = 'hbd-studio-row';
    const qualityLabel = document.createElement('label');
    qualityLabel.textContent = 'Tier';
    const lowBtn = document.createElement('button');
    lowBtn.type = 'button';
    lowBtn.className = 'hbd-studio-btn';
    lowBtn.textContent = 'Low';
    const highBtn = document.createElement('button');
    highBtn.type = 'button';
    highBtn.className = 'hbd-studio-btn';
    highBtn.textContent = 'High';
    const tierGroup = document.createElement('div');
    tierGroup.className = 'hbd-studio-row';
    tierGroup.style.flex = '1.4';
    tierGroup.style.gap = '6px';
    tierGroup.style.margin = '0';
    tierGroup.appendChild(lowBtn);
    tierGroup.appendChild(highBtn);
    qualityRow.appendChild(qualityLabel);
    qualityRow.appendChild(tierGroup);
    qualitySection.appendChild(qualityRow);

    // Read-only readout — shows what pixelRatio the renderer ended up with,
    // since that's the single biggest fill-rate lever and "did 'low'
    // actually halve my pixel work?" is the first question to answer.
    const prRow = document.createElement('div');
    prRow.className = 'hbd-studio-row';
    const prLabel = document.createElement('label');
    prLabel.textContent = 'Pixel ratio';
    const prValue = document.createElement('span');
    prValue.className = 'hbd-studio-value';
    prRow.appendChild(prLabel);
    prRow.appendChild(prValue);
    qualitySection.appendChild(prRow);
    this.body.appendChild(qualitySection);

    const syncQualityUi = (): void => {
      const tier = this.map.getQualityTier();
      lowBtn.classList.toggle('primary', tier === 'low');
      highBtn.classList.toggle('primary', tier === 'high');
      prValue.textContent = this.map.getPixelRatio().toFixed(2) + '×';
      // Cloud checkbox state is driven by the tier too — keep it in sync.
      if (this.cloudsInput) this.cloudsInput.checked = this.map.getCloudsEnabled();
    };
    lowBtn.addEventListener('click', () => {
      this.map.setQualityTier('low');
      syncQualityUi();
    });
    highBtn.addEventListener('click', () => {
      this.map.setQualityTier('high');
      syncQualityUi();
    });
    syncQualityUi();

    // ----- Clouds --------------------------------------------------------
    this.body.appendChild(makeSectionHeader('Clouds'));
    const cloudsSection = makeSection();
    const cloudsRow = document.createElement('div');
    cloudsRow.className = 'hbd-studio-row';
    const cloudsLabel = document.createElement('label');
    cloudsLabel.textContent = 'Enabled';
    this.cloudsInput = document.createElement('input');
    this.cloudsInput.type = 'checkbox';
    this.cloudsInput.checked = this.map.getCloudsEnabled();
    this.cloudsInput.addEventListener('change', () => {
      this.map.setCloudsEnabled(this.cloudsInput.checked);
    });
    cloudsRow.appendChild(cloudsLabel);
    cloudsRow.appendChild(this.cloudsInput);
    cloudsSection.appendChild(cloudsRow);

    const opacityRow = makeSliderRow('Opacity', 0, 1, 0.05, this.map.getCloudsOpacity());
    this.cloudsOpacityInput = opacityRow.input;
    this.cloudsOpacityValue = opacityRow.value;
    this.cloudsOpacityValue.textContent = this.map.getCloudsOpacity().toFixed(2);
    this.cloudsOpacityInput.addEventListener('input', () => {
      const v = Number(this.cloudsOpacityInput.value);
      this.cloudsOpacityValue.textContent = v.toFixed(2);
      this.map.setCloudsOpacity(v);
    });
    cloudsSection.appendChild(opacityRow.row);
    this.body.appendChild(cloudsSection);

    // ----- Fog ----------------------------------------------------------
    // Fog density is tilt-gated (no atmospheric fog when looking straight
    // down — there's no horizon to fade into). Studio exposes three knobs:
    //   - Tilt start  : camera tilt at which fog begins to appear (deg)
    //   - Tilt end    : tilt at which fog reaches full strength (deg)
    //   - Strength    : multiplier on the authored fog density
    this.body.appendChild(makeSectionHeader('Fog'));
    const fogSection = makeSection();

    const fogStartRow = makeSliderRow(
      'Tilt start', 0, 90, 1, this.map.getFogTiltStart(), '°'
    );
    fogStartRow.value.textContent = `${this.map.getFogTiltStart()}°`;
    fogStartRow.input.addEventListener('input', () => {
      const v = Number(fogStartRow.input.value);
      fogStartRow.value.textContent = `${v}°`;
      this.map.setFogTiltStart(v);
      // Keep end ≥ start so the ramp doesn't collapse silently.
      if (this.map.getFogTiltEnd() < v) {
        this.map.setFogTiltEnd(v);
        fogEndRow.input.value = String(v);
        fogEndRow.value.textContent = `${v}°`;
      }
    });
    fogSection.appendChild(fogStartRow.row);

    const fogEndRow = makeSliderRow(
      'Tilt end', 0, 90, 1, this.map.getFogTiltEnd(), '°'
    );
    fogEndRow.value.textContent = `${this.map.getFogTiltEnd()}°`;
    fogEndRow.input.addEventListener('input', () => {
      const v = Number(fogEndRow.input.value);
      fogEndRow.value.textContent = `${v}°`;
      this.map.setFogTiltEnd(v);
      if (this.map.getFogTiltStart() > v) {
        this.map.setFogTiltStart(v);
        fogStartRow.input.value = String(v);
        fogStartRow.value.textContent = `${v}°`;
      }
    });
    fogSection.appendChild(fogEndRow.row);

    const fogStrengthRow = makeSliderRow(
      'Strength', 0, 3, 0.05, this.map.getFogStrength()
    );
    fogStrengthRow.value.textContent = this.map.getFogStrength().toFixed(2);
    fogStrengthRow.input.addEventListener('input', () => {
      const v = Number(fogStrengthRow.input.value);
      fogStrengthRow.value.textContent = v.toFixed(2);
      this.map.setFogStrength(v);
    });
    fogSection.appendChild(fogStrengthRow.row);

    this.body.appendChild(fogSection);

    // ----- Labels --------------------------------------------------------
    this.body.appendChild(makeSectionHeader('Labels'));
    const labelSection = makeSection();

    const labelHeightRow = makeSliderRow(
      'Height', 0, 500, 5, this.map.getLabelHeight(), ' m'
    );
    labelHeightRow.value.textContent = `${this.map.getLabelHeight()} m`;
    labelHeightRow.input.addEventListener('input', () => {
      const v = Number(labelHeightRow.input.value);
      labelHeightRow.value.textContent = `${v} m`;
      this.map.setLabelHeight(v);
    });
    labelSection.appendChild(labelHeightRow.row);

    this.body.appendChild(labelSection);

    // ----- Animation -----------------------------------------------------
    // Tile spawn animation: how long new tiles take to "rise" from below
    // the ground plane into place. 0 = snap-in (no animation).
    this.body.appendChild(makeSectionHeader('Animation'));
    const animSection = makeSection();
    const spawnRow = makeSliderRow(
      'Pop-up time', 0, 3000, 50, this.map.getTileSpawnDurationMs(), ' ms'
    );
    spawnRow.value.textContent = `${this.map.getTileSpawnDurationMs()} ms`;
    spawnRow.input.addEventListener('input', () => {
      const v = Number(spawnRow.input.value);
      spawnRow.value.textContent = `${v} ms`;
      this.map.setTileSpawnDurationMs(v);
    });
    animSection.appendChild(spawnRow.row);
    this.body.appendChild(animSection);

    // ----- Compass -------------------------------------------------------
    this.body.appendChild(makeSectionHeader('Overlays'));
    const overlaySection = makeSection();
    const compassRow = document.createElement('div');
    compassRow.className = 'hbd-studio-row';
    const compassLabel = document.createElement('label');
    compassLabel.textContent = 'Compass';
    this.compassInput = document.createElement('input');
    this.compassInput.type = 'checkbox';
    this.compassInput.checked = this.map.isCompassVisible();
    this.compassInput.addEventListener('change', () => {
      this.map.setCompassVisible(this.compassInput.checked);
    });
    compassRow.appendChild(compassLabel);
    compassRow.appendChild(this.compassInput);
    overlaySection.appendChild(compassRow);
    this.body.appendChild(overlaySection);

    // ----- Actions -------------------------------------------------------
    const actions = document.createElement('div');
    actions.className = 'hbd-studio-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'hbd-studio-btn primary';
    exportBtn.textContent = 'Export JSON';
    exportBtn.addEventListener('click', () => this.export());
    actions.appendChild(exportBtn);
    this.panel.appendChild(actions);

    this.container.appendChild(this.panel);

    // Poll camera state to keep the slider readouts in sync with user
    // panning/zooming/rotating on the canvas. Avoid hooking the map's
    // 'viewchange' event because we don't want to retain a subscription via
    // the EventBus — the studio is meant to be cheap to mount/unmount.
    this.cameraSyncHandle = window.setInterval(() => this.syncFromCamera(), 100);
  }

  // ---------------------------------------------------------------------
  // Public handle methods
  // ---------------------------------------------------------------------

  getConfig(): StudioConfig {
    const view = this.map.getView();
    const customColors = this.map.getCustomColors();
    const layers: Partial<Record<LayerName, boolean>> = {};
    for (const [k, v] of this.layerState) layers[k] = v;

    const cfg: StudioConfig = {
      center: { lat: view.lat, lon: view.lon },
      zoom: roundTo(view.zoom, 3),
      tilt: roundTo(view.tilt, 1),
      bearing: roundTo(view.bearing, 1),
      pmtiles_url: this.initialConfig.pmtiles_url ?? '',
      layers,
      clouds: {
        enabled: this.map.getCloudsEnabled(),
        opacity: roundTo(this.map.getCloudsOpacity(), 3)
      },
      compass: this.map.isCompassVisible()
    };
    const theme = this.map.getCurrentTheme();
    if (theme) cfg.theme = theme;
    if (Object.keys(customColors).length > 0) cfg.customColors = customColors;
    if (this.initialConfig.pixelRatio !== undefined) cfg.pixelRatio = this.initialConfig.pixelRatio;
    if (this.initialConfig.background !== undefined) cfg.background = this.initialConfig.background;
    // Camera ranges — only included when the user has explicitly toggled the
    // range mode on. Disabled axes stay out of the JSON so the consumer's
    // defaults are honored.
    if (this.tiltRange.enabled) {
      cfg.tiltRange = { min: this.tiltRange.min, max: this.tiltRange.max };
    }
    if (this.bearingRange.enabled) {
      cfg.bearingRange = { min: this.bearingRange.min, max: this.bearingRange.max };
    }
    if (this.zoomRange.enabled) {
      cfg.zoomRange = { min: this.zoomRange.min, max: this.zoomRange.max };
    }
    return cfg;
  }

  export(): StudioConfig {
    const cfg = this.getConfig();
    const handled = this.onExport?.(cfg);
    if (handled === false) return cfg;
    // Default behavior: download as a JSON file.
    downloadJson(cfg, 'here-be-dragons.config.json');
    return cfg;
  }

  setOpen(open: boolean): void {
    this.panel.dataset.collapsed = open ? 'false' : 'true';
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearInterval(this.cameraSyncHandle);
    this.panel.remove();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** Build the collapsed-state trigger that, when clicked, expands the grid. */
  private buildThemeToggle(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hbd-studio-theme-toggle';
    btn.setAttribute('aria-expanded', 'false');
    const swatches = document.createElement('span');
    swatches.className = 'hbd-studio-theme-toggle-swatches';
    const label = document.createElement('span');
    label.className = 'hbd-studio-theme-toggle-label';
    label.textContent = 'Theme';
    const chev = document.createElement('span');
    chev.className = 'hbd-studio-theme-toggle-chevron';
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '▾';
    btn.appendChild(swatches);
    btn.appendChild(label);
    btn.appendChild(chev);
    this.themeToggle = btn;
    this.themeToggleSwatches = swatches;
    this.themeToggleLabel = label;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = btn.getAttribute('aria-expanded') === 'true';
      if (open) this.collapseThemes();
      else this.expandThemes();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.themeGrid || this.themeGrid.hidden) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (btn.contains(target) || this.themeGrid.contains(target)) return;
      this.collapseThemes();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.themeToggle?.getAttribute('aria-expanded') === 'true') {
        this.collapseThemes();
      }
    });
    return btn;
  }

  private expandThemes(): void {
    this.themeGrid.hidden = false;
    this.themeToggle?.setAttribute('aria-expanded', 'true');
  }

  private collapseThemes(): void {
    this.themeGrid.hidden = true;
    this.themeToggle?.setAttribute('aria-expanded', 'false');
  }

  /** Mirror the active theme's swatches + name on the collapsed trigger. */
  private refreshThemeToggle(name: string): void {
    if (!this.themeToggleSwatches || !this.themeToggleLabel) return;
    const theme = THEMES[name];
    if (!theme) {
      this.themeToggleLabel.textContent = 'Theme';
      this.themeToggleSwatches.innerHTML = '';
      return;
    }
    this.themeToggleLabel.textContent = formatThemeLabel(name);
    this.themeToggleSwatches.innerHTML = `
      <span style="background:${theme.land}"></span>
      <span style="background:${theme.building}"></span>
      <span style="background:${theme.park}"></span>
      <span style="background:${theme.water}"></span>
      <span style="background:${theme.road}"></span>
    `;
  }

  private buildThemeGrid(): void {
    const active = this.map.getCurrentTheme();
    this.themeGrid.innerHTML = '';
    for (const name of this.themeNames) {
      const theme = THEMES[name];
      if (!theme) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hbd-studio-theme-btn' + (name === active ? ' active' : '');
      btn.dataset.theme = name;
      btn.innerHTML = `
        <div class="hbd-studio-swatches">
          <span style="background:${theme.land}"></span>
          <span style="background:${theme.building}"></span>
          <span style="background:${theme.park}"></span>
          <span style="background:${theme.water}"></span>
          <span style="background:${theme.road}"></span>
        </div>
        <div class="hbd-studio-theme-label">${formatThemeLabel(name)}</div>
      `;
      btn.addEventListener('click', () => {
        this.map.applyTheme(name);
        // applyTheme clears custom colors; refresh the color inputs to the
        // new theme's baseline so the swatches read correctly.
        this.refreshCustomColorInputs();
        // Themes can also push new highlight colors (e.g. cyberpunk yellow);
        // pull those into the color pickers so the studio stays in sync.
        if (this.buildingHighlightInput) {
          this.buildingHighlightInput.value = this.map.getBuildingHighlightColor();
        }
        if (this.floorHighlightInput) {
          this.floorHighlightInput.value = this.map.getFloorHighlightColor();
        }
        for (const b of this.themeGrid.querySelectorAll('.hbd-studio-theme-btn')) {
          b.classList.remove('active');
        }
        btn.classList.add('active');
        this.refreshThemeToggle(name);
        // Stay expanded so the user can browse — only the chevron, an
        // outside click, or Escape collapses the picker.
      });
      this.themeGrid.appendChild(btn);
    }
    this.refreshThemeToggle(active);
  }

  /** Build a `Partial<ThemeColors>` from the current color-picker values. */
  private collectCustomColors(): Partial<ThemeColors> {
    const out: Partial<ThemeColors> = {};
    for (const [key, input] of this.colorInputs) {
      out[key] = input.value;
    }
    return out;
  }

  /** Snap each color input to the active theme's value (no overrides). */
  private refreshCustomColorInputs(): void {
    for (const [key, input] of this.colorInputs) {
      input.value = this.resolveColorForKey(key);
    }
  }

  /**
   * Resolve a per-key color: an active override wins over the theme, which
   * wins over a generic fallback. Used to seed the color inputs.
   */
  private resolveColorForKey(key: ThemeColorKey): string {
    const overrides = this.map.getCustomColors();
    if (overrides[key]) return overrides[key]!;
    const themeName = this.map.getCurrentTheme();
    const theme = themeName ? THEMES[themeName] : undefined;
    if (theme && theme[key]) return theme[key]!;
    return '#888888';
  }

  /**
   * Mirror the camera's live tilt/bearing/zoom into the sliders so dragging
   * the map updates the readouts. The polling is throttled so cheap (10 Hz).
   */
  private syncFromCamera(): void {
    if (this.destroyed) return;
    const view = this.map.getView();
    // Avoid clobbering a slider mid-drag — only write when the input isn't
    // the currently focused element.
    const active = document.activeElement;
    if (active !== this.tiltInput) {
      this.tiltInput.value = String(roundTo(view.tilt, 1));
      this.tiltValue.textContent = view.tilt.toFixed(0) + '°';
    }
    if (active !== this.bearingInput) {
      this.bearingInput.value = String(roundTo(view.bearing, 1));
      this.bearingValue.textContent = view.bearing.toFixed(0) + '°';
    }
    if (active !== this.zoomInput) {
      this.zoomInput.value = String(roundTo(view.zoom, 1));
      this.zoomValue.textContent = view.zoom.toFixed(1);
    }
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function makeSection(): HTMLDivElement {
  const s = document.createElement('div');
  s.className = 'hbd-studio-section';
  return s;
}

function makeSectionHeader(text: string): HTMLDivElement {
  const s = makeSection();
  const h = document.createElement('h4');
  h.textContent = text;
  s.appendChild(h);
  return s;
}

interface SliderRow {
  row: HTMLDivElement;
  input: HTMLInputElement;
  value: HTMLSpanElement;
}

/**
 * Mutable state owned by `buildCameraControl` for a single axis. The studio
 * reads `.enabled` + `.min/.max` at export time to decide whether this axis
 * contributes a range to the exported config.
 */
interface RangeState {
  enabled: boolean;
  min: number;
  max: number;
}

interface CameraControlOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  initial: number;
  /** Fires every input event on the main "initial value" slider. */
  onValueChange: (v: number) => void;
  /**
   * Fires whenever the range mode is toggled OR when a min/max slider moves.
   * Receives `null` when the user toggles range mode OFF — the studio
   * forwards that to the map's setXRange so the camera releases its clamp.
   */
  onRangeChange: (range: { min: number; max: number } | null) => void;
}

interface CameraControl {
  row: HTMLDivElement;
  rangeContainer: HTMLDivElement;
  input: HTMLInputElement;
  value: HTMLSpanElement;
  state: RangeState;
}

/**
 * Build a camera control: the main "initial value" slider plus a collapsible
 * range editor that lets the user pick `[min, max]` bounds. When range mode
 * is on, the main slider's `min`/`max` attributes get re-clamped to those
 * bounds and the camera's `setXRange(...)` enforces them at runtime.
 */
function buildCameraControl(opts: CameraControlOptions): CameraControl {
  const { label, min, max, step, unit, initial } = opts;
  // ---- Main row: label, slider, value readout, range caption, toggle ----
  const main = makeSliderRow(label, min, max, step, initial, unit);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'hbd-studio-range-toggle';
  toggle.setAttribute('aria-label', `Toggle ${label} range`);
  toggle.setAttribute('aria-pressed', 'false');
  toggle.title = `Limit allowed ${label.toLowerCase()} to a range`;
  toggle.textContent = '↔';
  main.row.appendChild(toggle);

  // ---- Range editor (initially hidden) ----
  const rangeContainer = document.createElement('div');
  rangeContainer.className = 'hbd-studio-range-rows';
  rangeContainer.hidden = true;

  const minRow = makeSliderRow('Min', min, max, step, min, unit);
  const maxRow = makeSliderRow('Max', min, max, step, max, unit);
  minRow.row.classList.add('hbd-studio-subrow');
  maxRow.row.classList.add('hbd-studio-subrow');
  rangeContainer.appendChild(minRow.row);
  rangeContainer.appendChild(maxRow.row);

  const state: RangeState = { enabled: false, min, max };

  // ---- Wiring ----
  main.input.addEventListener('input', () => {
    const v = Number(main.input.value);
    main.value.textContent = formatSliderValue(v, step) + unit;
    opts.onValueChange(v);
  });

  const pushRange = (): void => {
    let lo = Number(minRow.input.value);
    let hi = Number(maxRow.input.value);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    state.min = lo;
    state.max = hi;
    // Constrain the main slider to the chosen range so the initial value
    // can't be set outside what's allowed.
    main.input.min = String(lo);
    main.input.max = String(hi);
    const cur = Number(main.input.value);
    if (cur < lo) main.input.value = String(lo);
    if (cur > hi) main.input.value = String(hi);
    if (state.enabled) opts.onRangeChange({ min: lo, max: hi });
  };

  minRow.input.addEventListener('input', () => {
    const v = Number(minRow.input.value);
    minRow.value.textContent = formatSliderValue(v, step) + unit;
    pushRange();
  });
  maxRow.input.addEventListener('input', () => {
    const v = Number(maxRow.input.value);
    maxRow.value.textContent = formatSliderValue(v, step) + unit;
    pushRange();
  });

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    state.enabled = !state.enabled;
    toggle.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    toggle.classList.toggle('active', state.enabled);
    rangeContainer.hidden = !state.enabled;
    if (state.enabled) {
      pushRange();   // applies the current min/max bounds to the map
    } else {
      // Restore the main slider's full range and release the camera clamp.
      main.input.min = String(min);
      main.input.max = String(max);
      opts.onRangeChange(null);
    }
  });

  return { row: main.row, rangeContainer, input: main.input, value: main.value, state };
}

/**
 * Build a labeled slider row with:
 *   [label]  [▬▬▬●▬▬▬]  [current value]  [min–max]
 *
 * The `unit` suffix is appended to both the live value readout and the
 * min/max caption so a "Tilt" slider reads `55°  0–75°` rather than
 * `55°  0–75`. Callers still own the live-value update in their input
 * listener (they handle `map.setTilt` etc.), so they format the suffix
 * themselves there — `unit` here only affects the initial render and the
 * static range caption.
 */
function makeSliderRow(
  label: string,
  min: number,
  max: number,
  step: number,
  initial: number,
  unit = ''
): SliderRow {
  const row = document.createElement('div');
  row.className = 'hbd-studio-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(initial);
  const value = document.createElement('span');
  value.className = 'hbd-studio-value';
  value.textContent = formatSliderValue(initial, step) + unit;
  // Static min/max caption — gives the user a sense of how far the slider can
  // move without having to drag it to either end.
  const range = document.createElement('span');
  range.className = 'hbd-studio-range';
  range.textContent =
    `${formatSliderValue(min, step)}${unit}–${formatSliderValue(max, step)}${unit}`;
  row.appendChild(lab);
  row.appendChild(input);
  row.appendChild(value);
  row.appendChild(range);
  return { row, input, value };
}

function formatSliderValue(v: number, step: number): string {
  if (step >= 1) return Math.round(v).toString();
  // Decimal precision matches the slider's step (0.1 → 1 digit, 0.05 / 0.01
  // → 2 digits) so the range caption and the live value share a consistent
  // look — no "15.4" slider showing "4.00–20.00" beside it.
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return v.toFixed(digits);
}

function roundTo(v: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatThemeLabel(name: string): string {
  const SPECIALS: Record<string, string> = {
    cottagecore: 'Cottage Core',
    cottagecoredark: 'Cottage Dark',
    middleearth: 'Middle Earth',
    oldworld: 'Old World',
    concretejungle: 'Concrete Jungle'
  };
  return SPECIALS[name] ?? capitalize(name);
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Public factory mirrors `createDragonMap` style. */
export function createMapStudio(map: DragonMap, options?: StudioOptions): MapStudioHandle {
  return new MapStudio(map, options);
}
