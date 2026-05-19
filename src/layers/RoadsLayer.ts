import * as THREE from 'three';
import { Layer, makeSubmeshBufferGeometry } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import { RoadClass } from '../tiles/worker/extractors/roads.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';

/**
 * Live registry of every loaded road group (one per tile) carrying
 * centerline data. CarsLayer iterates this set instead of scene.traverse.
 * Auto-cleaned when any sub-mesh's geometry is disposed, since tile
 * eviction disposes every geometry in the group.
 */
export const ROAD_GROUPS = new Set<THREE.Group>();

export class RoadsLayer extends Layer {
  readonly name: LayerName = 'roads';

  build(geometry: LayerGeometry): THREE.Object3D {
    const group = new THREE.Group();
    const buffers: THREE.BufferGeometry[] = [];
    // Worker pre-splits this layer by class — see decode.worker.ts.
    const submeshes = geometry.submeshes ?? [];
    for (const sub of submeshes) {
      const bg = makeSubmeshBufferGeometry(sub);
      const slot =
        sub.classId === RoadClass.Major ? Palette.road_major :
        sub.classId === RoadClass.Minor ? Palette.road_minor :
        Palette.road_path;
      const mesh = new THREE.Mesh(bg, this.materials.get(slot));
      mesh.renderOrder = -2;
      group.add(mesh);
      buffers.push(bg);
    }
    // Stash centerlines on the group's userData. Bundled here (not per-class
    // mesh) because tile lifetime maps to the group, not to the sub-meshes.
    if (geometry.lines) {
      group.userData.roadLines = geometry.lines;
      ROAD_GROUPS.add(group);
      // Any sub-mesh's geometry dispose is enough — they all dispose
      // together at tile eviction time.
      const cleanup = (): void => {
        ROAD_GROUPS.delete(group);
        for (const b of buffers) b.removeEventListener('dispose', cleanup);
      };
      for (const b of buffers) b.addEventListener('dispose', cleanup);
    }
    return group;
  }
}
