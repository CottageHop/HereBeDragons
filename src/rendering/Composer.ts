import * as THREE from 'three';
import type { Renderer } from './Renderer.js';
import { OutlinePass } from './OutlinePass.js';
import { CloudsPass } from './CloudsPass.js';
import { CloudCompositePass } from './CloudCompositePass.js';
import { NoisePass } from './NoisePass.js';
import { FxaaPass } from './FxaaPass.js';
import { TiltShiftPass } from './TiltShiftPass.js';
import { DissolvePass } from './DissolvePass.js';
import { ReprojectPass } from './ReprojectPass.js';
import { LABEL_THREE_LAYER } from '../layers/LabelsLayer.js';
import { BUILDING_THREE_LAYER } from '../layers/BuildingsLayer.js';
import { TREE_THREE_LAYER } from '../layers/TreesLayer.js';
import { GRASS_THREE_LAYER } from '../layers/GrassLayer.js';
import { WAVES_THREE_LAYER } from '../layers/WavesLayer.js';
import { SPORES_THREE_LAYER } from '../scene/SporesField.js';
import { SIGNS_THREE_LAYER } from '../layers/SignsLayer.js';
import { SPLAT_THREE_LAYER } from '../splats/SplatsLayer.js';
import { type CoverageUniforms, patchCoverage } from '../materials/coverageShader.js';

/**
 * Multi-pass renderer:
 *   1. Scene with stylized materials → colorTarget (with depth texture attached).
 *   2. Scene with MeshNormalMaterial override → normalTarget.
 *   3. OutlinePass (color + normal + depth) → outlineTarget.
 *   4. CloudsPass (outlineTarget color + depth) → compositeTarget.
 *   5. FxaaPass → canvas (also handles linear→sRGB encode).
 *
 * Clouds sit AFTER the outline so they don't get the sketch outline treatment
 * but BEFORE FXAA so the noisy raymarch output gets anti-aliased.
 */
/**
 * The render targets of one internal resolution: the colour pass (with its depth texture), the
 * composite, and the scratch the dissolve / reprojection blend into. One set per render scale
 * (see `Composer.setRenderScale`), kept resident together.
 */
interface TargetSet {
  scale: number;
  color: THREE.WebGLRenderTarget;
  composite: THREE.WebGLRenderTarget;
  depth: THREE.DepthTexture;
  blend: THREE.WebGLRenderTarget | null;
}

export class Composer {
  private renderer: Renderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  /**
   * The targets, one set per internal render scale. Dynamic resolution flips the scale at the
   * start and end of every gesture; re-sizing one set of targets on each flip meant releasing and
   * allocating ~120 MB of textures (three HalfFloat 2880×1800 targets and a depth texture at 2×)
   * every time the camera came to rest — measured as a 70–150 ms stall of the main thread in
   * WebKit, on every settle. Each scale keeps its own targets instead; a flip just switches which
   * set draws. A canvas resize re-sizes the active set and drops the others (recreated on demand).
   */
  private readonly sets = new Map<number, TargetSet>();
  private active: TargetSet;
  private get colorTarget(): THREE.WebGLRenderTarget { return this.active.color; }
  private get compositeTarget(): THREE.WebGLRenderTarget { return this.active.composite; }
  private get depthTexture(): THREE.DepthTexture { return this.active.depth; }
  /**
   * Normal + outline targets for the sketch-outline pipeline. Lazy-allocated
   * by `ensureOutlineTargets()` the first time the outline pass actually runs
   * — they're two FULL-resolution HalfFloat RGBA targets (~130 MB combined at
   * 4K × DPR 2) and the outline pipeline is OFF on every default quality tier
   * (`'high'`, `'mobile'`, and `'low'` all set outlines:false). Allocating
   * them eagerly burned that memory on every map. Materialized + resized on
   * demand; `null` until the outline pass is enabled.
   */
  private normalTarget: THREE.WebGLRenderTarget | null = null;
  private outlineTarget: THREE.WebGLRenderTarget | null = null;
  /**
   * Output of the optional noise heat-map pass. Lazy-allocated on first
   * enable — a HalfFloat RGBA target at canvas resolution costs ~130 MB of
   * GPU memory at 1080p × DPR 2, which is wasteful when noise is off (the
   * default). `ensureNoiseTarget()` materializes + resizes it on demand.
   */
  private noiseTarget: THREE.WebGLRenderTarget | null = null;
  /**
   * Half-resolution target the cloud raymarch renders into. Holds premultiplied
   * cloud color (.rgb) + scene transmittance (.a); `cloudComposite` folds it
   * back over the full-res scene. Half-res = ~1/4 the (expensive) march pixels.
   * Lazy-allocated by `ensureCloudTarget()` — clouds are off by default (the
   * raymarch is the heaviest per-frame cost), so phones and most desktops
   * never pay for this target. `null` until clouds are enabled.
   */
  private cloudHalfTarget: THREE.WebGLRenderTarget | null = null;
  /** Tilt-shift targets — two at HALF resolution for the blur passes, one full-size for the
   *  composite; lazily allocated the first time the effect is actually on (strength > 0), so
   *  nobody pays for them otherwise. */
  private tiltShiftTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  readonly tiltShift = new TiltShiftPass();
  /**
   * Settle dissolve (see `DissolvePass`): `dissolveFrom` holds the captured frame (its own size —
   * not resized with the canvas, so a 1× motion frame survives the switch back to 2×),
   * `dissolveOut` the blend fed to FXAA. Both lazy, so nobody pays until a dissolve runs.
   */
  private readonly dissolve = new DissolvePass();
  /** Reprojection of the last frame to a newer camera (see `presentReprojected`). */
  private readonly reproject = new ReprojectPass();
  private dissolveFrom: THREE.WebGLRenderTarget | null = null;
  private dissolveActive = false;
  private dissolveT = 0;
  /** `dissolveFrom` holds a frame captured for REPROJECTION across a resize (see captureHeldFrame);
   *  cleared by the next real render. */
  private heldForWarp = false;
  /** What the last `render()` fed the final pass, and whether it still holds that picture (a
   *  resize reallocates the targets, so `present()` must not reuse it after one). */
  private lastSceneTex: THREE.Texture | null = null;
  private sceneTexValid = false;
  /**
   * Internal render scale (see `setRenderScale`): every target is sized `canvas × scale` and the
   * final pass upscales into the unchanged canvas. 1 = the canvas resolution.
   */
  private renderScale = 1;
  /** Fraction of full resolution the clouds render at. 0.5 = half each axis. */
  private static readonly CLOUD_RES_SCALE = 0.5;
  /** MSAA sample count for the lazily-allocated normal target (matches the
   *  color target). Captured from the constructor arg. */
  private readonly msaaSamples: number;
  private outline: OutlinePass;
  private clouds: CloudsPass;
  private cloudComposite: CloudCompositePass;
  private noise: NoisePass;
  private fxaa: FxaaPass;
  private normalMaterial: THREE.MeshNormalMaterial;
  /** Off by default; HereBeDragons opts in via `setCloudsEnabled`. */
  private cloudsEnabled = false;
  /** Off by default — the heat-map is an opt-in overlay, not a default effect. */
  private noiseEnabled = false;
  private buildingsInNormalPass = true;
  /**
   * When false, `render()` skips passes 2 + 3 — the full second scene render
   * for the normal buffer AND the full-screen Sobel/halftone outline shader.
   * The post chain reads `colorTarget` directly. Set false by the `'low'`
   * quality tier; it's ~30–40 % of the fixed per-frame GPU cost.
   */
  private outlineEnabled = true;

  /**
   * @param msaaSamples MSAA sample count on the color render target. 4 is the
   *   desktop default; the `'low'` quality profile passes 0 (FXAA-only AA) to
   *   spare integrated GPUs the per-pixel multisample cost.
   */
  constructor(
    renderer: Renderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    msaaSamples = 4
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    // Stored so the lazy outline/normal targets can be allocated with the same
    // sample count outside the constructor (see ensureOutlineTargets).
    this.msaaSamples = msaaSamples;

    // Match the canvas's drawing-buffer resolution (CSS px × pixel ratio).
    // If targets are sized to CSS px only, the final FXAA blit upsamples a
    // half-res composite into a HiDPI canvas and everything — text most
    // visibly — comes out blurry on retina displays.
    const pr = renderer.three.getPixelRatio();
    const w = Math.max(1, Math.round(renderer.width * pr));
    const h = Math.max(1, Math.round(renderer.height * pr));

    // All intermediate render targets store LINEAR values (no sRGB encoding).
    // Color space conversion happens once at the end of the pipeline in
    // FxaaPass before writing to the canvas. This avoids any auto-encode /
    // auto-decode behavior from custom ShaderMaterials reading/writing SRGB
    // framebuffers.
    //
    // HalfFloatType (16-bit float per channel) instead of UnsignedByteType:
    // linear 8-bit storage posterizes hard in dark regions because adjacent
    // linear-space values round to the same byte, producing visible plateaus
    // across smooth gradients (e.g. fog over very dark water in a moody
    // theme). 16-bit float gives ~10 bits of mantissa precision per channel
    // — well below the eye's discrimination threshold even in the darkest
    // sRGB regions. Costs 2× memory per target; same bandwidth profile, no
    // change to the shader code.
    //
    // MSAA on the color target (sample count from the quality profile —
    // 4 on desktop, 0 on the 'low' tier). Without it the stylized scene is
    // rendered single-sampled and FXAA can't track silhouettes well — edges
    // shimmer during pan. Three.js (WebGL2) resolves the MSAA buffer into
    // the regular texture so downstream passes (outline/clouds/FXAA) keep
    // sampling 1 sample/pixel as before. `samples: 0` is a plain
    // single-sampled target.
    //
    // The colour target, its depth texture and the composite below are allocated per render
    // scale by `makeSet` (see `sets`); the canvas-resolution set is the first.
    this.active = this.makeSet(1, w, h);
    this.sets.set(1, this.active);

    // MSAA on the normal target (matches the color-target sample count).
    // Without it, polygon silhouettes in the normal buffer are 1-pixel
    // aliased — and as the camera pans, the Sobel kernel snaps between
    // different aliased pixels each frame, producing shimmer along building
    // outlines. With MSAA the resolved normal at an edge is a blend, which
    // gives the Sobel a stable gradient regardless of subpixel motion.
    //
    // GPU cost: an extra ~3× write bandwidth on the normal pass. Worth it
    // for the visual stability on tilted, panned, urban scenes — the
    // ‘low’ quality tier still passes `samples: 0` here.
    // normalTarget + outlineTarget are lazy-allocated by `ensureOutlineTargets`
    // the first time the outline pass actually runs — see field comment. The
    // outline pipeline is off on every default tier, so most maps never pay
    // for these two full-res HalfFloat targets.
    //
    // noiseTarget is lazy-allocated by `ensureNoiseTarget` the first time the
    // noise pass is actually used — see field comment.

    this.normalMaterial = new THREE.MeshNormalMaterial();
    // (Tile reveal: see `setCoverageUniforms`.)

    this.outline = new OutlinePass();
    // Outline inputs (which include the lazily-allocated normalTarget) are
    // wired in `ensureOutlineTargets()` the first time the pass runs — not
    // here, so we don't force the normal target to exist.
    // Pass CSS-pixel dimensions (not physical) so the Sobel kernel samples at
    // ~1 CSS-pixel offsets regardless of DPR. With physical-pixel offsets,
    // outlines on a DPR=2 display were 0.5 CSS-px wide → right at the
    // aliasing limit, drifting during pan; on DPR=1 they were 1 CSS-px wide
    // → visually heavier. Pegging the kernel to CSS-pixels makes the outline
    // a consistent ~1 CSS-px stroke everywhere and gives the kernel enough
    // coverage to stay stable as the camera pans.
    this.outline.setTexel(renderer.width, renderer.height);
    this.outline.setCamera(camera.near, camera.far);

    this.clouds = new CloudsPass();
    // Placeholder input; `render()` re-points clouds at the live scene texture
    // every frame before the raymarch. The half-res cloud target itself is
    // lazy-allocated by `ensureCloudTarget()` on first cloud render.
    this.clouds.setInputs(this.colorTarget.texture, this.depthTexture);
    this.clouds.setCamera(camera);
    this.cloudComposite = new CloudCompositePass();

    this.noise = new NoisePass();
    // Placeholder input; `render()` re-points the noise pass at the live scene
    // texture before it runs.
    this.noise.setInput(this.colorTarget.texture);
    this.noise.setCamera(camera);

    this.fxaa = new FxaaPass();
    this.fxaa.setInput(this.compositeTarget.texture);
    this.fxaa.setSize(w, h);

    // Compile the present-time passes now, not on first use: the reprojection's first draw sat a
    // gesture's first frame behind a 341 ms shader compile (measured). `compileAsync` links with
    // KHR_parallel_shader_compile where available and never blocks; by the time a pass is first
    // drawn, seconds later, the program is ready.
    const three = renderer.three as THREE.WebGLRenderer & {
      compileAsync?: (scene: THREE.Object3D, camera: THREE.Camera) => Promise<unknown>;
    };
    for (const pass of [this.reproject, this.dissolve]) {
      if (typeof three.compileAsync === 'function') {
        three.compileAsync(pass.scene, pass.camera).catch(() => undefined);
      } else if (typeof three.compile === 'function') {
        three.compile(pass.scene, pass.camera);
      }
    }
  }

  /**
   * Render the scene internally at `scale` × the canvas resolution and let the final pass upscale
   * into the canvas (dynamic resolution the way games do it). The canvas's own drawing buffer
   * never changes size: measured on an Intel Iris, resizing it with the render targets at the
   * start of a gesture cost ~20 ms of main thread on that first moving tick — the frame the user
   * is waiting for. Spark sizes splats from the drawing buffer, so the splat overlay is told the
   * scale too (`SplatsLayer.setRenderScale` → Spark's `focalAdjustment`).
   */
  setRenderScale(scale: number): void {
    const s = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1) : 1;
    if (s === this.renderScale) return;
    this.renderScale = s;
    let set = this.sets.get(s);
    if (!set) {
      const pr = this.renderer.three.getPixelRatio() * s;
      set = this.makeSet(
        s,
        Math.max(1, Math.round(this.renderer.width * pr)),
        Math.max(1, Math.round(this.renderer.height * pr))
      );
      this.sets.set(s, set);
    }
    this.active = set;
    this.applyActiveSize(this.renderer.width, this.renderer.height);
    this.sceneTexValid = false;
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  /** Height of the internal render targets, device px (the splats' density LOD measures against it). */
  internalHeight(): number {
    return this.compositeTarget.height;
  }

  /** The targets of one render scale: colour (+ depth texture), composite, and a lazy blend scratch. */
  private makeSet(scale: number, w: number, h: number): TargetSet {
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    const color = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthTexture: depth,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.msaaSamples
    });
    const composite = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false
    });
    return { scale, color, composite, depth, blend: null };
  }

  private disposeSet(set: TargetSet): void {
    set.color.dispose();
    set.composite.dispose();
    set.blend?.dispose();
    set.depth.dispose();
  }

  resize(width: number, height: number): void {
    const pr = this.renderer.three.getPixelRatio() * this.renderScale;
    const w = Math.max(1, Math.round(width * pr));
    const h = Math.max(1, Math.round(height * pr));
    this.active.color.setSize(w, h);
    this.active.composite.setSize(w, h);
    this.active.blend?.setSize(w, h);
    // The other scales' sets are stale at the new size: drop them, they come back on demand.
    for (const [scale, set] of this.sets) {
      if (set === this.active) continue;
      this.disposeSet(set);
      this.sets.delete(scale);
    }
    this.applyActiveSize(width, height);
    this.sceneTexValid = false;
  }

  /** Size everything that follows the active set: the lazy targets and the passes' texel sizes. */
  private applyActiveSize(width: number, height: number): void {
    const w = this.active.color.width;
    const h = this.active.color.height;
    const pr = this.renderer.three.getPixelRatio() * this.renderScale;
    // Lazily-allocated targets resize only if they've been materialized.
    this.normalTarget?.setSize(w, h);
    this.outlineTarget?.setSize(w, h);
    this.noiseTarget?.setSize(w, h);
    this.tiltShiftTargets?.[0].setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.tiltShiftTargets?.[1].setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.tiltShiftTargets?.[2].setSize(w, h);
    this.tiltShift.setSize(w, h, pr);
    this.cloudHalfTarget?.setSize(
      Math.max(1, Math.round(w * Composer.CLOUD_RES_SCALE)),
      Math.max(1, Math.round(h * Composer.CLOUD_RES_SCALE))
    );
    // Pass CSS-pixel dimensions so the Sobel kernel stays at ~1 CSS-pixel
    // regardless of DPR — see the constructor-side comment for rationale.
    this.outline.setTexel(width, height);
    this.fxaa.setSize(w, h);
    this.clouds.setAspect(w / h);
  }

  /**
   * Allocate — and touch, so the GPU really backs them — everything the first switch to `scale`
   * and the first settle back from it would otherwise allocate mid-gesture: that scale's target
   * set with its blend scratch, the current scale's blend scratch, and the dissolve's capture
   * target at the motion size. Measured in WebKit: the first settle of a session stalled the main
   * thread 110 ms on exactly these allocations. Called by the map on an idle tick, where a stall
   * costs nothing visible. A no-op once done (until a canvas resize drops the inactive sets).
   */
  prepareScale(scale: number): void {
    const s = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1) : 1;
    const r = this.renderer.three;
    const pr = this.renderer.three.getPixelRatio();
    let set = this.sets.get(s);
    if (!set) {
      set = this.makeSet(
        s,
        Math.max(1, Math.round(this.renderer.width * pr * s)),
        Math.max(1, Math.round(this.renderer.height * pr * s))
      );
      this.sets.set(s, set);
    }
    const prevTarget = r.getRenderTarget();
    const touch = (t: THREE.WebGLRenderTarget): void => { r.setRenderTarget(t); r.clear(); };
    try {
      for (const owner of [set, this.active]) {
        if (!owner.blend) {
          owner.blend = new THREE.WebGLRenderTarget(owner.composite.width, owner.composite.height, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            colorSpace: THREE.LinearSRGBColorSpace,
            depthBuffer: false,
            stencilBuffer: false
          });
        }
      }
      if (set !== this.active) { touch(set.color); touch(set.composite); }
      touch(set.blend!);
      touch(this.active.blend!);
      // The dissolve captures the last MOVING frame, i.e. at the motion scale's size.
      const from = this.ensureDissolveFrom(set.color.width, set.color.height);
      touch(from);
    } finally {
      r.setRenderTarget(prevTarget);
    }
  }

  /** Whether `prepareScale(scale)` has done its work (false again after a canvas resize). */
  isScalePrepared(scale: number): boolean {
    const s = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1) : 1;
    const set = this.sets.get(s);
    return !!set && !!set.blend && !!this.active.blend && !!this.dissolveFrom
      && this.dissolveFrom.width === set.color.width && this.dissolveFrom.height === set.color.height;
  }

  /**
   * Draw once with every program the scene and the present-time passes use, into tiny targets of
   * the real targets' formats. Compiling a program is not the whole of its cost: the GPU builds
   * its pipeline state the first time a program draws into a given target format (WebKit's
   * ANGLE-on-Metal), measured as a 150 ms frame when the first settle dissolve ran and 70–160 ms
   * for the first draw of a material a tile happened to bring. Done here, at start-up, instead.
   * Objects the caller wants drawn must not be frustum-culled (they can sit anywhere).
   */
  warmupDraw(): void {
    const r = this.renderer.three;
    const tiny = this.makeSet(1, 4, 4);
    const prevTarget = r.getRenderTarget();
    try {
      r.setRenderTarget(tiny.color);
      r.clear();
      this.scene.overrideMaterial = null;
      r.render(this.scene, this.camera);
      // The dissolve blend and the reprojection, into a composite-format target.
      r.setRenderTarget(tiny.composite);
      this.dissolve.configure(tiny.color.texture, tiny.color.texture, 0.5);
      r.render(this.dissolve.scene, this.dissolve.camera);
      const identity = new THREE.Matrix4();
      this.reproject.configure(tiny.color.texture, identity, identity, new THREE.Vector3(), tiny.composite, tiny.depth, 1);
      r.render(this.reproject.scene, this.reproject.camera);
      this.dissolve.configure(null, tiny.color.texture, 1);
    } finally {
      r.setRenderTarget(prevTarget);
      this.disposeSet(tiny);
    }
  }

  /**
   * Capture the last rendered picture as the start of a settle dissolve. Until `endDissolve()`
   * every presented frame is `mix(captured, live, t)` with `t` from `setDissolveT` (0 at first,
   * so the screen does not change). False — and no dissolve — if there is no valid last picture
   * (nothing rendered yet, or a resize since).
   */
  beginDissolve(): boolean {
    if (!this.sceneTexValid || !this.lastSceneTex) return false;
    const r = this.renderer.three;
    const img = this.lastSceneTex.image as { width: number; height: number };
    this.ensureDissolveFrom(Math.max(1, img.width), Math.max(1, img.height));
    this.heldForWarp = false;
    this.dissolve.configure(null, this.lastSceneTex, 1);
    r.setRenderTarget(this.dissolveFrom);
    r.render(this.dissolve.scene, this.dissolve.camera);
    r.setRenderTarget(null);
    this.dissolveActive = true;
    this.dissolveT = 0;
    return true;
  }

  /**
   * Keep the last rendered picture for reprojection across a resize. A pixel-ratio change
   * (dynamic resolution dropping at the start of a gesture) reallocates the render targets and
   * with them the last frame's contents, so `presentReprojected` would have nothing to warp until
   * the first moving frame has rendered — which the swap hold is holding. Measured: ~80 ms with
   * nothing presented at the start of every gesture. One blit into the dissolve's capture target
   * (they are never wanted at once: the dissolve runs at rest, the warp in motion). False if there
   * is no valid last picture.
   */
  captureHeldFrame(): boolean {
    if (!this.sceneTexValid || !this.lastSceneTex) return false;
    const r = this.renderer.three;
    const img = this.lastSceneTex.image as { width: number; height: number };
    this.ensureDissolveFrom(Math.max(1, img.width), Math.max(1, img.height));
    this.dissolve.configure(null, this.lastSceneTex, 1);
    r.setRenderTarget(this.dissolveFrom);
    r.render(this.dissolve.scene, this.dissolve.camera);
    r.setRenderTarget(null);
    this.heldForWarp = true;
    return true;
  }

  private ensureDissolveFrom(w: number, h: number): THREE.WebGLRenderTarget {
    if (!this.dissolveFrom) {
      this.dissolveFrom = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false
      });
    } else if (this.dissolveFrom.width !== w || this.dissolveFrom.height !== h) {
      this.dissolveFrom.setSize(w, h);
    }
    return this.dissolveFrom;
  }

  /** Blend factor of the running dissolve: 0 = the captured frame, 1 = the live picture. */
  setDissolveT(t: number): void {
    this.dissolveT = Math.min(1, Math.max(0, t));
  }

  /** Stop blending; frames are presented straight again. */
  endDissolve(): void {
    this.dissolveActive = false;
  }

  get dissolving(): boolean {
    return this.dissolveActive;
  }

  /**
   * Present the last rendered picture warped to the CURRENT camera (see `ReprojectPass`): a tick
   * that draws no real frame — GPU pacing held it back, or the splat overlay is holding for its
   * motion-LoD swap — still shows the camera's motion. One full-screen pass plus FXAA; nothing of
   * the scene is rendered. The warp is refined with the last picture's own depth while that is
   * still in the depth texture (no resize since), so buildings land where they stand, not where the
   * ground behind them would. False if the last picture is gone (a resize since).
   * @param viewProj     the current camera's projection × view
   * @param prevViewProj the camera the last frame was rendered with, projection × view
   * @param camPos       the current camera position (world)
   * @param seedHeight   world height near the tall buildings' tops — where the warp also looks
   *                     for them (see ReprojectPass)
   */
  presentReprojected(viewProj: THREE.Matrix4, prevViewProj: THREE.Matrix4, camPos: THREE.Vector3, seedHeight = 0): boolean {
    // The last picture, or — across a resize that destroyed it — the copy captureHeldFrame kept.
    // Sampled by UV, so its size need not match the current targets.
    const src = this.sceneTexValid && this.lastSceneTex
      ? this.lastSceneTex
      : this.heldForWarp && this.dissolveFrom ? this.dissolveFrom.texture : null;
    if (!src) return false;
    const r = this.renderer.three;
    const out = this.ensureBlendTarget();
    const depth = src === this.lastSceneTex ? this.depthTexture : null;
    this.reproject.configure(src, viewProj, prevViewProj, camPos, out, depth, seedHeight);
    r.setRenderTarget(out);
    r.render(this.reproject.scene, this.reproject.camera);
    this.fxaa.setInput(out.texture);
    r.setRenderTarget(null);
    r.render(this.fxaa.scene, this.fxaa.camera);
    return true;
  }

  /** The full-size scratch target the dissolve blend and the reprojection write before FXAA
   *  (one per render scale, with the set it belongs to). */
  private ensureBlendTarget(): THREE.WebGLRenderTarget {
    const set = this.active;
    if (!set.blend) {
      set.blend = new THREE.WebGLRenderTarget(set.composite.width, set.composite.height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false
      });
    }
    return set.blend;
  }

  /**
   * Present again without rendering the scene: only the dissolve blend and the final pass, from
   * the picture the last `render()` produced. This is what makes a dissolve frame cheap. False if
   * that picture is gone (a resize since) — render instead.
   */
  present(): boolean {
    if (!this.sceneTexValid || !this.lastSceneTex) return false;
    const r = this.renderer.three;
    let tex = this.lastSceneTex;
    if (this.dissolveActive && this.dissolveFrom && this.dissolveT < 1) {
      const out = this.ensureBlendTarget();
      this.dissolve.configure(this.dissolveFrom.texture, tex, this.dissolveT);
      r.setRenderTarget(out);
      r.render(this.dissolve.scene, this.dissolve.camera);
      tex = out.texture;
    }
    this.fxaa.setInput(tex);
    // Pass 5: FXAA to the canvas (also performs linear→sRGB encode).
    r.setRenderTarget(null);
    r.render(this.fxaa.scene, this.fxaa.camera);
    return true;
  }

  setMouseUv(u: number, v: number): void {
    this.clouds.setMouseUv(u, v);
  }

  setCloudsEnabled(on: boolean): void {
    this.cloudsEnabled = on;
  }

  /** Toggle the optional dB heat-map overlay (off by default). */
  setNoiseEnabled(on: boolean): void {
    this.noiseEnabled = on;
  }

  getNoiseEnabled(): boolean {
    return this.noiseEnabled;
  }

  /**
   * Replace the noise-source list. See NoisePass.setSources for the
   * scene-world coord convention (`x`, `z` packed into the uniform).
   */
  setNoiseSources(sources: ReadonlyArray<{ x: number; z: number; db: number }>): void {
    this.noise.setSources(sources);
  }

  /** Drive the heat-map ring animation. HereBeDragons passes the cloud time. */
  setNoiseTime(t: number): void {
    this.noise.setTime(t);
  }

  get noisePass(): NoisePass {
    return this.noise;
  }

  /**
   * Final-pass saturation multiplier. Folded into FxaaPass so it applies on
   * every quality tier (the OutlinePass has its own `saturation` but is
   * disabled on `'low'`). 1.0 = identity; ~1.15 gives a subtle vibrance
   * boost; values >1.5 start looking cartoony. Free perf-wise.
   */
  setSaturation(s: number): void {
    this.fxaa.setSaturation(s);
  }

  /** Strength (0..1) of the screen-space paper grain in the final pass. */
  setPaperGrain(strength: number): void {
    this.fxaa.setPaperGrain(strength);
  }

  /**
   * Toggle the FXAA edge-detection in the final pass. When `false`, the
   * pass becomes a simple grade + sRGB blit — still one fullscreen pass
   * but no FXAA math. Used on the very-low quality tier where even FXAA
   * is measurable on mobile-class GPUs.
   */
  setFxaaEnabled(enabled: boolean): void {
    this.fxaa.setFxaaEnabled(enabled);
  }

  /**
   * Materialize `noiseTarget` on first use. Sized to match the rest of the
   * post chain (canvas resolution × DPR). After this, `resize()` keeps it in
   * sync with the canvas — we don't have to re-allocate on every window
   * resize, just on first enable.
   */
  private ensureNoiseTarget(): THREE.WebGLRenderTarget {
    if (this.noiseTarget) return this.noiseTarget;
    const w = this.active.color.width;
    const h = this.active.color.height;
    this.noiseTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false
    });
    return this.noiseTarget;
  }

  /**
   * Materialize the normal + outline targets (and wire the OutlinePass inputs)
   * the first time the outline pipeline renders. Sized to the current canvas
   * resolution; `resize()` keeps them in sync afterwards. Returns the pair so
   * the caller has non-null references for the rest of the frame.
   */
  private ensureOutlineTargets(): {
    normal: THREE.WebGLRenderTarget;
    outline: THREE.WebGLRenderTarget;
  } {
    if (this.normalTarget && this.outlineTarget) {
      return { normal: this.normalTarget, outline: this.outlineTarget };
    }
    const w = this.active.color.width;
    const h = this.active.color.height;
    // MSAA on the normal target matches the color target (resolved to a plain
    // texture for the Sobel pass) — see the original constructor rationale.
    this.normalTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.msaaSamples
    });
    this.outlineTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false
    });
    // Now that the normal target exists, wire the OutlinePass to read color +
    // normal + depth (deferred from the constructor).
    this.outline.setInputs(this.colorTarget.texture, this.normalTarget.texture, this.depthTexture);
    return { normal: this.normalTarget, outline: this.outlineTarget };
  }

  /**
   * Materialize the half-resolution cloud target on first cloud render. Sized
   * to CLOUD_RES_SCALE of the canvas resolution; `resize()` keeps it in sync.
   */
  private ensureCloudTarget(): THREE.WebGLRenderTarget {
    if (this.cloudHalfTarget) return this.cloudHalfTarget;
    const w = this.active.color.width;
    const h = this.active.color.height;
    const cw = Math.max(1, Math.round(w * Composer.CLOUD_RES_SCALE));
    const ch = Math.max(1, Math.round(h * Composer.CLOUD_RES_SCALE));
    this.cloudHalfTarget = new THREE.WebGLRenderTarget(cw, ch, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false
    });
    return this.cloudHalfTarget;
  }

  /**
   * Tile reveal: make the outline pass's normal override follow the basemap's
   * rounded-union mask. Masked fragments write the ground's flat up-normal
   * (not a discard — the override also draws the unmasked ground plane, so a
   * hole would ring the union with a normal edge), so buildings the colour
   * pass has masked out don't leave ghost outlines. Depth already comes from
   * the colour pass, where the discard happens.
   */
  setCoverageUniforms(coverage: CoverageUniforms): void {
    this.normalMaterial.onBeforeCompile = (shader) => patchCoverage(shader, coverage, 'flatNormal');
    this.normalMaterial.customProgramCacheKey = () => 'hbd-normal:masked';
    this.normalMaterial.needsUpdate = true;
  }

  /**
   * Toggle the sketch-outline pipeline (normal pass + outline shader). Off
   * on the `'low'` quality tier — skipping it drops a whole second scene
   * render plus a full-screen fragment shader, the single biggest fixed
   * per-frame GPU saving available on an integrated GPU.
   */
  setOutlineEnabled(on: boolean): void {
    this.outlineEnabled = on;
  }

  /**
   * Toggle whether building meshes participate in the normal pass. Off while
   * buildings are flattened — OutlinePass picks up edges from the normal
   * target, so excluding flattened buildings stops every footprint getting
   * an outline drawn around it.
   */
  setBuildingsInNormalPass(on: boolean): void {
    this.buildingsInNormalPass = on;
  }

  setCloudsOpacity(opacity: number): void {
    this.clouds.setOpacity(opacity);
  }

  /** Apply (or reset, with `null`) a theme's cloud look. See CloudsPass.applyPreset. */
  applyCloudPreset(preset: import('./CloudsPass.js').CloudPreset | null): void {
    this.clouds.applyPreset(preset);
  }

  /** Read the current cloud look as a fully-populated preset. */
  getCloudPreset(): Required<import('./CloudsPass.js').CloudPreset> {
    return this.clouds.getPreset();
  }

  /** Apply the outline/ink look (strength, darkness, halftone, hatching) +
   *  saturation to the OutlinePass. Only the provided fields change. */
  setOutlineLook(cfg: import('../types.js').OutlineConfig): void {
    const s = this.outline.settings;
    if (cfg.strength !== undefined) s.outlineStrength = cfg.strength;
    if (cfg.darkness !== undefined) s.outlineDarkness = cfg.darkness;
    if (cfg.halftone !== undefined) s.halftone = cfg.halftone;
    if (cfg.halftoneScale !== undefined) s.halftoneScale = cfg.halftoneScale;
    if (cfg.hatching !== undefined) s.hatching = cfg.hatching;
    if (cfg.hatchingScale !== undefined) s.hatchingScale = cfg.hatchingScale;
    if (cfg.saturation !== undefined) s.saturation = cfg.saturation;
    this.outline.applySettings();
  }

  /** Read the current outline/ink look as a fully-populated config. */
  getOutlineLook(): Required<import('../types.js').OutlineConfig> {
    const s = this.outline.settings;
    return {
      strength: s.outlineStrength,
      darkness: s.outlineDarkness,
      halftone: s.halftone,
      halftoneScale: s.halftoneScale,
      hatching: s.hatching,
      hatchingScale: s.hatchingScale,
      saturation: s.saturation
    };
  }

  setCloudTime(t: number): void {
    this.clouds.setTime(t);
  }

  setSunDirection(dir: THREE.Vector3): void {
    this.clouds.setSunDirection(dir);
  }

  setFog(color: THREE.Color, density: number): void {
    this.clouds.setFog(color, density);
  }

  get cloudsPass(): CloudsPass {
    return this.clouds;
  }

  /** Whether the normal + outline passes currently run (false on the low tiers). */
  get outlinesEnabled(): boolean {
    return this.outlineEnabled;
  }

  get outlinePass(): OutlinePass {
    return this.outline;
  }

  render(): void {
    const r = this.renderer.three;

    // Pass 1: color (stylized). Gaussian splats (SPLAT_THREE_LAYER) draw here
    // via the single SparkRenderer mesh the splats overlay owns.
    // Labels are held back while the miniature blur is running: they are UI, not scene, and a place
    // name smeared into illegibility is a functional loss rather than a stylistic one. They are
    // drawn sharp after the blur instead (see below). Nothing changes when the effect is off.
    const deferLabels = this.tiltShift.getStrength() > 0.001;
    r.setRenderTarget(this.colorTarget);
    r.clear();
    this.scene.overrideMaterial = null;
    if (deferLabels) this.camera.layers.disable(LABEL_THREE_LAYER);
    r.render(this.scene, this.camera);
    if (deferLabels) this.camera.layers.enable(LABEL_THREE_LAYER);

    // `sceneTex` is whatever the post chain treats as "the rendered scene".
    // With the outline pipeline on it's `outlineTarget`; with it off (the
    // low-GPU tier) we skip passes 2 + 3 entirely and the chain reads
    // `colorTarget` straight through.
    let sceneTex: THREE.Texture = this.colorTarget.texture;

    if (this.outlineEnabled) {
      // Materialize the normal + outline targets on first use (off on every
      // default tier, so most maps never allocate them).
      const { normal: normalTarget, outline: outlineTarget } = this.ensureOutlineTargets();
      // Pass 2: normals. Labels are excluded — rendering them with the normal
      // override would produce a flat-normal quad whose silhouette becomes a
      // rectangular outline around each label in the next pass. Buildings are
      // also excluded when `buildingsInNormalPass` is false (i.e. flat mode)
      // so flat building footprints don't get ringed by outlines.
      r.setRenderTarget(normalTarget);
      r.clear();
      this.scene.overrideMaterial = this.normalMaterial;
      this.camera.layers.disable(LABEL_THREE_LAYER);
      // Trees + grass are billboards expanded in custom vertex shaders; the
      // normal override can't reproduce that, so always exclude them here.
      this.camera.layers.disable(TREE_THREE_LAYER);
      this.camera.layers.disable(GRASS_THREE_LAYER);
      this.camera.layers.disable(WAVES_THREE_LAYER);
      this.camera.layers.disable(SPORES_THREE_LAYER);
      this.camera.layers.disable(SIGNS_THREE_LAYER);
      // Gaussian splats are rasterized by Spark's own shader (a mesh on
      // SPLAT_THREE_LAYER) — the normal override can't apply, and a Sobel
      // outline around a point cloud is just noise. Always exclude them.
      this.camera.layers.disable(SPLAT_THREE_LAYER);
      if (!this.buildingsInNormalPass) this.camera.layers.disable(BUILDING_THREE_LAYER);
      r.render(this.scene, this.camera);
      if (!this.buildingsInNormalPass) this.camera.layers.enable(BUILDING_THREE_LAYER);
      this.camera.layers.enable(SPLAT_THREE_LAYER);
      this.camera.layers.enable(SIGNS_THREE_LAYER);
      this.camera.layers.enable(SPORES_THREE_LAYER);
      this.camera.layers.enable(WAVES_THREE_LAYER);
      this.camera.layers.enable(GRASS_THREE_LAYER);
      this.camera.layers.enable(TREE_THREE_LAYER);
      this.camera.layers.enable(LABEL_THREE_LAYER);
      this.scene.overrideMaterial = null;

      // Pass 3: outline composite → outlineTarget. The colour + depth inputs follow the active
      // render scale's targets (they are re-pointed here, not only when the targets were made).
      this.outline.setInputs(this.colorTarget.texture, normalTarget.texture, this.depthTexture);
      r.setRenderTarget(outlineTarget);
      r.clear();
      this.camera.updateMatrixWorld();
      this.outline.setCamera(this.camera.near, this.camera.far);
      this.outline.setCameraWorldMatrix(this.camera.matrixWorld);
      this.outline.setInverseProjection(this.camera.projectionMatrixInverse);
      r.render(this.outline.scene, this.outline.camera);
      sceneTex = outlineTarget.texture;
    }

    if (this.noiseEnabled && this.noise.getSourceCount() > 0) {
      // Optional pass between outline and clouds: heat-map overlay. Reads
      // whatever the current scene texture is, writes the blended result to
      // `noiseTarget`. Subsequent stages keep treating `sceneTex` as opaque
      // input — they don't know or care that a noise pass ran. The render
      // target is materialized on first use to avoid paying its memory cost
      // for users who never enable the overlay.
      const target = this.ensureNoiseTarget();
      this.camera.updateMatrixWorld();
      this.noise.setInput(sceneTex);
      this.noise.setCamera(this.camera);
      r.setRenderTarget(target);
      r.clear();
      r.render(this.noise.scene, this.noise.camera);
      sceneTex = target.texture;
    }

    if (this.cloudsEnabled) {
      // Pass 4a: clouds raymarch at HALF resolution → cloudHalfTarget. The pass
      // now outputs cloud color (.rgb) + scene transmittance (.a) instead of
      // compositing over the scene itself — the expensive march runs at ~1/4
      // the pixels. Rendering into the smaller target sets the viewport for us.
      const cloudHalfTarget = this.ensureCloudTarget();
      this.clouds.setInputs(sceneTex, this.depthTexture);
      r.setRenderTarget(cloudHalfTarget);
      r.clear();
      this.camera.updateMatrixWorld();
      this.clouds.setCamera(this.camera);
      r.render(this.clouds.scene, this.clouds.camera);

      // Pass 4b: composite the upscaled half-res clouds over the full-res
      // scene → compositeTarget. Keeps buildings/roads/labels crisp.
      this.cloudComposite.setInputs(sceneTex, cloudHalfTarget.texture);
      r.setRenderTarget(this.compositeTarget);
      r.clear();
      r.render(this.cloudComposite.scene, this.cloudComposite.camera);
      sceneTex = this.compositeTarget.texture;
    }

    if (this.tiltShift.getStrength() > 0.001) {
      // Tilt-shift miniature: horizontal blur → A and vertical blur → B at half resolution, then
      // the full-res composite with the grade → C. Skipped entirely at strength 0, so it is free
      // when off.
      const [a, b, c] = this.ensureTiltShiftTargets();
      this.tiltShift.configureBlur(sceneTex, 0);
      r.setRenderTarget(a);
      r.clear();
      r.render(this.tiltShift.scene, this.tiltShift.camera);
      this.tiltShift.configureBlur(a.texture, 1);
      r.setRenderTarget(b);
      r.clear();
      r.render(this.tiltShift.scene, this.tiltShift.camera);
      this.tiltShift.configureComposite(sceneTex, b.texture);
      r.setRenderTarget(c);
      r.clear();
      r.render(this.tiltShift.scene, this.tiltShift.camera);
      // The labels, sharp, over the blurred picture.
      //
      // `scene.background` MUST be detached first. three.js's background step sets `forceClear`
      // whenever the background is a Color, and that clear runs even with `autoClear` off — so a
      // second render would wipe the blurred picture to the sky colour and leave nothing but the
      // labels on it. That is a whole-map blank from one line, and it is invisible to frame-time
      // measurement; see docs/tilt-shift-labels.md for how it was tracked down.
      //
      // `c` has no depth attachment, so the labels' own `depthTest: true` always passes and they
      // all land on top — which is what a map wants of its labels, and what the renderOrder 1000
      // they already carry is asking for.
      const bg = this.scene.background;
      const labelMask = this.camera.layers.mask;
      const autoClear = r.autoClear;
      this.scene.background = null;
      r.autoClear = false;
      this.camera.layers.disableAll();
      this.camera.layers.enable(LABEL_THREE_LAYER);
      r.render(this.scene, this.camera);
      r.autoClear = autoClear;
      this.camera.layers.mask = labelMask;
      this.scene.background = bg;
      sceneTex = c.texture;
    }
    this.lastSceneTex = sceneTex;
    this.sceneTexValid = true;
    this.heldForWarp = false;
    this.present();
  }

  private ensureTiltShiftTargets(): [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] {
    if (!this.tiltShiftTargets) {
      const w = this.compositeTarget.width;
      const h = this.compositeTarget.height;
      const make = (tw: number, th: number): THREE.WebGLRenderTarget =>
        new THREE.WebGLRenderTarget(Math.max(1, tw), Math.max(1, th), {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          colorSpace: THREE.LinearSRGBColorSpace,
          depthBuffer: false,
          stencilBuffer: false
        });
      this.tiltShiftTargets = [make(w >> 1, h >> 1), make(w >> 1, h >> 1), make(w, h)];
      this.tiltShift.setSize(w, h, this.renderer.three.getPixelRatio() * this.renderScale);
    }
    return this.tiltShiftTargets;
  }

  dispose(): void {
    for (const set of this.sets.values()) this.disposeSet(set);
    this.sets.clear();
    this.normalTarget?.dispose();
    this.outlineTarget?.dispose();
    this.noiseTarget?.dispose();
    this.cloudHalfTarget?.dispose();
    this.tiltShiftTargets?.[0].dispose();
    this.tiltShiftTargets?.[1].dispose();
    this.tiltShiftTargets?.[2].dispose();
    this.tiltShift.dispose();
    this.dissolveFrom?.dispose();
    this.dissolve.dispose();
    this.reproject.dispose();
    this.normalMaterial.dispose();
    this.outline.dispose();
    this.clouds.dispose();
    this.cloudComposite.dispose();
    this.noise.dispose();
    this.fxaa.dispose();
  }
}
