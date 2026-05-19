import type { LayerName } from '../types.js';
import type { Layer } from '../layers/Layer.js';

export class LayerRegistry {
  private layers = new Map<LayerName, Layer>();
  private enabled = new Map<LayerName, boolean>();

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
    for (const [, layer] of this.entries()) {
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
