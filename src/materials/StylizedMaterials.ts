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
   * Current painterly-surface strength (0..1). Applied to every non-building,
   * non-road material (ground, water, landuse, beach) so flat colour fields
   * gain a hand-painted watercolor wash. Tracked here so materials created
   * after the theme is applied (e.g. car_body when the cars layer first loads)
   * inherit the right strength. Theme-gated — 0 on themes that don't ask.
   */
  private painterlySurfaceStrength = 0;
  /**
   * Current road-surfacing strength (0..1) — cobblestone setts on roads,
   * mottled earth on paths. Tracked so road/rail materials created after the
   * theme is applied inherit it. Theme-gated (0 = plain ribbons).
   */
  private roadTextureStrength = 0;
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

  /**
   * Apply (or clear, with `null`) the painterly storybook building treatment —
   * a per-fragment look layered over the toon shading: warm plaster walls with
   * a sunlit vertical gradient, glowing window rows, terracotta roofs, and
   * per-building hand-painted color variation. Drives shader uniforms shared by
   * the building materials, so a theme swap is instant (no geometry rebuild).
   * `roof` defaults to a darkened wall color, `window` to warm lamplight.
   */
  setPainterly(
    style: { strength?: number; roof?: string; window?: string; floorHeight?: number } | null
  ): void {
    for (const slot of [Palette.building, Palette.building_top]) {
      const mat = this.get(slot);
      const ud = mat.userData;
      const strength = ud.uPainterly as { value: number } | undefined;
      const roof = ud.uRoofColor as { value: THREE.Color } | undefined;
      const win = ud.uWindowColor as { value: THREE.Color } | undefined;
      const floorH = ud.uFloorHeight as { value: number } | undefined;
      if (strength) strength.value = style?.strength ?? 0;
      // Roof defaults to a darkened wall color so omitting it still reads as a
      // distinct roof rather than flat wall tone.
      if (roof) roof.value.set(style?.roof ?? '#' + mat.color.clone().multiplyScalar(0.55).getHexString());
      if (win) win.value.set(style?.window ?? '#ffd98a');
      if (floorH) floorH.value = style?.floorHeight ?? 3.5;
    }
  }

  /**
   * Read back the resolved painterly-building look from the building material's
   * uniforms (the source of truth — includes the derived roof default). Colors
   * are returned as sRGB hex. Used by the public getter + studio resync.
   */
  getPainterly(): { strength: number; roof: string; window: string; floorHeight: number } {
    const mat = this.get(Palette.building);
    const strength = (mat.userData.uPainterly as { value: number } | undefined)?.value ?? 0;
    const roof = mat.userData.uRoofColor as { value: THREE.Color } | undefined;
    const win = mat.userData.uWindowColor as { value: THREE.Color } | undefined;
    const floorH = (mat.userData.uFloorHeight as { value: number } | undefined)?.value ?? 3.5;
    return {
      strength,
      roof: '#' + (roof ? roof.value.getHexString() : '8a5038'),
      window: '#' + (win ? win.value.getHexString() : 'ffd98a'),
      floorHeight: floorH
    };
  }

  /**
   * Set the painterly watercolor-wash strength (0..1) on every surface material
   * — ground, water, landuse, beach. 0 = flat toon fills (the look every other
   * theme keeps); ~0.9 gives the Ghibli theme its hand-painted, uneven gouache
   * surfaces. Stored so materials created later inherit the same strength.
   */
  setPainterlySurface(strength: number): void {
    this.painterlySurfaceStrength = strength;
    for (const mat of this.cache.values()) {
      const u = mat.userData.uPainterlySurface as { value: number } | undefined;
      if (u) u.value = strength;
    }
  }

  /**
   * Set the road-surfacing strength (0..1): cobblestone setts on major/minor
   * roads and mottled earth on paths. 0 = plain ribbons (every non-Ghibli
   * theme). Stored so road materials created later inherit the same strength.
   */
  setRoadTexture(strength: number): void {
    this.roadTextureStrength = strength;
    for (const mat of this.cache.values()) {
      const u = mat.userData.uRoadTexture as { value: number } | undefined;
      if (u) u.value = strength;
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

    // One onBeforeCompile per material, so the patches are mutually exclusive:
    // buildings get the blueprint/painterly-building patch, thin road/rail
    // ribbons get the sub-pixel fade, and every remaining surface (ground,
    // water, landuse, beach, car body) gets the painterly watercolor wash.
    const isBuilding = slot === Palette.building || slot === Palette.building_top;
    const fadeWidth = FADE_WIDTHS_M.find(([s]) => s === slot)?.[1];
    if (isBuilding) {
      attachBlueprintShader(mat);
    } else if (fadeWidth !== undefined) {
      const kind: 'road' | 'path' | 'none' =
        slot === Palette.road_major || slot === Palette.road_minor
          ? 'road'
          : slot === Palette.road_path
            ? 'path'
            : 'none';
      attachRoadFadeShader(mat, this.groundColor, kind);
      const rt = mat.userData.uRoadTexture as { value: number } | undefined;
      if (rt) rt.value = this.roadTextureStrength;
      this.fadeMaterials.push({ mat, widthM: fadeWidth });
    } else {
      attachPainterlySurfaceShader(mat, this.painterlySurfaceStrength);
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
function attachRoadFadeShader(
  mat: THREE.MeshToonMaterial,
  groundColor: THREE.Color,
  kind: 'road' | 'path' | 'none'
): void {
  const fade = { value: 1 };
  const ground = { value: groundColor.clone() };
  mat.userData.uRoadFade = fade;
  mat.userData.uRoadFadeGround = ground;
  // Procedural surfacing strength (theme-gated). Cobblestone setts on roads,
  // mottled earth on paths. 0 = plain ribbon (every non-Ghibli theme).
  const roadTex = { value: 0 };
  const textured = kind !== 'none';
  if (textured) mat.userData.uRoadTexture = roadTex;

  // World-XZ varying (paths/roads only) so the procedural surfacing follows the
  // ground rather than the screen. Hash/noise helpers for the two textures.
  const vertCommon = textured
    ? `#include <common>
varying vec3 vRoadWorld;`
    : '#include <common>';
  const vertBody = textured
    ? `#include <begin_vertex>
vRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    : '#include <begin_vertex>';

  const fragCommon = textured
    ? `#include <common>
uniform float uRoadFade;
uniform vec3 uRoadFadeGround;
uniform float uRoadTexture;
varying vec3 vRoadWorld;
float hbdrHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float hbdrNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hbdrHash(i), hbdrHash(i + vec2(1.0, 0.0)), u.x),
             mix(hbdrHash(i + vec2(0.0, 1.0)), hbdrHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float hbdrFbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 3; i++) { v += a * hbdrNoise(p); p *= 2.0; a *= 0.5; } return v; }`
    : `#include <common>
uniform float uRoadFade;
uniform vec3 uRoadFadeGround;`;

  // The procedural surfacing block, injected just before the sub-pixel fade so
  // the textured colour is what dissolves into the ground when the ribbon goes
  // sub-pixel. A derivative-based detail fade kills moire when zoomed out.
  let texBlock = '';
  if (kind === 'road') {
    texBlock = `
        if (uRoadTexture > 0.0) {
          vec2 cp = vRoadWorld.xz / 1.1;            // ~1.1 m cobble setts
          vec2 f = fract(cp);
          float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
          float grout = smoothstep(0.0, 0.11, edge);          // dark mortar lines
          float stone = (hbdrHash(floor(cp)) - 0.5) * 0.30;    // per-sett value
          float detail = 1.0 - smoothstep(0.35, 0.8, max(fwidth(cp.x), fwidth(cp.y)));
          vec3 tex = gl_FragColor.rgb * (1.0 + stone) * mix(0.6, 1.0, grout);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, tex, uRoadTexture * detail);
        }`;
  } else if (kind === 'path') {
    texBlock = `
        if (uRoadTexture > 0.0) {
          vec2 dp = vRoadWorld.xz;
          float n = hbdrFbm(dp * 0.6);                         // mottled earth
          float speck = hbdrHash(floor(dp * 3.0));             // pebbles / clods
          float detail = 1.0 - smoothstep(0.4, 0.9, fwidth(dp.x * 3.0));
          vec3 tex = gl_FragColor.rgb * (1.0 + (n - 0.5) * 0.34) * mix(1.0, 0.78, step(0.93, speck));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, tex, uRoadTexture * detail);
        }`;
  }

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRoadFade = fade;
    shader.uniforms.uRoadFadeGround = ground;
    if (textured) shader.uniforms.uRoadTexture = roadTex;
    if (textured) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', vertCommon)
        .replace('#include <begin_vertex>', vertBody);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragCommon)
      .replace(
        '#include <colorspace_fragment>',
        `
        ${texBlock}
        // Dissolve sub-pixel ribbons into the ground so they stop shimmering.
        gl_FragColor.rgb = mix(uRoadFadeGround, gl_FragColor.rgb, uRoadFade);
        #include <colorspace_fragment>
        `
      );
  };
  mat.needsUpdate = true;
}

/**
 * Patch a flat surface material (ground / water / landuse / beach) with a
 * procedural watercolor wash so its single flat colour reads as hand-painted
 * gouache instead of a CG fill. Driven by world-XZ fractal noise: broad colour
 * washes, a finer grain, a slight warm/cool hue drift, and a touch of
 * "pooling" darkening in the low areas — the combination that makes the
 * Ghibli surfaces look like cels. Theme-gated by `uPainterlySurface` (0 = a
 * cheap branch skip, so non-Ghibli themes are untouched and pay nothing).
 */
function attachPainterlySurfaceShader(mat: THREE.MeshToonMaterial, initial: number): void {
  const strength = { value: initial };
  mat.userData.uPainterlySurface = strength;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPainterlySurface = strength;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vSurfWorld;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vSurfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vSurfWorld;
uniform float uPainterlySurface;
float hbdsHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float hbdsNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hbdsHash(i);
  float b = hbdsHash(i + vec2(1.0, 0.0));
  float c = hbdsHash(i + vec2(0.0, 1.0));
  float d = hbdsHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float hbdsFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * hbdsNoise(p); p *= 2.0; a *= 0.5; }
  return v;
}`
      )
      .replace(
        '#include <colorspace_fragment>',
        `
        // ---- Painterly watercolor wash (theme-gated) --------------------
        if (uPainterlySurface > 0.0) {
          vec2 wp = vSurfWorld.xz;
          float wash = hbdsFbm(wp * 0.07);  // broad washes (~14 m features)
          float grain = hbdsFbm(wp * 0.33); // finer brush grain (~3 m)
          float mottle = (wash - 0.5) * 0.24 + (grain - 0.5) * 0.10;
          vec3 c = gl_FragColor.rgb;
          c *= 1.0 + mottle;                          // value variation
          c.r *= 1.0 + (wash - 0.5) * 0.07;           // warm/cool hue drift
          c.b *= 1.0 - (wash - 0.5) * 0.07;
          c *= mix(0.90, 1.02, smoothstep(0.3, 0.72, wash)); // pooling in lows
          gl_FragColor.rgb = mix(gl_FragColor.rgb, c, uPainterlySurface);
        }
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
  // Hover-affordance: subtle warm brighten of whichever building's index this
  // is set to (-1 = none). Driven per-mesh in BuildingsManager.onBeforeRender,
  // mirroring how `uSelectedBuildingIndex` is pushed for the click selection.
  const hoveredUniform = { value: -1 };
  const flattenUniform = { value: 0 };
  // Painterly building treatment (theme-gated; 0 = off so non-Ghibli themes
  // are untouched). Uniform objects are created synchronously so `setPainterly`
  // can mutate them even before the shader compiles (themes apply during
  // construction, before the first render).
  const painterlyUniform = { value: 0 };
  const roofColorUniform = { value: new THREE.Color('#8a5038') };
  const windowColorUniform = { value: new THREE.Color('#ffd98a') };
  const floorHeightUniform = { value: 3.5 };
  mat.userData.uSelectedBuildingIndex = selectedUniform;
  mat.userData.uHoveredBuildingIndex = hoveredUniform;
  mat.userData.uFlattenBuildings = flattenUniform;
  mat.userData.uPainterly = painterlyUniform;
  mat.userData.uRoofColor = roofColorUniform;
  mat.userData.uWindowColor = windowColorUniform;
  mat.userData.uFloorHeight = floorHeightUniform;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSelectedBuildingIndex = selectedUniform;
    shader.uniforms.uHoveredBuildingIndex = hoveredUniform;
    shader.uniforms.uFlattenBuildings = flattenUniform;
    shader.uniforms.uPainterly = painterlyUniform;
    shader.uniforms.uRoofColor = roofColorUniform;
    shader.uniforms.uWindowColor = windowColorUniform;
    shader.uniforms.uFloorHeight = floorHeightUniform;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float buildingIndex;
attribute float buildingRoof;
varying float vBuildingIndex;
varying float vBuildingRoof;
uniform float uFlattenBuildings;
// Painterly varyings: height above the building base (m), surface up-facing
// amount (1 = roof, 0 = wall), and an along-wall horizontal coordinate (m).
varying float vPaintHeight;
varying float vPaintUp;
varying float vPaintTangent;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vBuildingIndex = buildingIndex;
vBuildingRoof = buildingRoof;
// Collapse buildings to the ground plane. With uFlattenBuildings = 1 every
// vertex's Y goes to zero — wall quads degenerate to zero-area lines, only
// the roof footprint remains visible on the map.
transformed.y *= (1.0 - uFlattenBuildings);
// Painterly coords. Tiles are translated but never rotated/scaled, so the
// object-space normal equals the world normal and the along-wall tangent is
// (-n.z, 0, n.x). Project the world XZ onto it for a seam-consistent
// horizontal window coordinate that follows each wall's facing direction.
vPaintHeight = transformed.y;
vPaintUp = normal.y;
vec3 hbdWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vPaintTangent = hbdWorld.x * (-normal.z) + hbdWorld.z * (normal.x);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vBuildingIndex;
varying float vBuildingRoof;
uniform float uSelectedBuildingIndex;
uniform float uHoveredBuildingIndex;
varying float vPaintHeight;
varying float vPaintUp;
varying float vPaintTangent;
uniform float uPainterly;
uniform vec3 uRoofColor;
uniform vec3 uWindowColor;
uniform float uFloorHeight;
float hbdHash1(float n) { return fract(sin(n) * 43758.5453123); }
float hbdHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float hbdNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hbdHash2(i), hbdHash2(i + vec2(1.0, 0.0)), u.x),
             mix(hbdHash2(i + vec2(0.0, 1.0)), hbdHash2(i + vec2(1.0, 1.0)), u.x), u.y);
}`
      )
      .replace(
        '#include <colorspace_fragment>',
        `
        // ---- Painterly storybook treatment (theme-gated) ----------------
        // Layered over the toon-lit color so cel bands survive. uPainterly = 0
        // on every non-Ghibli theme makes this a no-op.
        if (uPainterly > 0.0) {
          vec3 hbdBase = gl_FragColor.rgb;
          float rnd = hbdHash1(vBuildingIndex + 0.5);
          // Explicit roof flag wins so pitched (sloped-normal) roof faces still
          // read as roof; fall back to the up-facing test for flat caps.
          float roofness = clamp(max(smoothstep(0.5, 0.8, vPaintUp), vBuildingRoof), 0.0, 1.0);
          float warm = rnd - 0.5;

          // Walls: light, cheerful pastel plaster — each building a different
          // soft hue over the airy cream base, for a happy, peaceful village
          // row. Multiplicative (linear space) so the tints stay light & gentle.
          vec3 wall = hbdBase;
          float fam = floor(rnd * 6.0);
          vec3 tint;
          if (fam < 1.0)      tint = vec3(1.06, 1.02, 0.84); // soft butter
          else if (fam < 2.0) tint = vec3(0.93, 1.03, 0.92); // pale sage
          else if (fam < 3.0) tint = vec3(0.92, 0.99, 1.07); // gentle sky blue
          else if (fam < 4.0) tint = vec3(1.06, 0.95, 0.97); // blush pink
          else if (fam < 5.0) tint = vec3(1.04, 1.01, 0.93); // warm cream
          else                tint = vec3(1.07, 0.98, 0.90); // soft peach
          wall *= tint;
          // Per-building brightness jitter so even same-colour neighbours differ.
          float vary = fract(rnd * 7.31) - 0.5;
          wall *= (1.0 + vary * 0.10);
          // Gentle plaster mottle — much softer than a weathered look, just
          // enough hand-painted unevenness to avoid a flat CG fill.
          float weather = hbdHash2(vec2(floor(vPaintTangent * 0.35), floor(vPaintHeight * 0.5)));
          wall *= 0.97 + weather * 0.07;
          // Fine plaster grain for close-up texture (high-frequency, very subtle).
          float pgrain = hbdHash2(vec2(floor(vPaintTangent * 1.6), floor(vPaintHeight * 1.6)));
          wall *= 0.985 + pgrain * 0.03;
          float hg = clamp(vPaintHeight / 40.0, 0.0, 1.0);
          wall *= mix(0.93, 1.07, hg); // brighter toward the sunlit top
          // Pale stone/plaster foundation: the lowest few metres lighten and
          // desaturate toward a neutral stone, like the reference's ground floor.
          float baseBlend = (1.0 - smoothstep(0.5, 5.5, vPaintHeight)) * 0.4;
          float wlum = dot(wall, vec3(0.299, 0.587, 0.114));
          wall = mix(wall, vec3(wlum) * 1.18 + 0.06, baseBlend);
          // Contact shadow: darken the very bottom where wall meets ground so
          // buildings read as grounded rather than floating on the map.
          float contact = (1.0 - smoothstep(0.0, 1.3, vPaintHeight)) * (1.0 - roofness);
          wall *= mix(1.0, 0.64, contact);

          // Window grid. Rows from height, columns from the along-wall coord.
          // Floor height + column width are jittered per building (independent
          // hashes of the building index) so window sizes/spacing differ from
          // one building to the next instead of a uniform grid everywhere.
          float floorH = max(uFloorHeight, 1.0) * (0.8 + hbdHash1(vBuildingIndex + 3.1) * 0.5);
          float colW = 2.4 + hbdHash1(vBuildingIndex + 7.7) * 1.8;
          float fy = vPaintHeight / floorH;
          float fx = vPaintTangent / colW;
          float fxr = fract(fx);
          float fyr = fract(fy);
          float onWall = 1.0 - roofness;
          float aboveBase = smoothstep(0.6, 1.4, vPaintHeight); // skip street level
          // Dissolve the facade detail before it goes sub-pixel, so zoomed-out
          // walls don't shimmer/moire (same idea as the road sub-pixel fade).
          float detail = 1.0 - smoothstep(0.28, 0.6, max(fwidth(fx), fwidth(fy)));

          // Framed windows: an inner glass pane + a darker frame ring, so
          // windows read as real openings rather than flat squares.
          float pane = step(0.30, fxr) * step(fxr, 0.70) * step(0.42, fyr) * step(fyr, 0.78)
                       * onWall * aboveBase * detail;
          float outer = step(0.22, fxr) * step(fxr, 0.78) * step(0.34, fyr) * step(fyr, 0.84)
                        * onWall * aboveBase * detail;
          float frame = clamp(outer - pane, 0.0, 1.0);
          // Door: ~18% of columns (per building) become a tall ground-floor
          // entrance. Suppress the window in that cell so a door, not a window.
          float isDoorCol = step(0.82, hbdHash2(vec2(floor(fx), vBuildingIndex + 31.0)));
          float groundCell = isDoorCol * step(vPaintHeight, floorH * 1.05);
          pane *= (1.0 - groundCell);
          frame *= (1.0 - groundCell);
          float lit = step(0.45, hbdHash2(vec2(floor(fx), floor(fy) + vBuildingIndex)));
          wall = mix(wall, wall * 0.42, frame);              // dark window frame
          wall += uWindowColor * pane * lit * 0.85;          // lit glass glow
          wall = mix(wall, wall * 0.55, pane * (1.0 - lit)); // unlit dark glass

          // Tall entrance door with a warm interior glow spilling out at its base.
          float doorW = step(0.30, fxr) * step(fxr, 0.70);
          float doorBody = 1.0 - smoothstep(floorH * 0.78, floorH * 0.92, vPaintHeight);
          float door = groundCell * doorW * doorBody * onWall * detail;
          wall = mix(wall, wall * 0.28, door);
          wall += uWindowColor * door * (1.0 - smoothstep(0.0, floorH * 0.45, vPaintHeight)) * 0.35;

          // Window sill: a thin shadow line just under each window opening.
          float sill = (1.0 - smoothstep(0.0, 0.05, abs(fyr - 0.40)))
                       * step(0.24, fxr) * step(fxr, 0.76) * onWall * aboveBase * detail;
          wall = mix(wall, wall * 0.70, sill * 0.5);

          // Shutters: ~40% of buildings get dark wooden panels flanking each
          // window — a Ghibli cottage staple (the reference's lattice shutters).
          float shutterOn = step(0.60, hbdHash1(vBuildingIndex + 19.4));
          float shutterX = step(0.10, fxr) * step(fxr, 0.20) + step(0.80, fxr) * step(fxr, 0.90);
          float shutterMask = clamp(shutterX, 0.0, 1.0) * step(0.40, fyr) * step(fyr, 0.80)
                              * onWall * aboveBase * detail * shutterOn;
          wall = mix(wall, vec3(0.32, 0.21, 0.15), shutterMask * 0.85);

          // String courses: a thin darker trim line at each floor boundary so
          // the building reads as clearly stacked storeys.
          float course = (1.0 - smoothstep(0.05, 0.12, fyr)) * onWall * aboveBase * detail;
          wall = mix(wall, wall * 0.80, course * 0.5);

          // Awning band: ~45% of buildings get a coloured strip at the top of
          // the ground floor, in a per-building accent hue — a shopfront
          // flourish that makes each building distinct.
          float awningOn = step(0.55, hbdHash1(vBuildingIndex + 5.5));
          float awningBand = (1.0 - smoothstep(0.0, 0.7, abs(vPaintHeight - floorH)))
                             * onWall * detail * awningOn;
          float ahue = hbdHash1(vBuildingIndex + 13.7);
          vec3 accent;
          if (ahue < 0.25)      accent = vec3(0.80, 0.28, 0.26); // warm red
          else if (ahue < 0.50) accent = vec3(0.24, 0.50, 0.66); // teal blue
          else if (ahue < 0.75) accent = vec3(0.34, 0.58, 0.36); // leaf green
          else                  accent = vec3(0.90, 0.70, 0.28); // gold
          wall = mix(wall, accent, awningBand * 0.7);

          // Shopfront: ~35% of buildings are lit shops — a warm interior glow
          // spills from the ground floor and a bright sign fascia glows at the
          // top of it, evoking the reference's lit ramen-shop. (Literal glyph
          // signs would be a separate billboard layer; this is the lit-front.)
          float isShop = step(0.65, hbdHash1(vBuildingIndex + 41.0));
          float groundLit = isShop
                            * (1.0 - smoothstep(floorH * 0.95, floorH * 1.15, vPaintHeight))
                            * onWall * aboveBase * detail;
          wall += uWindowColor * groundLit * (0.20 + 0.35 * (1.0 - smoothstep(0.0, floorH, vPaintHeight)));
          float signBand = isShop * (1.0 - smoothstep(0.0, 0.45, abs(vPaintHeight - floorH)))
                           * onWall * detail;
          wall = mix(wall, accent * 1.5, signBand * 0.6); // bright backlit sign strip

          // Pilasters: faint vertical trim at the column boundaries so the
          // facade reads as articulated bays (pairs with the string courses).
          float pilaster = (1.0 - smoothstep(0.04, 0.10, min(fxr, 1.0 - fxr)))
                           * onWall * aboveBase * detail;
          wall = mix(wall, wall * 0.86, pilaster * 0.35);

          // Ivy: climbs ~45% of walls from the base, denser low, with a leafy
          // two-tone noise — the trailing greenery all over the reference model.
          float ivyAmt = hbdHash1(vBuildingIndex + 23.7);
          if (ivyAmt > 0.55) {
            vec2 ivyP = vec2(vPaintTangent, vPaintHeight);
            float ivyField = hbdNoise2(ivyP * 0.45) * 0.6 + hbdNoise2(ivyP * 1.2) * 0.4;
            float ivyClimb = 1.0 - smoothstep(2.0, 7.0 + ivyAmt * 16.0, vPaintHeight);
            float ivyMask = onWall * detail * smoothstep(0.46, 0.62, ivyField * (0.4 + ivyClimb));
            vec3 ivyShade = mix(vec3(0.16, 0.32, 0.13), vec3(0.32, 0.50, 0.22), hbdNoise2(ivyP * 2.4));
            wall = mix(wall, ivyShade, ivyMask * 0.9);
          }

          // Roof: dark slate tile, keeping the toon light/shade split via base
          // luma. Kawara tile rows — horizontal grooves across the pitch, keyed
          // on world height so a flat cap (constant height) stays smooth. The
          // detail dissolves before it goes sub-pixel to avoid shimmer.
          float baseLuma = dot(hbdBase, vec3(0.299, 0.587, 0.114));
          vec3 roof = uRoofColor * mix(0.82, 1.18, baseLuma);
          // Per-building roof colour family so rooftops vary across the town
          // rather than all being one slate. Multiplicative over the theme roof
          // colour so they stay a cohesive set of tiled-roof tones.
          float rfam = floor(hbdHash1(vBuildingIndex + 21.3) * 5.0);
          vec3 rtint;
          if (rfam < 1.0)      rtint = vec3(1.00, 1.00, 1.00); // terracotta (base)
          else if (rfam < 2.0) rtint = vec3(1.07, 0.89, 0.83); // brick red
          else if (rfam < 3.0) rtint = vec3(1.06, 0.97, 0.80); // clay orange
          else if (rfam < 4.0) rtint = vec3(0.90, 0.83, 0.79); // weathered brown
          else                 rtint = vec3(1.04, 0.88, 0.85); // dusty rose tile
          roof *= rtint;
          roof *= (1.0 + warm * 0.08);
          float tr = abs(fract(vPaintHeight / 0.9) - 0.5) * 2.0;
          float tdetail = 1.0 - smoothstep(0.3, 0.7, fwidth(vPaintHeight / 0.9));
          roof *= 1.0 - smoothstep(0.6, 1.0, tr) * 0.32 * tdetail; // dark rows
          // Vertical tile seams crossing the rows → a full kawara tile grid.
          float tc = abs(fract(vPaintTangent / 0.7) - 0.5) * 2.0;
          float tcdetail = 1.0 - smoothstep(0.3, 0.7, fwidth(vPaintTangent / 0.7));
          roof *= 1.0 - smoothstep(0.72, 1.0, tc) * 0.18 * tcdetail; // seams
          // A faint warm highlight on the ridge cap (very top of the pitch).
          roof += uRoofColor * 0.15 * smoothstep(0.9, 1.0, vPaintUp) * vBuildingRoof;
          // Moss: soft green patches on the tiles — a weathered roof that ties
          // to the wall ivy (the reference's roof carries greenery too).
          float moss = hbdNoise2(vec2(vPaintTangent, vPaintHeight) * 0.6);
          roof = mix(roof, vec3(0.26, 0.34, 0.17), smoothstep(0.66, 0.80, moss) * vBuildingRoof * 0.45);

          vec3 painted = mix(wall, roof, roofness);
          gl_FragColor.rgb = mix(hbdBase, painted, uPainterly);
        }

        // ---- Blueprint mode for the selected building -------------------
        // Use a saturated cyan rather than near-white so the OutlinePass's
        // luma-based shine doesn't push the surface to pure white. Runs after
        // the painterly block so a selected building still reads as blueprint.
        // Hover affordance: a subtle warm brighten on the building the cursor
        // is over. Runs BEFORE the blueprint selection check so a selected
        // building (the stronger state) still wins when both overlap.
        if (uHoveredBuildingIndex >= 0.0 &&
            abs(vBuildingIndex - uHoveredBuildingIndex) < 0.5) {
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.95, 0.82), 0.18);
        }
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
