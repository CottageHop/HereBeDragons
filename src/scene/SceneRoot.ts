import * as THREE from 'three';
import { createLights, type LightPreset } from './Lights.js';
import { createGround } from './Ground.js';
import { StylizedMaterials } from '../materials/StylizedMaterials.js';
import type { TileGroup } from './TileGroup.js';

export class SceneRoot {
  readonly three: THREE.Scene;
  readonly tilesRoot: THREE.Group;
  readonly materials: StylizedMaterials;
  private ground: THREE.Mesh;
  private readonly lights: ReturnType<typeof createLights>;
  /** Authored light defaults, captured at construction so `applyLightPreset`
   *  can reset before layering a theme's overrides. */
  private readonly lightDefaults: {
    sun: number; sunColor: number;
    fill: number;
    ambient: number;
    hemi: number; hemiSky: number; hemiGround: number;
  };

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

    this.lights = createLights();
    this.three.add(this.lights.group);
    // Snapshot the authored defaults so applyLightPreset can reset cleanly
    // before layering a theme's overrides.
    const { sun, fill, ambient, hemi } = this.lights;
    this.lightDefaults = {
      sun: sun.intensity,
      sunColor: sun.color.getHex(),
      fill: fill.intensity,
      ambient: ambient.intensity,
      hemi: hemi.intensity,
      hemiSky: hemi.color.getHex(),
      hemiGround: hemi.groundColor.getHex()
    };

    this.ground = createGround(this.materials);
    this.three.add(this.ground);

    this.tilesRoot = new THREE.Group();
    this.tilesRoot.name = 'TilesRoot';
    this.three.add(this.tilesRoot);
  }

  /**
   * Apply a theme's lighting look. Resets to the authored defaults first, then
   * layers the preset's defined fields on top. Pass `null` to restore the
   * neutral defaults (used when a theme declares no light preset).
   */
  applyLightPreset(preset: LightPreset | null): void {
    const { sun, fill, ambient, hemi } = this.lights;
    const d = this.lightDefaults;
    sun.color.set(preset?.sun ?? d.sunColor);
    sun.intensity = preset?.sunIntensity ?? d.sun;
    fill.intensity = preset?.fillIntensity ?? d.fill;
    ambient.intensity = preset?.ambientIntensity ?? d.ambient;
    hemi.color.set(preset?.hemiSky ?? d.hemiSky);
    hemi.groundColor.set(preset?.hemiGround ?? d.hemiGround);
    hemi.intensity = preset?.hemiIntensity ?? d.hemi;
  }

  /** Read the current lighting as a fully-populated preset (colors as sRGB
   *  hex). Source of truth for the public getter + studio resync. */
  getLightPreset(): Required<LightPreset> {
    const { sun, fill, ambient, hemi } = this.lights;
    return {
      sun: '#' + sun.color.getHexString(),
      sunIntensity: sun.intensity,
      fillIntensity: fill.intensity,
      ambientIntensity: ambient.intensity,
      hemiSky: '#' + hemi.color.getHexString(),
      hemiGround: '#' + hemi.groundColor.getHexString(),
      hemiIntensity: hemi.intensity
    };
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
