import * as THREE from 'three';

/**
 * Raymarched volumetric clouds rendered as a screen-space post-process pass.
 *
 * Reconstructs a world-space view ray per pixel, intersects it with a flat
 * cloud-layer "slab" between two altitudes, then marches through that slab
 * sampling 3D fBm noise. Density along each step is converted into in-scatter
 * from the sun direction via Beer's law, accumulated front-to-back, and
 * composited over the input scene color. Scene depth is sampled so clouds
 * correctly occlude behind tall buildings and the camera can fly through them.
 *
 * The noise sample position is offset by `wind × time` to make the volume
 * drift slowly across the sky.
 *
 * Pipeline placement: between OutlinePass and FxaaPass. Reads outline output
 * as scene color, writes blended result for FXAA to anti-alias. No outline
 * stylization is applied to the clouds themselves — they stay realistic.
 */

const CLOUDS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const CLOUDS_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform vec3 uCameraPos;
uniform float uCameraNear;
uniform float uCameraFar;

uniform float uAltitudeMin;
uniform float uAltitudeMax;
uniform float uCoverage;
uniform float uDensityScale;
uniform vec3 uWindDir;
uniform float uWindSpeed;
uniform float uTime;
uniform vec3 uSunDir;          // normalized; from surface toward sun
uniform vec3 uCloudColor;
uniform vec3 uShadowColor;
uniform vec3 uFogColor;
uniform float uFogDensity;     // matches scene FogExp2 density
uniform int uStepCount;
uniform int uLightStepCount;
uniform float uNoiseScale;
uniform vec2 uMouseUv;          // pointer position in UV space; (-10,-10) = no pointer
uniform float uMouseRadius;     // radius in UV units within which clouds dissipate
uniform float uMouseStrength;   // 0..1; fraction of density removed at the cursor
uniform float uAspect;          // canvas width / height — used to circularize the mouse disk
uniform float uOpacity;         // 0..1; overall cloud blend; 1 = full, 0 = invisible

varying vec2 vUv;

// ---------------------------------------------------------------------------
// 3D value noise — hash-based, no texture lookup.
// ---------------------------------------------------------------------------

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * valueNoise3(p);
    p *= 2.13;
    a *= 0.5;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Density at a world-space point. Returns 0 outside the slab; inside,
// shapes an fBm noise field by coverage and a vertical falloff envelope so
// clouds are densest in the middle of the layer and feather at top/bottom.
// ---------------------------------------------------------------------------

float cloudDensity(vec3 worldPos) {
  if (worldPos.y < uAltitudeMin || worldPos.y > uAltitudeMax) return 0.0;

  // Vertical envelope: 0 at slab edges, 1 in the middle, with a soft falloff.
  float h = (worldPos.y - uAltitudeMin) / (uAltitudeMax - uAltitudeMin);
  float envelope = smoothstep(0.0, 0.25, h) * smoothstep(1.0, 0.7, h);

  // Drift the noise sample with wind × time.
  vec3 samplePos = worldPos + uWindDir * uWindSpeed * uTime;
  float n = fbm(samplePos * uNoiseScale);

  // Coverage threshold: pixels below coverage produce no density.
  float d = smoothstep(uCoverage, 1.0, n) * envelope;
  return d;
}

// ---------------------------------------------------------------------------
// Reconstruct linear view-space distance along the ray for the scene-depth
// texel at this pixel. Used to clamp the cloud march so clouds don't render
// in front of opaque scene geometry.
// ---------------------------------------------------------------------------

float linearizeDepth(float zNdc) {
  float ndc = zNdc * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) /
         (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
}

// Slab intersection: returns vec2(tEnter, tExit). If the ray misses the
// slab entirely, tExit ≤ tEnter and we early-out.
vec2 slabIntersect(vec3 ro, vec3 rd, float yMin, float yMax) {
  // Ray parallel to slab: either entirely inside or outside.
  if (abs(rd.y) < 1e-5) {
    if (ro.y >= yMin && ro.y <= yMax) return vec2(0.0, uCameraFar);
    return vec2(0.0, -1.0);
  }
  float t1 = (yMin - ro.y) / rd.y;
  float t2 = (yMax - ro.y) / rd.y;
  float tEnter = max(min(t1, t2), 0.0);
  float tExit  = max(t1, t2);
  return vec2(tEnter, tExit);
}

void main() {
  vec4 sceneColor = texture2D(uColor, vUv);

  // --- Reconstruct world-space view ray --------------------------------
  vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 viewPos = uInverseProjection * clip;
  viewPos /= viewPos.w;
  vec3 worldDir = normalize((uInverseView * vec4(viewPos.xyz, 0.0)).xyz);
  vec3 rayOrigin = uCameraPos;

  // --- Slab intersection ----------------------------------------------
  vec2 slabT = slabIntersect(rayOrigin, worldDir, uAltitudeMin, uAltitudeMax);
  if (slabT.y <= slabT.x) {
    gl_FragColor = sceneColor;
    return;
  }

  // --- Clamp by scene depth -------------------------------------------
  float sceneZ = linearizeDepth(texture2D(uDepth, vUv).r);
  // Convert view-space depth → distance along the (normalized) ray. The view
  // forward direction in world space is the third column of the inverse view;
  // dot with the ray direction gives the projection factor.
  vec3 camForward = normalize((uInverseView * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
  float rayProjectFactor = max(dot(worldDir, camForward), 1e-4);
  float tSceneHit = sceneZ / rayProjectFactor;

  float tEnter = slabT.x;
  float tExit  = min(slabT.y, tSceneHit);
  if (tEnter >= tExit) {
    gl_FragColor = sceneColor;
    return;
  }

  // --- Main raymarch --------------------------------------------------
  float stepLen = (tExit - tEnter) / float(uStepCount);
  vec3 accumColor = vec3(0.0);
  float accumTransmittance = 1.0;

  // Per-pixel jitter on the start position. Converts the regular step pattern
  // (which shows as banding rings) into pixel-level noise that FXAA smooths
  // out. Static (no time component) so it doesn't shimmer between frames.
  float jitter = hash13(vec3(gl_FragCoord.xy, 1.0));
  float t = tEnter + stepLen * jitter;

  // Screen-space "wisp" envelope: clouds at full density toward the center of
  // the view, feathering toward the edges. As the user pans, what was central
  // moves outward and dissolves — gives the feeling of clouds streaming past.
  float r = distance(vUv, vec2(0.5));
  float wisp = 1.0 - smoothstep(0.30, 0.62, r) * 0.85;

  // Pointer disturbance: clouds within uMouseRadius of the cursor dissipate
  // by uMouseStrength. Distance is aspect-corrected so the affected region is
  // a circle in screen space rather than a stretched ellipse on wide displays.
  vec2 mouseDelta = vUv - uMouseUv;
  mouseDelta.x *= uAspect;
  float mouseDist = length(mouseDelta);
  float mouseFalloff = smoothstep(0.0, uMouseRadius, mouseDist);
  float mouseMult = mix(1.0 - uMouseStrength, 1.0, mouseFalloff);
  wisp *= mouseMult;

  for (int i = 0; i < 128; i++) {
    if (i >= uStepCount) break;
    if (accumTransmittance < 0.01) break;

    vec3 p = rayOrigin + worldDir * t;
    float density = cloudDensity(p) * wisp;
    if (density > 0.0) {
      // Light raymarch toward the sun for soft self-shadowing.
      float lightDensity = 0.0;
      float lightStep = (uAltitudeMax - uAltitudeMin) * 0.3 / float(uLightStepCount);
      for (int j = 0; j < 32; j++) {
        if (j >= uLightStepCount) break;
        vec3 lp = p + uSunDir * lightStep * float(j + 1);
        lightDensity += cloudDensity(lp) * lightStep;
      }
      float lightT = exp(-lightDensity * uDensityScale * 1.4);

      vec3 lit = mix(uShadowColor, uCloudColor, lightT);
      float stepDensity = density * uDensityScale;
      float absorb = exp(-stepDensity * stepLen);
      // Energy-conserving front-to-back accumulation.
      vec3 inscatter = lit * (1.0 - absorb);
      accumColor += inscatter * accumTransmittance;
      accumTransmittance *= absorb;
    }

    t += stepLen;
  }

  // --- Fog (match scene FogExp2 so clouds fade with distance) ----------
  // Apply to the cloud color using the depth at the cloud entry point.
  float fogD = tEnter;
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * fogD * fogD);
  accumColor = mix(accumColor, uFogColor, fogFactor);

  // --- Composite over scene -------------------------------------------
  // Blend the cloud contribution toward zero by uOpacity so the studio can
  // dial clouds from invisible (0) to fully opaque (1) without re-toggling
  // the entire pass. At uOpacity=0 the output matches sceneColor exactly.
  vec3 cloudOut = sceneColor.rgb * accumTransmittance + accumColor;
  vec3 outColor = mix(sceneColor.rgb, cloudOut, uOpacity);
  gl_FragColor = vec4(outColor, 1.0);
}
`;

export interface CloudSettings {
  /** Lower edge of the cloud-layer slab, in world meters above ground. */
  altitudeMin: number;
  /** Upper edge of the cloud-layer slab. */
  altitudeMax: number;
  /** Coverage threshold (0 = overcast, 1 = clear sky). Sweet spot ~0.5. */
  coverage: number;
  /** Density multiplier applied to the noise field. */
  densityScale: number;
  /** Spatial frequency of the noise. Smaller = larger fluffier clouds. */
  noiseScale: number;
  /** Wind direction (will be normalized). */
  windDir: THREE.Vector3;
  /** Wind speed in m/s. */
  windSpeed: number;
  /** Direct sunlight color (top of cloud). */
  cloudColor: THREE.Color;
  /** Shadow color (deep inside / underside of cloud). */
  shadowColor: THREE.Color;
  /** Number of main raymarch steps. */
  stepCount: number;
  /** Number of secondary raymarch steps toward the sun for self-shadowing. */
  lightStepCount: number;
}

export class CloudsPass {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;

  settings: CloudSettings = {
    altitudeMin: 600,
    altitudeMax: 1100,
    coverage: 0.55,
    // Lower density for more transparent clouds. Combined with the jittered
    // start position and 48 march steps, integration is smooth and clouds
    // feel airy rather than solid.
    densityScale: 3.2,
    noiseScale: 0.0015,
    windDir: new THREE.Vector3(1, 0, 0.3).normalize(),
    windSpeed: 8,
    cloudColor: new THREE.Color('#ffffff'),
    shadowColor: new THREE.Color('#b8c4d0'),
    stepCount: 48,
    lightStepCount: 5
  };

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: CLOUDS_VERT,
      fragmentShader: CLOUDS_FRAG,
      uniforms: {
        uColor:              { value: null },
        uDepth:              { value: null },
        uInverseProjection:  { value: new THREE.Matrix4() },
        uInverseView:        { value: new THREE.Matrix4() },
        uCameraPos:          { value: new THREE.Vector3() },
        uCameraNear:         { value: 10 },
        uCameraFar:          { value: 60_000 },
        uAltitudeMin:        { value: this.settings.altitudeMin },
        uAltitudeMax:        { value: this.settings.altitudeMax },
        uCoverage:           { value: this.settings.coverage },
        uDensityScale:       { value: this.settings.densityScale },
        uNoiseScale:         { value: this.settings.noiseScale },
        uWindDir:            { value: this.settings.windDir.clone().normalize() },
        uWindSpeed:          { value: this.settings.windSpeed },
        uTime:               { value: 0 },
        uSunDir:             { value: new THREE.Vector3(0.5, 0.75, 0.4).normalize() },
        uCloudColor:         { value: this.settings.cloudColor },
        uShadowColor:        { value: this.settings.shadowColor },
        uFogColor:           { value: new THREE.Color('#e6f0fa') },
        uFogDensity:         { value: 0.00012 },
        uStepCount:          { value: this.settings.stepCount },
        uLightStepCount:     { value: this.settings.lightStepCount },
        // Default mouse position off-screen so there's no effect when the
        // pointer hasn't been seen yet (or has left the canvas).
        uMouseUv:            { value: new THREE.Vector2(-10, -10) },
        uMouseRadius:        { value: 0.22 },
        uMouseStrength:      { value: 0.95 },
        uAspect:             { value: 1.0 },
        uOpacity:            { value: 1.0 }
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

  setInputs(color: THREE.Texture, depth: THREE.Texture): void {
    this.material.uniforms.uColor.value = color;
    this.material.uniforms.uDepth.value = depth;
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    this.material.uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    this.material.uniforms.uInverseView.value.copy(camera.matrixWorld);
    this.material.uniforms.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    this.material.uniforms.uCameraNear.value = camera.near;
    this.material.uniforms.uCameraFar.value = camera.far;
  }

  setTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  setSunDirection(dir: THREE.Vector3): void {
    this.material.uniforms.uSunDir.value.copy(dir).normalize();
  }

  setFog(color: THREE.Color, density: number): void {
    this.material.uniforms.uFogColor.value.copy(color);
    this.material.uniforms.uFogDensity.value = density;
  }

  /** Pointer position in UV space (0..1, origin bottom-left). Use (-10,-10) to disable. */
  setMouseUv(u: number, v: number): void {
    this.material.uniforms.uMouseUv.value.set(u, v);
  }

  setAspect(aspect: number): void {
    this.material.uniforms.uAspect.value = aspect;
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.uOpacity.value = Math.max(0, Math.min(1, opacity));
  }

  applySettings(): void {
    const u = this.material.uniforms;
    u.uAltitudeMin.value = this.settings.altitudeMin;
    u.uAltitudeMax.value = this.settings.altitudeMax;
    u.uCoverage.value = this.settings.coverage;
    u.uDensityScale.value = this.settings.densityScale;
    u.uNoiseScale.value = this.settings.noiseScale;
    u.uWindDir.value.copy(this.settings.windDir).normalize();
    u.uWindSpeed.value = this.settings.windSpeed;
    u.uCloudColor.value.copy(this.settings.cloudColor);
    u.uShadowColor.value.copy(this.settings.shadowColor);
    u.uStepCount.value = this.settings.stepCount;
    u.uLightStepCount.value = this.settings.lightStepCount;
  }

  dispose(): void {
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    this.material.dispose();
  }
}
