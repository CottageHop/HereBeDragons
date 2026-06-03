/**
 * Deterministic FPS benchmark harness.
 *
 * Drives a reproducible camera orbit over a fixed scene and records the
 * frame-time distribution, so a code change's per-frame cost can be measured
 * as a clean A/B:
 *
 *   1. npm run dev → open /bench.html → note the reported numbers.
 *   2. git stash (revert the change) → reload → note the baseline.
 *   3. git stash pop.
 *
 * Why it forces a GPU-bound config by default: many render optimizations
 * (e.g. dropping the canvas MSAA resolve, removing redundant clears) free up
 * GPU headroom rather than raising an already-vsync-capped 60 fps. The delta
 * only shows up as higher fps when the GPU is the bottleneck — so the harness
 * disables dynamic resolution and renders at a high pixel ratio to push frame
 * time above the vsync floor. Override everything via query params.
 *
 * Query params (all optional):
 *   ?dpr=3            device pixel ratio (default 3 — deliberately heavy)
 *   ?clouds=1         enable the volumetric cloud raymarch (extra GPU load)
 *   ?quality=high|low force the quality tier (default high)
 *   ?seconds=12       measured window length after warmup (default 12)
 *   ?warmup=5         seconds to stream tiles + settle before measuring (default 5)
 *   ?zoom=15 ?lat= ?lon=  starting view (defaults: Lower Manhattan)
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
const quality: 'low' | 'high' | undefined =
  qualityParam === 'low' || qualityParam === 'high' ? qualityParam : 'high';
const warmupS = num('warmup', 5);
const measureS = num('seconds', 12);

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
  // resolution mid-orbit and pollute the comparison.
  pixelRatio: dpr,
  dynamicResolution: false,
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

async function run(): Promise<void> {
  // Warm up: let the camera sit so the visible tile window streams + decodes,
  // and shaders compile, before we start timing.
  setStatus(`warming up (${warmupS}s) — streaming tiles…`);
  await sleep(warmupS * 1000);

  // One full bearing revolution over the measured window — smooth, constant
  // scene complexity, perfectly reproducible.
  const startBearing = map.getView().bearing;
  const t0 = performance.now();
  const durationMs = measureS * 1000;
  const frames: number[] = []; // rAF-to-rAF deltas in ms
  let prev = performance.now();

  setStatus(`measuring (${measureS}s) — orbiting…`);

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      const elapsed = now - t0;
      // Drive the camera target so the map re-renders every frame.
      const frac = Math.min(1, elapsed / durationMs);
      map.setBearing(startBearing + frac * 360);

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

  // Drop the first few frames (the bearing kick + any first-move shader work).
  const samples = frames.slice(3).sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const median = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const fpsMean = 1000 / mean;
  const fpsMedian = 1000 / median;

  const cfg = `quality=${map.getQualityTier()} · dpr=${map.getPixelRatio().toFixed(2)}× · clouds=${clouds}`;
  const result = {
    fpsMedian: +fpsMedian.toFixed(1),
    fpsMean: +fpsMean.toFixed(1),
    medianMs: +median.toFixed(2),
    meanMs: +mean.toFixed(2),
    p95Ms: +p95.toFixed(2),
    p99Ms: +p99.toFixed(2),
    frames: samples.length,
    config: cfg
  };

  // Machine-readable line for copy/paste back into the chat.
  // eslint-disable-next-line no-console
  console.log('BENCH_RESULT ' + JSON.stringify(result));

  setStatus(
    `<div style="font:600 28px/1.2 system-ui">${result.fpsMedian} fps median` +
    `<span style="opacity:.6;font-weight:400"> · ${result.fpsMean} fps mean</span></div>` +
    `<div style="font:400 13px/1.6 ui-monospace,monospace;margin-top:8px">` +
    `median ${result.medianMs} ms · mean ${result.meanMs} ms · p95 ${result.p95Ms} ms · p99 ${result.p99Ms} ms<br>` +
    `${result.frames} frames · ${cfg}</div>` +
    `<div style="font:400 12px/1.5 system-ui;opacity:.6;margin-top:10px;max-width:340px">` +
    `Copy the <code>BENCH_RESULT</code> line from the console. ` +
    `Re-run after <code>git stash</code> for the baseline.</div>`
  );
}

run();
