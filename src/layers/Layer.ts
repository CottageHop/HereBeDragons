import * as THREE from 'three';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
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
 * Split a LayerGeometry into per-class submeshes based on a per-vertex class
 * attribute. Assumes that within each triangle, all three vertices share the
 * same class — true by construction in our extractors.
 *
 * Returns: array of [classId, BufferGeometry].
 */
export function splitByClass(geometry: LayerGeometry, attrName = 'class'): Array<[number, THREE.BufferGeometry]> {
  const classes = geometry.attributes?.[attrName];
  if (!classes) {
    return [[0, makeBufferGeometry(geometry)]];
  }
  const { positions, indices, normals } = geometry;
  const byClass = new Map<number, number[]>();
  for (let i = 0; i < indices.length; i += 3) {
    const cls = (classes as Uint8Array)[indices[i]];
    let bucket = byClass.get(cls);
    if (!bucket) {
      bucket = [];
      byClass.set(cls, bucket);
    }
    bucket.push(indices[i], indices[i + 1], indices[i + 2]);
  }

  const submeshes: Array<[number, THREE.BufferGeometry]> = [];
  for (const [cls, tris] of byClass) {
    // Compact vertex buffer for this submesh.
    const remap = new Map<number, number>();
    const subPositions: number[] = [];
    const subNormals: number[] | null = normals ? [] : null;
    const subIndices: number[] = [];

    for (const idx of tris) {
      let nidx = remap.get(idx);
      if (nidx === undefined) {
        nidx = subPositions.length / 3;
        remap.set(idx, nidx);
        subPositions.push(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
        if (subNormals && normals) {
          subNormals.push(normals[idx * 3], normals[idx * 3 + 1], normals[idx * 3 + 2]);
        }
      }
      subIndices.push(nidx);
    }

    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(subPositions), 3));
    if (subNormals) {
      bg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(subNormals), 3));
    } else {
      bg.computeVertexNormals();
    }
    bg.setIndex(new THREE.BufferAttribute(new Uint32Array(subIndices), 1));
    submeshes.push([cls, bg]);
  }
  return submeshes;
}
