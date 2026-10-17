import { describe, it, expect } from 'vitest';
import { createMotionDetail, glideProgress, stepMotionDetail } from '../src/core/motionDetail.js';

const STOP = 0.25;
const step = (s: ReturnType<typeof createMotionDetail>, px: number, o: { live?: boolean; rest?: boolean } = {}): number =>
  stepMotionDetail(s, { stepPx: px, gestureLive: o.live ?? false, atRest: o.rest ?? false, stopPx: STOP });

describe('motion detail — detail comes back over the second half of a glide', () => {
  it('full detail at rest; none while the map is in hand', () => {
    const s = createMotionDetail();
    expect(step(s, 0, { rest: true })).toBe(1);
    expect(step(s, 6, { live: true })).toBe(0);
    expect(step(s, 6, { live: true })).toBe(0);
  });

  it('a released fling: 0 through the first half of the glide (in time), then up to 1 by the stop', () => {
    const s = createMotionDetail();
    for (let k = 0; k < 10; k++) step(s, 8, { live: true });      // the drag
    const trace: number[] = [];
    for (let v = 8; v >= STOP; v *= 0.95) trace.push(step(s, v)); // MapControls damping, 5 % a tick
    const n = trace.length;
    // first 40 % of the glide: still the motion representation
    expect(Math.max(...trace.slice(0, Math.floor(n * 0.4)))).toBe(0);
    // it has started by 60 % and is complete at the stop
    expect(trace[Math.floor(n * 0.6)]).toBeGreaterThan(0);
    expect(trace[n - 1]).toBeGreaterThan(0.95);
    // and it only ever rises during the glide
    for (let i = 1; i < n; i++) expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1]);
  });

  it('after a drag, the glide is timed from the release speed, not the drag\'s fastest moment', () => {
    const s = createMotionDetail();
    for (let k = 0; k < 10; k++) step(s, 12, { live: true });     // fast drag…
    for (let k = 0; k < 10; k++) step(s, 3, { live: true });      // …slowed before letting go
    const trace: number[] = [];
    for (let v = 3; v >= STOP; v *= 0.95) trace.push(step(s, v));
    const n = trace.length;
    expect(Math.max(...trace.slice(0, Math.floor(n * 0.4)))).toBe(0);
    expect(trace[n - 1]).toBeGreaterThan(0.95);
  });

  it('halfway in time is the geometric mean of peak and stop speed', () => {
    expect(glideProgress(8, Math.sqrt(8 * STOP), STOP)).toBeCloseTo(0.5, 9);
    expect(glideProgress(8, 8, STOP)).toBe(0);
    expect(glideProgress(8, 0.1, STOP)).toBe(1);
  });

  it('a tiny nudge from rest never drops detail', () => {
    const s = createMotionDetail();
    step(s, 0, { rest: true });
    for (let k = 0; k < 20; k++) expect(step(s, 0.3)).toBe(1);
  });

  it('momentum that picks up again goes back to motion detail', () => {
    const s = createMotionDetail();
    for (let v = 8; v >= 0.4; v *= 0.95) step(s, v);
    expect(s.detail).toBeGreaterThan(0.5);
    for (let k = 0; k < 6; k++) step(s, 7);                     // a new flick
    expect(s.detail).toBe(0);
  });
});
