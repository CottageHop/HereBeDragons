import { describe, it, expect } from 'vitest';
import { OutlinePass } from '../src/rendering/OutlinePass.js';

/**
 * The Ghibli theme tunes the illustrated outline (strength/darkness) and color
 * saturation. Those land in OutlinePass.settings and are pushed to the shader
 * by applySettings(). This asserts that plumbing (which the public setOutline →
 * Composer.setOutlineLook delegates to). Runs in the `node` test env — the pass
 * is a plain THREE ShaderMaterial.
 */
describe('OutlinePass settings → uniforms', () => {
  it('applySettings pushes the look settings to the shader uniforms', () => {
    const o = new OutlinePass();
    o.settings.outlineStrength = 0.85;
    o.settings.outlineDarkness = 0.72;
    o.settings.saturation = 1.75;
    o.settings.halftone = 0.5;
    o.settings.hatching = 0.3;
    o.applySettings();

    const u = o.material.uniforms;
    expect(u.uOutlineStrength.value).toBeCloseTo(0.85);
    expect(u.uOutlineDarkness.value).toBeCloseTo(0.72);
    expect(u.uSaturation.value).toBeCloseTo(1.75);
    expect(u.uHalftone.value).toBeCloseTo(0.5);
    expect(u.uHatching.value).toBeCloseTo(0.3);

    o.dispose();
  });
});
