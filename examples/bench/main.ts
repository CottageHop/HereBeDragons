/**
 * Deterministic motion benchmark harness.
 *
 * Drives a reproducible camera motion over a fixed scene and records the
 * frame-time distribution, so a code change's per-frame cost can be measured
 * as a clean A/B:
 *
 *   1. npm run dev → open /bench.html → note the reported numbers.
 *   2. git stash (revert the change) → reload → note the baseline.
 *   3. git stash pop.
 *
 * It can also be driven headless — `examples/bench/headless-runner.mjs` loads
 * this page in Chrome and scrapes `window.__BENCH_RESULT` (set on completion).
 *
 * MODES (?mode=…):
 *   orbit  one full bearing revolution in place. Scene complexity is constant
 *          and no NEW tiles stream, so this isolates pure render/GPU cost. This
 *          is the original mode — good for measuring fill-rate optimizations.
 *   pan    constant-velocity translation across NEW territory, so tiles stream
 *          + decode + build continuously. This is the mode that exposes scroll
 *          jank: the main-thread mesh-build + GPU-upload spikes that a smooth
 *          orbit never triggers. Default.
 *   fling  repeated fast pan bursts that decelerate to a stop, then settle —
 *          mimics a flick-scroll. Surfaces the worst-case spike right as a
 *          fresh row of tiles pops in mid-glide.
 *   zoom   oscillating zoom in/out across levels, restreaming each level.
 *
 * Why it forces a GPU-bound config by default: many render optimizations free
 * up GPU headroom rather than raising an already-vsync-capped 60 fps. Pushing
 * frame time above the vsync floor (high DPR, no dynamic res) makes the delta
 * visible. Override everything via query params.
 *
 * Query params (all optional):
 *   ?mode=pan|orbit|fling|zoom   motion pattern (default pan)
 *   ?gate=0|1         force the interaction tile-priority gate off/on
 *                     (default: library default = on). Use for A/B.
 *   ?dpr=3            device pixel ratio (default 3 — deliberately heavy)
 *   ?clouds=1         enable the volumetric cloud raymarch (extra GPU load)
 *   ?quality=high|mobile|low  force the quality tier (default high).
 *   ?seconds=12       measured window length after warmup (default 12)
 *   ?warmup=5         seconds to stream tiles + settle before measuring (default 5)
 *   ?zoom=15 ?lat= ?lon=  starting view (defaults: Lower Manhattan)
 *   ?span=0.06        pan distance in degrees over the window (pan/fling modes)
 *   ?pmtiles=URL      override the tiles archive
 */
import { createHereBeDragons } from '../../src/index.js';

const url = new URL(window.location.href);
const num = (k: string, d: number): number => {
  const v = Number(url.searchParams.get(k));
  return Number.isFinite(v) && url.searchParams.get(k) != null ? v : d;
};

const pmtilesUrl =
  url.searchParams.get('pmtiles') ?? `${import.meta.env.BASE_URL}tiles.pmtiles`;
const lat = num('lat', 40.7065);
const lon = num('lon', -74.009);
const zoom = num('zoom', 15);
const dpr = num('dpr', 3);
const clouds = url.searchParams.get('clouds') === '1';
const qualityParam = url.searchParams.get('quality');
const quality: 'low' | 'mobile' | 'high' | undefined =
  qualityParam === 'low' || qualityParam === 'mobile' || qualityParam === 'high'
    ? qualityParam
    : 'high';
const warmupS = num('warmup', 5);
const measureS = num('seconds', 12);
const span = num('span', 0.06); // degrees of travel across the measured window
const modeParam = url.searchParams.get('mode');
const mode: 'orbit' | 'pan' | 'fling' | 'zoom' =
  modeParam === 'orbit' || modeParam === 'fling' || modeParam === 'zoom' ? modeParam : 'pan';
const gateParam = url.searchParams.get('gate');
const interactionTilePriority =
  gateParam === '0' ? false : gateParam === '1' ? true : undefined;
// ?dynres=1 mirrors the real app: dynamic resolution ON, pixel ratio unpinned
// (so the motion→rest full-res snap is in play). Default keeps the fixed-ratio
// A/B harness behavior.
const dynRes = url.searchParams.get('dynres') === '1';

const container = document.getElementById('app');
if (!container) throw new Error('#app not found');

const out = document.getElementById('bench-out');
const setStatus = (html: string): void => {
  if (out) out.innerHTML = html;
};

setStatus('booting map…');

const map = await createHereBeDragons(container, {
  center: { lat, lon },
  zoom,
  tilt: 55,
  pmtiles_url: pmtilesUrl,
  theme: 'concretejungle',
  quality,
  clouds,
  // Hold the pixel ratio fixed so the ONLY variable between A/B runs is the
  // code under test — dynamic resolution would otherwise change the render
  // resolution mid-motion and pollute the comparison.
  pixelRatio: dynRes ? undefined : dpr,
  dynamicResolution: dynRes,
  interactionTilePriority,
  layers: {
    water: true, waterways: true, landuse: true, roads: true, rails: true,
    buildings: true, labels: true, trees: true, grass: true, waves: true, signs: true
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/** Wall-clock period of one fling burst (pan + hold), in ms. */
const FLING_PERIOD_MS = 1600;
/** Fraction of each fling period spent panning (the rest is a settle hold). */
const FLING_PAN_FRACTION = 0.4;

/**
 * Drive the camera for the current `mode`. `frac` is normalized progress
 * (0→1) across the window; `elapsed` is wall-clock ms (fling uses real time
 * for its pan/hold cadence). Returns true if it moved the camera this frame —
 * the caller skips `setView` on hold frames so the camera genuinely settles
 * (the gate opens, the settle flush drains the backlog) exactly as it would
 * after a real flick.
 */
function driveCamera(frac: number, elapsed: number, startBearing: number): boolean {
  switch (mode) {
    case 'orbit':
      map.setBearing(startBearing + frac * 360);
      return true;
    case 'pan':
      // Constant-velocity north-east crawl into never-loaded territory. Never
      // settles — the smoothness ceiling for sustained scrolling.
      map.setView(lat + frac * span, lon + frac * span);
      return true;
    case 'fling': {
      // Flick-and-hold: pan hard for FLING_PAN_FRACTION of each period, then
      // hold (no setView) so the camera settles and the suspended tile backlog
      // bursts in — the realistic gesture lifecycle.
      const period = Math.floor(elapsed / FLING_PERIOD_MS);
      const t = (elapsed % FLING_PERIOD_MS) / FLING_PERIOD_MS; // 0→1 in period
      const bursts = Math.max(1, Math.floor((measureS * 1000) / FLING_PERIOD_MS));
      if (t > FLING_PAN_FRACTION) return false; // hold — let it settle
      const seg = t / FLING_PAN_FRACTION; // 0→1 within the pan
      const ease = 1 - (1 - seg) ** 3;
      const here = (period + ease) / bursts;
      map.setView(lat + here * span, lon + here * span);
      return true;
    }
    case 'zoom': {
      const z = zoom - 3 * (0.5 - 0.5 * Math.cos(frac * Math.PI * 4));
      map.setView(lat, lon, z);
      return true;
    }
  }
}

async function run(): Promise<void> {
  // Warm up: let the camera sit so the visible tile window streams + decodes,
  // and shaders compile, before we start timing.
  setStatus(`warming up (${warmupS}s) — streaming tiles…`);
  await sleep(warmupS * 1000);

  const startBearing = map.getView().bearing;
  const t0 = performance.now();
  const durationMs = measureS * 1000;
  const frames: number[] = []; // rAF-to-rAF deltas in ms
  let prev = performance.now();

  setStatus(`measuring (${measureS}s) — ${mode}…`);

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      const elapsed = now - t0;
      const frac = Math.min(1, elapsed / durationMs);
      driveCamera(frac, elapsed, startBearing);

      frames.push(now - prev);
      prev = now;

      if (elapsed >= durationMs) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Drop the first few frames (the first-move shader work / kick).
  const raw = frames.slice(3);
  const samples = raw.slice().sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const median = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const max = samples[samples.length - 1];
  const fpsMean = 1000 / mean;
  const fpsMedian = 1000 / median;
  // Jank metrics: a "missed frame" is anything that took longer than two
  // vsync intervals (>33 ms ≈ dropped to <30 fps); a "hitch" is a hard
  // stutter (>50 ms). These are what a user actually feels during a scroll —
  // the median can be a flat 60 while a handful of 80 ms spikes ruin it.
  const missed = raw.filter((d) => d > 33.34).length;
  const hitches = raw.filter((d) => d > 50).length;
  const missedPct = +((100 * missed) / raw.length).toFixed(2);

  const cfg =
    `mode=${mode} · gate=${map.getInteractionTilePriority()} · ` +
    `quality=${map.getQualityTier()} · dpr=${map.getPixelRatio().toFixed(2)}× · clouds=${clouds}`;
  const result = {
    mode,
    gate: map.getInteractionTilePriority(),
    fpsMedian: +fpsMedian.toFixed(1),
    fpsMean: +fpsMean.toFixed(1),
    medianMs: +median.toFixed(2),
    meanMs: +mean.toFixed(2),
    p95Ms: +p95.toFixed(2),
    p99Ms: +p99.toFixed(2),
    maxMs: +max.toFixed(2),
    missedFrames: missed,
    missedPct,
    hitches,
    frames: raw.length,
    config: cfg
  };

  // Machine-readable line for copy/paste back into the chat…
  console.log('BENCH_RESULT ' + JSON.stringify(result));
  // …and a window handle the headless runner polls for.
  (window as unknown as { __BENCH_RESULT?: unknown }).__BENCH_RESULT = result;

  setStatus(
    `<div style="font:600 28px/1.2 system-ui">${result.fpsMedian} fps median` +
    `<span style="opacity:.6;font-weight:400"> · ${result.fpsMean} fps mean</span></div>` +
    `<div style="font:400 13px/1.6 ui-monospace,monospace;margin-top:8px">` +
    `median ${result.medianMs} ms · p95 ${result.p95Ms} ms · p99 ${result.p99Ms} ms · max ${result.maxMs} ms<br>` +
    `<b>${result.missedFrames} missed</b> (${result.missedPct}%) · <b>${result.hitches} hitches</b> · ${result.frames} frames<br>` +
    `${cfg}</div>` +
    `<div style="font:400 12px/1.5 system-ui;opacity:.6;margin-top:10px;max-width:340px">` +
    `Copy the <code>BENCH_RESULT</code> line from the console. ` +
    `Re-run with <code>?gate=0</code> for the baseline.</div>`
  );
}

/**
 * Manual-driver mode (?driver=manual): instead of scripting the camera, expose
 * a continuous frame-time recorder so an external driver (puppeteer real mouse
 * drags / wheels) can exercise the genuine input + damping-inertia path that
 * programmatic setView never touches. The runner calls __bench.start(), drives
 * real gestures, then __bench.stop() to compute the same jank metrics.
 */
function summarize(raw: number[]): Record<string, number> {
  const samples = raw.slice().sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    fpsMean: +(1000 / mean).toFixed(1),
    medianMs: +percentile(samples, 50).toFixed(2),
    p95Ms: +percentile(samples, 95).toFixed(2),
    p99Ms: +percentile(samples, 99).toFixed(2),
    maxMs: +samples[samples.length - 1].toFixed(2),
    missedFrames: raw.filter((d) => d > 33.34).length,
    hitches: raw.filter((d) => d > 50).length,
    frames: raw.length
  };
}

if (url.searchParams.get('driver') === 'manual') {
  await sleep(warmupS * 1000);
  let rec: number[] | null = null;
  let prev = performance.now();
  const loop = (): void => {
    const now = performance.now();
    if (rec) rec.push(now - prev);
    prev = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as unknown as { __bench?: unknown }).__bench = {
    start(): void {
      rec = [];
      prev = performance.now();
    },
    stop(): Record<string, number | boolean> {
      const raw = (rec ?? []).slice(3);
      rec = null;
      // Defensive: getInteractionTilePriority() doesn't exist on pre-0.8.x
      // builds (used for baseline A/B against an older src checkout).
      const g = (map as { getInteractionTilePriority?: () => boolean }).getInteractionTilePriority;
      const result = { gate: typeof g === 'function' ? g.call(map) : false, ...summarize(raw) };
      (window as unknown as { __BENCH_RESULT?: unknown }).__BENCH_RESULT = result;
      return result;
    }
  };
  (window as unknown as { __BENCH_READY?: boolean }).__BENCH_READY = true;
  setStatus('manual driver ready');
} else {
  run();
}
