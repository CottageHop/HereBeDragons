import * as THREE from 'three';
import { Layer, splitByClass } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import { RailPart } from '../tiles/worker/extractors/rails.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';

/**
 * Renders rail track geometry produced by `extractRails` — a separate material
 * for the rail strips (dark steel) vs. the crossties (creosoted wood brown).
 * Both share the same Y plane and rely on Palette polygonOffsets to stack
 * correctly above the road layer.
 */
export class RailsLayer extends Layer {
  readonly name: LayerName = 'rails';

  build(geometry: LayerGeometry): THREE.Object3D {
    const group = new THREE.Group();
    for (const [cls, bg] of splitByClass(geometry)) {
      const slot = cls === RailPart.Tie ? Palette.rail_tie : Palette.rail_strip;
      const mesh = new THREE.Mesh(bg, this.materials.get(slot));
      // Same renderOrder as roads so the order between scene meshes is
      // determined by polygon offset rather than draw order.
      mesh.renderOrder = -2;
      group.add(mesh);
    }
    return group;
  }
}
