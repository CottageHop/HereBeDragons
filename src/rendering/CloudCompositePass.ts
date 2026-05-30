import * as THREE from 'three';

/**
 * Composites the half-resolution cloud target over the full-resolution scene.
 *
 * The {@link CloudsPass} raymarch is the heaviest fixed per-frame cost, and
 * clouds are soft / low-frequency — so it renders at half resolution into a
 * dedicated target that holds the cloud's own premultiplied color (`.rgb`) and
 * the remaining scene transmittance (`.a`). This pass runs at full resolution
 * and folds that back over the crisp scene with `scene * a + cloudColor`,
 * sampling the half-res cloud texture with linear filtering so the upscale is
 * smooth. Net: the expensive march runs at ~1/4 the pixels with no visible
 * loss, while building edges / roads / labels stay full resolution.
 */
const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uClouds;
varying vec2 vUv;
void main() {
  vec3 scene = texture2D(uScene, vUv).rgb;
  // .rgb = premultiplied cloud color, .a = scene transmittance through the cloud.
  vec4 cl = texture2D(uClouds, vUv);
  gl_FragColor = vec4(scene * cl.a + cl.rgb, 1.0);
}
`;

export class CloudCompositePass {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: null },
        uClouds: { value: null }
      },
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: false
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.scene.add(this.mesh);
  }

  setInputs(scene: THREE.Texture, clouds: THREE.Texture): void {
    this.material.uniforms.uScene.value = scene;
    this.material.uniforms.uClouds.value = clouds;
  }

  dispose(): void {
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    this.material.dispose();
  }
}
