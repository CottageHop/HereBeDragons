import { describe, it, expect } from 'vitest';
import { frontFacing, BACKFACE_FLAT_RATIO } from '../src/splats/backface.js';

// a surfel thin along local z, rotated so z points along +x (90° about y): q = (0, sin45, 0, cos45)
const s = Math.SQRT1_2;
const TO_X: [number, number, number, number] = [0, s, 0, s];
const SURFEL: [number, number, number] = [0.3, 0.3, 0.02];

describe('frontFacing', () => {
  it('keeps a surfel whose outward normal faces the camera and drops one facing away', () => {
    expect(frontFacing([0, 0, 0], SURFEL, TO_X, [100, 5, 50])).toBe(true);
    expect(frontFacing([0, 0, 0], SURFEL, TO_X, [-100, 5, 50])).toBe(false);
  });

  it('uses whichever axis is thinnest', () => {
    // thin along local x, identity rotation: normal +x
    expect(frontFacing([0, 0, 0], [0.02, 0.3, 0.3], [0, 0, 0, 1], [10, 0, 0])).toBe(true);
    expect(frontFacing([0, 0, 0], [0.02, 0.3, 0.3], [0, 0, 0, 1], [-10, 0, 0])).toBe(false);
  });

  it('never drops a blob: crowns and trunks have no side to face', () => {
    const blob: [number, number, number] = [0.9, 0.9, 0.9 * BACKFACE_FLAT_RATIO * 1.5];
    expect(frontFacing([0, 0, 0], blob, TO_X, [-100, 0, 0])).toBe(true);
  });

  it('a roof surfel (normal up) faces a camera above it', () => {
    expect(frontFacing([0, 0, 10], SURFEL, [0, 0, 0, 1], [30, -200, 400])).toBe(true);
  });
});
