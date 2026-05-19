import * as THREE from 'three';
import { StylizedMaterials } from '../materials/StylizedMaterials.js';
import { Palette } from '../materials/Palette.js';

export function createGround(materials: StylizedMaterials): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(50_000, 50_000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = materials.get(Palette.ground);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Ground';
  mesh.position.y = -3.0;
  mesh.renderOrder = -10;
  return mesh;
}
