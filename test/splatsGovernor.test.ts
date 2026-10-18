import { describe, it, expect } from 'vitest';
import { FrameGovernor, GOVERNOR_DEFAULTS } from '../src/splats/governor.js';
import {
  type ViewFrame,
  OFFSCREEN_PENALTY,
  rankTilesByRelevance,
  tileCentreDist2,
  tileScreenRelevance,
  viewFocus
} from '../src/splats/lod.js';
import { enumerateTileWindow } from '../src/splats/transform.js';
import { LayerRegistry } from '../src/scene/LayerRegistry.js';
import type { Layer } from '../src/layers/Layer.js';
import * as THREE from 'three';
import { GrassLayer } from '../src/layers/GrassLayer.js';
import { TreesLayer } from '../src/layers/TreesLayer.js';
import { WavesLayer } from '../src/layers/WavesLayer.js';
import { StylizedMaterials } from '../src/materials/StylizedMaterials.js';

/** Feed `ms` of frames of `dt` each; returns how often a knob moved. */
function run(g: FrameGovernor, clock: { now: number }, dt: number, ms: number): number {
  let changes = 0;
  for (let t = 0; t < ms; t += dt) {
    clock.now += dt;
    if (g.sample(dt, clock.now)) changes++;
  }
  return changes;
}

describe('FrameGovernor', () => {
  it('leaves everything alone at or under the target', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    expect(run(g, clock, 30, 20_000)).toBe(0);
    expect(g.state).toMatchObject({ enabled: true, scale: 1, biasDrop: 0, targetFrameMs: 33 });
    expect(g.state.frameMs).toBeCloseTo(30, 6);
  });

  it('cut-only by default: comfortable frames never grow the budget past 1', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    // Far under target for a long time — with the default ceiling of 1 there is nothing to raise.
    expect(run(g, clock, 8, 120_000)).toBe(0);
    expect(g.state).toMatchObject({ scale: 1, maxScale: 1 });
  });

  it('budgetGrowth: a device with headroom earns budget in x1.25 steps up to the ceiling', () => {
    const g = new FrameGovernor({ maxScale: 2 });
    const clock = { now: 0 };
    expect(g.state.maxScale).toBe(2);
    // 8 ms frames = well under 0.7 x 33. Each x1.25 step costs recoverMs of MOVING time.
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = g.scale;
      while (g.scale === before && clock.now < 600_000) { clock.now += 8; g.sample(8, clock.now); }
      if (g.scale !== before) seen.push(Number(g.scale.toFixed(4)));
    }
    expect(seen.slice(0, 3)).toEqual([1.25, 1.5625, 1.9531]);
    expect(g.scale).toBe(2);                       // clamped at the ceiling, not past it
    expect(run(g, clock, 8, 60_000)).toBe(0);      // and it stops asking once there
  });

  it('budgetGrowth: growth is the LAST raise — never while a degradation is still in effect', () => {
    const g = new FrameGovernor({ maxScale: 3 });
    const clock = { now: 0 };
    // Drive it all the way down: distance ladder, then budget floor, then the bias drop.
    while (g.biasDrop === 0 && clock.now < 400_000) { clock.now += 66; g.sample(66, clock.now); }
    expect(g.biasDrop).toBeGreaterThan(0);
    expect(g.scale).toBeCloseTo(GOVERNOR_DEFAULTS.minScale, 6);
    expect(g.splatMaxDistance).toBeGreaterThan(0);
    // Now hand it easy frames and watch the order: bias first, then scale back to exactly 1,
    // then the cutoff released — and only after all of that does the budget go above 1.
    const order: string[] = [];
    let prev = { b: g.biasDrop, s: g.scale, d: g.splatMaxDistance };
    while ((g.scale <= 1 || g.splatMaxDistance !== 0 || g.biasDrop !== 0) && clock.now < 900_000) {
      clock.now += 8;
      if (!g.sample(8, clock.now)) continue;
      if (g.biasDrop !== prev.b) order.push('bias');
      else if (g.scale !== prev.s) order.push(g.scale > 1 ? 'grow' : 'scale');
      else if (g.splatMaxDistance !== prev.d) order.push('distance');
      prev = { b: g.biasDrop, s: g.scale, d: g.splatMaxDistance };
    }
    // Every bias raise precedes every scale raise, which precedes every distance release,
    // and 'grow' only ever appears once the cutoff is gone.
    expect(order.indexOf('grow')).toBeGreaterThan(order.lastIndexOf('distance'));
    expect(order.lastIndexOf('distance')).toBeGreaterThan(order.lastIndexOf('scale'));
    expect(order.lastIndexOf('scale')).toBeGreaterThan(order.lastIndexOf('bias'));
    expect(g.splatMaxDistance).toBe(0);
    expect(g.scale).toBeGreaterThan(1);
  });

  // 70 ms is the discriminating hitch size: over growHitchRatio x target (66) so the growth gate
  // sees it, but small enough that the EMA stays under 0.7 x target — so it does NOT trip the
  // pre-existing dead band, and these tests isolate the new gate instead of that older rule.
  const HITCH = 70;

  it('growth waits for a quiet tail: hitches block it even while the median is fine', () => {
    const g = new FrameGovernor({ maxScale: 2 });
    const clock = { now: 0 };
    // The phone case: median far under target, but a hitch every so often. The EMA never crosses
    // target (the clamp sees to that), so nothing looks degraded — and growth must still hold off.
    for (let i = 0; i < 4000; i++) {
      clock.now += 8;
      g.sample(i % 60 === 59 ? HITCH : 8, clock.now);
    }
    expect(g.scale).toBe(1);
    expect(g.state.frameMs).toBeLessThan(GOVERNOR_DEFAULTS.targetFrameMs * GOVERNOR_DEFAULTS.recoverRatio);
    // Take the hitches away and the same frames now earn the growth.
    while (g.scale === 1 && clock.now < 400_000) { clock.now += 8; g.sample(8, clock.now); }
    expect(g.scale).toBeCloseTo(1.25, 6);
  });

  it('a hitch discards the evidence gathered so far, it does not merely pause it', () => {
    const g = new FrameGovernor({ maxScale: 2 });
    const clock = { now: 0 };
    // Almost enough quiet time to earn a step...
    for (let t = 0; t < GOVERNOR_DEFAULTS.recoverMs - 200; t += 8) { clock.now += 8; g.sample(8, clock.now); }
    expect(g.scale).toBe(1);
    clock.now += 8; g.sample(HITCH, clock.now);        // ...then one hitch
    // A mere pause would let the next 200 ms finish the job; a discard needs the full wait again.
    for (let t = 0; t < 1000; t += 8) { clock.now += 8; g.sample(8, clock.now); }
    expect(g.scale).toBe(1);
    while (g.scale === 1 && clock.now < 400_000) { clock.now += 8; g.sample(8, clock.now); }
    expect(g.scale).toBeCloseTo(1.25, 6);
  });

  it('the hitch gate does not hold back RECOVERY — only speculative growth', () => {
    const g = new FrameGovernor({ distanceLadder: [] });
    const clock = { now: 0 };
    while (g.scale === 1 && clock.now < 200_000) { clock.now += 66; g.sample(66, clock.now); }
    const cut = g.scale;
    expect(cut).toBeLessThan(1);
    // The SAME hitch cadence that blocks growth above must not stop the governor giving back
    // budget it took: recovery is restorative, growth is speculative.
    let raised = false;
    for (let i = 0; i < 6000 && !raised; i++) {
      clock.now += 8;
      if (g.sample(i % 60 === 59 ? HITCH : 8, clock.now) && g.scale > cut) raised = true;
    }
    expect(raised).toBe(true);
  });

  it('revokes growth when the tail goes bad — the case a pre-condition cannot catch', () => {
    const g = new FrameGovernor({ maxScale: 2 });
    const clock = { now: 0 };
    // Quiet tail: the budget grows, exactly as intended.
    while (g.scale < 2 && clock.now < 600_000) { clock.now += 8; g.sample(8, clock.now); }
    expect(g.scale).toBe(2);
    // Now the bigger budget starts producing long frames — while the MEDIAN stays fine, so the
    // EMA never crosses target and no other rule in here would ever give the budget back.
    for (let i = 0; i < 3000 && g.scale > 1; i++) {
      clock.now += 8;
      g.sample(i % 60 === 59 ? HITCH : 8, clock.now);
    }
    expect(g.scale).toBe(1);
    expect(g.state.frameMs).toBeLessThan(GOVERNOR_DEFAULTS.targetFrameMs);
  });

  it('revoking never digs below x1 — the ordinary rules own that region', () => {
    const g = new FrameGovernor({ maxScale: 2 });
    const clock = { now: 0 };
    // A hitchy tail from the very start: there is no speculative growth to take back, so the
    // budget must sit at 1 rather than being cut by the tail rule.
    for (let i = 0; i < 4000; i++) { clock.now += 8; g.sample(i % 40 === 39 ? HITCH : 8, clock.now); }
    expect(g.scale).toBe(1);
  });

  it('a revoke backs off the next attempt, so grant and revoke cannot oscillate', () => {
    const g = new FrameGovernor({ maxScale: 2 });
    const clock = { now: 0 };
    const earnOneStep = (): number => {
      const t0 = clock.now;
      while (g.scale === 1 && clock.now - t0 < 600_000) { clock.now += 8; g.sample(8, clock.now); }
      return clock.now - t0;
    };
    const firstWait = earnOneStep();
    expect(g.scale).toBeCloseTo(1.25, 6);
    // A grant resets the sample count, so the governor needs its warm-up back before it will act
    // on anything — feed that, then the hitch.
    for (let i = 0; i < GOVERNOR_DEFAULTS.warmupSamples; i++) { clock.now += 8; g.sample(8, clock.now); }
    clock.now += 8; g.sample(HITCH, clock.now);
    expect(g.scale).toBe(1);
    expect(earnOneStep()).toBeGreaterThan(firstWait);  // regret back-off doubled the wait
  });

  it('setMaxScale takes back growth it had lent out on the old ceiling', () => {
    const g = new FrameGovernor({ maxScale: 2 });
    const clock = { now: 0 };
    while (g.scale < 2 && clock.now < 600_000) { clock.now += 8; g.sample(8, clock.now); }
    expect(g.scale).toBe(2);
    expect(g.setMaxScale(1.5)).toBe(true);
    expect(g.scale).toBe(1.5);
    expect(g.setMaxScale(1)).toBe(true);
    expect(g.scale).toBe(1);
    expect(g.setMaxScale(2)).toBe(false);   // raising the ceiling alone changes nothing
    expect(g.scale).toBe(1);                // the growth must be earned again
  });

  it('walks the distance ladder BEFORE touching the budget', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    const ladder = GOVERNOR_DEFAULTS.distanceLadder;
    expect(g.splatMaxDistance).toBe(0);
    // Distant relief goes first: the imagery still draws out there, so it costs less of the
    // picture than evicting whole tiles of coverage.
    for (const want of ladder) {
      while (g.splatMaxDistance !== want) { clock.now += 66; g.sample(66, clock.now); }
      expect(g.scale).toBe(1);            // budget untouched while the ladder has room
    }
    expect(g.splatMaxDistance).toBe(ladder[ladder.length - 1]);
    // Only once the ladder is exhausted does the budget start shrinking.
    while (g.scale === 1) { clock.now += 66; g.sample(66, clock.now); }
    expect(g.scale).toBeCloseTo(0.6, 6);
  });

  it('motion thinning is the FIRST rung: the whole thin ladder before distance or budget', () => {
    const thin = [0.7, 0.5, 0.35];
    const g = new FrameGovernor({ thinLadder: thin });
    const clock = { now: 0 };
    expect(g.thinKeep).toBe(1);
    for (const want of thin) {
      while (g.thinKeep !== want) { clock.now += 66; g.sample(66, clock.now); }
      expect(g.splatMaxDistance).toBe(0);   // no distant relief lost yet
      expect(g.scale).toBe(1);              // and no tile evicted
    }
    // Only then the distance ladder, with the thinning held where it is.
    while (g.splatMaxDistance === 0) { clock.now += 66; g.sample(66, clock.now); }
    expect(g.thinKeep).toBe(0.35);
    expect(g.state.thinKeep).toBe(0.35);
  });

  it('thinning is the last rung back, before any speculative growth', () => {
    const g = new FrameGovernor({ thinLadder: [0.5], distanceLadder: [800] });
    const clock = { now: 0 };
    while (g.splatMaxDistance === 0) { clock.now += 66; g.sample(66, clock.now); }
    expect(g.thinKeep).toBe(0.5);
    const order: string[] = [];
    for (let t = 0; t < 20_000; t += 16) {
      clock.now += 16;
      if (g.sample(16, clock.now)) order.push(`${g.splatMaxDistance}/${g.thinKeep}`);
    }
    expect(order).toEqual(['0/0.5', '0/1']);
  });

  it('no thin ladder (the default) is exactly the old behaviour; setThinLadder clamps the rung', () => {
    expect(GOVERNOR_DEFAULTS.thinLadder).toEqual([]);
    const g = new FrameGovernor({ thinLadder: [0.7, 0.5] });
    const clock = { now: 0 };
    while (g.thinKeep !== 0.5) { clock.now += 66; g.sample(66, clock.now); }
    expect(g.setThinLadder([0.7])).toBe(true);
    expect(g.thinKeep).toBe(0.7);
    expect(g.setThinLadder([])).toBe(true);
    expect(g.thinKeep).toBe(1);
    // nothing is degraded any more, so switching off has nothing to release
    expect(g.setEnabled(false)).toBe(false);
  });

  it('over target: scales the budget down proportionally, at most every 500 ms, to the 0.25 floor', () => {
    const g = new FrameGovernor({ distanceLadder: [] }); // isolate the budget step
    const clock = { now: 0 };
    // 66 ms frames = twice the target → the first step takes the full 0.6.
    clock.now += 0;
    let first = 0;
    while (g.scale === 1) { clock.now += 66; g.sample(66, clock.now); first++; }
    // Not before the average has formed and the overshoot has persisted.
    expect(first).toBeGreaterThanOrEqual(GOVERNOR_DEFAULTS.warmupSamples);
    expect(first).toBeLessThan(GOVERNOR_DEFAULTS.warmupSamples + GOVERNOR_DEFAULTS.overStreak + 1);
    expect(g.scale).toBeCloseTo(0.6, 6);
    // A mild overshoot takes a mild step (≤ 0.9), and never within 500 ms of the last.
    const t0 = clock.now;
    while (g.scale > 0.59) { clock.now += 36; g.sample(36, clock.now); }
    expect(clock.now - t0).toBeGreaterThanOrEqual(GOVERNOR_DEFAULTS.stepMs);
    expect(g.scale).toBeCloseTo(0.6 * 0.9, 6);
    run(g, clock, 80, 20_000);
    expect(g.scale).toBe(GOVERNOR_DEFAULTS.minScale);
  });

  it('still over on the floor: steps the lodBias down by 0.5, to −1 at most', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    const steps: Array<[number, number]> = [];
    for (let t = 0; t < 40_000; t += 80) {
      clock.now += 80;
      if (g.sample(80, clock.now)) steps.push([g.scale, g.biasDrop]);
    }
    // The bias is only touched once the scale is on its floor…
    const firstDrop = steps.findIndex(([, b]) => b > 0);
    expect(steps.slice(0, firstDrop).every(([, b]) => b === 0)).toBe(true);
    expect(steps[firstDrop - 1][0]).toBe(0.25);
    // …then in two steps, and no further.
    expect(steps.slice(firstDrop)).toEqual([[0.25, 0.5], [0.25, 1]]);
    expect(g.state).toMatchObject({ scale: 0.25, biasDrop: 1 });
  });

  it('holds in the dead band between 0.7 × target and target', () => {
    const g = new FrameGovernor({ distanceLadder: [] });
    const clock = { now: 0 };
    run(g, clock, 60, 3_000);
    const held = g.scale;
    expect(held).toBeLessThan(1);
    expect(run(g, clock, 28, 60_000)).toBe(0); // 28 ms: fine, but no proof of headroom
    expect(g.scale).toBe(held);
  });

  it('recovers slowly: bias first, then the scale ×1.25, 4 s of moving frames under 0.7 × target each', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    run(g, clock, 80, 12_000);
    expect(g.state).toMatchObject({ scale: 0.25, biasDrop: 1 });
    const t0 = clock.now;
    const raises: Array<[number, number, number]> = [];
    for (let t = 0; t < 30_000; t += 16) {
      clock.now += 16;
      if (g.sample(16, clock.now)) raises.push([clock.now - t0, g.biasDrop, g.scale]);
    }
    expect(raises[0][0]).toBeGreaterThanOrEqual(GOVERNOR_DEFAULTS.recoverMs);
    expect(raises.slice(0, 3).map((r) => [r[1], +r[2].toFixed(4)])).toEqual([[0.5, 0.25], [0, 0.25], [0, 0.3125]]);
    for (let k = 1; k < raises.length; k++) {
      expect(raises[k][0] - raises[k - 1][0]).toBeGreaterThanOrEqual(GOVERNOR_DEFAULTS.recoverMs);
    }
  });

  it('never oscillates: a raise that has to be taken back doubles the wait for the next one', () => {
    // A load that is fast at scale ≤ 0.5 and slow above it — the budget that
    // fits straddles the target, the classic recipe for flapping.
    const g = new FrameGovernor();
    const clock = { now: 0 };
    const cost = (): number => (g.scale > 0.5 ? 50 : 18);
    const raiseTimes: number[] = [];
    let prev = g.scale;
    for (let t = 0; t < 240_000; ) {
      const dt = cost();
      t += dt;
      clock.now += dt;
      g.sample(dt, clock.now);
      if (g.scale > prev) raiseTimes.push(clock.now);
      prev = g.scale;
    }
    const gaps = raiseTimes.slice(1).map((t, i) => t - raiseTimes[i]);
    expect(gaps.length).toBeGreaterThan(1);
    // Each failed attempt is (about) twice as far from the last; by the end it
    // tries at most once a minute.
    for (let k = 1; k < gaps.length; k++) expect(gaps[k]).toBeGreaterThanOrEqual(gaps[k - 1] * 0.9);
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(55_000);
    expect(raiseTimes.length).toBeLessThan(9); // in four minutes
  });

  it('one hitch is not a slow GPU (samples are clamped to 4 × target)', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    run(g, clock, 16, 2_000);
    clock.now += 900;
    expect(g.sample(900, clock.now)).toBe(false);
    // Clamped to 4 × target, the hitch lifts the average just over 33 ms for
    // a frame — not for the four in a row a reduction takes.
    expect(g.state.frameMs).toBeLessThan(34);
    expect(run(g, clock, 16, 2_000)).toBe(0);
    expect(g.scale).toBe(1);
  });

  it('off releases both knobs; a new target only takes effect through the rules', () => {
    const g = new FrameGovernor({ targetFrameMs: 20 });
    const clock = { now: 0 };
    run(g, clock, 40, 5_000);
    expect(g.scale).toBeLessThan(1);
    expect(g.setEnabled(false)).toBe(true);
    expect(g.state).toMatchObject({ enabled: false, scale: 1, biasDrop: 0 });
    expect(g.sample(200, (clock.now += 200))).toBe(false);
    expect(g.setEnabled(true)).toBe(false); // nothing was held
    g.setTarget(50);
    expect(run(g, clock, 40, 5_000)).toBe(0);
    g.setTarget(-1); // garbage ignored
    expect(g.state.targetFrameMs).toBe(50);
  });
});

describe('tileScreenRelevance — spend the budget where the camera looks', () => {
  const Z = 16;
  const N = 2 ** Z;
  // A view centred 0.3 of a tile east / 0.7 south inside tile (1000, 2000),
  // one tile ≈ 3.2 camera distances across (camera zoom 15 over z16 tiles).
  const frame = (tilt: number, bearing = 0, fx = 0.3, fy = 0.7): ViewFrame => ({
    cx: (1000 + fx) / N, cy: (2000 + fy) / N, dist: 1 / N, bearingDeg: bearing, tiltDeg: tilt
  });
  const window3 = enumerateTileWindow(Z, 1000, 2000, 1);

  it('straight down it is ground distance from the VIEW CENTRE (not from the centre tile)', () => {
    const f = frame(0);
    const ranked = rankTilesByRelevance(Z, window3, f);
    const dist = ([x, y]: readonly [number, number]): number => tileCentreDist2(Z, x, y, f.cx, f.cy);
    for (let k = 1; k < ranked.length; k++) expect(dist(ranked[k])).toBeGreaterThanOrEqual(dist(ranked[k - 1]) - 1e-15);
    // With a four-tile budget that is the 2×2 block around the view centre
    // (the view sits in the tile's SW quarter) — not a plus shape.
    const key = ([x, y]: readonly [number, number]): string => `${x}/${y}`;
    expect(ranked.slice(0, 4).map(key).sort()).toEqual(['1000/2000', '1000/2001', '999/2000', '999/2001']);
    // From above the bearing only decides what falls off the (wider than
    // tall) screen — the tiles that matter are the same.
    expect(rankTilesByRelevance(Z, window3, frame(0, 137)).slice(0, 4).map(key).sort())
      .toEqual(ranked.slice(0, 4).map(key).sort());
  });

  it('tilted: tiles ahead beat tiles beside, tiles behind the camera come last', () => {
    const north = frame(60, 0, 0.5, 0.5); // camera south of the target, looking north (tile y decreases)
    const score = (x: number, y: number): number => tileScreenRelevance(Z, x, y, north);
    expect(score(1000, 1999)).toBeLessThan(score(1001, 2000)); // ahead < beside
    expect(score(1000, 1999)).toBeLessThan(score(999, 2000));
    expect(score(1000, 2001)).toBeGreaterThan(score(1001, 1999)); // behind > ahead-diagonal
    expect(score(1000, 2003)).toBeGreaterThanOrEqual(OFFSCREEN_PENALTY); // under / behind the camera
    const ranked = rankTilesByRelevance(Z, window3, north);
    expect(ranked[0]).toEqual([1000, 2000]);
    expect(ranked[1]).toEqual([1000, 1999]);
    // Tiles are scored by their point nearest the target, so the tile directly BEHIND the target
    // (it fills the bottom of the screen) may outrank the far diagonals — but never the tile
    // directly ahead, and the back DIAGONALS still come last.
    const idx = (x: number, y: number): number => ranked.findIndex(([a, b]) => a === x && b === y);
    expect(idx(1000, 2001)).toBeGreaterThan(idx(1000, 1999));
    expect(ranked.slice(-2).every(([x, y]) => y === 2001 && x !== 1000)).toBe(true);
    // Turn around: the order turns with the camera.
    const south = rankTilesByRelevance(Z, window3, frame(60, 180, 0.5, 0.5));
    expect(south[1]).toEqual([1000, 2001]);
    expect(south.slice(-2).every(([x, y]) => y === 1999 && x !== 1000)).toBe(true);
    // Looking east (camera west of the target): +x is ahead.
    const east = rankTilesByRelevance(Z, window3, frame(60, -90, 0.5, 0.5));
    expect(east[1]).toEqual([1001, 2000]);
  });

  it('off-screen tiles still rank among themselves by distance, after every on-screen one', () => {
    const f = frame(70, 0);
    const wide = enumerateTileWindow(Z, 1000, 2000, 3);
    const ranked = rankTilesByRelevance(Z, wide, f);
    const scores = ranked.map(([x, y]) => tileScreenRelevance(Z, x, y, f));
    const firstOff = scores.findIndex((s) => s >= OFFSCREEN_PENALTY);
    expect(firstOff).toBeGreaterThan(0);
    expect(scores.slice(firstOff).every((s) => s >= OFFSCREEN_PENALTY)).toBe(true);
    for (let k = firstOff + 1; k < ranked.length; k++) {
      expect(tileCentreDist2(Z, ranked[k][0], ranked[k][1], f.cx, f.cy))
        .toBeGreaterThanOrEqual(tileCentreDist2(Z, ranked[k - 1][0], ranked[k - 1][1], f.cx, f.cy) - 1e-18);
    }
  });

  it('viewFocus pushes the window centre forward by half the camera ground offset', () => {
    expect(viewFocus(frame(0))).toEqual({ x: frame(0).cx, y: frame(0).cy });
    const f = frame(60, 0);
    const p = viewFocus(f);
    expect(p.x).toBeCloseTo(f.cx, 15);
    expect(f.cy - p.y).toBeCloseTo(0.5 * f.dist * Math.sin(Math.PI / 3), 15); // north = −y
    const e = viewFocus(frame(60, -90));
    expect(e.x - f.cx).toBeCloseTo(0.5 * f.dist * Math.sin(Math.PI / 3), 15);
  });
});

describe('LayerRegistry.setThrottle — ambient animations while splats share the frame', () => {
  const make = () => {
    const calls: number[] = [];
    const layer = { name: 'trees', update: (dt: number) => { calls.push(dt); return true; } } as unknown as Layer;
    const reg = new LayerRegistry();
    reg.register('trees', layer);
    return { reg, calls };
  };

  it('ticks the layer once per interval with the banked time (same speed, fewer frames)', () => {
    const { reg, calls } = make();
    reg.setThrottle('trees', 66);
    let dirty = 0;
    for (let k = 0; k < 60; k++) if (reg.update(1 / 60)) dirty++;
    expect(dirty).toBe(15); // 15 fps out of 60
    expect(calls.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6); // no time lost
    reg.setThrottle('trees', null);
    expect(reg.update(1 / 60)).toBe(true);
  });

  it('advance: false freezes the animation but keeps the gate running', () => {
    const { reg, calls } = make();
    reg.setThrottle('trees', 1000, false);
    let dirty = 0;
    for (let k = 0; k < 125; k++) if (reg.update(1 / 60)) dirty++;
    expect(dirty).toBe(2);
    expect(calls).toEqual([0, 0]);
  });

  it('a frozen ambient layer asks for a render only when its zoom gate flips', () => {
    // The real layers: a frozen tick (dt = 0) used to report dirty whenever the layer was
    // shown, forcing a full redraw of every resident splat once a second at rest.
    let zoom = 16;
    const materials = new StylizedMaterials();
    const opts = { getCameraZoom: () => zoom };
    const layers = { grass: new GrassLayer(materials, opts), trees: new TreesLayer(materials, opts),
      waves: new WavesLayer(materials, opts) } as const;
    const reg = new LayerRegistry();
    for (const [name, layer] of Object.entries(layers)) {
      (layer as unknown as { meshes: Set<THREE.Mesh> }).meshes.add(new THREE.Mesh());
      reg.register(name as 'grass' | 'trees' | 'waves', layer);
    }
    expect(reg.update(1 / 60)).toBe(true); // first tick: the gates open, time runs
    for (const name of ['grass', 'trees', 'waves'] as const) reg.setThrottle(name, 1000, false);
    let dirty = 0;
    for (let k = 0; k < 250; k++) if (reg.update(1 / 60)) dirty++;
    expect(dirty).toBe(0); // four frozen ticks, nothing on screen changed
    zoom = 10; // below every layer's minZoom: they hide, which IS a change
    for (let k = 0; k < 61; k++) if (reg.update(1 / 60)) dirty++;
    expect(dirty).toBe(1);
    for (const layer of Object.values(layers)) layer.dispose();
    materials.dispose();
  });
});


describe('hitch bursts — a slow GPU the EMA cannot see', () => {
  const decision = (g: FrameGovernor): string => JSON.stringify([g.scale, g.biasDrop, g.splatMaxDistance]);
  // The pattern measured on an integrated GPU: a 100-350 ms readback stall once per sort
  // interval, with 17 ms frames between. The clamped EMA never reads "over".
  const burstyPan = (g: FrameGovernor, clock: { now: number }, ms: number, stallMs: number): number => {
    let changes = 0;
    const end = clock.now + ms;
    while (clock.now < end) {
      for (let i = 0; i < 5; i++) { clock.now += 17; if (g.sample(17, clock.now)) changes++; }
      clock.now += stallMs; if (g.sample(stallMs, clock.now)) changes++;
    }
    return changes;
  };

  it('a burst of stalls cuts the budget although the smoothed frame time is under target', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    run(g, clock, 16, 2000);                                  // warm, comfortable
    expect(g.scale).toBe(1);
    const before = decision(g);
    burstyPan(g, clock, 6000, 120);
    expect(decision(g)).not.toBe(before);                      // one rung down, at least
  });

  it('the same stalls spread thinly are lone hitches and change nothing', () => {
    const g = new FrameGovernor();
    const clock = { now: 0 };
    run(g, clock, 16, 2000);
    const before = decision(g);
    for (let k = 0; k < 6; k++) { run(g, clock, 16, 1500); clock.now += 120; g.sample(120, clock.now); }
    expect(g.scale).toBe(1);
    expect(decision(g)).toBe(before);
  });

  it('the rule can be switched off', () => {
    const g = new FrameGovernor({ hitchBurst: 0 });
    const clock = { now: 0 };
    run(g, clock, 16, 2000);
    const before = decision(g);
    burstyPan(g, clock, 6000, 120);
    expect(g.scale).toBe(1);
    expect(decision(g)).toBe(before);
  });
});
