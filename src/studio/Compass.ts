import type { HereBeDragons, HereBeDragonsEventPayload } from '../types.js';
import { injectCompassStylesOnce } from './compassStyles.js';

/**
 * Simple compass overlay. The red needle points to north; rotates the
 * inverse of the camera's bearing so north always reads correctly. Clicking
 * the compass snaps the camera back to bearing 0.
 *
 * Subscribes to the map's `viewchange` event — fires only when the camera
 * actually moves, so an idle compass costs nothing. A previous version
 * polled `map.getView()` in its own RAF loop; getView() allocates a vector
 * + does trig per call, so 60 wasted calls per second was visible on the
 * profile (e.g. while tiles were streaming in and the bearing wasn't
 * changing at all).
 *
 * Reset-to-north animation still uses its own RAF — it's a finite tween
 * triggered only on click, not a steady-state loop.
 */
export class Compass {
  readonly element: HTMLDivElement;
  private needle: HTMLDivElement;
  private map: HereBeDragons;
  private destroyed = false;
  private lastBearing = NaN;
  private viewUnsub: () => void;

  constructor(map: HereBeDragons, container: HTMLElement) {
    this.map = map;
    injectCompassStylesOnce();

    this.element = document.createElement('div');
    this.element.className = 'hbd-compass';
    this.element.title = 'Click to reset bearing to north';

    const label = document.createElement('div');
    label.className = 'hbd-compass-label';
    label.textContent = 'N';
    this.element.appendChild(label);

    this.needle = document.createElement('div');
    this.needle.className = 'hbd-compass-needle';
    this.element.appendChild(this.needle);

    this.element.addEventListener('click', () => {
      this.animateBearingToZero();
    });

    container.appendChild(this.element);

    // Render the initial bearing once. Subsequent updates come from
    // viewchange — no polling loop.
    this.applyBearing(this.map.getView().bearing);
    this.viewUnsub = this.map.on('viewchange', this.onViewChange);
  }

  private onViewChange = (e: HereBeDragonsEventPayload): void => {
    if (this.destroyed) return;
    // viewchange payload spreads in the CameraView fields, so `bearing` is
    // present at runtime. The shared union type doesn't narrow it for us.
    const bearing = (e as { bearing?: number }).bearing;
    if (typeof bearing === 'number') this.applyBearing(bearing);
  };

  private applyBearing(bearing: number): void {
    if (bearing === this.lastBearing) return;
    this.lastBearing = bearing;
    // Rotate the needle by -bearing so when the camera bears 30° east of
    // north, north appears 30° west on the compass (i.e. up and to the left).
    this.needle.style.transform = `rotate(${-bearing}deg)`;
  }

  /**
   * Smoothly rotate from the current bearing to 0. Picks the shortest
   * angular path through the ±180° wrap-around so a click never spins the
   * long way around.
   */
  private animateBearingToZero(): void {
    const start = this.map.getView().bearing;
    // Normalize the delta into [-180, 180] so we always take the short path.
    let delta = -start;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (Math.abs(delta) < 0.5) {
      this.map.setBearing(0);
      return;
    }
    const duration = 300;
    const t0 = performance.now();
    const step = (): void => {
      if (this.destroyed) return;
      const t = Math.min(1, (performance.now() - t0) / duration);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.map.setBearing(start + delta * e);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  destroy(): void {
    this.destroyed = true;
    this.viewUnsub();
    this.element.remove();
  }
}
