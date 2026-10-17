import { describe, it, expect } from 'vitest';
import {
  DURATION, EASE, approach, clamp01, motionDuration, progress, tauFor
} from '../src/core/motion.js';

describe('motion vocabulary', () => {
  it('every easing maps the unit interval onto itself and is monotonic where it should be', () => {
    for (const [name, f] of Object.entries(EASE)) {
      expect(f(0), name).toBeCloseTo(0, 6);
      expect(f(1), name).toBeCloseTo(1, 6);
      expect(f(-5), name).toBeCloseTo(0, 6);   // clamped, never NaN
      expect(f(9), name).toBeCloseTo(1, 6);
      expect(Number.isFinite(f(NaN)), name).toBe(true);
      if (name !== 'back') {
        for (let t = 0; t < 1; t += 0.1) expect(f(t + 0.1), name).toBeGreaterThanOrEqual(f(t) - 1e-9);
      }
    }
  });

  it('ease-out front-loads the motion; ease-in-out does not; back overshoots', () => {
    expect(EASE.out(0.25)).toBeGreaterThan(0.5);      // a quarter in, over half travelled
    expect(EASE.inOut(0.25)).toBeLessThan(0.25);      // symmetric curve is still accelerating
    expect(EASE.outSoft(0.25)).toBeGreaterThan(0.25);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => EASE.back(i / 49)))).toBeGreaterThan(1);
  });

  it('the duration scale is ordered and coarse', () => {
    expect(DURATION.quick).toBeLessThan(DURATION.base);
    expect(DURATION.base).toBeLessThan(DURATION.slow);
    expect(DURATION.slow).toBeLessThan(DURATION.deliberate);
  });

  it('approach is frame-rate independent: two half-steps ≈ one whole step', () => {
    const tau = 100;
    const one = approach(32, tau);
    let v = 0;
    for (let i = 0; i < 2; i++) v += (1 - v) * approach(16, tau);
    expect(v).toBeCloseTo(one, 3);
    expect(approach(16, 0)).toBe(1);   // zero tau = jump
    expect(approach(-5, tau)).toBe(0); // negative dt does nothing
  });

  it('tauFor settles in about the requested time', () => {
    const tau = tauFor(300);
    let v = 0;
    for (let ms = 0; ms < 300; ms += 16) v += (1 - v) * approach(16, tau);
    expect(v).toBeGreaterThan(0.9);
  });

  it('reduced motion makes durations instant, and progress skips to the end', () => {
    expect(motionDuration(600, false)).toBe(600);
    expect(motionDuration(600, true)).toBe(0);
    expect(progress(0, 0)).toBe(1);            // zero-length = already finished
    expect(progress(150, 300, EASE.linear)).toBeCloseTo(0.5, 6);
    expect(progress(900, 300)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
  });
});
