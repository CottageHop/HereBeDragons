import { describe, it, expect } from 'vitest';
import { SceneRoot } from '../src/scene/SceneRoot.js';

/**
 * The Ghibli golden-hour rig is a light preset applied to the SceneRoot. These
 * assert it drives the actual THREE lights and reads back faithfully, and that
 * `null` restores the authored defaults. Runs in the `node` test env — the
 * scene + lights + ground are all plain THREE objects (no GL context).
 */
describe('SceneRoot light preset', () => {
  it('applyLightPreset drives the lights; getLightPreset reads them back', () => {
    const s = new SceneRoot();
    s.applyLightPreset({
      sun: '#fff0cf',
      sunIntensity: 1.08,
      fillIntensity: 0.14,
      ambientIntensity: 0.07,
      hemiSky: '#bfe2f6',
      hemiGround: '#e6d4a6',
      hemiIntensity: 0.34
    });
    const lp = s.getLightPreset();
    expect(lp.sun.toLowerCase()).toBe('#fff0cf');
    expect(lp.sunIntensity).toBeCloseTo(1.08);
    expect(lp.fillIntensity).toBeCloseTo(0.14);
    expect(lp.ambientIntensity).toBeCloseTo(0.07);
    expect(lp.hemiSky.toLowerCase()).toBe('#bfe2f6');
    expect(lp.hemiGround.toLowerCase()).toBe('#e6d4a6');
    expect(lp.hemiIntensity).toBeCloseTo(0.34);
    s.dispose();
  });

  it('applyLightPreset(null) restores the authored defaults', () => {
    const s = new SceneRoot();
    const defaults = s.getLightPreset();
    s.applyLightPreset({ sunIntensity: 0.2, hemiIntensity: 0.9 });
    expect(s.getLightPreset().sunIntensity).toBeCloseTo(0.2);
    s.applyLightPreset(null);
    const back = s.getLightPreset();
    expect(back.sunIntensity).toBeCloseTo(defaults.sunIntensity as number);
    expect(back.hemiIntensity).toBeCloseTo(defaults.hemiIntensity as number);
    expect(back.sun.toLowerCase()).toBe((defaults.sun as string).toLowerCase());
    s.dispose();
  });
});
