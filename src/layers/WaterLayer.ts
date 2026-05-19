import * as THREE from 'three';
import { Layer, makeBufferGeometry } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';

export class WaterLayer extends Layer {
  readonly name: LayerName = 'water';

  build(geometry: LayerGeometry): THREE.Object3D {
    const bg = makeBufferGeometry(geometry);
    const mesh = new THREE.Mesh(bg, this.materials.get(Palette.water));
    mesh.renderOrder = -5;
    return mesh;
  }
}
