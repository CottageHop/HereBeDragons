/**
 * Auto motion resolution — the first, gentle step for a slow GPU behind a HiDPI screen.
 *
 * `quality: 'auto'` cannot name the GPU in Safari (it reports "Apple GPU" on every Mac), so an
 * Intel Iris laptop starts on `'high'`: the plain map at the panel's 2× ratio, ~40 ms a frame
 * while it pans (measured on a 2019 MacBook Pro 13" in WebKit). The only automatic answer used to
 * be the one-shot fall to the flat `'low'` tier below 15 fps. This step comes first: once the
 * map's moving frames stay slow, MOVING frames render at 1× (dynamic resolution) from then on,
 * while the picture at rest stays at the full ratio — the settle dissolves back to it. On a GPU
 * that keeps up nothing changes.
 *
 * Pure decision logic, fed one sample per rendered frame of camera motion (no THREE, no DOM).
 */

/** Rendered motion frames to skip first: shader compiles and the first tile builds are slow once. */
export const AUTO_MOTION_RES_WARMUP_FRAMES = 60;
/** Consecutive slow motion frames (smoothed) before acting — about a second of panning. */
export const AUTO_MOTION_RES_STREAK_FRAMES = 30;
/** Default threshold (ms, smoothed): slower than ~40 fps while moving. */
export const AUTO_MOTION_RES_FRAME_MS = 25;

export interface AutoMotionResState {
  frames: number;
  streak: number;
  /** Decided (either way) — no further samples are looked at. */
  done: boolean;
}

export function createAutoMotionResState(): AutoMotionResState {
  return { frames: 0, streak: 0, done: false };
}

/**
 * One rendered frame of camera motion. Returns true exactly once: when moving frames should
 * render at the motion ratio from now on.
 */
export function stepAutoMotionResolution(
  s: AutoMotionResState,
  smoothedFrameMs: number,
  thresholdMs: number = AUTO_MOTION_RES_FRAME_MS
): boolean {
  if (s.done) return false;
  s.frames++;
  if (s.frames <= AUTO_MOTION_RES_WARMUP_FRAMES) return false;
  if (smoothedFrameMs < thresholdMs) {
    s.streak = 0;
    return false;
  }
  s.streak++;
  if (s.streak < AUTO_MOTION_RES_STREAK_FRAMES) return false;
  s.done = true;
  return true;
}
