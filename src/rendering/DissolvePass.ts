import * as THREE from 'three';

/**
 * Settle dissolve: a full-screen blend of a held frame into the live one, in linear space, before
 * the FXAA / grade / sRGB pass. Used when the picture sharpens at rest (dynamic resolution coming
 * back to full, the splat overlay swapping its motion LoD for full detail): instead of a pop, the
 * last moving frame is held and cross-fades into the sharp one — a focus pull. The blend frames
 * re-render nothing but this pass and FXAA, so they run at display rate even when the scene behind
 * them costs 100 ms a frame.
 *
 * The same material copies (`uT = 1`, one input) to capture the held frame. Inputs are sampled by
 * UV, so the held frame may be at a different resolution than the live one (a 1× motion frame
 * blending into a 2× rest frame).
 */
const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tFrom;
uniform sampler2D tTo;
uniform float uT;
varying vec2 vUv;
void main() {
  vec4 to = texture2D(tTo, vUv);
  gl_FragColor = uT >= 1.0 ? to : mix(texture2D(tFrom, vUv), to, uT);
}
`;

export class DissolvePass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tFrom: { value: null }, tTo: { value: null }, uT: { value: 1 } },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      transparent: false
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  /** Blend `from` into `to` by `t` (0 = all `from`, 1 = all `to`). */
  configure(from: THREE.Texture | null, to: THREE.Texture, t: number): void {
    const u = this.material.uniforms;
    u.tFrom.value = from;
    u.tTo.value = to;
    u.uT.value = from ? Math.min(1, Math.max(0, t)) : 1;
  }

  dispose(): void {
    this.material.dispose();
    (this.scene.children[0] as THREE.Mesh).geometry.dispose();
  }
}
