import * as THREE from 'three';

export interface RendererOptions {
  pixelRatio?: number;
  background?: string;
  antialias?: boolean;
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
      antialias: options.antialias ?? true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.three.setPixelRatio(options.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.three.outputColorSpace = THREE.SRGBColorSpace;
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
