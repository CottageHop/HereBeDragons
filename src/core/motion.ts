/**
 * The map's motion vocabulary — one place for every easing curve and duration, so animations
 * feel like one system rather than a collection of independently-tuned effects.
 *
 * Two rules, both borrowed from platform UI kits:
 *
 *  - **Entrances and exits ease OUT.** Something arriving should start at full speed and land
 *    softly; a symmetric ease-in-out spends its first third barely moving, which reads as lag on
 *    a short animation. Only continuous, looping motion uses the symmetric curve.
 *  - **Durations come from a scale**, not from per-feature taste. Picking `DURATION.base` keeps
 *    unrelated effects in step even when nobody compares them side by side.
 *
 * Nothing here touches THREE, the DOM or a clock, so it is unit-testable and safe to import
 * anywhere (including workers).
 */

/** Duration scale in milliseconds. Prefer these over literals. */
export const DURATION = {
  /** A state flip the user should barely notice waiting for: toggles, hovers. */
  quick: 200,
  /** The default for most UI transitions: fades, grade changes, level cross-dissolves. */
  base: 350,
  /** Something with distance to travel: a tile growing in, a camera clamp easing out. */
  slow: 600,
  /** A deliberate, watchable reveal — the only tier that should feel like an *event*. */
  deliberate: 900
} as const;

export type DurationName = keyof typeof DURATION;

/** Clamp to the unit interval; every easing below assumes `t` is already in it. */
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : Number.isFinite(t) ? t : 0);

/**
 * Easing curves. All map [0,1] → [0,1] with f(0)=0, f(1)=1 (except `back`, which overshoots on
 * purpose and returns to 1).
 */
export const EASE = {
  /** Linear — only for continuous motion that must not accelerate (a spinning compass). */
  linear: (t: number): number => clamp01(t),
  /** THE default. Fast out of the gate, soft landing (cubic). */
  out: (t: number): number => {
    const x = 1 - clamp01(t);
    return 1 - x * x * x;
  },
  /** Gentler ease-out (quadratic) for small, frequent changes. */
  outSoft: (t: number): number => {
    const x = 1 - clamp01(t);
    return 1 - x * x;
  },
  /** Symmetric — continuous or reversible motion where both ends should be calm. */
  inOut: (t: number): number => {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
  },
  /** Ease-out with a slight overshoot, for a reveal that should feel alive. */
  back: (t: number): number => {
    const x = clamp01(t) - 1;
    const c = 1.70158;
    return 1 + (c + 1) * x * x * x + c * x * x;
  }
} as const;

export type EaseName = keyof typeof EASE;

/**
 * Frame-rate-independent exponential approach: the fraction of the remaining distance to cover
 * this frame, given a time constant. Use for values that chase a moving target (a strength that
 * can be reversed mid-flight) rather than for fixed-length animations.
 *
 * `tauMs` is the time to cover ~63 % of the gap; a value settles visually in about `3 × tau`.
 */
export function approach(dtMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return 1;
  return 1 - Math.exp(-Math.max(dtMs, 0) / tauMs);
}

/** The time constant that makes `approach()` settle in roughly `ms` (≈ ms / 3). */
export const tauFor = (ms: number): number => Math.max(ms, 0) / 3;

/**
 * Whether the user asked for reduced motion. Animations should not merely shorten — they should
 * go straight to the end state, which is what the media query actually asks for.
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A duration adjusted for the user's motion preference: 0 (instant) when reduced motion is on.
 * Pass the preference in so callers can cache it or override it in tests.
 */
export function motionDuration(ms: number, reduced: boolean): number {
  return reduced ? 0 : Math.max(ms, 0);
}

/**
 * Progress through a fixed-length animation, eased. Returns 1 immediately for a zero (or
 * reduced-motion) duration, so callers need no special case for "animations off".
 */
export function progress(elapsedMs: number, durationMs: number, ease: (t: number) => number = EASE.out): number {
  if (!(durationMs > 0)) return 1;
  return ease(clamp01(elapsedMs / durationMs));
}
