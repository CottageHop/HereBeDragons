import { describe, it, expect } from 'vitest';
import { StylizedMaterials } from '../src/materials/StylizedMaterials.js';
import { Palette } from '../src/materials/Palette.js';

/**
 * The Ghibli painterly knobs are driven through StylizedMaterials shader
 * uniforms. These assert the runtime setters actually push the right values
 * onto the cached materials (the uniform objects are created synchronously in
 * the onBeforeCompile attach helpers, so they're observable without a GL
 * context — these run in the `node` test env).
 */
describe('StylizedMaterials Ghibli FX setters', () => {
  it('setPainterlySurface drives the surface wash uniform on flat-fill materials', () => {
    const m = new StylizedMaterials();
    m.setPainterlySurface(0.7);
    const water = m.get(Palette.water);
    const u = water.userData.uPainterlySurface as { value: number };
    expect(u.value).toBeCloseTo(0.7);
    // ground is also a flat surface
    const ground = m.get(Palette.ground);
    expect((ground.userData.uPainterlySurface as { value: number }).value).toBeCloseTo(0.7);
    m.dispose();
  });

  it('setPainterlySurface does NOT add the wash uniform to buildings or roads', () => {
    const m = new StylizedMaterials();
    m.setPainterlySurface(0.9);
    expect(m.get(Palette.building).userData.uPainterlySurface).toBeUndefined();
    expect(m.get(Palette.road_major).userData.uPainterlySurface).toBeUndefined();
    m.dispose();
  });

  it('setRoadTexture drives the cobble/dirt uniform on road + path (not rails)', () => {
    const m = new StylizedMaterials();
    m.setRoadTexture(1);
    expect((m.get(Palette.road_major).userData.uRoadTexture as { value: number }).value).toBe(1);
    expect((m.get(Palette.road_path).userData.uRoadTexture as { value: number }).value).toBe(1);
    // Rails get the fade patch but no road-surfacing uniform.
    expect(m.get(Palette.rail_strip).userData.uRoadTexture).toBeUndefined();
    m.dispose();
  });

  it('setPainterly drives the building painterly uniforms (strength + roof + window)', () => {
    const m = new StylizedMaterials();
    m.setPainterly({ strength: 1, roof: '#b5573c', window: '#ffdc8c', floorHeight: 3.6 });
    const b = m.get(Palette.building);
    expect((b.userData.uPainterly as { value: number }).value).toBe(1);
    expect((b.userData.uFloorHeight as { value: number }).value).toBeCloseTo(3.6);
    // null clears it back to off.
    m.setPainterly(null);
    expect((m.get(Palette.building).userData.uPainterly as { value: number }).value).toBe(0);
    m.dispose();
  });

  it('getPainterly reflects the set building style (round-trips colors)', () => {
    const m = new StylizedMaterials();
    m.setPainterly({ strength: 1, roof: '#b5573c', window: '#ffdc8c', floorHeight: 3.6 });
    const got = m.getPainterly();
    expect(got.strength).toBe(1);
    expect(got.floorHeight).toBeCloseTo(3.6);
    expect(got.roof.toLowerCase()).toBe('#b5573c');
    expect(got.window.toLowerCase()).toBe('#ffdc8c');
    m.dispose();
  });

  it('newly-created materials inherit the current FX strengths', () => {
    const m = new StylizedMaterials();
    m.setPainterlySurface(0.5);
    m.setRoadTexture(0.8);
    // beach + path are created lazily AFTER the setters above.
    expect((m.get(Palette.beach).userData.uPainterlySurface as { value: number }).value).toBeCloseTo(0.5);
    expect((m.get(Palette.road_minor).userData.uRoadTexture as { value: number }).value).toBeCloseTo(0.8);
    m.dispose();
  });
});
