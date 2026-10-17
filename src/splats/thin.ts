/**
 * Motion thinning: while the camera moves, keep a fixed hashed fraction `keep` of every tile's
 * splats and grow the survivors by 1/sqrt(keep), so the surface stays covered (a surfel's
 * footprint goes with scale squared) with fewer splats. Splat cost here is per splat, not per
 * pixel, so this is the knob that buys frame time without dropping tiles of coverage.
 *
 * A dropped splat gets Spark's inactive flag, which the accumulator packs as zeros: it is left
 * out of the depth sort and the instanced draw, i.e. it costs nothing. Opacity 0 alone would
 * still be sorted and drawn.
 *
 * The hash is PCG (O'Neill) on the splat index, so the kept subset is stable from frame to
 * frame and nested: everything kept at 0.3 is also kept at 0.5. `thinGrow` mirrors the GLSL
 * for tests.
 */

/** Keep fractions the governor steps through while moving (`splats.motionThin`). */
export const MOTION_THIN_LADDER: readonly number[] = Object.freeze([0.7, 0.5, 0.35]);

/**
 * Largest growth of a kept splat. The offline lite builder caps tree thinning at 2.6 (bigger
 * crowns read as blobs at street level); here the far field thinned by `hbdDensityKeep` is
 * sub-pixel, where a 4× splat is still about one pixel, and the motion ladder (keep ≥ 0.35,
 * growth ≤ 1.7) never reaches the cap.
 */
export const THIN_MAX_GROW = 4;
/** Smallest useful keep fraction: below 1/THIN_MAX_GROW^2 the growth cap leaves holes. */
export const THIN_MIN_KEEP = 1 / (THIN_MAX_GROW * THIN_MAX_GROW);

export const THIN_GLSL = /* glsl */ `
uint hbdPcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// Motion thinning for one splat: (scale factor, alpha factor). Scale 0 = dropped (inactive);
// kept splats grow by 1/sqrt(keep). Splats in the soft band just above \`keep\` stay in the sort
// with alpha fading out across it, so a RISING keep fades them in every frame instead of adding
// them in a batch at the next depth sort.
vec2 hbdThin(int index, float keep, float band) {
  if (keep >= 1.0) return vec2(1.0);
  float r = float(hbdPcg(uint(index)) >> 8u) * (1.0 / 16777216.0);
  float g = min(inversesqrt(max(keep, 1e-4)), ${THIN_MAX_GROW.toFixed(2)});
  if (r < keep) return vec2(g, 1.0);
  if (band > 0.0 && r < keep + band) return vec2(g, 1.0 - (r - keep) / band);
  return vec2(0.0);
}
// Screen-space density: the fraction of splats to keep around \`center\` so that their sampling
// spacing (≈ 2 × the largest scale, for surfels authored with σ = ½ spacing) projects to about one
// target pixel. \`density\` = (focal length in device px / target spacing in device px)²; 0 = off.
// Several splats per pixel cost full price and add nothing — the far field of a tilted view is
// mostly that — so this is the per-splat lever applied where it is invisible.
float hbdDensityKeep(vec3 center, vec3 cam, vec3 scales, float density) {
  if (density <= 0.0) return 1.0;
  vec3 dv = center - cam;
  float d2 = max(dot(dv, dv), 1.0);
  float s = 2.0 * max(scales.x, max(scales.y, scales.z));
  return clamp(s * s * density / d2, 0.0, 1.0);
}
`;

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** JS mirror of `hbdThin` (scale part, no band): 0 when the splat is dropped, else its growth. */
export function thinGrow(index: number, keep: number): number {
  return thinWeights(index, keep, 0)[0];
}

/** JS mirror of `hbdThin`: [scale factor, alpha factor]. */
export function thinWeights(index: number, keep: number, band: number): [number, number] {
  if (keep >= 1) return [1, 1];
  const r = (pcg(index) >>> 8) / 16777216;
  const g = Math.min(1 / Math.sqrt(Math.max(keep, 1e-4)), THIN_MAX_GROW);
  if (r < keep) return [g, 1];
  if (band > 0 && r < keep + band) return [g, 1 - (r - keep) / band];
  return [0, 0];
}

/** Width of the soft band while detail is ramping up (see `hbdThin`). */
export const THIN_RAMP_BAND = 0.25;

/** JS mirror of `hbdDensityKeep`. `center`, `cam`, `scales` in the splat's object space. */
export function densityKeep(
  center: readonly [number, number, number],
  cam: readonly [number, number, number],
  scales: readonly [number, number, number],
  density: number
): number {
  if (!(density > 0)) return 1;
  const dx = center[0] - cam[0];
  const dy = center[1] - cam[1];
  const dz = center[2] - cam[2];
  const d2 = Math.max(dx * dx + dy * dy + dz * dz, 1);
  const s = 2 * Math.max(scales[0], scales[1], scales[2]);
  return Math.min(1, Math.max(0, (s * s * density) / d2));
}

/** `density` for `hbdDensityKeep`: (focal length / target spacing)², both in device pixels. */
export function densityFor(focalPx: number, targetPx: number): number {
  return targetPx > 0 && focalPx > 0 ? (focalPx / targetPx) ** 2 : 0;
}

/** Clamp a requested keep fraction to the usable range (1 = thinning off). */
export function clampThinKeep(keep: number): number {
  if (!Number.isFinite(keep) || keep >= 1) return 1;
  return Math.max(THIN_MIN_KEEP, keep);
}
