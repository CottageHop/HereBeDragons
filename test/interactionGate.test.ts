import { describe, it, expect } from 'vitest';
import { shouldSuspendBuilds, GESTURE_SETTLE_MS } from '../src/controls/interactionGate.js';

/**
 * The interaction tile-priority gate is what makes scroll/zoom stay smooth:
 * it suspends the multi-millisecond tile-mesh build (and its synchronous GPU
 * upload) for as long as a gesture is live, then burst-flushes the backlog the
 * instant motion settles. These assertions pin that contract — the headless
 * bench proved the win (a fast pan went from a 155 ms hitch + 6 dropped frames
 * to a flat 60 fps with zero drops); this keeps the decision logic honest.
 */
describe('shouldSuspendBuilds', () => {
  it('never suspends when the feature is disabled, even mid-gesture', () => {
    expect(shouldSuspendBuilds({ enabled: false, gesturePressed: true, msSinceMotion: 0 })).toBe(false);
    expect(shouldSuspendBuilds({ enabled: false, gesturePressed: false, msSinceMotion: 0 })).toBe(false);
  });

  it('suspends the instant the map is grabbed, before any motion', () => {
    // gesturePressed fires on MapControls `start` — the camera has not moved
    // yet (msSinceMotion is huge), but the gate must already be closed so the
    // very first frame of the gesture is build-free.
    expect(shouldSuspendBuilds({ enabled: true, gesturePressed: true, msSinceMotion: 9999 })).toBe(true);
  });

  it('stays suspended through the inertia glide (within the settle window)', () => {
    expect(shouldSuspendBuilds({ enabled: true, gesturePressed: false, msSinceMotion: 0 })).toBe(true);
    expect(shouldSuspendBuilds({ enabled: true, gesturePressed: false, msSinceMotion: GESTURE_SETTLE_MS - 1 })).toBe(true);
  });

  it('reopens once the camera has been at rest past the settle window', () => {
    expect(shouldSuspendBuilds({ enabled: true, gesturePressed: false, msSinceMotion: GESTURE_SETTLE_MS })).toBe(false);
    expect(shouldSuspendBuilds({ enabled: true, gesturePressed: false, msSinceMotion: 500 })).toBe(false);
  });
});
