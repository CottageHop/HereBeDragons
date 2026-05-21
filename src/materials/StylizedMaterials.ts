import * as THREE from 'three';
import { build3BandGradient } from './GradientMaps.js';
import { Palette, type PaletteSlot, type PaletteKey } from './Palette.js';

/**
 * World-space width (metres) of each thin "line" slot, used to drive the
 * sub-pixel fade. As the camera pulls back these ribbons shrink below a pixel
 * and, single-sampled (we ship without MSAA — it's too expensive per frame),
 * rasterization flickers them on/off as the camera pans — the "lines crawling"
 * shimmer. Fading them into the ground colour before they get that small makes
 * them dissolve smoothly instead. Rail strips (0.4 m) are sub-pixel even at
 * city zoom, so they're the first to go.
 */
const FADE_WIDTHS_M: ReadonlyArray<readonly [PaletteSlot, number]> = [
  [Palette.road_major, 12],
  [Palette.road_minor, 7],
  [Palette.road_path, 3],
  [Palette.rail_strip, 0.4],
  [Palette.rail_tie, 3.2]
];

/**
 * On-screen ribbon width (CSS px) over which the fade runs. At/above HI the
 * ribbon is its full colour; at/below LO it's pure ground (gone). Pegged to
 * CSS pixels — not device pixels — so dynamic-resolution flips (which change
 * the device pixel ratio mid-pan) don't make roads fade in and out. Tune HI up
 * to keep thin roads visible longer at the cost of more shimmer.
 */
const FADE_LO_PX = 0.25;
const FADE_HI_PX = 1.0;

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Caches the stylized-shading materials (three.js's MeshToonMaterial under
 * the hood, parameterized with a stepped-gradient lookup) keyed by
 * (color, doubleSided). All layers share materials so a single tile unload
 * doesn't ripple to GPU resource churn.
 */
export class StylizedMaterials {
  private cache = new Map<string, THREE.MeshToonMaterial>();
  private gradient: THREE.DataTexture;
  /**
   * Current ground colour (linear), the fade target for thin ribbons. Tracked
   * here so road/rail materials created before/after a theme change all blend
   * toward the right colour. THREE.Color holds linear components when colour
   * management is on (the default), matching our linear render targets.
   */
  private groundColor = new THREE.Color(Palette.ground.color);
  /**
   * Current major-road colour (linear). The tunnel outline is drawn in this so
   * it reads as a (faint, dashed) road in every theme — including dark ones
   * where a ground-derived tint would vanish. Updated on theme change.
   */
  private roadColor = new THREE.Color(Palette.road_major.color);
  /**
   * Road/rail materials that participate in the sub-pixel fade, paired with
   * their world-space width. Iterated per frame by `setSubpixelFade`.
   */
  private fadeMaterials: Array<{ mat: THREE.MeshToonMaterial; widthM: number }> = [];
  /**
   * Shared dashed-outline material for tunnel ribbons. Lazily created (most
   * tiles have no tunnels) and recoloured to the current road colour on theme
   * change, so an underground roadway reads as a faint dashed road outline.
   */
  private tunnelMaterial: THREE.ShaderMaterial | null = null;

  constructor() {
    this.gradient = build3BandGradient();
  }

  get(slot: PaletteSlot): THREE.MeshToonMaterial {
    const key = this.cacheKey(slot);
    let mat = this.cache.get(key);
    if (!mat) {
      mat = this.createMaterial(slot, slot.color);
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
    // Apply the ground colour first so any road/rail materials created below
    // (or already created) fade toward the new ground, not the old one.
    if (byKey.ground) this.setGroundColor(byKey.ground);

    for (const k of Object.keys(byKey) as PaletteKey[]) {
      const hex = byKey[k];
      if (!hex) continue;
      const slot = Palette[k];
      if (!slot) continue;
      const cacheKey = this.cacheKey(slot);
      let mat = this.cache.get(cacheKey);
      if (!mat) {
        mat = this.createMaterial(slot, hex);
        this.cache.set(cacheKey, mat);
      } else {
        mat.color.set(hex);
        mat.needsUpdate = true;
      }
    }

    // Keep the tunnel outline tinted to the road colour.
    if (byKey.road_major) {
      this.roadColor.set(byKey.road_major);
      if (this.tunnelMaterial) {
        (this.tunnelMaterial.uniforms.uColor.value as THREE.Color).copy(this.roadColor);
      }
    }
  }

  /**
   * Update the sub-pixel fade for the current view. `metersPerPixel` is the
   * ground-plane metres covered by one CSS pixel at the camera target —
   * `(2 * distance * tan(fov/2)) / cssViewportHeight`. Cheap: a smoothstep +
   * one uniform write per fadeable material (≤ 5). Call once per rendered
   * frame; HereBeDragons does this from the RAF loop.
   */
  setSubpixelFade(metersPerPixel: number): void {
    if (!(metersPerPixel > 0)) return;
    for (const { mat, widthM } of this.fadeMaterials) {
      const screenPx = widthM / metersPerPixel;
      const fade = smoothstep(FADE_LO_PX, FADE_HI_PX, screenPx);
      const u = mat.userData.uRoadFade as { value: number } | undefined;
      if (u) u.value = fade;
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
    this.fadeMaterials.length = 0;
    this.tunnelMaterial?.dispose();
    this.tunnelMaterial = null;
    this.gradient.dispose();
  }

  private cacheKey(slot: PaletteSlot): string {
    const offset = slot.polygonOffsetUnits ?? 0;
    return `${slot.color}|${slot.doubleSided ? 'ds' : 'ss'}|${offset}`;
  }

  /**
   * Build a stylized material for a slot and wire up whichever per-slot shader
   * hooks it needs: the blueprint/flatten patch for buildings, the sub-pixel
   * fade for thin road/rail ribbons. Single creation path so `get()` and
   * `setColors()` can't drift.
   */
  private createMaterial(slot: PaletteSlot, hex: string): THREE.MeshToonMaterial {
    const offset = slot.polygonOffsetUnits ?? 0;
    const mat = new THREE.MeshToonMaterial({
      color: new THREE.Color(hex),
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

    const fadeWidth = FADE_WIDTHS_M.find(([s]) => s === slot)?.[1];
    if (fadeWidth !== undefined) {
      attachRoadFadeShader(mat, this.groundColor);
      this.fadeMaterials.push({ mat, widthM: fadeWidth });
    }

    return mat;
  }

  private setGroundColor(hex: string): void {
    this.groundColor.set(hex);
    // Repoint every road/rail fade uniform at the new ground colour.
    for (const { mat } of this.fadeMaterials) {
      const u = mat.userData.uRoadFadeGround as { value: THREE.Color } | undefined;
      if (u) u.value.copy(this.groundColor);
    }
  }

  /**
   * Shared material for tunnel ribbons. Draws only the road's outline (its two
   * long edges, via the `dashV` across-width coord), dashed along its length
   * (`dashU`), at low opacity — so an underground roadway reads as a faint
   * dashed outline below the surface. Tinted from the current ground colour.
   */
  getTunnelMaterial(): THREE.ShaderMaterial {
    if (this.tunnelMaterial) return this.tunnelMaterial;
    this.tunnelMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: this.roadColor.clone() },
        uDashPeriod: { value: 16 },
        uDashFill: { value: 0.5 },
        uEdge: { value: 0.16 },
        uOpacity: { value: 0.25 }
      },
      vertexShader: TUNNEL_VERT,
      fragmentShader: TUNNEL_FRAG,
      transparent: true,
      depthWrite: false,
      // Pull toward the camera so the outline sits above the ground/landuse fill
      // (less than roads at −28+, so a surface road still wins at a crossing).
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -26,
      side: THREE.DoubleSide
    });
    return this.tunnelMaterial;
  }
}

const TUNNEL_VERT = /* glsl */ `
attribute float dashU;
attribute float dashV;
varying float vDashU;
varying float vDashV;
void main() {
  vDashU = dashU;
  vDashV = dashV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TUNNEL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uDashPeriod;
uniform float uDashFill;
uniform float uEdge;
uniform float uOpacity;
varying float vDashU;
varying float vDashV;
void main() {
  // Outline only: keep fragments near either long edge (vDashV ~ 0 or ~ 1),
  // drop the filled interior.
  bool onEdge = vDashV < uEdge || vDashV > 1.0 - uEdge;
  // Dash along the centerline: keep the first fraction of each period.
  bool onDash = fract(vDashU / uDashPeriod) < uDashFill;
  if (!(onEdge && onDash)) discard;
  // Faint road-coloured dashed outline at low opacity reads as below-surface.
  // Targets are linear and uColor is a linear THREE.Color, so output linear.
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

/**
 * Patch a thin-ribbon material (road / rail) so its fragment colour blends
 * toward the ground colour as `uRoadFade` drops from 1 → 0. Opaque (no alpha /
 * no transparent-pass reordering): a faded ribbon just reads as ground, which
 * is exactly what's underneath it. The mix happens in linear space before the
 * (no-op, since the targets are linear) colorspace conversion.
 */
function attachRoadFadeShader(mat: THREE.MeshToonMaterial, groundColor: THREE.Color): void {
  const fade = { value: 1 };
  const ground = { value: groundColor.clone() };
  mat.userData.uRoadFade = fade;
  mat.userData.uRoadFadeGround = ground;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRoadFade = fade;
    shader.uniforms.uRoadFadeGround = ground;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uRoadFade;
uniform vec3 uRoadFadeGround;`
      )
      .replace(
        '#include <colorspace_fragment>',
        `
        // Dissolve sub-pixel ribbons into the ground so they stop shimmering.
        gl_FragColor.rgb = mix(uRoadFadeGround, gl_FragColor.rgb, uRoadFade);
        #include <colorspace_fragment>
        `
      );
  };
  mat.needsUpdate = true;
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
