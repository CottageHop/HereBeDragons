import type { LayerGeometry, SubmeshGeometry } from '../decodeProtocol.js';

/**
 * Split a LayerGeometry into per-class submeshes based on a per-vertex
 * `class` attribute. Runs in the worker so the per-vertex remap + buffer
 * packing doesn't burn main-thread time during the apply phase. Returned
 * submeshes are flat typed arrays; the main thread wraps them in
 * THREE.BufferGeometry with zero further copying.
 *
 * Assumes that within each triangle, all three vertices share the same class
 * — true by construction in our extractors.
 */
export function splitByClass(
  geometry: LayerGeometry,
  attrName = 'class'
): SubmeshGeometry[] {
  const classes = geometry.attributes?.[attrName] as Uint8Array | undefined;
  if (!classes) {
    return [
      {
        classId: 0,
        positions: geometry.positions,
        indices: geometry.indices,
        normals: geometry.normals
      }
    ];
  }

  const { positions, indices, normals } = geometry;
  const byClass = new Map<number, number[]>();
  for (let i = 0; i < indices.length; i += 3) {
    const cls = classes[indices[i]];
    let bucket = byClass.get(cls);
    if (!bucket) {
      bucket = [];
      byClass.set(cls, bucket);
    }
    bucket.push(indices[i], indices[i + 1], indices[i + 2]);
  }

  const submeshes: SubmeshGeometry[] = [];
  for (const [classId, tris] of byClass) {
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

    submeshes.push({
      classId,
      positions: new Float32Array(subPositions),
      indices: new Uint32Array(subIndices),
      normals: subNormals ? new Float32Array(subNormals) : undefined
    });
  }
  return submeshes;
}
