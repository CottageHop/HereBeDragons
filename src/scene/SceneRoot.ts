import * as THREE from 'three';
import { createLights } from './Lights.js';
import { createGround } from './Ground.js';
import { StylizedMaterials } from '../materials/StylizedMaterials.js';
import type { TileGroup } from './TileGroup.js';

export class SceneRoot {
  readonly three: THREE.Scene;
  readonly tilesRoot: THREE.Group;
  readonly materials: StylizedMaterials;
  private ground: THREE.Mesh;

  constructor() {
    this.three = new THREE.Scene();
    this.three.background = new THREE.Color('#e6f0fa');
    // Exponential-squared fog: factor = 1 - exp(-density² × dist²). Compared
    // to linear fog, this gives a gentle start near the camera and a sharply
    // ramping density at the far edge — most of the fog accumulates near the
    // horizon, which is what gives the scene "atmospheric weight" without
    // washing out the foreground. Density 2.2e-4 puts the rough alpha curve:
    //   2 km → 18%,  4 km → 54%,  6 km → 82%,  8 km → 95%,  10 km → 99%.
    //
    // Tuned so the fog horizon (~10 km, 99% opacity) sits just past the
    // default tile-window edge (5 z14 tiles ≈ 12 km), which lets the tile
    // dispatcher load FEWER far-away tiles without the edge being visible.
    // The previous 1.2e-4 value pushed 99% out to ~20 km, requiring the
    // tile window to load ~3× the tiles to keep the horizon clean.
    this.three.fog = new THREE.FogExp2('#e6f0fa', 0.00022);

    this.materials = new StylizedMaterials();

    const lights = createLights();
    this.three.add(lights.group);

    this.ground = createGround(this.materials);
    this.three.add(this.ground);

    this.tilesRoot = new THREE.Group();
    this.tilesRoot.name = 'TilesRoot';
    this.three.add(this.tilesRoot);
  }

  addTile(tile: TileGroup): void {
    this.tilesRoot.add(tile);
  }

  removeTile(tile: TileGroup): void {
    this.tilesRoot.remove(tile);
    tile.dispose();
  }

  /** Translate all live tiles after a projection rebase. */
  shiftTiles(dx: number, dz: number): void {
    for (const child of this.tilesRoot.children) {
      child.position.x -= dx;
      child.position.z -= dz;
    }
  }

  dispose(): void {
    this.tilesRoot.children.slice().forEach((child) => {
      this.tilesRoot.remove(child);
      const tile = child as TileGroup;
      tile.dispose?.();
    });
    this.ground.geometry.dispose();
    this.materials.dispose();
  }
}
