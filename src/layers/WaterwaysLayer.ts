import * as THREE from 'three';
import { Layer, makeBufferGeometry } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';

/**
 * River / canal / stream lines as thin water-colored ribbons. Shares the
 * theme.water color with the polygon water layer so a river entering a lake
 * reads as a single continuous blue surface (the waterway sits at Y = -0.95,
 * just above the water polygon at Y = -1.0).
 */
export class WaterwaysLayer extends Layer {
  readonly name: LayerName = 'waterways';

  build(geometry: LayerGeometry): THREE.Object3D {
    const bg = makeBufferGeometry(geometry);
    const mesh = new THREE.Mesh(bg, this.materials.get(Palette.waterway));
    mesh.renderOrder = -4;
    return mesh;
  }
}
