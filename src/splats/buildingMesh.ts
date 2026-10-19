/**
 * Buildings as textured meshes (`splats.buildingMeshes`, experimental): SplatMap's `{y}.bldg` —
 * the tile's buildings as triangles in the splat tile's own local frame — drawn opaque under one
 * shader instead of tens of thousands of surfels each. Walls take a procedural facade
 * re-implemented here from SplatMap's styles, every pattern fading to its average colour where it
 * shrinks below a pixel (no shimmer); a depth-tested opaque mesh needs no sort, no per-frame
 * regeneration and no workers.
 *
 * Houses (facade program 0) keep the roof structure the roof analysis found — gable, hip and shed
 * planes, carried past the walls as eaves and rakes with fascia boards (version 3) — and are laid
 * with roofing along each plane: asphalt shingle courses, standing-seam metal, clay barrel tile or
 * a membrane (SplatMap picks it from the measured, dehazed roof colour), tinted by that colour and
 * by the photograph's own detail (its high-pass), with a darker ridge cap; the underside of an
 * overhang is a soffit. Walls are lap siding (boards shading the one below), brick in running
 * bond, stucco or a stone veneer base over a foundation strip; windows have frames, sills, a
 * meeting rail, colonial grilles on some houses, shutters where the style has them, glass with the
 * sky and some curtains; the street wall gets a panelled garage door where the driveway meets it
 * and a front door beside it; walls darken at the ground and under the eaves.
 *
 * City buildings (programs 1-3): 1 punched masonry (limestone, granite, brick: courses, a stone
 * base, a window per bay and floor under a lintel), 2 a glass curtain wall (mullions, a spandrel at
 * every floor, the sky mirrored in the glass, each pane a little different) and 3 ribbon windows
 * (bands of glass between concrete or metal spandrels), with a shopfront ground floor, a cornice,
 * a per-building tint, floors that darken towards the street, and roofs from the imagery.
 *
 * Format (SplatMap `splatmap/splat/building_mesh.py`, gzip): "HBDB", u16 version, u16 flags,
 * u32 vertices, u32 buildings, u32 styles, f32 tile size, f32 mercator scale; then per vertex
 * f32[3] position, f32[2] uv (true metres — wall / trim: along, up; roof: along the eave, up the
 * slope), f32[2] size (wall: length, height; roof: the plane's width, slope length), u16 building,
 * u8 kind (1 roof, 2 wall, 3 trim), u8 flags (bit 0: street wall); then per building u8 style,
 * u8[3] roof colour, f32 eave height, u32 seed, f32 garage door centre along the street wall
 * (-1 none), f32 its width, u8 roofing, u8[3] padding; then per style f32[38]. Versions 1 and 2
 * (8- / 12-byte buildings, 25 / 35 style floats, roof uv = imagery) read as version 3: houses'
 * defaults, no garage, shingles, roofs in world-aligned metres.
 */
import * as THREE from 'three';

export const BUILDING_KIND_ROOF = 1;
export const BUILDING_KIND_WALL = 2;
/** Fascia boards along an overhanging roof's edges. */
export const BUILDING_KIND_TRIM = 3;
/** Roofing (SplatMap `ROOF_*`). */
export const BUILDING_ROOF_SHINGLE = 0;
export const BUILDING_ROOF_METAL = 1;
export const BUILDING_ROOF_TILE = 2;
export const BUILDING_ROOF_MEMBRANE = 3;
/** Floats per facade style (SplatMap STYLE_LAYOUT, HBDB version 3). */
export const BUILDING_STYLE_FLOATS = 38;
/** Floats per style in version 1 / 2 files. */
export const BUILDING_STYLE_FLOATS_V1 = 25;
export const BUILDING_STYLE_FLOATS_V2 = 35;
/** RGBA float texels per style row in the shader's style texture (38 floats, padded to 40). */
const STYLE_TEXELS = 10;
const HEADER_BYTES = 28;
/** SplatMap's FacadeStyle defaults for the style floats an older file lacks (from float 25). */
const STYLE_DEFAULT_TAIL = [0, 0.22, 0.23, 0.25, 1.5, 0, 0, 0, 0, 0, 0.35, 0.18, 0.12];
/** Bytes per building record, by version. */
const BUILDING_RECORD: Record<number, number> = { 1: 8, 2: 12, 3: 24 };

export interface BuildingMeshData {
  version: number;
  vertices: number;
  positions: Float32Array;
  /** Per vertex, true metres (see the format). */
  uv: Float32Array;
  wall: Float32Array;
  building: Uint16Array;
  kind: Uint8Array;
  /** Per vertex: bit 0 street wall. */
  flags: Uint8Array;
  buildingStyle: Uint8Array;
  buildingRoof: Uint8Array;
  /** Per building: its own seed (version 1: 0). */
  buildingSeed: Uint32Array;
  /** Per building: eave height, true metres. */
  buildingEave: Float32Array;
  /** Per building: garage door centre along the street wall and width, true metres (-1, 0: none). */
  buildingGarage: Float32Array;
  /** Per building: roofing (BUILDING_ROOF_*). */
  buildingRoofing: Uint8Array;
  /** BUILDING_STYLE_FLOATS per style (older files' padded). */
  styles: Float32Array;
  nStyles: number;
  tileSize: number;
  mercatorScale: number;
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
  const record = BUILDING_RECORD[version];
  if (!record) throw new Error(`unsupported HBDB version ${version}`);
  const n = dv.getUint32(8, true);
  const nb = dv.getUint32(12, true);
  const ns = dv.getUint32(16, true);
  const tileSize = dv.getFloat32(20, true);
  const mercatorScale = dv.getFloat32(24, true) || 1;
  let off = HEADER_BYTES;
  const positions = new Float32Array(buf, off, n * 3); off += n * 12;
  let uv = new Float32Array(buf, off, n * 2); off += n * 8;
  const wall = new Float32Array(buf, off, n * 2); off += n * 8;
  const building = new Uint16Array(buf, off, n); off += n * 2;
  const kind = new Uint8Array(buf, off, n); off += n;
  const flags = new Uint8Array(buf, off, n); off += n;
  const buildingStyle = new Uint8Array(nb);
  const buildingRoof = new Uint8Array(nb * 3);
  const buildingSeed = new Uint32Array(nb);
  const buildingEave = new Float32Array(nb);
  const buildingGarage = new Float32Array(nb * 2).fill(-1);
  const buildingRoofing = new Uint8Array(nb);
  for (let i = 0; i < nb; i++, off += record) {
    buildingStyle[i] = dv.getUint8(off);
    buildingRoof[i * 3] = dv.getUint8(off + 1);
    buildingRoof[i * 3 + 1] = dv.getUint8(off + 2);
    buildingRoof[i * 3 + 2] = dv.getUint8(off + 3);
    buildingEave[i] = dv.getFloat32(off + 4, true);
    if (version >= 2) buildingSeed[i] = dv.getUint32(off + 8, true);
    buildingGarage[i * 2 + 1] = 0;
    if (version >= 3) {
      buildingGarage[i * 2] = dv.getFloat32(off + 12, true);
      buildingGarage[i * 2 + 1] = dv.getFloat32(off + 16, true);
      buildingRoofing[i] = dv.getUint8(off + 20);
    }
  }
  const have = version === 1 ? BUILDING_STYLE_FLOATS_V1 : version === 2 ? BUILDING_STYLE_FLOATS_V2 : BUILDING_STYLE_FLOATS;
  let styles: Float32Array;
  if (have < BUILDING_STYLE_FLOATS) {
    const old = new Float32Array(buf, off, ns * have);
    styles = new Float32Array(ns * BUILDING_STYLE_FLOATS);
    const tail = STYLE_DEFAULT_TAIL.slice(have - BUILDING_STYLE_FLOATS_V1);
    for (let s = 0; s < ns; s++) {
      styles.set(old.subarray(s * have, (s + 1) * have), s * BUILDING_STYLE_FLOATS);
      styles.set(tail, s * BUILDING_STYLE_FLOATS + have);
    }
  } else {
    styles = new Float32Array(buf, off, ns * BUILDING_STYLE_FLOATS);
  }
  if (version < 3) {
    // roofs carried their imagery coordinates (the shader takes those from the position): give
    // them world-aligned metres for the roofing instead
    uv = uv.slice();
    for (let i = 0; i < n; i++) {
      if (kind[i] !== BUILDING_KIND_ROOF) continue;
      uv[i * 2] = positions[i * 3] / mercatorScale;
      uv[i * 2 + 1] = positions[i * 3 + 1] / mercatorScale;
    }
  }
  return {
    version, vertices: n, positions, uv, wall, building, kind, flags, buildingStyle, buildingRoof,
    buildingSeed, buildingEave, buildingGarage, buildingRoofing, styles, nStyles: ns, tileSize, mercatorScale
  };
}

/** A building's variation, 0..1: from its seed (version 2+), else from its index. */
function seedUnit(seed: number, index: number): number {
  let h = (seed || index + 1) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) & 0xffff) / 0xffff;
}

/** One geometry for the tile: positions in the splat tile's local frame (mercator metres, z up).
 *  `aHouse` = (eave height, garage door centre along this wall or -1, its width, roofing + 8 on
 *  the street wall). */
export function buildingGeometry(d: BuildingMeshData): THREE.BufferGeometry {
  const n = d.vertices;
  const style = new Uint8Array(n);
  const roof = new Uint8Array(n * 3);
  const seed = new Uint16Array(n);
  const house = new Float32Array(n * 4);
  const unit = new Uint16Array(d.buildingStyle.length);
  for (let b = 0; b < unit.length; b++) unit[b] = Math.round(seedUnit(d.buildingSeed[b], b) * 0xffff);
  for (let i = 0; i < n; i++) {
    const b = d.building[i];
    style[i] = Math.min(d.buildingStyle[b], Math.max(0, d.nStyles - 1));
    roof[i * 3] = d.buildingRoof[b * 3];
    roof[i * 3 + 1] = d.buildingRoof[b * 3 + 1];
    roof[i * 3 + 2] = d.buildingRoof[b * 3 + 2];
    seed[i] = unit[b];
    const street = (d.flags[i] & 1) !== 0 && d.kind[i] === BUILDING_KIND_WALL;
    house[i * 4] = d.buildingEave[b];
    house[i * 4 + 1] = street ? d.buildingGarage[b * 2] : -1;
    house[i * 4 + 2] = street ? d.buildingGarage[b * 2 + 1] : 0;
    house[i * 4 + 3] = d.buildingRoofing[b] + (street ? 8 : 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  g.setAttribute('aWall', new THREE.BufferAttribute(d.wall, 2));
  g.setAttribute('aKind', new THREE.BufferAttribute(d.kind, 1));
  g.setAttribute('aStyle', new THREE.BufferAttribute(style, 1));
  g.setAttribute('aRoof', new THREE.BufferAttribute(roof, 3, true));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1, true));
  g.setAttribute('aHouse', new THREE.BufferAttribute(house, 4));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** The style floats that are colours (base, trim, glass, stone, shutter; spandrel; door). */
const STYLE_COLOR_FLOATS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 27, 28, 35, 36, 37];

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
  attribute vec4 aHouse;
  varying vec2 vUv;
  varying vec2 vWall;
  varying float vKind;
  varying float vStyle;
  varying float vSeed;
  varying vec3 vRoof;
  varying vec4 vHouse;
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
    vHouse = aHouse;
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
  varying vec4 vHouse;      // eave height, garage door centre on this wall (-1 none), its width, roofing (+8: street wall)
  varying vec3 vViewPos;
  #include <fog_pars_fragment>

  // One facade style (SplatMap STYLE_LAYOUT, colours linear), read once per fragment: ten texels.
  struct Style {
    vec3 base; vec3 trim; vec3 glass; vec3 stone; vec3 shutter; vec3 span; vec3 door;
    float spacing; float ww; float wh; float sill; float storey; float pitch; float contrast;
    float brick; float stoneBase; float shutters; int program; float mullion; float spandrelH;
    float lobby; float cornice; float refl; float tintVar;
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
    vec4 t9 = texelFetch(uStyleTex, ivec2(9, s), 0);
    Style st;
    st.base = t0.xyz;
    st.trim = vec3(t0.w, t1.xy);
    st.glass = vec3(t1.zw, t2.x);
    st.stone = t2.yzw;
    st.shutter = t3.xyz;
    st.spacing = t3.w;
    st.ww = t4.x; st.wh = t4.y; st.sill = t4.z; st.storey = t4.w;
    st.pitch = t5.x; st.contrast = t5.y; st.brick = t5.z; st.stoneBase = t5.w;
    st.shutters = t6.x;
    st.program = int(t6.y + 0.5);
    st.span = vec3(t6.zw, t7.x);
    st.mullion = t7.y; st.spandrelH = t7.z; st.lobby = t7.w;
    st.cornice = t8.x; st.refl = t8.y; st.tintVar = t8.z;
    st.door = vec3(t8.w, t9.xy);
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

  // How much of a pattern with this period (metres) is resolved at pixel footprint w: 1 = all,
  // 0 = below a pixel (draw its average instead).
  float seen(float period, float w) {
    return 1.0 - smoothstep(0.25, 0.6, w / period);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  // Lap siding: boards p tall; each board's butt laps over the one below and shades its top, and
  // catches the light itself; boards differ a little.
  vec3 lapSiding(vec3 base, float v, float p, float contrast, float w) {
    float f = fract(v / p);
    float k = max(contrast, 0.08);
    float prof = 1.0 - k * (0.35 * f + 1.6 * smoothstep(0.78, 1.0, f));
    float board = 1.0 + 0.05 * (hash12(vec2(floor(v / p), vSeed * 61.0)) - 0.5);
    return base * mix(1.0 - k * 0.35, prof * board, seen(p, w));
  }

  // Brick in running bond: 200 x 67 mm courses, 10 mm mortar joints, every brick its own tone.
  vec3 brickWall(vec3 base, float u, float v, vec2 w) {
    float ch = 0.0667;
    float bl = 0.2;
    float row = floor(v / ch);
    float shift = 0.5 * bl * mod(row, 2.0);
    float id = floor((u + shift) / bl);
    float tone = hash12(vec2(id, row) + vSeed * 13.0);
    vec3 brick = base * mix(1.0, 0.8 + 0.4 * tone, seen(ch, w.y));
    float mortar = max(lines(v, ch, 0.01, w.y), lines(u + shift, bl, 0.01, w.x));
    return mix(brick, vec3(0.33, 0.32, 0.30), mortar * 0.85);
  }

  // Stucco: a trowelled, faintly mottled render.
  vec3 stucco(vec3 base, float u, float v, vec2 w) {
    float n = 0.6 * vnoise(vec2(u, v) * 1.7) + 0.4 * vnoise(vec2(u, v) * 6.0) * seen(0.17, max(w.x, w.y));
    return base * (0.93 + 0.12 * n);
  }

  // A stone veneer: courses of irregular lengths, each stone its own tone, dark joints.
  vec3 stoneVeneer(vec3 base, float u, float v, vec2 w) {
    float ch = 0.28;
    float row = floor(v / ch);
    float len = 0.42 + 0.3 * hash12(vec2(row, 7.0) + vSeed);
    float off = hash12(vec2(row, 3.0) + vSeed) * len;
    float tone = hash12(vec2(floor((u + off) / len), row) + vSeed * 13.0);
    vec3 c = base * mix(1.0, 0.72 + 0.56 * tone, seen(ch, w.y));
    float joint = max(lines(v, ch, 0.025, w.y), lines(u + off, len, 0.025, w.x));
    return mix(c, base * 0.45, joint);
  }

  // A house window in its own coordinates (x from its centre, y from its sill): frame, sashes and
  // meeting rail, a grille on colonial houses, glass with the sky and sometimes curtains, the sill
  // under it, shutters either side. Returns (colour, coverage).
  vec4 houseWindow(Style sty, float x, float y, float ww, float wh, vec2 w, float id, bool grille) {
    float hw = 0.5 * ww;
    float body = inside(x, -hw, hw, w.x) * inside(y, 0.0, wh, w.y);
    float fr = 0.07;
    float glass = inside(x, -hw + fr, hw - fr, w.x) * inside(y, fr, wh - fr, w.y);
    float rail = inside(y, 0.5 * wh - 0.03, 0.5 * wh + 0.03, w.y);
    float bars = grille ? max(lines(x + hw, ww / 3.0, 0.025, w.x), lines(y, wh / 4.0, 0.025, w.y)) : 0.0;
    float up = clamp(y / wh, 0.0, 1.0);
    vec3 pane = mix(sty.glass * 0.22, uSkyColor * (0.35 + 0.4 * up), 0.3 + 0.25 * up);
    float curtain = step(0.66, hash12(vec2(id, 5.0) + vSeed * 3.0)) * (1.0 - inside(x, -0.55 * hw, 0.55 * hw, w.x));
    pane = mix(pane, vec3(0.42, 0.40, 0.36), 0.8 * curtain);
    // the sash is set back in the wall: its head throws a shadow on the glass
    pane *= 1.0 - 0.45 * inside(y, wh - fr - 0.06, wh - fr, w.y) * seen(0.06, w.y);
    vec3 c = mix(sty.trim, pane, glass * (1.0 - rail) * (1.0 - bars));
    float sill = inside(y, -0.07, 0.0, w.y) * inside(x, -hw - 0.05, hw + 0.05, w.x);
    c = mix(c, sty.trim * 1.08, sill * (1.0 - body));
    float cover = max(body, sill);
    if (sty.shutters > 0.5) {
      float sw = 0.42 * ww;
      float shut = inside(abs(x), hw + 0.04, hw + 0.04 + sw, w.x) * inside(y, 0.0, wh, w.y);
      vec3 louvres = sty.shutter * (1.0 - 0.35 * lines(y, 0.07, 0.02, w.y));
      c = mix(c, louvres, shut * (1.0 - body));
      cover = max(cover, shut);
    }
    return vec4(c, cover);
  }

  // The garage door: four sections with a raised panel every ~0.65 m, in a trim frame.
  vec4 garageDoor(Style sty, float x, float y, float gw, vec2 w) {
    float hw = 0.5 * gw;
    float gh = 2.15;
    float sec = gh / 4.0;
    float frame = inside(x, -hw - 0.12, hw + 0.12, w.x) * inside(y, 0.0, gh + 0.12, w.y);
    float door = inside(x, -hw, hw, w.x) * inside(y, 0.0, gh, w.y);
    float cols = max(1.0, floor(gw / 0.65 + 0.5));
    float pw = gw / cols;
    float px = fract((x + hw) / pw);
    float py = fract(y / sec);
    float panelTop = inside(py, 0.76, 0.84, w.y / sec) * inside(px, 0.1, 0.9, w.x / pw);
    float panelBottom = inside(py, 0.16, 0.24, w.y / sec) * inside(px, 0.1, 0.9, w.x / pw);
    vec3 dc = mix(sty.trim, sty.base, 0.2) * 0.96;
    dc *= (1.0 - 0.35 * lines(y, sec, 0.025, w.y)) * (1.0 - 0.14 * panelTop) * (1.0 + 0.06 * panelBottom);
    return vec4(mix(sty.trim, dc, door), frame);
  }

  // The front door: a panel door in the style's colour with a light in its top, in a trim frame.
  vec4 entryDoor(Style sty, float x, float y, vec2 w) {
    float hw = 0.48;
    float dh = 2.1;
    float frame = inside(x, -hw - 0.1, hw + 0.1, w.x) * inside(y, 0.0, dh + 0.1, w.y);
    float door = inside(x, -hw, hw, w.x) * inside(y, 0.0, dh, w.y);
    float lite = inside(x, -hw + 0.16, hw - 0.16, w.x) * inside(y, dh - 0.55, dh - 0.14, w.y);
    vec3 c = mix(sty.trim, sty.door, door);
    return vec4(mix(c, sty.glass * 0.25 + uSkyColor * 0.12, lite), frame);
  }

  // A house wall (program 0, see the module comment). u, v: along / up the wall; L, H: its length
  // and height (a gable end rises above the eave).
  vec3 house(Style sty, float u, float v, float L, float H, vec2 w) {
    float eave = vHouse.x > 0.5 ? vHouse.x : H;
    bool street = vHouse.w > 7.5;
    float gu = vHouse.y;
    float gw = vHouse.z;
    bool garage = street && gu >= 0.0 && gw > 0.5;
    vec3 col;
    if (sty.brick > 0.5) col = brickWall(sty.base, u, v, w);
    else if (sty.pitch > 0.0) col = lapSiding(sty.base, v, sty.pitch, sty.contrast, w.y);
    else col = stucco(sty.base, u, v, w);
    if (sty.brick < 0.5 && sty.pitch > 0.0) {
      // corner boards
      col = mix(col, sty.trim, 1.0 - smoothstep(0.1 - w.x, 0.1 + w.x, min(u, L - u)));
    }
    // a stone base course, and the foundation strip at the ground
    if (sty.stoneBase > 0.0) {
      col = mix(col, stoneVeneer(sty.stone, u, v, w), 1.0 - smoothstep(sty.stoneBase - w.y, sty.stoneBase + w.y, v));
    }
    col = mix(col, vec3(0.30, 0.29, 0.27), 1.0 - smoothstep(0.22 - w.y, 0.22 + w.y, v));
    // the front door: beside the garage, else a third of the way along the street wall
    float doorU = -1.0;
    if (garage) {
      doorU = gu + 0.5 * gw + 1.7;
      if (doorU + 0.7 > L - 0.3) doorU = gu - 0.5 * gw - 1.7;
      if (doorU - 0.7 < 0.3) doorU = -1.0;
    } else if (street && L > 3.5) {
      doorU = clamp(0.35 * L, 1.2, L - 1.2);
    }
    // windows: a row per storey below the eave, sparser on the side and back walls, none where a
    // door is
    float storey = max(sty.storey, 2.4);
    float spacing = max(sty.spacing, 1.2) * (street ? 1.0 : 1.7);
    float ww = clamp(sty.ww, 0.6, 1.4);
    float wh = clamp(sty.wh, 0.9, 1.8);
    float sill = max(sty.sill, 0.6);
    float nSt = max(floor((eave - 0.3) / storey), 1.0);
    float st = floor(v / storey);
    float vin = v - st * storey;
    float nWin = L >= 2.6 ? max(floor((L - 1.0) / spacing), 0.0) : 0.0;
    if (nWin == 0.0 && L >= 4.0) nWin = 1.0;
    float margin = (L - (nWin - 1.0) * spacing) * 0.5;
    float slot = floor((u - margin) / spacing + 0.5);
    float cu = margin + slot * spacing;
    float clear = 1.0;
    if (st < 0.5) {
      if (garage && abs(cu - gu) < 0.5 * (gw + ww) + 0.4) clear = 0.0;
      if (doorU > 0.0 && abs(cu - doorU) < 0.5 * ww + 0.9) clear = 0.0;
    }
    float inSlot = step(0.0, slot) * step(slot, nWin - 1.0) * step(st, nSt - 1.0) * clear;
    bool grille = hash12(vec2(vSeed * 97.0, 3.0)) < 0.45;
    vec4 wn = houseWindow(sty, u - cu, vin - sill, ww, wh, w, slot + st * 17.0, grille);
    float detail = seen(spacing, w.x) * seen(storey, w.y);
    float avgWin = nWin > 0.0 ? clamp((ww / spacing) * (wh / storey), 0.0, 1.0) * step(v, nSt * storey) : 0.0;
    vec3 far = mix(col, mix(sty.trim, sty.glass * 0.25, 0.65), avgWin);
    col = mix(far, mix(col, wn.rgb, wn.a * inSlot), detail);
    float doorsSeen = seen(1.2, max(w.x, w.y));
    if (garage) {
      vec4 gd = garageDoor(sty, u - gu, v, gw, w);
      col = mix(col, gd.rgb, gd.a * doorsSeen);
    }
    if (doorU > 0.0) {
      vec4 ed = entryDoor(sty, u - doorU, v, w);
      col = mix(col, ed.rgb, ed.a * doorsSeen);
    }
    // the contact shadow at the ground, and the eaves' shadow under the roof
    col *= mix(0.72, 1.0, smoothstep(0.0, 0.9, v));
    if (H - eave < 0.25) col *= 1.0 - 0.32 * (1.0 - smoothstep(0.0, 0.75, eave - v));
    return col;
  }

  // Roofing laid along a roof plane: uv (along the eave, up the slope) in metres from its eave, s
  // the plane's (width, slope length). Shingle courses, standing seams, barrel tiles or a
  // membrane, each fading to its average below a pixel, and a darker ridge cap at the top.
  vec3 roofing(int mat, vec3 base, vec2 uv, vec2 s, vec2 w) {
    float tone;
    if (mat == 1) {
      float p = 0.45;
      float rib = lines(uv.x, p, 0.035, w.x);
      float lee = lines(uv.x - 0.035, p, 0.03, w.x);
      tone = mix(1.0, 1.0 + 0.22 * rib - 0.15 * lee, seen(p, w.x));
    } else if (mat == 2) {
      float e = 0.3;
      float p = 0.26;
      float row = floor(uv.y / e);
      float barrel = 0.72 + 0.4 * sin(3.14159 * fract(uv.x / p));
      float course = 1.0 - 0.3 * smoothstep(0.75, 1.0, fract(uv.y / e));
      float g = hash12(vec2(floor(uv.x / p), row) + vSeed);
      tone = mix(0.94, barrel * course * (0.9 + 0.2 * g), seen(e, max(w.x, w.y)));
    } else if (mat == 3) {
      tone = 0.94 + 0.08 * vnoise(uv * 2.0);
    } else {
      // architectural shingles: 143 mm courses, tabs of varying width, each tab its own tone
      float e = 0.143;
      float row = floor(uv.y / e);
      float tw = 0.25 + 0.2 * hash12(vec2(row, 11.0) + vSeed);
      float off = hash12(vec2(row, 3.0) + vSeed) * tw;
      float g = hash12(vec2(floor((uv.x + off) / tw), row) + vSeed * 5.0);
      float course = 1.0 - 0.32 * smoothstep(0.72, 1.0, fract(uv.y / e));
      float gap = lines(uv.x + off, tw, 0.012, w.x);
      tone = mix(0.95, course * (0.86 + 0.28 * g) * (1.0 - 0.45 * gap), seen(e, w.y));
    }
    float ridge = 1.0 - smoothstep(0.22 - w.y, 0.22 + w.y, s.y - uv.y);
    return base * tone * (1.0 - 0.18 * ridge);
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
    vec3 V = normalize(-vViewPos);
    float shade = 0.78 + 0.3 * lambert;                       // SplatMap's baked lambert
    vec3 col;
    Style st = loadStyle(int(vStyle + 0.5));
    if (vKind < 1.5) {
      vec3 roof = pow(vRoof, vec3(2.2));
      vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
      if (!gl_FrontFacing) {
        // the underside of an overhang: a soffit in the trim colour, out of the sun
        col = st.trim * 0.8;
        shade = 0.62;
      } else if (dot(n, up) > 0.985) {
        // a flat roof: the photograph is the best roof there is (plant, gravel, membranes)
        col = uHasImagery > 0.5 ? mix(roof, texture2D(uImagery, vTileUv).rgb, uRoofDetail) : roof;
      } else {
        // a pitched roof: its roofing, in the measured colour, with the photograph's own detail
        if (uHasImagery > 0.5) {
          vec3 img = texture2D(uImagery, vTileUv).rgb;
          vec3 blur = textureLod(uImagery, vTileUv, 3.0).rgb;
          float lum = dot(blur, vec3(0.299, 0.587, 0.114));
          float hp = dot(img - blur, vec3(0.299, 0.587, 0.114)) / max(lum, 0.05);
          roof *= clamp(1.0 + 0.55 * uRoofDetail * hp, 0.7, 1.3);
        }
        int mat = int(mod(vHouse.w, 8.0) + 0.5);
        col = roofing(mat, roof, vUv, vWall, fwidth(vUv));
        shade = 0.55 + 0.6 * lambert;
        if (mat == 1) {
          // standing seam catches the sun
          shade += 0.45 * pow(max(dot(reflect(-sun, n), V), 0.0), 24.0);
        }
      }
    } else if (vKind > 2.5) {
      // fascia boards along the roof's edges
      col = st.trim * 0.95;
      shade = 0.6 + 0.5 * lambert;
    } else {
      vec2 fw = fwidth(vUv);
      if (st.program == 0) {
        col = house(st, vUv.x, vUv.y, vWall.x, vWall.y, fw);
        shade = 0.6 + 0.55 * lambert;                         // a house's sides read in the sun
      } else {
        float fres = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 2.0);
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
