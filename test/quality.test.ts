import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveQualityProfile, isMobileDevice, detectGpuTier } from '../src/rendering/quality.js';

/**
 * The `'mobile'` tier is the ceiling for phone-class GPUs (e.g. an iPhone 8):
 * it must keep the real-estate essentials (3D buildings, labels) while dropping
 * the cinematic dressing and the memory-hungry underlay, and cap the pixel
 * ratio. These assertions pin that contract so a future profile tweak can't
 * silently turn the phone tier back into something a 2 GB device can't run.
 */
describe('mobile quality profile', () => {
  it('resolves the mobile tier when forced', () => {
    const p = resolveQualityProfile('mobile');
    expect(p.level).toBe('mobile');
  });

  it('keeps 3D buildings + labels but drops the cinematic FX', () => {
    const p = resolveQualityProfile('mobile');
    expect(p.flatBuildings).toBe(false); // 3D buildings KEPT — it's a 3D realty map
    expect(p.labels).toBe(true); // street/place labels KEPT
    expect(p.clouds).toBe(false); // raymarch dropped
    expect(p.outlines).toBe(false); // sketch outline pipeline dropped
    expect(p.ambientFX).toBe(false); // trees/grass/waves/signs/cars/painterly dropped
  });

  it('caps pixel ratio below retina and drops the underlay to save memory', () => {
    const p = resolveQualityProfile('mobile');
    expect(p.pixelRatioCap).toBeLessThanOrEqual(1.5);
    expect(p.pixelRatioCap).toBeGreaterThan(1); // still crisper than the 'low' floor
    expect(p.underlay).toBe(false); // ~10–30 MB saved on a 2 GB device
    expect(p.msaaSamples).toBe(0);
    expect(p.fxaa).toBe(true); // cheap edge AA kept for legibility
  });

  it('allows a tilt (3D) but caps it, unlike the top-down low tier', () => {
    const mobile = resolveQualityProfile('mobile');
    const low = resolveQualityProfile('low');
    expect(mobile.maxTilt).toBeGreaterThan(0);
    expect(low.maxTilt).toBe(0);
  });

  it('keeps full building detail (no tile zoom offset)', () => {
    expect(resolveQualityProfile('mobile').tileZoomOffset).toBe(0);
  });

  it('low/high tiers do NOT force ambient FX off (only mobile does)', () => {
    expect(resolveQualityProfile('high').ambientFX).toBeUndefined();
    expect(resolveQualityProfile('low').ambientFX).toBeUndefined();
  });
});

describe('mobile device detection', () => {
  const ua = (s: string): void => {
    vi.stubGlobal('navigator', { userAgent: s, platform: 'iPhone', maxTouchPoints: 5 });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects an iPhone user-agent as mobile', () => {
    ua('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
    expect(isMobileDevice()).toBe(true);
  });

  it('detects an Android user-agent as mobile', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7)' });
    expect(isMobileDevice()).toBe(true);
  });

  it('does not flag a plain desktop user-agent', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      platform: 'MacIntel',
      maxTouchPoints: 0
    });
    // matchMedia/window are undefined under the node test env, so the fallback
    // heuristic can't fire — a desktop UA should resolve to false.
    expect(isMobileDevice()).toBe(false);
  });

  it('auto GPU detection short-circuits to mobile on a phone', () => {
    ua('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)');
    expect(detectGpuTier()).toBe('mobile');
  });
});
