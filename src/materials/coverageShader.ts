import * as THREE from 'three';

/**
 * GPU side of the basemap "tile reveal" (see `tiles/CoverageField.ts`).
 *
 * The visible region of the vector basemap is the rounded union of the
 * loaded tiles. The CPU bakes that shape into ONE small world-space texture
 * — a signed edge distance, not the mask itself, so bilinear filtering
 * reconstructs a crisp round outline from ~17 texels per tile — and every
 * basemap material samples it by world XZ. Sampling by world position (not
 * per tile) is what lets cross-tile things — bridges, cars, labels — follow
 * the same outline with no per-object bookkeeping.
 *
 * All materials share these uniform OBJECTS by reference, so one write from
 * the field reaches every program. `uCoverageParams.x` is the on/off switch:
 * 0 (with the cut-out off too) makes `hbdCoverage()` return 1 before it
 * touches the texture, so a disabled reveal draws exactly what the unpatched
 * shaders drew.
 *
 * The texture has a SECOND channel — the CUT-OUT: the rounded union of the
 * splat overlay's resident tiles ("3D satellite"), baked by the same field
 * from the very values the overlay's own GPU mask uses. Where the satellite
 * has landed the vector basemap is removed: `hbdCoverage()` returns
 * `reveal · (1 − cut)`, the exact complement of the imagery's alpha
 * (`cut = smoothstep(0, 2·feather, s) · rippleFront`), so the satellite's
 * feathered rim and the vector map's dithered cut dissolve into each other
 * with neither a gap nor a doubly-covered band. One texture fetch serves both
 * channels. Labels have their own entry point (`hbdCoverageLabel`) because a
 * hybrid map keeps them on top of the imagery unless told otherwise.
 */
export interface CoverageUniforms {
  uCoverageTex: { value: THREE.Texture };
  /** World rect of the texture: (xMin, zMin, 1 / width, 1 / depth). */
  uCoverageRect: { value: THREE.Vector4 };
  /** (enabled 0|1, decode scale, decode bias, 1 / (2·feather)) — the texel
   *  value `r` decodes to the signed edge distance `s = r·scale + bias` in
   *  tile units; the mask is `smoothstep(0, 2·feather, s)`. */
  uCoverageParams: { value: THREE.Vector4 };
  /**
   * Cut-out channel (G): (mode, decode scale, decode bias, unused). `mode` is
   * 0 = off, 1 = cut the basemap but keep labels, 2 = cut labels too. The
   * texel decodes to the RAMP COORDINATE `t = g·scale + bias` — the signed
   * edge distance over the feather width, so it is unit-free across splat
   * levels — and the cut is `smoothstep(0, 1, t)`.
   */
  uCoverageCut: { value: THREE.Vector4 };
  /** The overlay's ripple front, which its imagery alpha is multiplied by:
   *  (origin x, origin z, front radius R, band width W); `W ≤ 0` = no ripple. */
  uCoverageRipple: { value: THREE.Vector4 };
}

/** Uniforms in their "reveal off" state: a 1×1 fully-covered texture. */
export function createCoverageUniforms(): CoverageUniforms {
  const tex = new THREE.DataTexture(new Uint8Array([255, 0]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return {
    uCoverageTex: { value: tex },
    uCoverageRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uCoverageParams: { value: new THREE.Vector4(0, 1, 0, 1) },
    uCoverageCut: { value: new THREE.Vector4(0, 1, 0, 0) },
    uCoverageRipple: { value: new THREE.Vector4(0, 0, 0, 0) }
  };
}

/** Point a material's / shader's uniform map at the shared objects. */
export function registerCoverageUniforms(
  target: { [name: string]: THREE.IUniform },
  coverage: CoverageUniforms
): void {
  target.uCoverageTex = coverage.uCoverageTex;
  target.uCoverageRect = coverage.uCoverageRect;
  target.uCoverageParams = coverage.uCoverageParams;
  target.uCoverageCut = coverage.uCoverageCut;
  target.uCoverageRipple = coverage.uCoverageRipple;
}

/**
 * `hbdCoverage(worldXZ)` → mask in [0,1]: the tile reveal times the
 * complement of the satellite cut-out. Valid in both shader stages (the
 * texture has no mips, so no derivatives are involved). Outside the field's
 * window the reveal is 0 (tiles out there are past the keep zone) and so is
 * the cut. `hbdCoverageLabel` is the same for labels, which ignore the
 * cut-out unless its mode says otherwise. With both features off neither
 * touches the texture.
 */
export const COVERAGE_GLSL = /* glsl */ `
uniform sampler2D uCoverageTex;
uniform vec4 uCoverageRect;
uniform vec4 uCoverageParams;
uniform vec4 uCoverageCut;
uniform vec4 uCoverageRipple;
float hbdCoverageMix(vec2 worldXZ, float cutMode) {
  bool reveal = uCoverageParams.x > 0.5;
  bool cut = uCoverageCut.x >= cutMode;
  if (!reveal && !cut) return 1.0;
  vec2 uv = (worldXZ - uCoverageRect.xy) * uCoverageRect.zw;
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  vec2 rg = texture2D(uCoverageTex, uv).rg;
  float c = 1.0;
  if (reveal) {
    float t = clamp((rg.r * uCoverageParams.y + uCoverageParams.z) * uCoverageParams.w, 0.0, 1.0)
      * inside.x * inside.y;
    c = t * t * (3.0 - 2.0 * t);
  }
  if (cut) {
    float k = clamp(rg.g * uCoverageCut.y + uCoverageCut.z, 0.0, 1.0) * inside.x * inside.y;
    k = k * k * (3.0 - 2.0 * k);
    if (uCoverageRipple.w > 0.0) {
      float f = clamp((uCoverageRipple.z - length(worldXZ - uCoverageRipple.xy)) / uCoverageRipple.w, 0.0, 1.0);
      k *= f * f * (3.0 - 2.0 * f);
    }
    c *= 1.0 - k;
  }
  return c;
}
float hbdCoverage(vec2 worldXZ) { return hbdCoverageMix(worldXZ, 0.5); }
float hbdCoverageLabel(vec2 worldXZ) { return hbdCoverageMix(worldXZ, 1.5); }
`;

/**
 * Fragment-only: `hbdCoverageDiscard(worldXZ)` cuts an OPAQUE material to
 * the mask. No MSAA anywhere (and pixel ratio 1 on the 'low' tier), so the
 * soft edge is a 4×4 ordered (Bayer) dither across the feather ramp rather
 * than alpha. Thresholds are (k + 0.5) / 16, so a mask of exactly 1 — every
 * settled interior texel — never discards (no dither crawl at rest) and a
 * mask of 0 always does.
 */
export const COVERAGE_DISCARD_GLSL = /* glsl */ `
${COVERAGE_GLSL}
float hbdBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float hbdBayer4(vec2 a) { return hbdBayer2(0.5 * a) * 0.25 + hbdBayer2(a); }
void hbdCoverageDiscard(vec2 worldXZ) {
  float c = hbdCoverage(worldXZ);
  if (c < 1.0 && c < hbdBayer4(gl_FragCoord.xy) + 0.03125) discard;
}
`;

/**
 * How a patched built-in material applies the mask:
 *  - `discard`: opaque — Bayer-dithered discard;
 *  - `alpha`: transparent — multiply the output alpha;
 *  - `labelAlpha`: the same through `hbdCoverageLabel` (labels stay on top
 *    of the satellite cut-out unless it is told to take them too);
 *  - `flatNormal`: the outline pass's normal override — masked fragments
 *    write the ground's up-normal instead of being discarded. The override
 *    also draws the (unmasked) ground plane and underlay, so discarding
 *    would ring the union with a normal edge; a flat normal is exactly what
 *    the ground underneath contributes.
 */
export type CoverageMode = 'discard' | 'alpha' | 'labelAlpha' | 'flatNormal';

/**
 * Patch a three.js BUILT-IN material's shader (inside `onBeforeCompile`) to
 * sample the coverage field by world XZ. Run it AFTER any other patch of the
 * same shader: it only appends to `#include` anchors those patches keep.
 * Instancing-aware (the cars are an InstancedMesh, whose instance transform
 * is not yet in `transformed` at `begin_vertex`).
 *
 * The material must also get a `customProgramCacheKey` that differs from its
 * unmasked twin — three keys programs on `onBeforeCompile.toString()`, which
 * is identical for both.
 */
export function patchCoverage(
  shader: { uniforms: { [name: string]: THREE.IUniform }; vertexShader: string; fragmentShader: string },
  coverage: CoverageUniforms,
  mode: CoverageMode
): void {
  registerCoverageUniforms(shader.uniforms, coverage);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nvarying vec2 vHbdCoverXZ;`)
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
#ifdef USE_INSTANCING
vHbdCoverXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
#else
vHbdCoverXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
#endif`
    );
  const pars = mode === 'discard' ? COVERAGE_DISCARD_GLSL : COVERAGE_GLSL;
  // Declarations go after <common> where there is one (MeshNormalMaterial's
  // fragment shader has none), else right before main().
  const decl = `varying vec2 vHbdCoverXZ;\n${pars}`;
  let frag = shader.fragmentShader.includes('#include <common>')
    ? shader.fragmentShader.replace('#include <common>', `#include <common>\n${decl}`)
    : shader.fragmentShader.replace('void main()', `${decl}\nvoid main()`);
  if (mode === 'flatNormal') {
    frag = frag.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
if (hbdCoverage(vHbdCoverXZ) < 0.5) normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`
    );
  } else {
    const apply =
      mode === 'discard'
        ? 'hbdCoverageDiscard(vHbdCoverXZ);'
        : mode === 'labelAlpha'
          ? 'gl_FragColor.a *= hbdCoverageLabel(vHbdCoverXZ);'
          : 'gl_FragColor.a *= hbdCoverage(vHbdCoverXZ);';
    frag = frag.replace(
      '#include <colorspace_fragment>',
      `${apply}\n#include <colorspace_fragment>`
    );
  }
  shader.fragmentShader = frag;
}
