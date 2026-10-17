/**
 * Frame-time governor for the splats overlay. Pure — no THREE, no DOM, no
 * clock of its own (the caller passes `nowMs`), so it is unit-tested in node.
 *
 * Splat rendering cost is, to a very good approximation, LINEAR in the number
 * of resident splats (every one is transformed and rasterised as an instanced
 * quad each frame; on an integrated GPU that vertex work — not fill, not the
 * sort — is what a frame is made of). So the one lever that reliably buys
 * frame time is the resident-splat budget. The governor watches a smoothed
 * frame time WHILE THE PICTURE IS MOVING (camera motion, tiles / ripple
 * animating — idle frames say nothing about cost) and turns two knobs:
 *
 *  1. `scale` — multiplies the configured `maxSplats` budget, `minScale`
 *     (0.25) → `maxScale`. Over target it steps down PROPORTIONALLY to the
 *     overshoot (cost ∝ splats, so `target / smoothed` is the right size of
 *     step, limited to 0.6‥0.9 per step) at most every `stepMs`; the layer
 *     then evicts farthest-first and stops admitting.
 *
 *     `maxScale` defaults to 1, i.e. the configured budget is a ceiling and
 *     the governor can only ever cut. That is safe but one-sided: the number
 *     has to be chosen for the weakest device it will run on, so every device
 *     above that line permanently leaves its headroom unused. Above 1 the
 *     budget becomes a STARTING POINT instead — a device that has held well
 *     under target long enough earns more coverage, by the same evidence rule
 *     and back-off that govern every other raise. Growth is deliberately the
 *     LAST raise: bias, then scale back to 1, then the distance cutoff, and
 *     only once everything is fully restored does the budget go past 1.
 *  2. `biasDrop` — once the scale sits on its floor and frames are STILL over
 *     target for `floorHoldMs`, the effective `lodBias` steps down by 0.5
 *     (to at most −1 from the configured value): coarser tiles, same count.
 *  0. `thinKeep` — FIRST, before anything else, when a `thinLadder` is given:
 *     the fraction of each tile's splats kept while the camera moves (the
 *     survivors grow to keep the surface covered; at rest every splat is back).
 *     It removes splats without removing coverage, and only for frames whose
 *     detail the eye cannot use, so it is the cheapest rung there is.
 *
 * Recovery is deliberately slow and one-sided: a knob is only raised after
 * the smoothed frame time has stayed under `recoverRatio × target` (0.7) for
 * `recoverMs` of MOVING time (4 s) — bias first, then the scale by ×1.25. If
 * a raise is followed by an over-target reading within `regretMs` the raise
 * is judged a mistake: the wait before the next one doubles (up to 60 s).
 * Between "over" and "under 0.7×" nothing moves — that dead band plus the
 * back-off is what keeps it from oscillating around a budget that straddles
 * the target.
 */

export interface GovernorParams {
  /** Frame time to hold while moving, ms. */
  targetFrameMs: number;
  /** Floor of the budget scale. */
  minScale: number;
  /**
   * Ceiling of the budget scale. 1 (the default) means the configured `maxSplats`
   * is a hard ceiling and the governor only ever cuts. Above 1 it may grow the
   * budget on a device that has proven it has headroom — see the note above.
   */
  maxScale: number;
  /**
   * Distance ladder (scene metres) for `splatMaxDistance`, tried BEFORE the budget is cut.
   * Dropping distant relief is a gentler degradation than dropping whole tiles of satellite
   * coverage — the imagery keeps drawing out there either way. `[]` skips this step.
   */
  distanceLadder: number[];
  /**
   * Keep fractions for motion thinning, strictly decreasing, tried FIRST (see `thinKeep`). `[]`
   * (the default) skips the rung; the splats layer passes a ladder when `motionThin` is on.
   */
  thinLadder: number[];
  /**
   * A raw frame over `growHitchRatio x targetFrameMs` counts as a HITCH, and the budget will not
   * grow until `growQuietMs` of moving time has passed without one. Growth is speculative — it
   * spends headroom nobody asked for — so it demands cleaner evidence than recovery, which only
   * gives back what the governor itself took. It matters because `sample()` deliberately clamps
   * `dt` before smoothing, so a burst of long frames barely moves the average the other rules
   * watch: measured on an emulated phone, growing the budget took the worst frame to ~190 ms and
   * 2-3 % janky frames while the median sat unchanged at 17 ms and the EMA never crossed target.
   */
  growHitchRatio: number;
  /**
   * Hitches inside `hitchWindowMs` that count as a slow GPU even while the smoothed frame time
   * sits under target. Measured on an integrated GPU: every depth re-sort stalls the main thread
   * for a GPU→CPU readback that waits for the GPU to drain — 88 ms at 283k resident splats,
   * 120–350 ms at 1.15M — about once per sort interval, with ordinary frames between. The EMA
   * clamps each one (rightly: a lone hitch is a tile upload), so it never reads "over", and the
   * budget stayed at 1.2M through a pan that was 24 % frames over 50 ms. A burst of hitches is
   * not a lone hitch. The threshold sits between a phone's occasional hitch (one every ~500 ms,
   * ~4 per window: growth is withheld but nothing is cut) and the sort-stall storm (one every
   * ~100-130 ms, 15-20 per window). `0` disables the rule.
   */
  hitchBurst: number;
  hitchWindowMs: number;
  growQuietMs: number;
  /** Largest total `lodBias` reduction. */
  maxBiasDrop: number;
  /** One `lodBias` step. */
  biasStep: number;
  /** Least time between two reductions, ms (a change needs time to show). */
  stepMs: number;
  /** Time over target AT the scale floor before the bias steps down, ms. */
  floorHoldMs: number;
  /** Moving time under `recoverRatio × target` before a raise, ms. */
  recoverMs: number;
  recoverRatio: number;
  /** A reduction within this long of a raise doubles the next wait, ms. */
  regretMs: number;
  /** Cap on the backed-off recovery wait, ms. */
  maxRecoverMs: number;
  /** EMA weight of a new sample. */
  alpha: number;
  /** Samples needed before the first decision. */
  warmupSamples: number;
  /** Consecutive over-target readings needed before a reduction — one hitch
   *  (a tile upload, a GC pause) lifts the average for a frame or two. */
  overStreak: number;
}

export const GOVERNOR_DEFAULTS: Readonly<GovernorParams> = Object.freeze({
  targetFrameMs: 33,
  minScale: 0.25,
  maxScale: 1,
  growHitchRatio: 2,
  hitchBurst: 8,
  hitchWindowMs: 2000,
  growQuietMs: 4000,
  distanceLadder: [2000, 1200, 800],
  thinLadder: [],
  maxBiasDrop: 1,
  biasStep: 0.5,
  stepMs: 500,
  floorHoldMs: 1500,
  recoverMs: 4000,
  recoverRatio: 0.7,
  regretMs: 10_000,
  maxRecoverMs: 60_000,
  alpha: 0.15,
  warmupSamples: 8,
  overStreak: 4
});

/** Snapshot for `getSplatsStats()` / the Studio. */
export interface GovernorState {
  /** Whether the governor is switched on. */
  enabled: boolean;
  /** Smoothed moving-frame time, ms (0 before the first sample). */
  frameMs: number;
  targetFrameMs: number;
  /** Budget multiplier in effect, `minScale` ‥ `maxScale`. */
  scale: number;
  /** Ceiling `scale` may grow to; 1 = the governor can only cut. */
  maxScale: number;
  /** `lodBias` reduction in effect, 0 ‥ `maxBiasDrop`. */
  biasDrop: number;
  /** `splatMaxDistance` in effect (scene metres), or 0 when the ladder is untouched. */
  splatMaxDistance: number;
  /** Fraction of splats kept while moving (1 = no thinning). */
  thinKeep: number;
}

export class FrameGovernor {
  private p: GovernorParams;
  private on = true;
  private smoothed = 0;
  private samples = 0;
  private scaleV = 1;
  private biasDropV = 0;
  /** Index into `distanceLadder`; −1 = no cutoff yet. */
  private distanceStep = -1;
  /** Index into `thinLadder`; −1 = no thinning. */
  private thinStep = -1;
  /** Clock time of the last reduction (−∞ = never). */
  private lastStepMs = -Infinity;
  /** Clock time of the last raise. */
  private lastRaiseMs = -Infinity;
  /** Moving time accumulated under the recovery threshold. */
  private underMs = 0;
  /** Moving time accumulated over target while on the scale floor. */
  private floorOverMs = 0;
  /** Clock times of recent hitches, for the burst rule (pruned to `hitchWindowMs`). */
  private hitchTimes: number[] = [];
  /** Consecutive over-target readings. */
  private overRun = 0;
  /** Clock time of the last hitch (a raw frame over `growHitchRatio x target`). */
  private lastHitchMs = -Infinity;
  /** Current (possibly backed-off) recovery wait. */
  private recoverWaitMs: number;

  constructor(params: Partial<GovernorParams> = {}) {
    this.p = { ...GOVERNOR_DEFAULTS, ...params };
    this.recoverWaitMs = this.p.recoverMs;
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Budget multiplier in effect (1 while disabled). */
  get scale(): number {
    return this.on ? this.scaleV : 1;
  }

  /** `lodBias` reduction in effect (0 while disabled). */
  get biasDrop(): number {
    return this.on ? this.biasDropV : 0;
  }

  /** The distance cutoff the governor is asking for; 0 = none. */
  get splatMaxDistance(): number {
    const l = this.p.distanceLadder;
    return this.on && this.distanceStep >= 0 && this.distanceStep < l.length
      ? l[this.distanceStep]
      : 0;
  }

  /** Fraction of splats to keep while the camera moves; 1 = all. */
  get thinKeep(): number {
    const l = this.p.thinLadder;
    return this.on && this.thinStep >= 0 && this.thinStep < l.length ? l[this.thinStep] : 1;
  }

  /**
   * New thinning ladder (`[]` = no thinning rung). A shorter ladder clamps the rung in effect.
   * @returns true if `thinKeep` changed.
   */
  setThinLadder(ladder: readonly number[]): boolean {
    const before = this.thinKeep;
    this.p.thinLadder = [...ladder];
    this.thinStep = Math.min(this.thinStep, this.p.thinLadder.length - 1);
    return this.thinKeep !== before;
  }

  get state(): GovernorState {
    return {
      enabled: this.on,
      frameMs: this.smoothed,
      targetFrameMs: this.p.targetFrameMs,
      scale: this.scale,
      maxScale: Math.max(1, this.p.maxScale),
      biasDrop: this.biasDrop,
      splatMaxDistance: this.splatMaxDistance,
      thinKeep: this.thinKeep
    };
  }

  /** Switch on / off. Off releases both knobs at once. @returns changed. */
  setEnabled(on: boolean): boolean {
    if (on === this.on) return false;
    this.on = on;
    const had = this.scaleV !== 1 || this.biasDropV !== 0 || this.distanceStep >= 0 || this.thinStep >= 0;
    this.reset();
    return had;
  }

  /** New target. A looser target doesn't release anything by itself — the
   *  recovery rule does, on evidence. */
  setTarget(targetFrameMs: number): void {
    if (targetFrameMs > 0 && Number.isFinite(targetFrameMs)) this.p.targetFrameMs = targetFrameMs;
  }

  /**
   * New budget ceiling. Lowering it below the scale currently in effect takes the
   * excess back at once — that growth was only ever lent out on the old ceiling.
   * @returns true if `scale` changed (the layer then re-enforces its budget).
   */
  setMaxScale(maxScale: number): boolean {
    if (!(maxScale > 0) || !Number.isFinite(maxScale)) return false;
    this.p.maxScale = maxScale;
    const ceiling = Math.max(1, maxScale);
    if (this.scaleV <= ceiling) return false;
    this.scaleV = ceiling;
    return this.on;
  }

  /** Forget everything (overlay rebuilt / quality tier changed). */
  reset(): void {
    this.smoothed = 0;
    this.samples = 0;
    this.scaleV = 1;
    this.biasDropV = 0;
    this.distanceStep = -1;
    this.thinStep = -1;
    this.lastStepMs = -Infinity;
    this.lastRaiseMs = -Infinity;
    this.lastHitchMs = -Infinity;
    this.underMs = 0;
    this.floorOverMs = 0;
    this.hitchTimes = [];
    this.overRun = 0;
    this.recoverWaitMs = this.p.recoverMs;
  }

  /**
   * Feed one frame. `dtMs` is the time since the previous RENDERED frame;
   * call it only for frames drawn while the picture was moving and at least
   * one splat tile was resident. @returns true if `scale` or `biasDrop`
   * changed (the layer then re-enforces its budget / re-picks its level).
   */
  sample(dtMs: number, nowMs: number): boolean {
    if (!this.on || !(dtMs > 0) || !Number.isFinite(dtMs)) return false;
    const p = this.p;
    // Note the hitch BEFORE the clamp below hides it — the clamp is what keeps one long frame
    // from looking like a slow GPU, and is exactly why growth needs its own view of the tail.
    const hitch = dtMs > p.targetFrameMs * p.growHitchRatio;
    if (hitch) this.lastHitchMs = nowMs;
    // One hitch (a tile upload, a GC) must not look like a slow GPU.
    const dt = Math.min(dtMs, p.targetFrameMs * 4);
    this.smoothed = this.samples === 0 ? dt : this.smoothed + (dt - this.smoothed) * p.alpha;
    this.samples++;
    if (this.samples < p.warmupSamples) return false;

    // Speculative growth is REVOKED on tail evidence, symmetric to how it is granted. A
    // pre-condition alone cannot work here: the tail is quiet at the smaller budget, so the gate
    // opens, the budget grows, and only then do the long frames appear — the growth is what
    // causes them. Measured on an emulated phone, growth to x2 took the worst frame to 185 ms and
    // 9 % janky frames while the median stayed at 17 ms and the EMA never came near target, so no
    // other rule here would ever have given it back. Only the budget ABOVE the configured one is
    // at stake; at or below x1 the ordinary rules own the decision. `noteReduction` applies the
    // usual regret back-off, so a revoke straight after a grant doubles the wait before the next
    // attempt and the two cannot oscillate.
    if (hitch && this.revokeGrowth(nowMs)) return true;

    // A BURST of hitches is a slow GPU wearing a disguise the EMA cannot see through (see
    // `hitchBurst`): take one ordinary reduction step for it, on the ordinary cadence.
    if (hitch && p.hitchBurst > 0) {
      this.hitchTimes.push(nowMs);
      while (this.hitchTimes.length && nowMs - this.hitchTimes[0] > p.hitchWindowMs) this.hitchTimes.shift();
      if (this.hitchTimes.length >= p.hitchBurst && nowMs - this.lastStepMs >= p.stepMs) {
        this.hitchTimes = [];
        if (this.reduceOneStep(nowMs)) return true;
      }
    }

    const over = this.smoothed > p.targetFrameMs;
    const under = this.smoothed < p.targetFrameMs * p.recoverRatio;

    if (over) {
      this.underMs = 0;
      this.overRun++;
      const atFloor = this.scaleV <= p.minScale + 1e-9;
      if (atFloor) this.floorOverMs += dt;
      if (this.overRun < p.overStreak || nowMs - this.lastStepMs < p.stepMs) return false;
      return this.reduceOneStep(nowMs, Math.min(0.9, Math.max(0.6, p.targetFrameMs / this.smoothed)));
    }

    this.floorOverMs = 0;
    this.overRun = 0;
    if (!under) {
      this.underMs = 0; // the dead band: hold
      return false;
    }
    const ceiling = Math.max(1, p.maxScale);
    if (this.scaleV >= ceiling && this.biasDropV <= 0 && this.distanceStep < 0 && this.thinStep < 0) {
      return false;
    }
    // Nothing is degraded, so the only raise left is speculative growth: hold it back until the
    // tail has been quiet, and let a hitch discard the evidence gathered so far.
    if (this.biasDropV <= 0 && this.scaleV >= 1 && this.distanceStep < 0 && this.thinStep < 0
      && nowMs - this.lastHitchMs < p.growQuietMs) {
      this.underMs = 0;
      return false;
    }
    this.underMs += dt;
    if (this.underMs < this.recoverWaitMs) return false;
    this.underMs = 0;
    this.lastRaiseMs = nowMs;
    if (this.biasDropV > 0) this.biasDropV = Math.max(0, this.biasDropV - p.biasStep);
    else if (this.scaleV < 1) this.scaleV = Math.min(1, this.scaleV * 1.25);
    else if (this.distanceStep >= 0) this.distanceStep--;
    // Thinning was the first rung down, so it is the last one back.
    else if (this.thinStep >= 0) this.thinStep--;
    // Everything is restored and the device is still comfortably under target:
    // spend the headroom on coverage. Last in the order on purpose — never grow
    // the budget while any degradation is still in effect.
    else this.scaleV = Math.min(ceiling, this.scaleV * 1.25);
    // The old average says nothing about the new load — let it re-form
    // before the next decision either way.
    this.samples = 0;
    return true;
  }

  /**
   * A long frame the caller does NOT want counted as draw cost — a tile upload, a level dissolve.
   * It must not move the average (that would ratchet the budget down at every load), but a bigger
   * budget means more resident tiles and therefore more of these, so SPECULATIVE growth still
   * answers for them: this can only give back budget above x1, never cut below it.
   * @returns true if `scale` changed.
   */
  noteHitch(dtMs: number, nowMs: number): boolean {
    if (!this.on || !(dtMs > 0) || !Number.isFinite(dtMs)) return false;
    if (dtMs <= this.p.targetFrameMs * this.p.growHitchRatio) return false;
    this.lastHitchMs = nowMs;
    return this.revokeGrowth(nowMs);
  }

  /**
   * One rung down the degradation ladder: motion thinning first (fewer splats, same coverage,
   * only while moving), then distant relief (the imagery still draws out there, so it costs less
   * of the picture than evicting tiles), then the resident budget by `factor`, then — once on the
   * floor for `floorHoldMs` — a coarser pyramid level.
   * @returns true if anything changed.
   */
  private reduceOneStep(nowMs: number, factor = 0.8): boolean {
    const p = this.p;
    if (this.thinStep < p.thinLadder.length - 1) {
      this.thinStep++;
      this.noteReduction(nowMs);
      return true;
    }
    if (this.distanceStep < p.distanceLadder.length - 1) {
      this.distanceStep++;
      this.noteReduction(nowMs);
      return true;
    }
    const atFloor = this.scaleV <= p.minScale + 1e-9;
    if (!atFloor) {
      this.scaleV = Math.max(p.minScale, this.scaleV * factor);
      this.noteReduction(nowMs);
      return true;
    }
    if (this.floorOverMs >= p.floorHoldMs && this.biasDropV < p.maxBiasDrop - 1e-9) {
      this.biasDropV = Math.min(p.maxBiasDrop, this.biasDropV + p.biasStep);
      this.floorOverMs = 0;
      this.noteReduction(nowMs);
      return true;
    }
    return false;
  }

  /** Step the budget back toward x1 after a hitch. Never digs below the configured budget. */
  private revokeGrowth(nowMs: number): boolean {
    if (this.scaleV <= 1 || nowMs - this.lastStepMs < this.p.stepMs) return false;
    this.scaleV = Math.max(1, this.scaleV / 1.25);
    this.underMs = 0;
    this.noteReduction(nowMs);
    return true;
  }

  private noteReduction(nowMs: number): void {
    this.lastStepMs = nowMs;
    // Had to take back a recent raise → wait twice as long next time.
    if (nowMs - this.lastRaiseMs < this.p.regretMs) {
      this.recoverWaitMs = Math.min(this.p.maxRecoverMs, this.recoverWaitMs * 2);
    }
    // The average was formed under the old load; start it over so one slow
    // stretch is not paid for twice.
    this.samples = 0;
    this.overRun = 0;
  }
}
