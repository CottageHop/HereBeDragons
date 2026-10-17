import * as THREE from 'three';

/**
 * Tilt-shift "miniature" post-process.
 *
 * A real tilt-shift lens tilts the focal plane so only a thin band of the scene is sharp; seen
 * from above, that shallow depth of field is what makes a town read as a scale model. The
 * screen-space version: blur grows with the distance from a FOCUS LINE on screen (the map keeps
 * it on the point the camera looks at), done as two separable passes with a per-pixel radius,
 * plus the saturated, slightly contrasty, bright grade of model photography.
 *
 * Everything is scaled by `strength` (0‥1) so the effect can ease in and out; at 0 the composer
 * skips the pass entirely, so it costs nothing when off. The grade runs in GAMMA space: the
 * buffers are linear light, where pivoting contrast around 0.5 would crush the shadows.
 *
 * The blur runs at HALF resolution (the usual depth-of-field economy): two 13-tap passes over a
 * quarter of the pixels, then one full-resolution composite that takes the sharp band from the
 * full-res image and the blur from the half-res one. Measured on an Intel Iris with the splat
 * overlay in a pan, the full-res version cost 15–25 ms of p95; this is a third of the fetches.
 *
 * Pipeline placement: after clouds, before the final FXAA / sRGB encode.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Shared by both passes: how far from the focus line a pixel is, 0 (sharp) ‥ 1 (full blur). */
const BLUR_AMOUNT = /* glsl */ `
float blurAmount(vec2 uv) {
  float d = abs(uv.y - uFocusY);
  float t = clamp((d - uBand) / max(uFalloff, 1e-4), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;

/**
 * Blur pass, run twice (horizontal, then vertical) at HALF resolution: the radius still grows
 * with the distance from the focus line, in full-resolution device pixels.
 */
const FRAG_BLUR = /* glsl */ `
precision highp float;
uniform sampler2D uColor;
uniform vec2 uTexel;      // 1 / FULL resolution (device px) — tap spacing is in full-res pixels
uniform vec2 uDir;        // (1,0) or (0,1)
uniform float uFocusY;    // focus line, 0..1 from the bottom
uniform float uBand;      // half-height of the sharp band (fraction of screen height)
uniform float uFalloff;   // distance over which blur ramps to max
uniform float uRadius;    // blur radius in device px at full blur (already x strength)
varying vec2 vUv;
${BLUR_AMOUNT}
void main() {
  float r = blurAmount(vUv) * uRadius;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float x = float(i) / 6.0;
    float w = exp(-2.0 * x * x);
    acc += texture2D(uColor, vUv + uDir * uTexel * (x * r)) * w;
    wsum += w;
  }
  gl_FragColor = acc / wsum;
}
`;

/**
 * Composite pass at FULL resolution: the sharp picture where the band is, the half-res blur
 * (bilinearly upsampled) where it is not, mixed by the same ramp — so the band's edge is the
 * full-res image and the half-res softness never shows there — plus the grade.
 */
const FRAG_COMPOSITE = /* glsl */ `
precision highp float;
uniform sampler2D uColor;   // the sharp scene, full resolution
uniform sampler2D uBlur;    // the blurred scene, half resolution
uniform float uFocusY;
uniform float uBand;
uniform float uFalloff;
uniform float uStrength;  // 0..1, mixes the grade
uniform float uSaturation;
uniform float uContrast;
uniform float uVignette;
varying vec2 vUv;
${BLUR_AMOUNT}
void main() {
  float t = blurAmount(vUv) * uStrength;
  vec4 c = mix(texture2D(uColor, vUv), texture2D(uBlur, vUv), t);
  vec3 g = pow(max(c.rgb, 0.0), vec3(1.0 / 2.2));
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = mix(vec3(l), g, uSaturation);
  graded = (graded - 0.5) * uContrast + 0.5;
  graded = graded * 1.04 + 0.015;
  vec2 q = vUv - 0.5;
  graded *= 1.0 - uVignette * dot(q, q) * 1.6;
  g = mix(g, graded, uStrength);
  c.rgb = pow(clamp(g, 0.0, 1.0), vec3(2.2));
  gl_FragColor = c;
}
`;

export interface TiltShiftSettings {
  /** Blur radius at full blur, CSS pixels. Default 9. */
  radius: number;
  /** Half-height of the sharp band, fraction of screen height. Default 0.08. */
  band: number;
  /** Distance over which blur ramps to full, fraction of screen height. Default 0.32. */
  falloff: number;
  /** Saturation multiplier of the grade. Default 1.35. */
  saturation: number;
  /** Contrast multiplier of the grade (gamma space). Default 1.08. */
  contrast: number;
  /** Vignette strength. Default 0.2. */
  vignette: number;
}

export const TILT_SHIFT_DEFAULTS: TiltShiftSettings = {
  radius: 9,
  band: 0.08,
  falloff: 0.32,
  saturation: 1.35,
  contrast: 1.08,
  vignette: 0.2
};

/**
 * The miniature look for SATELLITE imagery (the splat overlay's `miniature` option): the same
 * shallow focus, a calmer grade. `TILT_SHIFT_DEFAULTS` is tuned for the painted vector map;
 * photographs already carry their own colour, and the overlay's neutral grade has just taken the
 * map's painterly saturation off them — a 1.35× lift here would put it back as neon.
 */
export const MINIATURE_IMAGERY_TILT_SHIFT: TiltShiftSettings = {
  radius: 9,
  band: 0.08,
  falloff: 0.32,
  saturation: 1.15,
  contrast: 1.06,
  vignette: 0.18
};

/** Clamp a projected focus line so the sharp band never leaves the screen. */
export function clampFocusY(y: number): number {
  if (!Number.isFinite(y)) return 0.5;
  return Math.min(Math.max(y, 0.15), 0.85);
}

/** Merge user options over the defaults, clamping to sane ranges. */
export function resolveTiltShift(o: Partial<TiltShiftSettings> | undefined): TiltShiftSettings {
  const d = TILT_SHIFT_DEFAULTS;
  const num = (v: unknown, def: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : def;
  return {
    radius: num(o?.radius, d.radius, 0, 40),
    band: num(o?.band, d.band, 0, 0.5),
    falloff: num(o?.falloff, d.falloff, 0.02, 1),
    saturation: num(o?.saturation, d.saturation, 0, 3),
    contrast: num(o?.contrast, d.contrast, 0.5, 2),
    vignette: num(o?.vignette, d.vignette, 0, 1)
  };
}

export class TiltShiftPass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** The blur material (both directions) and the composite; they share `uniforms`. */
  private readonly material: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly mesh: THREE.Mesh;
  settings: TiltShiftSettings = { ...TILT_SHIFT_DEFAULTS };
  private strength = 0;
  private pixelRatio = 1;

  constructor() {
    this.uniforms = {
      uColor: { value: null },
      uBlur: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uFocusY: { value: 0.5 },
      uBand: { value: this.settings.band },
      uFalloff: { value: this.settings.falloff },
      uRadius: { value: 0 },
      uStrength: { value: 0 },
      uSaturation: { value: this.settings.saturation },
      uContrast: { value: this.settings.contrast },
      uVignette: { value: this.settings.vignette }
    };
    const make = (fragmentShader: string): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader, depthTest: false, depthWrite: false });
    this.material = make(FRAG_BLUR);
    this.composite = make(FRAG_COMPOSITE);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** Device-pixel size of the FULL-resolution buffers + the renderer pixel ratio (radius is in CSS px). */
  setSize(w: number, h: number, pixelRatio: number): void {
    (this.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(w, 1), 1 / Math.max(h, 1));
    this.pixelRatio = pixelRatio;
    this.applySettings();
  }

  setFocusY(y: number): void {
    this.uniforms.uFocusY.value = clampFocusY(y);
  }

  /** 0 = off (the composer skips the pass), 1 = full effect. */
  setStrength(s: number): void {
    this.strength = Math.min(Math.max(s, 0), 1);
    this.applySettings();
  }

  getStrength(): number {
    return this.strength;
  }

  applySettings(): void {
    const u = this.uniforms;
    u.uBand.value = this.settings.band;
    u.uFalloff.value = this.settings.falloff;
    u.uRadius.value = this.settings.radius * this.pixelRatio * this.strength;
    u.uStrength.value = this.strength;
    u.uSaturation.value = this.settings.saturation;
    u.uContrast.value = this.settings.contrast;
    u.uVignette.value = this.settings.vignette;
  }

  /** Configure for the horizontal (first) or vertical + grade (second) pass. */
  /** Blur pass: `input` (full or half res) → the current target, along `dir` (0 = x, 1 = y). */
  configureBlur(input: THREE.Texture, dir: 0 | 1): void {
    this.uniforms.uColor.value = input;
    (this.uniforms.uDir.value as THREE.Vector2).set(dir === 0 ? 1 : 0, dir === 0 ? 0 : 1);
    this.mesh.material = this.material;
  }

  /** Composite pass: the sharp full-res `scene` with the half-res `blurred` picture, plus the grade. */
  configureComposite(scene: THREE.Texture, blurred: THREE.Texture): void {
    this.uniforms.uColor.value = scene;
    this.uniforms.uBlur.value = blurred;
    this.mesh.material = this.composite;
  }


  dispose(): void {
    this.material.dispose();
    this.composite.dispose();
    this.mesh.geometry.dispose();
  }
}
