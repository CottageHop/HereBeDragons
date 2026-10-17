import * as THREE from 'three';
import { StylizedMaterials } from '../materials/StylizedMaterials.js';
import { Palette } from '../materials/Palette.js';

export function createGround(materials: StylizedMaterials): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(50_000, 50_000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  // The UNMASKED twin: the 50 km ground plane is what shows outside the
  // tile reveal's rounded union — masking it would dissolve the map to the
  // clear colour there. (Tile meshes in the same slot use the masked one.)
  const mat = materials.getUnmasked(Palette.ground);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Ground';
  mesh.position.y = -3.0;
  mesh.renderOrder = -10;
  return mesh;
}
