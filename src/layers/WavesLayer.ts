import * as THREE from 'three';
import { Layer, makeBufferGeometry } from './Layer.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';

/**
 * Own render layer so the composer's normal/outline pass can skip the waves —
 * they're a custom animated shader the MeshNormalMaterial override can't run.
 */
export const WAVES_THREE_LAYER = 5;

const SHALLOW_COLOR = '#9fd6e0';
const BEACH_COLOR = '#ecd9a6';
const FOAM_COLOR = '#fbf6ec';

export interface WavesLayerOptions {
  getCameraZoom: () => number;
  /** Waves render at this camera zoom and above. Default 12. */
  minZoom?: number;
}

/**
 * Animated shoreline foam. The waves extractor emits a flat ribbon straddling
 * every water boundary edge with `shoreV` (across: 0 water / 0.5 shoreline / 1
 * land) and `shoreU` (along-coast metres). This layer renders it with a custom
 * shader that paints a wet band — shallow water on the seaward half, wet sand
 * on the landward half — and animates white-capped waves rolling in and
 * breaking landward, so the coast reads as a living, hand-painted shore. A
 * single shared material is recoloured per theme.
 */
export class WavesLayer extends Layer {
  readonly name: LayerName = 'waves';
  private readonly getCameraZoom: () => number;
  private readonly minZoom: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly meshes = new Set<THREE.Mesh>();
  private shown = true;
  private time = 0;

  constructor(materials: StylizedMaterials, opts: WavesLayerOptions) {
    super(materials);
    this.getCameraZoom = opts.getCameraZoom;
    this.minZoom = opts.minZoom ?? 12;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(SHALLOW_COLOR) },
        uBeach: { value: new THREE.Color(BEACH_COLOR) },
        uFoam: { value: new THREE.Color(FOAM_COLOR) },
        uOpacity: { value: 1.0 }
      },
      vertexShader: WAVES_VERT,
      fragmentShader: WAVES_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // Pull toward the camera so the foam draws over the coplanar water plane
      // (-24). Kept just past water and below roads (-36) so a coastal road
      // still wins, and not so large it bleeds over nearby building bases.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -30,
      fog: true
    });
  }

  /** Recolour shallow water / wet sand / foam from the active theme. */
  setColors(shallowHex: string, beachHex: string, foamHex: string): void {
    (this.material.uniforms.uShallow.value as THREE.Color).set(shallowHex);
    (this.material.uniforms.uBeach.value as THREE.Color).set(beachHex);
    (this.material.uniforms.uFoam.value as THREE.Color).set(foamHex);
  }

  build(geometry: LayerGeometry): THREE.Object3D {
    if (geometry.positions.length === 0) return new THREE.Group();
    const bg = makeBufferGeometry(geometry);
    const v = geometry.attributes?.shoreV as Float32Array | undefined;
    const u = geometry.attributes?.shoreU as Float32Array | undefined;
    if (v) bg.setAttribute('shoreV', new THREE.BufferAttribute(v, 1));
    if (u) bg.setAttribute('shoreU', new THREE.BufferAttribute(u, 1));

    const mesh = new THREE.Mesh(bg, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2; // after opaque water/land, with the transparent pass
    mesh.visible = this.shown;
    mesh.layers.set(WAVES_THREE_LAYER);

    this.meshes.add(mesh);
    const cleanup = (): void => {
      this.meshes.delete(mesh);
      bg.removeEventListener('dispose', cleanup);
    };
    bg.addEventListener('dispose', cleanup);
    return mesh;
  }

  /**
   * @returns true if the frame needs a redraw — the zoom gate flipped, or waves
   *   are showing and the surf animation advanced.
   */
  update(dt: number): boolean {
    const shouldShow = this.getCameraZoom() >= this.minZoom;
    const gateFlipped = shouldShow !== this.shown;
    if (gateFlipped) {
      this.shown = shouldShow;
      for (const m of this.meshes) m.visible = shouldShow;
    }
    if (!this.shown || this.meshes.size === 0) return gateFlipped;
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    return true;
  }

  dispose(): void {
    this.material.dispose();
    this.meshes.clear();
  }
}

const WAVES_VERT = /* glsl */ `
attribute float shoreV;
attribute float shoreU;
varying float vV;
varying float vU;
#include <fog_pars_vertex>
void main() {
  vV = shoreV;
  vU = shoreU;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const WAVES_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uBeach;
uniform vec3 uFoam;
uniform float uOpacity;
varying float vV;
varying float vU;
#include <fog_pars_fragment>

float hbdwHash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  // Distance from the shoreline (v = 0.5): 0 at shore, 1 at the ribbon edges.
  float d = abs(vV - 0.5) * 2.0;

  // Rolling swell travelling along the coast, breaking over time. Two
  // frequencies so the surf doesn't read as a single metronomic pulse.
  float swell = sin(vU * 0.18 - uTime * 1.3) + 0.5 * sin(vU * 0.05 + uTime * 0.6);
  float breakAmt = smoothstep(0.1, 1.0, swell * 0.5 + 0.5);

  // The foam band sits at the shoreline and is shoved landward as a wave
  // breaks, then recedes. White-cap texture from a coarse hash that ticks
  // with time so the crest crinkles rather than sliding rigidly.
  float center = 0.5 + breakAmt * 0.18;
  float foam = (1.0 - smoothstep(0.0, 0.22, abs(vV - center))) * breakAmt;
  float crinkle = hbdwHash(floor(vU * 2.0) + floor(uTime * 3.0));
  foam *= 0.6 + 0.4 * crinkle;
  foam = clamp(foam, 0.0, 1.0);

  // Wet band: shallow water on the seaward half, wet sand on the landward half.
  vec3 baseCol = mix(uShallow, uBeach, smoothstep(0.42, 0.6, vV));
  vec3 col = mix(baseCol, uFoam, foam);

  // Alpha: the wet band feathers out at the ribbon edges (blending into open
  // water / dry land); foam is bright and near-opaque where it breaks.
  float band = 1.0 - d;
  float a = max(band * 0.5, foam) * uOpacity;
  if (a < 0.01) discard;

  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}
`;
