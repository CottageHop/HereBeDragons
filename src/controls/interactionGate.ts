/**
 * Interaction tile-priority gate — the pure decision logic behind the
 * `interactionTilePriority` option (scroll/zoom smoothness over tile loading).
 *
 * Building a decoded tile into a mesh forces a synchronous GPU buffer upload on
 * the next render — a multi-millisecond main-thread spike. The gate suspends
 * that construction for as long as a gesture is "live," so a pan/zoom never
 * competes with an upload. Decode + dispatch keep running, so the backlog is
 * ready to burst-drain the instant motion settles.
 *
 * This module is the framework-free heart of that policy: no THREE, no DOM, no
 * timers — just the two decisions (suspend? / settle edge?) so the contract can
 * be unit-tested without a GL context. The RAF loop in HereBeDragons feeds it
 * live state each frame and acts on the result.
 */

/**
 * How long after the last camera motion to keep suspending builds, so the
 * damping inertia glide that trails a fling stays build-free. Shorter than the
 * dynamic-resolution settle (180 ms): builds should resume promptly once the
 * camera is genuinely at rest so tiles snap in fast, but not so soon that the
 * sub-frame gaps between damping steps reopen the gate mid-glide.
 */
export const GESTURE_SETTLE_MS = 90;

export interface GateInput {
  /** Whether the feature is enabled at all (the `interactionTilePriority` option). */
  enabled: boolean;
  /**
   * Whether the map is physically grabbed right now — between a MapControls
   * `start` and `end` (pointer-drag, pinch, or wheel). True even before the
   * camera has moved, so the gate closes on frame one of a gesture.
   */
  gesturePressed: boolean;
  /** Milliseconds since the camera last actually moved (covers the inertia glide). */
  msSinceMotion: number;
}

/**
 * Should tile-mesh construction be suspended this frame? True while a gesture
 * is live: the map is grabbed, or it moved within the settle window. When it
 * falls back to false, the suspended backlog drains a couple of tiles per
 * frame (TileManager's per-frame build cap), so the catch-up spreads across
 * frames rather than spiking the settle render.
 */
export function shouldSuspendBuilds(s: GateInput): boolean {
  if (!s.enabled) return false;
  return s.gesturePressed || s.msSinceMotion < GESTURE_SETTLE_MS;
}
