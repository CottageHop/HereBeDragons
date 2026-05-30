import * as THREE from 'three';
import { Layer } from './Layer.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';

/**
 * Dedicated THREE render layer for grass billboards — same rationale as
 * {@link TREE_THREE_LAYER}: the composer's normal pass swaps in a
 * MeshNormalMaterial that can't run the billboard + wind vertex shader, so
 * grass lives on its own layer and the normal pass excludes it.
 */
export const GRASS_THREE_LAYER = 4;

/** Default tuft footprint in metres — wider than tall so a field reads as turf
 *  clumps rather than spikes, and big enough to be legible at map zoom. */
const GRASS_WIDTH_M = 2.4;
const GRASS_HEIGHT_M = 1.6;

const BASE_COLOR = '#5e7a32';
const TIP_COLOR = '#a6c558';
/** Base wind-sway strength at multiplier 1.0. */
const GRASS_WIND_STRENGTH = 0.4;

export interface GrassLayerOptions {
  /** Current camera zoom, for the LOD gate. */
  getCameraZoom: () => number;
  /** Grass only renders at this camera zoom and above. Default 14 — matched to
   *  the trees gate so grass and trees appear together (the tile manager can
   *  serve z15 tiles while the reported camera zoom is still ~14.x). */
  minZoom?: number;
}

/**
 * Wind-blown grass, rendered as instanced camera-facing billboard tufts. The
 * grass extractor scatters base points across green landuse; this layer
 * expands each into a quad and the vertex shader bends the tips in a travelling
 * wind wave (stiff at the base, swaying at the tip) so a meadow ripples like
 * wind moving over it. Colours come from theme uniforms (base + tip green) so
 * grass recolours instantly on a theme swap. The tuft texture is a stylized
 * canvas shared across tiles — only its alpha (blade shape) and a base→tip
 * shading ramp come from the texture.
 */
export class GrassLayer extends Layer {
  readonly name: LayerName = 'grass';
  private readonly getCameraZoom: () => number;
  private readonly minZoom: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.Texture;
  private readonly meshes = new Set<THREE.Mesh>();
  private shown = true;
  /** Wind clock — advanced each frame so the sway animates. */
  private time = 0;

  constructor(materials: StylizedMaterials, opts: GrassLayerOptions) {
    super(materials);
    this.getCameraZoom = opts.getCameraZoom;
    this.minZoom = opts.minZoom ?? 14;
    this.texture = makeGrassTexture();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uMap: { value: this.texture },
        uBase: { value: new THREE.Color(BASE_COLOR) },
        uTip: { value: new THREE.Color(TIP_COLOR) },
        uWidth: { value: GRASS_WIDTH_M },
        uHeight: { value: GRASS_HEIGHT_M },
        uTime: { value: 0 },
        // Wind direction in scene XZ, matching the cloud drift so the whole
        // world feels driven by one breeze.
        uWindDir: { value: new THREE.Vector2(1, 0.3).normalize() },
        uWindStrength: { value: GRASS_WIND_STRENGTH },
        uWindFreq: { value: 0.06 },
        uWindSpeed: { value: 1.6 }
      },
      vertexShader: GRASS_VERT,
      fragmentShader: GRASS_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      fog: true
    });
  }

  /** Recolour base + tip from the active theme (derived from the park color). */
  setColors(baseHex: string, tipHex: string): void {
    (this.material.uniforms.uBase.value as THREE.Color).set(baseHex);
    (this.material.uniforms.uTip.value as THREE.Color).set(tipHex);
  }

  /** Scale the wind-sway strength (1 = default; 0 = still). */
  setWindStrength(mult: number): void {
    this.material.uniforms.uWindStrength.value = GRASS_WIND_STRENGTH * Math.max(0, mult);
  }

  build(geometry: LayerGeometry): THREE.Object3D {
    const count = geometry.positions.length / 3;
    if (count === 0) return new THREE.Group();

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3)
    );
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(geometry.positions, 3));
    const scale = (geometry.attributes?.scale as Float32Array | undefined) ?? new Float32Array(count).fill(1);
    const phase = (geometry.attributes?.phase as Float32Array | undefined) ?? new Float32Array(count);
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.instanceCount = count;

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.visible = this.shown;
    mesh.layers.set(GRASS_THREE_LAYER);

    this.meshes.add(mesh);
    const cleanup = (): void => {
      this.meshes.delete(mesh);
      geo.removeEventListener('dispose', cleanup);
    };
    geo.addEventListener('dispose', cleanup);

    return mesh;
  }

  /**
   * @returns true if the frame needs a redraw — either the zoom gate flipped
   *   grass visibility, or grass is showing and its wind sway advanced (so the
   *   render-on-demand loop keeps animating the meadow).
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
    this.texture.dispose();
    this.meshes.clear();
  }
}

const GRASS_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aScale;
attribute float aPhase;
uniform float uWidth;
uniform float uHeight;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindFreq;
uniform float uWindSpeed;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec3 worldBase = (modelMatrix * vec4(aOffset, 1.0)).xyz;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float downness = clamp(-camFwd.y, 0.0, 1.0);
  float lay = smoothstep(0.45, 0.95, downness);
  vec3 right = normalize(vec3(camRight.x, 0.0, camRight.z));
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), camUp, lay));
  float w = uWidth * aScale;
  float h = uHeight * aScale;
  vec3 worldPos = worldBase + right * (position.x * w) + up * (position.y * h);

  // Travelling wind wave across the field. Phase keys off the blade's world XZ
  // so the ripple sweeps over the meadow; the per-blade aPhase desyncs
  // neighbours. Bend is quadratic in height so the base stays planted and only
  // the tip sways. A second, faster harmonic adds a flutter.
  float p = dot(worldBase.xz, uWindDir) * uWindFreq + uTime * uWindSpeed + aPhase;
  float wave = sin(p) + 0.3 * sin(p * 2.7 + 1.3);
  float bend = wave * uWindStrength * position.y * position.y;
  worldPos.x += uWindDir.x * bend * h;
  worldPos.z += uWindDir.y * bend * h;

  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const GRASS_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uBase;
uniform vec3 uTip;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(uMap, vUv);
  if (tex.a < 0.5) discard;
  // texture: alpha = blade silhouette, red = base→tip shading/height ramp.
  vec3 col = mix(uBase, uTip, tex.r);
  // A touch of extra contrast so tufts don't read as a flat green mat.
  col *= 0.85 + 0.3 * tex.r;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

/**
 * Draw a stylized grass tuft (a fan of blades) onto a 96×96 canvas. Channels:
 * alpha = silhouette, red = base→tip ramp (dark base, light tip). The actual
 * green comes from theme uniforms at draw time.
 */
function makeGrassTexture(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture();
  const s = 96;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  ctx.clearRect(0, 0, s, s);

  // Several blades fanning out from the base centre. Each blade is a tapered
  // triangle; we paint it with a vertical gradient so red ramps 0 (base) → 1
  // (tip) regardless of which blade.
  const grad = ctx.createLinearGradient(0, s, 0, 0);
  grad.addColorStop(0, 'rgb(40,0,0)'); // base: low red
  grad.addColorStop(1, 'rgb(255,0,0)'); // tip: high red
  ctx.fillStyle = grad;

  const blades: Array<[number, number]> = [
    [0.5, 0.0],   // centre, straight up
    [0.30, -0.18],
    [0.70, 0.18],
    [0.16, -0.34],
    [0.84, 0.34],
    [0.42, -0.08],
    [0.58, 0.08]
  ];
  const baseY = s * 0.98;
  for (const [cx, lean] of blades) {
    const x = cx * s;
    const tipX = x + lean * s;
    const tipY = s * (0.06 + Math.random() * 0.12);
    const halfW = s * 0.05;
    ctx.beginPath();
    ctx.moveTo(x - halfW, baseY);
    ctx.lineTo(x + halfW, baseY);
    ctx.quadraticCurveTo((x + tipX) / 2 + halfW, (baseY + tipY) / 2, tipX, tipY);
    ctx.quadraticCurveTo((x + tipX) / 2 - halfW, (baseY + tipY) / 2, x - halfW, baseY);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
