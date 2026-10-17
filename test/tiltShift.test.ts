import { describe, it, expect } from 'vitest';
import { TILT_SHIFT_DEFAULTS, clampFocusY, resolveTiltShift, TiltShiftPass } from '../src/rendering/TiltShiftPass.js';

describe('tilt-shift settings', () => {
  it('resolves partial options over the defaults and clamps nonsense', () => {
    expect(resolveTiltShift(undefined)).toEqual(TILT_SHIFT_DEFAULTS);
    const r = resolveTiltShift({ radius: 999, band: -1, saturation: 1.6, contrast: NaN });
    expect(r.radius).toBe(40);
    expect(r.band).toBe(0);
    expect(r.saturation).toBe(1.6);
    expect(r.contrast).toBe(TILT_SHIFT_DEFAULTS.contrast);
    expect(r.falloff).toBe(TILT_SHIFT_DEFAULTS.falloff);
  });

  it('keeps the focus band on screen', () => {
    expect(clampFocusY(0.5)).toBe(0.5);
    expect(clampFocusY(-3)).toBe(0.15);
    expect(clampFocusY(7)).toBe(0.85);
    expect(clampFocusY(NaN)).toBe(0.5);
  });
});

describe('TiltShiftPass', () => {
  it('scales the blur radius by strength and pixel ratio, and is inert at strength 0', () => {
    const p = new TiltShiftPass();
    p.setSize(2000, 1000, 2);
    const u = (p.scene.children[0] as unknown as { material: { uniforms: Record<string, { value: number }> } }).material.uniforms;
    expect(p.getStrength()).toBe(0);
    expect(u.uRadius.value).toBe(0);
    p.setStrength(0.5);
    expect(u.uRadius.value).toBeCloseTo(TILT_SHIFT_DEFAULTS.radius * 2 * 0.5, 6);
    expect(u.uStrength.value).toBe(0.5);
    p.setStrength(5);
    expect(p.getStrength()).toBe(1);
    p.dispose();
  });

  it('configures the two half-res blur passes, then the full-res composite with the grade', () => {
    const p = new TiltShiftPass();
    const mesh = p.scene.children[0] as unknown as { material: { uniforms: Record<string, { value: { x: number; y: number } | number | null }> } };
    p.configureBlur(null as never, 0);
    const blur = mesh.material;
    expect((blur.uniforms.uDir.value as { x: number; y: number }).x).toBe(1);
    p.configureBlur(null as never, 1);
    expect(mesh.material).toBe(blur);
    expect((blur.uniforms.uDir.value as { x: number; y: number }).y).toBe(1);
    p.configureComposite(null as never, null as never);
    expect(mesh.material).not.toBe(blur);
    // one uniforms object behind both materials: the composite sees the same focus/band/grade
    expect(mesh.material.uniforms).toBe(blur.uniforms);
    p.dispose();
  });
});
