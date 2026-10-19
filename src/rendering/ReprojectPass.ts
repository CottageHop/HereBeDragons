import * as THREE from 'three';

/**
 * Reprojection: the previous frame warped to the current camera, presented on a tick that draws
 * no real frame (GPU frame pacing held it back, or the splat overlay is holding for a swap), so
 * that every vsync shows the camera's motion instead of repeating the last picture — the trick
 * VR runtimes call timewarp, and the reason a 30 Hz render can read as 60 Hz motion.
 *
 * Each output pixel's view ray is first intersected with the ground plane (`y = ground`) and that
 * world point projected with the camera the previous frame was drawn with: exact for everything on
 * the plane, and for rays that miss it (sky, above the horizon — treated as infinitely far,
 * rotation-exact). What stands above the plane is off by its height times the camera's move over
 * its distance — under a pixel for a house, but a 250 m tower 1.5 km away under one frame of an
 * orbit (~40 m of camera travel) is metres out, and alternating warped and real frames make it
 * jump back and forth. So, given the previous frame's depth, the guess is refined against what
 * that frame actually drew (Bowles et al.'s fixed-point iterative warp): read the depth where the
 * guess points, rebuild that world point, see where the current camera puts it, and step the
 * guess by the miss — a couple of iterations land on rooftops and facades exactly.
 *
 * The iteration converges to SOME surface the previous frame saw that projects onto this pixel —
 * at a tower's leading edge that can be the ground the tower is now moving over, a perfect fixed
 * point but hidden in the current view. So it runs from three seeds — the ground plane and planes
 * at half and all of `seedHeight` (the tallest buildings' height: they land on the towers) — and
 * of the candidates that converge the one nearest the current camera wins, as the depth test would
 * have it. A pixel the previous frame never saw (the ground a tower uncovers) converges nowhere and
 * takes the smallest miss. Measured over a synthetic downtown (towers to 420 m, one frame of an
 * orbit or a pan): pixels more than a pixel out drop from 12-59% with the ground plane to
 * 0.2-1.6%. Nine depth reads a pixel, on held ticks only. Pixels outside the previous frame clamp
 * to its edge.
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

/** Iterations of the depth refinement per seed (each one depth read and one projection). */
export const REPROJECT_DEPTH_ITERATIONS = 3;
/** Squared miss (px²) under which a refinement has converged: its point projects onto the pixel. */
export const REPROJECT_CONVERGED_PX2 = 0.5;
/** Squared miss (px²) under which a refinement stops early: further steps cannot improve it. */
export const REPROJECT_DONE_PX2 = 0.01;
/** Squared distance (px²) at which a later seed has walked onto the candidate already found. */
export const REPROJECT_MERGE_PX2 = 1;

const fragmentShader = /* glsl */ `
uniform sampler2D tPrev;
uniform sampler2D tDepth;          // the previous frame's depth (window depth 0..1)
uniform float uUseDepth;           // 1: tDepth is that frame's depth; 0: the ground plane alone
uniform mat4 uInvViewProj;         // current camera: clip -> world
uniform mat4 uPrevViewProj;        // previous camera: world -> clip
uniform mat4 uPrevToCur;           // previous camera's clip -> current camera's clip
uniform vec3 uCamPos;              // current camera position, world
uniform float uGround;             // ground plane height, world y
uniform float uSeedHeight;         // the highest seed's plane, world y (0: the ground seed alone)
uniform vec2 uSize;                // output size, px (misses are measured in pixels)
varying vec2 vUv;

// Where the previous frame drew the point of this pixel's ray at height h (the far point if the
// ray does not reach it).
vec2 seedAt(vec3 dir, vec3 far, float h) {
  float t = (h - uCamPos.y) / dir.y;
  vec3 world = (dir.y < -1e-6 && t > 0.0 && t < 1.0) ? uCamPos + dir * t : far;
  vec4 prev = uPrevViewProj * vec4(world, 1.0);
  return clamp((prev.xy / prev.w) * 0.5 + 0.5, vec2(0.0), vec2(1.0));
}

// Fixed-point refinement from one seed: the candidate with the smallest miss, as
// (uv in the previous frame, miss² px², current-view depth). Stops once landed, or once it walks
// onto \`known\` — the candidate an earlier seed found, which it would only find again (that is
// where most pixels' later seeds go: to the ground point the ground seed already has).
vec4 refine(vec2 p, vec2 known) {
  vec4 best = vec4(p, 1e9, 1.0);
  for (int i = 0; i < ${REPROJECT_DEPTH_ITERATIONS}; i++) {
    vec2 k = (p - known) * uSize;
    if (dot(k, k) < ${REPROJECT_MERGE_PX2.toFixed(2)}) break;
    float d = textureLod(tDepth, p, 0.0).r;   // no derivatives in this loop
    if (d >= 1.0) break;              // nothing drawn there
    // the previous frame's point, straight into the current clip space (its world w is positive)
    vec4 c = uPrevToCur * vec4(p * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    if (c.w <= 0.0) break;
    vec2 miss = vUv - ((c.xy / c.w) * 0.5 + 0.5);
    vec2 px = miss * uSize;
    float e = dot(px, px);
    if (e < best.z) best = vec4(p, e, c.z / c.w);
    if (e < ${REPROJECT_DONE_PX2.toFixed(3)}) break;   // landed
    p = clamp(p + miss, vec2(0.0), vec2(1.0));
  }
  return best;
}

// The nearer of two converged candidates (what the current camera sees), else the converged one,
// else the smaller miss (a pixel the previous frame never saw).
vec4 choose(vec4 x, vec4 y) {
  bool cx = x.z < ${REPROJECT_CONVERGED_PX2.toFixed(2)};
  bool cy = y.z < ${REPROJECT_CONVERGED_PX2.toFixed(2)};
  if (cx && cy) return y.w < x.w ? y : x;
  if (cy) return y;
  if (cx) return x;
  return y.z < x.z ? y : x;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 pFar = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 far = pFar.xyz / pFar.w;
  vec3 dir = far - uCamPos;
  vec2 puv = seedAt(dir, far, uGround);
  if (uUseDepth > 0.5) {
    vec4 pick = refine(puv, vec2(-1e3));
    if (uSeedHeight > 0.0) {
      pick = choose(pick, refine(seedAt(dir, far, 0.5 * uSeedHeight), pick.xy));
      pick = choose(pick, refine(seedAt(dir, far, uSeedHeight), pick.xy));
    }
    puv = pick.xy;
  }
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
        tDepth: { value: null },
        uUseDepth: { value: 0 },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uPrevToCur: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uGround: { value: 0 },
        uSeedHeight: { value: 0 },
        uSize: { value: new THREE.Vector2(1, 1) }
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
   * @param viewProj      the CURRENT camera's projection × view
   * @param prevViewProj  the PREVIOUS camera's projection × view
   * @param camPos        the current camera's world position
   * @param size          the output's size, px
   * @param depth         the previous frame's depth texture, or null when there is none of that
   *                      frame (a resize since) — then the ground plane alone
   * @param seedHeight    world height of the highest refinement seed (the tallest buildings')
   */
  configure(
    prev: THREE.Texture,
    viewProj: THREE.Matrix4,
    prevViewProj: THREE.Matrix4,
    camPos: THREE.Vector3,
    size: { width: number; height: number },
    depth: THREE.Texture | null = null,
    seedHeight = 0,
    ground = 0
  ): void {
    const u = this.material.uniforms;
    u.tPrev.value = prev;
    u.tDepth.value = depth;
    u.uUseDepth.value = depth ? 1 : 0;
    (u.uInvViewProj.value as THREE.Matrix4).copy(viewProj).invert();
    (u.uPrevViewProj.value as THREE.Matrix4).copy(prevViewProj);
    (u.uPrevToCur.value as THREE.Matrix4).copy(prevViewProj).invert().premultiply(viewProj);
    (u.uCamPos.value as THREE.Vector3).copy(camPos);
    (u.uSize.value as THREE.Vector2).set(size.width, size.height);
    u.uSeedHeight.value = seedHeight;
    u.uGround.value = ground;
  }

  dispose(): void {
    this.material.dispose();
    (this.scene.children[0] as THREE.Mesh).geometry.dispose();
  }
}

/** Options of `reprojectUv`. */
export interface ReprojectUvOptions {
  /** The previous frame's window depth (0..1, 1 = nothing drawn) at a UV; without it, the ground
   *  plane alone (and the result unclamped). */
  depthAt?: (uv: [number, number]) => number;
  /** Output size, px (default 1280 × 800). */
  size?: readonly [number, number];
  /** World height of the highest seed (default 0: the ground seed alone). */
  seedHeight?: number;
  /** Ground plane height (default 0). */
  ground?: number;
}

/**
 * JS mirror of the shader: where in the previous frame (UV) the current frame's pixel at `uv`
 * finds its content. `null` when the previous camera has the ground-plane point behind it.
 */
export function reprojectUv(
  uv: readonly [number, number],
  viewProj: THREE.Matrix4,
  prevViewProj: THREE.Matrix4,
  camPos: THREE.Vector3,
  opts: ReprojectUvOptions = {}
): [number, number] | null {
  const { depthAt, size = [1280, 800], seedHeight = 0, ground = 0 } = opts;
  const inv = viewProj.clone().invert();
  const far = new THREE.Vector3(uv[0] * 2 - 1, uv[1] * 2 - 1, 1).applyMatrix4(inv);
  const dir = far.clone().sub(camPos);
  const at = (h: number): [number, number] | null => {
    const t = (h - camPos.y) / dir.y;
    const world = dir.y < -1e-6 && t > 0 && t < 1 ? camPos.clone().addScaledVector(dir, t) : far;
    const prev = new THREE.Vector4(world.x, world.y, world.z, 1).applyMatrix4(prevViewProj);
    if (prev.w <= 0) return null;
    return [(prev.x / prev.w) * 0.5 + 0.5, (prev.y / prev.w) * 0.5 + 0.5];
  };
  const guess = at(ground);
  if (!guess || !depthAt) return guess;
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const prevToCur = prevViewProj.clone().invert().premultiply(viewProj);
  const refine = (seed: [number, number], known: readonly [number, number]): { p: [number, number]; e: number; z: number } => {
    let p: [number, number] = [clamp01(seed[0]), clamp01(seed[1])];
    let best = { p, e: 1e9, z: 1 };
    for (let i = 0; i < REPROJECT_DEPTH_ITERATIONS; i++) {
      if (((p[0] - known[0]) * size[0]) ** 2 + ((p[1] - known[1]) * size[1]) ** 2 < REPROJECT_MERGE_PX2) break;
      const d = depthAt(p);
      if (d >= 1) break;
      const c = new THREE.Vector4(p[0] * 2 - 1, p[1] * 2 - 1, d * 2 - 1, 1).applyMatrix4(prevToCur);
      if (c.w <= 0) break;
      const miss: [number, number] = [uv[0] - ((c.x / c.w) * 0.5 + 0.5), uv[1] - ((c.y / c.w) * 0.5 + 0.5)];
      const e = (miss[0] * size[0]) ** 2 + (miss[1] * size[1]) ** 2;
      if (e < best.e) best = { p, e, z: c.z / c.w };
      if (e < REPROJECT_DONE_PX2) break;
      p = [clamp01(p[0] + miss[0]), clamp01(p[1] + miss[1])];
    }
    return best;
  };
  type Cand = ReturnType<typeof refine>;
  const choose = (x: Cand, y: Cand): Cand => {
    const cx = x.e < REPROJECT_CONVERGED_PX2;
    const cy = y.e < REPROJECT_CONVERGED_PX2;
    if (cx && cy) return y.z < x.z ? y : x;
    if (cy) return y;
    if (cx) return x;
    return y.e < x.e ? y : x;
  };
  let pick = refine(guess, [-1e3, -1e3]);
  if (seedHeight > 0) {
    for (const h of [0.5 * seedHeight, seedHeight]) {
      const s = at(h);
      if (s) pick = choose(pick, refine(s, pick.p));
    }
  }
  return pick.p;
}
