import * as THREE from 'three';
import type { Renderer } from './Renderer.js';
import { OutlinePass } from './OutlinePass.js';
import { CloudsPass } from './CloudsPass.js';
import { CloudCompositePass } from './CloudCompositePass.js';
import { NoisePass } from './NoisePass.js';
import { FxaaPass } from './FxaaPass.js';
import { LABEL_THREE_LAYER } from '../layers/LabelsLayer.js';
import { BUILDING_THREE_LAYER } from '../layers/BuildingsLayer.js';
import { TREE_THREE_LAYER } from '../layers/TreesLayer.js';
import { GRASS_THREE_LAYER } from '../layers/GrassLayer.js';
import { WAVES_THREE_LAYER } from '../layers/WavesLayer.js';
import { SPORES_THREE_LAYER } from '../scene/SporesField.js';
import { SIGNS_THREE_LAYER } from '../layers/SignsLayer.js';

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
export class Composer {
  private renderer: Renderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;

  private colorTarget: THREE.WebGLRenderTarget;
  private normalTarget: THREE.WebGLRenderTarget;
  private outlineTarget: THREE.WebGLRenderTarget;
  /**
   * Output of the optional noise heat-map pass. Lazy-allocated on first
   * enable — a HalfFloat RGBA target at canvas resolution costs ~130 MB of
   * GPU memory at 1080p × DPR 2, which is wasteful when noise is off (the
   * default). `ensureNoiseTarget()` materializes + resizes it on demand.
   */
  private noiseTarget: THREE.WebGLRenderTarget | null = null;
  private compositeTarget: THREE.WebGLRenderTarget;
  /**
   * Half-resolution target the cloud raymarch renders into. Holds premultiplied
   * cloud color (.rgb) + scene transmittance (.a); `cloudComposite` folds it
   * back over the full-res scene. Half-res = ~1/4 the (expensive) march pixels.
   */
  private cloudHalfTarget: THREE.WebGLRenderTarget;
  /** Fraction of full resolution the clouds render at. 0.5 = half each axis. */
  private static readonly CLOUD_RES_SCALE = 0.5;
  private depthTexture: THREE.DepthTexture;
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

    // Match the canvas's drawing-buffer resolution (CSS px × pixel ratio).
    // If targets are sized to CSS px only, the final FXAA blit upsamples a
    // half-res composite into a HiDPI canvas and everything — text most
    // visibly — comes out blurry on retina displays.
    const pr = renderer.three.getPixelRatio();
    const w = Math.max(1, Math.round(renderer.width * pr));
    const h = Math.max(1, Math.round(renderer.height * pr));

    this.depthTexture = new THREE.DepthTexture(w, h);
    this.depthTexture.type = THREE.UnsignedIntType;

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
    this.colorTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthTexture: this.depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      samples: msaaSamples
    });

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
    this.normalTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: msaaSamples
    });

    this.outlineTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false
    });

    // noiseTarget is lazy-allocated by `ensureNoiseTarget` the first time the
    // noise pass is actually used — see field comment.

    this.compositeTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false
    });

    this.normalMaterial = new THREE.MeshNormalMaterial();

    this.outline = new OutlinePass();
    this.outline.setInputs(this.colorTarget.texture, this.normalTarget.texture, this.depthTexture);
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
    this.clouds.setInputs(this.outlineTarget.texture, this.depthTexture);
    this.clouds.setCamera(camera);

    // Half-res cloud target + the pass that composites it over the full-res
    // scene. Linear filtering (the WebGLRenderTarget default) makes the upscale
    // smooth; no depth buffer needed (clouds read the shared depth texture).
    const cw = Math.max(1, Math.round(w * Composer.CLOUD_RES_SCALE));
    const ch = Math.max(1, Math.round(h * Composer.CLOUD_RES_SCALE));
    this.cloudHalfTarget = new THREE.WebGLRenderTarget(cw, ch, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false
    });
    this.cloudComposite = new CloudCompositePass();

    this.noise = new NoisePass();
    this.noise.setInput(this.outlineTarget.texture);
    this.noise.setCamera(camera);

    this.fxaa = new FxaaPass();
    this.fxaa.setInput(this.compositeTarget.texture);
    this.fxaa.setSize(w, h);
  }

  resize(width: number, height: number): void {
    const pr = this.renderer.three.getPixelRatio();
    const w = Math.max(1, Math.round(width * pr));
    const h = Math.max(1, Math.round(height * pr));
    this.colorTarget.setSize(w, h);
    this.normalTarget.setSize(w, h);
    this.outlineTarget.setSize(w, h);
    this.noiseTarget?.setSize(w, h);
    this.compositeTarget.setSize(w, h);
    this.cloudHalfTarget.setSize(
      Math.max(1, Math.round(w * Composer.CLOUD_RES_SCALE)),
      Math.max(1, Math.round(h * Composer.CLOUD_RES_SCALE))
    );
    // Pass CSS-pixel dimensions so the Sobel kernel stays at ~1 CSS-pixel
    // regardless of DPR — see the constructor-side comment for rationale.
    this.outline.setTexel(width, height);
    this.fxaa.setSize(w, h);
    this.clouds.setAspect(w / h);
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
    const pr = this.renderer.three.getPixelRatio();
    const w = Math.max(1, Math.round(this.renderer.width * pr));
    const h = Math.max(1, Math.round(this.renderer.height * pr));
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

  get outlinePass(): OutlinePass {
    return this.outline;
  }

  render(): void {
    const r = this.renderer.three;

    // Pass 1: color (stylized).
    r.setRenderTarget(this.colorTarget);
    r.clear();
    this.scene.overrideMaterial = null;
    r.render(this.scene, this.camera);

    // `sceneTex` is whatever the post chain treats as "the rendered scene".
    // With the outline pipeline on it's `outlineTarget`; with it off (the
    // low-GPU tier) we skip passes 2 + 3 entirely and the chain reads
    // `colorTarget` straight through.
    let sceneTex: THREE.Texture = this.colorTarget.texture;

    if (this.outlineEnabled) {
      // Pass 2: normals. Labels are excluded — rendering them with the normal
      // override would produce a flat-normal quad whose silhouette becomes a
      // rectangular outline around each label in the next pass. Buildings are
      // also excluded when `buildingsInNormalPass` is false (i.e. flat mode)
      // so flat building footprints don't get ringed by outlines.
      r.setRenderTarget(this.normalTarget);
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
      if (!this.buildingsInNormalPass) this.camera.layers.disable(BUILDING_THREE_LAYER);
      r.render(this.scene, this.camera);
      if (!this.buildingsInNormalPass) this.camera.layers.enable(BUILDING_THREE_LAYER);
      this.camera.layers.enable(SIGNS_THREE_LAYER);
      this.camera.layers.enable(SPORES_THREE_LAYER);
      this.camera.layers.enable(WAVES_THREE_LAYER);
      this.camera.layers.enable(GRASS_THREE_LAYER);
      this.camera.layers.enable(TREE_THREE_LAYER);
      this.camera.layers.enable(LABEL_THREE_LAYER);
      this.scene.overrideMaterial = null;

      // Pass 3: outline composite → outlineTarget.
      r.setRenderTarget(this.outlineTarget);
      r.clear();
      this.camera.updateMatrixWorld();
      this.outline.setCamera(this.camera.near, this.camera.far);
      this.outline.setCameraWorldMatrix(this.camera.matrixWorld);
      this.outline.setInverseProjection(this.camera.projectionMatrixInverse);
      r.render(this.outline.scene, this.outline.camera);
      sceneTex = this.outlineTarget.texture;
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
      this.clouds.setInputs(sceneTex, this.depthTexture);
      r.setRenderTarget(this.cloudHalfTarget);
      r.clear();
      this.camera.updateMatrixWorld();
      this.clouds.setCamera(this.camera);
      r.render(this.clouds.scene, this.clouds.camera);

      // Pass 4b: composite the upscaled half-res clouds over the full-res
      // scene → compositeTarget. Keeps buildings/roads/labels crisp.
      this.cloudComposite.setInputs(sceneTex, this.cloudHalfTarget.texture);
      r.setRenderTarget(this.compositeTarget);
      r.clear();
      r.render(this.cloudComposite.scene, this.cloudComposite.camera);
      this.fxaa.setInput(this.compositeTarget.texture);
    } else {
      // No clouds: feed the scene texture straight into FXAA.
      this.fxaa.setInput(sceneTex);
    }

    // Pass 5: FXAA to the canvas (also performs linear→sRGB encode).
    r.setRenderTarget(null);
    r.render(this.fxaa.scene, this.fxaa.camera);
  }

  dispose(): void {
    this.colorTarget.dispose();
    this.normalTarget.dispose();
    this.outlineTarget.dispose();
    this.noiseTarget?.dispose();
    this.compositeTarget.dispose();
    this.cloudHalfTarget.dispose();
    this.depthTexture.dispose();
    this.normalMaterial.dispose();
    this.outline.dispose();
    this.clouds.dispose();
    this.cloudComposite.dispose();
    this.noise.dispose();
    this.fxaa.dispose();
  }
}
