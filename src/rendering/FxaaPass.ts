import * as THREE from 'three';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

/**
 * Final composite pass to the canvas. Two modes:
 *
 *   FXAA mode (default): samples through the FXAAShader edge-detection
 *   pipeline, then applies the same saturation grade + sRGB encode the
 *   passthrough variant does. Smooths jagged building/road edges without
 *   needing MSAA on the depth-bound render target.
 *
 *   Passthrough mode (`setFxaaEnabled(false)`): skips the FXAA logic
 *   entirely and just blits the input texture to the canvas with the same
 *   grade + sRGB encode. Used on the very-low quality tier where even a
 *   single fullscreen FXAA shader is measurable on mobile-class GPUs.
 *
 * Both modes share a single uniforms object so `setInput / setSize /
 * setSaturation` work identically regardless of which mode is active.
 * Switching modes is a single material swap (no recompile, no first-render
 * stall) because both materials are constructed up front.
 *
 * Three.js' built-in materials automatically inject `<colorspace_fragment>`
 * which converts linear → sRGB before writing to the canvas. Custom
 * ShaderMaterials (like these) don't get that chunk by default, so the
 * conversion is applied explicitly at the end of each fragment shader.
 * Without this, linear values end up displayed on the sRGB canvas as if
 * they were already encoded — everything ~2.2× darker than intended.
 */
const SRGB_ENCODE_WITH_GRADE = /* glsl */ `
  // Saturation around luma (Rec.709). uSaturation = 1.0 is identity; >1
  // pushes colors away from grey, <1 toward greyscale. Applied in linear
  // space so the curve interacts predictably with sRGB encode below.
  float _gradeLuma = dot(_fxaa.rgb, vec3(0.2126, 0.7152, 0.0722));
  _fxaa.rgb = mix(vec3(_gradeLuma), _fxaa.rgb, uSaturation);

  // Paper grain: a faint static fibre texture keyed to screen pixels (not the
  // world) so the frame reads as paint on a fixed sheet — the world slides
  // under the "paper" as the camera moves, which is exactly the animated-cel
  // feel. uPaperGrain = 0 is a no-op (multiply by 1.0).
  if (uPaperGrain > 0.0) {
    vec2 _fc = gl_FragCoord.xy;
    float _g = fract(sin(dot(floor(_fc), vec2(127.1, 311.7))) * 43758.5453);
    float _fib = fract(sin(dot(floor(_fc * 0.5), vec2(269.5, 183.3))) * 43758.5453);
    float _grain = (_g - 0.5) * 0.06 + (_fib - 0.5) * 0.045;
    _fxaa.rgb *= 1.0 + _grain * uPaperGrain;
  }

  vec3 _srgb_lo = _fxaa.rgb * 12.92;
  vec3 _srgb_hi = pow(_fxaa.rgb, vec3(1.0 / 2.4)) * 1.055 - 0.055;
  vec3 _srgb = mix(_srgb_hi, _srgb_lo, vec3(lessThanEqual(_fxaa.rgb, vec3(0.0031308))));
  gl_FragColor = vec4(_srgb, _fxaa.a);
`;

// Inject the uSaturation uniform declaration AND the grade-then-encode block.
// FXAAShader doesn't expose its uniform declarations at the top, so we just
// prepend the extra uniform before `void main()`.
const fxaaFragmentWithEncode = FXAAShader.fragmentShader
  .replace(
    'void main() {',
    `uniform float uSaturation;\nuniform float uPaperGrain;\nvoid main() {`
  )
  .replace(
    'gl_FragColor = ApplyFXAA( tDiffuse, resolution.xy, vUv );',
    `vec4 _fxaa = ApplyFXAA( tDiffuse, resolution.xy, vUv );
${SRGB_ENCODE_WITH_GRADE}`
  );

/**
 * Passthrough variant: same uniforms as FXAA mode, but no edge detection —
 * just sample, grade, sRGB encode, write. Cheaper on tile-based mobile
 * GPUs where even FXAA's relatively modest fragment shader is measurable.
 */
const passthroughFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uSaturation;
uniform float uPaperGrain;
varying vec2 vUv;

void main() {
  vec4 _fxaa = texture2D(tDiffuse, vUv);
${SRGB_ENCODE_WITH_GRADE}
}
`;

export class FxaaPass {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly mesh: THREE.Mesh;
  /** Currently-active material (used by external callers via `material`). */
  material: THREE.ShaderMaterial;
  private readonly fxaaMaterial: THREE.ShaderMaterial;
  private readonly passthroughMaterial: THREE.ShaderMaterial;
  /** Shared uniforms object — referenced by both materials. */
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor() {
    // Clone FXAAShader's uniforms and tack `uSaturation` onto the same
    // object. BOTH internal materials point at this object — keeping
    // setInput/setSize/setSaturation valid regardless of which mode is on.
    const uniforms = THREE.UniformsUtils.clone(FXAAShader.uniforms) as Record<string, THREE.IUniform>;
    uniforms.uSaturation = { value: 1.0 };
    uniforms.uPaperGrain = { value: 0.0 };
    this.uniforms = uniforms;

    this.fxaaMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: fxaaFragmentWithEncode,
      depthTest: false,
      depthWrite: false,
      transparent: false
    });

    this.passthroughMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: passthroughFragment,
      depthTest: false,
      depthWrite: false,
      transparent: false
    });

    this.material = this.fxaaMaterial;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.scene.add(this.mesh);
  }

  setInput(texture: THREE.Texture): void {
    this.uniforms.tDiffuse.value = texture;
  }

  setSize(w: number, h: number): void {
    (this.uniforms.resolution.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  /**
   * Saturation multiplier applied in the final composite. 1.0 = identity.
   * Values >1 push colors away from grey; values <1 desaturate. Cheap (one
   * dot product + mix in the fragment shader — the pass was already
   * bandwidth-bound). Available on every quality tier since this pass
   * always runs (even in passthrough mode).
   */
  setSaturation(saturation: number): void {
    this.uniforms.uSaturation.value = Math.max(0, saturation);
  }

  /**
   * Strength (0..1) of the screen-space paper grain folded into the final
   * encode. 0 = off (the look every non-painted theme keeps). The Ghibli theme
   * drives this so the frame reads as paint on paper. Free — the pass was
   * already bandwidth-bound and this is a couple of hashes per pixel.
   */
  setPaperGrain(strength: number): void {
    this.uniforms.uPaperGrain.value = Math.max(0, strength);
  }

  /**
   * Switch between full FXAA and a passthrough blit. Both materials are
   * pre-built so the swap costs nothing (no shader compile, no GPU stall).
   */
  setFxaaEnabled(enabled: boolean): void {
    const next = enabled ? this.fxaaMaterial : this.passthroughMaterial;
    if (this.mesh.material === next) return;
    this.mesh.material = next;
    this.material = next;
  }

  dispose(): void {
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    this.fxaaMaterial.dispose();
    this.passthroughMaterial.dispose();
  }
}
