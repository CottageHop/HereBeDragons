import * as THREE from 'three';

/**
 * Frustum culling for splat tiles.
 *
 * Spark draws every splat of every `SplatMesh` in the scene: it has no per-mesh frustum test, and
 * a `SplatMesh` carries no bounding volume three.js could cull on. With a radius-2 window at high
 * tilt a real measurement had 3 of 17 resident tiles entirely behind or beside the camera —
 * 755k of 3.93M splats (19 %) — and hiding them took the 95th-percentile frame from 58 ms to
 * 46 ms. Cost being linear in drawn splats, this is close to free money.
 *
 * A tile is a square column: `size` scene units on each side from its origin, rising from the
 * ground to whatever its tallest splat reaches. `TILE_HEIGHT_SCENE` is deliberately generous —
 * missing a tile that should be drawn would pop a hole in the map, while keeping one extra costs
 * only what it would have cost anyway.
 */

/** Height of a tile's bounding column, scene units. Tall enough for any building + canopy. */
export const TILE_HEIGHT_SCENE = 150;
/** Dropped below the ground plane, so a camera under the terrain still sees its tile. */
export const TILE_DEPTH_SCENE = 30;

/**
 * World-space bounds of a tile whose south-west corner sits at `position` (the scene-space
 * placement from `splatTileTransform`) and which spans `size` scene units.
 *
 * The tile group is rotated so its local +y (north) maps to scene −z, i.e. the square runs from
 * the placement point in +x and −z.
 */
export function tileWorldBox(
  position: { x: number; y: number; z: number },
  size: number,
  target = new THREE.Box3()
): THREE.Box3 {
  const s = Math.max(size, 0);
  target.min.set(position.x, position.y - TILE_DEPTH_SCENE, position.z - s);
  target.max.set(position.x + s, position.y + TILE_HEIGHT_SCENE, position.z);
  return target;
}

/** Reusable scratch so the per-frame test allocates nothing. */
const scratchMatrix = new THREE.Matrix4();

/** Frustum for a camera, reusing `target`. Call after the camera's matrices are up to date. */
export function cameraFrustum(camera: THREE.Camera, target = new THREE.Frustum()): THREE.Frustum {
  scratchMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return target.setFromProjectionMatrix(scratchMatrix);
}

/** Whether a tile's column intersects the view. */
export function tileVisible(frustum: THREE.Frustum, box: THREE.Box3): boolean {
  return frustum.intersectsBox(box);
}
