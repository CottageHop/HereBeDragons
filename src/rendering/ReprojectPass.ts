import * as THREE from 'three';

/**
 * Reprojection: the previous frame warped to the current camera, presented on a tick that draws
 * no real frame (GPU frame pacing held it back, or the splat overlay is holding for a swap), so
 * that every vsync shows the camera's motion instead of repeating the last picture — the trick
 * VR runtimes call timewarp, and the reason a 30 Hz render can read as 60 Hz motion.
 *
 * A map needs no depth buffer for it: each output pixel's view ray is intersected with the ground
 * plane (`y = ground`) and that world point is projected with the camera the previous frame was
 * drawn with. Everything on the plane lands exactly; what stands above it (buildings, trees) is
 * off by its height times the camera's move between the two frames over its distance — a 10 m
 * building 300 m away under a 2 m move is 0.2 px out, for the one frame the warp shows. Rays
 * that miss the plane (sky, above the horizon) are treated as infinitely far: rotation-exact.
 * Pixels the previous frame never had (the strip the camera moved towards) clamp to its edge.
 *
 * `reprojectUv` is the JS mirror of the shader's mapping, for tests.
 */
const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tPrev;
uniform mat4 uInvViewProj;   // current camera: clip -> world
uniform mat4 uPrevViewProj;  // previous camera: world -> clip
uniform vec3 uCamPos;        // current camera position, world
uniform float uGround;       // ground plane height, world y
varying vec2 vUv;
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 pFar = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 far = pFar.xyz / pFar.w;
  vec3 dir = far - uCamPos;
  float t = (uGround - uCamPos.y) / dir.y;
  vec3 world = (dir.y < -1e-6 && t > 0.0 && t < 1.0) ? uCamPos + dir * t : far;
  vec4 prev = uPrevViewProj * vec4(world, 1.0);
  vec2 puv = clamp((prev.xy / prev.w) * 0.5 + 0.5, vec2(0.0), vec2(1.0));
  gl_FragColor = texture2D(tPrev, puv);
}
`;

export class ReprojectPass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tPrev: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uGround: { value: 0 }
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      transparent: false
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  /**
   * @param prev          the previous frame (linear, pre-FXAA)
   * @param invViewProj   inverse of the CURRENT camera's projection × view
   * @param prevViewProj  the PREVIOUS camera's projection × view
   * @param camPos        the current camera's world position
   */
  configure(
    prev: THREE.Texture,
    invViewProj: THREE.Matrix4,
    prevViewProj: THREE.Matrix4,
    camPos: THREE.Vector3,
    ground = 0
  ): void {
    const u = this.material.uniforms;
    u.tPrev.value = prev;
    (u.uInvViewProj.value as THREE.Matrix4).copy(invViewProj);
    (u.uPrevViewProj.value as THREE.Matrix4).copy(prevViewProj);
    (u.uCamPos.value as THREE.Vector3).copy(camPos);
    u.uGround.value = ground;
  }

  dispose(): void {
    this.material.dispose();
    (this.scene.children[0] as THREE.Mesh).geometry.dispose();
  }
}

/**
 * JS mirror of the shader: where in the previous frame (UV, unclamped) the current frame's pixel
 * at `uv` finds its content. `null` when the previous camera has the point behind it.
 */
export function reprojectUv(
  uv: readonly [number, number],
  invViewProj: THREE.Matrix4,
  prevViewProj: THREE.Matrix4,
  camPos: THREE.Vector3,
  ground = 0
): [number, number] | null {
  const far = new THREE.Vector3(uv[0] * 2 - 1, uv[1] * 2 - 1, 1).applyMatrix4(invViewProj);
  const dir = far.clone().sub(camPos);
  const t = (ground - camPos.y) / dir.y;
  const world = dir.y < -1e-6 && t > 0 && t < 1 ? camPos.clone().addScaledVector(dir, t) : far;
  const prev = new THREE.Vector4(world.x, world.y, world.z, 1).applyMatrix4(prevViewProj);
  if (prev.w <= 0) return null;
  return [(prev.x / prev.w) * 0.5 + 0.5, (prev.y / prev.w) * 0.5 + 0.5];
}
