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

/**
 * Live registry of every loaded road group carrying bridge centerlines (in
 * `userData.bridgeLines`). The BridgesManager iterates this to stitch and arch
 * bridge decks. Auto-cleaned on tile eviction via a sentinel geometry.
 */
export const BRIDGE_GROUPS = new Set<THREE.Group>();

/**
 * Bumped whenever a bridge group is added or removed. The BridgesManager
 * watches this counter so it only rebuilds the (potentially expensive) stitched
 * decks when the set of loaded bridge tiles actually changed.
 */
export let bridgeVersion = 0;

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
    // Tunnels: a flat ribbon drawn with the shared dashed + faded material so
    // an underground roadway reads as below the surface. Geometry carries a
    // `dashU` attribute (distance along the centerline) for the dash pattern.
    if (geometry.tunnels) {
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(geometry.tunnels.positions, 3));
      tg.setAttribute('dashU', new THREE.BufferAttribute(geometry.tunnels.dashU, 1));
      tg.setAttribute('dashV', new THREE.BufferAttribute(geometry.tunnels.dashV, 1));
      tg.setIndex(new THREE.BufferAttribute(geometry.tunnels.indices, 1));
      const mesh = new THREE.Mesh(tg, this.materials.getTunnelMaterial());
      mesh.renderOrder = -3;
      group.add(mesh);
    }

    // Bridge centerlines for the BridgesManager. Registered with a dedicated
    // sentinel geometry rather than the ribbon buffers above: a mid-span tile
    // (a bridge over open water) can have bridges but no ribbon submeshes, so
    // there'd be no buffer whose dispose marks tile eviction.
    if (geometry.bridges) {
      group.userData.bridgeLines = geometry.bridges;
      BRIDGE_GROUPS.add(group);
      bridgeVersion++;
      const sentinel = new THREE.BufferGeometry();
      sentinel.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
      const sentinelMesh = new THREE.Mesh(sentinel, this.materials.get(Palette.road_major));
      sentinelMesh.visible = false;
      sentinelMesh.frustumCulled = false;
      group.add(sentinelMesh);
      const cleanup = (): void => {
        BRIDGE_GROUPS.delete(group);
        bridgeVersion++;
        sentinel.removeEventListener('dispose', cleanup);
      };
      sentinel.addEventListener('dispose', cleanup);
    }
    return group;
  }
}
