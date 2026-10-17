import type { LayerName } from '../types.js';
import type { Layer } from '../layers/Layer.js';

export class LayerRegistry {
  private layers = new Map<LayerName, Layer>();
  private enabled = new Map<LayerName, boolean>();
  /** Layers whose per-frame `update()` is paused (see `setSuspended`). */
  private suspended = new Set<LayerName>();
  /** Throttled layers → their tick interval + the time banked so far. */
  private throttled = new Map<LayerName, { intervalMs: number; advance: boolean; accMs: number }>();

  register(name: LayerName, layer: Layer): void {
    this.layers.set(name, layer);
    if (!this.enabled.has(name)) this.enabled.set(name, true);
  }

  get(name: LayerName): Layer | undefined {
    return this.layers.get(name);
  }

  isEnabled(name: LayerName): boolean {
    return this.enabled.get(name) ?? false;
  }

  setEnabled(name: LayerName, enabled: boolean): void {
    this.enabled.set(name, enabled);
  }

  /**
   * Pause / resume a layer's per-frame `update()` without touching its
   * enabled state. Used while an overlay masks the layer out of the drawn
   * scene (the splats overlay's `hideBasemap`): an invisible wind / foam
   * animation must not report "dirty" every frame, or render-on-demand never
   * idles and the whole (expensive) frame is redrawn for nothing.
   */
  setSuspended(name: LayerName, suspended: boolean): void {
    if (suspended) this.suspended.add(name);
    else this.suspended.delete(name);
  }

  /**
   * Rate-limit a layer's per-frame `update()` — for AMBIENT animations (wind
   * in the trees and grass, shoreline foam) that report "dirty" on every tick
   * and so force a full render every frame. While something expensive shares
   * the frame (the splats overlay re-rasterises every resident splat per
   * render) that idle cost is out of proportion to a swaying tree. The layer
   * is then ticked once per `intervalMs` with the banked time, so the motion
   * keeps its speed at a lower frame rate; with `advance: false` it is ticked
   * with `dt = 0` instead — frozen in place, but its zoom gate still runs.
   * `null` lifts the limit.
   */
  setThrottle(name: LayerName, intervalMs: number | null, advance = true): void {
    if (intervalMs === null || !(intervalMs > 0)) {
      this.throttled.delete(name);
      return;
    }
    const t = this.throttled.get(name);
    if (t) {
      t.intervalMs = intervalMs;
      t.advance = advance;
    } else {
      this.throttled.set(name, { intervalMs, advance, accMs: 0 });
    }
  }

  *entries(): IterableIterator<[LayerName, Layer]> {
    for (const [name, layer] of this.layers) {
      if (this.enabled.get(name) !== false) {
        yield [name, layer];
      }
    }
  }

  /**
   * @returns true if any layer's per-frame update changed the rendered
   *   scene (e.g. CarsLayer moved its instanced traffic). Feeds the
   *   render-on-demand check in the RAF loop.
   */
  update(dt: number): boolean {
    let dirty = false;
    for (const [name, layer] of this.entries()) {
      if (this.suspended.has(name)) continue;
      const t = this.throttled.get(name);
      if (t) {
        t.accMs += dt * 1000;
        if (t.accMs < t.intervalMs) continue;
        const banked = t.advance ? t.accMs / 1000 : 0;
        t.accMs = 0;
        if (layer.update?.(banked)) dirty = true;
        continue;
      }
      if (layer.update?.(dt)) dirty = true;
    }
    return dirty;
  }

  dispose(): void {
    for (const layer of this.layers.values()) {
      layer.dispose?.();
    }
    this.layers.clear();
    this.enabled.clear();
  }
}
