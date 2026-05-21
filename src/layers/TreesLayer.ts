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

  constructor(materials: StylizedMaterials, opts: TreesLayerOptions) {
    super(materials);
    this.getCameraZoom = opts.getCameraZoom;
    this.minZoom = opts.minZoom ?? 14;
    this.texture = makeTreeTexture();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.texture },
        uCanopy: { value: new THREE.Color(Palette.landuse_wood.color) },
        uTrunk: { value: new THREE.Color(TRUNK_COLOR) },
        uWidth: { value: TREE_WIDTH_M },
        uHeight: { value: TREE_HEIGHT_M }
      },
      vertexShader: TREE_VERT,
      fragmentShader: TREE_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthTest: true,
      depthWrite: true
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

  /** @returns true if the zoom gate flipped tree visibility this frame. */
  update(_dt: number): boolean {
    const shouldShow = this.getCameraZoom() >= this.minZoom;
    if (shouldShow === this.shown) return false;
    this.shown = shouldShow;
    for (const m of this.meshes) m.visible = shouldShow;
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
varying vec2 vUv;
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
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

const TREE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uCanopy;
uniform vec3 uTrunk;
varying vec2 vUv;
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
}
`;

/**
 * Draw a stylized tree onto a 128×192 canvas, encoding everything the shader
 * needs into channels rather than final colour: alpha = silhouette, red = a
 * top-lit shading ramp, blue = region mask (0 canopy, 1 trunk). The actual
 * canopy/trunk colours come from theme uniforms at draw time.
 */
function makeTreeTexture(): THREE.Texture {
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
  // crown is lit top → bottom. blue = 0 (canopy region).
  const cg = ctx.createLinearGradient(0, 6, 0, 135);
  cg.addColorStop(0, 'rgb(255,255,0)');
  cg.addColorStop(1, 'rgb(110,110,0)');
  ctx.fillStyle = cg;
  const blobs: Array<[number, number, number]> = [
    [64, 62, 46],
    [40, 82, 34],
    [88, 82, 34],
    [64, 96, 42],
    [46, 50, 26],
    [82, 50, 26]
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
