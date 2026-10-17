/**
 * Pure maths for the splat overlay's "ripple" reveal. No THREE, no DOM —
 * the same formulas are mirrored in GLSL (Spark dyno modifier for the
 * splats, a small ShaderMaterial for the imagery ground) and unit-tested
 * here.
 *
 * Model: an expanding circular front of radius R(t) = speed · t centred on
 * `origin` (scene x/z). A splat at horizontal distance `d` from the origin
 *
 *   - is COLLAPSED (scale 0, opacity 0) while d > R,
 *   - GROWS from 0 → 1 over the `ringWidth` metres just behind the front,
 *     overshooting to ~1.35× midway so the front visibly "pops",
 *   - carries a ±10 % sine ring that rides the front (the ripple itself),
 *   - settles at exactly 1 once the front is more than `ringWidth` past it.
 *
 * Disable plays the same animation backwards (R shrinks from speed·duration
 * to 0) and the tiles are unloaded once the front reaches the origin.
 */

export type RippleDirection = 'in' | 'out';

/** Front speed in scene metres per second. */
export const DEFAULT_RIPPLE_SPEED_MPS = 250;
/** Total animation length in milliseconds. */
export const DEFAULT_RIPPLE_DURATION_MS = 1800;
/** Width of the grow / ring band just behind the front, in metres. */
export const DEFAULT_RIPPLE_RING_WIDTH_M = 40;
/** Peak overshoot of the grow envelope (0.35 → splats reach ≈1.35× just
 *  behind the front before settling to 1). */
export const RIPPLE_OVERSHOOT = 0.35;
/** "Back" easing coefficient that produces `RIPPLE_OVERSHOOT` (see
 *  `rippleEnvelope`; c1 = 3.75 ⇒ peak ≈ 1.35). */
export const RIPPLE_BACK_C1 = 3.75;
/** Amplitude of the sine ring that rides the front (±10 %). */
export const RIPPLE_RING_AMPLITUDE = 0.1;
/** Angular speed (rad/s) of the ring's shimmer — a slow phase drift so the
 *  ring reads as alive rather than as a static contour. */
export const RIPPLE_RING_PHASE_RATE = 6;

export interface RippleParams {
  durationMs: number;
  speedMps: number;
  ringWidthM: number;
}

export const DEFAULT_RIPPLE_PARAMS: Readonly<RippleParams> = Object.freeze({
  durationMs: DEFAULT_RIPPLE_DURATION_MS,
  speedMps: DEFAULT_RIPPLE_SPEED_MPS,
  ringWidthM: DEFAULT_RIPPLE_RING_WIDTH_M
});

/** Fill in defaults for a partial ripple spec (NaN / non-positive → default). */
export function resolveRippleParams(
  p: Partial<Pick<RippleParams, 'durationMs' | 'speedMps'>> & { ringWidthM?: number } = {}
): RippleParams {
  const pick = (v: number | undefined, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  return {
    durationMs: pick(p.durationMs, DEFAULT_RIPPLE_DURATION_MS),
    speedMps: pick(p.speedMps, DEFAULT_RIPPLE_SPEED_MPS),
    ringWidthM: pick(p.ringWidthM, DEFAULT_RIPPLE_RING_WIDTH_M)
  };
}

/** Radius the front reaches at the end of the animation (metres). */
export function rippleMaxRadius(p: RippleParams): number {
  return (p.speedMps * p.durationMs) / 1000;
}

/**
 * Front radius (metres) `elapsedMs` into the animation. `'in'` expands from
 * 0, `'out'` contracts from `rippleMaxRadius` to 0. Clamped to
 * `[0, durationMs]` so the value is well-defined before the start and after
 * the end.
 */
export function rippleFrontRadius(
  elapsedMs: number,
  p: RippleParams,
  dir: RippleDirection = 'in'
): number {
  const t = Math.min(Math.max(elapsedMs, 0), p.durationMs);
  const grown = (p.speedMps * t) / 1000;
  return dir === 'in' ? grown : rippleMaxRadius(p) - grown;
}

export function isRippleFinished(elapsedMs: number, p: RippleParams): boolean {
  return elapsedMs >= p.durationMs;
}

/**
 * Reveal fraction in `[0, 1]` for a point `d` metres from the origin when
 * the front is at `R`: 0 beyond the front, smoothstep to 1 across the band
 * of width `w` behind it. This is the splat OPACITY factor and the imagery
 * ground's alpha.
 */
export function rippleReveal(d: number, R: number, w: number): number {
  const s = Math.min(Math.max((R - d) / w, 0), 1);
  return s * s * (3 - 2 * s);
}

/**
 * "Back"-eased grow envelope: 0 at `g = 0`, overshoots to ≈ 1 + OVERSHOOT
 * around `g ≈ 0.5`, settles to exactly 1 at `g = 1`. (easeOutBack with
 * c1 = RIPPLE_BACK_C1, c3 = c1 + 1.)
 */
export function rippleEnvelope(g: number): number {
  const c1 = RIPPLE_BACK_C1;
  const c3 = c1 + 1;
  const u = g - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/**
 * Scale factor (≥ 0) for a splat `d` metres from the origin when the front
 * is at `R` with band width `w`, `tSec` seconds into the animation:
 *
 *   envelope(grow)  +  ring · grow
 *
 * where `grow` is `rippleReveal(d, R, w)`, `envelope` the overshooting
 * back-ease above, and `ring` a ±10 % sine wave across the band (zero
 * outside it). Exactly 0 beyond the front, exactly 1 once the front is > `w`
 * past the splat.
 */
export function rippleScale(d: number, R: number, w: number, tSec = 0): number {
  const grow = rippleReveal(d, R, w);
  const overshoot = rippleEnvelope(grow);
  const band = (R - d) / w;
  const ring =
    Math.abs(band) < 1
      ? RIPPLE_RING_AMPLITUDE * Math.sin(2 * Math.PI * band - RIPPLE_RING_PHASE_RATE * tSec)
      : 0;
  return Math.max(0, overshoot + ring * grow);
}

/** Alias for the opacity envelope (same curve as the reveal fraction). */
export function rippleOpacity(d: number, R: number, w: number): number {
  return rippleReveal(d, R, w);
}

/**
 * Brightness multiplier for the imagery ground: a single positive lobe just
 * inside the front so the ring reads as a bright wave sweeping the ground.
 */
export function rippleGroundBrightness(d: number, R: number, w: number): number {
  const band = (R - d) / w;
  if (band <= 0 || band >= 1) return 1;
  return 1 + 4 * RIPPLE_RING_AMPLITUDE * Math.sin(Math.PI * band);
}
