import * as THREE from 'three';

/**
 * Animated decibel heat-map overlay rendered as a screen-space post-process.
 *
 * Inputs: a sparse array of point sound sources `{ x, z, db }` in scene-world
 * coordinates (lat/lon converted by DragonMap before reaching this pass).
 *
 * Per pixel: unproject the NDC ray, intersect the ground plane (y = 0), and
 * sum the inverse-square dB contribution from every source. Pixels in audible
 * range (≥ 30 dB) get mapped through a green → yellow → red color ramp and
 * blended over the input scene color. Per-source phase-offset ring bands
 * pulse outward over time so multiple sources don't beat in lockstep.
 *
 * Ports PolyMap's `src/noise.wgsl` to GLSL. The only meaningful change from
 * the WGSL original is the ground-position reconstruction: PolyMap assumes
 * an orthographic camera; we reconstruct the world ray and intersect y = 0
 * so a tilted DragonMap camera still gets the correct ground position
 * under each pixel.
 *
 * Pipeline placement: between OutlinePass and CloudsPass. Sits on top of
 * stylized geometry but underneath atmospheric clouds — clouds will fade
 * the heat-map at the horizon the same way they fade buildings.
 */

/**
 * Max sources uploaded per frame. Matches PolyMap's `MAX_NOISE_SOURCES`.
 * 128 × vec4 = 8 KB of uniform memory, well inside the WebGL 2 / WebGPU
 * minimum 16 KB per-shader uniform-storage guarantee on every device we
 * care about. Apps with more sources should spatial-cull on the CPU and
 * upload the closest 128 to the camera.
 */
export const MAX_NOISE_SOURCES = 128;

const NOISE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const NOISE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uColor;
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform vec3 uCameraPos;
uniform float uTime;
uniform int uSourceCount;
// Packed: xy = world ground position (x, z), z = decibels at 1 unit. .w unused.
uniform vec4 uSources[${MAX_NOISE_SOURCES}];

varying vec2 vUv;

// Ripple band parameters — port of PolyMap's noise.wgsl tunables.
const float WAVELENGTH = 14.0;   // world units between ring peaks
const float RIPPLE_SPEED = 5.0;  // world units / sec radial outward
const float SHARPNESS = 10.0;    // higher → thinner bright bands

// Color ramp: 40 dB (background) → 90 dB (painfully loud).
vec4 ramp(float db) {
  float t = clamp((db - 40.0) / 50.0, 0.0, 1.0);
  vec3 green  = vec3(0.20, 0.80, 0.35);
  vec3 yellow = vec3(0.95, 0.85, 0.20);
  vec3 red    = vec3(0.90, 0.15, 0.15);
  vec3 col;
  if (t < 0.5) {
    col = mix(green, yellow, t * 2.0);
  } else {
    col = mix(yellow, red, (t - 0.5) * 2.0);
  }
  // Alpha grows with noise level so quiet areas are almost clear.
  float a = clamp(t * 0.7 + 0.1, 0.0, 0.6);
  return vec4(col, a);
}

void main() {
  vec4 sceneColor = texture2D(uColor, vUv);
  if (uSourceCount == 0) {
    gl_FragColor = sceneColor;
    return;
  }

  // --- Reconstruct ground-plane position at this pixel -----------------
  // Same world-ray trick CloudsPass uses, but intersect y = 0 instead of
  // a slab. Pixels whose ray goes parallel-or-up from a ground-level camera
  // never hit (sky pixels) — fall back to the unmodified scene.
  vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 viewPos = uInverseProjection * clip;
  viewPos /= viewPos.w;
  vec3 worldDir = normalize((uInverseView * vec4(viewPos.xyz, 0.0)).xyz);
  if (abs(worldDir.y) < 1e-5) {
    gl_FragColor = sceneColor;
    return;
  }
  float t = -uCameraPos.y / worldDir.y;
  if (t <= 0.0) {
    // Ray points away from the ground (sky pixel).
    gl_FragColor = sceneColor;
    return;
  }
  vec3 ground = uCameraPos + worldDir * t;
  vec2 pos = vec2(ground.x, ground.z);

  // --- Sum power across every source, with per-source ring band --------
  // log10 = log(x) / log(10). Both are natural-log built-ins in GLSL ES.
  float totalPower = 0.0;
  float ringAccum = 0.0;
  for (int i = 0; i < ${MAX_NOISE_SOURCES}; i++) {
    if (i >= uSourceCount) break;
    vec4 src = uSources[i];
    vec2 srcPos = src.xy;
    float srcDb = src.z;
    float d = max(distance(pos, srcPos), 1.0);
    float dbHere = srcDb - 20.0 * log(d) / log(10.0);
    if (dbHere > 30.0) {
      float weight = pow(10.0, dbHere / 10.0);
      totalPower += weight;
      float phaseOffset = srcPos.x * 0.1 + srcPos.y * 0.07;
      float phase = d / WAVELENGTH - uTime * RIPPLE_SPEED / WAVELENGTH + phaseOffset;
      float band = pow(max(0.0, sin(phase * 6.2831853)), SHARPNESS);
      ringAccum += band * weight;
    }
  }
  if (totalPower < 1.0) {
    gl_FragColor = sceneColor;
    return;
  }
  float totalDb = 10.0 * log(totalPower) / log(10.0);
  vec4 col = ramp(totalDb);

  // Ring highlight: louder spots get proportionally brighter bands.
  float ringStrength = clamp(ringAccum / max(totalPower, 1.0), 0.0, 1.0);
  col.rgb += vec3(ringStrength * 0.5);
  col.a = clamp(col.a + ringStrength * 0.35, 0.0, 0.9);

  // Standard alpha composite onto scene.
  vec3 outRgb = mix(sceneColor.rgb, col.rgb, col.a);
  gl_FragColor = vec4(outRgb, 1.0);
}
`;

export class NoisePass {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  /** Backing array for the `uSources[]` uniform. Re-uploaded on each update. */
  private readonly sourceData: Float32Array;

  constructor() {
    this.sourceData = new Float32Array(MAX_NOISE_SOURCES * 4);
    // Three.js represents a vec4 array uniform as an array of Vector4 OR a
    // flat Float32Array — the latter copies as a single GL call. Wrap each
    // slot in a Vector4 view so updates write into the shared backing buffer.
    const sources: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_NOISE_SOURCES; i++) {
      sources.push(
        new THREE.Vector4(
          this.sourceData[i * 4 + 0],
          this.sourceData[i * 4 + 1],
          this.sourceData[i * 4 + 2],
          this.sourceData[i * 4 + 3]
        )
      );
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: NOISE_VERT,
      fragmentShader: NOISE_FRAG,
      uniforms: {
        uColor:             { value: null },
        uInverseProjection: { value: new THREE.Matrix4() },
        uInverseView:       { value: new THREE.Matrix4() },
        uCameraPos:         { value: new THREE.Vector3() },
        uTime:              { value: 0 },
        uSourceCount:       { value: 0 },
        uSources:           { value: sources }
      },
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

  setInput(color: THREE.Texture): void {
    this.material.uniforms.uColor.value = color;
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    this.material.uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    this.material.uniforms.uInverseView.value.copy(camera.matrixWorld);
    this.material.uniforms.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
  }

  setTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  /**
   * Replace the entire source list. Excess sources beyond MAX_NOISE_SOURCES
   * are silently dropped — callers should spatial-cull on the CPU when their
   * dataset is larger.
   *
   * @param sources scene-world coords: `{ x, z, db }`. `x` is east, `z` is
   *   south (matching the scene-graph axis convention used by Projection).
   */
  setSources(sources: ReadonlyArray<{ x: number; z: number; db: number }>): void {
    const n = Math.min(sources.length, MAX_NOISE_SOURCES);
    const slots = this.material.uniforms.uSources.value as THREE.Vector4[];
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      slots[i].set(s.x, s.z, s.db, 0);
    }
    // Zero the rest so a shrink doesn't leave stale dB values in unused slots
    // (the shader bails on `i >= uSourceCount`, so this is defense-in-depth
    // rather than load-bearing).
    for (let i = n; i < MAX_NOISE_SOURCES; i++) {
      slots[i].set(0, 0, 0, 0);
    }
    this.material.uniforms.uSourceCount.value = n;
  }

  /** Live count of active sources (last value passed to setSources). */
  getSourceCount(): number {
    return this.material.uniforms.uSourceCount.value as number;
  }

  dispose(): void {
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    this.material.dispose();
  }
}
