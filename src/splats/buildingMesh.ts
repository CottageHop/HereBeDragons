/**
 * Buildings as textured meshes (`splats.buildingMeshes`, experimental): SplatMap's `{y}.bldg` —
 * the tile's buildings as triangles in the splat tile's own local frame — drawn opaque under one
 * shader instead of tens of thousands of surfels each. Roofs take the tile's imagery (they ARE the
 * photograph, seen from above); walls take a procedural facade, re-implemented here from
 * SplatMap's styles so the windows stay crisp up close and fade to their average colour where
 * they shrink below a pixel (no shimmer). A depth-tested opaque mesh needs no sort, no per-frame
 * regeneration and no workers.
 *
 * Facades come in programs (SplatMap `FacadeStyle.program`): 0 a house (siding, shutters, the
 * window grid SplatMap painted its surfels with), and three for city buildings — 1 punched
 * masonry (limestone, granite, brick: courses, a stone base, a window per bay and floor under a
 * lintel), 2 a glass curtain wall (mullions, a spandrel at every floor, the sky mirrored in the
 * glass, each pane a little different) and 3 ribbon windows (bands of glass between concrete or
 * metal spandrels). City buildings get a shopfront ground floor, a cornice, a per-building tint
 * and darken towards the street, as a street canyon does.
 *
 * Format (SplatMap `splatmap/splat/building_mesh.py`, gzip): "HBDB", u16 version, u16 flags,
 * u32 vertices, u32 buildings, u32 styles, f32 tile size, f32 mercator scale; then per vertex
 * f32[3] position, f32[2] uv (roof: imagery u east / v north; wall: along / up in true metres),
 * f32[2] wall size (true metres; 0 on roofs), u16 building, u8 kind (1 roof, 2 wall), u8 flags;
 * then per building u8 style, u8[3] roof colour, f32 eave height (version 2: and u32 seed); then
 * per style f32[35] (version 1: f32[25], read as houses).
 */
import * as THREE from 'three';

export const BUILDING_KIND_ROOF = 1;
export const BUILDING_KIND_WALL = 2;
/** Floats per facade style (SplatMap STYLE_LAYOUT, HBDB version 2). */
export const BUILDING_STYLE_FLOATS = 35;
/** Floats per style in a version-1 file (houses only). */
export const BUILDING_STYLE_FLOATS_V1 = 25;
/** RGBA float texels per style row in the shader's style texture (35 floats, padded to 36). */
const STYLE_TEXELS = 9;
const HEADER_BYTES = 28;
/** The version-2 fields of a version-1 style: SplatMap's FacadeStyle defaults (a house). */
const V1_STYLE_TAIL = [0, 0.22, 0.23, 0.25, 1.5, 0, 0, 0, 0, 0];

export interface BuildingMeshData {
  version: number;
  vertices: number;
  positions: Float32Array;
  uv: Float32Array;
  wall: Float32Array;
  building: Uint16Array;
  kind: Uint8Array;
  buildingStyle: Uint8Array;
  buildingRoof: Uint8Array;
  /** Per building: its own seed (version 1: 0). */
  buildingSeed: Uint32Array;
  /** BUILDING_STYLE_FLOATS per style (version 1's padded). */
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
  if (version !== 1 && version !== 2) throw new Error(`unsupported HBDB version ${version}`);
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
  const buildingSeed = new Uint32Array(nb);
  const record = version === 1 ? 8 : 12;
  for (let i = 0; i < nb; i++, off += record) {
    buildingStyle[i] = dv.getUint8(off);
    buildingRoof[i * 3] = dv.getUint8(off + 1);
    buildingRoof[i * 3 + 1] = dv.getUint8(off + 2);
    buildingRoof[i * 3 + 2] = dv.getUint8(off + 3);
    if (version === 2) buildingSeed[i] = dv.getUint32(off + 8, true);
  }
  let styles: Float32Array;
  if (version === 1) {
    const v1 = new Float32Array(buf, off, ns * BUILDING_STYLE_FLOATS_V1);
    styles = new Float32Array(ns * BUILDING_STYLE_FLOATS);
    for (let s = 0; s < ns; s++) {
      styles.set(v1.subarray(s * BUILDING_STYLE_FLOATS_V1, (s + 1) * BUILDING_STYLE_FLOATS_V1), s * BUILDING_STYLE_FLOATS);
      styles.set(V1_STYLE_TAIL, s * BUILDING_STYLE_FLOATS + BUILDING_STYLE_FLOATS_V1);
    }
  } else {
    styles = new Float32Array(buf, off, ns * BUILDING_STYLE_FLOATS);
  }
  return {
    version, vertices: n, positions, uv, wall, building, kind, buildingStyle, buildingRoof, buildingSeed,
    styles, nStyles: ns, tileSize
  };
}

/** A building's variation, 0..1: from its seed (version 2), else from its index. */
function seedUnit(seed: number, index: number): number {
  let h = (seed || index + 1) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) & 0xffff) / 0xffff;
}

/** One geometry for the tile: positions in the splat tile's local frame (mercator metres, z up). */
export function buildingGeometry(d: BuildingMeshData): THREE.BufferGeometry {
  const n = d.vertices;
  const style = new Uint8Array(n);
  const roof = new Uint8Array(n * 3);
  const seed = new Uint16Array(n);
  const unit = new Uint16Array(d.buildingStyle.length);
  for (let b = 0; b < unit.length; b++) unit[b] = Math.round(seedUnit(d.buildingSeed[b], b) * 0xffff);
  for (let i = 0; i < n; i++) {
    const b = d.building[i];
    style[i] = Math.min(d.buildingStyle[b], Math.max(0, d.nStyles - 1));
    roof[i * 3] = d.buildingRoof[b * 3];
    roof[i * 3 + 1] = d.buildingRoof[b * 3 + 1];
    roof[i * 3 + 2] = d.buildingRoof[b * 3 + 2];
    seed[i] = unit[b];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  g.setAttribute('aWall', new THREE.BufferAttribute(d.wall, 2));
  g.setAttribute('aKind', new THREE.BufferAttribute(d.kind, 1));
  g.setAttribute('aStyle', new THREE.BufferAttribute(style, 1));
  g.setAttribute('aRoof', new THREE.BufferAttribute(roof, 3, true));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1, true));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** The style floats that are colours (base, trim, glass, stone, shutter; spandrel). */
const STYLE_COLOR_FLOATS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 27, 28];

/** The facade styles as a float texture, one row per style (STYLE_TEXELS RGBA texels), colours
 *  already linear (SplatMap's are display values) so the shader converts nothing. */
export function buildingStyleTexture(d: BuildingMeshData): THREE.DataTexture {
  const rows = Math.max(1, d.nStyles);
  const data = new Float32Array(rows * STYLE_TEXELS * 4);
  for (let s = 0; s < d.nStyles; s++) {
    const o = s * STYLE_TEXELS * 4;
    data.set(d.styles.subarray(s * BUILDING_STYLE_FLOATS, (s + 1) * BUILDING_STYLE_FLOATS), o);
    for (const i of STYLE_COLOR_FLOATS) data[o + i] = Math.pow(Math.max(0, data[o + i]), 2.2);
  }
  const tex = new THREE.DataTexture(data, STYLE_TEXELS, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const VERT = /* glsl */ `
  attribute vec2 aWall;
  attribute float aKind;
  attribute float aStyle;
  attribute float aSeed;
  attribute vec3 aRoof;
  varying vec2 vUv;
  varying vec2 vWall;
  varying float vKind;
  varying float vStyle;
  varying float vSeed;
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
    vSeed = aSeed;
    vRoof = aRoof;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uImagery;
  uniform float uHasImagery;
  uniform sampler2D uStyleTex;
  uniform vec3 uSunDir;
  uniform vec3 uSkyColor;
  uniform float uRoofDetail;
  uniform float uLevelFade;
  uniform vec4 uQuad;
  varying vec2 vTileUv;
  varying vec2 vUv;
  varying vec2 vWall;
  varying float vKind;
  varying float vStyle;
  varying float vSeed;
  varying vec3 vRoof;
  varying vec3 vViewPos;
  #include <fog_pars_fragment>

  // One facade style (SplatMap STYLE_LAYOUT), read once per fragment: nine texels.
  struct Style {
    vec3 base; vec3 trim; vec3 glass; vec3 stone; vec3 span;
    float spacing; float ww; float wh; float sill; float storey; float pitch; float contrast;
    float brick; float stoneBase; int program; float mullion; float spandrelH; float lobby;
    float cornice; float refl; float tintVar;
  };
  Style loadStyle(int s) {
    vec4 t0 = texelFetch(uStyleTex, ivec2(0, s), 0);
    vec4 t1 = texelFetch(uStyleTex, ivec2(1, s), 0);
    vec4 t2 = texelFetch(uStyleTex, ivec2(2, s), 0);
    vec4 t3 = texelFetch(uStyleTex, ivec2(3, s), 0);
    vec4 t4 = texelFetch(uStyleTex, ivec2(4, s), 0);
    vec4 t5 = texelFetch(uStyleTex, ivec2(5, s), 0);
    vec4 t6 = texelFetch(uStyleTex, ivec2(6, s), 0);
    vec4 t7 = texelFetch(uStyleTex, ivec2(7, s), 0);
    vec4 t8 = texelFetch(uStyleTex, ivec2(8, s), 0);
    Style st;
    st.base = t0.xyz;
    st.trim = vec3(t0.w, t1.xy);
    st.glass = vec3(t1.zw, t2.x);
    st.stone = t2.yzw;
    st.spacing = t3.w;
    st.ww = t4.x; st.wh = t4.y; st.sill = t4.z; st.storey = t4.w;
    st.pitch = t5.x; st.contrast = t5.y; st.brick = t5.z; st.stoneBase = t5.w;
    st.program = int(t6.y + 0.5);
    st.span = vec3(t6.zw, t7.x);
    st.mullion = t7.y; st.spandrelH = t7.z; st.lobby = t7.w;
    st.cornice = t8.x; st.refl = t8.y; st.tintVar = t8.z;
    return st;
  }

  // A box edge in one coordinate, anti-aliased over the pixel footprint w.
  float inside(float x, float lo, float hi, float w) {
    return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
  }

  // Lines lw wide every p (metres), anti-aliased; their average coverage once below a pixel.
  float lines(float x, float p, float lw, float w) {
    float d = abs(fract(x / p + 0.5) - 0.5) * p;
    float l = 1.0 - smoothstep(0.5 * lw - w, 0.5 * lw + w, d);
    return mix(lw / p, l, 1.0 - smoothstep(0.25, 0.6, w / p));
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // A house (program 0): siding / brick lines, a stone base, corner trim and fascia, a window per
  // bay and storey. Each pattern fades to its AVERAGE colour as its period drops below a couple of
  // pixels — a window grid under a pixel shimmers.
  vec3 house(Style sty, float u, float v, float L, float H, vec2 fw) {
    vec3 col = sty.base;
    vec3 trim = sty.trim;
    vec3 glass = sty.glass;
    float spacing = max(sty.spacing, 0.5);
    float ww = sty.ww;
    float wh = sty.wh;
    float sill = sty.sill;
    float storey = max(sty.storey, 1.0);
    float pitch = sty.pitch;
    float contrast = sty.contrast;
    if (pitch > 0.0) {
      float line = 1.0 - smoothstep(0.18 - fw.y / pitch, 0.18 + fw.y / pitch, fract(v / pitch));
      float lineDetail = 1.0 - smoothstep(0.25, 0.6, fw.y / pitch);
      col *= 1.0 - contrast * mix(0.18, line, lineDetail);
    }
    float stoneBase = sty.stoneBase;
    if (stoneBase > 0.0) {
      col = mix(col, sty.stone, 1.0 - smoothstep(stoneBase - fw.y, stoneBase + fw.y, v));
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

  // Glass: its own colour, the sky mirrored more at grazing angles and higher up (a street
  // canyon's glass sees the buildings opposite, a crown's sees sky), each pane a little different.
  vec3 glassCol(vec3 glass, float refl, float pane, float up, float fres) {
    vec3 sky = uSkyColor * (0.55 + 0.45 * up);
    return mix(glass * (0.82 + 0.36 * pane), sky, clamp(refl * (0.3 + 0.7 * fres), 0.0, 0.85));
  }

  // A city building (programs 1-3, see the module comment).
  vec3 city(Style sty, float u, float v, float L, float H, vec2 fw, float fres) {
    int prog = sty.program;
    float tint = 1.0 + sty.tintVar * (2.0 * vSeed - 1.0);
    vec3 base = sty.base * tint;
    vec3 trim = sty.trim;
    vec3 glass = sty.glass;
    vec3 stone = sty.stone;
    vec3 span = sty.span;
    float storey = max(sty.storey, 2.5);
    float lobby = min(sty.lobby, 0.3 * H);
    float cornice = min(sty.cornice, 0.1 * H);
    float refl = sty.refl;
    float up = clamp(v / max(H, 1.0), 0.0, 1.0);
    float floorsSeen = 1.0 - smoothstep(0.25, 0.6, fw.y / storey);
    float vv = v - lobby;
    float fl = floor(vv / storey);
    float vin = vv - fl * storey;
    vec3 col;
    if (prog == 1) {
      // punched masonry: courses, a stone base, a window per bay and floor under a lintel
      col = base;
      if (sty.pitch > 0.0) col *= 1.0 - sty.contrast * lines(v, sty.pitch, 0.3 * sty.pitch, fw.y);
      float sb = sty.stoneBase;
      if (sb > 0.0) col = mix(col, stone * tint, 1.0 - smoothstep(sb - fw.y, sb + fw.y, v));
      float spacing = max(sty.spacing, 0.8);
      float ww = sty.ww;
      float wh = sty.wh;
      float sill = sty.sill;
      float nWin = max(floor((L - 0.8) / spacing), 0.0);
      float margin = (L - (nWin - 1.0) * spacing) * 0.5;
      float slot = floor((u - margin) / spacing + 0.5);
      float cu = margin + slot * spacing;
      float lastFloor = floor((H - lobby - cornice - 0.4) / storey) - 1.0;
      float inSlot = step(0.0, slot) * step(slot, nWin - 1.0) * step(0.0, vv) * step(fl, lastFloor);
      float win = inside(u - cu, -0.5 * ww, 0.5 * ww, fw.x) * inside(vin, sill, sill + wh, fw.y) * inSlot;
      float lintel = inside(u - cu, -0.5 * ww - 0.12, 0.5 * ww + 0.12, fw.x)
                   * inside(vin, sill + wh, sill + wh + 0.22, fw.y) * inSlot;
      float detail = 1.0 - smoothstep(0.25, 0.6, max(fw.x / spacing, fw.y / storey));
      float avgWin = nWin > 0.0 ? clamp((ww / spacing) * (wh / storey), 0.0, 1.0) * step(0.0, vv) : 0.0;
      float pane = hash12(vec2(slot, fl) + vSeed * 131.0);
      col = mix(col, trim, lintel * detail * sty.brick);        // stone lintels in a brick wall
      col = mix(col, glassCol(glass, refl, mix(0.5, pane, detail), up, fres), mix(avgWin, win, detail));
    } else {
      // curtain wall (2) / ribbon windows (3): glass and a spandrel at every floor, mullions
      float sh = clamp(sty.spandrelH, 0.0, storey - 0.5);
      float band = mix(sh / storey, inside(vin, storey - sh, storey + 0.02, fw.y), floorsSeen) * step(0.0, vv);
      float mul = max(sty.mullion, 0.6);
      float m = lines(u, mul, prog == 2 ? 0.07 : 0.1, fw.x);
      float pane = hash12(vec2(floor(u / mul), fl) + vSeed * 131.0);
      vec3 spandrel = prog == 2 ? span : span * tint;
      col = mix(glassCol(glass, refl, mix(0.5, pane, floorsSeen), up, fres), spandrel, band);
      col = mix(col, trim, m * (1.0 - band) * (prog == 2 ? 0.85 : 0.7));
    }
    if (lobby > 0.0 && v < lobby) {
      // the ground floor: shopfront glass between piers, a sign band over it
      float shop = inside(v, 0.15, lobby - 0.7, fw.y) * (1.0 - lines(u, 4.5, 0.8, fw.x));
      vec3 frame = prog == 1 ? stone * tint : trim * 0.5;
      col = mix(frame, glassCol(glass * 0.6, 0.5 * refl, 0.5, 0.0, fres), shop);
    }
    if (cornice > 0.0) {
      // the parapet / cornice and the shadow line under it
      float top = 1.0 - smoothstep(cornice - fw.y, cornice + fw.y, H - v);
      float shadow = inside(H - v, cornice, cornice + 0.3, fw.y) * (1.0 - smoothstep(0.25, 0.6, fw.y / 0.3));
      col *= 1.0 - 0.45 * shadow;
      col = mix(col, prog == 1 ? trim : mix(span, trim, 0.5), top);
    }
    // a street canyon's floors see less sky
    return col * mix(0.62, 1.0, smoothstep(0.0, 40.0, v));
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
    float lambert = max(dot(n, sun), 0.0);
    float shade = 0.78 + 0.3 * lambert;                       // SplatMap's baked lambert
    vec3 col;
    if (vKind < 1.5) {
      vec3 roof = pow(vRoof, vec3(2.2));
      col = uHasImagery > 0.5 ? mix(roof, texture2D(uImagery, vUv).rgb, uRoofDetail) : roof;
    } else {
      Style st = loadStyle(int(vStyle + 0.5));
      vec2 fw = fwidth(vUv);
      if (st.program == 0) {
        col = house(st, vUv.x, vUv.y, vWall.x, vWall.y, fw);
      } else {
        float fres = pow(1.0 - clamp(abs(dot(n, normalize(-vViewPos))), 0.0, 1.0), 2.0);
        col = city(st, vUv.x, vUv.y, vWall.x, vWall.y, fw, fres);
        shade = 0.6 + 0.6 * lambert;                          // a city's sides read in the sun
      }
    }
    gl_FragColor = vec4(col * shade, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** World sun direction for the walls' shading: from the south-west, ~50° up (scene: x east, y up, z south). */
export const BUILDING_SUN_DIR = new THREE.Vector3(-0.45, 0.78, 0.43).normalize();
/** What city glass mirrors: a pale daytime sky (linear RGB). */
export const BUILDING_SKY_COLOR = new THREE.Color(0.45, 0.53, 0.62);

/**
 * One tile's building material. `levelFade`: the tile's ground fade uniform, shared by reference,
 * so the buildings dissolve (dithered — they are opaque) with the tile; `quad`: the tile's
 * per-quadrant child dissolve (the splat modifier's vector, shared), so a cover tile's buildings
 * give way under landed detail exactly like its splats. Free it with `disposeBuildingMaterial`
 * (it owns the style texture).
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
        uStyleTex: { value: null },
        uSunDir: { value: BUILDING_SUN_DIR.clone() },
        uSkyColor: { value: BUILDING_SKY_COLOR.clone() },
        uRoofDetail: { value: 0.65 },
        uTileSize: { value: d.tileSize }
      }
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    side: THREE.DoubleSide
  });
  // after the merge: UniformsUtils.merge clones textures
  mat.uniforms.uStyleTex.value = buildingStyleTexture(d);
  mat.uniforms.uLevelFade = levelFade ?? { value: 1 };
  mat.uniforms.uQuad = { value: quad ?? new THREE.Vector4(0, 0, 0, 0) };
  mat.name = 'hbd-splats:buildings';
  return mat;
}

/** Free a building material and the style texture it owns. */
export function disposeBuildingMaterial(mat: THREE.ShaderMaterial): void {
  (mat.uniforms.uStyleTex?.value as THREE.Texture | null)?.dispose();
  mat.dispose();
}

const DEPTH_FRAG = /* glsl */ `
  uniform float uLevelFade;
  uniform vec4 uQuad;
  varying vec2 vTileUv;
  float bayer4(vec2 p) {
    ivec2 q = ivec2(mod(p, 4.0));
    int i = q.x + q.y * 4;
    int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
    return (float(m[i]) + 0.5) / 16.0;
  }
  void main() {
    float q = vTileUv.y >= 0.5 ? (vTileUv.x >= 0.5 ? uQuad.w : uQuad.z) : (vTileUv.x >= 0.5 ? uQuad.y : uQuad.x);
    float fade = min(uLevelFade, 1.0 - q);
    if (fade < 0.999 && fade <= bayer4(gl_FragCoord.xy)) discard;
    gl_FragColor = vec4(0.0);
  }
`;

/**
 * The depth pre-pass twin of a building material: the same vertices and the same dithered fade,
 * depth only. Drawn first, it leaves the full facade shader one fragment per pixel — in a downtown
 * three or four walls overlap each pixel, and the city facades are the costliest fragments the map
 * draws (measured on an Intel Iris Plus at 2880×1800: ~13 ms a frame, ~0 with the pre-pass). Shares
 * the material's uniforms, so fades move both.
 */
export function createBuildingDepthMaterial(mat: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const depth = new THREE.ShaderMaterial({
    uniforms: mat.uniforms,
    vertexShader: VERT,
    fragmentShader: DEPTH_FRAG,
    side: THREE.DoubleSide,
    colorWrite: false
  });
  depth.name = 'hbd-splats:buildings-depth';
  return depth;
}

export function setBuildingImagery(mat: THREE.ShaderMaterial, tex: THREE.Texture | null): void {
  mat.uniforms.uImagery.value = tex;
  mat.uniforms.uHasImagery.value = tex ? 1 : 0;
}
