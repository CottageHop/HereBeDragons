import * as THREE from 'three';
import { Layer } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';

/**
 * Dedicated THREE render layer for tree billboards. The composer's normal pass
 * swaps in a MeshNormalMaterial override that can't run our billboard vertex
 * shader — rendered with it, every tree would collapse to a stray quad at its
 * tile origin and the outline pass would ring it. Keeping trees on their own
 * layer lets the normal pass exclude them (same trick as labels / buildings).
 */
export const TREE_THREE_LAYER = 3;

/** Default billboard footprint in metres (canvas is 2:3, so is this). */
const TREE_WIDTH_M = 6;
const TREE_HEIGHT_M = 9;

/** Default trunk colour before a theme is applied; theme application overrides
 *  it via setColors so the trunk matches each palette (see applyMergedPalette). */
const TRUNK_COLOR = '#6b4f33';
/** Base canopy wind-sway strength at multiplier 1.0 (gentler than grass). */
const TREE_WIND_STRENGTH = 0.12;

export interface TreesLayerOptions {
  /** Current camera zoom, for the LOD gate. */
  getCameraZoom: () => number;
  /** Trees only render at this camera zoom and above. Default 14. */
  minZoom?: number;
}

/**
 * Individual trees, rendered as camera-facing billboard sprites. Each tile's
 * `pois` `kind: 'tree'` points (see the trees extractor) become one instanced
 * quad per tree; a cylindrical-billboard vertex shader yaws every quad to face
 * the camera while keeping it upright, so the trunk stays vertical at any
 * bearing. The sprite texture is a stylized canvas tree shared across all
 * tiles; only its alpha (shape), a shading ramp, and a trunk/canopy region
 * mask come from the texture — the actual colours come from theme uniforms,
 * so trees recolour instantly on theme change without redrawing the canvas.
 */
export class TreesLayer extends Layer {
  readonly name: LayerName = 'trees';
  private readonly getCameraZoom: () => number;
  private readonly minZoom: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.Texture;
  /** Every loaded tree mesh, so the zoom gate can flip them together. */
  private readonly meshes = new Set<THREE.Mesh>();
  /** Current gate state — whether trees are shown at the latest camera zoom. */
  private shown = true;
  /** Wind clock — advanced each frame so the canopy sway animates. */
  private time = 0;

  constructor(materials: StylizedMaterials, opts: TreesLayerOptions) {
    super(materials);
    this.getCameraZoom = opts.getCameraZoom;
    this.minZoom = opts.minZoom ?? 14;
    this.texture = makeTreeTexture();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // Standard fog uniforms (fogColor / fogDensity / …) so the renderer can
        // fill them each frame. Cloned rather than shared so we don't mutate
        // Three's library uniform objects.
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uMap: { value: this.texture },
        uCanopy: { value: new THREE.Color(Palette.landuse_wood.color) },
        uTrunk: { value: new THREE.Color(TRUNK_COLOR) },
        uWidth: { value: TREE_WIDTH_M },
        uHeight: { value: TREE_HEIGHT_M },
        // Wind sway — the canopy leans in a slow breeze that matches the grass
        // and cloud drift, so the whole scene moves as one. Trunk stays planted.
        uTime: { value: 0 },
        uWindDir: { value: new THREE.Vector2(1, 0.3).normalize() },
        uWindStrength: { value: TREE_WIND_STRENGTH },
        uWindFreq: { value: 0.04 },
        uWindSpeed: { value: 1.1 }
      },
      vertexShader: TREE_VERT,
      fragmentShader: TREE_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      // Opt into scene fog. Three injects the USE_FOG / FOG_EXP2 defines and
      // refreshes the fog uniforms; the fog_* chunks in the shaders below run
      // the same FogExp2 math the toon materials use, so trees fade with the
      // same atmosphere as buildings/roads/water (and respond to the Fog
      // tilt/strength controls, which drive scene.fog.density).
      fog: true
    });
  }

  /**
   * Recolour the canopy and trunk from the active theme. Both are theme-derived
   * so trees match the palette's aesthetic — e.g. a greyscale theme yields a
   * dark-grey trunk rather than a stand-out brown.
   */
  setColors(canopyHex: string, trunkHex: string): void {
    (this.material.uniforms.uCanopy.value as THREE.Color).set(canopyHex);
    (this.material.uniforms.uTrunk.value as THREE.Color).set(trunkHex);
  }

  /** Scale the canopy wind-sway strength (1 = default; 0 = still). */
  setWindStrength(mult: number): void {
    this.material.uniforms.uWindStrength.value = TREE_WIND_STRENGTH * Math.max(0, mult);
  }

  build(geometry: LayerGeometry): THREE.Object3D {
    const count = geometry.positions.length / 3;
    if (count === 0) return new THREE.Group();

    const geo = new THREE.InstancedBufferGeometry();
    // Shared unit quad: x in [-0.5, 0.5] (centred), y in [0, 1] (grows up from
    // the base). uv.v = 0 at the base so — with three's default flipY — the
    // trunk (canvas bottom) lands at ground level and the canopy at the top.
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0],
        3
      )
    );
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    // Per-tree instanced attributes. `positions` (XYZ base, tile-local) doubles
    // as the per-instance offset; `scale` is the size-variety multiplier.
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(geometry.positions, 3));
    const scale = (geometry.attributes?.scale as Float32Array | undefined) ?? new Float32Array(count).fill(1);
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));
    geo.instanceCount = count;

    const mesh = new THREE.Mesh(geo, this.material);
    // Billboards expand well beyond their base points in the shader, so the
    // default bounding sphere would cull them wrongly. Tiles are already bound
    // by the tile window, so just skip per-mesh frustum culling.
    mesh.frustumCulled = false;
    mesh.renderOrder = 1; // after the ground/landuse fills they stand on
    mesh.visible = this.shown;
    // Own render layer so the normal pass can skip them — see TREE_THREE_LAYER.
    mesh.layers.set(TREE_THREE_LAYER);

    this.meshes.add(mesh);
    // Auto-prune from the registry when the tile is evicted (its geometry is
    // disposed by TileGroup) — same pattern as ROAD_GROUPS.
    const cleanup = (): void => {
      this.meshes.delete(mesh);
      geo.removeEventListener('dispose', cleanup);
    };
    geo.addEventListener('dispose', cleanup);

    return mesh;
  }

  /**
   * @returns true if the frame needs a redraw — either the zoom gate flipped
   *   tree visibility, or trees are showing and the wind sway advanced (so the
   *   render-on-demand loop keeps the canopy moving).
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

const TREE_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aScale;
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
  // Tree base in world space (modelMatrix carries the tile group's transform,
  // including the spawn-rise animation).
  vec3 worldBase = (modelMatrix * vec4(aOffset, 1.0)).xyz;
  // Camera basis in world space, read from the view matrix rows.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  // The quad always yaws to face the camera (width along camera-right, kept
  // horizontal). Its up-axis stays world-up at oblique views — so trees stand
  // upright with the trunk planted — but tips back toward the camera's up as the
  // view approaches top-down, where an upright billboard would vanish edge-on.
  // downness is 0 at the horizon, 1 looking straight down.
  float downness = clamp(-camFwd.y, 0.0, 1.0);
  float lay = smoothstep(0.45, 0.95, downness);
  vec3 right = normalize(vec3(camRight.x, 0.0, camRight.z));
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), camUp, lay));
  float w = uWidth * aScale;
  float h = uHeight * aScale;
  vec3 worldPos = worldBase + right * (position.x * w) + up * (position.y * h);
  // Wind sway: the canopy leans along the wind in a slow travelling wave that
  // sweeps across the stand (phase keyed off the tree's world XZ). Linear in
  // height so the trunk base stays planted and the crown moves most.
  float p = dot(worldBase.xz, uWindDir) * uWindFreq + uTime * uWindSpeed;
  float sway = sin(p) * uWindStrength * position.y;
  worldPos.x += uWindDir.x * sway * h;
  worldPos.z += uWindDir.y * sway * h;
  // View-space position doubles as the fog depth (consumed by fog_vertex),
  // matching the scene FogExp2 the toon materials fade with.
  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const TREE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uCanopy;
uniform vec3 uTrunk;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  vec4 tex = texture2D(uMap, vUv);
  // Alpha-tested billboard — hard silhouette, no transparent-pass sorting, and
  // it writes depth so the outline pass edges the tree shape.
  if (tex.a < 0.5) discard;
  // texture channels: r = shading ramp, b = trunk-vs-canopy region mask.
  float shade = 0.6 + 0.4 * tex.r;
  vec3 base = mix(uCanopy, uTrunk, step(0.5, tex.b));
  // Render targets are linear; uniforms are linear THREE.Color — output linear.
  gl_FragColor = vec4(base * shade, 1.0);
  // Blend toward the fog colour by view distance. No-op without scene fog
  // (the chunk is guarded by USE_FOG).
  #include <fog_fragment>
}
`;

/**
 * Draw a stylized tree onto a 128×192 canvas, encoding everything the shader
 * needs into channels rather than final colour: alpha = silhouette, red = a
 * top-lit shading ramp, blue = region mask (0 canopy, 1 trunk). The actual
 * canopy/trunk colours come from theme uniforms at draw time.
 */
function makeTreeTexture(): THREE.Texture {
  // Headless (SSR / tests): no canvas — return an empty texture (never sampled
  // without a renderer anyway).
  if (typeof document === 'undefined') return new THREE.Texture();
  const w = 128;
  const h = 192;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  ctx.clearRect(0, 0, w, h);

  // Trunk first (canvas bottom): blue = 255 marks the trunk region; red ramps
  // dark-at-base → lighter-up for a touch of shading.
  const tg = ctx.createLinearGradient(0, 118, 0, 190);
  tg.addColorStop(0, 'rgb(160,0,255)');
  tg.addColorStop(1, 'rgb(90,0,255)');
  ctx.fillStyle = tg;
  const tw = 16;
  ctx.fillRect(w / 2 - tw / 2, 118, tw, 74);

  // Canopy: overlapping circles sharing one vertical gradient so the whole
  // crown is lit top → bottom. blue = 0 (canopy region). The blobs all overlap
  // heavily around the centre so their union is ONE rounded crown (not two
  // lobes), with a large lower-centre blob that reaches down over the trunk
  // top so the trunk emerges cleanly from a single bush.
  const cg = ctx.createLinearGradient(0, 6, 0, 150);
  cg.addColorStop(0, 'rgb(255,255,0)');
  cg.addColorStop(1, 'rgb(120,120,0)');
  ctx.fillStyle = cg;
  const blobs: Array<[number, number, number]> = [
    [64, 56, 50], // main crown
    [40, 74, 34], // left shoulder
    [88, 74, 34], // right shoulder
    [64, 102, 48], // large lower-centre — merges down over the trunk as one mass
    [48, 46, 28], // upper-left round
    [80, 46, 28] // upper-right round
  ];
  for (const [bx, by, br] of blobs) {
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // channels are masks/ramps, not colour
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
