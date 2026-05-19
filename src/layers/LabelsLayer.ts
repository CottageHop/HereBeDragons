import * as THREE from 'three';
import { Layer } from './Layer.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
import { LabelKind, type StreetLabelData } from '../tiles/worker/extractors/labels.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';

/**
 * Three.js layer index reserved for label objects (sprites + street meshes).
 * Composer disables this layer during the normal-pass render so labels don't
 * register as normal-discontinuity edges (which would draw a sketch outline
 * around the whole label as a rectangular box).
 */
export const LABEL_THREE_LAYER = 1;

/** Per-kind style for place-name labels. Visual dimensions match the previous
 *  sprite-based path so swapping the underlying implementation doesn't change
 *  the apparent text size. */
interface PlaceStyle {
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  letterSpacing: number;
  /** Extra screen-pixel padding around the label bbox for collision tests. */
  collisionPadding: number;
}

const PLACE_STYLES: Record<LabelKind, PlaceStyle> = {
  [LabelKind.Region]: {
    fontSize: 64, fontWeight: '700', fontFamily: 'system-ui, sans-serif',
    color: '#2a2018', strokeColor: '#ffffff', strokeWidth: 6,
    letterSpacing: 4, collisionPadding: 16
  },
  [LabelKind.City]: {
    fontSize: 48, fontWeight: '700', fontFamily: 'system-ui, sans-serif',
    color: '#2a2018', strokeColor: '#ffffff', strokeWidth: 5,
    letterSpacing: 2, collisionPadding: 12
  },
  [LabelKind.Macrohood]: {
    fontSize: 32, fontWeight: '600', fontFamily: 'system-ui, sans-serif',
    color: '#3a302a', strokeColor: '#ffffff', strokeWidth: 4,
    letterSpacing: 1, collisionPadding: 10
  },
  [LabelKind.Neighbourhood]: {
    fontSize: 24, fontWeight: '500', fontFamily: 'system-ui, sans-serif',
    color: '#4a4036', strokeColor: '#ffffff', strokeWidth: 3,
    letterSpacing: 0, collisionPadding: 8
  },
  [LabelKind.Business]: {
    fontSize: 20, fontWeight: '500', fontFamily: 'system-ui, sans-serif',
    color: '#4a4036', strokeColor: '#ffffff', strokeWidth: 2,
    letterSpacing: 0, collisionPadding: 6
  },
  [LabelKind.Street]: {
    // Street labels render curved-along-road, NOT as place sprites. This entry
    // exists only so the record type-checks; street rendering uses its own
    // STREET_STYLES table below.
    fontSize: 18, fontWeight: '500', fontFamily: 'system-ui, sans-serif',
    color: '#3a302a', strokeColor: '#ffffff', strokeWidth: 2,
    letterSpacing: 0, collisionPadding: 4
  }
};

export interface LabelsLayerOptions {
  /** Current camera logical zoom (used for min_zoom filtering). */
  getCameraZoom: () => number;
  /** Camera reference for world→screen projection during collision. */
  camera: THREE.PerspectiveCamera;
  /** Current viewport size for sprite bbox computation. */
  getViewport: () => { width: number; height: number };
}

/** Per-weight style for street labels (curved along road polylines). */
interface StreetStyle {
  fontSize: number;
  fontWeight: string;
  fontFamily: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  /** Glyph height in world meters (so labels scale with the road). */
  worldHeight: number;
  /** Extra spacing between glyphs in world meters. */
  letterSpacingWorld: number;
}

const STREET_STYLES: StreetStyle[] = [
  // weight 0: major/highway — big, bold
  {
    fontSize: 40, fontWeight: '700', fontFamily: 'system-ui, sans-serif',
    color: '#1c1812', strokeColor: '#ffffff', strokeWidth: 4,
    worldHeight: 11, letterSpacingWorld: 0
  },
  // weight 1: minor / residential — smaller
  {
    fontSize: 28, fontWeight: '600', fontFamily: 'system-ui, sans-serif',
    color: '#2a2620', strokeColor: '#ffffff', strokeWidth: 3,
    worldHeight: 7, letterSpacingWorld: 0
  }
];

interface AtlasGlyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Full quad pixel dimensions (includes glyph padding). */
  pixelWidth: number;
  pixelHeight: number;
  /** Pen advance to the next char, without padding. */
  advancePixels: number;
  /** World-space dimensions for street-label use (derived from worldHeight). */
  widthWorld: number;
  heightWorld: number;
  advanceWorld: number;
}

interface FontAtlas {
  texture: THREE.CanvasTexture;
  /** Keys: `street:${weight}:${char}` and `place:${kind}:${char}`. */
  glyphs: Map<string, AtlasGlyph>;
}

/** Y altitude for street label meshes — slightly above the road ribbons. */
const STREET_LABEL_Y = 0.5;

interface PlacedRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Default elevation (meters) used to compute the place-label depth value.
 * Labels are screen-positioned at ground level (y = 0) but DEPTH-tested as if
 * at this elevation — buildings shorter than this clear them, buildings
 * taller occlude them. 500 m clears everything but supertall skyscrapers
 * (Burj Khalifa class outliers); raise if you need labels to survive those.
 */
const DEFAULT_PLACE_DEPTH_ELEVATION = 500;

/**
 * Custom shader material for place labels. Two anchor points per vertex:
 *
 *   - **Screen position** comes from projecting (mesh.x, 0, mesh.z) — labels
 *     stay pinned to the ground location regardless of camera tilt. Without
 *     this, raising the depth anchor for occlusion would also drift labels
 *     upward on screen (a 500 m anchor projects ~290 px above the actual
 *     place at typical map tilt).
 *
 *   - **Depth** is the NDC z of (mesh.x, uDepthElevation, mesh.z) — labels
 *     fail the depth test only against geometry above that elevation. So an
 *     elevation of 500 m means buildings up to 500 m pass behind the label
 *     while taller ones occlude it.
 *
 * Per-corner `pixelOffset.xy * (2 / viewport) * clipW` is the standard
 * trick to add a screen-pixel shift that survives the perspective divide
 * unchanged — keeps glyphs the same size in pixels regardless of distance.
 */
const PLACE_VERT = /* glsl */ `
attribute vec2 pixelOffset;
uniform vec2 uViewport;
uniform float uDepthElevation;
uniform float uVisualElevation;

varying vec2 vUv;

void main() {
  // World anchor — only XZ from the mesh, Y forced for each role.
  float anchorX = modelMatrix[3].x;
  float anchorZ = modelMatrix[3].z;

  // Screen projection from uVisualElevation (m above ground). 0 keeps labels
  // pinned to the place's ground position with zero drift on tilted cameras.
  // Raise it (50–300 m typical) to make labels float visually above the
  // skyline — useful for keeping city labels readable above tall buildings.
  vec4 clipGround = projectionMatrix * viewMatrix * vec4(anchorX, uVisualElevation, anchorZ, 1.0);
  // Depth projection from a SEPARATE elevation anchor — drives the depth
  // test only. Decouples "where the label is drawn" from "what occludes it".
  vec4 clipDepth  = projectionMatrix * viewMatrix * vec4(anchorX, uDepthElevation, anchorZ, 1.0);

  vec2 pxToClip = vec2(2.0 / max(uViewport.x, 1.0), 2.0 / max(uViewport.y, 1.0));
  vec4 pos = clipGround;
  pos.xy += pixelOffset * pxToClip * pos.w;
  // Override Z so the rasterizer derives depth from clipDepth, not clipGround.
  // We must scale by pos.w (not clipDepth.w) because the perspective divide
  // that turns gl_Position.z into NDC z divides by gl_Position.w. Net result
  // after the divide: ndc.z = clipDepth.z / clipDepth.w, exactly the NDC the
  // depth anchor would have produced on its own.
  pos.z = (clipDepth.z / clipDepth.w) * pos.w;
  gl_Position = pos;

  vUv = uv;
}
`;

const PLACE_FRAG = /* glsl */ `
precision mediump float;

uniform sampler2D uAtlas;
varying vec2 vUv;

void main() {
  vec4 c = texture2D(uAtlas, vUv);
  // The atlas already bakes in stroke + fill colors per kind, so we just
  // forward the texel. Discard fully-transparent pixels so depthTest:false
  // labels behind buildings don't bleed white halos when the source canvas
  // pre-multiplies alpha unexpectedly.
  if (c.a < 0.01) discard;
  gl_FragColor = c;
}
`;

/**
 * Place-name labels with min_zoom filtering and screen-space greedy collision
 * avoidance.
 *
 * Renders each label as a small Mesh (one quad per glyph) sized in SCREEN
 * PIXELS via a custom vertex shader — the entire layer uses a single shared
 * atlas texture, so a tile with 50 labels costs 1 texture and 50 small
 * draw calls instead of 50 textures + 50 draw calls.
 *
 * Each frame:
 *  1. Project every mesh's world anchor into screen space.
 *  2. Filter out anything past `min_zoom`, off-screen, or behind the camera.
 *  3. Compute the mesh's screen-pixel AABB from the precomputed totalWidth ×
 *     fontHeight (no per-frame measurement — those are cached per label).
 *  4. Sort all candidates: lower kind enum first (Region > City > Macrohood >
 *     Neighbourhood > Business), then by priority (population for places,
 *     POI sort_key derivative). Tiebreaker order = "draw the more important
 *     label first".
 *  5. Greedily place: walk sorted candidates, accept each whose bbox doesn't
 *     overlap an already-placed one; otherwise hide it.
 *
 * O(n × k) where k is the number of placed labels (typically 20–50). Cheap
 * enough to run every frame for a few hundred candidates.
 */
export class LabelsLayer extends Layer {
  readonly name: LayerName = 'labels';
  private builtGroups = new Set<THREE.Group>();
  private readonly opts: LabelsLayerOptions;
  private projector = new THREE.Vector3();

  /**
   * Shared font atlas — one canvas texture containing every glyph for every
   * style (place kinds + street weights). Built once at construction.
   */
  private fontAtlas: FontAtlas;
  /** MeshBasicMaterial for street labels (world-space sized, baked atlas). */
  private streetMaterial: THREE.MeshBasicMaterial;
  /** ShaderMaterial for place labels — pixel-offset positioning. */
  private placeMaterial: THREE.ShaderMaterial;

  constructor(materials: StylizedMaterials, opts: LabelsLayerOptions) {
    super(materials);
    this.opts = opts;
    this.fontAtlas = buildFontAtlas(STREET_STYLES, PLACE_STYLES);
    this.streetMaterial = new THREE.MeshBasicMaterial({
      map: this.fontAtlas.texture,
      transparent: true,
      // Buildings (opaque) write depth → labels behind them get depth-rejected.
      depthTest: true,
      // Don't write into the depth texture — otherwise OutlinePass would draw
      // spurious rings around every glyph.
      depthWrite: false,
      toneMapped: false,
      // Don't fade with scene fog — labels need to read at any distance.
      fog: false
    });
    this.placeMaterial = new THREE.ShaderMaterial({
      vertexShader: PLACE_VERT,
      fragmentShader: PLACE_FRAG,
      uniforms: {
        uAtlas: { value: this.fontAtlas.texture },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uDepthElevation: { value: DEFAULT_PLACE_DEPTH_ELEVATION },
        // Default 75 m lifts place-name labels comfortably above typical
        // mid-rise rooftops so city / region labels read above the skyline
        // even on the `'low'` quality tier where there's no outline pass
        // to make text pop. Override per-map via `options.labelHeight` or
        // the studio "Height" slider; depth occlusion is decoupled (see
        // uDepthElevation).
        uVisualElevation: { value: 75 }
      },
      // Test (but don't write) depth. The shader writes the depth value as
      // if the label were at uDepthElevation rather than ground level, so the
      // label is occluded only by geometry taller than that — typical houses
      // (~6 m) and mid-rise buildings pass behind labels, supertall buildings
      // occlude them. Each label is occluded as a whole (every glyph shares
      // the depth-anchor's depth) so there's never a partially-cut label.
      depthTest: true,
      depthWrite: false,
      transparent: true,
      // Custom-shader output is already in the right colorspace — three.js's
      // automatic tone map would darken it.
      toneMapped: false
    });
  }

  build(geometry: LayerGeometry): THREE.Object3D {
    const group = new THREE.Group();
    group.name = 'labels';

    // --- Point labels (places + POIs) -------------------------------------
    const positions = geometry.positions;
    const kinds = (geometry.attributes?.kind as Uint8Array) ?? new Uint8Array(0);
    const minZooms = (geometry.attributes?.minZoom as Uint8Array) ?? new Uint8Array(0);
    const priorities = (geometry.attributes?.priority as Uint32Array) ?? new Uint32Array(0);
    const texts = (geometry.metadata?.texts as string[]) ?? [];

    const count = positions.length / 3;
    for (let i = 0; i < count; i++) {
      const text = texts[i];
      if (!text) continue;
      const kind = (kinds[i] ?? LabelKind.Neighbourhood) as LabelKind;
      const minZoom = minZooms[i] ?? 0;
      const priority = priorities[i] ?? 0;

      const mesh = this.makePlaceLabel(text, kind);
      if (!mesh) continue;
      mesh.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      mesh.userData.minZoom = minZoom;
      mesh.userData.kind = kind;
      mesh.userData.priority = priority;
      mesh.visible = false; // collision pass on the next frame will reveal it
      group.add(mesh);
    }

    // --- Street labels (curved along polylines) ---------------------------
    const streets = (geometry.metadata?.streets as StreetLabelData[] | undefined) ?? [];
    const byMinZoom = new Map<number, StreetLabelData[]>();
    for (const s of streets) {
      let list = byMinZoom.get(s.minZoom);
      if (!list) {
        list = [];
        byMinZoom.set(s.minZoom, list);
      }
      list.push(s);
    }
    for (const [minZoom, list] of byMinZoom) {
      const mesh = this.buildStreetMesh(list);
      if (!mesh) continue;
      mesh.userData.kind = LabelKind.Street;
      mesh.userData.minZoom = minZoom;
      mesh.visible = false;
      group.add(mesh);
    }

    this.builtGroups.add(group);
    // Tag the whole subtree onto the labels-only THREE layer. Composer
    // disables this layer for the normal pass so the OutlinePass doesn't
    // draw a rectangular outline around each label's quad bounds.
    group.traverse((obj) => {
      obj.layers.set(LABEL_THREE_LAYER);
    });
    return group;
  }

  update(_dt: number): void {
    const cameraZoom = this.opts.getCameraZoom();
    const viewport = this.opts.getViewport();
    const camera = this.opts.camera;

    // Keep the shader's viewport uniform in sync — used to convert per-vertex
    // pixel offsets into clip-space offsets. A stale value here makes place
    // labels appear stretched/compressed after a window resize.
    const u = this.placeMaterial.uniforms.uViewport.value as THREE.Vector2;
    u.set(viewport.width, viewport.height);

    interface Candidate {
      mesh: THREE.Mesh;
      kind: LabelKind;
      priority: number;
      rect: PlacedRect;
    }
    const candidates: Candidate[] = [];

    for (const group of this.builtGroups) {
      if (!group.parent) {
        this.builtGroups.delete(group);
        continue;
      }
      for (const child of group.children) {
        // Street-label sub-groups: hidden as a whole by min_zoom; skip the
        // sprite-collision logic for them. The character meshes inside follow
        // the road curve, so they don't need screen-space placement.
        if (child.userData.kind === LabelKind.Street) {
          const minZoom = child.userData.minZoom as number;
          child.visible = cameraZoom >= minZoom;
          continue;
        }

        const mesh = child as THREE.Mesh;
        const minZoom = mesh.userData.minZoom as number;
        if (cameraZoom < minZoom) {
          mesh.visible = false;
          continue;
        }

        // World → NDC. NDC z > 1 means behind far plane; z < -1 means behind near.
        this.projector.copy(mesh.position).project(camera);
        if (this.projector.z < -1 || this.projector.z > 1) {
          mesh.visible = false;
          continue;
        }

        const screenX = (this.projector.x * 0.5 + 0.5) * viewport.width;
        const screenY = (1 - (this.projector.y * 0.5 + 0.5)) * viewport.height;

        // Cull when fully off-screen.
        if (screenX < -viewport.width || screenX > viewport.width * 2 ||
            screenY < -viewport.height || screenY > viewport.height * 2) {
          mesh.visible = false;
          continue;
        }

        // Use the precomputed pixel size (cached on the mesh at build time)
        // rather than projecting the mesh bounds — labels are pixel-anchored,
        // so their screen extent is the same regardless of camera distance.
        const halfPxW = (mesh.userData.pixelWidth as number) * 0.5 +
          (mesh.userData.collisionPadding as number);
        const halfPxH = (mesh.userData.pixelHeight as number) * 0.5 +
          (mesh.userData.collisionPadding as number);

        candidates.push({
          mesh,
          kind: mesh.userData.kind as LabelKind,
          priority: mesh.userData.priority as number,
          rect: {
            minX: screenX - halfPxW,
            maxX: screenX + halfPxW,
            minY: screenY - halfPxH,
            maxY: screenY + halfPxH
          }
        });
      }
    }

    // Sort by importance: lower kind enum first, then higher priority.
    candidates.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind - b.kind;
      return b.priority - a.priority;
    });

    // Greedy placement.
    const placed: PlacedRect[] = [];
    for (const c of candidates) {
      let collides = false;
      for (const p of placed) {
        if (
          c.rect.maxX < p.minX || c.rect.minX > p.maxX ||
          c.rect.maxY < p.minY || c.rect.minY > p.maxY
        ) {
          continue; // disjoint
        }
        collides = true;
        break;
      }
      if (collides) {
        c.mesh.visible = false;
      } else {
        c.mesh.visible = true;
        placed.push(c.rect);
      }
    }
  }

  dispose(): void {
    this.fontAtlas.texture.dispose();
    this.streetMaterial.dispose();
    this.placeMaterial.dispose();
    this.builtGroups.clear();
  }

  /**
   * Set the world-meter elevation used for the SCREEN projection of place
   * labels (Region / City / Macrohood / Neighbourhood / Business). 0 pins
   * labels to the ground over the place's actual coords; raising it lifts
   * them visually above tall buildings (with some screen drift on tilted
   * cameras — labels project from the higher Y so they appear above where
   * the place actually sits). The depth-test elevation is unaffected; see
   * `setPlaceLabelDepthElevation`.
   */
  setPlaceLabelElevation(meters: number): void {
    this.placeMaterial.uniforms.uVisualElevation.value = Math.max(0, meters);
  }

  getPlaceLabelElevation(): number {
    return this.placeMaterial.uniforms.uVisualElevation.value as number;
  }

  /**
   * Build a single place-label Mesh: one quad per character, all sharing the
   * atlas texture + the screen-pixel-offset shader material. Each glyph quad
   * is anchored on the mesh origin (mesh.position carries the world anchor)
   * and offset in screen pixels by per-corner attributes.
   *
   * Returns null when the text contains no atlas-resident characters.
   */
  private makePlaceLabel(text: string, kind: LabelKind): THREE.Mesh | null {
    const styleKey = `place:${kind}:`;
    const style = PLACE_STYLES[kind];
    // Pre-measure: skip unknown characters (non-ASCII the atlas didn't include).
    const glyphs: AtlasGlyph[] = [];
    let totalAdvance = 0;
    for (const ch of text) {
      const g = this.fontAtlas.glyphs.get(styleKey + ch);
      if (!g) continue;
      glyphs.push(g);
      totalAdvance += g.advancePixels;
    }
    if (glyphs.length === 0) return null;
    // Letter-spacing widens the layout without changing per-glyph advance —
    // mirrors the canvas spec's `letterSpacing` attribute on 2D contexts that
    // support it, and keeps adjacent glyphs from visually merging.
    totalAdvance += style.letterSpacing * Math.max(0, glyphs.length - 1);

    const positions: number[] = [];
    const pixelOffsets: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertexCursor = 0;
    let cursorPx = -totalAdvance * 0.5;
    // All glyph quads share the same pixel height (the largest of the row in
    // the atlas) — using the per-glyph height directly would jitter the
    // baseline across chars with different ascender/descender extents.
    const maxGlyphHeight = glyphs.reduce((m, g) => Math.max(m, g.pixelHeight), 0);
    const halfH = maxGlyphHeight * 0.5;

    for (const g of glyphs) {
      const charCenter = cursorPx + g.advancePixels * 0.5;
      const halfW = g.pixelWidth * 0.5;
      // Position (anchor) is identical for every vertex: the mesh.position
      // (set after construction) carries the world XYZ.
      for (let i = 0; i < 4; i++) {
        positions.push(0, 0, 0);
      }
      // Corners (SW, SE, NE, NW) — pixel offsets relative to the anchor.
      pixelOffsets.push(charCenter - halfW, -halfH);   // SW
      pixelOffsets.push(charCenter + halfW, -halfH);   // SE
      pixelOffsets.push(charCenter + halfW,  halfH);   // NE
      pixelOffsets.push(charCenter - halfW,  halfH);   // NW
      uvs.push(g.u0, g.v0);  // SW
      uvs.push(g.u1, g.v0);  // SE
      uvs.push(g.u1, g.v1);  // NE
      uvs.push(g.u0, g.v1);  // NW
      const v = vertexCursor;
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      vertexCursor += 4;
      cursorPx += g.advancePixels + style.letterSpacing;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('pixelOffset', new THREE.BufferAttribute(new Float32Array(pixelOffsets), 2));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    // The mesh's "bounding sphere" is tiny (zero-position vertices) — three's
    // frustum cull would otherwise drop the mesh once the camera moves a few
    // meters away, since it doesn't know the pixelOffset attribute is what
    // gives the mesh real extent.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);

    const mesh = new THREE.Mesh(geo, this.placeMaterial);
    // Render after everything else so the depthTest:false material doesn't
    // accidentally render under e.g. tags' DOM overlays.
    mesh.renderOrder = 1000;
    // Cache pixel dimensions for the collision pass — avoids per-frame
    // re-measurement of the same string.
    mesh.userData.pixelWidth = totalAdvance;
    mesh.userData.pixelHeight = maxGlyphHeight;
    mesh.userData.collisionPadding = style.collisionPadding;
    return mesh;
  }

  /**
   * Build ONE merged BufferGeometry containing every character of every
   * street in `streets`. All characters share the font-atlas texture so the
   * whole batch renders in a single draw call. Returns null if no characters
   * end up placed (every label too long for its road, etc.).
   */
  private buildStreetMesh(streets: StreetLabelData[]): THREE.Mesh | null {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertexCursor = 0;

    for (const street of streets) {
      const styleIndex = street.weight;
      const style = STREET_STYLES[styleIndex] ?? STREET_STYLES[1];
      const styleKey = `street:${styleIndex}:`;

      const flat = street.polyline;
      const pts: { x: number; z: number }[] = [];
      for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], z: flat[i + 1] });
      if (pts.length < 2) continue;

      // Reverse if the polyline overall goes west so text reads left-to-right.
      if (pts[pts.length - 1].x < pts[0].x) pts.reverse();

      const cum: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dz = pts[i].z - pts[i - 1].z;
        cum.push(cum[i - 1] + Math.hypot(dx, dz));
      }
      const totalLen = cum[cum.length - 1];

      // Pre-measure total text width.
      let totalAdvanceWorld = 0;
      const glyphs: AtlasGlyph[] = [];
      for (const ch of street.text) {
        const g = this.fontAtlas.glyphs.get(styleKey + ch);
        if (!g) continue; // unknown character (non-ASCII); skip
        glyphs.push(g);
        totalAdvanceWorld += g.advanceWorld + style.letterSpacingWorld;
      }
      totalAdvanceWorld -= style.letterSpacingWorld;
      if (totalAdvanceWorld > totalLen * 0.85) continue;

      let cursorS = (totalLen - totalAdvanceWorld) / 2;

      for (const g of glyphs) {
        const charCenterS = cursorS + g.advanceWorld * 0.5;
        const sample = sampleAtArcLength(pts, cum, charCenterS);

        const tx = sample.tangentX;
        const tz = sample.tangentZ;
        const hx = g.widthWorld * 0.5;
        const hy = g.heightWorld * 0.5;
        const cx = sample.x;
        const cz = sample.z;

        const corners: Array<[number, number, number, number]> = [
          [-hx, -hy, g.u0, g.v0],
          [ hx, -hy, g.u1, g.v0],
          [ hx,  hy, g.u1, g.v1],
          [-hx,  hy, g.u0, g.v1]
        ];
        for (const [lx, ly, u, v] of corners) {
          const wx = cx + lx * tx + ly * tz;
          const wz = cz + lx * tz - ly * tx;
          positions.push(wx, STREET_LABEL_Y, wz);
          uvs.push(u, v);
        }

        const v = vertexCursor;
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
        vertexCursor += 4;

        cursorS += g.advanceWorld + style.letterSpacingWorld;
      }
    }

    if (indices.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

    const mesh = new THREE.Mesh(geo, this.streetMaterial);
    mesh.renderOrder = 500;
    // Frustum culling on this merged geometry is risky because its bounding
    // box can be empty / wrong when the merge spans many far-apart roads.
    // Cheap enough to always draw; the GPU's depth test does the real culling.
    mesh.frustumCulled = false;
    return mesh;
  }
}

/**
 * Sample the (x, z) world position and unit tangent on the polyline at the
 * given arc-length `s`. Uses linear interpolation within the segment that
 * contains `s`. Falls back to the polyline endpoints for out-of-range values.
 */
function sampleAtArcLength(
  pts: { x: number; z: number }[],
  cum: number[],
  s: number
): { x: number; z: number; tangentX: number; tangentZ: number } {
  if (s <= cum[0]) {
    const a = pts[0];
    const b = pts[1] ?? pts[0];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: a.x, z: a.z, tangentX: dx / len, tangentZ: dz / len };
  }
  const total = cum[cum.length - 1];
  if (s >= total) {
    const a = pts[pts.length - 2] ?? pts[pts.length - 1];
    const b = pts[pts.length - 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: b.x, z: b.z, tangentX: dx / len, tangentZ: dz / len };
  }
  let i = 1;
  while (i < cum.length && cum[i] < s) i++;
  const segStart = cum[i - 1];
  const segLen = cum[i] - segStart;
  const tParam = segLen > 0 ? (s - segStart) / segLen : 0;
  const a = pts[i - 1];
  const b = pts[i];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return {
    x: a.x + dx * tParam,
    z: a.z + dz * tParam,
    tangentX: dx / len,
    tangentZ: dz / len
  };
}

/**
 * Build a single canvas texture containing every printable-ASCII glyph for
 * every street style AND every place-kind style. Each glyph gets a unique
 * key in the returned map so the same atlas serves both rendering paths
 * (street labels read it as world-space-sized geometry; place labels read
 * it as screen-pixel-anchored geometry).
 *
 * Layout: simple shelf packer. Glyphs are measured first, packed into rows,
 * then rendered. Width is capped at MAX_WIDTH so the atlas fits comfortably
 * inside the typical max-texture-size limit (4096 on every device we care
 * about).
 */
function buildFontAtlas(
  streetStyles: StreetStyle[],
  placeStyles: Record<LabelKind, PlaceStyle>
): FontAtlas {
  // 1024 px wide is enough for every style at every printable-ASCII char —
  // it just wraps onto more rows for fonts that didn't fit in fewer. Doubling
  // to 2048 quadruples GPU texture memory (4× at DPR 2) for no measured packing
  // benefit, so stay at 1024.
  const MAX_WIDTH = 1024;
  const PADDING = 2;

  interface PlacedGlyph {
    char: string;
    /** Lookup key for the returned glyph map. */
    key: string;
    /** Reference back to either a StreetStyle or PlaceStyle, used at paint time. */
    fontSpec: string;
    fillColor: string;
    strokeColor: string;
    strokeWidth: number;
    /** World-space metrics for street glyphs; zeros for place glyphs. */
    worldHeight: number;
    pixelWidth: number;
    pixelHeight: number;
    advanceWidth: number;
    x: number;
    y: number;
  }

  const placed: PlacedGlyph[] = [];
  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d');
  if (!mctx) throw new Error('2d context unavailable');

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  const packStyle = (
    keyPrefix: string,
    fontSize: number,
    fontWeight: string,
    fontFamily: string,
    color: string,
    strokeColor: string,
    strokeWidth: number,
    worldHeight: number
  ): void => {
    const fontSpec = `${fontWeight} ${fontSize}px ${fontFamily}`;
    mctx.font = fontSpec;
    const padX = fontSize * 0.18;
    const padY = fontSize * 0.25;
    const glyphPixelHeight = Math.ceil(fontSize * 1.4 + padY * 2);
    for (let cc = 0x20; cc <= 0x7E; cc++) {
      const ch = String.fromCharCode(cc);
      const m = mctx.measureText(ch);
      const pixelWidth = Math.ceil(m.width + padX * 2);
      if (cursorX + pixelWidth + PADDING > MAX_WIDTH) {
        cursorX = 0;
        cursorY += rowHeight + PADDING;
        rowHeight = 0;
      }
      placed.push({
        char: ch,
        key: keyPrefix + ch,
        fontSpec,
        fillColor: color,
        strokeColor,
        strokeWidth,
        worldHeight,
        pixelWidth,
        pixelHeight: glyphPixelHeight,
        advanceWidth: m.width,
        x: cursorX,
        y: cursorY
      });
      cursorX += pixelWidth + PADDING;
      if (glyphPixelHeight > rowHeight) rowHeight = glyphPixelHeight;
    }
  };

  // Street styles first (existing pixel layout, world-scaled when rendered).
  for (let s = 0; s < streetStyles.length; s++) {
    const sd = streetStyles[s];
    packStyle(
      `street:${s}:`,
      sd.fontSize, sd.fontWeight, sd.fontFamily,
      sd.color, sd.strokeColor, sd.strokeWidth,
      sd.worldHeight
    );
  }
  // Then every place kind. `worldHeight` is unused for place glyphs (they're
  // sized in screen pixels at render time) — left as 0 for clarity.
  for (const kindStr of Object.keys(placeStyles)) {
    const kind = Number(kindStr) as LabelKind;
    const ps = placeStyles[kind];
    packStyle(
      `place:${kind}:`,
      ps.fontSize, ps.fontWeight, ps.fontFamily,
      ps.color, ps.strokeColor, ps.strokeWidth,
      0
    );
  }

  const atlasWidth = MAX_WIDTH;
  const atlasHeight = cursorY + rowHeight;

  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(atlasWidth * dpr);
  canvas.height = Math.ceil(atlasHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.scale(dpr, dpr);

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';

  for (const p of placed) {
    ctx.font = p.fontSpec;
    ctx.lineWidth = p.strokeWidth * 2;
    ctx.strokeStyle = p.strokeColor;
    ctx.fillStyle = p.fillColor;
    const cx = p.x + p.pixelWidth / 2;
    const cy = p.y + p.pixelHeight / 2;
    ctx.strokeText(p.char, cx, cy);
    ctx.fillText(p.char, cx, cy);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.flipY = true;
  texture.needsUpdate = true;

  // Build the lookup map. UVs assume flipY=true (texture v=0 corresponds to
  // canvas bottom, v=1 to top).
  const glyphs = new Map<string, AtlasGlyph>();
  for (const p of placed) {
    // World metrics are only meaningful for street glyphs (worldHeight > 0);
    // place glyphs leave them at zero — the place shader doesn't read them.
    const worldScale = p.worldHeight > 0 ? p.worldHeight / p.pixelHeight : 0;
    glyphs.set(p.key, {
      u0: p.x / atlasWidth,
      v0: 1 - (p.y + p.pixelHeight) / atlasHeight,
      u1: (p.x + p.pixelWidth) / atlasWidth,
      v1: 1 - p.y / atlasHeight,
      pixelWidth: p.pixelWidth,
      pixelHeight: p.pixelHeight,
      advancePixels: p.advanceWidth,
      widthWorld: p.pixelWidth * worldScale,
      heightWorld: p.worldHeight,
      advanceWorld: p.advanceWidth * worldScale
    });
  }

  return { texture, glyphs };
}
