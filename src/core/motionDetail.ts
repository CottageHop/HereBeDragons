/**
 * Motion detail: how much of the at-rest detail to draw while the camera is still moving, 0 (the
 * cheap motion representation) … 1 (full detail). Pure — no THREE, no clock — so it is unit-tested.
 *
 * The idea: detail should come back while a scroll or fling is still slowing down, not after it
 * has stopped. An inertia glide slows by a fixed fraction every frame, so its speed falls
 * exponentially and log(speed) is linear in time. Halfway through the glide IN TIME is therefore
 * the speed halfway between the gesture's peak and the stop speed on a log scale (their geometric
 * mean). Detail starts rising there and reaches 1 as the glide stops, so detail — and with it the
 * frame cost — goes up exactly as the motion goes down.
 *
 * With a hand on the map (a drag in progress) it stays 0: the user is steering. A tiny nudge from
 * rest (peak under twice the stop speed) never drops it at all. A glide that speeds up again
 * (new momentum) falls back to 0 once it is clearly back in the first part of the curve.
 */

export interface MotionDetailState {
  /** Smoothed camera step, CSS px per tick. */
  stepPx: number;
  /** Fastest smoothed step since the camera was last at rest. */
  peakPx: number;
  /** Detail in effect, 0‥1. */
  detail: number;
  /** A gesture had the map in hand on the previous tick. */
  wasLive: boolean;
}

export interface MotionDetailInput {
  /** On-screen camera movement since the previous tick, CSS px. */
  stepPx: number;
  /** A gesture (drag, pinch) has the map in hand. */
  gestureLive: boolean;
  /** The camera has been still long enough to count as at rest. */
  atRest: boolean;
  /** Step at which a glide ends (the controller drops it below this), CSS px per tick. */
  stopPx: number;
}

/** Fraction of the glide's duration (0‥1) at which detail starts to come back. */
export const MOTION_DETAIL_START = 0.5;
/** Below this fraction a glide that sped up again is back to motion detail (hysteresis). */
export const MOTION_DETAIL_DROP = 0.35;

export function createMotionDetail(): MotionDetailState {
  return { stepPx: 0, peakPx: 0, detail: 1, wasLive: false };
}

/** How far through the current glide the camera is, by time, 0‥1. */
export function glideProgress(peakPx: number, stepPx: number, stopPx: number): number {
  if (!(peakPx > 2 * stopPx)) return 1;
  const v = Math.max(stepPx, stopPx);
  const q = Math.log(peakPx / v) / Math.log(peakPx / stopPx);
  return q < 0 ? 0 : q > 1 ? 1 : q;
}

const smoothstep = (t: number): number => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

/** Advance one tick. @returns the detail in effect. */
export function stepMotionDetail(s: MotionDetailState, input: MotionDetailInput): number {
  if (input.atRest) {
    s.stepPx = 0;
    s.peakPx = 0;
    s.detail = 1;
    s.wasLive = false;
    return 1;
  }
  // Light smoothing: a damped glide is already smooth, wheel/trackpad momentum is not.
  s.stepPx = s.stepPx * 0.5 + Math.max(0, input.stepPx) * 0.5;
  s.peakPx = Math.max(s.peakPx, s.stepPx);
  if (input.gestureLive) {
    s.detail = 0;
    s.wasLive = true;
    return 0;
  }
  // A drag just let go: the glide is measured from its release speed, not from how fast the drag
  // once went. (Wheel and trackpad scrolls never show a live gesture at tick time — each event
  // starts and ends inside its handler — so their momentum keeps the peak of the whole scroll.)
  if (s.wasLive) {
    s.peakPx = s.stepPx;
    s.wasLive = false;
  }
  const q = glideProgress(s.peakPx, s.stepPx, input.stopPx);
  if (q < MOTION_DETAIL_DROP) s.detail = 0;
  else s.detail = Math.max(s.detail, smoothstep((q - MOTION_DETAIL_START) / (1 - MOTION_DETAIL_START)));
  return s.detail;
}
