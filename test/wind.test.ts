import { describe, it, expect } from 'vitest';
import { GrassLayer } from '../src/layers/GrassLayer.js';
import { TreesLayer } from '../src/layers/TreesLayer.js';
import { StylizedMaterials } from '../src/materials/StylizedMaterials.js';

/**
 * The wind-sway strength is a runtime multiplier on the grass + tree billboard
 * shaders. These assert the multiplier scales each layer's base wind uniform.
 * The layers' canvas textures are guarded for headless (`typeof document`), so
 * they construct in the `node` test env.
 */
describe('Wind sway strength', () => {
  const opts = { getCameraZoom: () => 16 };

  it('GrassLayer.setWindStrength scales the wind uniform from its base (0.4)', () => {
    const materials = new StylizedMaterials();
    const grass = new GrassLayer(materials, opts);
    const mat = (grass as unknown as { material: { uniforms: { uWindStrength: { value: number } } } }).material;
    expect(mat.uniforms.uWindStrength.value).toBeCloseTo(0.4); // default mult 1
    grass.setWindStrength(2);
    expect(mat.uniforms.uWindStrength.value).toBeCloseTo(0.8);
    grass.setWindStrength(0);
    expect(mat.uniforms.uWindStrength.value).toBe(0);
    grass.dispose();
    materials.dispose();
  });

  it('TreesLayer.setWindStrength scales the wind uniform from its base (0.12)', () => {
    const materials = new StylizedMaterials();
    const trees = new TreesLayer(materials, opts);
    const mat = (trees as unknown as { material: { uniforms: { uWindStrength: { value: number } } } }).material;
    expect(mat.uniforms.uWindStrength.value).toBeCloseTo(0.12);
    trees.setWindStrength(0.5);
    expect(mat.uniforms.uWindStrength.value).toBeCloseTo(0.06);
    trees.dispose();
    materials.dispose();
  });
});
