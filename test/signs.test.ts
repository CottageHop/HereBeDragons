import { describe, it, expect } from 'vitest';
import { SignsLayer } from '../src/layers/SignsLayer.js';
import { StylizedMaterials } from '../src/materials/StylizedMaterials.js';
import type { LayerGeometry } from '../src/tiles/worker/decodeProtocol.js';

/**
 * Shop-sign density is a runtime cull on an over-emitted candidate set (by a
 * per-sign `rank`), and the zoom gate is runtime-settable. These assert both
 * knobs + that the `rank` attribute flows through `build`. The atlas texture
 * builder is guarded for headless, so the layer constructs in the node env.
 */
describe('SignsLayer density + zoom', () => {
  const opts = { getCameraZoom: () => 16 };

  it('density + min-zoom setters clamp and read back', () => {
    const materials = new StylizedMaterials();
    const signs = new SignsLayer(materials, opts);
    expect(signs.getDensity()).toBeCloseTo(0.5); // default
    signs.setDensity(0.8);
    expect(signs.getDensity()).toBeCloseTo(0.8);
    signs.setDensity(5); // clamped to 1
    expect(signs.getDensity()).toBe(1);
    signs.setMinZoom(13);
    expect(signs.getMinZoom()).toBe(13);
    signs.dispose();
    materials.dispose();
  });

  it('build wires the per-sign rank attribute for the density cull', () => {
    const materials = new StylizedMaterials();
    const signs = new SignsLayer(materials, opts);
    const geom: LayerGeometry = {
      positions: new Float32Array([0, 0, 0, 10, 0, 10]),
      indices: new Uint32Array(0),
      attributes: { variant: new Float32Array([0, 1]), rank: new Float32Array([0.2, 0.9]) }
    };
    const mesh = signs.build(geom) as unknown as { geometry: { getAttribute: (n: string) => { count: number } | undefined } };
    const rankAttr = mesh.geometry.getAttribute('aRank');
    expect(rankAttr).toBeTruthy();
    expect(rankAttr!.count).toBe(2);
    signs.dispose();
    materials.dispose();
  });
});
