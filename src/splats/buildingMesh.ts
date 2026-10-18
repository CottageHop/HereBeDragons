/**
 * Buildings as textured meshes (`splats.buildingMeshes`, experimental): SplatMap's `{y}.bldg` —
 * the tile's buildings as triangles in the splat tile's own local frame — drawn opaque under one
 * shader instead of tens of thousands of surfels each. Roofs take the tile's imagery (they ARE the
 * photograph, seen from above); walls take a procedural facade, the same design SplatMap painted
 * its surfels with (`splatmap.geom.styles.facade_color`), re-implemented here so the windows stay
 * crisp up close and fade to their average colour where they shrink below a pixel (no shimmer).
 * A depth-tested opaque mesh needs no sort, no per-frame regeneration and no workers.
 *
 * Format (SplatMap `splatmap/splat/building_mesh.py`, gzip): "HBDB", u16 version, u16 flags,
 * u32 vertices, u32 buildings, u32 styles, f32 tile size, f32 mercator scale; then per vertex
 * f32[3] position, f32[2] uv (roof: imagery u east / v north; wall: along / up in true metres),
 * f32[2] wall size (true metres; 0 on roofs), u16 building, u8 kind (1 roof, 2 wall), u8 flags;
 * then per building u8 style, u8[3] roof colour, f32 eave height; then per style f32[25].
 */
import * as THREE from 'three';

export const BUILDING_KIND_ROOF = 1;
export const BUILDING_KIND_WALL = 2;
/** Floats per facade style in the file (SplatMap STYLE_LAYOUT). */
export const BUILDING_STYLE_FLOATS = 25;
/** vec4 slots per style in the shader's table (25 floats, padded). */
const STYLE_VEC4 = 7;
/** Styles one tile's table can hold (SplatMap has 11 today). */
export const MAX_BUILDING_STYLES = 24;
const HEADER_BYTES = 28;

export interface BuildingMeshData {
  vertices: number;
  positions: Float32Array;
  uv: Float32Array;
  wall: Float32Array;
  building: Uint16Array;
  kind: Uint8Array;
  buildingStyle: Uint8Array;
  buildingRoof: Uint8Array;
  styles: Float32Array;
  nStyles: number;
  tileSize: number;
}

/** Inflate a gzip-wrapped `.bldg` (the browser's own DecompressionStream). */
export async function inflateBuildingMesh(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export function parseBuildingMesh(buf: ArrayBuffer): BuildingMeshData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'HBDB') throw new Error('not an HBDB building mesh');
  const version = dv.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported HBDB version ${version}`);
  const n = dv.getUint32(8, true);
  const nb = dv.getUint32(12, true);
  const ns = dv.getUint32(16, true);
  const tileSize = dv.getFloat32(20, true);
  let off = HEADER_BYTES;
  const positions = new Float32Array(buf, off, n * 3); off += n * 12;
  const uv = new Float32Array(buf, off, n * 2); off += n * 8;
  const wall = new Float32Array(buf, off, n * 2); off += n * 8;
  const building = new Uint16Array(buf, off, n); off += n * 2;
  const kind = new Uint8Array(buf, off, n); off += n * 2;          // kind, then flags (unused)
  const buildingStyle = new Uint8Array(nb);
  const buildingRoof = new Uint8Array(nb * 3);
  for (let i = 0; i < nb; i++, off += 8) {
    buildingStyle[i] = dv.getUint8(off);
    buildingRoof[i * 3] = dv.getUint8(off + 1);
    buildingRoof[i * 3 + 1] = dv.getUint8(off + 2);
    buildingRoof[i * 3 + 2] = dv.getUint8(off + 3);
  }
  const styles = new Float32Array(buf, off, ns * BUILDING_STYLE_FLOATS);
  return { vertices: n, positions, uv, wall, building, kind, buildingStyle, buildingRoof, styles, nStyles: ns, tileSize };
}

/** One geometry for the tile: positions in the splat tile's local frame (mercator metres, z up). */
export function buildingGeometry(d: BuildingMeshData): THREE.BufferGeometry {
  const n = d.vertices;
  const style = new Uint8Array(n);
  const roof = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const b = d.building[i];
    style[i] = Math.min(d.buildingStyle[b], MAX_BUILDING_STYLES - 1);
    roof[i * 3] = d.buildingRoof[b * 3];
    roof[i * 3 + 1] = d.buildingRoof[b * 3 + 1];
    roof[i * 3 + 2] = d.buildingRoof[b * 3 + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  g.setAttribute('aWall', new THREE.BufferAttribute(d.wall, 2));
  g.setAttribute('aKind', new THREE.BufferAttribute(d.kind, 1));
  g.setAttribute('aStyle', new THREE.BufferAttribute(style, 1));
  g.setAttribute('aRoof', new THREE.BufferAttribute(roof, 3, true));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** The facade style table as vec4s (25 floats per style, padded to 28). */
function styleTable(d: BuildingMeshData): THREE.Vector4[] {
  const out: THREE.Vector4[] = [];
  for (let s = 0; s < MAX_BUILDING_STYLES; s++) {
    for (let k = 0; k < STYLE_VEC4; k++) {
      const v = new THREE.Vector4();
      if (s < d.nStyles) {
        const base = s * BUILDING_STYLE_FLOATS + k * 4;
        const at = (i: number): number => (k * 4 + i < BUILDING_STYLE_FLOATS ? d.styles[base + i] : 0);
        v.set(at(0), at(1), at(2), at(3));
      }
      out.push(v);
    }
  }
  return out;
}

const VERT = /* glsl */ `
  attribute vec2 aWall;
  attribute float aKind;
  attribute float aStyle;
  attribute vec3 aRoof;
  varying vec2 vUv;
  varying vec2 vWall;
  varying float vKind;
  varying float vStyle;
  varying vec3 vRoof;
  varying vec3 vViewPos;
  varying vec2 vTileUv;
  uniform float uTileSize;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vTileUv = position.xy / uTileSize;
    vWall = aWall;
    vKind = aKind;
    vStyle = aStyle;
    vRoof = aRoof;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  #define STYLE_VEC4 ${STYLE_VEC4}
  uniform sampler2D uImagery;
  uniform float uHasImagery;
  uniform vec4 uStyles[${MAX_BUILDING_STYLES * STYLE_VEC4}];
  uniform vec3 uSunDir;
  uniform float uRoofDetail;
  uniform float uLevelFade;
  uniform vec4 uQuad;
  varying vec2 vTileUv;
  varying vec2 vUv;
  varying vec2 vWall;
  varying float vKind;
  varying float vStyle;
  varying vec3 vRoof;
  varying vec3 vViewPos;
  #include <fog_pars_fragment>

  float sf(int s, int i) {
    vec4 v = uStyles[s * STYLE_VEC4 + i / 4];
    int k = i - (i / 4) * 4;
    return k == 0 ? v.x : (k == 1 ? v.y : (k == 2 ? v.z : v.w));
  }
  vec3 sc(int s, int i) { return pow(vec3(sf(s, i), sf(s, i + 1), sf(s, i + 2)), vec3(2.2)); }

  // A box edge in one coordinate, anti-aliased over the pixel footprint w.
  float inside(float x, float lo, float hi, float w) {
    return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
  }

  // SplatMap's facade (splatmap.geom.styles.facade_color): siding / brick lines, a stone base,
  // corner trim and fascia, a window per bay and storey. Each pattern fades to its AVERAGE
  // colour as its period drops below a couple of pixels — a window grid under a pixel shimmers.
  vec3 facade(int s, float u, float v, float L, float H, vec2 fw) {
    vec3 col = sc(s, 0);
    vec3 trim = sc(s, 3);
    vec3 glass = sc(s, 6);
    float spacing = max(sf(s, 15), 0.5);
    float ww = sf(s, 16);
    float wh = sf(s, 17);
    float sill = sf(s, 18);
    float storey = max(sf(s, 19), 1.0);
    float pitch = sf(s, 20);
    float contrast = sf(s, 21);
    if (pitch > 0.0) {
      float line = 1.0 - smoothstep(0.18 - fw.y / pitch, 0.18 + fw.y / pitch, fract(v / pitch));
      float lineDetail = 1.0 - smoothstep(0.25, 0.6, fw.y / pitch);
      col *= 1.0 - contrast * mix(0.18, line, lineDetail);
    }
    float stoneBase = sf(s, 23);
    if (stoneBase > 0.0) {
      col = mix(col, sc(s, 9), 1.0 - smoothstep(stoneBase - fw.y, stoneBase + fw.y, v));
    }
    float nSt = max(floor((H - 0.3) / storey), 1.0);
    float st = floor(v / storey);
    float vin = v - st * storey;
    float nWin = L >= 2.6 ? max(floor((L - 1.0) / spacing), 0.0) : 0.0;
    if (nWin == 0.0 && L >= 4.0) nWin = 1.0;
    float margin = (L - (nWin - 1.0) * spacing) * 0.5;
    float slot = floor((u - margin) / spacing + 0.5);
    float cu = margin + slot * spacing;
    float inSlot = step(0.0, slot) * step(slot, nWin - 1.0) * step(st, nSt - 1.0);
    float win = inside(u - cu, -ww * 0.5, ww * 0.5, fw.x) * inside(vin, sill, sill + wh, fw.y) * inSlot;
    float avgWin = nWin > 0.0 ? clamp((ww / spacing) * (wh / storey), 0.0, 1.0) : 0.0;
    float detail = 1.0 - smoothstep(0.25, 0.6, max(fw.x / spacing, fw.y / storey));
    col = mix(col, glass, mix(avgWin, win, detail));
    float edge = max(1.0 - smoothstep(0.12 - fw.x, 0.12 + fw.x, min(u, L - u)),
                     1.0 - smoothstep(0.18 - fw.y, 0.18 + fw.y, H - v));
    col = mix(col, trim, edge * detail);
    return col;
  }

  float bayer4(vec2 p) {
    ivec2 q = ivec2(mod(p, 4.0));
    int i = q.x + q.y * 4;
    int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    return (float(m[i]) + 0.5) / 16.0;
  }

  void main() {
    // the tile's own fade, and per quadrant (SW, SE, NW, NE) how far a finer child tile has
    // dissolved in over it — a cover tile's buildings give way where the detail has landed
    float q = vTileUv.y >= 0.5 ? (vTileUv.x >= 0.5 ? uQuad.w : uQuad.z) : (vTileUv.x >= 0.5 ? uQuad.y : uQuad.x);
    float fade = min(uLevelFade, 1.0 - q);
    if (fade < 0.999 && fade <= bayer4(gl_FragCoord.xy)) discard;
    vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
    if (n.z < 0.0) n = -n;                                   // towards the camera
    vec3 sun = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
    float shade = 0.78 + 0.3 * max(dot(n, sun), 0.0);         // SplatMap's baked lambert
    vec3 col;
    if (vKind < 1.5) {
      vec3 roof = pow(vRoof, vec3(2.2));
      col = uHasImagery > 0.5 ? mix(roof, texture2D(uImagery, vUv).rgb, uRoofDetail) : roof;
    } else {
      col = facade(int(vStyle + 0.5), vUv.x, vUv.y, vWall.x, vWall.y, fwidth(vUv));
    }
    gl_FragColor = vec4(col * shade, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** World sun direction for the walls' shading: from the south-west, ~50° up (scene: x east, y up, z south). */
export const BUILDING_SUN_DIR = new THREE.Vector3(-0.45, 0.78, 0.43).normalize();

/**
 * One tile's building material. `levelFade`: the tile's ground fade uniform, shared by reference,
 * so the buildings dissolve (dithered — they are opaque) with the tile; `quad`: the tile's
 * per-quadrant child dissolve (the splat modifier's vector, shared), so a cover tile's buildings
 * give way under landed detail exactly like its splats.
 */
export function createBuildingMaterial(
  d: BuildingMeshData,
  levelFade: { value: number } | null = null,
  quad: THREE.Vector4 | null = null
): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uImagery: { value: null },
        uHasImagery: { value: 0 },
        uStyles: { value: styleTable(d) },
        uSunDir: { value: BUILDING_SUN_DIR.clone() },
        uRoofDetail: { value: 0.65 },
        uTileSize: { value: d.tileSize }
      }
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    side: THREE.DoubleSide
  });
  mat.uniforms.uLevelFade = levelFade ?? { value: 1 };
  mat.uniforms.uQuad = { value: quad ?? new THREE.Vector4(0, 0, 0, 0) };
  mat.name = 'hbd-splats:buildings';
  return mat;
}

export function setBuildingImagery(mat: THREE.ShaderMaterial, tex: THREE.Texture | null): void {
  mat.uniforms.uImagery.value = tex;
  mat.uniforms.uHasImagery.value = tex ? 1 : 0;
}
