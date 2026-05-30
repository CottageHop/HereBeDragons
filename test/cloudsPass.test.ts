import { describe, it, expect } from 'vitest';
import { CloudsPass } from '../src/rendering/CloudsPass.js';

/**
 * The Ghibli cloud look is a preset applied to the CloudsPass. These assert the
 * preset applies to the settings + GPU uniforms and reads back faithfully, and
 * that `null` restores the authored defaults (so a theme swap can't leak the
 * previous look). Runs in the `node` test env — the pass builds a THREE
 * ShaderMaterial with no GL context needed.
 */
describe('CloudsPass preset', () => {
  it('applyPreset drives settings + uniforms; getPreset reads them back', () => {
    const c = new CloudsPass();
    c.applyPreset({
      coverage: 0.42,
      densityScale: 4.6,
      altitudeMin: 650,
      altitudeMax: 1600,
      noiseScale: 0.0011,
      windSpeed: 6,
      cloudColor: '#fff6e6',
      shadowColor: '#b9c6dc'
    });

    const u = c.material.uniforms;
    expect(u.uCoverage.value).toBeCloseTo(0.42);
    expect(u.uDensityScale.value).toBeCloseTo(4.6);
    expect(u.uAltitudeMin.value).toBe(650);
    expect(u.uAltitudeMax.value).toBe(1600);
    expect(u.uNoiseScale.value).toBeCloseTo(0.0011);

    const got = c.getPreset();
    expect(got.coverage).toBeCloseTo(0.42);
    expect(got.altitudeMax).toBe(1600);
    expect(got.windSpeed).toBe(6);
    expect(got.cloudColor.toLowerCase()).toBe('#fff6e6');
    expect(got.shadowColor.toLowerCase()).toBe('#b9c6dc');

    c.dispose();
  });

  it('applyPreset(null) restores the authored defaults', () => {
    const c = new CloudsPass();
    const defaults = c.getPreset();
    c.applyPreset({ coverage: 0.1, densityScale: 7, altitudeMin: 100 });
    expect(c.getPreset().coverage).toBeCloseTo(0.1);
    c.applyPreset(null);
    const back = c.getPreset();
    expect(back.coverage).toBeCloseTo(defaults.coverage as number);
    expect(back.densityScale).toBeCloseTo(defaults.densityScale as number);
    expect(back.altitudeMin).toBe(defaults.altitudeMin);
    c.dispose();
  });
});
