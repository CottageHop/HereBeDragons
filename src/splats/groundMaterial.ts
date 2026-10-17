import * as THREE from 'three';
import { ROUNDED_UNION_GLSL } from './roundedUnion.js';
import { RIPPLE_OVERSHOOT, RIPPLE_RING_AMPLITUDE, RIPPLE_RING_PHASE_RATE } from './ripple.js';

/**
 * Uniforms shared by every splat-tile ground plane AND mirrored into Spark's
 * per-splat modifier, so the imagery and the splats reveal under one front.
 * `uActive` = 0 means "fully revealed, ignore the ripple" (the steady state).
 */
export interface RippleUniforms {
  /** Ripple origin in scene x/z. */
  uOrigin: { value: THREE.Vector2 };
  /** Front radius, scene metres. */
  uR: { value: number };
  /** Band width behind the front, scene metres. */
  uW: { value: number };
  /** Seconds into the animation (ring shimmer phase). */
  uTime: { value: number };
  /** 1 while a ripple is playing, else 0. */
  uActive: { value: number };
}

export function createRippleUniforms(): RippleUniforms {
  return {
    uOrigin: { value: new THREE.Vector2() },
    uR: { value: 0 },
    uW: { value: 1 },
    uTime: { value: 0 },
    uActive: { value: 0 }
  };
}

/**
 * GLSL mirror of `ripple.ts`: the reveal envelope, the ±10 % sine ring and
 * the ground's bright wave. Shared between this material and (in spirit) the
 * dyno graph in SplatsLayer, which is built from the same constants.
 */
const RIPPLE_GLSL = /* glsl */ `
  const float RIPPLE_OVERSHOOT = ${RIPPLE_OVERSHOOT.toFixed(3)};
  const float RIPPLE_RING_AMPLITUDE = ${RIPPLE_RING_AMPLITUDE.toFixed(3)};
  const float RIPPLE_RING_PHASE_RATE = ${RIPPLE_RING_PHASE_RATE.toFixed(3)};
  float rippleReveal(float d, float R, float w) {
    float s = clamp((R - d) / w, 0.0, 1.0);
    return s * s * (3.0 - 2.0 * s);
  }
  float rippleGroundBrightness(float d, float R, float w) {
    float band = (R - d) / w;
    if (band <= 0.0 || band >= 1.0) return 1.0;
    return 1.0 + 4.0 * RIPPLE_RING_AMPLITUDE * sin(3.14159265 * band);
  }
`;

/**
 * Per-tile uniforms of the rounded-union mask (see `roundedUnion.ts`). The
 * SAME `Vector4` instances back the tile's Spark dyno uniforms, so one write
 * moves the splats and the ground together.
 */
export interface UnionUniforms {
  /** Edge-neighbour weights: x = E, y = W, z = N, w = S. */
  uUnionEdge: { value: THREE.Vector4 };
  /** Diagonal-block weights (already min'd with their two edges):
   *  x = NE, y = NW, z = SE, w = SW. */
  uUnionCorner: { value: THREE.Vector4 };
  /** Growth of each edge bridge, min(own g, neighbour g): E, W, N, S. */
  uUnionEdgeG: { value: THREE.Vector4 };
  /** Growth of each block, min over its four tiles: NE, NW, SE, SW. */
  uUnionCornerG: { value: THREE.Vector4 };
  /** The tile's own growth, 0 → 1. */
  uUnionG: { value: number };
  /** Soft-edge half-width in tile units; negative = mask off (square tile). */
  uUnionFeather: { value: number };
}

/** Per-tile level cross-dissolve of the imagery ground (see `levelFade.ts`). */
export interface LevelFadeUniform {
  /** Ground alpha factor, 0 → 1 (1 = steady state). */
  uLevelFade: { value: number };
}

export function createUnionUniforms(feather: number): UnionUniforms {
  return {
    uUnionEdge: { value: new THREE.Vector4() },
    uUnionCorner: { value: new THREE.Vector4() },
    uUnionEdgeG: { value: new THREE.Vector4() },
    uUnionCornerG: { value: new THREE.Vector4() },
    uUnionG: { value: 0 },
    uUnionFeather: { value: feather }
  };
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPosition.xyz;
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float uHasMap;
  uniform vec3 uFallback;
  uniform vec2 uOrigin;
  uniform float uR;
  uniform float uW;
  uniform float uTime;
  uniform float uActive;
  uniform vec4 uUnionEdge;
  uniform vec4 uUnionCorner;
  uniform vec4 uUnionEdgeG;
  uniform vec4 uUnionCornerG;
  uniform float uUnionG;
  uniform float uUnionFeather;
  uniform float uLevelFade;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  #include <fog_pars_fragment>
  ${RIPPLE_GLSL}
  ${ROUNDED_UNION_GLSL}
  void main() {
    vec4 tex = texture2D(map, vUv);
    vec3 color = mix(uFallback, tex.rgb, uHasMap);
    float alpha = 1.0;
    if (uActive > 0.5) {
      float d = length(vWorldPos.xz - uOrigin);
      alpha = rippleReveal(d, uR, uW);
      color *= rippleGroundBrightness(d, uR, uW);
    }
    // Rounded union of the loaded tiles (× the ripple front, if any).
    if (uUnionFeather >= 0.0) {
      // PlaneGeometry puts uv (0,0) at the plane's −x/−y corner and the plane
      // lies in the tile-local frame (x east, y north): u runs east, v NORTH —
      // the frame the mask is defined in.
      alpha *= hbdRoundedUnionMask(
        vUv, uUnionEdge, uUnionCorner, uUnionEdgeG, uUnionCornerG, uUnionG, uUnionFeather);
    }
    // Level cross-dissolve (1 in the steady state).
    alpha *= uLevelFade;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * Textured ground plane material for one splat tile. sRGB imagery, mipmaps,
 * anisotropy (set on the texture by the caller), fog-aware, driven by the
 * shared ripple uniforms so it reveals under the same front as the splats,
 * and cut to the rounded union of the loaded tiles by the per-tile `union`
 * uniforms (ripple front × union mask).
 * Starts as a flat `fallback` colour until `setMap()` is called.
 */
export function createSplatGroundMaterial(
  ripple: RippleUniforms,
  union: UnionUniforms | null = null,
  fallback = new THREE.Color(0x3a4a3a),
  levelFade: LevelFadeUniform | null = null
): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        map: { value: null },
        uHasMap: { value: 0 },
        uFallback: { value: fallback }
      }
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide
  });
  // Share (not clone) the ripple uniforms so one write per frame drives
  // every tile's ground. UniformsUtils.merge clones, hence the manual assign.
  mat.uniforms.uOrigin = ripple.uOrigin;
  mat.uniforms.uR = ripple.uR;
  mat.uniforms.uW = ripple.uW;
  mat.uniforms.uTime = ripple.uTime;
  mat.uniforms.uActive = ripple.uActive;
  // Per-tile union mask (shared by reference with the tile's splat modifier);
  // without one the plane stays a plain square.
  const u = union ?? createUnionUniforms(-1);
  mat.uniforms.uUnionEdge = u.uUnionEdge;
  mat.uniforms.uUnionCorner = u.uUnionCorner;
  mat.uniforms.uUnionEdgeG = u.uUnionEdgeG;
  mat.uniforms.uUnionCornerG = u.uUnionCornerG;
  mat.uniforms.uUnionG = u.uUnionG;
  mat.uniforms.uUnionFeather = u.uUnionFeather;
  mat.uniforms.uLevelFade = levelFade?.uLevelFade ?? { value: 1 };
  mat.name = 'hbd-splats:ground';
  return mat;
}

export function setSplatGroundMap(mat: THREE.ShaderMaterial, tex: THREE.Texture | null): void {
  mat.uniforms.map.value = tex;
  mat.uniforms.uHasMap.value = tex ? 1 : 0;
  mat.needsUpdate = true;
}
