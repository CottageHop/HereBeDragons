import type { HereBeDragons, HereBeDragonsEventPayload } from '../types.js';
import { injectScaleBarStylesOnce } from './scaleBarStyles.js';

export type ScaleBarUnits = 'metric' | 'imperial';

const METERS_PER_FOOT = 0.3048;
const FEET_PER_MILE = 5280;

/**
 * Round-number progressions for each unit system. We pick the largest
 * entry that still fits inside the target pixel width, which gives the
 * "100 ft / 500 ft / 1/4 mi" feel users recognise from print real-estate
 * maps. Imperial flips to miles once the bar exceeds a mile.
 */
const METRIC_STEPS_M = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000
];
const IMPERIAL_STEPS_FT = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500,
  // miles, in feet
  FEET_PER_MILE, 2 * FEET_PER_MILE, 5 * FEET_PER_MILE,
  10 * FEET_PER_MILE, 25 * FEET_PER_MILE
];

export interface ScaleBarChoice {
  /** Distance in the source unit (meters or feet). */
  distance: number;
  /** Pre-formatted label including units (e.g. `"500 ft"`, `"1/4 mi"`). */
  label: string;
  /** How wide the bar should be drawn, in CSS pixels. */
  widthPx: number;
}

/**
 * Pick the nicest round distance whose drawn width fits inside
 * `targetWidthPx` at the current `metersPerPixel`. Pure function — split
 * out so it can be unit-tested without DOM.
 */
export function chooseScaleBar(
  metersPerPixel: number,
  targetWidthPx: number,
  units: ScaleBarUnits
): ScaleBarChoice {
  // Convert the pixel budget into the candidate unit so we compare apples
  // to apples against the steps table.
  const maxDistance =
    units === 'metric'
      ? metersPerPixel * targetWidthPx
      : (metersPerPixel * targetWidthPx) / METERS_PER_FOOT;
  const steps = units === 'metric' ? METRIC_STEPS_M : IMPERIAL_STEPS_FT;

  // Walk top-down so we pick the largest step that still fits.
  let chosen = steps[0];
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i] <= maxDistance) {
      chosen = steps[i];
      break;
    }
  }

  // Translate the chosen distance back to pixels.
  const widthPx =
    units === 'metric'
      ? chosen / metersPerPixel
      : (chosen * METERS_PER_FOOT) / metersPerPixel;

  return {
    distance: chosen,
    label: formatScaleBarLabel(chosen, units),
    widthPx
  };
}

function formatScaleBarLabel(distance: number, units: ScaleBarUnits): string {
  if (units === 'metric') {
    if (distance >= 1_000) {
      const km = distance / 1_000;
      return `${stripTrailingZero(km)} km`;
    }
    return `${distance} m`;
  }
  // Imperial — distance is in feet.
  if (distance >= FEET_PER_MILE) {
    const miles = distance / FEET_PER_MILE;
    return `${stripTrailingZero(miles)} mi`;
  }
  return `${distance} ft`;
}

function stripTrailingZero(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/**
 * Map scale bar — a small "100 ft" / "200 m" ribbon pinned to the map. Most
 * real-estate map UIs expect one because investors think in distances
 * ("are these comps within walking distance?"). Subscribes to `viewchange`
 * (not RAF) so an idle bar costs nothing — meters-per-pixel only changes
 * when the camera does.
 *
 * Click to swap between metric and imperial. The initial unit is taken
 * from the `units` option (defaults to imperial since the primary
 * audience is US real-estate).
 */
export class ScaleBar {
  readonly element: HTMLDivElement;
  private label: HTMLDivElement;
  private bar: HTMLDivElement;
  private map: HereBeDragons;
  private destroyed = false;
  private viewUnsub: () => void;
  private units: ScaleBarUnits;
  private targetWidthPx: number;
  private lastDistance = NaN;
  private lastUnits: ScaleBarUnits | '' = '';
  private clickHandler: () => void;

  constructor(
    map: HereBeDragons,
    container: HTMLElement,
    options: { units?: ScaleBarUnits; targetWidthPx?: number } = {}
  ) {
    this.map = map;
    this.units = options.units ?? 'imperial';
    // 90 px is a comfortable target — wide enough to read at a glance,
    // narrow enough to not crowd attribution / compass on small maps.
    this.targetWidthPx = options.targetWidthPx ?? 90;

    injectScaleBarStylesOnce();

    this.element = document.createElement('div');
    this.element.className = 'hbd-scalebar';
    this.element.title = 'Click to toggle units';

    this.label = document.createElement('div');
    this.label.className = 'hbd-scalebar-label';
    this.element.appendChild(this.label);

    this.bar = document.createElement('div');
    this.bar.className = 'hbd-scalebar-bar';
    this.element.appendChild(this.bar);

    this.clickHandler = () => {
      this.units = this.units === 'metric' ? 'imperial' : 'metric';
      this.recompute(true);
    };
    this.element.addEventListener('click', this.clickHandler);

    container.appendChild(this.element);

    this.recompute(true);
    this.viewUnsub = this.map.on('viewchange', this.onViewChange);
  }

  private onViewChange = (_e: HereBeDragonsEventPayload): void => {
    if (this.destroyed) return;
    this.recompute(false);
  };

  /**
   * Recompute the active scale-bar choice and apply it. Idempotent — only
   * touches the DOM when the distance or units actually changed, so a pan
   * that doesn't shift the choice does zero layout work.
   */
  private recompute(force: boolean): void {
    const mpp = this.map.getMetersPerPixel();
    if (!Number.isFinite(mpp) || mpp <= 0) return;
    const choice = chooseScaleBar(mpp, this.targetWidthPx, this.units);
    if (
      !force &&
      choice.distance === this.lastDistance &&
      this.units === this.lastUnits
    ) {
      return;
    }
    this.lastDistance = choice.distance;
    this.lastUnits = this.units;
    this.label.textContent = choice.label;
    this.bar.style.width = `${Math.round(choice.widthPx)}px`;
  }

  setUnits(units: ScaleBarUnits): void {
    if (units === this.units) return;
    this.units = units;
    this.recompute(true);
  }

  getUnits(): ScaleBarUnits {
    return this.units;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  destroy(): void {
    this.destroyed = true;
    this.viewUnsub();
    this.element.removeEventListener('click', this.clickHandler);
    this.element.remove();
  }
}
