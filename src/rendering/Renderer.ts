import * as THREE from 'three';

export interface RendererOptions {
  pixelRatio?: number;
  background?: string;
  antialias?: boolean;
  /**
   * Fires after the WebGL context has been lost (GPU reset, long tab-background,
   * power-save) AND restored. The renderer has already opted into restoration
   * by `preventDefault()`-ing the `webglcontextlost` event; consumers should
   * use this hook to force a redraw and re-seed any per-frame state they cache.
   * HereBeDragons wires this to nudge `needsRender` so the next RAF repaints.
   */
  onContextRestored?: () => void;
}

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly dom: HTMLCanvasElement;
  private container: HTMLElement;
  // Cached container dimensions. `clientWidth`/`clientHeight` are live DOM
  // properties — every read forces the browser to flush pending style + layout
  // synchronously. Per-frame callers (LabelsLayer.update, TagsManager.update)
  // were each triggering one or more reflows every RAF. We refresh these in
  // `resize()` and serve cached values from `get width()` / `get height()`.
  private _width = 0;
  private _height = 0;

  constructor(container: HTMLElement, options: RendererOptions = {}) {
    this.container = container;
    this.three = new THREE.WebGLRenderer({
      // No MSAA on the DEFAULT framebuffer. The whole map is a multi-pass
      // pipeline: every bit of 3D geometry is rendered into offscreen render
      // targets (colorTarget, normalTarget, …) and the canvas only ever
      // receives the final FULL-SCREEN FXAA blit (a single quad covering the
      // viewport). MSAA only anti-aliases primitive *edges*, and a fullscreen
      // quad has none inside the frame — so a multisampled backbuffer does
      // nothing visible here while costing a multisampled allocation plus an
      // MSAA resolve on every single presented frame. All scene anti-aliasing
      // is handled by FxaaPass (and, on tiers that use it, the color/normal
      // targets' own `samples`). Defaulting this off is a pure, free FPS win
      // with zero change to the rendered image. An explicit `antialias` option
      // still wins if a caller really wants it.
      antialias: options.antialias ?? false,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.three.setPixelRatio(options.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    // The Composer drives clears explicitly: every pass that needs a fresh
    // target calls `renderer.clear()` itself right after `setRenderTarget()`.
    // Three's default `autoClear = true` then clears the SAME target a second
    // time at the top of each `render()` — a redundant full-target clear per
    // pass (and a wholly redundant canvas clear before the fullscreen blit
    // that overwrites every pixel anyway). Turning autoClear off removes that
    // duplicate clear across the entire multi-pass chain. Visual-neutral: the
    // passes that must clear still do so explicitly; fullscreen passes cover
    // 100% of their target so they never needed a clear in the first place.
    this.three.autoClear = false;
    // Linear tone mapping at exposure 1.0 — pure identity for values ≤ 1.0.
    // With lights summed to exactly 1.0× diffuse this means a lit surface
    // displays the exact authored hex color (the swatch). No curve, no
    // compression, no clipping. The stylized gradient handles the shading.
    this.three.toneMapping = THREE.LinearToneMapping;
    this.three.toneMappingExposure = 1.0;
    this.three.setClearColor(new THREE.Color(options.background ?? '#e6f0fa'), 1);

    this.dom = this.three.domElement;
    this.dom.style.display = 'block';
    this.dom.style.width = '100%';
    this.dom.style.height = '100%';
    // Open-hand cursor signals "draggable map". Toggle to grabbing while the
    // pointer is held — MapControls doesn't manage cursor itself.
    this.dom.style.cursor = 'grab';
    this.dom.addEventListener('pointerdown', () => {
      this.dom.style.cursor = 'grabbing';
    });
    const releaseGrab = (): void => {
      this.dom.style.cursor = 'grab';
    };
    this.dom.addEventListener('pointerup', releaseGrab);
    this.dom.addEventListener('pointercancel', releaseGrab);
    this.dom.addEventListener('pointerleave', releaseGrab);

    // WebGL context-loss survival. Browsers reclaim the GPU context on long
    // tab-backgrounds, driver crashes, GPU pressure, power-save — and unless
    // we `preventDefault()` the `webglcontextlost` event, the canvas is dead
    // forever. With it prevented, the browser fires `webglcontextrestored`
    // and Three's WebGLRenderer re-uploads its textures/programs/buffers
    // automatically; we just need to nudge the consumer to redraw.
    this.dom.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
    }, false);
    if (options.onContextRestored) {
      const cb = options.onContextRestored;
      this.dom.addEventListener('webglcontextrestored', () => { cb(); }, false);
    }

    container.appendChild(this.dom);

    this.resize();
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this._width = w;
    this._height = h;
    this.three.setSize(w, h, false);
  }

  dispose(): void {
    this.three.dispose();
    if (this.dom.parentNode === this.container) {
      this.container.removeChild(this.dom);
    }
  }
}
