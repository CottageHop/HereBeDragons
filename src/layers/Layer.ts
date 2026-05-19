import * as THREE from 'three';
import type { LayerGeometry, SubmeshGeometry } from '../tiles/worker/decodeProtocol.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';
import type { LayerName } from '../types.js';

export abstract class Layer {
  abstract readonly name: LayerName;

  constructor(protected materials: StylizedMaterials) {}

  /** Build a THREE.Object3D from one tile's geometry payload. */
  abstract build(geometry: LayerGeometry): THREE.Object3D;

  /**
   * Optional per-frame tick. Return `true` if the layer changed anything
   * the renderer needs to redraw (e.g. moved geometry) so the RAF loop's
   * render-on-demand check knows the frame is dirty. Returning `void` /
   * `false` means "nothing visible changed."
   */
  update?(dt: number): void | boolean;
  dispose?(): void;
}

/**
 * Build a Three BufferGeometry from a LayerGeometry payload. Caller owns the
 * geometry and is responsible for disposing it at tile unload.
 */
export function makeBufferGeometry(geometry: LayerGeometry): THREE.BufferGeometry {
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3));
  if (geometry.normals) {
    bg.setAttribute('normal', new THREE.BufferAttribute(geometry.normals, 3));
  } else {
    bg.computeVertexNormals();
  }
  bg.setIndex(new THREE.BufferAttribute(geometry.indices, 1));
  return bg;
}

/**
 * Build a Three BufferGeometry from a worker-emitted SubmeshGeometry — the
 * pre-split per-class chunks for landuse/roads/rails. Zero-copy on the
 * underlying typed arrays.
 */
export function makeSubmeshBufferGeometry(sub: SubmeshGeometry): THREE.BufferGeometry {
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(sub.positions, 3));
  if (sub.normals) {
    bg.setAttribute('normal', new THREE.BufferAttribute(sub.normals, 3));
  } else {
    bg.computeVertexNormals();
  }
  bg.setIndex(new THREE.BufferAttribute(sub.indices, 1));
  return bg;
}
