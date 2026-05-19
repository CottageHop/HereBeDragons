import * as THREE from 'three';
import type { LayerName } from '../types.js';

/**
 * A per-tile THREE.Group that holds one Object3D per layer. Created by the
 * TileManager when a tile's worker decode resolves, and disposed when the tile
 * is evicted from the visible set.
 */
export class TileGroup extends THREE.Group {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  private layerObjects = new Map<LayerName, THREE.Object3D>();

  constructor(z: number, x: number, y: number) {
    super();
    this.z = z;
    this.x = x;
    this.y = y;
    this.name = `Tile ${z}/${x}/${y}`;
  }

  setLayer(name: LayerName, obj: THREE.Object3D | null): void {
    const existing = this.layerObjects.get(name);
    if (existing) {
      this.remove(existing);
      disposeObject(existing);
      this.layerObjects.delete(name);
    }
    if (obj) {
      obj.name = `${this.name}:${name}`;
      this.add(obj);
      this.layerObjects.set(name, obj);
    }
  }

  getLayer(name: LayerName): THREE.Object3D | undefined {
    return this.layerObjects.get(name);
  }

  setLayerVisible(name: LayerName, visible: boolean): void {
    const obj = this.layerObjects.get(name);
    if (obj) obj.visible = visible;
  }

  dispose(): void {
    for (const obj of this.layerObjects.values()) {
      this.remove(obj);
      disposeObject(obj);
    }
    this.layerObjects.clear();
  }
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    // Materials are shared via StylizedMaterials cache — do NOT dispose here.
  });
}
