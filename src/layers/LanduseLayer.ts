import * as THREE from 'three';
import { Layer, makeSubmeshBufferGeometry } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import { LanduseClass } from '../tiles/worker/extractors/landuse.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';

export class LanduseLayer extends Layer {
  readonly name: LayerName = 'landuse';

  build(geometry: LayerGeometry): THREE.Object3D {
    const group = new THREE.Group();
    // The worker pre-splits landuse by class so the main thread doesn't have
    // to walk the index buffer per tile. `submeshes` is always populated for
    // this layer; the fallback is defensive only.
    const submeshes = geometry.submeshes ?? [];
    for (const sub of submeshes) {
      const bg = makeSubmeshBufferGeometry(sub);
      const slot = paletteForClass(sub.classId);
      const mesh = new THREE.Mesh(bg, this.materials.get(slot));
      mesh.renderOrder = -6;
      group.add(mesh);
    }
    return group;
  }
}

function paletteForClass(cls: number): typeof Palette[keyof typeof Palette] {
  switch (cls) {
    case LanduseClass.Park:  return Palette.landuse_park;
    case LanduseClass.Wood:  return Palette.landuse_wood;
    case LanduseClass.Grass: return Palette.landuse_grass;
    case LanduseClass.Sand:  return Palette.landuse_sand;
    case LanduseClass.Urban: return Palette.landuse_urban;
    default:                 return Palette.landuse_grass;
  }
}
