import { describe, it, expect } from 'vitest';
import { THEMES, THEME_NAMES, themeToPaletteOverrides } from '../src/themes.js';

/**
 * The `professional` theme is the client-facing preset for real-estate maps.
 * These assert it's registered, carries the expected clean palette, has every
 * Ghibli-FX field deliberately omitted (so applyMergedPalette resets them to
 * off), and derives a sensible palette via themeToPaletteOverrides.
 */
describe('professional theme', () => {
  it('is registered + shows up in THEME_NAMES', () => {
    expect(THEMES.professional).toBeTruthy();
    expect(THEME_NAMES).toContain('professional');
  });

  it('carries a clean neutral palette + a polished outline / highlight', () => {
    const t = THEMES.professional;
    expect(t.land).toBe('#eef0f1');
    expect(t.building).toBe('#dde0e3');
    expect(t.water).toBe('#aac4d6');
    expect(t.saturation).toBe(1.0);
    expect(t.outline?.strength).toBe(0.6);
    expect(t.outline?.darkness).toBe(0.5);
    // Real-estate-grade highlight (a strong blue for picked buildings + floors).
    expect(t.highlight?.building).toBe('#2563eb');
    expect(t.highlight?.floor).toBe('#3b82f6');
  });

  it('omits every Ghibli FX field so applyMergedPalette resets them to off', () => {
    const t = THEMES.professional;
    expect(t.surfacePainterly).toBeUndefined();
    expect(t.roadTexture).toBeUndefined();
    expect(t.spores).toBeUndefined();
    expect(t.buildingStyle).toBeUndefined();
    expect(t.clouds).toBeUndefined();
    expect(t.light).toBeUndefined();
  });

  it('derives a sensible Palette override set', () => {
    const overrides = themeToPaletteOverrides(THEMES.professional);
    expect(overrides.ground).toBe('#eef0f1');
    expect(overrides.building).toBe('#dde0e3');
    expect(overrides.water).toBe('#aac4d6');
    // road_minor is lightened from road; road_path lightened more.
    expect(overrides.road_major).toBe('#c0c2c4');
    expect(overrides.road_minor).toBeTruthy();
    expect(overrides.road_path).toBeTruthy();
    expect(overrides.beach).toBe('#e0d8c4');
  });
});
