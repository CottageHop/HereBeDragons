import * as THREE from 'three';
import { Layer } from './Layer.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';

/** Own render layer so the composer's normal/outline pass can skip the signs. */
export const SIGNS_THREE_LAYER = 7;

/** Banner footprint in metres — a tall, narrow nobori. */
const SIGN_WIDTH_M = 1.5;
const SIGN_HEIGHT_M = 4.0;
/** Must match SIGN_VARIANTS in the signs extractor. */
const VARIANTS = 4;
const WORDS = ['ラーメン', '寿司', '茶屋', 'うどん'];
const BANNER_COLORS = ['#c0392b', '#2c5f7c', '#3a6b35', '#caa23a'];

export interface SignsLayerOptions {
  getCameraZoom: () => number;
  /** Signs render at this camera zoom and above. Default 15 (read up close). */
  minZoom?: number;
}

/**
 * Sparse Japanese shop-sign banners, rendered as upright billboard nobori. The
 * signs extractor places a handful of ground points per tile in front of
 * buildings; this layer grows each into a tall narrow banner facing the camera
 * and picks one of a few vertical-text words from a shared canvas atlas by the
 * per-sign `variant`. Kept sparse + zoom-gated so they read as the occasional
 * storefront, not clutter.
 */
export class SignsLayer extends Layer {
  readonly name: LayerName = 'signs';
  private readonly getCameraZoom: () => number;
  private minZoom: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.Texture;
  private readonly meshes = new Set<THREE.Mesh>();
  private shown = true;

  constructor(materials: StylizedMaterials, opts: SignsLayerOptions) {
    super(materials);
    this.getCameraZoom = opts.getCameraZoom;
    this.minZoom = opts.minZoom ?? 15;
    this.texture = makeSignAtlas();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uMap: { value: this.texture },
        uWidth: { value: SIGN_WIDTH_M },
        uHeight: { value: SIGN_HEIGHT_M },
        uVariants: { value: VARIANTS },
        // Banners with rank ≥ uDensity are culled in the vertex shader, so this
        // thins the over-emitted candidate set at runtime (0 = none, 1 = all).
        uDensity: { value: 0.5 }
      },
      vertexShader: SIGN_VERT,
      fragmentShader: SIGN_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      fog: true
    });
  }

  build(geometry: LayerGeometry): THREE.Object3D {
    const count = geometry.positions.length / 3;
    if (count === 0) return new THREE.Group();

    const geo = new THREE.InstancedBufferGeometry();
    // Unit quad: x centred [-0.5, 0.5], y grows up [0, 1].
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3)
    );
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(geometry.positions, 3));
    const variant = (geometry.attributes?.variant as Float32Array | undefined) ?? new Float32Array(count);
    geo.setAttribute('aVariant', new THREE.InstancedBufferAttribute(variant, 1));
    const rank = (geometry.attributes?.rank as Float32Array | undefined) ?? new Float32Array(count);
    geo.setAttribute('aRank', new THREE.InstancedBufferAttribute(rank, 1));
    geo.instanceCount = count;

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.visible = this.shown;
    mesh.layers.set(SIGNS_THREE_LAYER);

    this.meshes.add(mesh);
    const cleanup = (): void => {
      this.meshes.delete(mesh);
      geo.removeEventListener('dispose', cleanup);
    };
    geo.addEventListener('dispose', cleanup);
    return mesh;
  }

  /** Banner density 0..1 — thins the over-emitted candidate set (0 = none). */
  setDensity(density: number): void {
    this.material.uniforms.uDensity.value = Math.max(0, Math.min(1, density));
  }

  getDensity(): number {
    return this.material.uniforms.uDensity.value as number;
  }

  /** Camera zoom at/above which signs appear. */
  setMinZoom(zoom: number): void {
    this.minZoom = zoom;
  }

  getMinZoom(): number {
    return this.minZoom;
  }

  /** @returns true if the zoom gate flipped sign visibility this frame. */
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

const SIGN_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aVariant;
attribute float aRank;
uniform float uWidth;
uniform float uHeight;
uniform float uDensity;
varying vec2 vUv;
varying float vVar;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vVar = aVariant;
  // Density cull: drop candidate banners whose rank is above the threshold by
  // pushing the vertex off-screen (the triangle clips away, no fragments).
  if (aRank > uDensity) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 worldBase = (modelMatrix * vec4(aOffset, 1.0)).xyz;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float downness = clamp(-camFwd.y, 0.0, 1.0);
  float lay = smoothstep(0.45, 0.95, downness);
  vec3 right = normalize(vec3(camRight.x, 0.0, camRight.z));
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), camUp, lay));
  vec3 worldPos = worldBase + right * (position.x * uWidth) + up * (position.y * uHeight);
  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SIGN_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uVariants;
varying vec2 vUv;
varying float vVar;
#include <fog_pars_fragment>
void main() {
  // Pick this sign's cell from the horizontal atlas.
  vec2 uv = vec2((vVar + vUv.x) / uVariants, vUv.y);
  vec4 tex = texture2D(uMap, uv);
  if (tex.a < 0.5) discard;
  gl_FragColor = vec4(tex.rgb, 1.0);
  #include <fog_fragment>
}
`;

/**
 * Draw the banner atlas: VARIANTS cells side by side, each a coloured vertical
 * nobori with a top crossbar and white vertical Japanese text. Alpha is the
 * banner silhouette so the surrounding quad is transparent.
 */
function makeSignAtlas(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture();
  const cellW = 64;
  const cellH = 192;
  const w = cellW * VARIANTS;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = cellH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Texture();
  ctx.clearRect(0, 0, w, cellH);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let v = 0; v < VARIANTS; v++) {
    const ox = v * cellW;
    const cx = ox + cellW / 2;
    // Pole crossbar (dark wood) near the top.
    ctx.fillStyle = '#3a2a1c';
    ctx.fillRect(ox + 12, 14, cellW - 24, 5);
    // Banner body.
    const bx = ox + 20;
    const bw = cellW - 40;
    const by = 20;
    const bh = 158;
    ctx.fillStyle = BANNER_COLORS[v];
    ctx.fillRect(bx, by, bw, bh);
    // A lighter inner border.
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 3, by + 3, bw - 6, bh - 6);
    // Vertical text: one glyph per row, centred.
    const word = WORDS[v];
    ctx.fillStyle = '#fdf6e8';
    ctx.font = 'bold 17px "Hiragino Sans", "Noto Sans JP", sans-serif';
    const top = by + 18;
    const step = (bh - 32) / word.length;
    for (let c = 0; c < word.length; c++) {
      ctx.fillText(word[c], cx, top + step * (c + 0.5));
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; // these are real colours, not masks
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
