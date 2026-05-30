import { describe, it, expect } from 'vitest';
import { chooseScaleBar } from '../src/studio/ScaleBar.js';
import { Projection } from '../src/core/Projection.js';

const METERS_PER_FOOT = 0.3048;
const TARGET_PX = 90;

describe('chooseScaleBar — metric', () => {
  it('picks a round step that fits inside the target pixel budget', () => {
    // mpp = 1 → 90 m fits; the next step up (100 m) does not.
    const choice = chooseScaleBar(1, TARGET_PX, 'metric');
    expect(choice.distance).toBe(50);
    expect(choice.widthPx).toBe(50);
    expect(choice.label).toBe('50 m');
  });

  it('flips to km past 1000 m', () => {
    // mpp = 200 → 90*200 = 18000 m budget → 10 km step.
    const choice = chooseScaleBar(200, TARGET_PX, 'metric');
    expect(choice.distance).toBe(10_000);
    expect(choice.label).toBe('10 km');
  });

  it('still produces a visible bar at max realistic zoom', () => {
    // Zoom 22 at the equator: ~0.037 m/px → 90 px ≈ 3.4 m. At any
    // realistic camera setting (zoom ≤ 22) the bar resolves to one of
    // the smallest steps (≤ 5 m) and remains visible.
    const mpp = Projection.metersPerPixel(0, 22);
    const choice = chooseScaleBar(mpp, TARGET_PX, 'metric');
    expect(choice.distance).toBeLessThanOrEqual(5);
    expect(choice.widthPx).toBeGreaterThan(0);
  });
});

describe('chooseScaleBar — imperial', () => {
  it('picks feet at street scale', () => {
    // mpp ~= 0.3 → 90 px ≈ 27 m ≈ 88 ft → 50 ft step.
    const choice = chooseScaleBar(0.3, TARGET_PX, 'imperial');
    expect(choice.distance).toBe(50);
    expect(choice.label).toBe('50 ft');
    expect(choice.widthPx).toBeCloseTo((50 * METERS_PER_FOOT) / 0.3, 4);
  });

  it('flips to miles past 5280 ft', () => {
    // mpp ~= 10 → 90 px = 900 m ≈ 2953 ft → 2500 ft step.
    const choice = chooseScaleBar(10, TARGET_PX, 'imperial');
    expect(choice.distance).toBe(2500);
    expect(choice.label).toBe('2500 ft');
  });

  it('renders a 1 mi step at the right pixel width', () => {
    // mpp = 20 → 90 px = 1800 m ≈ 5905 ft → 1 mile step (5280 ft).
    const choice = chooseScaleBar(20, TARGET_PX, 'imperial');
    expect(choice.distance).toBe(5280);
    expect(choice.label).toBe('1 mi');
    const expectedPx = (5280 * METERS_PER_FOOT) / 20;
    expect(choice.widthPx).toBeCloseTo(expectedPx, 4);
  });
});

describe('chooseScaleBar — never overflows the budget across realistic zooms', () => {
  it('chosen widthPx is always ≤ target across the realistic camera range', () => {
    // The camera's zoom range maxes out around 22; below ~zoom 8 the bar
    // would represent a city-sized distance which has no useful meaning
    // for a property map. Within that range, the bar must always fit.
    for (let zoom = 4; zoom <= 21; zoom += 0.5) {
      const mpp = Projection.metersPerPixel(40.71, zoom);
      for (const units of ['metric', 'imperial'] as const) {
        const choice = chooseScaleBar(mpp, TARGET_PX, units);
        // Float-arithmetic slack: allow a sub-pixel overshoot.
        expect(choice.widthPx).toBeLessThanOrEqual(TARGET_PX + 1e-6);
      }
    }
  });
});
