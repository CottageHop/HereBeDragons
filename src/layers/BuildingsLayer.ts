import * as THREE from 'three';
import { Layer, makeBufferGeometry } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
import type { BuildingMeta } from '../tiles/worker/extractors/buildings.js';

/**
 * Three.js layer index reserved for building meshes. Composer disables this
 * layer during the normal-pass render when buildings are flattened — that
 * suppresses outline detection so flat buildings don't get a sketch ring
 * around every footprint.
 */
export const BUILDING_THREE_LAYER = 2;

/**
 * Live registry of every loaded building mesh in the scene. Replaces ad-hoc
 * `scene.traverse` calls in BuildingsManager / CarsLayer hot paths — those
 * traversals were O(scene) per click + per per-frame elevation lookup. The
 * set is auto-cleaned when each mesh's geometry is disposed (TileManager
 * disposes geometries on tile eviction), so callers never need to manually
 * unregister.
 */
export const BUILDING_MESHES = new Set<THREE.Mesh>();

/**
 * Cached array projection of `BUILDING_MESHES`. Three.js's
 * `raycaster.intersectObjects` only accepts arrays, and click + elevation
 * raycasts can fire multiple times per second. Rather than `Array.from`
 * the Set on every call, we maintain a parallel array that's rebuilt lazily
 * the first time it's accessed after a tile load/evict. Returns the same
 * reference between mutations, so callers can safely cache it across
 * frames if they want.
 */
let _meshArray: THREE.Mesh[] = [];
let _meshArrayDirty = false;
export function buildingMeshArray(): THREE.Mesh[] {
  if (_meshArrayDirty) {
    _meshArray = Array.from(BUILDING_MESHES);
    _meshArrayDirty = false;
  }
  return _meshArray;
}

export class BuildingsLayer extends Layer {
  readonly name: LayerName = 'buildings';

  build(geometry: LayerGeometry): THREE.Object3D {
    const bg = makeBufferGeometry(geometry);
    // The worker emits buildingIndex as Float32Array already — wrap it in a
    // BufferAttribute with zero further copying.
    const buildingIndexAttr = geometry.attributes?.buildingIndex;
    if (buildingIndexAttr instanceof Float32Array) {
      bg.setAttribute('buildingIndex', new THREE.BufferAttribute(buildingIndexAttr, 1));
    }
    // Per-vertex roof flag (1 = roof face, 0 = wall) so the painterly shader
    // paints pitched roof faces terracotta even though their normals slope.
    const buildingRoofAttr = geometry.attributes?.buildingRoof;
    if (buildingRoofAttr instanceof Float32Array) {
      bg.setAttribute('buildingRoof', new THREE.BufferAttribute(buildingRoofAttr, 1));
    }
    const mesh = new THREE.Mesh(bg, this.materials.get(Palette.building));
    // Tag onto the dedicated buildings layer so Composer can exclude buildings
    // from the normal pass when they're flattened (no outlines on footprints).
    mesh.layers.set(BUILDING_THREE_LAYER);

    // Stash the tile's cumulative building volume so CarsLayer can scale
    // traffic density to local urban load. Read in CarsLayer.rebuildEdgeGraph.
    const meta = geometry.metadata as
      | { totalVolume?: number; buildings?: BuildingMeta[] }
      | undefined;
    if (typeof meta?.totalVolume === 'number') {
      mesh.userData.buildingVolume = meta.totalVolume;
    }
    // The building registry powers picking + highlight. Marked with a stable
    // userData flag so BuildingsManager can find these meshes via traverse.
    if (Array.isArray(meta?.buildings)) {
      mesh.userData.imBuildings = meta.buildings;
      mesh.userData.imBuildingMesh = true;
    }

    // Blueprint mode: each frame, push this mesh's "selected building index"
    // into the shared material's uniform so the per-fragment check can fade
    // the right building. Other meshes (without a selection set) reset to -1
    // before their own draw, so the change is local.
    mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
      const ud = (material as THREE.MeshToonMaterial).userData;
      const sel = ud.uSelectedBuildingIndex as { value: number } | undefined;
      if (sel) {
        const v = mesh.userData.imSelectedBuildingIndex;
        sel.value = typeof v === 'number' ? v : -1;
      }
      // Same pattern for the hover affordance: push this mesh's hovered index
      // (or -1 to clear) before its draw so the shared material's per-fragment
      // check can warm-brighten the right building per-tile.
      const hov = ud.uHoveredBuildingIndex as { value: number } | undefined;
      if (hov) {
        const h = mesh.userData.imHoveredBuildingIndex;
        hov.value = typeof h === 'number' ? h : -1;
      }
    };

    // Register in the live mesh set; auto-cleanup on geometry dispose
    // (TileManager calls geometry.dispose() during tile eviction). Bump the
    // dirty flag so `buildingMeshArray()` rebuilds its cached copy on next
    // access — keeps the per-click raycast off the `Array.from` path.
    BUILDING_MESHES.add(mesh);
    _meshArrayDirty = true;
    bg.addEventListener('dispose', () => {
      BUILDING_MESHES.delete(mesh);
      _meshArrayDirty = true;
    });
    return mesh;
  }
}
