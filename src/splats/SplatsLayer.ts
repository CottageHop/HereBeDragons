import * as THREE from 'three';
import type { Projection } from '../core/Projection.js';
import type { CameraView, LayerName } from '../types.js';
import { lonLatToTile, lonLatToTileFractional, tileKey, tileToLonLat } from '../core/TileId.js';
import { logger } from '../util/log.js';
import { EARTH_CIRCUMFERENCE_M } from '../tiles/worker/extractors/shared/mercator.js';
import type { SplatsConfig, SplatsRevealOptions, SplatsStats } from './types.js';
import {
  type ResolvedSplatsOptions,
  effectiveImageryTemplate,
  imageryCandidates,
  imageryIsDerived,
  imageryTemplateFrom,
  resolveSplatsOptions
} from './options.js';
import { enumerateTileWindow, expandTileUrl, splatTileTransform } from './transform.js';
import { cameraFrustum, tileVisible, tileWorldBox } from './cull.js';
import {
  type ViewFrame,
  groundDepthBias,
  lodFallbackOrder,
  type RankCell,
  rankCellsByRelevance,
  selectTileZoom,
  nearEdgeMppFactor,
  selectTileZoomByResolution,
  tileCoverRange,
  tileScreenRelevance,
  viewFocus
} from './lod.js';
import { FrameGovernor } from './governor.js';
import { zoomToDistance } from '../controls/MapCameraController.js';
import {
  type RippleDirection,
  type RippleParams,
  RIPPLE_BACK_C1,
  RIPPLE_RING_AMPLITUDE,
  RIPPLE_RING_PHASE_RATE,
  isRippleFinished,
  resolveRippleParams,
  rippleFrontRadius,
  rippleMaxRadius
} from './ripple.js';
import {
  type AppearKind,
  type FadeTrack,
  LEVEL_FADE_MIN_SCALE,
  TRANSITION_GRACE_MS,
  appearKind,
  childQuadrant,
  createFade,
  fadeProgress,
  fadeRebase,
  fadeToward,
  fadeValue,
  prefetchLevel,
  tilesOverlap,
  transitionAllowance
} from './levelFade.js';
import {
  type LevelFadeUniform,
  type RippleUniforms,
  type UnionUniforms,
  createRippleUniforms,
  createSplatGroundMaterial,
  createUnionUniforms,
  setSplatGroundMap
} from './groundMaterial.js';
import {
  type ResolvedRoundedUnion,
  ROUNDED_UNION_GLSL,
  type UnionPresence,
  unionGrowthElapsed,
  unionPresenceGrowth,
  unionPresenceStay,
  unionSettleMs,
  unionTileValues
} from '../core/roundedUnion.js';
import { MOTION_THIN_LADDER, THIN_GLSL, THIN_RAMP_BAND, clampThinKeep, densityFor } from './thin.js';
import { BACKFACE_GLSL } from './backface.js';
import { approach } from '../core/motion.js';

/**
 * Three.js layer index reserved for Gaussian-splat objects (the per-tile
 * `SplatMesh`es, their imagery ground planes AND the single `SparkRenderer`
 * mesh that actually draws the splats). Composer disables this layer during
 * the normal-pass render so the Sobel outline shader never sees splats —
 * Spark's own shader can't honour the normal override material, and
 * outlining a point cloud looks like noise.
 */
export const SPLAT_THREE_LAYER = 8;

/**
 * Vector basemap layers hidden GLOBALLY while splat tiles are showing (with
 * `hideBasemap: true`; the default `'covered'` cuts the basemap out per
 * region through the coverage field instead — see `SplatCutoutSink`). Everything else — waterways, rails, signs, cars,
 * shrubs… — stays, as does the caller's own `setLayerEnabled` state.
 * `waves` goes with `water`: shoreline foam with no water under it is an
 * artefact, and its per-frame animation would keep the render loop (and with
 * it the full splat rasterisation) running while nothing moves.
 */
export const SPLATS_HIDDEN_BASEMAP_LAYERS: readonly LayerName[] = Object.freeze([
  'buildings',
  'roads',
  'landuse',
  'water',
  'waves',
  'trees',
  'grass',
  'labels'
] as const);

/** Fetch/decode attempts for one tile before it is treated as permanently absent. */
const MAX_TILE_ATTEMPTS = 3;
/** Window radius cap on the 'low' / 'mobile' tiers. */
const LOW_TIER_MAX_RADIUS = 1;
/** Floor for that spacing on the 'low' / 'mobile' tiers, where one sort's
 *  readback stall is a larger share of the frame budget. */
const LOW_TIER_SORT_INTERVAL_MS = 250;
/** Lite (motion-LoD) tile loads at once: they are small, but the full tiles come first. */
const MOTION_LOD_MAX_IN_FLIGHT = 2;
/** The slice of the 2D canvas API the flip test needs (OffscreenCanvas in browsers; faked in tests). */
export interface FlipTestCanvas {
  getContext(type: '2d'): {
    fillStyle: string | CanvasGradient | CanvasPattern;
    fillRect(x: number, y: number, w: number, h: number): void;
    drawImage(image: ImageBitmap, x: number, y: number): void;
    getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
  } | null;
}

/**
 * Does `createImageBitmap(…, { imageOrientation: 'flipY' })` actually flip? Decodes a 1×2 canvas
 * whose top pixel is red and bottom pixel blue, draws the bitmap back and checks that the top is
 * now blue. Pure (the APIs are passed in) so it is unit-tested; see `bitmapFlipSupported`.
 */
export async function detectBitmapFlip(
  create: ((src: FlipTestCanvas, opts: ImageBitmapOptions) => Promise<ImageBitmap>) | undefined,
  makeCanvas: ((w: number, h: number) => FlipTestCanvas) | undefined
): Promise<boolean> {
  try {
    if (!create || !makeCanvas) return false;
    const src = makeCanvas(1, 2);
    const sctx = src.getContext('2d');
    if (!sctx) return false;
    sctx.fillStyle = '#ff0000';
    sctx.fillRect(0, 0, 1, 1);
    sctx.fillStyle = '#0000ff';
    sctx.fillRect(0, 1, 1, 1);
    const bmp = await create(src, { imageOrientation: 'flipY' });
    const dctx = makeCanvas(1, 2).getContext('2d');
    if (!dctx) return false;
    dctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const top = dctx.getImageData(0, 0, 1, 1).data;
    return top[2] > 200 && top[0] < 60; // the top pixel is now the blue one
  } catch {
    return false;
  }
}

/** `detectBitmapFlip` with this page's APIs, run once and cached. False where they are missing.
 *  Logs the path taken once, so a device check is one glance at the console. */
let bitmapFlip: Promise<boolean> | null = null;
export function bitmapFlipSupported(): Promise<boolean> {
  bitmapFlip ??= detectBitmapFlip(
    typeof createImageBitmap === 'function'
      ? (src, opts) => createImageBitmap(src as unknown as ImageBitmapSource, opts)
      : undefined,
    typeof OffscreenCanvas === 'function'
      ? (w, h) => new OffscreenCanvas(w, h) as unknown as FlipTestCanvas
      : undefined
  ).then((ok) => {
    logger.info(ok
      ? 'splat imagery: ImageBitmap uploads (createImageBitmap honours imageOrientation)'
      : 'splat imagery: <img> uploads (createImageBitmap flipY not honoured here)');
    return ok;
  });
  return bitmapFlip;
}

/** Longest the map holds its picture for a motion-LoD swap (see `holdForSwap`), ms. */
const SWAP_HOLD_MAX_MS = 200;
/** Time constant of a governor thinning step while moving, ms (settles in ~3x). */
const THIN_EASE_TAU_MS = 120;
/** Lite → full cross-fade at the start of a detail ramp: full fades in, then lite out, ms. */
const SWAP_FADE_MS = 240;
/** Longest the cross-fade waits for Spark to display the combined set before starting anyway. */
const SWAP_FADE_WAIT_MS = 400;
/** Longest rising detail waits for a depth sort before it is let through regardless, ms. */
const RAMP_SORT_WAIT_MS = 600;
/**
 * Budget ranking hysteresis: a resident tile only gives way to a candidate
 * whose relevance score is better by this factor (plus a little), so an
 * orbiting camera — under which the scores of neighbouring tiles cross over
 * continuously — doesn't swap tiles back and forth.
 */
const EVICT_SCORE_RATIO = 1.5;
const EVICT_SCORE_SLACK = 0.1;
/** View change (bearing°, tilt°, zoom) after which tiles skipped as
 *  over-budget are reconsidered — the ranking they lost under has moved. */
const RERANK_BEARING_DEG = 20;
const RERANK_TILT_DEG = 10;
const RERANK_ZOOM = 0.5;
/** Most tiles held decoded-but-unattached by the prefetch. */
const MAX_PREFETCHED = 2;
/** Imagery ground sits this far (scene metres) above the vector ground. */
const GROUND_LIFT = 0.05;
/**
 * Depth bias per pyramid level for the imagery ground (polygon-offset units,
 * negative = toward the camera). Two levels are coplanar while a level
 * transition cross-fades them; the FINER level wins the depth test, so
 * zooming in shows the detailed tiles growing over the coarse one and zooming
 * out reveals the coarse tile as the detailed ones shrink off it — never a
 * z-fighting shimmer. Polygon offset scales with the depth buffer's own
 * resolution, so it holds at every camera distance (a fixed lift would not).
 */
const GROUND_LEVEL_DEPTH_BIAS = 2;
/** Front radius that means "everything revealed" once a ripple has ended. */
/** Pixel size of a tile's ground image — the resolution the imagery can actually show. */
const SPLAT_GROUND_PX = 1024;
const REVEALED_RADIUS = 1e9;

// ---------------------------------------------------------------------------
// Minimal structural view of the parts of `@sparkjsdev/spark` we touch. Spark
// is an OPTIONAL peer dependency loaded with a dynamic import, so nothing in
// this file (or the public .d.ts) references its types directly.
// ---------------------------------------------------------------------------

/** An opaque node of Spark's `dyno` shader graph. */
export type DynoNode = unknown;

/** A dyno uniform: a graph node whose `.value` we drive from JS. */
export interface DynoUniformLike<V> {
  value: V;
}

/** The slice of Spark's `dyno` namespace the ripple modifier is built from. */
export interface SparkDynoLike {
  Gsplat: unknown;
  dynoBlock(
    inTypes: Record<string, unknown>,
    outTypes: Record<string, unknown>,
    construct: (inputs: Record<string, DynoNode>) => Record<string, DynoNode>
  ): DynoNode;
  /**
   * Raw-GLSL node (Spark's `dyno.Dyno`): the rounded-union mask compiles the
   * same GLSL function as the imagery ground through one of these. Optional —
   * without it the splats stay square (the ground is still masked).
   */
  Dyno?: new (opts: {
    inTypes: Record<string, string>;
    outTypes: Record<string, string>;
    inputs: Record<string, DynoNode>;
    globals?: () => string[];
    statements: (io: { inputs: Record<string, string>; outputs: Record<string, string> }) => string[];
  }) => { outputs: Record<string, DynoNode> };
  dynoFloat(value: number): DynoUniformLike<number>;
  dynoVec2(value: THREE.Vector2): DynoUniformLike<THREE.Vector2>;
  dynoVec3?(value: THREE.Vector3): DynoUniformLike<THREE.Vector3>;
  dynoVec4?(value: THREE.Vector4): DynoUniformLike<THREE.Vector4>;
  dynoConst(type: string, value: number): DynoNode;
  splitGsplat(gsplat: DynoNode): { outputs: Record<string, DynoNode> };
  combineGsplat(parts: { gsplat: DynoNode; scales?: DynoNode; opacity?: DynoNode; flags?: DynoNode }): DynoNode;
  swizzle(a: DynoNode, select: string): DynoNode;
  add(a: DynoNode, b: DynoNode): DynoNode;
  sub(a: DynoNode, b: DynoNode): DynoNode;
  mul(a: DynoNode, b: DynoNode): DynoNode;
  div(a: DynoNode, b: DynoNode): DynoNode;
  length(a: DynoNode): DynoNode;
  abs(a: DynoNode): DynoNode;
  sin(a: DynoNode): DynoNode;
  max(a: DynoNode, b: DynoNode): DynoNode;
  clamp(a: DynoNode, lo: DynoNode, hi: DynoNode): DynoNode;
  lessThan(a: DynoNode, b: DynoNode): DynoNode;
  select(cond: DynoNode, t: DynoNode, f: DynoNode): DynoNode;
}

/** The subset of Spark's `SplatMesh` this layer relies on. */
export interface SparkSplatMeshLike extends THREE.Object3D {
  /** Resolves once the file bytes are decoded and uploaded. */
  initialized: Promise<unknown>;
  numSplats?: number;
  packedSplats?: { numSplats?: number };
  /** Whole-mesh opacity multiplier (Spark picks a change up as a cheap regeneration). */
  opacity?: number;
  /** Per-splat GPU modifier applied in world space (after the placement).
   *  NB: write-only on the real SplatMesh (a setter with no getter). */
  worldModifier?: DynoNode;
  /** Per-splat GPU modifier applied in the mesh's OBJECT space — for a splat
   *  tile that is the tile-local frame (x east, y north, mercator metres
   *  from the SW corner). Write-only, like `worldModifier`. */
  objectModifier?: DynoNode;
  /** Highest spherical-harmonics degree to evaluate (0 = base colour only). */
  maxSh?: number;
  /** Recompile the generator after a modifier change. */
  updateGenerator?(): void;
  /** Bump the version so Spark re-runs the generator on the next frame
   *  (needed when a modifier's UNIFORMS change but the graph doesn't). */
  updateVersion?(): void;
  dispose(): void;
}

export interface SparkSplatMeshOptions {
  fileBytes: ArrayBuffer | Uint8Array;
  fileType?: string;
  fileName?: string;
}

/** The subset of Spark's `SparkRenderer` this layer relies on. */
export interface SparkRendererLike extends THREE.Object3D {
  /** Live-tunable twin of the constructor option. */
  minSortIntervalMs?: number;
  /** Live-tunable too: Spark copies it into its uniforms every frame. */
  maxStdDev?: number;
  /** Multiplies the drawing-buffer size Spark sizes splats from: the composer's internal render
   *  scale when the scene is rendered below canvas resolution (see `setRenderScale`). */
  focalAdjustment?: number;
  /** Generate + start a sort without drawing (the motion-LoD swap hold primes Spark with it). */
  update?(o: { scene: THREE.Object3D; camera: THREE.Camera }): Promise<void>;
  /** Spark's accumulators: `current` is the newest generated set, `display` the one drawn; a
   *  new splat MAPPING (meshes shown or hidden) is drawn only once its first sort has landed. */
  current?: { mappingVersion: number };
  display?: { mappingVersion: number };
  /** A depth sort (readback + worker) is in flight. */
  sorting?: boolean;
  /** When the latest depth sort STARTED (Spark runs one at a time, so a new value means the one
   *  before it has landed). */
  lastSortTime?: number;
  dispose(): void;
}

export interface SparkRendererOptionsLike {
  renderer: THREE.WebGLRenderer;
  onDirty?: () => void;
  /** Gaussian cut-off in standard deviations (Spark default √8). */
  maxStdDev?: number;
  /** Minimum interval between sort passes, ms (Spark default 0). */
  minSortIntervalMs?: number;
  /** Minimum on-screen splat size in pixels for Spark's LoD tree (Spark default 1). */
  lodRenderScale?: number;
  /** Spark's level-of-detail driver (default on). */
  enableLod?: boolean;
}

/** Shape of the (lazily imported) Spark module. */
export interface SparkModule {
  SparkRenderer: new (opts: SparkRendererOptionsLike) => SparkRendererLike;
  SplatMesh: new (opts: SparkSplatMeshOptions) => SparkSplatMeshLike;
  /** Enum of file-type strings (`{ PLY: 'ply', SPZ: 'spz', … }`). */
  SplatFileType?: Record<string, string>;
  /** The dyno shader-graph namespace; absent → reveals fall back to instant. */
  dyno?: SparkDynoLike;
}

/**
 * Where the overlay reports the ground it has taken, for
 * `hideBasemap: 'covered'` — in the map this is the tile-reveal
 * `CoverageField`, whose second texture channel every basemap material
 * samples as an inverse mask.
 */
export interface SplatCutoutSink {
  /** Allocate the field at the cut-out resolution (or release it). */
  setCutoutReserved(on: boolean, finestZoom?: number): void;
  /** 0 = nothing is cut, 1 = the basemap is (labels stay), 2 = labels too. */
  setCutoutMode(mode: 0 | 1 | 2): void;
  /** The resident tiles with the mask values their GPU mask is using
   *  (`fade`: the level cross-dissolve of the tile's ground, default 1). */
  setCutout(
    tiles: ReadonlyArray<{
      z: number; x: number; y: number; g: number; values?: ArrayLike<number>; fade?: number;
    }>,
    feather: number
  ): void;
  /** The ripple front the imagery alpha is multiplied by (scene metres). */
  setCutoutRipple(active: boolean, originX?: number, originZ?: number, radius?: number, width?: number): void;
}

export interface SplatsLayerDeps {
  /** The raw three renderer Spark hooks into for its sort / upload work. */
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Anything that can report the camera's geographic view (the map camera). */
  camera: { getView(): CameraView };
  /** The three camera, for per-frame frustum culling of resident tiles. */
  getCamera?: () => THREE.Camera | null;
  /** Height of the buffer the scene is rendered into, device px (the composer's internal targets
   *  — not the canvas, which may be larger). Default: the renderer's drawing buffer. */
  renderHeightPx?: () => number;
  projection: Projection;
  /** Render-on-demand nudge — tile loads (and Spark's async sort completing)
   *  change the picture without a camera move. */
  onSceneChange?: () => void;
  /** Called with `true` when the first splat tile lands and `false` when the
   *  last one leaves, if `hideBasemap` is on. The map wires this to the
   *  TileManager's per-layer hide. */
  setBasemapHidden?: (hidden: boolean) => void;
  /** `hideBasemap: 'covered'`: receives the overlay's rounded union. */
  cutout?: SplatCutoutSink;
  /** The map's metres-per-pixel at the camera target — `levelSelection: 'resolution'`. */
  getMetersPerPixel?: () => number;
  /** Viewport width / height, for the screen-space tile ranking. */
  getAspect?: () => number;
  /**
   * Compile the ripple modifier's GLSL during the initial tile load instead of on the user's
   * first toggle (see the `prewarm` field). Default `true`; tests that count generator rebuilds
   * turn it off.
   */
  prewarmShaders?: boolean;
  /**
   * Whether the user asked for reduced motion — then level changes swap
   * instantly, whatever `levelFadeMs` says. Defaults to the
   * `prefers-reduced-motion: reduce` media query (false where there is no
   * `matchMedia`). Read at construction, on option changes and at every
   * level switch.
   */
  prefersReducedMotion?: () => boolean;
  /**
   * Override for the Spark import — tests inject a stub so Spark (WASM,
   * WebGL) is never loaded in node. Defaults to `import('@sparkjsdev/spark')`.
   */
  loadSpark?: () => Promise<SparkModule>;
  /**
   * Override for the tile fetch. Resolve `null` for "no tile here" (HTTP 404),
   * reject for a transient failure. Defaults to `fetch` → ArrayBuffer.
   */
  fetchTile?: (url: string) => Promise<ArrayBuffer | null>;
  /**
   * Override for the imagery load. Resolve `null` for "no image". Defaults to
   * `THREE.TextureLoader` (sRGB, mipmapped, max anisotropy).
   */
  loadTexture?: (url: string) => Promise<THREE.Texture | null>;
}

/** Everything one resident splat tile owns. */
interface SplatTile {
  key: string;
  /** Placement node (SW corner, −π/2 about X, uniform cos(originLat) scale). */
  root: THREE.Object3D;
  /** Tile edge length in SCENE units (mercator edge x placement scale) — frustum culling. */
  worldSize: number;
  /** Distance-cutoff fade, 1 = drawn, 0 = fully faded out (see `splatMaxDistance`). */
  distFade: number;
  /** Last level-fade values written, so the distance fade can re-apply them. */
  lastSplatFade: number;
  lastGroundFade: number;
  mesh: SparkSplatMeshLike;
  /** Motion LoD: the same tile from the lite pyramid, drawn instead of `mesh` while the camera
   *  moves (null until loaded, or with no lite pyramid). Shares `mesh`'s modifier graph. */
  lite: SparkSplatMeshLike | null;
  liteState: 'none' | 'loading' | 'ready' | 'missing';
  /** The tile's object-space modifier graph (Spark's setter has no getter). */
  objectModifier: DynoNode | null;
  /** The lite mesh's graph: same tile uniforms, its own thinning inputs (see attachTileModifier). */
  liteModifier: DynoNode | null;
  /** Camera position in the tile's object space, for the density LOD (null without `dynoVec3`);
   *  `camSet` once it holds a real position. */
  camDyno: DynoUniformLike<THREE.Vector3> | null;
  camSet: boolean;
  /** The culling verdict (frustum + distance fade): whether a splat mesh is drawn at all. */
  cullDraw: boolean;
  /** Imagery ground plane (null when imagery is off). */
  ground: THREE.Mesh | null;
  groundMaterial: THREE.ShaderMaterial | null;
  groundTexture: THREE.Texture | null;
  splats: number;
  /** Pyramid level this tile belongs to (its `{z}`). */
  z: number;
  tileX: number;
  tileY: number;
  /** Whether the shared ripple `worldModifier` is attached (tracked here:
   *  Spark's modifier properties are setters with no getter). */
  rippleOn: boolean;
  /** Rounded-union mask uniforms, shared by reference between the ground
   *  material and the splat modifier; null when `roundedUnion` is off. */
  union: UnionUniforms | null;
  /** Spark-side growth uniform (the vec4 weights are shared by reference). */
  unionG: DynoUniformLike<number> | null;
  /** Spark-side feather uniform (mirrors `union.uUnionFeather`). */
  unionFeather: DynoUniformLike<number> | null;
  /** The governor gave this tile up: it is shrinking out of the union and no
   *  longer counts against the budget (nor may it be called back). */
  evicting: boolean;
  /** How the tile was revealed: `'grow'` on new ground, `'dissolve'` over
   *  ground another level was already showing (see `levelFade.ts`). */
  appear: AppearKind;
  /** Level cross-dissolve of the SPLATS (opacity, and scale 0.6 → 1). */
  fade: FadeTrack;
  /** …and of the imagery GROUND (and the vector cut-out under it). Separate
   *  so the ground underneath is never see-through while two levels swap:
   *  an outgoing ground holds at 1 until the incoming one is opaque. */
  groundFade: FadeTrack;
  /** Ground-side uniform of `groundFade` (null without imagery). */
  fadeU: LevelFadeUniform | null;
  /** Spark-side uniforms: the splat fade, and how far each QUADRANT's child
   *  (one level finer) has dissolved in over it — SW, SE, NW, NE. */
  fadeDyno: DynoUniformLike<number> | null;
  quadDyno: DynoUniformLike<THREE.Vector4> | null;
  /** The imagery has landed (or never will): the ground may dissolve in. */
  imageryDone: boolean;
  /** Imagery requested alongside the tile (prefetch / dissolve candidates),
   *  so the ground can dissolve in with the splats; null once handed over. */
  preTexture: Promise<THREE.Texture | null> | null;
  /** Set by `disposeTile` — a late `preTexture` frees itself. */
  disposed: boolean;
  /** The splats were released after the fade-out; only the imagery ground
   *  lingers (in `groundGhosts`) until the level over it is opaque. */
  meshGone: boolean;
}

interface RippleState {
  dir: RippleDirection;
  params: RippleParams;
  startMs: number;
}

/** Scratch for one tile's 16 union values (weights ×8, bridge growths ×8). */
const SCRATCH = new Float64Array(16);

function defaultPrefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

async function defaultFetchTile(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Map a URL template's extension to Spark's `SplatFileType` value. */
function fileTypeFromTemplate(template: string): 'spz' | 'ply' | undefined {
  const m = /\.(spz|ply)(\?|#|$)/i.exec(template);
  return m ? (m[1].toLowerCase() as 'spz' | 'ply') : undefined;
}

// Moved to `options.ts` (pure); re-exported so existing imports keep working.
export { imageryTemplateFrom };

/**
 * Self-contained overlay that streams pre-tiled 3D Gaussian splats and draws
 * them with Spark on top of the vector basemap. Mirrors `ParcelsManager`'s
 * tile-window loop: a square window of tiles around the camera target,
 * nearest-first, capped concurrency, eviction of tiles that drift out of the
 * keep zone, and everything dropped below `minZoom` or on disable.
 *
 * The tiles are a PYRAMID (`minTileZoom` … `maxTileZoom`, every level carrying
 * a similar per-tile splat budget): the ACTIVE level follows the camera zoom
 * (`selectTileZoom`, with hysteresis) and the window is always `radius` tiles
 * of that level, so tiles on screen and resident splats stay roughly constant
 * across zooms. A level change is a CROSS-DISSOLVE, not new ground: the next
 * level's tile under the camera is prefetched as the zoom nears the boundary,
 * lands at its full rounded-union shape and fades in (`levelFadeMs`) while the
 * tile(s) it covers fade out — see `tickLevelFade()` / `isCovered()`. The
 * budget counts both levels, allows one tile's worth of overshoot for the
 * length of a dissolve (`transitionOvershoot`), and gives up old-level tiles
 * first when there is real pressure.
 *
 * Each tile also gets a textured satellite ground plane (`{z}/{x}/{y}.png`)
 * a few centimetres above the vector ground, and while ≥ 1 tile is resident
 * the vector basemap's buildings / roads / landuse / water / trees / grass /
 * labels are hidden (see `SPLATS_HIDDEN_BASEMAP_LAYERS`).
 *
 * Enable / disable can play a "ripple" reveal: an expanding front from an
 * origin, implemented as a per-splat GPU modifier (Spark `worldModifier`
 * built with the `dyno` shader graph) plus the ground material's matching
 * radial alpha — see `ripple.ts` for the maths.
 *
 * The resident tiles are shown as their ROUNDED UNION, not as squares (one
 * tile a circle, two a pill, a 2×2 block a rounded square): a per-tile Spark
 * `objectModifier` plus the ground material's alpha, both compiled from the
 * one GLSL function in `roundedUnion.ts` and driven by the same per-tile
 * uniforms, animated as tiles land and leave — see `tickUnion()`.
 *
 * Independent of the basemap TileManager / decode worker by design — splat
 * tiles are opaque binary blobs handed straight to Spark, and there is no
 * per-layer geometry to extract. Spark itself is imported lazily inside
 * `open()`; if the import fails (peer dep not installed, unsupported browser)
 * the layer logs once and stays inert for the map's lifetime.
 *
 * NOTE: Spark requires exactly ONE `SparkRenderer` in the scene — it is the
 * mesh that actually rasterizes every `SplatMesh` below it. This layer owns
 * that instance; do not add another.
 */
export class SplatsLayer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: { getView(): CameraView };
  private readonly projection: Projection;
  private readonly onSceneChange: () => void;
  private readonly setBasemapHiddenCb: ((hidden: boolean) => void) | null;
  private readonly cutout: SplatCutoutSink | null;
  private readonly getAspect: (() => number) | null;
  private readonly loadSpark: () => Promise<SparkModule>;
  private readonly fetchTile: (url: string) => Promise<ArrayBuffer | null>;
  private readonly loadTexture: (url: string) => Promise<THREE.Texture | null>;
  private readonly clock: () => number;
  private readonly prefersReducedMotion: () => boolean;

  private readonly group: THREE.Group;
  private spark: SparkModule | null = null;
  private sparkRenderer: SparkRendererLike | null = null;
  // The tile source + grid: fixed for a given set of tiles, swapped only by
  // `rebuild()` (which drops every tile first).
  private fileType: 'spz' | 'ply' | undefined;
  private urlTemplate: string;
  /** Lite pyramid for the low tiers (`''` = none); see `activeUrlTemplate()`. */
  private lowTierUrlTemplate: string;
  /** Motion LoD (see setCameraMoving): option, the map's motion signal, what is drawn now,
   *  and lite loads in flight. */
  private motionLod: boolean;
  private cameraMoving = false;
  /** Motion detail from the map (see setMotionDetail): 0 = motion LoD (also the default, for a
   *  caller that only reports camera motion), 1 = full detail. */
  private motionDetail = 0;
  private drawingLite = false;
  private liteInFlight = 0;
  /** Motion thinning: fraction of each tile's splats kept while moving (1 = all), shared by
   *  every tile's modifier graph. Created with the first tile modifier. */
  private thinDyno: DynoUniformLike<number> | null = null;
  /** The same for the LITE meshes (their own graph, so the full set can ramp while the lite set
   *  keeps the governor's thinning during the cross-fade), and the full set's soft band. */
  private liteThinDyno: DynoUniformLike<number> | null = null;
  private thinBandDyno: DynoUniformLike<number> | null = null;
  private zeroBandDyno: DynoUniformLike<number> | null = null;
  /** Cover level (`splats.cover`): the next coarser level is kept resident under the detail
   *  window, outside the budget — see coverZ(). */
  private cover: boolean;
  /** `splats.cullBackFaces`: see `backface.ts`. */
  private cullBackFaces: boolean;
  /** Shared 1/0 uniform of `cullBackFaces` for every tile's modifier. */
  private backfaceDyno: DynoUniformLike<number> | null = null;
  /** Screen-space density LOD (`splats.densityLod`): target spacing in device px (0 = off), the
   *  shared `(focal / target)²` uniform, the camera position it was last synced for, and scratch. */
  private densityLod: number;
  private densityDyno: DynoUniformLike<number> | null = null;
  private readonly lodCamPos = new THREE.Vector3(Number.NaN, 0, 0);
  private readonly lodMat = new THREE.Matrix4();
  private readonly lodSize = new THREE.Vector2();
  /** Motion-LoD swap hold (see `holdForSwap`): when the flip to lite started (null = none),
   *  whether Spark has been primed with the new set, and whether a frame was held for it. */
  private swapHoldSince: number | null = null;
  private swapPrimed = false;
  private swapHeld = false;
  /**
   * Lite → full cross-fade (see tickMotionLod): both meshes drawn, full fading in over the opaque
   * lite set, then lite fading out. `mapping` = Spark's displayed mapping when it began (the fade
   * clock starts once the combined set is on screen), `t0` = that moment (null = still waiting).
   */
  private swapFade: { since: number; mapping: number; t0: number | null } | null = null;
  /**
   * Rising density may not outrun Spark's sort: a splat only draws once a sort has put it in the
   * ordering. `rampSortKeep` = the kept fraction (plus soft band) covered by the last sort that
   * LANDED; `rampSortPending` = the same for the sort in flight; `prevSorting` = last tick's flag.
   */
  private rampSortKeep = 1;
  private rampSortPending: number | null = null;
  private prevSortTime = 0;
  /** When the rising density first had to wait for a sort (failsafe: never wait forever). */
  private rampHeldSince: number | null = null;
  /** Motion-thinning ease state: whether the last sync was mid-gesture, and when it ran. */
  private thinWasMoving = false;
  private lastThinMs = 0;
  /** Ease time constant (THIN_EASE_TAU_MS; 0 snaps — kept as a field so A/B probes can flip it). */
  private thinEaseTauMs = THIN_EASE_TAU_MS;
  private imageryTemplate: string | null;
  /** True when `imageryTemplate` was derived from `urlTemplate` (→ WebP-first candidates). */
  private imageryDerived = true;
  /** Consecutive failures per candidate slot with no success yet: after 3 the slot is skipped,
   *  so a PNG-only tile set doesn't pay a 404 per tile for the WebP twin. */
  private readonly imageryMisses = new Map<string, number>();
  private enabled: boolean;
  /** False on the 'mobile' / 'low' quality tiers — overrides `enabled`. */
  private tierAllowed = true;
  // Everything from here to `union` is live-settable through `applyOptions`
  // (except the union's on / off, which `rebuild()` owns).
  private minZoom: number;
  /** Pyramid bounds + the camera-zoom → level bias (per quality tier). */
  private minTileZoom: number;
  private maxTileZoom: number;
  private lodBias: number;
  private lowTierLodBias: number;
  private radius: number;
  private maxInFlight: number;
  private hideBasemap: boolean | 'covered';
  private keepLabels: boolean;
  /** Frame-time governor: scales the budget / lowers the bias under load. */
  private readonly governor: FrameGovernor;
  /** Resident-splat budgets: `'high'` tier vs `'low'` / `'mobile'`. */
  private maxSplats: number;
  private lowTierMaxSplats: number;
  /** True on the 'low' / 'mobile' tiers → the smaller budget + radius ≤ 1. */
  private lowTier = false;
  private maxStdDev: number;
  private lodRenderScale: number;
  private sortIntervalMs: number;
  /** Level cross-dissolve (see `levelFade.ts`): fade length IN EFFECT (0
   *  under `prefers-reduced-motion`) and as configured, the budget allowance
   *  cap (× the configured budget) and the prefetch band. */
  private levelFadeMs = 0;
  private configuredLevelFadeMs: number;
  private transitionOvershoot: number;
  private prefetchBand: number;
  /** Rounded-union mask (`roundedUnion` option), resolved. Tiles are built
   *  with or without the modifier, so `enabled` only changes in `rebuild()`;
   *  `feather` / `growMs` are live. */
  private readonly union: ResolvedRoundedUnion;

  private opened = false;
  /** In-flight `open()` — a second caller awaits the same import instead of
   *  adding a second SparkRenderer. */
  private opening: Promise<void> | null = null;
  private disposed = false;
  private basemapHidden = false;
  /** `hideBasemap: 'covered'` in effect with ≥ 1 tile resident. */
  private basemapCovered = false;
  /** A tile / imagery landing ran in this `update()` / the one before: the
   *  GPU upload it forces lands in the frames around it, and must not be
   *  mistaken by the governor for the cost of drawing splats. */
  private landedNow = false;
  private landedPrev = false;
  /** The cut-out sink needs the current tiles / mask values pushed. */
  private cutoutDirty = false;
  /** Scratch list handed to the sink (reused between pushes). */
  private readonly cutoutScratch: Array<{
    z: number; x: number; y: number; g: number; fade: number; values?: Float64Array;
  }> = [];

  private readonly tiles = new Map<string, SplatTile>();
  /** key → load token. A stale in-flight load whose token no longer matches
   *  (cleared by `clearTiles`, or superseded) discards its result. */
  private readonly pending = new Map<string, { token: number; z: number }>();
  private loadSeq = 0;
  private readonly missing = new Set<string>();
  /**
   * Consecutive load/decode failures per tile, and the keys that have given up.
   *
   * Without this a permanently broken tile server is retried forever: measured against a host
   * returning corrupt bytes, one camera produced 937 requests and 1878 console warnings in 16
   * seconds — roughly 60 requests per second, per client, for the same handful of tiles, with the
   * console too noisy to read. A 404 already ends in `missing`; a tile that keeps failing to
   * FETCH or DECODE now does too, after `MAX_TILE_ATTEMPTS` tries, and says so once.
   */
  private readonly failures = new Map<string, number>();
  /** Tiles that decoded but didn't fit the budget for the CURRENT centre —
   *  not re-fetched until the centre moves or a resident tile leaves. */
  private readonly overBudget = new Set<string>();
  private inFlight = 0;
  /**
   * Scene mutations that force a GPU upload on the next render — decoded
   * tiles (`applyQueue`) and landed imagery textures (`imageryQueue`).
   * Exactly ONE entry runs per `update()`, tiles before imagery, so a burst
   * of landings never stacks several multi-MB uploads into a single frame
   * (the same per-frame cap the basemap's tile builds use). Each entry
   * re-validates its tile when it runs.
   */
  private readonly applyQueue: Array<() => void> = [];
  private readonly imageryQueue: Array<() => void> = [];
  /** Decoded tiles waiting in `applyQueue` (their splat counts are known and
   *  already count against the budget). */
  private readonly queuedTiles = new Map<string, SplatTile>();
  /** Tiles of the level the camera is ABOUT to switch to, fetched + decoded
   *  ahead of the threshold and never attached to the scene (at most
   *  `MAX_PREFETCHED`). Promoted by `switchLevel`, dropped out of the band. */
  private readonly prefetched = new Map<string, SplatTile>();
  /** Decoded tiles of the ACTIVE level waiting for room: landing them now
   *  would push the overlap past budget + allowance, and the room is on its
   *  way (old-level tiles are dissolving out). Off-scene, retried every tick,
   *  and no new loads start meanwhile — see `commitTile`. */
  private readonly parked = new Map<string, { tile: SplatTile; sinceMs: number }>();
  /** Level being prefetched right now (null outside the band). */
  private prefetchZ: number | null = null;
  /** Imagery grounds whose splats were released after a fade-out: they hold
   *  until the level over them is opaque, then fade (no budget, no mesh). */
  private readonly groundGhosts = new Map<string, SplatTile>();
  /** A level dissolve (or its over-budget overlap) is in progress — the
   *  governor must not read these frames as the cost of the steady state. */
  private levelFading = false;
  /** Clock time the committed splats first exceeded the budget with an old
   *  level still resident (the transition allowance is time-limited). */
  private overSinceMs: number | null = null;
  /** Level the camera zoom asks for (hysteresis state of `selectTileZoom`). */
  private wantedZ: number | null = null;
  /** Level being loaded — `wantedZ` unless that level is missing here (see
   *  `resolveActiveLevel`). Null until the first tick above `minZoom`. */
  private activeZ: number | null = null;
  /** Window centre, as the tile of the ACTIVE level under the camera target. */
  private lastCenterX = 0;
  private lastCenterY = 0;
  private hasCenter = false;
  /** …and as lon / lat, from which any other level's centre is derived. */
  private centerLon = 0;
  private centerLat = 0;
  /** The camera for the screen-space tile ranking (see `tileScreenRelevance`);
   *  `cx` / `cy` is the true camera target, the window centre above is the
   *  `viewFocus` pushed forward from it. */
  private frame: ViewFrame = { cx: 0, cy: 0, dist: 1, bearingDeg: 0, tiltDeg: 0 };
  /** View at which the over-budget skips were last forgotten. */
  private rankedAt = { bearing: 0, tilt: 0, zoom: 0 };
  /** Per-tick cache of the centre tile per level. */
  private readonly centerCache = new Map<number, { x: number; y: number }>();
  /** `renderer.capabilities.getMaxAnisotropy()` is a GL query — cache it. */
  private maxAnisotropy: number | null = null;

  // --- rounded union state ------------------------------------------------
  /** key → presence, for every resident tile plus the fading "ghosts" of
   *  tiles that were dropped at once. */
  private readonly presence = new Map<string, UnionPresence>();
  /** True while any growth / bridge / leave animation is in progress (or a
   *  membership change still has to be written to the uniforms). */
  private unionDirty = false;

  // --- reveal (ripple) state ----------------------------------------------
  private readonly rippleUniforms: RippleUniforms = createRippleUniforms();
  /** Spark-side uniforms mirroring `rippleUniforms` (created with Spark). */
  private rippleDyno: {
    origin: DynoUniformLike<THREE.Vector2>;
    R: DynoUniformLike<number>;
    W: DynoUniformLike<number>;
    time: DynoUniformLike<number>;
    modifier: DynoNode;
  } | null = null;
  private ripple: RippleState | null = null;
  /**
   * Shader pre-warm for the ripple modifier. Spark compiles a `dyno` graph's GLSL the first time
   * a mesh RENDERS with it attached, so the user's first toggle used to pay it mid-animation
   * (measured on an Intel Iris: 186 ms for the first reveal, 76 ms for the first hide; every
   * later toggle 19-42 ms). We pay it during the initial tile load instead, where the user is
   * already waiting: attach the modifier to one resident tile with the front fully open — which
   * the graph resolves to scale 1 / opacity 1, a visual no-op — let it render one frame, detach.
   */
  private prewarm: 'idle' | 'armed' | 'rendering' | 'done' = 'idle';
  private readonly prewarmEnabled: boolean;
  private readonly getMetersPerPixel?: () => number;
  private readonly getCamera?: () => THREE.Camera | null;
  private readonly renderHeightPx?: () => number;
  /** Internal render scale in effect (see setRenderScale). */
  private renderScale = 1;
  private frustumCull: boolean;
  private visibleFirst_: boolean;
  private splatMaxDistance: number;
  private lowTierSplatMaxDistance: number;
  private splatFadeMs: number;
  private lastCullMs = 0;
  private readonly cullCentre = new THREE.Vector3();
  private readonly cullFrustum = new THREE.Frustum();
  private readonly cullBox = new THREE.Box3();
  private levelSelection: 'bias' | 'resolution';
  private resolutionMargin: number;
  private resolutionTiltAware: boolean;
  private prewarmKey: string | null = null;
  /** `setEnabled(false, { reveal: 'ripple' })` keeps the tiles alive until the
   *  out-ripple has collapsed; this flags that deferred teardown. */
  private disablePending = false;

  constructor(deps: SplatsLayerDeps, config: SplatsConfig) {
    this.renderer = deps.renderer;
    this.scene = deps.scene;
    this.camera = deps.camera;
    this.projection = deps.projection;
    this.onSceneChange = deps.onSceneChange ?? (() => {});
    this.setBasemapHiddenCb = deps.setBasemapHidden ?? null;
    this.cutout = deps.cutout ?? null;
    this.getAspect = deps.getAspect ?? null;
    this.loadSpark =
      deps.loadSpark ??
      (async () => (await import('@sparkjsdev/spark')) as unknown as SparkModule);
    this.fetchTile = deps.fetchTile ?? defaultFetchTile;
    this.loadTexture = deps.loadTexture ?? ((url) => this.defaultLoadTexture(url));
    this.prewarmEnabled = deps.prewarmShaders !== false;
    this.getMetersPerPixel = deps.getMetersPerPixel;
    this.getCamera = deps.getCamera;
    this.renderHeightPx = deps.renderHeightPx;
    this.prefersReducedMotion = deps.prefersReducedMotion ?? defaultPrefersReducedMotion;
    this.clock =
      config.clock ??
      (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());

    const o = resolveSplatsOptions(config);
    this.urlTemplate = o.urlTemplate;
    this.lowTierUrlTemplate = o.lowTierUrlTemplate;
    this.motionLod = o.motionLod;
    this.imageryTemplate = effectiveImageryTemplate(o);
    this.imageryDerived = imageryIsDerived(o);
    this.imageryMisses.clear();
    this.enabled = o.enabled;
    this.minZoom = o.minZoom;
    this.minTileZoom = o.minTileZoom;
    this.maxTileZoom = o.maxTileZoom;
    this.lodBias = o.lodBias;
    this.levelSelection = o.levelSelection;
    this.resolutionMargin = o.resolutionMargin;
    this.resolutionTiltAware = o.resolutionTiltAware;
    this.lowTierLodBias = o.lowTierLodBias;
    this.radius = o.radius;
    this.maxInFlight = o.maxInFlight;
    this.hideBasemap = o.hideBasemap;
    this.keepLabels = o.keepLabels;
    this.densityLod = o.densityLod;
    this.cover = o.cover;
    this.cullBackFaces = o.cullBackFaces;
    this.governor = new FrameGovernor({
      targetFrameMs: o.targetFrameMs,
      maxScale: o.budgetGrowth,
      thinLadder: o.motionThin ? [...MOTION_THIN_LADDER] : []
    });
    this.governor.setEnabled(o.governor);
    this.maxSplats = o.maxSplats;
    this.lowTierMaxSplats = o.lowTierMaxSplats;
    this.maxStdDev = o.maxStdDev;
    this.lodRenderScale = o.lodRenderScale;
    this.frustumCull = o.frustumCull;
    this.visibleFirst_ = o.visibleFirst;
    this.splatMaxDistance = o.splatMaxDistance;
    this.lowTierSplatMaxDistance = o.lowTierSplatMaxDistance;
    this.splatFadeMs = o.splatFadeMs;
    this.sortIntervalMs = o.sortIntervalMs;
    this.configuredLevelFadeMs = o.levelFadeMs;
    this.syncLevelFadeMs();
    this.transitionOvershoot = o.transitionOvershoot;
    this.prefetchBand = o.prefetchBand;
    this.fileType = fileTypeFromTemplate(o.urlTemplate);
    this.union = { ...o.roundedUnion };
    this.cutout?.setCutoutReserved(this.hideBasemap === 'covered', this.maxTileZoom);

    this.group = new THREE.Group();
    this.group.name = 'hbd-splats';
    this.group.visible = this.isActive();
    this.scene.add(this.group);
  }

  /**
   * Lazily import Spark and add its renderer mesh to the scene. Safe to call
   * when disabled (the loop just no-ops until enabled). Failure is logged
   * once, not thrown — a missing / broken Spark must never take the basemap
   * down; the layer simply stays inert.
   */
  open(): Promise<void> {
    if (this.opened || this.disposed) return Promise.resolve();
    this.opening ??= this.doOpen().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    try {
      const mod = await this.loadSpark();
      if (this.disposed) return;
      if (typeof mod?.SparkRenderer !== 'function' || typeof mod?.SplatMesh !== 'function') {
        throw new Error('module does not export SparkRenderer / SplatMesh');
      }
      this.spark = mod;
      const sr = new mod.SparkRenderer({
        renderer: this.renderer,
        // Spark sorts splats asynchronously (worker); when a sort or LoD
        // update lands the picture changes without a camera move.
        onDirty: () => this.onSceneChange(),
        // Every sort pass costs a GPU→CPU depth readback that blocks the main
        // thread until the GPU has drained (∝ resident splats), then a 4 B ×
        // N ordering-texture upload. Spacing the passes out bounds how much
        // of a continuous camera move is spent inside those stalls.
        minSortIntervalMs: this.currentSortIntervalMs(),
        maxStdDev: this.maxStdDev,
        // Do not draw splats smaller than this many pixels — see `lodRenderScale`.
        lodRenderScale: this.lodRenderScale,
        // Our tiles are plain .spz with no LoD trees (the pyramid IS the level of detail).
        // Spark's LoD driver would still run on every update and hand an empty job to a
        // dedicated LoD worker each frame — a thread woken per frame for nothing.
        enableLod: false
      });
      sr.name = 'hbd-splats:spark-renderer';
      sr.layers.set(SPLAT_THREE_LAYER);
      this.sparkRenderer = sr;
      sr.focalAdjustment = this.renderScale;
      this.scene.add(sr);
      this.opened = true;
    } catch (err) {
      logger.warn(
        'splats overlay disabled — failed to load @sparkjsdev/spark:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Whether the overlay is in effect (user-enabled AND allowed by the tier). */
  isEnabled(): boolean {
    return this.isActive();
  }

  /**
   * Turn the overlay on or off. With `reveal: 'ripple'` the transition plays
   * the expanding-front animation from `origin` (default: the view centre);
   * on disable the front collapses first and the tiles are unloaded once it
   * reaches the origin. Default `reveal` is `'none'` (instant).
   */
  setEnabled(on: boolean, opts: SplatsRevealOptions = {}): void {
    const ripple = opts.reveal === 'ripple';
    if (on) {
      if (this.enabled && !this.disablePending) {
        // Already on: `reveal: 'ripple'` replays the reveal over the resident
        // tiles (a "where are the splats?" flourish); otherwise a no-op.
        if (ripple && this.tierAllowed && this.canRipple()) this.startRipple('in', opts);
        return;
      }
      this.enabled = true;
      this.disablePending = false;
      if (!this.tierAllowed) return;
      this.group.visible = true;
      if (ripple && this.canRipple()) this.startRipple('in', opts);
      else this.endRipple();
      this.onSceneChange();
      return;
    }
    if (!this.enabled) return;
    this.enabled = false;
    // Animate out only if there is something on screen to collapse.
    if (ripple && this.tierAllowed && this.tiles.size > 0 && this.canRipple()) {
      this.disablePending = true;
      this.startRipple('out', opts);
      return;
    }
    this.disablePending = false;
    this.endRipple();
    this.applyActive();
  }

  /**
   * Quality-tier hook. `'high'` runs the full `maxSplats` budget and window;
   * `'low'` / `'mobile'` switch to the `lowTierMaxSplats` budget with the
   * window capped at radius 1 and the tile level picked with `lowTierLodBias`
   * (one level coarser by default), and force the overlay off when that
   * budget is 0. Shrinking the budget evicts farthest-first at once; the user's
   * `enabled` choice is never touched, so a swap back to `'high'` restores
   * everything.
   */
  setQualityTier(tier: 'low' | 'mobile' | 'high'): void {
    const low = tier !== 'high';
    if (low === this.lowTier && this.tierAllowed === (!low || this.lowTierMaxSplats > 0)) return;
    const before = this.activeUrlTemplate();
    this.lowTier = low;
    if (this.lowTierUrlTemplate && this.activeUrlTemplate() !== before) {
      // The tiers read different pyramids: what is resident came from the other one.
      // Drop it like any change of tile set; the next update() refills from the right source.
      this.clearTiles();
      this.missing.clear();
      this.failures.clear();
      this.hasCenter = false;
      this.wantedZ = null;
      this.activeZ = null;
    }
    // Another budget, another bias, another render pipeline: what the
    // governor learnt about the old tier does not carry over.
    this.governor.reset();
    if (this.sparkRenderer) this.sparkRenderer.minSortIntervalMs = this.currentSortIntervalMs();
    this.setTierAllowed(!low || this.lowTierMaxSplats > 0);
    if (this.isActive() && this.enforceBudget()) {
      this.syncBasemapHidden();
      this.onSceneChange();
    }
  }

  /** The tile template in effect: the lite pyramid on the low tiers when one is configured. */
  activeUrlTemplate(): string {
    return this.lowTier && this.lowTierUrlTemplate ? this.lowTierUrlTemplate : this.urlTemplate;
  }

  /**
   * Hard gate under the tier hook: `false` forces the overlay off without
   * touching the user's `enabled` choice. (`setQualityTier` drives this for
   * the `lowTierMaxSplats: 0` case; it stays public for tests / embedders.)
   */
  setTierAllowed(allowed: boolean): void {
    if (allowed === this.tierAllowed) return;
    this.tierAllowed = allowed;
    if (!allowed) {
      // A deferred (rippling-out) disable can't wait for a GPU we just lost.
      this.disablePending = false;
      this.endRipple();
    }
    this.applyActive();
  }

  setMinZoom(z: number): void {
    this.minZoom = z;
  }

  /**
   * Start over with a different tile set: a new `urlTemplate` /
   * `imageryTemplate`, or the rounded union switched on / off
   * (tiles are built with or without its modifier). Every resident, queued
   * and in-flight tile is dropped (the basemap comes back until the first new
   * tile lands), the "no tile here" memory is cleared, and the loop refills
   * from the new source on the next `update()` — the enabled state carries
   * over, nothing is replayed. The Spark renderer is deliberately KEPT:
   * Spark wants exactly one per scene and its sort loop does not survive a
   * dispose mid-flight, so a rebuild reuses it. The remaining (live) options
   * in `o` are applied too.
   */
  rebuild(o: ResolvedSplatsOptions): void {
    // A new source means new meshes: let the pre-warm run again (it is a no-op if already compiled).
    this.prewarm = this.prewarm === 'rendering' ? 'done' : this.prewarm;
    if (this.disposed) return;
    // A pending ripple-out has nothing left to collapse.
    this.disablePending = false;
    this.endRipple();
    this.clearTiles();
    this.missing.clear();
    this.failures.clear();
    this.hasCenter = false;
    this.wantedZ = null;
    this.activeZ = null;
    this.governor.reset();
    this.group.visible = this.isActive();
    this.urlTemplate = o.urlTemplate;
    this.lowTierUrlTemplate = o.lowTierUrlTemplate;
    this.imageryTemplate = effectiveImageryTemplate(o);
    this.imageryDerived = imageryIsDerived(o);
    this.imageryMisses.clear();
    this.fileType = fileTypeFromTemplate(o.urlTemplate);
    this.union.enabled = o.roundedUnion.enabled;
    this.applyOptions(o);
  }

  /**
   * Apply the live-settable options to the running layer: `minZoom`, the
   * pyramid bounds + LOD biases (the next `update()` re-evaluates the active
   * level and, if it changed, transitions to it like any zoom would — no
   * rebuild), `radius`, `maxInFlight`, the two budgets, `hideBasemap`,
   * Spark's `maxStdDev` / sort spacing, and the rounded union's `feather` /
   * `growMs`. (`maxCameraZoom` is the map's business — see
   * `SplatsController`.) The tile-set options (`urlTemplate`,
   * `imageryTemplate`, rounded union on / off → `rebuild()`) and `enabled`
   * (→ `setEnabled`) are ignored here — `planSplatsUpdate` decides which call an update needs. Shrinking a budget evicts
   * farthest-first at once; a smaller window lets its outer tiles shrink away
   * on the next `update()`; growing either lets that `update()` load more.
   */
  applyOptions(o: ResolvedSplatsOptions): void {
    if (this.disposed) return;
    // Motion LoD is live: off, the next tick shows the full meshes (lite ones already loaded
    // stay until their tiles go — cheap, and they are wanted again if it is turned back on).
    this.motionLod = o.motionLod;
    // Level-SELECTION knobs are live: they only change which level the next tick asks for, and
    // a level change is already a supported transition.
    this.levelSelection = o.levelSelection;
    this.resolutionMargin = o.resolutionMargin;
    this.resolutionTiltAware = o.resolutionTiltAware;
    // Spark exposes this one on the live renderer, so it does not need a rebuild.
    if (this.lodRenderScale !== o.lodRenderScale) {
      this.lodRenderScale = o.lodRenderScale;
      const sr = this.sparkRenderer as { lodRenderScale?: number } | null;
      if (sr) sr.lodRenderScale = o.lodRenderScale;
    }
    // Culling / distance-cutoff knobs are all live: they only change what is DRAWN.
    this.frustumCull = o.frustumCull;
    this.visibleFirst_ = o.visibleFirst;
    this.splatMaxDistance = o.splatMaxDistance;
    this.lowTierSplatMaxDistance = o.lowTierSplatMaxDistance;
    this.splatFadeMs = o.splatFadeMs;
    this.minZoom = o.minZoom;
    this.maxInFlight = o.maxInFlight;
    this.minTileZoom = o.minTileZoom;
    this.maxTileZoom = o.maxTileZoom;
    this.lodBias = o.lodBias;
    this.lowTierLodBias = o.lowTierLodBias;

    const windowChanged =
      o.radius !== this.radius ||
      o.maxSplats !== this.maxSplats ||
      o.lowTierMaxSplats !== this.lowTierMaxSplats;
    this.radius = o.radius;
    this.maxSplats = o.maxSplats;
    this.lowTierMaxSplats = o.lowTierMaxSplats;
    if (windowChanged) {
      // The ranking is unchanged but what fits is not: forget the skips.
      this.overBudget.clear();
      // `lowTierMaxSplats` crossing 0 opens / closes the low-tier gate.
      this.setTierAllowed(!this.lowTier || this.lowTierMaxSplats > 0);
      if (this.isActive()) this.enforceBudget();
    }

    const finestChanged = o.maxTileZoom !== this.maxTileZoom;
    this.maxTileZoom = o.maxTileZoom;
    if (o.hideBasemap !== this.hideBasemap || o.keepLabels !== this.keepLabels || finestChanged) {
      this.hideBasemap = o.hideBasemap;
      this.keepLabels = o.keepLabels;
      this.cutout?.setCutoutReserved(this.hideBasemap === 'covered', this.maxTileZoom);
      this.cutoutDirty = true;
      this.syncBasemapHidden();
    }

    this.governor.setTarget(o.targetFrameMs);
    if (this.governor.setMaxScale(o.budgetGrowth)) this.enforceBudget();
    if (this.governor.setEnabled(o.governor)) {
      // Switched off with a reduced budget in force: the full one is back.
      this.overBudget.clear();
    }
    this.governor.setThinLadder(o.motionThin ? MOTION_THIN_LADDER : []);
    this.syncThin();
    this.densityLod = o.densityLod;
    this.tickDensityLod();
    if (o.cullBackFaces !== this.cullBackFaces) {
      this.cullBackFaces = o.cullBackFaces;
      if (this.backfaceDyno && this.backfaceDyno.value !== (o.cullBackFaces ? 1 : 0)) {
        this.backfaceDyno.value = o.cullBackFaces ? 1 : 0;
        for (const tile of this.tiles.values()) this.bumpTile(tile);
      }
      this.tickDensityLod();
    }
    if (o.cover !== this.cover) {
      // The wanted set changes: cover tiles become old-level tiles (they dissolve out once the
      // detail over them has settled) or start loading on the next tick.
      this.cover = o.cover;
      this.overBudget.clear();
      this.onSceneChange();
    }

    // Level dissolve: a shorter fade simply finishes sooner (the tracks are
    // linear progress); 0 completes everything on the next tick.
    this.configuredLevelFadeMs = o.levelFadeMs;
    this.syncLevelFadeMs();
    this.transitionOvershoot = o.transitionOvershoot;
    this.prefetchBand = o.prefetchBand;

    this.maxStdDev = o.maxStdDev;
    this.sortIntervalMs = o.sortIntervalMs;
    if (this.sparkRenderer) {
      this.sparkRenderer.maxStdDev = this.maxStdDev;
      this.sparkRenderer.minSortIntervalMs = this.currentSortIntervalMs();
    }

    this.union.growMs = o.roundedUnion.growMs;
    if (o.roundedUnion.feather !== this.union.feather) {
      this.union.feather = o.roundedUnion.feather;
      for (const tile of [...this.tiles.values(), ...this.queuedTiles.values()]) {
        if (!tile.union) continue;
        tile.union.uUnionFeather.value = this.union.feather;
        if (tile.unionFeather) {
          tile.unionFeather.value = this.union.feather;
          this.bumpTile(tile);
        }
      }
      this.cutoutDirty = true;
    }
    this.syncBasemapHidden();
    this.flushCutout();
    this.onSceneChange();
  }

  getStats(): SplatsStats {
    let coverTiles = 0;
    let coverSplats = 0;
    for (const t of this.tiles.values()) {
      if (!this.isCoverTile(t)) continue;
      coverTiles++;
      coverSplats += t.splats;
    }
    return {
      tiles: this.tiles.size,
      tileZoom: this.tileZoom,
      splats: this.residentSplats(),
      ...(coverTiles > 0 ? { coverTiles, coverSplats } : {}),
      maxSplats: this.currentMaxSplats(),
      reveal: this.ripple?.dir ?? 'none',
      basemapHidden: this.basemapHidden,
      basemapCovered: this.basemapCovered,
      governor: this.governor.state
    };
  }

  /**
   * Level-transition bookkeeping, for tooling and tests: whether a dissolve
   * is in progress, the decoded-but-unattached prefetched tiles, the level
   * being prefetched, and each resident tile's reveal kind + fade values.
   */
  getTransitionState(): {
    fading: boolean;
    prefetchZ: number | null;
    prefetched: string[];
    ghosts: string[];
    tiles: Array<{
      key: string; z: number; appear: AppearKind; fade: number; groundFade: number;
      /** How far a child has dissolved in over each quadrant: SW, SE, NW, NE. */
      quad: number[];
    }>;
  } {
    const now = this.clock();
    const ms = this.levelFadeMs;
    return {
      fading: this.levelFading,
      prefetchZ: this.prefetchZ,
      prefetched: [...this.prefetched.keys()],
      ghosts: [...this.groundGhosts.keys()],
      tiles: [...this.tiles.values()].map((t) => ({
        key: t.key, z: t.z, appear: t.appear,
        fade: fadeValue(fadeProgress(t.fade, now, ms)),
        groundFade: fadeValue(fadeProgress(t.groundFade, now, ms)),
        quad: t.quadDyno ? t.quadDyno.value.toArray() : [0, 0, 0, 0]
      }))
    };
  }

  /** `hideBasemap: 'covered'` is cutting the basemap out right now. */
  isCovering(): boolean {
    return this.basemapCovered;
  }

  /** `hideBasemap: true` is hiding the basemap layers right now. */
  isHidingBasemap(): boolean {
    return this.basemapHidden;
  }

  /** Splat tiles are resident (whatever the `hideBasemap` mode). */
  hasTiles(): boolean {
    return this.tiles.size > 0;
  }

  /**
   * Tiles are landing or dissolving right now (decoded tiles queued for admission, a level fade
   * in progress). Informational: the map paces one frame deep at all times now (it first did so
   * only while this was true — each landing redraws the full set and re-sorts it, and a sort's
   * readback blocks the main thread behind every frame queued on the GPU).
   */
  isLandingOrFading(): boolean {
    return this.applyQueue.length > 0 || this.queuedTiles.size > 0 || this.levelFading || this.landedNow;
  }

  /** The governor's smoothed moving-frame time, ms (0 before any sample). */
  governorFrameMs(): number {
    return this.governor.state.frameMs;
  }

  /**
   * Feed the frame-time governor: `dtMs` since the previous RENDERED frame,
   * `moving` = the camera moved (or is gliding). Only frames drawn while the
   * picture moves — camera, ripple, tiles growing — and with splats resident
   * say anything about the overlay's cost; the rest are ignored. When the
   * governor turns a knob the budget is re-enforced at once (farthest tiles
   * go) and the next `update()` re-picks the level.
   */
  reportFrame(dtMs: number, moving: boolean): void {
    if (this.disposed || this.tiles.size === 0 || !this.isActive()) return;
    if (!moving && !this.ripple && !this.unionDirty) return;
    // An upload hitch, and the overlap of two levels for the length of a dissolve (up to one tile
    // over the budget), are the price of a TRANSITION, not of the steady state — reading either as
    // draw cost would ratchet the budget down at every load and every level change. They are still
    // a stutter the viewer sees, and holding a bigger budget causes more of them, so they are
    // handed to the governor as hitches: they cannot cut the configured budget, only give back
    // growth taken above it.
    // The frame after a swap hold spans the hold: a transition, not draw cost.
    const swapHeld = this.swapHeld && this.swapHoldSince === null;
    if (swapHeld) this.swapHeld = false;
    // Frames of the detail ramp at the end of a glide are heavier on purpose (detail coming back
    // as the motion slows) — reading them as draw cost would thin the very detail being restored.
    const detailRamp = this.cameraMoving && this.motionDetail > 0;
    if (this.landedNow || this.landedPrev || this.levelFading || swapHeld || detailRamp) {
      if (!this.governor.noteHitch(dtMs, this.clock())) return;
    } else if (!this.governor.sample(dtMs, this.clock())) return;
    this.overBudget.clear();
    this.syncThin();
    // Gracefully: what has to go shrinks out of the union (300 ms) instead of
    // vanishing mid-move.
    if (this.enforceBudget(true)) this.syncBasemapHidden();
    this.flushCutout();
    this.onSceneChange();
  }

  /** Budget in effect: the quality tier's, times the governor's scale. */
  private currentMaxSplats(): number {
    const base = this.lowTier ? this.lowTierMaxSplats : this.maxSplats;
    return Math.round(base * this.governor.scale);
  }

  /** Fade length in effect: the configured one, or 0 under reduced motion.
   *  Fades in progress keep the progress they had reached. */
  private syncLevelFadeMs(): void {
    const ms = this.prefersReducedMotion() ? 0 : this.configuredLevelFadeMs;
    if (ms === this.levelFadeMs) return;
    const now = this.clock();
    for (const t of [...this.tiles.values(), ...this.groundGhosts.values()]) {
      fadeRebase(t.fade, now, this.levelFadeMs);
      fadeRebase(t.groundFade, now, this.levelFadeMs);
    }
    this.levelFadeMs = ms;
  }

  /** The tier's configured budget, before the governor's scale. */
  private baseMaxSplats(): number {
    return this.lowTier ? this.lowTierMaxSplats : this.maxSplats;
  }

  /** Allowance above the budget for a dissolve bringing in `splats`. */
  private allowanceFor(splats: number): number {
    return transitionAllowance(splats, this.baseMaxSplats(), this.transitionOvershoot, this.levelFadeMs);
  }

  /** Sort spacing in effect for the current quality tier. */
  private currentSortIntervalMs(): number {
    return this.lowTier
      ? Math.max(this.sortIntervalMs, LOW_TIER_SORT_INTERVAL_MS)
      : this.sortIntervalMs;
  }

  /** Window radius in effect for the current quality tier. */
  private currentRadius(): number {
    return this.lowTier ? Math.min(this.radius, LOW_TIER_MAX_RADIUS) : this.radius;
  }

  /** Splats resident in the scene (not counting decoded tiles still queued). */
  private residentSplats(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.splats;
    return n;
  }

  /** Resident + queued splats — everything already decoded and committed
   *  (less the tiles the governor has given up, which are on their way out). */
  private committedSplats(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (!t.evicting && !this.isCoverTile(t)) n += t.splats;
    for (const t of this.queuedTiles.values()) if (!this.isCoverTile(t)) n += t.splats;
    return n;
  }

  /** Resident (not given up) + queued tiles. */
  private committedTiles(): number {
    let n = 0;
    for (const t of this.queuedTiles.values()) if (!this.isCoverTile(t)) n++;
    for (const t of this.tiles.values()) if (!t.evicting && !this.isCoverTile(t)) n++;
    return n;
  }

  /**
   * Estimated splats per not-yet-decoded tile: the mean of what has landed
   * so far (0 before the first tile, so the centre tile is always tried).
   */
  private estimateTileSplats(): number {
    const n = this.committedTiles();
    return n === 0 ? 0 : this.committedSplats() / n;
  }

  /** LOD bias in effect: the quality tier's, less the governor's reduction. */
  private currentLodBias(): number {
    return (this.lowTier ? this.lowTierLodBias : this.lodBias) - this.governor.biasDrop;
  }

  /** The ACTIVE pyramid level — the `{z}` being requested (`maxTileZoom`
   *  until the first tick above `minZoom` picks one). */
  get tileZoom(): number {
    return this.activeZ ?? this.maxTileZoom;
  }

  /**
   * Per-frame tick (called from the RAF loop). Advances a playing ripple,
   * commits at most ONE queued scene mutation (tile / imagery landing),
   * recomputes the visible tile window and kicks off loads within the
   * resident-splat budget. Cheap when inactive, below minZoom, or when
   * Spark never loaded.
   */
  update(): void {
    this.updateWindow();
    this.tickMotionLod();
    this.tickDensityLod();
  }

  /**
   * Screen-space density LOD (see `splats.densityLod`): keep the shared `(focal / target)²`
   * uniform current with the drawing-buffer size, and every tile's object-space camera position
   * current with the camera. Camera moves need no regeneration call of their own — Spark already
   * regenerates each frame the view changes; a density change at rest is bumped explicitly.
   */
  private tickDensityLod(): void {
    const d = this.densityDyno;
    if (!d || this.disposed) return;
    const cam = this.getCamera?.() as (THREE.Camera & { fov?: number }) | null | undefined;
    let density = 0;
    if (this.densityLod > 0 && cam && typeof cam.fov === 'number') {
      let heightPx = this.renderHeightPx?.() ?? 0;
      if (!(heightPx > 0) && typeof this.renderer.getDrawingBufferSize === 'function') {
        this.renderer.getDrawingBufferSize(this.lodSize);
        heightPx = this.lodSize.y;
      }
      if (heightPx > 0) {
        const focal = heightPx / 2 / Math.tan((cam.fov * Math.PI) / 360);
        density = densityFor(focal, this.densityLod);
      }
    }
    if (density !== d.value) {
      d.value = density;
      for (const tile of this.tiles.values()) this.bumpTile(tile);
    }
    // The object-space camera feeds the density LOD AND the back-face test.
    if ((density <= 0 && !this.cullBackFaces) || !cam) return;
    cam.updateMatrixWorld();
    const moved = !cam.position.equals(this.lodCamPos);
    if (moved) this.lodCamPos.copy(cam.position);
    for (const tile of this.tiles.values()) {
      if (!tile.camDyno || (!moved && tile.camSet)) continue;
      // both meshes are direct children of the root at identity, so root-local = object space
      tile.root.updateWorldMatrix(true, false);
      this.lodMat.copy(tile.root.matrixWorld).invert();
      tile.camDyno.value.copy(cam.position).applyMatrix4(this.lodMat);
      tile.camSet = true;
    }
  }

  // -------------------------------------------------------------------------
  // Motion LoD
  // -------------------------------------------------------------------------

  /**
   * Whether the camera is moving (the map calls this every tick). With `motionLod` and a lite
   * pyramid, every resident tile also holds its LITE version — the same tile from
   * `lowTierUrlTemplate`, ~45 % of the splats — and draws it while the camera moves, back to
   * full detail once the map has settled. The frame cost here is per splat, not per pixel
   * (measured: the same pan at render scale 1, 0.75 and 0.5 runs at the same 27–29 fps), so
   * fewer splats in motion is the lever: one full z16 tile pans at 28 fps with a ~100 ms stall at
   * every depth sort on an Intel Iris, one lite tile at 52–58 fps with ~35 ms stalls. In motion
   * the eye cannot use the extra detail; at rest the full tile is back within a frame or two.
   * Switching is a visibility flip — both meshes are resident, nothing is refetched.
   */
  setCameraMoving(moving: boolean): void {
    this.cameraMoving = moving;
  }

  /**
   * How much at-rest detail to draw while the camera still moves (0‥1, see core/motionDetail): the
   * second half of a scroll or fling brings detail back instead of waiting for the stop. Above 0
   * the FULL meshes draw, thinned to the lite set's density at first (times the governor's
   * thinning), and the kept fraction rises with it to every splat at 1 — detail, and frame cost,
   * go up exactly as the motion slows down.
   */
  setMotionDetail(detail: number): void {
    this.motionDetail = detail > 0 ? Math.min(1, detail) : 0;
  }

  private motionLodActive(): boolean {
    return this.motionLod && !!this.lowTierUrlTemplate && !this.lowTier && this.isActive();
  }

  private tickMotionLod(): void {
    if (this.disposed) return;
    const active = this.motionLodActive();
    const useLite = active && this.cameraMoving && this.motionDetail <= 0;
    if (useLite !== this.drawingLite) {
      this.drawingLite = useLite;
      // Lite → full while still moving (the detail ramp at the end of a glide): cross-fade rather
      // than swap — a hard swap of every splat for a different set reads as a pop mid-motion.
      // Into motion, and back to rest, stay hard cuts (covered by the swap hold / settle dissolve).
      const sr = this.sparkRenderer;
      this.swapFade = !useLite && this.cameraMoving && sr?.display
        ? { since: this.clock(), mapping: sr.display.mappingVersion, t0: null }
        : null;
      // A new mapping: nothing of the full set is in Spark's ordering yet beyond where it starts.
      this.rampSortKeep = useLite ? 1 : this.rampStartKeep();
      this.rampSortPending = null;
      for (const tile of this.tiles.values()) this.applyMeshVisibility(tile);
      // Into motion: hold the picture until the lite set is sorted (see holdForSwap). Back to
      // rest needs no hold — the cheap lite set keeps drawing while the full one sorts.
      this.swapHoldSince = useLite && [...this.tiles.values()].some((t) => t.lite?.visible)
        ? this.clock()
        : null;
      this.swapPrimed = false;
      this.onSceneChange();
    }
    // Same tick as the lite flip, so Spark regenerates its splat set once for both.
    this.syncThin();
    this.tickSwapFade();
    if (!active || this.cameraMoving) return;
    // Fetch the lite versions of resident tiles that lack one, a couple at a time, so they are
    // ready before the next gesture — at rest only: attaching a mesh changes Spark's splat set
    // (a regeneration and a resort), which is a hitch mid-pan. The tiles' own loads go first and
    // ALL the way: a twin's fetch + decode competes with them for the in-flight slots, the decode
    // workers and the main thread, so none starts while any wanted tile is still in flight or
    // waiting to land.
    if (this.pending.size > 0 || this.queuedTiles.size > 0 || this.parked.size > 0) return;
    for (const tile of this.tiles.values()) {
      if (this.liteInFlight >= MOTION_LOD_MAX_IN_FLIGHT || this.inFlight >= this.maxInFlight) break;
      if (tile.lite || tile.liteState !== 'none' || tile.evicting || tile.meshGone) continue;
      void this.loadLite(tile);
    }
  }

  private async loadLite(tile: SplatTile): Promise<void> {
    const spark = this.spark;
    if (!spark) return;
    tile.liteState = 'loading';
    this.liteInFlight++;
    let mesh: SparkSplatMeshLike | null = null;
    try {
      const url = expandTileUrl(this.lowTierUrlTemplate, tile.z, tile.tileX, tile.tileY);
      const data = await this.fetchTile(url);
      if (!data || tile.disposed || tile.meshGone) {
        tile.liteState = data ? 'none' : 'missing';
        return;
      }
      const fileType = this.fileType
        ? (spark.SplatFileType?.[this.fileType.toUpperCase()] ?? this.fileType)
        : undefined;
      mesh = new spark.SplatMesh({ fileBytes: data, fileType, fileName: url });
      mesh.name = `splat-tile-lite:${tile.key}`;
      mesh.layers.set(SPLAT_THREE_LAYER);
      mesh.maxSh = 0;
      // the full mesh's modifier graph: same uniform nodes, so the union mask, level fade and
      // distance fade drive both versions without any bookkeeping
      const liteModifier = tile.liteModifier ?? tile.objectModifier;
      if (liteModifier) mesh.objectModifier = liteModifier;
      if (tile.rippleOn && this.rippleDyno) mesh.worldModifier = this.rippleDyno.modifier;
      await mesh.initialized;
      if (tile.disposed || tile.meshGone || !this.tiles.has(tile.key)) {
        mesh.dispose();
        tile.liteState = 'none';
        return;
      }
      tile.lite = mesh;
      tile.liteState = 'ready';
      mesh = null;
      tile.root.add(tile.lite);
      this.applyMeshVisibility(tile);
      this.onSceneChange();
    } catch (err) {
      tile.liteState = 'missing';
      logger.warn(`splat lite tile ${tile.key} failed:`, err instanceof Error ? err.message : String(err));
      mesh?.dispose();
    } finally {
      this.liteInFlight--;
    }
  }

  /**
   * Motion-LoD swap hold — the map asks before each render and skips drawing while this is true.
   *
   * Showing or hiding meshes changes Spark's splat MAPPING, and Spark keeps drawing the previous
   * set until the new one's first depth sort lands. At the start of a gesture that previous set
   * is the full detail (~1M splats, ~90–150 ms a frame on an Intel Iris), and the sort's readback
   * waits behind those frames: measured ~600 ms of 90–270 ms frames at every gesture start, the
   * same with the GPU pre-warmed, while generating either set costs 1–2 ms. So on the flip the
   * map draws nothing: the first held tick runs Spark's update itself (generate + start the sort
   * on an idle GPU), the next ones wait for the sort, and the first frame drawn is the lite set.
   * The hold never outlasts `SWAP_HOLD_MAX_MS`, and it only STARTS from an idle GPU and an idle
   * Spark (`gpuIdle`: the map has no unfinished frame): otherwise the sort's readback blocks the
   * main thread behind the frames already queued, which no cap can cut short.
   */
  holdForSwap(gpuIdle = true): boolean {
    if (this.swapHoldSince === null) return false;
    const sr = this.sparkRenderer;
    if (this.disposed || !sr?.update || !sr.current || !sr.display
      || this.clock() - this.swapHoldSince > SWAP_HOLD_MAX_MS) {
      this.swapHoldSince = null;
      return false;
    }
    if (sr.current.mappingVersion !== sr.display.mappingVersion) {
      this.swapHeld = true;                   // the new set is generated, its sort is in flight
      return true;
    }
    if (!this.swapPrimed) {
      // Only from an idle GPU and an idle Spark. With the map still busy after the last gesture
      // (tiles landing, a reveal animating) the readback of the new sort — or of one already in
      // flight — blocks the main thread behind the full-set frames queued before the flip, which
      // no cap can cut short: measured as one 225–360 ms freeze instead of the usual stutter.
      // Not holding is the better of the two there.
      const cam = this.getCamera?.();
      let scene: THREE.Object3D = this.group;
      while (scene.parent) scene = scene.parent;
      if (!gpuIdle || sr.sorting || !cam || scene === this.group) {
        this.swapHoldSince = null;
        return false;
      }
      cam.updateMatrixWorld();
      void sr.update({ scene, camera: cam });
      this.swapPrimed = true;
      this.swapHeld = true;
      return true;
    }
    this.swapHoldSince = null;                // primed and the mappings agree: the sort landed
    return false;
  }

  /** Which of a tile's two meshes is drawn: the culling verdict, then motion LoD (both meshes
   *  while the lite → full cross-fade runs). Detail tiles stay drawn in motion, lite. They used to
   *  give way to their cover parent away from the view focus, which flipped detail to the cover
   *  and back at every touch, most visibly across tile borders, for no measurable frame gain. */
  private applyMeshVisibility(tile: SplatTile): void {
    const show = tile.cullDraw;
    const fading = this.swapFade !== null && !!tile.lite;
    const lite = (this.drawingLite || fading) && !!tile.lite;
    const full = !this.drawingLite || !tile.lite || fading;
    if (tile.mesh.visible !== (show && full)) tile.mesh.visible = show && full;
    if (tile.lite && tile.lite.visible !== (show && lite)) tile.lite.visible = show && lite;
  }

  /**
   * Advance the lite → full cross-fade: the full meshes fade in over the still-opaque lite ones
   * (so the ground never shows through a half-transparent pair), then the lite ones fade out. The
   * clock starts once Spark displays the combined set — a new mapping is only drawn after its
   * first sort. Per-mesh opacity is a Spark uniform: changing it is a cheap regeneration.
   */
  private tickSwapFade(): void {
    const fade = this.swapFade;
    if (!fade) return;
    const now = this.clock();
    const sr = this.sparkRenderer;
    const end = (): void => {
      this.swapFade = null;
      for (const tile of this.tiles.values()) {
        tile.mesh.opacity = 1;
        if (tile.lite) tile.lite.opacity = 1;
        this.applyMeshVisibility(tile);
      }
      this.onSceneChange();
    };
    if (this.drawingLite || !this.cameraMoving) {
      end();
      return;
    }
    if (fade.t0 === null) {
      const shown = !sr?.display || sr.display.mappingVersion !== fade.mapping;
      if (!shown && now - fade.since < SWAP_FADE_WAIT_MS) {
        for (const tile of this.tiles.values()) if (tile.lite) tile.mesh.opacity = 0;
        return;
      }
      fade.t0 = now;
    }
    const u = (now - fade.t0) / SWAP_FADE_MS;
    if (u >= 1) {
      end();
      return;
    }
    for (const tile of this.tiles.values()) {
      if (!tile.lite) continue;
      tile.mesh.opacity = Math.min(1, 2 * u);
      tile.lite.opacity = Math.min(1, 2 - 2 * u);
    }
    this.onSceneChange();
  }

  /**
   * Push the governor's motion-thinning keep fraction to every tile — while the camera moves
   * only; at rest every splat is drawn. A change regenerates Spark's splat set, so it is applied
   * on the motion flip (where the lite swap regenerates anyway) and on a governor step.
   */
  private syncThin(): void {
    const dyno = this.thinDyno;
    if (!dyno) return;
    const now = this.clock();
    const moving = this.cameraMoving && this.isActive();
    const ramp = moving && this.motionDetail > 0;
    const govKeep = clampThinKeep(this.governor.thinKeep);
    // FULL meshes: the detail ramp at the end of a glide (from the motion density to every splat,
    // following the map's motion detail, which is smooth already), else the governor's thinning
    // while moving, else everything. LITE meshes (drawn in motion, and fading out during the
    // cross-fade): the governor's thinning, untouched by the ramp.
    const fullTarget = !moving
      ? 1
      : ramp
        ? clampThinKeep(this.rampStartKeep() + (1 - this.rampStartKeep()) * this.motionDetail)
        : govKeep;
    const liteTarget = moving ? govKeep : 1;
    // A governor step mid-gesture EASES (a density pop while moving reads as flicker), one small
    // regeneration a frame. The flip into motion and the return to rest snap: the swap hold and
    // the map's settle dissolve already cover those moments.
    const easing = moving && this.thinWasMoving;
    const k = approach(Math.min(now - this.lastThinMs, 100), this.thinEaseTauMs);
    const eased = (cur: number, target: number, ease: boolean): number => {
      if (!ease || cur === target) return target;
      const v = cur + (target - cur) * k;
      return Math.abs(v - target) < 0.01 ? target : v;
    };
    // Track what the last landed sort holds (see rampSortKeep). Spark sorts one at a time, often
    // back to back, so a new start stamp means the previous sort has landed; a sort sorts the set
    // generated just before it started, i.e. with the values in the uniforms right now.
    const sr = this.sparkRenderer;
    const sortTime = sr?.lastSortTime ?? 0;
    if (sortTime !== this.prevSortTime) {
      if (this.rampSortPending !== null) this.rampSortKeep = this.rampSortPending;
      this.rampSortPending = dyno.value + (this.thinBandDyno?.value ?? 0);
      this.prevSortTime = sortTime;
    } else if (!sr?.sorting && this.rampSortPending !== null) {
      this.rampSortKeep = this.rampSortPending;
      this.rampSortPending = null;
    }
    let full = eased(dyno.value, fullTarget, easing && !ramp);
    // Rising: never past what the ordering already holds (it fades in through the soft band as the
    // value climbs, then the next sort extends it). Falling is always immediate.
    let held = false;
    if (full > dyno.value) {
      const capped = Math.max(dyno.value, Math.min(full, this.rampSortKeep));
      held = capped < full;
      if (held) {
        this.rampHeldSince ??= now;
        if (now - this.rampHeldSince < RAMP_SORT_WAIT_MS) full = capped;
      }
    }
    if (!held) this.rampHeldSince = null;
    const lite = this.liteThinDyno ? eased(this.liteThinDyno.value, liteTarget, easing) : liteTarget;
    // The soft band while the full set's density is on its way up (the ramp, and its tail at rest);
    // a lower keep needs none, and in steady motion it would only add splats to draw.
    const band = full < 1 && (ramp || fullTarget > full) ? THIN_RAMP_BAND : 0;
    this.thinWasMoving = moving;
    this.lastThinMs = now;
    let changed = false;
    if (dyno.value !== full) { dyno.value = full; changed = true; }
    if (this.liteThinDyno && this.liteThinDyno.value !== lite) { this.liteThinDyno.value = lite; changed = true; }
    if (this.thinBandDyno && this.thinBandDyno.value !== band) { this.thinBandDyno.value = band; changed = true; }
    // Held at the cap: keep Spark sorting (a regeneration marks it dirty), or the cap never lifts.
    if (changed || held) for (const tile of this.tiles.values()) this.bumpTile(tile);
  }

  /**
   * Kept fraction of the FULL meshes at the start of the detail ramp: the density the lite set
   * had (its splats per full splat, ~0.45 for the 0.7 m pyramid), times the governor's thinning,
   * so the swap from lite to full is a change of splats, not of density.
   */
  private rampStartKeep(): number {
    let full = 0;
    let lite = 0;
    for (const t of this.tiles.values()) {
      if (!t.lite) continue;
      full += t.splats;
      lite += t.lite.numSplats ?? t.lite.packedSplats?.numSplats ?? 0;
    }
    const ratio = full > 0 && lite > 0 ? Math.min(1, lite / full) : 1;
    return ratio * clampThinKeep(this.governor.thinKeep);
  }

  /**
   * The composer renders the scene at `scale` × the canvas resolution (dynamic resolution without
   * a canvas resize). Spark sizes splat footprints from the drawing buffer, so it is told the
   * same scale through `focalAdjustment`; the density LOD follows through `renderHeightPx`.
   */
  setRenderScale(scale: number): void {
    const s = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1) : 1;
    this.renderScale = s;
    if (this.sparkRenderer) this.sparkRenderer.focalAdjustment = s;
  }

  /** Motion LoD is drawing the lite meshes right now. */
  isDrawingLite(): boolean {
    return this.drawingLite;
  }

  /**
   * Full detail is what Spark is drawing: not the lite set, no motion thinning, and no new
   * mapping still waiting for its first sort. The map's settle dissolve fades in once this holds.
   */
  isDetailSettled(): boolean {
    if (this.drawingLite || (this.thinDyno?.value ?? 1) < 1) return false;
    const sr = this.sparkRenderer;
    return !sr?.current || !sr.display || sr.current.mappingVersion === sr.display.mappingVersion;
  }

  /** Bump the generator version of both of a tile's meshes (a modifier uniform changed). */
  private bumpTile(tile: SplatTile): void {
    tile.mesh.updateVersion?.();
    tile.lite?.updateVersion?.();
  }

  private disposeLite(tile: SplatTile): void {
    if (!tile.lite) return;
    tile.root.remove(tile.lite);
    try {
      tile.lite.dispose();
    } catch (err) {
      logger.warn(`splat lite tile ${tile.key} dispose failed:`, err instanceof Error ? err.message : String(err));
    }
    tile.lite = null;
    tile.liteState = 'none';
  }

  private updateWindow(): void {
    if (this.disposed) return;
    if (this.ripple) this.tickRipple();
    this.tickPrewarm();
    if (this.unionDirty) this.tickUnion();
    this.tickLevelFade();
    this.flushCutout();
    this.tickCulling();
    if (!this.isActive() || !this.opened) return;
    const view = this.camera.getView();
    if (view.zoom < this.minZoom) {
      // Zoomed back out below the threshold — drop everything so we don't
      // keep megabytes of splat textures resident off-screen.
      if (
        this.tiles.size > 0 || this.pending.size > 0 || this.queuedTiles.size > 0 ||
        this.prefetched.size > 0 || this.parked.size > 0 || this.groundGhosts.size > 0
      ) {
        this.clearTiles();
        this.onSceneChange();
      }
      // Coming back in selects a level afresh (no hysteresis to honour).
      this.wantedZ = null;
      this.activeZ = null;
      this.hasCenter = false;
      return;
    }

    // Where the camera is looking: the frame the tiles are ranked in, and the
    // window centre for every level (see `centreAt`) — the target pushed
    // forward along the view direction when tilted (`viewFocus`).
    const n0 = lonLatToTileFractional(view.lon, view.lat, 0);
    const f = this.frame;
    f.cx = n0.x;
    f.cy = n0.y;
    f.bearingDeg = view.bearing;
    f.tiltDeg = view.tilt;
    // Scene metres → normalised mercator (the scene is scaled by cos(lat₀)).
    f.dist =
      zoomToDistance(view.zoom) /
      (Math.max(Math.cos((this.projection.origin.lat * Math.PI) / 180), 1e-6) * EARTH_CIRCUMFERENCE_M);
    f.aspect = this.getAspect?.() ?? 1.6;
    // Keep the window centred on what the camera looks at. A forward push is only allowed
    // when the window is wide enough to still contain the target tile: (radius − 1) tiles of
    // the level in use (0 for the default 3×3 window).
    const zForShift = this.activeZ ?? this.maxTileZoom;
    const maxShift = Math.max(0, this.currentRadius() - 1) / 2 ** zForShift;
    const focus = viewFocus(f, maxShift);
    const focusLL = tileToLonLat(0, focus.x, Math.min(Math.max(focus.y, 0), 1));
    this.centerLon = focusLL.lon;
    this.centerLat = focusLL.lat;
    this.centerCache.clear();

    // Pyramid level: what the camera zoom asks for (with hysteresis), unless
    // that level has no tiles here. A change starts a level transition.
    const lodParams = {
      minTileZoom: this.minTileZoom,
      maxTileZoom: this.maxTileZoom,
      lodBias: this.currentLodBias()
    };
    let mpp = this.levelSelection === 'resolution' ? this.getMetersPerPixel?.() : undefined;
    if (mpp !== undefined && this.resolutionTiltAware) {
      // Judge by the NEAR edge of a tilted view, not the camera target (see nearEdgeMppFactor).
      mpp *= nearEdgeMppFactor(view.tilt, f.fovDeg);
    }
    this.wantedZ = mpp !== undefined && mpp > 0
      // Match the level to what the screen can actually show (see selectTileZoomByResolution).
      ? selectTileZoomByResolution(mpp, this.wantedZ, {
        ...lodParams,
        imagePx: SPLAT_GROUND_PX,
        latDeg: this.centerLat,
        margin: this.resolutionMargin
      })
      : selectTileZoom(view.zoom, this.wantedZ, lodParams);
    const z = this.resolveActiveLevel(this.wantedZ);
    if (z !== this.activeZ) this.switchLevel(z);

    const center = this.centreAt(z);
    const ranked = this.rankedAt;
    const turned = Math.abs(((view.bearing - ranked.bearing + 540) % 360) - 180);
    if (
      !this.hasCenter || center.x !== this.lastCenterX || center.y !== this.lastCenterY ||
      turned > RERANK_BEARING_DEG ||
      Math.abs(view.tilt - ranked.tilt) > RERANK_TILT_DEG ||
      Math.abs(view.zoom - ranked.zoom) > RERANK_ZOOM
    ) {
      // New centre (or the view turned) → the budget ranking changed; tiles
      // that were skipped as over-budget may now be the most relevant.
      this.overBudget.clear();
      ranked.bearing = view.bearing;
      ranked.tilt = view.tilt;
      ranked.zoom = view.zoom;
    }
    this.lastCenterX = center.x;
    this.lastCenterY = center.y;
    this.hasCenter = true;

    // Landings, THEN the loop — so an admitted tile counts against the budget before more loads
    // start. At REST every decoded tile and image waiting lands in this one frame: a landing
    // re-sorts Spark's whole set and the sort's readback blocks the main thread for a frame's
    // worth of GPU queue, so a batch costs one stall where one-per-frame cost one per tile
    // (measured: six stalls, 190–410 ms, over a seven-tile load). The uploads themselves are
    // cheap now (ImageBitmap imagery ~6 ms, a tile's splat textures ~3 ms). In MOTION one per
    // frame, as before, and with motion LoD on the splat tiles do not land at all: a landing mid-
    // pan is a hitch; they land the moment the map settles. Imagery (a texture swap) still lands,
    // and so does a splat tile when nothing is on screen yet: an empty view is worse than a hitch.
    this.retryParked();
    this.landedPrev = this.landedNow;
    let landed = 0;
    if (!this.cameraMoving) {
      for (const fn of this.applyQueue.splice(0)) { fn(); landed++; }
      for (const fn of this.imageryQueue.splice(0)) { fn(); landed++; }
    } else {
      const deferSplats = this.motionLodActive() && this.tiles.size > 0;
      const landing = (deferSplats ? undefined : this.applyQueue.shift()) ?? this.imageryQueue.shift();
      if (landing) { landing(); landed++; }
    }
    this.landedNow = landed > 0;

    this.evictFarTiles();

    const budget = this.currentMaxSplats();
    const estimate = this.estimateTileSplats();
    // Splats already committed + a mean-sized guess for each fetch in flight.
    // Old-level tiles (a level transition in progress) are left out: they
    // give way — first — when a new-level tile actually LANDS (`loadTile`),
    // not when its fetch starts, so they keep the picture whole meanwhile.
    let projected = this.committedSplats() - this.oldLevelSplats() + this.pending.size * estimate;
    for (const p of this.parked.values()) projected += p.tile.splats;
    // Most relevant first: by where each tile falls on SCREEN, not by grid
    // distance from the centre tile — the budget goes where the camera looks.
    // Candidates come from `desiredTiles()`, so when the cut is on they span several levels and
    // are ranked as ONE list — a coarse far cell competes with a fine near one on the same screen
    // relevance scale, which is the only way the budget can be split between near detail and far
    // reach. With the cut off this is exactly the single-level window it always was.
    // Load order: the detail tile under the view FOCUS first (what the user is looking at), then
    // the cover (the whole view in coarse splats, outside the budget), then the rest of the detail
    // level by screen relevance — from the view centre outward. Measured with cover-first and one
    // load in flight, the first detail tile started 700 ms after the first cover fetch.
    const wanted = [...this.desiredTiles(z).values()];
    const coverZ = this.coverZ();
    const coverCells = coverZ === null ? [] : wanted.filter((c) => c.z === coverZ);
    const detailRanked = this.visibleFirst(rankCellsByRelevance(coverZ === null ? wanted : wanted.filter((c) => c.z !== coverZ), f));
    const focusKey = tileKey(z, center.x, center.y);
    const focusFirst = detailRanked.filter((c) => tileKey(c.z, c.x, c.y) === focusKey);
    const window = [
      ...focusFirst,
      ...this.visibleFirst(rankCellsByRelevance(coverCells, f)),
      ...detailRanked.filter((c) => tileKey(c.z, c.x, c.y) !== focusKey)
    ];
    let started = 0;
    for (const { z: cz, x, y } of window) {
      // A decoded tile is already waiting for room: don't decode more.
      if (this.inFlight >= this.maxInFlight || this.parked.size > 0) break;
      const key = tileKey(cz, x, y);
      if (
        this.tiles.has(key) ||
        this.queuedTiles.has(key) ||
        this.parked.has(key) ||
        this.pending.has(key) ||
        this.missing.has(key) ||
        this.overBudget.has(key)
      ) {
        continue;
      }
      if (cz !== coverZ) {
        // Most-relevant-first residency: make room by dropping resident tiles
        // that matter clearly LESS than this one; if that still doesn't
        // fit, the window beyond here is out of budget — stop (the first tile
        // is always tried so a budget below one tile still shows something).
        if (this.activeLevelTiles() + this.pending.size > 0) {
          projected -= this.evictFartherThan(cz, x, y, projected + estimate - budget);
          if (projected + estimate > budget) break;
        }
        projected += estimate;
      }
      started++;
      void this.loadTile(cz, x, y, key);
    }
    this.updatePrefetch(view.zoom, z, started === 0 && this.parked.size === 0);
    // A landing above may have started (or, with `levelFadeMs: 0`, finished)
    // a dissolve: apply it in this very frame.
    this.tickLevelFade();
    this.flushCutout();
  }

  /**
   * Prefetch across the level threshold. Within `prefetchBand` of the camera
   * zoom at which the level will switch, the NEXT level's tile under the
   * camera target is fetched and decoded in the background — never attached
   * to the scene — so that on crossing the dissolve starts at once
   * (`switchLevel` promotes it). Leaving the band drops what was prefetched
   * and abandons what is in flight. `idle`: the window loop had nothing to
   * start this tick (the active level's own tiles always go first).
   */
  private updatePrefetch(cameraZoom: number, activeZ: number, idle: boolean): void {
    let pz = prefetchLevel(
      cameraZoom, this.wantedZ,
      { minTileZoom: this.minTileZoom, maxTileZoom: this.maxTileZoom, lodBias: this.currentLodBias() },
      this.prefetchBand
    );
    if (pz === activeZ) pz = null; // (the wanted level is missing here and we already fell back to it)
    this.prefetchZ = pz;
    for (const [key, tile] of this.prefetched) {
      if (tile.z === pz && this.isInKeepZone(tile.z, tile.tileX, tile.tileY)) continue;
      this.prefetched.delete(key);
      this.disposeTile(key, tile);
    }
    // Abandon in-flight loads for levels no longer in play (not a prefetch either). Asking the
    // SET, not `activeZ`: with a cover level in play this line used to kill every cover load on
    // every tick — fetched, decoded, abandoned, fetched again (measured: 9 requests a frame).
    const live = this.levelsInPlay();
    for (const [key, p] of this.pending) if (!live.has(p.z) && p.z !== pz) this.pending.delete(key);
    if (pz === null || !idle || this.inFlight >= this.maxInFlight) return;
    const n = 2 ** pz;
    const x = Math.min(n - 1, Math.max(0, Math.floor(this.frame.cx * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(this.frame.cy * n)));
    const key = tileKey(pz, x, y);
    if (
      this.prefetched.has(key) || this.pending.has(key) || this.missing.has(key) ||
      this.tiles.has(key) || this.queuedTiles.has(key) || this.parked.has(key) ||
      // Already known not to fit. Cleared when the centre moves, so a real change of situation
      // still gets a fresh try — this only stops the same doomed fetch repeating on every tick.
      this.overBudget.has(key)
    ) {
      return;
    }
    void this.loadTile(pz, x, y, key, true);
  }

  dispose(): void {
    this.ripple = null;
    this.disablePending = false;
    this.clearTiles();
    this.cutout?.setCutoutRipple(false);
    this.flushCutout();
    this.cutout?.setCutoutReserved(false);
    this.disposed = true;
    this.scene.remove(this.group);
    if (this.sparkRenderer) {
      this.scene.remove(this.sparkRenderer);
      // Spark spaces its sorts with a timer (`minSortIntervalMs`); one left
      // pending fires after `dispose()` has freed the render targets and
      // rejects with "No target". Cancel it first (best effort — these are
      // Spark internals, so only touch them if they look as expected).
      const sort = this.sparkRenderer as unknown as { sortTimeoutId?: unknown; sortDirty?: unknown };
      if (typeof sort.sortTimeoutId === 'number' && sort.sortTimeoutId !== -1) {
        clearTimeout(sort.sortTimeoutId);
        sort.sortTimeoutId = -1;
      }
      if (typeof sort.sortDirty === 'boolean') sort.sortDirty = false;
      try {
        this.sparkRenderer.dispose();
      } catch (err) {
        logger.warn('SparkRenderer dispose failed:', err instanceof Error ? err.message : String(err));
      }
      this.sparkRenderer = null;
    }
    this.spark = null;
    this.rippleDyno = null;
    this.missing.clear();
    this.failures.clear();
  }

  // -------------------------------------------------------------------------
  // Internals — tile loop
  // -------------------------------------------------------------------------

  private isActive(): boolean {
    return this.enabled && this.tierAllowed;
  }

  private applyActive(): void {
    const active = this.isActive();
    this.group.visible = active;
    if (!active) this.clearTiles();
    // Same frame: the basemap must be back the moment the imagery is gone.
    this.flushCutout();
    this.onSceneChange();
  }

  private async loadTile(z: number, x: number, y: number, key: string, prefetch = false): Promise<void> {
    const token = ++this.loadSeq;
    this.pending.set(key, { token, z });
    this.inFlight++;
    // Cover tiles come from the lite pyramid when there is one: coarse, mostly far, and the whole
    // window of them is resident — a third of the splats for the same ground is the right price.
    const coverLite = this.coverZ() === z && !!this.lowTierUrlTemplate && !this.lowTier;
    const url = expandTileUrl(coverLite ? this.lowTierUrlTemplate : this.activeUrlTemplate(), z, x, y);
    // A tile that will DISSOLVE in (prefetched, or landing over ground another
    // level is showing) wants its imagery with it, not a frame-load later —
    // the ground would fade in as the flat fallback colour. Ask for both now.
    let early: Promise<THREE.Texture | null> | null = null;
    if (this.imageryTemplate && (prefetch || this.overlapsOtherLevel({ z, x, y }))) {
      early = this.loadImagery(z, x, y).catch(() => null);
    }
    const dropEarly = (): void => {
      void early?.then((tex) => tex?.dispose());
      early = null;
    };
    // A level switch drops the pending entries of every other level, so a
    // load that outlives its level discards its result here too.
    const live = (): boolean => !this.disposed && this.pending.get(key)?.token === token;
    try {
      const data = await this.fetchTile(url);
      if (!live()) return dropEarly();
      if (!data) {
        this.missing.add(key);
        return dropEarly();
      }
      // Camera moved far away while the fetch was in flight — drop it.
      if (!this.isInKeepZone(z, x, y)) return dropEarly();
      const tile = await this.buildTile(z, x, y, key, data, url);
      // Loaded lite already: no motion-LoD twin to fetch, it IS the lite version.
      if (coverLite) tile.liteState = 'missing';
      tile.preTexture = early;
      early = null;
      // Re-check: a disable / zoom-out / eviction may have raced the decode.
      // A tile landing mid-way through a ripple-OUT would only flash.
      if (!live() || !this.isInKeepZone(z, x, y) || this.disablePending) {
        this.disposeTile(key, tile);
        return;
      }
      if (prefetch && !this.levelsInPlay().has(z)) {
        // Decoded ahead of the threshold: hold it OFF-scene (no upload, no draw cost) until the
        // level switches — unless the camera has left the band meanwhile, or even budget +
        // allowance could not take it.
        //
        // The two reasons are NOT alike and must not share a branch. Leaving the band is about
        // this moment, so the tile is simply dropped. Being too big for the budget is a property
        // of the TILE, so dropping it silently means the next idle tick prefetches it again,
        // decodes it again, and discards it again: measured at a camera parked in the band with a
        // small budget, 137 requests for one tile in 25 seconds with no user input at all. Record
        // it the way `commitTile` records the same verdict, and have the prefetch guard honour it.
        if (this.prefetchZ !== z) {
          this.disposeTile(key, tile);
          return;
        }
        if (tile.splats > this.currentMaxSplats() + this.allowanceFor(tile.splats)) {
          this.overBudget.add(key);
          this.disposeTile(key, tile);
          return;
        }
        while (this.prefetched.size >= MAX_PREFETCHED) {
          const [oldKey, old] = this.prefetched.entries().next().value as [string, SplatTile];
          this.prefetched.delete(oldKey);
          this.disposeTile(oldKey, old);
        }
        this.prefetched.set(key, tile);
        return;
      }
      this.failures.delete(key);
      this.commitTile(key, tile);
    } catch (err) {
      // A tile failure is non-fatal, but it must not be retried forever — see `failures`.
      const n = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, n);
      const why = err instanceof Error ? err.message : String(err);
      if (n >= MAX_TILE_ATTEMPTS) {
        this.missing.add(key);
        logger.warn(
          `splat tile ${key} failed ${n}x, giving up (no further attempts for this tile): ${why}`
        );
      } else {
        logger.warn(`splat tile ${key} failed (attempt ${n}/${MAX_TILE_ATTEMPTS}): ${why}`);
      }
    } finally {
      if (this.pending.get(key)?.token === token) this.pending.delete(key);
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  /**
   * A decoded tile of the ACTIVE level: now the real splat count is known —
   * does it fit? Two limits:
   *
   *  - a tile landing over ground another level is showing may take the
   *    free room in the budget plus the TRANSITION ALLOWANCE (one tile's
   *    worth, capped — see `transitionAllowance`), so the two can
   *    cross-dissolve instead of swapping; beyond that the old level gives
   *    way at once (real pressure);
   *  - the active level ALONE must fit the budget proper: farther resident
   *    tiles of this level give way, otherwise the tile is dropped and
   *    remembered as over-budget for this centre.
   *
   * A first tile always lands, even over budget, so a tiny budget still
   * shows something. The old level's splats are released when its fade-out
   * completes (`tickLevelFade`), at most `levelFadeMs + 250 ms` later.
   */
  private commitTile(key: string, tile: SplatTile, force = false): void {
    if (this.isCoverTile(tile)) {
      // Cover tiles sit outside the budget: straight to admission (the keep zone still applies
      // there), staggered one landing per frame like everything else.
      this.parked.delete(key);
      this.queuedTiles.set(key, tile);
      this.applyQueue.push(() => this.admitTile(key, tile));
      return;
    }
    const budget = this.currentMaxSplats();
    // The transition allowance is for ground an OLD level still shows; the cover level under a
    // detail tile is the steady state, not a transition, and earns none.
    const allowance = this.overlapsOtherLevel({ z: tile.z, x: tile.tileX, y: tile.tileY }, true)
      ? this.allowanceFor(tile.splats)
      : 0;
    // The allowance sits on top of the budget — or of the old level, where
    // that alone is over it: with a budget of about one tile the lone resident
    // tile often is (a first tile always lands), and must still be dissolved
    // out of. It is ONE allowance for the whole overlap, however many tiles
    // land during it.
    const beyond = (): number =>
      this.committedSplats() + tile.splats - (Math.max(budget, this.oldLevelSplats()) + allowance);
    const overAll = beyond();
    if (
      overAll > 0 && !force && this.allowanceFor(tile.splats) > 0 &&
      this.activeLevelTiles() > 0 && this.oldLevelSplats() >= overAll
    ) {
      // The room is coming: the old level dissolves out under the tiles that
      // have landed (or are about to) and releases its splats within the
      // fade. Wait for it off-scene rather than pop an old tile out
      // mid-dissolve (retried from `update()`, forced after the grace).
      if (!this.parked.has(key)) this.parked.set(key, { tile, sinceMs: this.clock() });
      return;
    }
    this.parked.delete(key);
    if (overAll > 0) this.evictOldLevel(overAll);
    const over = Math.max(
      this.committedSplats() - this.oldLevelSplats() + tile.splats - budget,
      beyond()
    );
    if (
      over > 0 && this.activeLevelTiles() > 0 &&
      this.evictFartherThan(tile.z, tile.tileX, tile.tileY, over) < over
    ) {
      this.disposeTile(key, tile);
      this.overBudget.add(key);
      return;
    }
    // Commit to the budget now; the scene attach (which forces the splat
    // texture upload on the next render) is staggered one per frame.
    this.queuedTiles.set(key, tile);
    this.applyQueue.push(() => this.admitTile(key, tile));
  }

  /** Retry the parked tiles (room may have been released since). */
  private retryParked(): void {
    if (this.parked.size === 0) return;
    const now = this.clock();
    const live = this.levelsInPlay(); // hoisted: this runs every frame
    for (const [key, { tile, sinceMs }] of [...this.parked]) {
      if (!live.has(tile.z) || !this.isInKeepZone(tile.z, tile.tileX, tile.tileY)) {
        this.parked.delete(key);
        this.disposeTile(key, tile);
        continue;
      }
      this.commitTile(key, tile, now - sinceMs > this.levelFadeMs + TRANSITION_GRACE_MS);
    }
  }

  /** Tiles that are SHOWING right now (not on their way out of range), of
   *  any level — plus the grounds still lingering after a fade-out. */
  private *showingTiles(): Generator<SplatTile> {
    for (const [key, t] of this.tiles) {
      if (t.evicting || (this.presence.get(key)?.outMs ?? null) !== null) continue;
      yield t;
    }
    yield* this.groundGhosts.values();
  }

  /** Is ground of tile `ref` already shown by a tile of ANOTHER level (`ignoreCover`: not
   *  counting the cover level, which is always there)? */
  private overlapsOtherLevel(ref: { z: number; x: number; y: number }, ignoreCover = false): boolean {
    for (const t of this.showingTiles()) {
      if (t.z === ref.z || (ignoreCover && this.isCoverTile(t))) continue;
      if (tilesOverlap(ref, { z: t.z, x: t.tileX, y: t.tileY })) return true;
    }
    return false;
  }

  /**
   * Attach a decoded tile to the scene (runs from `applyQueue`, one per
   * frame). Re-validates: the tile may have been cleared / evicted / moved
   * out of the keep zone while it waited.
   */
  private admitTile(key: string, tile: SplatTile): void {
    if (this.queuedTiles.get(key) !== tile) return; // cleared while queued
    this.queuedTiles.delete(key);
    if (
      this.disposed ||
      !this.isActive() ||
      this.disablePending ||
      !this.levelsInPlay().has(tile.z) ||
      !this.isInKeepZone(tile.z, tile.tileX, tile.tileY)
    ) {
      this.disposeTile(key, tile);
      return;
    }
    // NEW GROUND grows (a circle from the tile centre, bridges toward the
    // neighbours); a change of detail IN PLACE — ground another level is
    // already showing — dissolves: full shape at once, fading in.
    const now = this.clock();
    const refs: Array<{ z: number; x: number; y: number }> = [];
    for (const t of this.showingTiles()) refs.push({ z: t.z, x: t.tileX, y: t.tileY });
    tile.appear = appearKind({ z: tile.z, x: tile.tileX, y: tile.tileY }, refs);
    const dissolve = tile.appear === 'dissolve';
    // The same tile's ground may still be lingering from a fade-out (a quick
    // zoom there and back): take over from where it got to — two coplanar
    // grounds of one level would z-fight.
    const ghost = this.groundGhosts.get(key);
    let groundP = dissolve ? 0 : 1;
    if (ghost) {
      groundP = fadeProgress(ghost.groundFade, now, this.levelFadeMs);
      this.dropGhost(key, ghost);
    }
    tile.fade = createFade(dissolve ? 0 : 1, now);
    tile.groundFade = { p: groundP, dir: 0, atMs: now };
    this.writeFade(tile, fadeValue(tile.fade.p), fadeValue(groundP));

    this.tiles.set(key, tile);
    this.group.add(tile.root);
    // Rounded union: a growing tile grows from its centre from NOW (not from
    // when it was decoded) and its neighbours start bridging toward it; a
    // dissolving one is back-dated past the whole animation, so it (and its
    // bridges to settled neighbours) has its final shape at once and the
    // silhouette of the covered region does not move. (With the union off the
    // entry is just the landing time.)
    const inMs = dissolve ? now - unionSettleMs(this.union.growMs) - 1 : now;
    this.presence.set(key, { x: tile.tileX, y: tile.tileY, inMs, outMs: null });
    this.cutoutDirty = true;
    if (this.union.enabled) {
      this.unionDirty = true;
      this.tickUnion();
    }
    // A ripple may have started or ended while the tile sat in the queue.
    this.applyRippleModifier(tile, !!this.ripple);
    // Imagery streams in after the tile is resident (its landing is
    // gated on the tile still being resident).
    if (tile.groundMaterial && this.imageryTemplate) {
      void this.attachImagery(tile);
    } else {
      tile.imageryDone = true;
    }
    this.syncBasemapHidden();
    this.onSceneChange();
  }

  /** Hand the bytes to Spark and place the resulting mesh in the scene frame. */
  private async buildTile(
    z: number,
    x: number,
    y: number,
    key: string,
    data: ArrayBuffer,
    url: string
  ): Promise<SplatTile> {
    const spark = this.spark;
    if (!spark) throw new Error('Spark not loaded');

    const fileType = this.fileType
      ? (spark.SplatFileType?.[this.fileType.toUpperCase()] ?? this.fileType)
      : undefined;
    const mesh = new spark.SplatMesh({ fileBytes: data, fileType, fileName: url });
    mesh.name = `splat-tile:${key}`;
    mesh.layers.set(SPLAT_THREE_LAYER);
    // SplatMap tiles carry degree-0 colour only; pin it so a tile that does
    // ship SH never pays for view-dependent colour in the generate pass.
    mesh.maxSh = 0;
    // Decode (gzip inflate + unpack) runs in Spark's worker pool; this only
    // yields until the packed splat array is back on the main thread.
    await mesh.initialized;

    const { lat: originLat, lon: originLon } = this.projection.origin;
    const t = splatTileTransform(z, x, y, originLat, originLon);
    const root = new THREE.Object3D();
    root.name = `splat-tile-root:${key}`;
    root.position.set(t.position[0], t.position[1], t.position[2]);
    root.rotation.x = t.rotationX;
    root.scale.setScalar(t.scale);
    root.layers.set(SPLAT_THREE_LAYER);
    root.add(mesh);

    // Rounded-union mask: per-tile uniforms (the weights differ per tile),
    // shared by reference between the splat modifier and the ground material.
    const union = this.union.enabled ? createUnionUniforms(this.union.feather) : null;
    const tileMercator = EARTH_CIRCUMFERENCE_M / 2 ** z; // tile edge, mercator metres
    const dyno = this.attachTileModifier(mesh, union, tileMercator);

    // Imagery ground: a tile-sized plane in the tile-local frame (x east,
    // y north, +z normal → scene +Y after the root's rotation), lifted
    // GROUND_LIFT scene metres so it sits just above the vector ground and
    // hides the splats' ragged underside.
    let ground: THREE.Mesh | null = null;
    let groundMaterial: THREE.ShaderMaterial | null = null;
    let fadeU: LevelFadeUniform | null = null;
    if (this.imageryTemplate) {
      const size = tileMercator;
      const geom = new THREE.PlaneGeometry(size, size);
      fadeU = { uLevelFade: { value: 1 } };
      groundMaterial = createSplatGroundMaterial(this.rippleUniforms, union, undefined, fadeU);
      ground = new THREE.Mesh(geom, groundMaterial);
      ground.name = `splat-tile-ground:${key}`;
      ground.position.set(size / 2, size / 2, GROUND_LIFT / t.scale);
      // Drawn before the (transparent, depth-testing) splat mesh so the
      // splats composite over the imagery rather than under it.
      // …and coarser levels before finer ones, which also win the depth test
      // (see GROUND_LEVEL_DEPTH_BIAS) while a level transition overlaps them.
      ground.renderOrder = -2 + z / 32;
      // Starts unbiased; `updateGroundDepthBias()` sets it every frame relative to the coarsest
      // level on screen, so a lone level never hides the base of the walls standing on it.
      groundMaterial.polygonOffset = true;
      groundMaterial.polygonOffsetFactor = 0;
      groundMaterial.polygonOffsetUnits = 0;
      ground.layers.set(SPLAT_THREE_LAYER);
      root.add(ground);
    }
    root.updateMatrixWorld(true);

    const splats = mesh.numSplats ?? mesh.packedSplats?.numSplats ?? 0;
    const tile: SplatTile = {
      key, root, mesh, lite: null, liteState: 'none', objectModifier: dyno?.block ?? null,
      liteModifier: dyno?.liteBlock ?? null, camDyno: dyno?.cam ?? null, camSet: false, cullDraw: true,
      ground, groundMaterial, groundTexture: null, splats,
      worldSize: tileMercator * t.scale,
      distFade: 1, lastSplatFade: 1, lastGroundFade: 1,
      z, tileX: x, tileY: y, rippleOn: false, union,
      unionG: union ? (dyno?.g ?? null) : null,
      unionFeather: union ? (dyno?.feather ?? null) : null,
      evicting: false,
      appear: 'grow', fade: createFade(1, 0), groundFade: createFade(1, 0), fadeU,
      fadeDyno: dyno?.fade ?? null, quadDyno: dyno?.quad ?? null,
      imageryDone: false, preTexture: null, disposed: false, meshGone: false
    };
    // A tile that lands while a ripple is playing joins the current front:
    // the modifier's uniforms are shared, so it needs no catch-up state.
    if (this.ripple && this.rippleDyno) this.applyRippleModifier(tile, true);
    return tile;
  }

  /** Load the tile's imagery and swap it onto the ground plane when it lands. */
  private async attachImagery(tile: SplatTile): Promise<void> {
    let tex: THREE.Texture | null = null;
    try {
      // Requested alongside the tile (prefetch / dissolve candidate)?
      const pre = tile.preTexture;
      tile.preTexture = null;
      tex = pre ? await pre : await this.loadImagery(tile.z, tile.tileX, tile.tileY);
    } catch (err) {
      logger.warn(`splat imagery ${tile.key} failed:`, err instanceof Error ? err.message : String(err));
    }
    if (!tex) {
      // No imagery is coming: a dissolving ground fades in as it is.
      tile.imageryDone = true;
      this.onSceneChange();
      return;
    }
    const landed = tex;
    // Swapping the map forces a (mipmapped) texture upload on the next
    // render — stagger it with the tile landings, one per frame. The tile
    // may have been evicted by the time the slot comes round.
    this.imageryQueue.push(() => {
      if (this.disposed || this.tiles.get(tile.key) !== tile || !tile.groundMaterial) {
        landed.dispose();
        return;
      }
      tile.groundTexture = landed;
      setSplatGroundMap(tile.groundMaterial, landed);
      tile.imageryDone = true;
      this.onSceneChange();
    });
  }

  /**
   * Load a tile's imagery ground, trying the candidate templates in order (see
   * `imageryCandidates`): `@2x.webp` on capable high-DPI devices at the finest level, then
   * `.webp`, then `.png`. A candidate slot that fails 3 times before ever succeeding is dropped.
   */
  private async loadImagery(z: number, x: number, y: number): Promise<THREE.Texture | null> {
    if (!this.imageryTemplate) return null;
    const dpr = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
    const hiRes = !this.lowTier && z >= this.maxTileZoom && dpr >= 1.5;
    const candidates = imageryCandidates(this.imageryTemplate, this.imageryDerived, hiRes);
    for (let i = 0; i < candidates.length; i++) {
      const template = candidates[i];
      const last = i === candidates.length - 1;
      if (!last && (this.imageryMisses.get(template) ?? 0) >= 3) continue;
      let tex: THREE.Texture | null = null;
      try {
        tex = await this.loadTexture(expandTileUrl(template, z, x, y));
      } catch {
        tex = null;
      }
      if (tex) {
        this.imageryMisses.set(template, -Infinity); // proven to exist: never drop this slot
        return tex;
      }
      this.imageryMisses.set(template, (this.imageryMisses.get(template) ?? 0) + 1);
    }
    return null;
  }

  private defaultLoadTexture(url: string): Promise<THREE.Texture | null> {
    const finish = (tex: THREE.Texture): THREE.Texture => {
      tex.colorSpace = THREE.SRGBColorSpace;
      // Sharp at oblique angles: trilinear mipmaps + max anisotropy.
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      this.maxAnisotropy ??= this.renderer.capabilities.getMaxAnisotropy();
      tex.anisotropy = this.maxAnisotropy;
      tex.needsUpdate = true;
      return tex;
    };
    // Decode to an ImageBitmap with every conversion off, and upload THAT. Through an <img>
    // (TextureLoader) the browser converts and copies on upload: measured on an Intel Iris, the
    // 2048² ground images cost 18–30 ms of main thread each (197 ms over a 7-tile load, two to
    // four of them bunching into 72 ms frames) — the landing hitch, not the splats (8 ms for
    // 22 MB of them). A bitmap is already in upload form; flipY is done in the decode so the
    // orientation is the one the <img> path gave (row 0 = the tile's north edge at v = 1).
    // WebGL ignores UNPACK_FLIP_Y for ImageBitmaps, so a browser that does not honour the
    // decode's `imageOrientation: 'flipY'` would show the imagery upside down: it gets the <img>
    // path instead (see bitmapFlipSupported, tested once per page).
    if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
      return (async () => {
        if (!(await bitmapFlipSupported())) return this.loadTextureViaImage(url, finish);
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          const bitmap = await createImageBitmap(await res.blob(), {
            imageOrientation: 'flipY',
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none'
          });
          const tex = new THREE.Texture(bitmap);
          tex.flipY = false;
          // Free the bitmap's memory with the texture (three does not close it for us).
          tex.addEventListener('dispose', () => bitmap.close());
          return finish(tex);
        } catch {
          return null; // 404 / decode failure → plain ground, no retry
        }
      })();
    }
    return this.loadTextureViaImage(url, finish);
  }

  /** The `<img>` path: TextureLoader, three's own flipY on upload. */
  private loadTextureViaImage(url: string, finish: (tex: THREE.Texture) => THREE.Texture): Promise<THREE.Texture | null> {
    return new Promise((resolve) => {
      new THREE.TextureLoader().load(
        url,
        (tex) => resolve(finish(tex)),
        undefined,
        () => resolve(null) // 404 / decode failure → plain ground, no retry
      );
    });
  }

  /** Tile of level `z` under the camera target (cached per tick). */
  private centreAt(z: number): { x: number; y: number } {
    let c = this.centerCache.get(z);
    if (!c) {
      c = lonLatToTile(this.centerLon, this.centerLat, z);
      this.centerCache.set(z, c);
    }
    return c;
  }

  /** Keep zone of tile `z/x/y`: `radius + 1` tiles OF ITS OWN LEVEL. */
  private isInKeepZone(z: number, x: number, y: number): boolean {
    if (!this.hasCenter) return true;
    const c = this.centreAt(z);
    const d = Math.max(Math.abs(x - c.x), Math.abs(y - c.y));
    return d <= this.currentRadius() + 1;
  }

  // -------------------------------------------------------------------------
  // Internals — pyramid level
  // -------------------------------------------------------------------------

  /**
   * The tiles the layer WANTS right now, keyed by `tileKey`, each carrying the level to load it
   * at. Today every entry shares one level — this is the single-level window, unchanged — but it
   * is the one place that answers "which ground, at what level", which is what per-tile level
   * selection needs to vary (see docs/per-tile-lod.md). Callers that only need membership should
   * ask here rather than re-deriving a range, so that when the set stops being a square they do
   * not silently keep testing a square.
   *
   * Ordering is NOT meaningful here: the load loop still ranks by screen relevance separately.
   */
  private desiredTiles(z: number): Map<string, { z: number; x: number; y: number }> {
    const c = this.centreAt(z);
    const out = new Map<string, { z: number; x: number; y: number }>();
    for (const [x, y] of enumerateTileWindow(z, c.x, c.y, this.currentRadius())) {
      out.set(tileKey(z, x, y), { z, x, y });
    }
    // The cover level's own window under it (see coverZ): the same radius at a level whose
    // tiles are twice the size, so it reaches well past the detail window.
    const cz = this.coverZ();
    if (cz !== null && z === this.activeZ) {
      const cc = this.centreAt(cz);
      for (const [x, y] of enumerateTileWindow(cz, cc.x, cc.y, this.currentRadius())) {
        out.set(tileKey(cz, x, y), { z: cz, x, y });
      }
    }
    return out;
  }

  /** Every tile the layer wants at level `z` is a known 404. */
  private windowAllMissing(z: number): boolean {
    for (const key of this.desiredTiles(z).keys()) {
      if (!this.missing.has(key)) return false;
    }
    return true;
  }

  /**
   * The level to load for a wanted level: itself, unless its whole window
   * here is known to be missing — then the next finer level that isn't, then
   * the coarser ones (`lodFallbackOrder`). A tile set that ships only part of
   * the pyramid (z16 alone, or a pyramid still being built) keeps showing at
   * every camera zoom instead of going blank; the 404s are remembered, so
   * the probe costs one window of requests per level per place.
   */
  private resolveActiveLevel(wanted: number): number {
    if (this.missing.size === 0) return wanted;
    for (const z of lodFallbackOrder(wanted, this.minTileZoom, this.maxTileZoom)) {
      if (!this.windowAllMissing(z)) return z;
    }
    return wanted;
  }

  /**
   * Start a level transition. The new level loads from the next loop pass
   * (nearest-first); fetches and decoded-but-unseen tiles of any OTHER level
   * are abandoned; RESIDENT tiles of the old level are left alone — they stay
   * until `isCovered()` says the new level has taken over their ground (or
   * the budget needs them, or they drift out of range).
   */
  private switchLevel(z: number): void {
    this.syncLevelFadeMs(); // (the reduced-motion preference may have changed)
    this.activeZ = z;
    this.hasCenter = false; // the centre tile is per level
    this.overBudget.clear();
    // Work in flight is discarded by LEVEL, not by window membership: a tile at a level still in
    // play but outside the window is left alone here, because the budget and keep-zone rules own
    // that decision. Asking `levelsInPlay()` rather than comparing to `activeZ` is what lets the
    // set hold more than one level later without this reconciliation quietly dropping the
    // coarse half of a cut (see docs/per-tile-lod.md).
    const live = this.levelsInPlay();
    for (const [key, p] of this.pending) if (!live.has(p.z)) this.pending.delete(key);
    for (const [key, tile] of this.queuedTiles) {
      if (live.has(tile.z)) continue;
      this.queuedTiles.delete(key);
      this.disposeTile(key, tile);
    }
    for (const [key, p] of [...this.parked]) {
      if (live.has(p.tile.z)) continue;
      this.parked.delete(key);
      this.disposeTile(key, p.tile);
    }
    // Prefetched across the threshold: what was decoded for a level still in play goes straight
    // to admission (the dissolve starts this frame); the rest goes.
    for (const [key, tile] of [...this.prefetched]) {
      this.prefetched.delete(key);
      if (live.has(tile.z) && this.isInKeepZone(tile.z, tile.tileX, tile.tileY)) {
        this.commitTile(key, tile);
      } else {
        this.disposeTile(key, tile);
      }
    }
    this.onSceneChange();
  }

  /**
   * The pyramid levels the layer is currently willing to hold tiles at.
   *
   * Today this is exactly one — `activeZ` — so every caller behaves as it always has. It exists so
   * that the places which decide "is this tile still relevant" ask a SET rather than compare to a
   * single level: with a quadtree cut in play the answer becomes several levels at once, and a
   * comparison against `activeZ` would silently discard the coarse tiles of the far field.
   */
  private levelsInPlay(): Set<number> {
    if (this.activeZ === null) return new Set();
    const cz = this.coverZ();
    return cz === null ? new Set([this.activeZ]) : new Set([this.activeZ, cz]);
  }

  /**
   * The cover level: one coarser than the detail level, kept resident under the detail window
   * (see `splats.cover`). None when the option is off, on the low tiers (memory), or when the
   * pyramid has no coarser level.
   */
  private coverZ(): number | null {
    if (!this.cover || this.lowTier || this.activeZ === null) return null;
    const cz = this.activeZ - 1;
    return cz >= this.minTileZoom ? cz : null;
  }

  private isCoverTile(tile: { z: number }): boolean {
    const cz = this.coverZ();
    return cz !== null && tile.z === cz;
  }

  /** Resident + queued tiles at a level the layer is still holding. */
  private activeLevelTiles(): number {
    const live = this.levelsInPlay();
    let n = 0;
    for (const t of this.tiles.values()) if (live.has(t.z)) n++;
    for (const t of this.queuedTiles.values()) if (live.has(t.z)) n++;
    return n;
  }

  /** Splats held by resident tiles at a level that is NO LONGER in play — i.e. superseded
   *  tiles still on screen for the length of a transition, not part of the current picture. */
  private oldLevelSplats(): number {
    const live = this.levelsInPlay();
    let n = 0;
    for (const t of this.tiles.values()) if (!live.has(t.z)) n += t.splats;
    return n;
  }

  /** Tile `key` is resident and staying (it dissolves in from that moment). */
  private isLanded(key: string): boolean {
    const tile = this.tiles.get(key);
    if (!tile || tile.evicting) return false;
    return (this.presence.get(key)?.outMs ?? null) === null;
  }

  /** Nothing more will change at `key`: landed, or never going to land. */
  private isSettled(key: string): boolean {
    return this.isLanded(key) || this.missing.has(key) || this.overBudget.has(key);
  }

  /**
   * Have the tiles the layer WANTS taken over `tile`'s ground?
   *
   * Asked of a resident tile that is no longer wanted, to decide when it may go. Phrased against
   * `desiredTiles()` rather than against "the active level" so that it keeps working once the
   * wanted set spans several levels (see docs/per-tile-lod.md): it never assumes the replacements
   * form a contiguous range, only that they are the wanted tiles lying over this ground.
   *
   * The two directions need DIFFERENT evidence, and that asymmetry is deliberate:
   *
   *  - a COARSER replacement must have LANDED. There is one tile over this ground, so if it is a
   *    404 there is nothing there at all — the detailed tile stays as a fallback while in range.
   *  - FINER replacements need only be SETTLED (landed, or known not to be coming). There are
   *    many, and one missing child just means no data for that patch; the coarse tile has still
   *    been superseded everywhere something was going to arrive. Until they are all settled it
   *    fades only WHERE a child dissolved in over it, per quadrant — see `tickLevelFade`.
   *
   * A tile with NO wanted tile over its ground (the old window's periphery) waits for the whole
   * wanted set to settle, so the edge does not fall away before the centre has refined.
   */
  private isCovered(tile: SplatTile): boolean {
    const za = this.activeZ;
    if (za === null) return false;
    const wanted = this.desiredTiles(za);
    // Still wanted → by definition nothing has replaced it.
    if (wanted.has(tileKey(tile.z, tile.tileX, tile.tileY))) return false;
    // Same level but out of the window: it is simply out of range, not covered.
    if (za === tile.z) return false;

    const r = tileCoverRange(tile.z, tile.tileX, tile.tileY, za);
    if (za < tile.z) return this.isLanded(tileKey(za, r.x0, r.y0));

    let overlapped = false;
    for (const { x, y } of wanted.values()) {
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      overlapped = true;
      if (!this.isSettled(tileKey(za, x, y))) return false;
    }
    if (overlapped) return true;
    for (const key of wanted.keys()) if (!this.isSettled(key)) return false;
    return true;
  }

  /**
   * Free at least `needed` splats by dropping OLD-level tiles (a level
   * transition in progress): the ones already shrinking out first, then the
   * least relevant on screen. Immediate, like every budget eviction. Returns
   * the splats freed (possibly short of `needed`).
   */
  private evictOldLevel(needed: number): number {
    if (needed <= 0) return 0;
    const candidates: Array<{ key: string; tile: SplatTile; leaving: boolean; shown: number; d: number }> = [];
    const now = this.clock();
    const live = this.levelsInPlay(); // hoisted out of the loop
    for (const [key, tile] of this.tiles) {
      if (live.has(tile.z)) continue;
      candidates.push({
        key, tile,
        leaving: (this.presence.get(key)?.outMs ?? null) !== null,
        // Quantised, so tiles fading together still rank by relevance.
        shown: Math.round(fadeProgress(tile.fade, now, this.levelFadeMs) * 4),
        d: tileScreenRelevance(tile.z, tile.tileX, tile.tileY, this.frame)
      });
    }
    if (candidates.length === 0) return 0;
    // The ones already shrinking out, then the most faded, then the least relevant.
    candidates.sort((a, b) => Number(b.leaving) - Number(a.leaving) || a.shown - b.shown || b.d - a.d);
    let freed = 0;
    for (const c of candidates) {
      if (freed >= needed) break;
      this.removeTile(c.key, c.tile);
      freed += c.tile.splats;
    }
    this.syncBasemapHidden();
    this.onSceneChange();
    return freed;
  }

  private evictFarTiles(): void {
    if (!this.hasCenter) return;
    let changed = false;
    for (const [key, tile] of this.tiles) {
      const p = this.unionAnimated() ? this.presence.get(key) : undefined;
      // A tile stays while it is in range of ITS level's window. (A tile of
      // the old level whose ground the active level has taken over does not
      // shrink out — it DISSOLVES out: `tickLevelFade`.)
      const stays = this.isInKeepZone(tile.z, tile.tileX, tile.tileY);
      if (stays) {
        // Back in range (or its level active again) before it finished
        // shrinking → grow back from where it got to. (Not a tile the
        // governor gave up: that one leaves for the budget's sake.)
        if (p && p.outMs !== null && !tile.evicting) this.cancelLeave(p);
        continue;
      }
      if (p) {
        // Shrink out of the union first (UNION_LEAVE_MS); `tickUnion` removes
        // the tile when it has gone. This path is never the one that frees
        // budget — `evictFartherThan` / `enforceBudget` drop at once.
        if (p.outMs === null) {
          p.outMs = this.clock();
          this.unionDirty = true;
        }
        continue;
      }
      this.removeTile(key, tile);
      changed = true;
    }
    if (changed) {
      this.syncBasemapHidden();
      this.onSceneChange();
    }
  }

  /**
   * Free at least `needed` splats of budget by evicting resident / queued
   * tiles OF THE ACTIVE LEVEL that matter clearly LESS on screen than tile
   * `(x, y)` (`tileScreenRelevance`, with hysteresis — see
   * `EVICT_SCORE_RATIO`), least relevant first (old-level tiles go through
   * `evictOldLevel`). Returns the number of splats actually freed (0 when
   * nothing qualifies, or `needed` ≤ 0). Never touches tiles that matter as
   * much — the caller decides what to do when the freed amount falls short.
   */
  private evictFartherThan(z: number, x: number, y: number, needed: number): number {
    if (needed <= 0 || !this.hasCenter || this.activeZ === null) return 0;
    const f = this.frame;
    // Score the incoming tile at ITS OWN level: with a cut in play the candidate may be coarser
    // than `activeZ`, and scoring it as though it were fine would understate how far away it is.
    const mine = tileScreenRelevance(z, x, y, f) * EVICT_SCORE_RATIO + EVICT_SCORE_SLACK;
    const candidates: Array<{ key: string; tile: SplatTile; d: number }> = [];
    const live = this.levelsInPlay(); // hoisted: both loops below run every frame
    for (const [key, tile] of this.tiles) {
      if (!live.has(tile.z) || tile.evicting || this.isCoverTile(tile)) continue;
      const d = tileScreenRelevance(tile.z, tile.tileX, tile.tileY, f);
      if (d > mine) candidates.push({ key, tile, d });
    }
    for (const [key, tile] of this.queuedTiles) {
      if (!live.has(tile.z) || this.isCoverTile(tile)) continue;
      const d = tileScreenRelevance(tile.z, tile.tileX, tile.tileY, f);
      if (d > mine) candidates.push({ key, tile, d });
    }
    // Only worth it if those tiles can actually cover the shortfall.
    let available = 0;
    for (const c of candidates) available += c.tile.splats;
    if (available < needed) return 0;
    candidates.sort((a, b) => b.d - a.d);
    let freed = 0;
    for (const c of candidates) {
      if (freed >= needed) break;
      this.dropTile(c.key, c.tile);
      freed += c.tile.splats;
    }
    if (freed > 0) {
      this.syncBasemapHidden();
      this.onSceneChange();
    }
    return freed;
  }

  /**
   * Bring residency back under the current budget (after a tier swap, an
   * option change or a governor step), old-level tiles first, then the least
   * relevant on screen, always keeping at least one tile. Returns whether
   * anything was evicted.
   */
  private enforceBudget(graceful = false): boolean {
    const budget = this.currentMaxSplats();
    let changed = false;
    if (this.currentRadius() < this.radius) {
      for (const [key, tile] of this.tiles) {
        if (this.isInKeepZone(tile.z, tile.tileX, tile.tileY)) continue;
        this.removeTile(key, tile);
        changed = true;
      }
    }
    const over = this.committedSplats() - budget;
    if (over > 0 && this.committedTiles() > 1 && this.activeLevelTiles() > 0) {
      if (this.evictOldLevel(over) > 0) changed = true;
    }
    while (this.committedTiles() > 1 && this.committedSplats() > budget) {
      let far: { key: string; tile: SplatTile; d: number } | null = null;
      const consider = (key: string, tile: SplatTile): void => {
        if (tile.evicting || this.isCoverTile(tile)) return;
        const d = tileScreenRelevance(tile.z, tile.tileX, tile.tileY, this.frame);
        if (!far || d > far.d) far = { key, tile, d };
      };
      for (const [key, tile] of this.tiles) consider(key, tile);
      for (const [key, tile] of this.queuedTiles) consider(key, tile);
      if (!far) break;
      const { key, tile } = far as { key: string; tile: SplatTile };
      const p = this.presence.get(key);
      if (graceful && this.unionAnimated() && p && this.tiles.get(key) === tile) {
        // Shrink out of the union; `tickUnion` removes it when it has gone.
        tile.evicting = true;
        p.outMs ??= this.clock();
        this.unionDirty = true;
      } else {
        this.dropTile(key, tile);
      }
      changed = true;
    }
    return changed;
  }

  /** Remove a tile whether it is resident or still queued for admission. */
  private dropTile(key: string, tile: SplatTile): void {
    if (this.tiles.get(key) === tile) {
      this.removeTile(key, tile);
    } else if (this.queuedTiles.get(key) === tile) {
      this.queuedTiles.delete(key);
      this.disposeTile(key, tile);
    }
  }

  private removeTile(key: string, tile: SplatTile): void {
    this.cutoutDirty = true;
    this.group.remove(tile.root);
    this.disposeTile(key, tile);
    this.tiles.delete(key);
    this.retirePresence(key);
  }

  /**
   * A tile's splats have dissolved out: release them NOW (that is the budget
   * the transition borrowed). Its imagery ground — a textured quad, no splat
   * cost — lingers as a "ghost" until the level over it is opaque, then fades
   * (`tickLevelFade`), so the basemap never shows between two levels.
   */
  private releaseSplats(key: string, tile: SplatTile): void {
    if (!tile.ground || !tile.groundMaterial) {
      this.removeTile(key, tile);
      return;
    }
    this.cutoutDirty = true;
    this.tiles.delete(key);
    this.retirePresence(key);
    this.disposeLite(tile);
    tile.root.remove(tile.mesh);
    try {
      tile.mesh.dispose();
    } catch (err) {
      logger.warn(`splat tile ${key} dispose failed:`, err instanceof Error ? err.message : String(err));
    }
    tile.meshGone = true;
    tile.splats = 0;
    const old = this.groundGhosts.get(key);
    if (old) this.dropGhost(key, old);
    this.groundGhosts.set(key, tile);
  }

  private dropGhost(key: string, ghost: SplatTile): void {
    this.groundGhosts.delete(key);
    this.group.remove(ghost.root);
    this.disposeTile(key, ghost);
    this.cutoutDirty = true;
  }

  /** The presence entry of a tile that just left `tiles`. */
  private retirePresence(key: string): void {
    // The tile is gone NOW (its memory may be needed); what stays behind is
    // a timestamp, so the neighbours' joins toward it retract over
    // UNION_LEAVE_MS instead of snapping to round corners.
    const p = this.presence.get(key);
    if (!p) return;
    if (!this.union.enabled) {
      this.presence.delete(key); // only a landing time — no mask to retract
      return;
    }
    if (this.unionAnimated()) {
      p.outMs ??= this.clock();
      this.unionDirty = true;
    } else {
      this.presence.delete(key);
      this.unionDirty = true;
    }
  }

  private disposeTile(key: string, tile: SplatTile): void {
    tile.disposed = true;
    this.disposeLite(tile);
    if (!tile.meshGone) {
      try {
        tile.mesh.dispose();
      } catch (err) {
        logger.warn(`splat tile ${key} dispose failed:`, err instanceof Error ? err.message : String(err));
      }
      tile.meshGone = true;
    }
    // Imagery requested ahead of the tile and never handed over.
    void tile.preTexture?.then((tex) => tex?.dispose());
    tile.preTexture = null;
    tile.ground?.geometry.dispose();
    tile.groundMaterial?.dispose();
    tile.groundTexture?.dispose();
    tile.groundTexture = null;
  }

  private clearTiles(): void {
    // A new source means new meshes: let the pre-warm run again (it is a no-op if already compiled).
    this.prewarm = this.prewarm === 'rendering' ? 'done' : this.prewarm;
    for (const [key, tile] of this.tiles) this.removeTile(key, tile);
    this.tiles.clear();
    // Nothing left to join to — no ghosts to fade either.
    this.presence.clear();
    this.unionDirty = false;
    for (const [key, tile] of this.queuedTiles) this.disposeTile(key, tile);
    this.queuedTiles.clear();
    for (const [key, tile] of this.prefetched) this.disposeTile(key, tile);
    this.prefetched.clear();
    for (const [key, p] of this.parked) this.disposeTile(key, p.tile);
    this.parked.clear();
    this.prefetchZ = null;
    for (const [key, ghost] of [...this.groundGhosts]) this.dropGhost(key, ghost);
    this.levelFading = false;
    this.overSinceMs = null;
    this.applyQueue.length = 0;
    // Queued imagery closures re-validate their tile and self-dispose, but
    // run them now so their textures don't linger until the next frames.
    for (const fn of this.imageryQueue.splice(0)) fn();
    this.overBudget.clear();
    // Dropping the pending tokens makes in-flight loads discard their result
    // (see the `live()` re-checks in loadTile).
    this.pending.clear();
    // Keep `missing` — those tiles genuinely have no data; re-checking wastes
    // requests. (Cleared only on dispose.)
    this.syncBasemapHidden();
  }

  /**
   * While ≥ 1 splat tile is resident the basemap gives way — globally
   * (`hideBasemap: true`: the layers hide) or per region (`'covered'`: the
   * cut-out sink removes it under the landed tiles only).
   */
  private syncBasemapHidden(): void {
    const showing =
      this.tiles.size + this.groundGhosts.size > 0 && (this.isActive() || this.disablePending);
    const covered = showing && this.hideBasemap === 'covered' && this.cutout !== null;
    if (covered !== this.basemapCovered) {
      this.basemapCovered = covered;
      this.cutoutDirty = true;
    }
    const want = showing && this.hideBasemap === true;
    if (want === this.basemapHidden) return;
    this.basemapHidden = want;
    this.setBasemapHiddenCb?.(want);
  }

  /**
   * Hand the cut-out sink the resident tiles with the mask values their GPU
   * mask is using RIGHT NOW (read back from the very uniforms), so the
   * vector map's cut is the complement of what the imagery draws. Runs only
   * after something changed: a tile landed or left, a union value moved, the
   * mode was switched.
   */
  private flushCutout(): void {
    if (!this.cutoutDirty) return;
    this.cutoutDirty = false;
    const sink = this.cutout;
    if (!sink) return;
    if (!this.basemapCovered) {
      sink.setCutoutMode(0);
      sink.setCutout([], this.union.feather);
      return;
    }
    // Every level cuts (the sink takes the max), fading tiles and lingering
    // grounds included: during a dissolve the cut is the union of BOTH
    // levels' settled shapes. `fade` only matters on ground no other tile
    // cuts: there the vector map fades out as the imagery fades in.
    const list = this.cutoutScratch;
    let n = 0;
    for (const tile of [...this.tiles.values(), ...this.groundGhosts.values()]) {
      const entry = (list[n] ??= { z: 0, x: 0, y: 0, g: 1, fade: 1 });
      entry.fade = tile.fadeU ? tile.fadeU.uLevelFade.value : 1;
      entry.z = tile.z;
      entry.x = tile.tileX;
      entry.y = tile.tileY;
      const u = tile.union;
      if (u) {
        const v = (entry.values ??= new Float64Array(16));
        u.uUnionEdge.value.toArray(v, 0);
        u.uUnionCorner.value.toArray(v, 4);
        u.uUnionEdgeG.value.toArray(v, 8);
        u.uUnionCornerG.value.toArray(v, 12);
        entry.g = u.uUnionG.value;
      } else {
        entry.values = undefined; // rounded union off: a plain square
        entry.g = 1;
      }
      n++;
    }
    list.length = n;
    sink.setCutout(list, this.union.feather);
    sink.setCutoutMode(this.keepLabels ? 1 : 2);
  }

  // -------------------------------------------------------------------------
  // Internals — rounded union
  // -------------------------------------------------------------------------

  /** Whether union membership changes animate (else they apply at once). */
  private unionAnimated(): boolean {
    return this.union.enabled && this.union.growMs > 0;
  }

  /**
   * Give a tile's SplatMesh its union-mask modifier: a Spark `objectModifier`
   * (tile-local frame, so `(u, v) = center.xy / tileSize` with v north) that
   * multiplies scale and opacity by the SAME GLSL function the ground uses.
   * It composes with the ripple's `worldModifier` by multiplication. Returns
   * the growth + feather uniforms (the weight vectors are shared with `union`
   * by reference); null when this Spark build has no raw-GLSL dyno node.
   */
  private attachTileModifier(
    mesh: SparkSplatMeshLike,
    unionOrNull: UnionUniforms | null,
    tileSize: number
  ): {
    g: DynoUniformLike<number>;
    feather: DynoUniformLike<number>;
    fade: DynoUniformLike<number>;
    quad: DynoUniformLike<THREE.Vector4>;
    block: DynoNode;
    liteBlock: DynoNode;
    cam: DynoUniformLike<THREE.Vector3> | null;
  } | null {
    const d = this.spark?.dyno;
    if (!d?.Dyno || !d.dynoVec4) return null;
    const DynoCtor = d.Dyno;
    // Rounded union off: the mask is skipped (negative feather), the level
    // dissolve still applies.
    const union = unionOrNull ?? createUnionUniforms(-1);
    // Level cross-dissolve: the tile's own fade, and per quadrant (SW, SE,
    // NW, NE) how far a child tile has dissolved in over it.
    const fade = d.dynoFloat(1);
    const quad = d.dynoVec4(new THREE.Vector4(0, 0, 0, 0));
    const edge = d.dynoVec4(union.uUnionEdge.value);
    const corner = d.dynoVec4(union.uUnionCorner.value);
    const edgeG = d.dynoVec4(union.uUnionEdgeG.value);
    const cornerG = d.dynoVec4(union.uUnionCornerG.value);
    const g = d.dynoFloat(union.uUnionG.value);
    const invSize = (1 / tileSize).toExponential(8);
    // A uniform, not a baked constant: `applyOptions` retunes it live.
    const feather = d.dynoFloat(union.uUnionFeather.value);
    this.thinDyno ??= d.dynoFloat(1);
    this.liteThinDyno ??= d.dynoFloat(1);
    this.thinBandDyno ??= d.dynoFloat(0);
    this.zeroBandDyno ??= d.dynoFloat(0);
    this.densityDyno ??= d.dynoFloat(0);
    const density = this.densityDyno;
    this.backfaceDyno ??= d.dynoFloat(this.cullBackFaces ? 1 : 0);
    const cull = this.backfaceDyno;
    // Density LOD needs the camera in object space; without a vec3 uniform it is simply off.
    const cam = d.dynoVec3 ? d.dynoVec3(new THREE.Vector3()) : null;
    // Two graphs over the SAME tile uniforms (union, fade, quadrants): the full mesh's and the lite
    // mesh's, which differ only in their thinning inputs.
    const build = (keep: DynoUniformLike<number>, band: DynoUniformLike<number>): DynoNode =>
      d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
      const { center, scales, quaternion, opacity, index, flags } = d.splitGsplat(gsplat).outputs;
      const node = new DynoCtor({
        inTypes: {
          center: 'vec3', edge: 'vec4', corner: 'vec4', edgeG: 'vec4', cornerG: 'vec4', g: 'float',
          feather: 'float', fade: 'float', quad: 'vec4', index: 'int', flags: 'uint', keep: 'float',
          band: 'float', scales: 'vec3', density: 'float', quaternion: 'vec4', cull: 'float',
          ...(cam ? { cam: 'vec3' } : {})
        },
        outTypes: { scale: 'float', alpha: 'float', flags: 'uint' },
        inputs: {
          center, edge, corner, edgeG, cornerG, g, feather, fade, quad, index, flags, keep, band, scales, density,
          quaternion, cull, ...(cam ? { cam } : {})
        },
        globals: () => [ROUNDED_UNION_GLSL, THIN_GLSL, BACKFACE_GLSL],
        statements: ({ inputs, outputs }) => [
          `vec2 hbdUv = ${inputs.center}.xy * ${invSize};`,
          `float hbdMask = ${inputs.feather} >= 0.0 ? hbdRoundedUnionMask(hbdUv, ` +
            `${inputs.edge}, ${inputs.corner}, ${inputs.edgeG}, ${inputs.cornerG}, ` +
            `${inputs.g}, ${inputs.feather}) : 1.0;`,
          // Level dissolve: opacity × fade, scale × mix(0.6, 1, fade) — two
          // dense overlapping sets at full size read as doubled. Under a child
          // that has dissolved in, this (coarser) tile is gone already.
          `float hbdQ = hbdUv.y >= 0.5 ? (hbdUv.x >= 0.5 ? ${inputs.quad}.w : ${inputs.quad}.z)` +
            ` : (hbdUv.x >= 0.5 ? ${inputs.quad}.y : ${inputs.quad}.x);`,
          `float hbdFade = clamp(min(${inputs.fade}, 1.0 - hbdQ), 0.0, 1.0);`,
          // Screen-space density (far splats that share a pixel), then motion thinning, as ONE kept
          // fraction on one hash: a dropped splat leaves Spark's sort and draw entirely (inactive
          // flag); the kept ones grow by 1/sqrt(keep) so the surface stays covered.
          `float hbdKeepD = ${cam ? `hbdDensityKeep(${inputs.center}, ${inputs.cam}, ${inputs.scales}, ${inputs.density})` : '1.0'};`,
          `vec2 hbdThinW = hbdThin(${inputs.index}, ${inputs.keep} * hbdKeepD, ${inputs.band});`,
          // The far side of a building (a surfel facing away, see backface.ts) leaves too.
          `float hbdFront = ${cam ? `${inputs.cull} > 0.5 ? hbdFrontFacing(${inputs.center}, ${inputs.scales}, ${inputs.quaternion}, ${inputs.cam}) : 1.0` : '1.0'};`,
          `${outputs.alpha} = hbdMask * hbdFade * hbdThinW.y * hbdFront;`,
          // Fully faded (a parent quadrant under a landed child) leaves the sort and draw too.
          `${outputs.flags} = (hbdThinW.x > 0.0 && hbdFade > 0.0 && hbdFront > 0.0) ? ${inputs.flags} : 0u;`,
          `${outputs.scale} = hbdThinW.x * hbdMask * mix(${LEVEL_FADE_MIN_SCALE.toFixed(2)}, 1.0, hbdFade);`
        ]
      }).outputs;
      return {
        gsplat: d.combineGsplat({
          gsplat,
          scales: d.mul(scales, node.scale),
          opacity: d.mul(opacity, node.alpha),
          flags: node.flags
        })
      };
    });
    const block = build(this.thinDyno, this.thinBandDyno);
    mesh.objectModifier = block;
    // No updateGenerator(): a fresh SplatMesh builds its generator on its
    // first frame, modifiers included. `liteBlock` is returned for the motion-LoD lite mesh: the
    // same tile uniforms, its own thinning.
    return { g, feather, fade, quad, block, liteBlock: build(this.liteThinDyno, this.zeroBandDyno), cam };
  }

  // -------------------------------------------------------------------------
  // Internals — level cross-dissolve
  // -------------------------------------------------------------------------

  /** Write a tile's fade values to the GPU. @returns whether anything moved. */
  private writeFade(tile: SplatTile, splat: number, ground: number, quad?: readonly number[]): boolean {
    let moved = false;
    let bump = false;
    tile.lastSplatFade = splat;
    tile.lastGroundFade = ground;
    // The distance cutoff rides on top of the level fade, and only on the SPLATS — the imagery
    // ground plane keeps drawing out there, which is the whole point of the cutoff.
    splat *= tile.distFade;
    if (tile.fadeDyno && tile.fadeDyno.value !== splat) {
      tile.fadeDyno.value = splat;
      bump = true;
    }
    const q = tile.quadDyno?.value;
    if (q && quad && (q.x !== quad[0] || q.y !== quad[1] || q.z !== quad[2] || q.w !== quad[3])) {
      q.set(quad[0], quad[1], quad[2], quad[3]);
      bump = true;
    }
    if (bump && !tile.meshGone) {
      this.bumpTile(tile);
      moved = true;
    }
    if (tile.fadeU && tile.fadeU.uLevelFade.value !== ground) {
      tile.fadeU.uLevelFade.value = ground;
      this.cutoutDirty = true;
      moved = true;
    }
    return moved;
  }

  /** An active-level tile is resident over (part of) old-level tile `tile`. */
  private hasLandedCover(tile: SplatTile): boolean {
    const ref = { z: tile.z, x: tile.tileX, y: tile.tileY };
    const live = this.levelsInPlay(); // hoisted out of the loop
    for (const [key, t] of this.tiles) {
      if (!live.has(t.z) || t.z === tile.z || !this.isLanded(key)) continue;
      if (tilesOverlap(ref, { z: t.z, x: t.tileX, y: t.tileY })) return true;
    }
    return false;
  }

  /** Every other-level ground over / under `tile` is opaque (or has none) —
   *  `tile`'s own ground may go without the basemap showing through. */
  private coverGroundReady(tile: SplatTile, now: number): boolean {
    const ref = { z: tile.z, x: tile.tileX, y: tile.tileY };
    for (const [key, t] of this.tiles) {
      if (t.z === tile.z || !t.groundMaterial || !this.isLanded(key)) continue;
      if (!tilesOverlap(ref, { z: t.z, x: t.tileX, y: t.tileY })) continue;
      if (fadeProgress(t.groundFade, now, this.levelFadeMs) < 1) return false;
    }
    return true;
  }

  /**
   * Advance the level cross-dissolve. Per resident tile:
   *
   *  - a tile of the ACTIVE level heads for 1 (a dissolving tile from 0, a
   *    tile that was fading out when the camera zoomed back from wherever it
   *    had got to — never a restart, never a refetch);
   *  - a tile of another level heads for 0 once the active level has taken
   *    its ground over (`isCovered`), or — budget pressure — as soon as one
   *    covering tile has landed while the splats are over budget. Before
   *    that, zooming IN by one level, it fades per QUADRANT with the child
   *    dissolving in over it, so both levels are never at full opacity in
   *    the same place;
   *  - when its splats reach 0 they are released at once (`releaseSplats`);
   *    the imagery ground holds at 1 until the ground over it is opaque and
   *    only then fades, and an incoming ground waits for its imagery, so the
   *    vector basemap / bare ground never shows between two levels.
   *
   * The allowance is time-limited: over budget with an old level resident for
   * more than `levelFadeMs + 250 ms` → the old level gives way at once.
   */
  /**
   * Bias each tile's imagery ground relative to the coarsest level resident (see
   * `groundDepthBias`). Cheap: a handful of tiles, two number writes each, no recompile --
   * polygon offset is render state, not a shader define.
   */
  private updateGroundDepthBias(): void {
    let coarsest = Infinity;
    for (const tile of this.tiles.values()) {
      if (tile.groundMaterial && !tile.disposed) coarsest = Math.min(coarsest, tile.z);
    }
    if (coarsest === Infinity) return;
    for (const tile of this.tiles.values()) {
      const m = tile.groundMaterial;
      if (!m) continue;
      const bias = groundDepthBias(tile.z, coarsest, GROUND_LEVEL_DEPTH_BIAS);
      if (m.polygonOffsetFactor !== bias) {
        m.polygonOffsetFactor = bias;
        m.polygonOffsetUnits = bias;
      }
    }
  }

  private tickLevelFade(): void {
    this.updateGroundDepthBias();
    if (this.tiles.size === 0 && this.groundGhosts.size === 0) {
      this.levelFading = false;
      this.overSinceMs = null;
      return;
    }
    const now = this.clock();
    const ms = this.levelFadeMs;
    const za = this.activeZ;
    let fading = false;
    let moved = false;
    let removed = false;

    const budget = this.currentMaxSplats();
    let over = this.committedSplats() - budget;
    if (over > 0 && this.oldLevelSplats() > 0 && this.activeLevelTiles() > 0) {
      this.overSinceMs ??= now;
      if (now - this.overSinceMs > ms + TRANSITION_GRACE_MS) {
        if (this.evictOldLevel(over) > 0) removed = true;
        over = this.committedSplats() - budget;
      }
    } else {
      this.overSinceMs = null;
    }

    const quad = [0, 0, 0, 0];
    for (const [key, tile] of [...this.tiles]) {
      const leaving = tile.evicting || (this.presence.get(key)?.outMs ?? null) !== null;
      let target: 0 | 1 = 1;
      if (leaving) {
        target = tile.fade.dir < 0 ? 0 : 1; // on its way out of range: leave the fade be
      } else if (za !== null && tile.z !== za && !this.isCoverTile(tile)) {
        if (this.isCovered(tile) || (over > 0 && this.hasLandedCover(tile))) target = 0;
      }
      // A detail tile over a LANDED cover parent draws square: its rounded-union corners would
      // open a wedge where the parent's quadrant has faded out under it. The vector cut-out and
      // the imagery keep their shapes; only the splat mask is lifted.
      if (tile.unionFeather && za !== null && tile.z === za) {
        const cz = this.coverZ();
        const square = cz !== null && this.isLanded(tileKey(cz, tile.tileX >> 1, tile.tileY >> 1));
        const want = square ? -1 : this.union.feather;
        if (tile.unionFeather.value !== want) {
          tile.unionFeather.value = want;
          this.bumpTile(tile);
          moved = true;
        }
      }
      const p = fadeToward(tile.fade, target, now, ms);
      if (target === 0 && p <= 0 && !leaving) {
        this.releaseSplats(key, tile);
        removed = true;
        moved = true;
        continue;
      }
      // Ground: in with the imagery, out only via the ghost phase — unless it
      // never got to opaque, then it simply turns round with the splats.
      const g = tile.groundFade;
      const gNow = fadeProgress(g, now, ms);
      let gp = gNow;
      if (target === 0 && gNow < 1) gp = fadeToward(g, 0, now, ms);
      else if (tile.imageryDone || tile.appear === 'grow') gp = fadeToward(g, 1, now, ms);
      else {
        g.p = gNow; // waiting for the imagery
        g.dir = 0;
        g.atMs = now;
      }
      // Zooming in by one level: fade where a child has dissolved in.
      quad[0] = quad[1] = quad[2] = quad[3] = 0;
      if (za !== null && za === tile.z + 1) {
        const ref = { z: tile.z, x: tile.tileX, y: tile.tileY };
        for (let cx = tile.tileX * 2; cx <= tile.tileX * 2 + 1; cx++) {
          for (let cy = tile.tileY * 2; cy <= tile.tileY * 2 + 1; cy++) {
            const ck = tileKey(za, cx, cy);
            const child = this.tiles.get(ck);
            if (!child || !this.isLanded(ck)) continue;
            const qi = childQuadrant(ref, { z: za, x: cx, y: cy });
            if (qi >= 0) quad[qi] = fadeValue(fadeProgress(child.fade, now, ms));
          }
        }
      }
      if (this.writeFade(tile, fadeValue(p), fadeValue(gp), quad)) moved = true;
      if (tile.fade.dir !== 0 || g.dir !== 0) fading = true;
    }

    for (const [key, ghost] of [...this.groundGhosts]) {
      const g = ghost.groundFade;
      let gp = fadeProgress(g, now, ms);
      if (g.dir < 0 || gp < 1 || this.coverGroundReady(ghost, now)) gp = fadeToward(g, 0, now, ms);
      if (gp <= 0) {
        this.dropGhost(key, ghost);
        removed = true;
        moved = true;
        continue;
      }
      if (this.writeFade(ghost, 0, fadeValue(gp))) moved = true;
      if (g.dir !== 0) fading = true;
    }

    this.levelFading = fading || this.overSinceMs !== null;
    if (removed) this.syncBasemapHidden();
    if (moved || fading) this.onSceneChange();
  }

  /** A leaving tile came back into range: regrow from its current size. */
  private cancelLeave(p: UnionPresence): void {
    if (p.outMs === null) return;
    const now = this.clock();
    const g = this.unionGrowthOf(p, now);
    p.inMs = now - unionGrowthElapsed(g, this.union.growMs);
    p.outMs = null;
    this.unionDirty = true;
  }

  /** Growth `g` of tile `p` right now (0 for an absent tile). */
  private unionGrowthOf(p: UnionPresence | undefined, now: number): number {
    return unionPresenceGrowth(p, now, this.union.growMs);
  }

  /** How present tile `p` is right now, 0‥1 (1 unless it is leaving). */
  private unionStay(p: UnionPresence | undefined, now: number): number {
    return unionPresenceStay(p, now);
  }

  /**
   * Advance the union animation and write each resident tile's weights.
   * Runs from `update()` only while something is animating (`unionDirty`);
   * Spark re-runs a tile's modifier (`updateVersion`) only if ITS uniforms
   * actually moved, and frames are requested only while something does.
   */
  private tickUnion(): void {
    const now = this.clock();
    const growMs = this.union.growMs;
    const settleMs = unionSettleMs(growMs);
    let animating = false;
    let removed = false;

    // Retire whatever has finished leaving (resident tiles and ghosts alike).
    for (const [key, p] of this.presence) {
      if (p.outMs === null) {
        if (now - p.inMs < settleMs) animating = true;
        continue;
      }
      if (this.unionStay(p, now) > 0) {
        animating = true;
        continue;
      }
      this.presence.delete(key);
      const tile = this.tiles.get(key);
      if (tile) {
        this.removeTile(key, tile);
        removed = true;
      }
    }

    let changed = removed;
    // The union is computed PER LEVEL: a tile only ever joins to neighbours
    // of its own level (the other level of a transition is a separate shape
    // that cross-fades with this one through the growth values).
    let z = 0;
    const at = (x: number, y: number): UnionPresence | undefined =>
      this.presence.get(tileKey(z, x, y));
    for (const [key, tile] of this.tiles) {
      const u = tile.union;
      const p = this.presence.get(key);
      if (!u || !p) continue;
      z = tile.z;
      // The 16 mask values (shared maths — see `unionTileValues`).
      const next = SCRATCH;
      const g = unionTileValues(p, at, now, growMs, next);

      const vecs = [u.uUnionEdge.value, u.uUnionCorner.value, u.uUnionEdgeG.value, u.uUnionCornerG.value];
      let same = g === u.uUnionG.value;
      for (let i = 0; same && i < 4; i++) {
        const v = vecs[i];
        const o = i * 4;
        same = v.x === next[o] && v.y === next[o + 1] && v.z === next[o + 2] && v.w === next[o + 3];
      }
      if (same) continue;
      for (let i = 0; i < 4; i++) vecs[i].fromArray(next, i * 4);
      u.uUnionG.value = g;
      if (tile.unionG) {
        tile.unionG.value = g;
        this.bumpTile(tile);
      }
      changed = true;
    }

    this.unionDirty = animating;
    if (changed) this.cutoutDirty = true;
    if (removed) this.syncBasemapHidden();
    if (changed || animating) this.onSceneChange();
  }

  // -------------------------------------------------------------------------
  // Internals — ripple reveal
  // -------------------------------------------------------------------------

  private canRipple(): boolean {
    return this.opened && !!this.spark?.dyno;
  }

  /** Resolve the ripple origin to scene x/z (from lat/lon or the view centre). */
  private rippleOrigin(opts: SplatsRevealOptions): THREE.Vector2 {
    const ll = opts.origin ?? this.camera.getView();
    const p = this.projection.project(ll.lon, ll.lat);
    return new THREE.Vector2(p.x, -p.y); // scene Z = −mercatorY
  }

  private startRipple(dir: RippleDirection, opts: SplatsRevealOptions): void {
    const dyno = this.ensureRippleDyno();
    if (!dyno) return;
    const params = resolveRippleParams(opts);
    const origin = this.rippleOrigin(opts);
    this.ripple = { dir, params, startMs: this.clock() };

    const u = this.rippleUniforms;
    u.uOrigin.value.copy(origin);
    u.uW.value = params.ringWidthM;
    u.uR.value = dir === 'in' ? 0 : rippleMaxRadius(params);
    u.uTime.value = 0;
    u.uActive.value = 1;
    dyno.origin.value = u.uOrigin.value;
    dyno.W.value = u.uW.value;
    dyno.R.value = u.uR.value;
    dyno.time.value = 0;

    this.cutout?.setCutoutRipple(true, origin.x, origin.y, u.uR.value, params.ringWidthM);
    for (const tile of this.tiles.values()) this.applyRippleModifier(tile, true);
    this.onSceneChange();
  }

  /** Advance the front; called every RAF tick while a ripple is playing. */
  private tickRipple(): void {
    const r = this.ripple;
    const dyno = this.rippleDyno;
    if (!r || !dyno) return;
    const elapsed = this.clock() - r.startMs;
    const R = rippleFrontRadius(elapsed, r.params, r.dir);
    const tSec = Math.max(0, elapsed) / 1000;
    this.rippleUniforms.uR.value = R;
    this.rippleUniforms.uTime.value = tSec;
    dyno.R.value = R;
    dyno.time.value = tSec;
    // The vector map's cut follows the same front as the imagery's alpha.
    const o = this.rippleUniforms.uOrigin.value;
    this.cutout?.setCutoutRipple(true, o.x, o.y, R, this.rippleUniforms.uW.value);
    // Uniform changes don't bump Spark's generator version by themselves —
    // nudge every mesh so the modifier re-runs on the next render.
    for (const tile of this.tiles.values()) this.bumpTile(tile);
    this.onSceneChange();
    if (isRippleFinished(elapsed, r.params)) this.finishRipple();
  }

  private finishRipple(): void {
    const r = this.ripple;
    if (!r) return;
    this.endRipple();
    if (r.dir === 'out' && this.disablePending) {
      this.disablePending = false;
      this.applyActive();
    }
  }

  /** Stop any ripple and put everything in the fully-revealed steady state. */
  private endRipple(): void {
    this.ripple = null;
    this.rippleUniforms.uActive.value = 0;
    this.rippleUniforms.uR.value = REVEALED_RADIUS;
    this.cutout?.setCutoutRipple(false);
    if (this.rippleDyno) this.rippleDyno.R.value = REVEALED_RADIUS;
    for (const tile of this.tiles.values()) this.applyRippleModifier(tile, false);
  }

  /**
   * Drive the one-frame pre-warm (see `prewarm`). Runs only while no ripple is playing, so it can
   * never fight a real animation, and is a no-op once done or when Spark has no `dyno`.
   */
  private tickPrewarm(): void {
    if (!this.prewarmEnabled || this.prewarm === 'done' || this.ripple) return;
    if (this.prewarm === 'rendering') {
      const tile = this.prewarmKey ? this.tiles.get(this.prewarmKey) : null;
      if (tile) this.applyRippleModifier(tile, false);
      this.prewarmKey = null;
      this.prewarm = 'done';
      return;
    }
    // Wait for a tile that is actually in the scene; the front stays fully open throughout.
    const tile = this.tiles.values().next().value;
    if (!tile) return;
    if (!this.ensureRippleDyno()) {
      this.prewarm = 'done'; // no dyno support: nothing to compile
      return;
    }
    if (this.rippleDyno) this.rippleDyno.R.value = REVEALED_RADIUS;
    this.applyRippleModifier(tile, true);
    this.prewarmKey = tile.key;
    this.prewarm = 'rendering';
    this.onSceneChange();
  }

  /**
   * Hide resident tiles outside the view. Spark draws every splat of every mesh in the scene, and
   * a `SplatMesh` carries no bounding volume for three to cull on, so this is the difference
   * between paying for an off-screen tile and not (see cull.ts). One frustum build plus a box
   * test per resident tile.
   */
  /**
   * Re-order a ranked window so tiles inside the view come first.
   *
   * The screen-relevance score already favours what the camera looks at, but it scores a tile by
   * a point, so at high tilt it still admitted tiles that lie entirely outside the frustum —
   * measured at tilt 70, 6 of 17 resident tiles were off-screen, holding 1.2M splats of a 4M
   * budget that visible ground could have used. Partitioning by an actual volume test keeps the
   * relative order inside each group, so this only demotes what cannot be seen.
   *
   * The box is inflated by half a tile so a tile about to scroll into view is not starved.
   *
   * This changes LOAD ORDER, not residency: the budget is a cap, not a target, so once every
   * visible tile is in, off-screen ones still fill the remainder — which is useful, since with
   * `frustumCull` they cost no frame time and are already decoded when the camera turns toward
   * them. Measured at tilt 70 with a 4M budget: 11 of 16 resident tiles visible, 29 % of the
   * budget held off-screen as that prefetch, and the frame-time win there comes from the culling
   * rather than from this ordering.
   */
  private visibleFirst(ranked: RankCell[]): RankCell[] {
    if (!this.visibleFirst_ || ranked.length < 2) return ranked;
    const cam = this.getCamera?.();
    if (!cam) return ranked;
    cam.updateMatrixWorld();
    cameraFrustum(cam, this.cullFrustum);
    const { lat: originLat, lon: originLon } = this.projection.origin;
    const inView: RankCell[] = [];
    const outside: RankCell[] = [];
    for (const cell of ranked) {
      const { z, x, y } = cell;
      const t = splatTileTransform(z, x, y, originLat, originLon);
      const size = (EARTH_CIRCUMFERENCE_M / 2 ** z) * t.scale;
      const box = tileWorldBox(
        { x: t.position[0], y: t.position[1], z: t.position[2] },
        size,
        this.cullBox
      );
      box.expandByScalar(size * 0.5); // headroom: don't starve a tile about to scroll in
      (tileVisible(this.cullFrustum, box) ? inView : outside).push(cell);
    }
    return outside.length ? inView.concat(outside) : ranked;
  }

  /**
   * The distance cutoff actually in force: the tighter of what the app configured and what the
   * FrameGovernor is asking for. The governor reaches for this BEFORE it cuts the tile budget —
   * losing distant relief keeps more of the picture than losing whole tiles of coverage. On the
   * low / mobile tiers a non-zero floor applies even when the governor is idle.
   */
  private effectiveSplatMaxDistance(): number {
    const tierFloor = this.lowTier ? this.lowTierSplatMaxDistance : 0;
    const candidates = [this.splatMaxDistance, this.governor.splatMaxDistance, tierFloor]
      .filter((d) => d > 0);
    return candidates.length ? Math.min(...candidates) : 0;
  }

  /** Per-frame step of the distance fade (see `splatFadeMs`). */
  private distFadeStep(): number {
    const now = this.clock();
    const dt = this.lastCullMs === 0 ? 16 : Math.min(now - this.lastCullMs, 100);
    this.lastCullMs = now;
    return this.splatFadeMs > 0 ? dt / this.splatFadeMs : 1;
  }

  private tickCulling(): void {
    if (!this.frustumCull) return;
    const cam = this.getCamera?.();
    if (!cam) return;
    cam.updateMatrixWorld();
    cameraFrustum(cam, this.cullFrustum);
    let changed = false;
    for (const tile of this.tiles.values()) {
      const visible = tileVisible(
        this.cullFrustum,
        tileWorldBox(tile.root.position, tile.worldSize, this.cullBox)
      );
      // Past `splatMaxDistance` the splats go but the imagery stays: same photograph, and an
      // individual splat is under a pixel out there, so only the relief is lost.
      let splatsVisible = visible;
      const cutoff = this.effectiveSplatMaxDistance();
      if (visible && cutoff > 0) {
        this.cullBox.getCenter(this.cullCentre);
        if (this.cullCentre.distanceTo(cam.position) > cutoff) splatsVisible = false;
      }
      // Ease rather than pop: a tile blinking out as the governor tightens the cutoff is
      // exactly the kind of jolt this map is trying to avoid.
      const want = splatsVisible ? 1 : 0;
      if (tile.distFade !== want) {
        const step = this.distFadeStep();
        tile.distFade = want > tile.distFade
          ? Math.min(want, tile.distFade + step)
          : Math.max(want, tile.distFade - step);
        if (Math.abs(tile.distFade - want) < 0.01) tile.distFade = want;
        this.writeFade(tile, tile.lastSplatFade, tile.lastGroundFade);
        changed = true;
      }
      // Fully faded (or out of frustum) costs nothing at all.
      const draw = visible && tile.distFade > 0;
      if (tile.cullDraw !== draw) {
        tile.cullDraw = draw;
        this.applyMeshVisibility(tile);
        changed = true;
      }
      // The imagery plane follows the FRUSTUM test only — it is what keeps a distant tile drawn.
      if (tile.ground && tile.ground.visible !== visible) tile.ground.visible = visible;
    }
    if (changed) this.onSceneChange();
  }

  private applyRippleModifier(tile: SplatTile, on: boolean): void {
    const dyno = this.rippleDyno;
    const want = on && !!dyno;
    // Tracked on the tile: Spark's `worldModifier` is a setter with no
    // getter, so the mesh can't be asked what it currently has.
    if (tile.rippleOn === want) return;
    tile.rippleOn = want;
    for (const m of [tile.mesh, tile.lite]) {
      if (!m) continue;
      m.worldModifier = want ? dyno?.modifier : undefined;
      m.updateGenerator?.();
      m.updateVersion?.();
    }
  }

  /**
   * Build the per-splat GPU modifier once (a Spark `dyno` graph run for
   * every splat, in WORLD space, after the tile placement):
   *
   *   d      = |center.xz − origin|
   *   grow   = smoothstep(0, 1, clamp((R − d) / W, 0, 1))
   *   scale  = max(0, envelope(grow) + ring·grow)     (envelope = easeOutBack)
   *   ring   = |(R − d)/W| < 1 ? AMP·sin(2π·(R − d)/W − RATE·t) : 0
   *   scales ← scales · scale,  opacity ← opacity · grow
   *
   * — the GLSL twin of `rippleScale()` / `rippleOpacity()` in ripple.ts.
   */
  private ensureRippleDyno(): SplatsLayer['rippleDyno'] {
    if (this.rippleDyno) return this.rippleDyno;
    const d = this.spark?.dyno;
    if (!d) return null;
    const origin = d.dynoVec2(new THREE.Vector2());
    const R = d.dynoFloat(0);
    const W = d.dynoFloat(1);
    const time = d.dynoFloat(0);
    const c = (v: number): DynoNode => d.dynoConst('float', v);

    const modifier = d.dynoBlock({ gsplat: d.Gsplat }, { gsplat: d.Gsplat }, ({ gsplat }) => {
      const { center, scales, opacity } = d.splitGsplat(gsplat).outputs;
      const dist = d.length(d.sub(d.swizzle(center, 'xz'), origin));
      const band = d.div(d.sub(R, dist), W); // (R − d) / W
      const s = d.clamp(band, c(0), c(1));
      const grow = d.mul(d.mul(s, s), d.sub(c(3), d.mul(c(2), s))); // smoothstep
      // easeOutBack: 1 + c3·u³ + c1·u², u = grow − 1 (see rippleEnvelope).
      const u = d.sub(grow, c(1));
      const u2 = d.mul(u, u);
      const overshoot = d.add(
        c(1),
        d.add(d.mul(c(RIPPLE_BACK_C1 + 1), d.mul(u2, u)), d.mul(c(RIPPLE_BACK_C1), u2))
      );
      const ringWave = d.mul(
        c(RIPPLE_RING_AMPLITUDE),
        d.sin(d.sub(d.mul(c(2 * Math.PI), band), d.mul(c(RIPPLE_RING_PHASE_RATE), time)))
      );
      const ring = d.select(d.lessThan(d.abs(band), c(1)), ringWave, c(0));
      const scale = d.max(d.add(overshoot, d.mul(ring, grow)), c(0));
      return {
        gsplat: d.combineGsplat({
          gsplat,
          scales: d.mul(scales, scale),
          opacity: d.mul(opacity, grow)
        })
      };
    });

    this.rippleDyno = { origin, R, W, time, modifier };
    return this.rippleDyno;
  }
}
