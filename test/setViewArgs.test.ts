import { describe, it, expect } from 'vitest';
import { describeArg } from '../src/controls/MapCameraController.js';

/**
 * `setView(lat, lon, zoom?)` is positional. Passing an options object — the natural mistake, and
 * one made twice while testing this library — used to project `undefined`, park the camera at NaN
 * and render nothing, with no error at all. These cover the wording that replaced that silence.
 */
describe('describeArg — what the setView error tells you was passed', () => {
  it('names an object rather than printing [object Object]', () => {
    expect(describeArg({ lat: 1, lon: 2 })).toBe('an object');
    expect(describeArg([1, 2])).toBe('an array');
  });

  it('distinguishes the three empties that all look alike in a template string', () => {
    expect(describeArg(null)).toBe('null');
    expect(describeArg(undefined)).toBe('undefined');
    expect(describeArg(NaN)).toBe('NaN');
  });

  it('shows the actual value for primitives, quoted so an empty string is visible', () => {
    expect(describeArg('35.1')).toBe('string "35.1"');
    expect(describeArg('')).toBe('string ""');
    expect(describeArg(12)).toBe('number 12');
    expect(describeArg(false)).toBe('boolean false');
  });
});
