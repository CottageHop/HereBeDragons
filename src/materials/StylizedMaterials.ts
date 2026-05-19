import * as THREE from 'three';
import { build3BandGradient } from './GradientMaps.js';
import { Palette, type PaletteSlot, type PaletteKey } from './Palette.js';

/**
 * Caches the stylized-shading materials (three.js's MeshToonMaterial under
 * the hood, parameterized with a stepped-gradient lookup) keyed by
 * (color, doubleSided). All layers share materials so a single tile unload
 * doesn't ripple to GPU resource churn.
 */
export class StylizedMaterials {
  private cache = new Map<string, THREE.MeshToonMaterial>();
  private gradient: THREE.DataTexture;

  constructor() {
    this.gradient = build3BandGradient();
  }

  get(slot: PaletteSlot): THREE.MeshToonMaterial {
    const offset = slot.polygonOffsetUnits ?? 0;
    const key = `${slot.color}|${slot.doubleSided ? 'ds' : 'ss'}|${offset}`;
    let mat = this.cache.get(key);
    if (!mat) {
      mat = new THREE.MeshToonMaterial({
        color: new THREE.Color(slot.color),
        gradientMap: this.gradient,
        side: slot.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        // Stable layer ordering for coplanar ground-plane geometry. Without
        // this, distant tiles z-fight as the depth buffer's precision drops
        // below the layers' physical Y separation.
        polygonOffset: offset !== 0,
        polygonOffsetFactor: offset !== 0 ? -1 : 0,
        polygonOffsetUnits: offset
      });
      if (slot === Palette.building || slot === Palette.building_top) {
        attachBlueprintShader(mat);
      }
      this.cache.set(key, mat);
    }
    return mat;
  }

  /**
   * Replace the color on each cached material identified by palette key.
   * Materials that haven't been created yet are created so the override takes
   * effect immediately. Used by theme application.
   */
  setColors(byKey: Partial<Record<PaletteKey, string>>): void {
    for (const k of Object.keys(byKey) as PaletteKey[]) {
      const hex = byKey[k];
      if (!hex) continue;
      const slot = Palette[k];
      if (!slot) continue;
      const offset = slot.polygonOffsetUnits ?? 0;
      const cacheKey = `${slot.color}|${slot.doubleSided ? 'ds' : 'ss'}|${offset}`;
      let mat = this.cache.get(cacheKey);
      if (!mat) {
        mat = new THREE.MeshToonMaterial({
          color: new THREE.Color(hex),
          gradientMap: this.gradient,
          side: slot.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
          polygonOffset: offset !== 0,
          polygonOffsetFactor: offset !== 0 ? -1 : 0,
          polygonOffsetUnits: offset
        });
        // Mirror the shader attachment that `get()` performs, so building
        // materials get their per-building palette / blueprint hooks even
        // when first instantiated here (applyTheme runs before any tile
        // load, so this is the common path).
        if (slot === Palette.building || slot === Palette.building_top) {
          attachBlueprintShader(mat);
        }
        this.cache.set(cacheKey, mat);
      } else {
        mat.color.set(hex);
        mat.needsUpdate = true;
      }
    }
  }

  /**
   * Flatten the building geometry to the ground plane (or restore). Drives a
   * shader uniform shared by the building / building_top materials so the
   * change is instant — no geometry rebuild.
   */
  setBuildingsFlat(flat: boolean): void {
    const v = flat ? 1 : 0;
    for (const slot of [Palette.building, Palette.building_top]) {
      const mat = this.get(slot);
      const u = mat.userData.uFlattenBuildings as
        | { value: number }
        | undefined;
      if (u) u.value = v;
    }
  }

  dispose(): void {
    for (const mat of this.cache.values()) mat.dispose();
    this.cache.clear();
    this.gradient.dispose();
  }
}

/**
 * Patch a building material so the building whose index matches
 * `uSelectedBuildingIndex` renders as a flat pale "blueprint" tone instead
 * of the normal stylized shading. The uniform is stored on `mat.userData` so
 * each building mesh can flip it per-draw via `onBeforeRender` — meshes
 * share the cached material but can have different selected buildings.
 */
function attachBlueprintShader(mat: THREE.MeshToonMaterial): void {
  const selectedUniform = { value: -1 };
  const flattenUniform = { value: 0 };
  mat.userData.uSelectedBuildingIndex = selectedUniform;
  mat.userData.uFlattenBuildings = flattenUniform;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSelectedBuildingIndex = selectedUniform;
    shader.uniforms.uFlattenBuildings = flattenUniform;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float buildingIndex;
varying float vBuildingIndex;
uniform float uFlattenBuildings;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vBuildingIndex = buildingIndex;
// Collapse buildings to the ground plane. With uFlattenBuildings = 1 every
// vertex's Y goes to zero — wall quads degenerate to zero-area lines, only
// the roof footprint remains visible on the map.
transformed.y *= (1.0 - uFlattenBuildings);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vBuildingIndex;
uniform float uSelectedBuildingIndex;`
      )
      .replace(
        '#include <colorspace_fragment>',
        `
        // ---- Blueprint mode for the selected building -------------------
        // Use a saturated cyan rather than near-white so the OutlinePass's
        // luma-based shine doesn't push the surface to pure white.
        if (uSelectedBuildingIndex >= 0.0 &&
            abs(vBuildingIndex - uSelectedBuildingIndex) < 0.5) {
          gl_FragColor.rgb = vec3(0.42, 0.72, 0.92);
        }
        #include <colorspace_fragment>
        `
      );
  };
  mat.needsUpdate = true;
}
