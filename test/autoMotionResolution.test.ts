import { describe, it, expect } from 'vitest';
import {
  AUTO_MOTION_RES_FRAME_MS,
  AUTO_MOTION_RES_STREAK_FRAMES,
  AUTO_MOTION_RES_WARMUP_FRAMES,
  createAutoMotionResState,
  stepAutoMotionResolution
} from '../src/rendering/autoMotionResolution.js';

const run = (frames: number[], threshold = AUTO_MOTION_RES_FRAME_MS): number => {
  const s = createAutoMotionResState();
  let fired = -1;
  frames.forEach((ms, i) => {
    if (stepAutoMotionResolution(s, ms, threshold)) {
      expect(fired).toBe(-1); // once
      fired = i;
    }
  });
  return fired;
};

describe('auto motion resolution — the slow-GPU step before the flat tier', () => {
  it('never fires on a GPU that keeps up', () => {
    expect(run(Array(600).fill(14))).toBe(-1);
  });

  it('fires once after the warmup and a sustained run of slow moving frames', () => {
    const fired = run(Array(400).fill(40)); // the plain map panning at 2× on an Intel Iris in WebKit
    expect(fired).toBe(AUTO_MOTION_RES_WARMUP_FRAMES + AUTO_MOTION_RES_STREAK_FRAMES - 1);
  });

  it('ignores a slow warmup (shader compiles, first tile builds) and resets on a fast frame', () => {
    const warmup = Array(AUTO_MOTION_RES_WARMUP_FRAMES).fill(120);
    const almost = Array(AUTO_MOTION_RES_STREAK_FRAMES - 1).fill(40);
    expect(run([...warmup, ...almost, 16, ...almost, 16])).toBe(-1);
    expect(run([...warmup, ...almost, 40])).toBe(warmup.length + almost.length);
  });

  it('honours a custom threshold', () => {
    expect(run(Array(400).fill(30), 33)).toBe(-1);
    expect(run(Array(400).fill(30), 25)).toBeGreaterThan(0);
  });
});
