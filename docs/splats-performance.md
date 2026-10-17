# Splats on minimal hardware: what the frame time is actually spent on

Measured 2026-10-06/07 on an Intel Iris Plus Mac (the project's reference weak device), headless
Chrome with Metal, 1280×800, nine held-out Coeur d'Alene z16 tiles. Scripts live in
`SplatMap/viewer/` (`bench_splats.mjs`, `hitch_splats.mjs`, `readback_pan.mjs`,
`profile_pan.mjs`); they read the example's HUD and `window.map.getSplatsStats()`.

## 1. The tiles were twice as heavy as designed

`houses_to_gaussians` passed `spacing_m` to the sampler in **tile-local (Mercator) units**, so
"0.45 m" surfels were 0.30 m apart at Coeur d'Alene (×1.49) and 0.37 m at Charlotte (×1.22):
2.2× / 1.5× the splats per tile for nothing the design wanted. Fixed; a tile went from 604k to
283k gaussians and 4.5 MB to 2.4 MB. A lite pyramid at 0.7 m is ~165k; `splatmap tiles --lite-out`
writes both from one prediction.

| same camera, same nine tiles | still | during a 6 s pan | resident |
| --- | --- | --- | --- |
| old build, 722k / tile | 46 fps, worst 132 ms | 21 fps, worst 143 ms | 1 tile |
| fixed spacing, 283k / tile | 46 fps, worst 143 ms | 33 fps, worst 82 ms | 1 tile |
| lite 0.7 m, 165k / tile | 60 fps, worst 18 ms | 44 fps, worst 70 ms | 2 tiles |

## 2. The hitch is the sort readback waiting for the GPU

The basemap alone pans at a flat 17 ms with no frame over 50 ms. With splats resident, a pan has
60–80 frames over 50 ms (p99 ~330 ms at 1.15M resident), and almost none coincide with a tile
landing or leaving. A CPU profile of the pan: **`getBufferSubData` 5.0 s of 13.8 s (36 %)**; the
layer's own code, 5 ms. Instrumenting it:

| resident | sort interval | readbacks | mean stall | max | frames > 50 ms |
| --- | --- | --- | --- | --- | --- |
| 1.15M (4 tiles) | 100 ms | 39 | 121 ms | 352 ms | 71 |
| 1.15M | 1,000 ms | 13 | 191 ms | 350 ms | 61 |
| 283k (1 tile) | 100 ms | 50 | 88 ms | 101 ms | 50 |

Spark sorts in a worker, but to feed it it renders a per-splat depth pass and reads it back
(4.6 MB at 1.15M) with a synchronous `getBufferSubData`, which waits for every frame queued
ahead of it. On a GPU-bound device that queue is deep, so the readback converts GPU back-pressure
into a main-thread freeze once per sort. Spacing the sorts out does not help — fewer, longer
stalls. The stall is proportional to resident splats, which makes the budget the lever.

## 3. What changed in the viewer

- `groundDepthBias`: the imagery ground's polygon offset was `-2 × zoom` and hid the bottom ~32 px
  of every wall; now relative to the coarsest resident level (zero for a lone level).
- `lowTierUrlTemplate`: the low tiers fetch a lite pyramid instead of thinning full tiles after
  download.
- Governor `hitchBurst`: 8 hitches in 2 s take one step down the degradation ladder. The EMA
  clamps each hitch (rightly — one is a tile upload), so the sort-stall storm never read as
  "over" and the budget sat at 1.2M through a pan that was 24 % frames over 50 ms.
- Example: a "3D Satellite" button; `VITE_SPLATS_TEMPLATE` / `VITE_SPLATS_LITE_TEMPLATE`.

## 4. The map around the splats (2026-10-09)

Question from use: the standalone SplatMap viewer is smooth, the same tiles inside the map are
not. Measured at an emulated 2× DPR (`deviceScaleFactor: 2`, 1280×800, so the fill cost of a
Retina MacBook), one z16 tile resident, high tier, `bench_matrix.mjs` (rAF sampling, 5 s still
then a 6 s drag; it also reads `map.getRenderStats()`):

| configuration | still | pan |
| --- | --- | --- |
| basemap only | 60 fps, worst 17 ms | 60 fps, worst 17 ms |
| + splats, high | 55 fps, worst 133 ms | 23 fps, p95 100 ms, 144 frames > 50 ms |
| + splats, `pixelRatio=1` | 54 fps | 26 fps, p95 100 ms |
| + splats, `hideBasemap=1` | 52 fps | 24 fps, p95 100 ms |
| + splats, `roundedUnion=0` / `tileReveal=0` / `sortIntervalMs=1000` / ripple reveal | — | 21–24 fps, no change |
| + splats, governor off (4 tiles, 1.15M) | 52 fps | 10 fps, p95 217 ms |
| + splats, lite pyramid (2 tiles, 239k) | 36 fps | 35 fps, p95 67 ms |
| + splats, low tier (top-down, 3 tiles) | 60 fps | 59 fps |
| standalone viewer, 3 tiles in view (900k) | 13 fps | 13 fps, p95 233 ms |
| standalone viewer, 9 tiles (2.5M) | 4 fps | 4 fps |

A CPU profile of the pan: the map's own code is 0.1 % of the main thread, `getBufferSubData`
(Spark's sort readback) 38 %, the rest idle waiting for the GPU. So on this machine the frame is
the splats: the basemap underneath, the mask, the reveal, the sort cadence and the pixel ratio
move nothing, and the standalone viewer is slower, not faster, at the same splat count (it draws
every tile it has every frame). Two map-side costs did show up:

- **The render heartbeat.** With splats resident, every 30th tick's safety-net redraw cost
  100–150 ms (a cold GPU re-rasterising every splat) on a map standing still — twice a second.
  Skipped while the overlay has tiles: 0 renders in 5 s at rest, worst frame 150 → 17 ms.
- **Everything the map renders besides the splats** — the outline pipeline, clouds, tilt-shift,
  the ambient animations, Retina resolution while moving. `splats.leanMap` (default on) parks
  them while the overlay shows and restores them after: pan 22–23 → 27–37 fps across runs
  (run-to-run noise on this GPU is about ±5 fps, so the matrix above is one run each).

What the lean map cannot fix is the splat count a device can rasterise: on an integrated GPU
that is the lite pyramid and the governor's budget; on a Retina laptop with a capable GPU the
HUD's "lean" marker and `getRenderStats()` are the first things to read when it feels slow.

## 5. Threads, queues and what else turns off (2026-10-09)

Where the time goes while splats show, per thread:

- **Main thread.** The map's own per-frame code is ~0.1 % of a pan. What blocks it is one
  synchronous call: Spark's per-sort depth readback (`getBufferSubData`). three's
  `readRenderTargetPixelsAsync` already polls a fence before reading, yet the read still took
  90–120 ms on average (330 ms worst): in Chrome the read is serviced by the GPU process in
  submission order, so it waits behind every frame queued after the readback, and a
  GPU-bound render loop that submits on every rAF keeps that queue several frames deep.
- **GPU.** The splats themselves (fill + blending), and Spark's accumulator regeneration,
  which re-runs every resident splat through each tile's modifier on every frame the camera
  moves.
- **Workers.** The map's tile decoders (`min(4, cores − 1)`), Spark's decode pool (≤ 4), its
  sort worker, and — until now — its LoD worker.

What changed:

- **Frame pacing** (`performance.framePacing`, opt-in): a fence per frame, and a new frame
  is only submitted while fewer than two are unfinished on the GPU, so the queue the readback
  waits behind stays two frames deep. On the Iris, quiet machine, 4 interleaved rounds each:

  | | drawn fps | p95 interval | worst | frames > 50 ms | readback stall (mean) |
  | --- | --- | --- | --- | --- | --- |
  | unpaced (default) | 26.4 | 99 ms | 336–382 ms | 74–82 | 108 ms |
  | paced, 2 in flight | 24.6 | 129–188 ms | 232–301 ms | 54–56 | 51 ms |

  A trade on this GPU, not a win, so it stays opt-in (`&framePacing=1` in the example). The
  first, noisier round had half the paced runs at 36 fps / worst 66 ms; that mode never
  recurred, so it is not counted. It may pay off where the queue runs deeper.
- **Spark's LoD driver is off** (`enableLod: false`). Our tiles are plain `.spz` with no LoD
  trees — the pyramid is the level of detail — but the driver still ran on every update and
  posted an empty job to a dedicated LoD worker each frame.
- **Basemap mesh uploads wait for the gesture to end** while the lean map is on (the
  `interactionTilePriority` gate, forced on): an upload mid-pan only competes with the splats.

What was tried and did NOT help (measured, interleaved repeats; keep for the next person):

| idea | result |
| --- | --- |
| 8-bit sRGB colour target instead of RGBA16F (half the blend bandwidth) | identical frame times on Iris; picture identical too (0.25/255) — not the bottleneck |
| gate Spark's regeneration to the sort cadence while panning | no change in drawn fps — the regeneration pass is not the bottleneck |
| hold all submission while a sort readback is outstanding | stall ~30 ms, but drawn fps fell 24 → 19–20: the GPU drains and idles on every sort |
| one frame in flight instead of two | shortest stalls (~31 ms) but drawn fps fell to ~19 — no CPU/GPU overlap, tick quantisation |

## 6. Motion LoD: fewer splats while the camera moves (2026-10-09)

First the diagnosis that decides which game trick applies. One full z16 tile (357k splats),
governor off, pan, Intel Iris at 2× DPR:

| render scale | drawn fps |
| --- | --- |
| 1.0 | 27–28 |
| 0.75 | 29 |
| 0.5 | 27–29 |

Not fill-bound: a quarter of the pixels changes nothing, so half-resolution splat rendering
(the usual particle trick) would buy nothing here. The cost is PER SPLAT (Spark's per-splat
vertex work and the depth-sort readback that waits behind it): the same pan with one LITE tile
(~170k splats, the 0.7 m pyramid) runs at 52–58 fps, p50 17 ms; two lite tiles (340k) at 32.

So the lever is fewer splats in motion. `splats.motionLod` (default on, needs
`lowTierUrlTemplate`): every resident tile also loads its lite version (after the full one, at
rest, two at a time), shares the full mesh's modifier graph (union mask, level fade, distance
fade, ripple all drive both), and the map flips which one is visible — lite while the camera
moves, full 250 ms after it stops. Nothing is refetched on a gesture. Decoded tiles also stop
LANDING while the camera moves (a landing is a ~400k-splat upload and a resort — a 300 ms
frame mid-pan); they land on settle, unless nothing is on screen yet.

Default settings, three interleaved rounds:

| pan | drawn fps | p50 | p95 | frames > 50 ms | sort stall |
| --- | --- | --- | --- | --- | --- |
| `motionLod: false` | 22 | 35 ms | 108 ms | ~78 | 128 ms |
| `motionLod` (default) | 41–42 | 17 ms | 57 ms | ~43 | 58 ms |

Cost: ~45 % more splat memory per resident tile (both versions on the GPU), and one swap at
the start and end of a gesture (Spark regenerates and resorts the visible set: ~150 ms).

With motion LoD, frame pacing flips from a trade to a win (three interleaved rounds): frames
over 50 ms 43 → 17, the sort stall 58 → 28 ms, p95 57 → 50 ms, for 3 % fewer frames drawn.
So `performance.framePacing` is now ON by default. A 60 fps governor target (`targetFrameMs`
18) changed nothing here (the budget already sits at its floor) and was not adopted.

The zoom cap (`maxCameraZoom`) is now 16.5, from measured metres per screen pixel at a 62°
tilt: at 17 the near edge of the frame is ~0.47 m/px — the 0.45 m surfels and ~0.4 m ground
texels are magnified (blurred roads and cars, visible surfel dots); at 16.5 it is ~0.7 m/px.

All of it together, default settings vs the old ones (`&motionLod=0&framePacing=0`), same
capped view, three interleaved rounds:

| pan | drawn fps | p50 | p95 | frames > 50 ms | sort stall | jitter (sd) |
| --- | --- | --- | --- | --- | --- | --- |
| before | 21 | 35–37 ms | 109–123 ms | 64–80 | 132–137 ms | 54 ms |
| now | 36–39 | 18–25 ms | 51–55 ms | 18–25 | 28–31 ms | 24 ms |

Measured and NOT adopted this round:

| idea | result |
| --- | --- |
| Spark's continuous LoD (`SplatMesh lod: true` + `enableLod`, 800k rendered budget) | pan 18 fps vs 21 baseline: per-frame LoD traversal and merged (bigger) far splats; tiles took 10 s instead of 3 to build their trees; the per-tile splat count reads 0 (our budget stops counting); and it renders continuously at rest (19 fps idle — battery) |
| resort every 250 ms instead of 100 ms while moving | half the readbacks, each longer (77 vs 60 ms): no smoother |
| gate Spark's regeneration to the sort cadence (re-tested on a quiet machine, fixed budget) | +0.7 fps — not the cost |

## 7. Motion thinning and the gesture start (2026-10-16)

Measured with `SplatMap/viewer/probe_gesture.mjs` (every drawn frame of a 6 s drag with what
changed on it: governor knobs, resident tiles, Spark's `activeSplats`, each readback and its
size), Intel Iris, DSF 2, the CdA demo at tilt 62, interleaved A/B rounds.

**What a pan looked like.** All long frames sat in the first ~2 s of the gesture, then three
phases: (1) 0.4–1.1 s, 100–270 ms frames at 2 ms of CPU each, GPU-bound; (2) a steady ~45 ms a
frame on three lite tiles (459k splats); (3) the governor walking its ladder — the distance
cutoff first (no effect: every tile here is within 800 m), then the budget, which EVICTED tiles
down to 1 of 3. Two facts drove the rest: the budget counts FULL splats while motion draws LITE
ones, and evicting coverage was the governor's only real lever.

**Motion thinning (`splats.motionThin`).** A new first rung: keep a hashed 0.7 → 0.5 → 0.35 of
each tile's splats while moving, survivors grown 1/√keep. In Spark, a splat with its active flag
cleared is packed as zeros and leaves the depth sort and the instanced draw; zero opacity alone
does not (it is sorted and drawn, and only exits the vertex shader after two texture reads).

| pan, 3 rounds | drawn fps | p50 | p95 | frames > 50 ms | readback | budget at end |
| --- | --- | --- | --- | --- | --- | --- |
| `motionThin: false` | 24.5–29.4 | 26–34 ms | 92–94 ms | 20–34 | 30–47 ms | ×0.6–0.8 |
| `motionThin` (default) | 47.9–48.9 | 17 ms | 33–34 ms | 7–9 | 16–18 ms | ×1, d0 |

(The `false` arm ran below the morning's single-gesture baseline of 32–38 fps, the machine
warmer after an hour of runs; its p95 matched. The interleaved comparison is the result.)

**The gesture start.** With `activeSplats` logged per frame: for the first ~0.6 s of a gesture
Spark still DRAWS the full set (1,051k) while it sorts the lite one, because a change of mapping
(meshes shown/hidden) is only displayed once its first sort lands — and that sort's readback
(262 ms) waits behind the full-set frames. Ruled out by measurement: shader compiles / first-use
costs (a second gesture after 2.5 s at rest hitches the same), GPU clock ramp-up (1 s of forced
renders right before the gesture changed nothing), regeneration (`sparkRenderer.update()` to
`gl.finish()` at rest: 1–2 ms for either set), and the mapping change as such (thinning the full
mesh in place, mapping unchanged, has the same start: Spark's display keeps the old 1.05M ordering
until the sort).

The fix is a hold: on the flip to lite the map draws nothing; the first held tick calls Spark's
`update()` itself (generate + start the sort on an idle GPU — readback 3 ms instead of 260), and
the first frame drawn is the sorted lite set. It is capped at 200 ms, and it only starts with no
unfinished frame on the GPU and no sort in flight: when the map is still busy from the previous
gesture (tiles landing, the reveal animating, a full-set sort in flight), the readback blocks the
main thread behind the queued frames and no cap can cut it short — the first version measured one
225–360 ms freeze there.

| 3 rounds | worst frame, gesture from rest | sum of frames > 50 ms, first 0.7 s | worst frame, whole pan | drawn fps |
| --- | --- | --- | --- | --- |
| no hold | 169–278 ms | 512–615 ms | 169–360 ms | 40.0–48.4 |
| hold | 110–118 ms | 296–390 ms | 110–118 ms | 49.8–51.5 |

A second gesture started while the map is still busy is unchanged by the hold (189–264 vs
190–269 ms worst), except when the GPU happened to be idle (58 vs 188 ms).

Also measured this round and kept as is: dynamic resolution while moving (`leanMap` turns it on).
With it off the pan was slower (28.7–29.2 vs 32.3–33.2 fps, p50 29–32 vs 18–23 ms): with LITE
tiles at 2× DPR the frame is no longer purely per-splat.

## 8. Smooth detail transitions (2026-10-16, later)

User report: "the detail keeps going fine and blurry … make it like a motion blur to high
detail, not an on/off switch." Two separate causes, measured with `probe_restmotion.mjs` (stacks
and on-screen size of every camera change after a drag) and `probe_settle.mjs` (a 200×200 CSS-px
screen patch read back after every presented frame, box-averaged so a 1×↔2× switch compares the
same piece of map; NB three.js leaves a PIXEL_PACK_BUFFER bound while a Spark readback is in
flight, so a probe's own `readPixels` must unbind it or it reads zeros).

**It never really stopped.** MapControls damps per FRAME and only reports a change once the drift
passes an epsilon: 0.35 CSS px a frame 0.3 s after release, 0.02 px at 1.3 s, with sporadic steps
later still (longer in wall time at lower frame rates). Every step was "camera motion" — lite
splats, low resolution — and the late ones flipped detail on and off at rest. Fix: drop the glide
once its next step is under 0.25 CSS px (after the gesture only). Measured: the glide now decays
visibly from 1.5 px a frame and stops at 0.26 px, 1.16 s after release; nothing after that.

**The return to detail was a pop.** Full detail arrived in one frame — 19 % of all the change
after release in a single step of 14.9/255. Drawing both splat sets to cross-fade them would cost
~120 ms a frame on this GPU, so the fade is done on SCREEN instead: the composer captures the last
moving frame, keeps it up while full detail gets ready (identical picture, so invisible), then
blends it into the sharp render over 400 ms. The blend frames re-render nothing (`present()`), and
other render requests wait for the fade — the first version let tile landings re-render the scene
under it and got 4 steps ~110 ms apart.

| settle after a drag | frames carrying the change | largest single step | after the transition |
| --- | --- | --- | --- |
| snap (before) | 1 | 14.9 (19 % of the total) | — |
| dissolve | 26 blend frames, 15–20 ms apart | 0.96 | 0.02 |

Pan cost is unchanged: interleaved with all three changes switched off at runtime, both arms ran
the same 28 fps (the machine was in a 30 fps-locked state that afternoon — busy VS Code renderer and
a runaway widget — so these absolute numbers are not comparable with §7's). The one difference is
the start of a second gesture: with the glide fix the map is really at rest, so it pays the usual
swap hold (75–78 ms); without it the creeping camera had kept the lite set up all along.

### Detail over the second half of the glide (user: "start transitioning from blur to detail about halfway through the scroll")

The settle dissolve only began once the camera had stopped. Now the splats themselves ramp up
while the glide is still slowing: the per-tick on-screen step falls geometrically, so halfway in
time is `sqrt(peak × stop)` (peak = release speed for a drag, the scroll's peak for wheel/trackpad
momentum). From there the full meshes replace the lite ones — cross-faded with per-mesh opacity,
full in over the opaque lite set, then lite out — starting at the lite density and rising to every
splat at the stop. Three things had to be fixed on the way, each found in the per-frame trace:

1. The two meshes shared one thinning uniform, so starting the ramp also coarsened the still-opaque
   lite set — the lite mesh now has its own graph over the same tile uniforms.
2. Newly kept splats only draw once a sort has put them in the ordering, so they arrived in batches
   at each sort (steps of 7, 4.7, 3.9 every ~100–250 ms): a soft band (0.25) above the threshold
   keeps the next splats in the sort with alpha fading in.
3. Sorts here run 220–270 ms apart under load, slower than the ramp, so the rise is capped at what
   the last LANDED sort holds. Spark sorts back to back, so its `sorting` flag never drops between
   ticks; a new `lastSortTime` (stamped at sort start, one sort at a time) is what marks a landing.
   While capped the layer keeps Spark sorting (a regeneration a tick), with a 600 ms failsafe.

Measured (released drag, glide 1.4 s): detail starts at ~0.6 s, complete at the stop; the lite →
full swap no longer stands out from the motion. The readback probe forces a GPU sync every frame
(frames 60–170 ms instead of 30–50), so its per-frame steps overstate what a viewer sees.

## 9. Game-engine pass: density LOD, time-based inertia, reprojection (2026-10-16, evening)

Three tricks from real-time rendering, each measured in interleaved A/B rounds with
`probe_gesture.mjs` (now also counting PRESENTED frames: renders plus blend-only and reprojected
presents — what the eye sees) and `probe_look.mjs` (full-buffer pixel diff at rest, PNGs saved).

**Screen-space density LOD (`splats.densityLod`, default 2 device px).** Constant samples per
pixel, not per metre: each splat's sampling spacing (2 × its scale) is projected from the tile's
object-space camera position; under the target only a hashed fraction is kept, grown to cover.
Rest, 62° tilt: 2× buffer −28 % splats drawn (mean pixel change 0.17/255), 1× buffer −54 %
(0.67/255); the on/off screenshots are indistinguishable. In a pan the map is already at vsync
(p50 17 ms in every arm), so no fps change; what moved: frames > 50 ms 8/7 → 5/4, readback
22 → 17 ms, busy-start worst frame 189/315 → 98/135, and the governor's thinning ended higher
(drawn count unchanged at ~105k) — detail redistributed from the far field to the near.

**Time-based camera inertia.** MapControls damps per update(); the factor is now rescaled to the
frame's length (`BASE_DAMPING` per 1/60 s). Unit-tested: a fling covers the same distance in the
same wall time at 60 and at 20 fps. No GPU measurement — it changes the motion, not the cost.

**Reprojection on held ticks (`performance.reprojection`).** A tick held by GPU pacing or by the
swap hold presents the previous frame warped to the current camera by a ground-plane
reprojection (`ReprojectPass`; unit-tested against three.js projection: exact on the plane, 10 m
roof at ~400 m under a 1 m camera step < 0.5 px).

| pan, 2 rounds | presented fps | presented p95 | presented sd | warped presents | busy-start worst |
| --- | --- | --- | --- | --- | --- |
| reprojection off | 55.0 / 55.2 | 32 / 30 ms | 7 / 7 | — | 101 / 119 ms |
| reprojection on | 55.3 / 57.9 | 19 / 19 ms | 18* / 6 | 14 / 11 | 57 / 104 ms |

\* round 1 carried one 341 ms gap: the reprojection shader compiling on its first use, on a
fresh page. Both present-time passes are now compiled at construction (`compileAsync`); a fresh
page's first gesture then has a worst frame of 109 ms (the swap hold), 26 warped presents in the
pan, presented p95 22 ms.

The warp's picture, checked with `probe_warp.mjs` (render, move the camera one pan step, present
the warp, really render, compare): a 0.7 m step (3.3 px) puts the warped frame 0.80/255 from the
real one where repeating the old frame is 9.29 off; a 2 m step (9.5 px) 1.46 vs 19.43.

**Miniature on the splats (`splats.miniature`).** The tilt-shift's first version blurred at full
resolution: in a pan with the overlay, drawn fps 53 → 36–45 and presented p95 18–21 → 30–40 ms
(trace: CPU per render unchanged at 2–4 ms, so the cost was fill — 26 taps a pixel over the 2×
buffer at rest). Half-resolution blur + full-res composite: presented 57.3 / 57.9 fps and p95
19 / 20 ms with the miniature on, 58.9 / 51.3 and 19 / 44 off — within noise of each other.

**The capped view (zoom 15, tilt 45).** The density LOD draws 538k of 1,051k splats at rest on
the 2× buffer (−49 %; at this zoom more of the splats are sub-pixel). A first reading of the
second gesture here showed "worst frames" of 266–833 ms; the per-frame trace showed every one to
be a single interval reaching back across the idle REST before the gesture (at this view the map
goes fully idle at rest, and render-on-demand draws nothing for a second), i.e. a probe artifact,
since fixed (intervals are now taken only between frames presented after the gesture began, and
the time to the first presented frame is reported separately).

What the trace did show: NOTHING was presented for the first 45–113 ms of a gesture, even with
reprojection on. The dynamic-resolution drop at gesture start resizes the render targets, which
destroys the last frame's contents, so the warp had no source until the first moving frame had
rendered — and the swap hold was holding that frame. `Composer.captureHeldFrame` now keeps a copy
(one blit into the dissolve's capture target) right before the resize and `presentReprojected`
warps from it: the first ticks of a gesture now present reprojected frames (11–12 in the first
0.7 s), first frame at 45–113 ms on a fresh page's first gesture, 8–45 ms after that.

**Fixed canvas, internal render scale.** Tick-level tracing (`TICKS=1`: every rAF callback timed)
showed the first moving tick of a gesture blocking 30–47 ms; with dynamic resolution off, 18 ms
(first gesture) and nothing (later ones) — so ~20 ms of every gesture start, and every settle,
was the canvas drawing-buffer resize that came with the pixel-ratio flip. The composer now keeps
the canvas at the display's ratio and renders into targets at `canvas × scale`, upscaling in the
final pass; Spark gets the scale as `focalAdjustment` (it sizes footprints from the drawing
buffer). First presented frame after a gesture start: 67–113 → 42–51 ms (fresh page, first
gesture), 43–56 → 25–30 ms after; first moving tick 19 ms then none. The 19 ms that remains on a
fresh page's first gesture is one-time (the lite meshes' first generation / compile) — left as is.

## 11. Cover level: fill the view, refine from the centre (2026-10-17)

User: "maybe load the higher details from the center out", then "make the splat portions show up
correctly when the camera pans". The zoom-15 cap had left the detail level as an island (9 z16
tiles wanted, 3 in budget). `splats.cover` keeps the next coarser level's window resident under
the detail window — outside the budget, loaded first, lite pyramid — and detail dissolves in over
it from the view centre (the level-fade quadrant machinery, unchanged). The demo pyramids needed a
z15 level, built from the z16 tiles (`splatmap lod --min-z 15`; lite at ~80k splats a tile).

Found on the way, by the harness (279 fetches in 30 frames, nothing resident): `updatePrefetch`
abandoned every in-flight load not at `activeZ` / the prefetch level. The fourth place that
compared a level to `activeZ` instead of asking the set; the step-3 refactor had left it.

Look at the capped view: the whole frame is satellite at rest and mid-pan (3 detail + 4 cover
tiles, 1.37M resident, 752k drawn at 2×). Cost, first version (cover resident and drawn in motion
with the lite detail): drawn fps 47 → 32–35, presented p95 26–29 → 40–52 ms, readback 11 → 28 ms —
Spark's generate and depth passes scale with RESIDENT splats, inactive ones included. So in
motion the detail tiles away from the view focus hide (their cover parent shows) and come back
dissolving in at rest: motion carries the cover plus one lite detail tile, about what it carried
before the cover existed.

Measured with the hide (2 interleaved rounds, `probe_mapping.mjs` for Spark's mapping):

| pan | mapping in motion | active splats p50 | drawn fps | presented fps / p95 | readback |
| --- | --- | --- | --- | --- | --- |
| cover off | 540k | 102k | 44–50 | 56.5 / 25–32 ms | 8–11 ms |
| cover on | 482k | 154k | 36 | 52–53 / 42–45 ms | 21–22 ms |

The mapping (what Spark generates and sorts) is SMALLER with the cover — the hide works — but
the cover shows more picture: its coarse splats are large, so the density LOD keeps them where it
would have thinned detail, and the rest frames at a gesture's start and end carry 1.39M resident
instead of 1.15M. That is the price of covering the whole view rather than a third of it; the
governor's thinning ladder still owns the floor. Mid-pan the frame is imagery edge to edge, lite
detail at the centre, cover around it.

## 12. Loading detail faster (2026-10-17)

User: "if we can load higher details faster that would be awesome". Per-tile timeline from page
open (`probe_loadtime.mjs`), before: strictly serial — `maxInFlight: 1` — cover tiles landed at
2088 / 2261 / 2440 / 2646 ms, five cover 404s probed, the FIRST detail fetch at 2791 (700 ms after
the first fetch), detail landings 3110 / 3471 / 3917 (380 ms apart: ~100 ms fetch + ~250 ms decode,
one at a time, while Spark's four decode workers idled).

After: focus detail tile first, four in flight, 350 ms dissolve — focus detail landed 280 ms after
the first cover tile (1950 vs 1670; was ~1 s), three detail fetches start together, the last
detail landing at ~2.8 s is bound by the demo tile server's transfer rate (its Python server
answered one request at a time — restarted threaded — and still moves ~4 MB in ~300 ms) and by
concurrent decodes slowing each other (250–400 ms vs ~200 alone). After a pan the new tile is
decoded before the glide ends (fetch starts mid-pan) and lands at the settle: landing is
deliberately held during motion (an upload + resort mid-glide is a hitch). Pan smoothness with 4
in flight vs 1: within noise (presented 52 fps, p95 48–54 vs 47–50).

### The loading hitches themselves

`probe_loadtime.mjs` (now with every readback stall and every rAF callback over 40 ms),
`probe_landing.mjs` (GL calls per long frame) and `probe_profile.mjs` (CDP CPU profile, self time
per function) together: during a seven-tile load the main thread was blocked ~0.8 s — six sort
readbacks (42–113 ms; one per landing, since a landing re-sorts the set) and five long frames
whose GL time was `texSubImage2D`: the 2048² ground images uploaded through `<img>` cost 18–30 ms
each, 197 ms in all, two to four bunching into one 72 ms frame. Spark's splat textures: 8 ms for
22 MB. The profile's top self-time entries confirmed it: `readRenderTargetPixelsAsync` 411 ms,
program first-use link waits 223 ms (the vector map's own materials, at start-up), V8 on the
Spark module.

Fixes: imagery decoded to `ImageBitmap` with conversions off (uploads 197 → 52 ms for ~100 MB);
at rest every decoded tile and image lands in ONE frame (one sort per batch); one frame in flight
while landing or fading (busy-start worst frame 86 → 50–67 ms, pan p95 44–45 → 29–33 ms); lite
twins wait for the detail; Spark imported at construction. End to end (two runs from map
construction): first detail tile 3.1 s → 1.2–1.5 s, all detail 3.9 s → 1.5–1.7 s, load-window
readback stalls 412 → 158–252 ms. Still there: Spark's one-time init frame (~175 ms) and a few
40–90 ms frames of three/Spark first-render work on a mapping change.

### One frame in flight, everywhere

The pan-time readback stall (~1 s per 6 s pan with the cover on) is Spark waiting for the GPU
queue. Interleaved A/B, 2 rounds, machine in a slow state (governor at its floor in every arm —
another map was open in Safari):

| | presented fps | presented p95 | sd | > 50 ms | readback mean / max | warps |
| --- | --- | --- | --- | --- | --- | --- |
| two frames in flight | 54.7 / 55.0 | 32 / 39 ms | 10 / 11 | 7 / 7 | 7–9 / 103–119 ms | 165–175 |
| one frame in flight | 57.4 / 57.9 | 20 / 21 ms | 7 / 7 | 5 / 1 | 4 / 66–105 ms | 194 |
| one + densityLod 3 | 57.7 / 57.7 | 20 / 19 ms | 8 / 6 | 3 / 5 | 4 / 36–80 ms | 168–191 |

One frame in flight ships (pure scheduling; reprojection is what makes it free now — §5 measured
it as a trade before that). The heavier thinning adds little in motion and would change the rest
picture, so `densityLod` stays at 2.

## 10. What is still open

- Spark's one-time initialisation: ~175 ms of main thread on the overlay's first frame, once per
  page (the same on Spark 2.2.0 and 2.3.1).
- First-render frames when the splat set changes: a load or the motion-LoD swap still costs a few
  40–90 ms frames on this machine — three's and Spark's own first-draw work for the new mapping.
  Batched landings at rest (§12) make that one episode per load instead of one per tile.
- A gesture that starts while tiles are still landing waits behind one heavy frame (one frame in
  flight, §12: worst 50–67 ms). Candidate: keep the lite set until the whole picture has settled,
  not just the camera.
- The first gesture after a page load pays ~19 ms once on its first moving tick (the lite meshes'
  first generation / program). A pre-warm of the lite graph would remove it.
- The sort readback (Spark's, blocking) is ~4 ms mean with one frame in flight. Shorter needs a
  sort that does not read back, and Spark 2.3.0 / 2.3.1 (checked 2026-10-17) still read back
  synchronously, so this stays with Spark.
- Real devices: Safari (the `createImageBitmap` flip test picks the imagery upload path and logs
  it) and a real phone, as before.
