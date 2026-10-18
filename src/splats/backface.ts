/**
 * Back faces of surfels. SplatMap writes every wall and roof surfel flat (its thinnest axis under
 * {@link BACKFACE_FLAT_RATIO} of the middle one) with that thin axis on the surface's OUTWARD
 * normal, so a surfel whose normal points away from the camera is the far side of a closed
 * building — hidden behind the near walls and the roof. Skipping those (they leave Spark's sort
 * and draw, like a thinned splat) halves the wall overdraw of a block of towers. Blobs — crowns,
 * trunks — have no side to face and are never skipped. Splat sources whose surfels carry no
 * outward orientation should turn this off (`splats.cullBackFaces: false`).
 */

/** A splat is a surfel (has a front and a back) when its thinnest axis is under this x its middle. */
export const BACKFACE_FLAT_RATIO = 0.2;

/** GLSL: `1.0` to keep, `0.0` for a surfel facing away from `cam`. Quaternions are (x, y, z, w). */
export const BACKFACE_GLSL = /* glsl */ `
float hbdFrontFacing(vec3 center, vec3 scales, vec4 q, vec3 cam) {
  float lo = min(scales.x, min(scales.y, scales.z));
  float mid = max(min(scales.x, scales.y), min(max(scales.x, scales.y), scales.z));
  if (lo >= ${BACKFACE_FLAT_RATIO.toFixed(3)} * mid) return 1.0;
  vec3 axis = scales.x == lo ? vec3(1.0, 0.0, 0.0) : (scales.y == lo ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
  vec3 n = axis + 2.0 * cross(q.xyz, cross(q.xyz, axis) + q.w * axis);
  return dot(n, cam - center) < 0.0 ? 0.0 : 1.0;
}
`;

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

/** JS mirror of `hbdFrontFacing` (tests, tools). */
export function frontFacing(center: Vec3, scales: Vec3, q: Quat, cam: Vec3): boolean {
  const [sx, sy, sz] = scales;
  const lo = Math.min(sx, sy, sz);
  const mid = Math.max(Math.min(sx, sy), Math.min(Math.max(sx, sy), sz));
  if (lo >= BACKFACE_FLAT_RATIO * mid) return true;
  const a: Vec3 = sx === lo ? [1, 0, 0] : sy === lo ? [0, 1, 0] : [0, 0, 1];
  const [qx, qy, qz, qw] = q;
  // v + 2 q.xyz x (q.xyz x v + w v)
  const c1: Vec3 = [qy * a[2] - qz * a[1] + qw * a[0], qz * a[0] - qx * a[2] + qw * a[1], qx * a[1] - qy * a[0] + qw * a[2]];
  const n: Vec3 = [
    a[0] + 2 * (qy * c1[2] - qz * c1[1]),
    a[1] + 2 * (qz * c1[0] - qx * c1[2]),
    a[2] + 2 * (qx * c1[1] - qy * c1[0])
  ];
  const v: Vec3 = [cam[0] - center[0], cam[1] - center[1], cam[2] - center[2]];
  return n[0] * v[0] + n[1] * v[1] + n[2] * v[2] >= 0;
}
