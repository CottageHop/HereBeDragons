import * as THREE from 'three';

/**
 * Full-screen quad that samples a color target, a normal target, and a depth
 * texture, then composites a dark "ink" outline where normal-angle or depth
 * discontinuity exceeds thresholds.
 *
 * Designed for an illustrated/sketch look — silhouettes against the sky read
 * as silhouettes (depth jump); roof/wall creases read as inner lines (normal
 * jump). Both contribute additively.
 */

const OUTLINE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const OUTLINE_FRAG = /* glsl */ `
uniform sampler2D uColor;
uniform sampler2D uNormal;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform float uNormalThreshold;
uniform float uDepthThreshold;
uniform float uOutlineStrength;
uniform float uOutlineDarkness;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uShine;
uniform vec3 uShineColor;
uniform float uSaturation;
uniform float uHalftone;        // 0 = off, 1 = full dot-pattern shading
uniform float uHalftoneScale;   // dot-grid cell size in pixels
uniform float uHatching;        // 0 = off, 1 = full hatch density
uniform float uHatchingScale;   // hatch cell size in pixels
uniform mat4 uCameraWorldMatrix; // view→world transform — used to detect flat ground
uniform mat4 uInverseProjection; // clip→view — used to reconstruct world XZ per fragment

varying vec2 vUv;

float linearDepth(float z) {
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
}

float normalDiff(vec3 a, vec3 b) {
  return 1.0 - clamp(dot(normalize(a * 2.0 - 1.0), normalize(b * 2.0 - 1.0)), -1.0, 1.0);
}

// Simple hash → [0, 1). Used to seed per-cell randomness for hatching.
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  vec4 c = texture2D(uColor, uv);

  vec3 nC = texture2D(uNormal, uv).rgb;
  vec3 nL = texture2D(uNormal, uv + vec2(-uTexel.x, 0.0)).rgb;
  vec3 nR = texture2D(uNormal, uv + vec2( uTexel.x, 0.0)).rgb;
  vec3 nU = texture2D(uNormal, uv + vec2(0.0,  uTexel.y)).rgb;
  vec3 nD = texture2D(uNormal, uv + vec2(0.0, -uTexel.y)).rgb;

  float nEdge =
      normalDiff(nC, nL) +
      normalDiff(nC, nR) +
      normalDiff(nC, nU) +
      normalDiff(nC, nD);

  float dC = linearDepth(texture2D(uDepth, uv).r);
  float dL = linearDepth(texture2D(uDepth, uv + vec2(-uTexel.x, 0.0)).r);
  float dR = linearDepth(texture2D(uDepth, uv + vec2( uTexel.x, 0.0)).r);
  float dU = linearDepth(texture2D(uDepth, uv + vec2(0.0,  uTexel.y)).r);
  float dD = linearDepth(texture2D(uDepth, uv + vec2(0.0, -uTexel.y)).r);

  // Normalize depth differences by center depth so distant objects don't get
  // huge outlines just because absolute depth values are large.
  float dEdge =
      abs(dL - dC) +
      abs(dR - dC) +
      abs(dU - dC) +
      abs(dD - dC);
  dEdge /= max(dC, 0.001);

  // Tight smoothstep ramp + raised thresholds — only sharp creases and clear
  // silhouettes survive, which reads as a thinner line.
  float normalEdge = smoothstep(uNormalThreshold, uNormalThreshold * 1.15, nEdge);
  float depthEdge  = smoothstep(uDepthThreshold,  uDepthThreshold  * 1.15, dEdge);
  float depthFade  = 1.0 - smoothstep(uFadeStart, uFadeEnd, dC);
  float edge = clamp(max(normalEdge, depthEdge) * uOutlineStrength * depthFade, 0.0, 1.0);

  // Outline = darkened version of the underlying surface color rather than a
  // fixed near-black. Each surface gets an ink stroke "of its own hue", which
  // reads as a softer pencil/ink sketch and avoids the hard black look.
  vec3 outColor = c.rgb * mix(1.0, uOutlineDarkness, edge);

  // Saturation boost — pulls colors away from grey so the scene feels less dull.
  float lumaSat = dot(outColor, vec3(0.299, 0.587, 0.114));
  outColor = mix(vec3(lumaSat), outColor, uSaturation);

  // Luma-based "shine": bright pixels get an additive warm glow, dark pixels
  // don't. Cheaper than a real bloom pass but reads as soft reflectivity —
  // sunlit roofs and water surfaces gain a polished highlight.
  float luma = dot(outColor, vec3(0.299, 0.587, 0.114));
  float shineFactor = pow(luma, 3.0) * uShine;
  outColor += uShineColor * shineFactor;

  // Halftone shading on 3D surfaces only. The normal texture is in VIEW
  // space, so we transform back to world space via the camera matrix to find
  // pixels whose surface points roughly +Y — those are the flat ground / road
  // / water / landuse layers and should stay clean. Building walls and other
  // non-flat geometry get the dot pattern.
  if (uHalftone > 0.0) {
    vec3 viewNormal = normalize(nC * 2.0 - 1.0);
    vec3 worldNormal = (uCameraWorldMatrix * vec4(viewNormal, 0.0)).xyz;
    // surfaceGate = 1 on a wall, 0 on perfectly flat ground.
    float surfaceGate = 1.0 - smoothstep(0.55, 0.85, abs(worldNormal.y));
    if (surfaceGate > 0.01) {
      float lum = dot(outColor, vec3(0.299, 0.587, 0.114));
      float shade = clamp(1.0 - lum, 0.0, 1.0);
      if (shade > 0.02) {
        vec2 cellSize = vec2(uHalftoneScale);
        vec2 cellCenter = floor(gl_FragCoord.xy / cellSize) * cellSize + cellSize * 0.5;
        float d = distance(gl_FragCoord.xy, cellCenter);
        // Radius scales with shading: 0 at full bright, half the cell at full dark.
        float r = shade * cellSize.x * 0.45;
        float dotMask = 1.0 - smoothstep(r - 0.8, r + 0.8, d);
        // Black dots on a slightly-toned-down version of the surface — keeps
        // the original color readable while the dots eat into shaded areas.
        vec3 surface = mix(vec3(1.0), outColor, 0.15);
        vec3 dotted = mix(surface, vec3(0.0), dotMask);
        outColor = mix(outColor, dotted, uHalftone * surfaceGate);
      }
    }
  }

  // Hatching halo. For pixels NEAR an outline edge (but not on it) we draw a
  // sketchy short black line at a per-cell random angle and length. This adds
  // the inked-by-hand feel without affecting the outline itself.
  if (uHatching > 0.0) {
    // Cheap dilation: read normal at four 5-texel offsets and compare to
    // center. A large normal diff means there's an edge near this offset.
    float dilated = 0.0;
    for (int i = 0; i < 4; i++) {
      float ang = float(i) * 1.5707963;
      vec2 off = vec2(cos(ang), sin(ang)) * uTexel * 5.0;
      vec3 nO = texture2D(uNormal, uv + off).rgb;
      float diff = smoothstep(uNormalThreshold, uNormalThreshold * 1.6, normalDiff(nC, nO));
      dilated = max(dilated, diff);
    }
    // halo = "nearby has an edge but we are NOT the edge ourselves" so hatches
    // form a fringe around outlines instead of doubling them up.
    float halo = clamp(dilated - edge, 0.0, 1.0);
    if (halo > 0.05) {
      // Reconstruct world-space XZ at this fragment from depth so the hatch
      // cells stick to the geometry instead of the screen. Without this,
      // hatches stay locked to pixels and "flow" across the surface as the
      // camera pans.
      float sceneNdcZ = texture2D(uDepth, uv).r * 2.0 - 1.0;
      vec4 clip = vec4(uv * 2.0 - 1.0, sceneNdcZ, 1.0);
      vec4 viewPos = uInverseProjection * clip;
      viewPos /= viewPos.w;
      vec3 worldPos = (uCameraWorldMatrix * vec4(viewPos.xyz, 1.0)).xyz;
      // World-meter cell size — scale tuned to roughly match the pixel size
      // of uHatchingScale at typical city zoom.
      float worldCell = uHatchingScale * 0.10;
      vec2 cellId = floor(worldPos.xz / worldCell);
      float h1 = hash21(cellId);
      float h2 = hash21(cellId + 17.13);
      float h3 = hash21(cellId + 91.77);
      // Skip ~50% of cells so the hatches stay irregular.
      if (h3 > 0.5) {
        vec2 cellCenter = (cellId + 0.5) * worldCell;
        float angle = h1 * 6.2831853;
        vec2 dir = vec2(cos(angle), sin(angle));
        vec2 fromCenter = worldPos.xz - cellCenter;
        float along = dot(fromCenter, dir);
        float perp = abs(dot(fromCenter, vec2(-dir.y, dir.x)));
        float halfLen = mix(worldCell * 0.18, worldCell * 0.5, h2);
        // Thickness in world meters — tied to cell size so it scales with zoom.
        float thickness = worldCell * 0.06;
        float lineMask =
          (1.0 - smoothstep(thickness, thickness * 1.5, perp)) *
          (1.0 - smoothstep(halfLen, halfLen * 1.1, abs(along)));
        outColor = mix(outColor, vec3(0.0), lineMask * halo * uHatching);
      }
    }
  }

  gl_FragColor = vec4(outColor, 1.0);
}
`;

export interface OutlineSettings {
  normalThreshold: number;
  depthThreshold: number;
  outlineStrength: number;
  /**
   * How dark the outline gets. The outline color is the surface color
   * multiplied by this factor (so 0.65 = outline is 65% of the surface
   * brightness, i.e. slightly darker than the surface itself).
   */
  outlineDarkness: number;
  /** View-space depth (m) below which outlines render at full strength. */
  fadeStart: number;
  /** View-space depth (m) at which outlines fully fade out. */
  fadeEnd: number;
  /** Strength of the bright-pixel additive glow (0 = off, ~0.4 = subtle, ~1 = heavy). */
  shine: number;
  /** Tint of the shine highlight. Slightly warm white reads like sunlight. */
  shineColor: THREE.Color;
  /** Saturation multiplier applied before shine. 1 = unchanged, >1 boosts vibrance. */
  saturation: number;
  /** Halftone (dot-pattern) shading strength. 0 = off (default), 1 = full. */
  halftone: number;
  /** Halftone dot-grid cell size in pixels. Default 8. */
  halftoneScale: number;
  /** Edge-halo hatching strength. 0 = off (default), 1 = full. */
  hatching: number;
  /** Hatching cell size in pixels. Default 14. */
  hatchingScale: number;
}

export class OutlinePass {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  settings: OutlineSettings = {
    normalThreshold: 0.20,
    depthThreshold: 0.07,
    outlineStrength: 1.0,
    outlineDarkness: 0.6,
    // View-space depth (m) where outline strength starts to drop. The fade
    // exists so a continent-scale view doesn't get noisy outlines on every
    // sub-pixel building, but it should NOT kick in for normal city / neigh-
    // bourhood browsing. Previously 1500 → outlines visibly weakened at any
    // tilt past near-top-down. 10000 m keeps outlines crisp throughout a
    // typical map session and only starts fading at city-overview range.
    fadeStart: 10000,
    fadeEnd: 40000,
    // Neutral white shine + strong saturation. Saturation does the vibrancy
    // work without shifting hue; the shine is neutral so it doesn't tint
    // bright pixels orange.
    shine: 0.5,
    shineColor: new THREE.Color('#ffffff'),
    saturation: 1.5,
    halftone: 0,
    halftoneScale: 8,
    hatching: 0,
    hatchingScale: 14
  };

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      uniforms: {
        uColor:            { value: null },
        uNormal:           { value: null },
        uDepth:            { value: null },
        uTexel:            { value: new THREE.Vector2(1, 1) },
        uNormalThreshold:  { value: this.settings.normalThreshold },
        uDepthThreshold:   { value: this.settings.depthThreshold },
        uOutlineStrength:  { value: this.settings.outlineStrength },
        uOutlineDarkness:  { value: this.settings.outlineDarkness },
        uCameraNear:       { value: 1 },
        uCameraFar:        { value: 200_000 },
        uFadeStart:        { value: this.settings.fadeStart },
        uFadeEnd:          { value: this.settings.fadeEnd },
        uShine:            { value: this.settings.shine },
        uShineColor:       { value: this.settings.shineColor },
        uSaturation:       { value: this.settings.saturation },
        uHalftone:         { value: this.settings.halftone },
        uHalftoneScale:    { value: this.settings.halftoneScale },
        uHatching:         { value: this.settings.hatching },
        uHatchingScale:    { value: this.settings.hatchingScale },
        uCameraWorldMatrix: { value: new THREE.Matrix4() },
        uInverseProjection: { value: new THREE.Matrix4() }
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

  setInputs(color: THREE.Texture, normal: THREE.Texture, depth: THREE.Texture): void {
    this.material.uniforms.uColor.value = color;
    this.material.uniforms.uNormal.value = normal;
    this.material.uniforms.uDepth.value = depth;
  }

  setCamera(near: number, far: number): void {
    this.material.uniforms.uCameraNear.value = near;
    this.material.uniforms.uCameraFar.value = far;
  }

  /** Push the camera's world matrix — needed by halftone for the flat-ground gate. */
  setCameraWorldMatrix(m: THREE.Matrix4): void {
    this.material.uniforms.uCameraWorldMatrix.value.copy(m);
  }

  /** Push the inverse projection — needed to reconstruct world XZ for hatching. */
  setInverseProjection(m: THREE.Matrix4): void {
    this.material.uniforms.uInverseProjection.value.copy(m);
  }

  setTexel(w: number, h: number): void {
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  applySettings(): void {
    this.material.uniforms.uNormalThreshold.value = this.settings.normalThreshold;
    this.material.uniforms.uDepthThreshold.value = this.settings.depthThreshold;
    this.material.uniforms.uOutlineStrength.value = this.settings.outlineStrength;
    this.material.uniforms.uOutlineDarkness.value = this.settings.outlineDarkness;
    this.material.uniforms.uFadeStart.value = this.settings.fadeStart;
    this.material.uniforms.uFadeEnd.value = this.settings.fadeEnd;
    this.material.uniforms.uShine.value = this.settings.shine;
    this.material.uniforms.uShineColor.value = this.settings.shineColor;
    this.material.uniforms.uSaturation.value = this.settings.saturation;
    this.material.uniforms.uHalftone.value = this.settings.halftone;
    this.material.uniforms.uHalftoneScale.value = this.settings.halftoneScale;
    this.material.uniforms.uHatching.value = this.settings.hatching;
    this.material.uniforms.uHatchingScale.value = this.settings.hatchingScale;
  }

  dispose(): void {
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    this.material.dispose();
  }
}
