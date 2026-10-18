import { GOVERNOR_DEFAULTS } from '../src/splats/governor.js';
import { MOTION_THIN_LADDER } from '../src/splats/thin.js';
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { Projection } from '../src/core/Projection.js';
import { lonLatToTile, tileToLonLat, tileKey } from '../src/core/TileId.js';
import {
  splatTileTransform,
  splatLocalToScene,
  enumerateTileWindow,
  expandTileUrl
} from '../src/splats/transform.js';
import {
  SplatsLayer,
  SPLAT_THREE_LAYER,
  SPLATS_HIDDEN_BASEMAP_LAYERS,
  imageryTemplateFrom,
  type DynoNode,
  type SparkDynoLike,
  type SparkModule,
  type SparkSplatMeshOptions
} from '../src/splats/SplatsLayer.js';
import {
  DEFAULT_RIPPLE_PARAMS,
  RIPPLE_OVERSHOOT,
  RIPPLE_RING_AMPLITUDE,
  isRippleFinished,
  resolveRippleParams,
  rippleFrontRadius,
  rippleEnvelope,
  rippleGroundBrightness,
  rippleMaxRadius,
  rippleOpacity,
  rippleReveal,
  rippleScale
} from '../src/splats/ripple.js';
import {
  ALL_NEIGHBOURS,
  NO_NEIGHBOURS,
  ROUNDED_UNION_GLSL,
  UNION_LEAVE_MS,
  type UnionWeights,
  resolveRoundedUnion,
  roundedUnionDistance,
  roundedUnionMask,
  roundedUnionSigned,
  unionBridgeDelayMs,
  unionBridgeWeight,
  unionGrowth,
  unionGrowthElapsed,
  unionLeaveFactor,
  unionSettleMs
} from '../src/splats/roundedUnion.js';
import type { CameraView } from '../src/types.js';
import {
  exportSplatsOptions,
  planSplatsUpdate,
  resolveSplatsOptions,
  splatsReplacePatch
} from '../src/splats/options.js';
import {
  DEFAULT_LEVEL_FADE_MS,
  DEFAULT_PREFETCH_BAND,
  DEFAULT_TRANSITION_OVERSHOOT,
  appearKind,
  childQuadrant,
  createFade,
  fadeProgress,
  fadeToward,
  fadeValue,
  prefetchLevel,
  tilesOverlap,
  transitionAllowance
} from '../src/splats/levelFade.js';
import {
  LOD_HYSTERESIS,
  lodFallbackOrder,
  selectTileZoom,
  tileCentreDist2,
  tileCoverRange
} from '../src/splats/lod.js';

/**
 * Splat tiles are authored in a tile-local frame (origin SW corner, x east,
 * y north, z up, Web-Mercator metres). These tests pin the placement maths
 * against the map's own Projection and drive the SplatsLayer tile loop with
 * a stubbed Spark module + fetch — no GL, no DOM, and `@sparkjsdev/spark` is
 * never imported.
 */

// Boise, ID — mid-latitude so cos(lat) is far from 1 and any missed
// mercator scale factor shows up as tens of metres.
const ORIGIN = { lat: 43.615, lon: -116.2023 };
const DEG = Math.PI / 180;

function mercatorScaleAt(lat: number): number {
  return 1 / Math.cos(lat * DEG);
}

describe('splatTileTransform', () => {
  const z = 16;
  const t = lonLatToTile(ORIGIN.lon, ORIGIN.lat, z);
  const projection = new Projection(ORIGIN.lat, ORIGIN.lon);
  const xf = splatTileTransform(z, t.x, t.y, ORIGIN.lat, ORIGIN.lon);

  // Tile edge in mercator metres (what the tile-local frame is authored in).
  const tileMercator = (2 * Math.PI * 6378137) / 2 ** z;

  it('uses cos(originLat) as the uniform scale and −π/2 about X', () => {
    expect(xf.scale).toBeCloseTo(Math.cos(ORIGIN.lat * DEG), 12);
    expect(xf.rotationX).toBeCloseTo(-Math.PI / 2, 12);
    expect(xf.position[1]).toBe(0);
    expect(xf.sizeScene).toBeCloseTo(tileMercator * xf.scale, 9);
  });

  it('places tile-local (0,0,0) at the SW corner per Projection.project', () => {
    const sw = tileToLonLat(z, t.x, t.y + 1); // SW corner = (x, y+1) tile corner
    const p = projection.project(sw.lon, sw.lat);
    const [sx, sy, sz] = splatLocalToScene(xf, 0, 0, 0);
    expect(sx).toBeCloseTo(p.x, 3);
    expect(sy).toBeCloseTo(0, 3);
    expect(sz).toBeCloseTo(-p.y, 3); // scene Z = −mercatorY
  });

  it('places tile-local (size,size,0) at the NE corner', () => {
    const ne = tileToLonLat(z, t.x + 1, t.y);
    const p = projection.project(ne.lon, ne.lat);
    const [sx, sy, sz] = splatLocalToScene(xf, tileMercator, tileMercator, 0);
    expect(sx).toBeCloseTo(p.x, 3);
    expect(sy).toBeCloseTo(0, 3);
    expect(sz).toBeCloseTo(-p.y, 3);
  });

  it('maps a pre-stretched height h at the tile centre to scene Y ≈ h true metres', () => {
    const h = 30; // true metres
    const centre = tileToLonLat(z, t.x + 0.5, t.y + 0.5);
    // The tiler pre-multiplies heights by 1/cos(lat_tile) so the frame is
    // isotropic in mercator metres.
    const localZ = h * mercatorScaleAt(centre.lat);
    const [, sy] = splatLocalToScene(xf, tileMercator / 2, tileMercator / 2, localZ);
    const expected = h * mercatorScaleAt(centre.lat) * Math.cos(ORIGIN.lat * DEG);
    expect(sy).toBeCloseTo(expected, 6);
    // …and because the tile is at the origin latitude that is ≈ h.
    expect(Math.abs(sy - h)).toBeLessThan(0.01);
  });

  it('agrees with the THREE.Object3D hierarchy the layer builds', () => {
    const root = new THREE.Object3D();
    root.position.set(...xf.position);
    root.rotation.x = xf.rotationX;
    root.scale.setScalar(xf.scale);
    root.updateMatrixWorld(true);
    const v = new THREE.Vector3(123.4, 567.8, 9.1).applyMatrix4(root.matrixWorld);
    const [ex, ey, ez] = splatLocalToScene(xf, 123.4, 567.8, 9.1);
    expect(v.x).toBeCloseTo(ex, 6);
    expect(v.y).toBeCloseTo(ey, 6);
    expect(v.z).toBeCloseTo(ez, 6);
  });
});

describe('splatTileTransform across the pyramid (each tile in the frame of ITS OWN zoom)', () => {
  const projection = new Projection(ORIGIN.lat, ORIGIN.lon);
  // Off-origin on purpose: a level-dependent error would grow with distance.
  const at = { lon: ORIGIN.lon + 0.21, lat: ORIGIN.lat - 0.13 };

  it.each([13, 14, 15, 16])('z%i: SW and NE corners land where Projection.project puts them', (z) => {
    const t = lonLatToTile(at.lon, at.lat, z);
    const xf = splatTileTransform(z, t.x, t.y, ORIGIN.lat, ORIGIN.lon);
    const size = (2 * Math.PI * 6378137) / 2 ** z; // tile edge, mercator metres
    expect(xf.sizeScene).toBeCloseTo(size * Math.cos(ORIGIN.lat * DEG), 6);

    const sw = tileToLonLat(z, t.x, t.y + 1);
    const pSW = projection.project(sw.lon, sw.lat);
    const [ax, ay, az] = splatLocalToScene(xf, 0, 0, 0);
    expect(ax).toBeCloseTo(pSW.x, 3);
    expect(ay).toBe(0);
    expect(az).toBeCloseTo(-pSW.y, 3);

    const ne = tileToLonLat(z, t.x + 1, t.y);
    const pNE = projection.project(ne.lon, ne.lat);
    const [bx, , bz] = splatLocalToScene(xf, size, size, 0);
    expect(bx).toBeCloseTo(pNE.x, 3);
    expect(bz).toBeCloseTo(-pNE.y, 3);
  });

  it('a parent tile covers exactly its four children (shared SW corner, twice the edge)', () => {
    const c = lonLatToTile(at.lon, at.lat, 16);
    const cx = c.x & ~1; // the parent's west / …
    const cy = c.y | 1; //  … south child
    const child = splatTileTransform(16, cx, cy, ORIGIN.lat, ORIGIN.lon);
    const parent = splatTileTransform(15, cx >> 1, cy >> 1, ORIGIN.lat, ORIGIN.lon);
    expect(parent.position[0]).toBeCloseTo(child.position[0], 3);
    expect(parent.position[2]).toBeCloseTo(child.position[2], 3);
    expect(parent.sizeScene).toBeCloseTo(2 * child.sizeScene, 6);
    expect(parent.scale).toBe(child.scale);
  });
});

describe('tile-pyramid level selection', () => {
  const P = { minTileZoom: 13, maxTileZoom: 16, lodBias: 0 };

  it('tileZ = clamp(floor(cameraZoom + lodBias), min, max)', () => {
    expect(selectTileZoom(17.0, null, P)).toBe(16);
    expect(selectTileZoom(16.0, null, P)).toBe(16);
    expect(selectTileZoom(15.99, null, P)).toBe(15);
    expect(selectTileZoom(15.0, null, P)).toBe(15);
    expect(selectTileZoom(14.5, null, P)).toBe(14);
    expect(selectTileZoom(13.5, null, P)).toBe(13);
    expect(selectTileZoom(9, null, P)).toBe(13);
    expect(selectTileZoom(22, null, P)).toBe(16);
  });

  it('lodBias shifts the level (−1 = one level coarser), fractions shift the switch-over', () => {
    expect(selectTileZoom(16.5, null, { ...P, lodBias: -1 })).toBe(15);
    expect(selectTileZoom(14.5, null, { ...P, lodBias: -1 })).toBe(13);
    expect(selectTileZoom(13.5, null, { ...P, lodBias: -1 })).toBe(13); // clamped
    expect(selectTileZoom(14.5, null, { ...P, lodBias: 1 })).toBe(15);
    expect(selectTileZoom(15.6, null, { ...P, lodBias: 0.5 })).toBe(16);
  });

  it('hysteresis: ±0.15 around each boundary, so a camera on the line does not flap', () => {
    expect(LOD_HYSTERESIS).toBe(0.15);
    // Zooming in from z15: still z15 just past 16, z16 only past 16.15.
    expect(selectTileZoom(16.0, 15, P)).toBe(15);
    expect(selectTileZoom(16.14, 15, P)).toBe(15);
    expect(selectTileZoom(16.16, 15, P)).toBe(16);
    // Zooming out from z16: still z16 just under 16, z15 only below 15.85.
    expect(selectTileZoom(15.99, 16, P)).toBe(16);
    expect(selectTileZoom(15.85, 16, P)).toBe(16);
    expect(selectTileZoom(15.84, 16, P)).toBe(15);
    // A jitter across the boundary never changes the level from either side.
    let z = 15;
    for (const cam of [15.95, 16.05, 15.98, 16.1, 15.9]) z = selectTileZoom(cam, z, P);
    expect(z).toBe(15);
    z = 16;
    for (const cam of [15.95, 16.05, 15.98, 16.1, 15.9]) z = selectTileZoom(cam, z, P);
    expect(z).toBe(16);
    // A big jump lands on the right level in one go.
    expect(selectTileZoom(13.4, 16, P)).toBe(13);
    expect(selectTileZoom(16.6, 13, P)).toBe(16);
  });

  it('a previous level outside the (changed) bounds is ignored', () => {
    expect(selectTileZoom(16.05, 16, { ...P, maxTileZoom: 15 })).toBe(15);
    expect(selectTileZoom(13.2, 13, { ...P, minTileZoom: 14 })).toBe(14);
    expect(selectTileZoom(15.5, 12, { minTileZoom: 15, maxTileZoom: 15, lodBias: 0 })).toBe(15);
  });

  it('fallback order: the level, then finer, then coarser', () => {
    expect(lodFallbackOrder(14, 13, 16)).toEqual([14, 15, 16, 13]);
    expect(lodFallbackOrder(16, 13, 16)).toEqual([16, 15, 14, 13]);
    expect(lodFallbackOrder(13, 13, 13)).toEqual([13]);
  });

  it('cover range: one ancestor when coarser, the square of descendants when finer', () => {
    expect(tileCoverRange(16, 18053, 25931, 15)).toEqual({ x0: 9026, y0: 12965, x1: 9026, y1: 12965 });
    expect(tileCoverRange(16, 18053, 25931, 13)).toEqual({ x0: 2256, y0: 3241, x1: 2256, y1: 3241 });
    expect(tileCoverRange(15, 9026, 12965, 16)).toEqual({ x0: 18052, y0: 25930, x1: 18053, y1: 25931 });
    expect(tileCoverRange(14, 1, 2, 16)).toEqual({ x0: 4, y0: 8, x1: 7, y1: 11 });
    expect(tileCoverRange(15, 3, 4, 15)).toEqual({ x0: 3, y0: 4, x1: 3, y1: 4 });
  });

  it('cross-level distance ranks tiles of different levels on one scale', () => {
    // Camera at the centre of z15 tile (2, 2) — i.e. the corner shared by its
    // four z16 children: the parent is nearer than any child.
    const cx = 2.5 / 2 ** 15;
    const cy = 2.5 / 2 ** 15;
    expect(tileCentreDist2(15, 2, 2, cx, cy)).toBeCloseTo(0, 20);
    expect(tileCentreDist2(16, 4, 4, cx, cy)).toBeGreaterThan(0);
    expect(tileCentreDist2(16, 4, 4, cx, cy)).toBeCloseTo(tileCentreDist2(16, 5, 5, cx, cy), 20);
    expect(tileCentreDist2(16, 8, 8, cx, cy)).toBeGreaterThan(tileCentreDist2(15, 3, 2, cx, cy));
  });
});

describe('enumerateTileWindow / expandTileUrl', () => {
  it('produces the expected z16 keys around a known lon/lat, nearest-first', () => {
    const z = 16;
    const c = lonLatToTile(ORIGIN.lon, ORIGIN.lat, z);
    // Sanity: the Boise tile at z16.
    expect(c.x).toBe(11614);
    expect(c.y).toBe(23927);
    const win = enumerateTileWindow(z, c.x, c.y, 1);
    expect(win).toHaveLength(9);
    expect(win[0]).toEqual([c.x, c.y]); // centre first
    const keys = new Set(win.map(([x, y]) => tileKey(z, x, y)));
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        expect(keys.has(`16/${c.x + dx}/${c.y + dy}`)).toBe(true);
      }
    }
    // Edge tiles (d²=1) come before corners (d²=2).
    const d2 = (p: [number, number]): number => (p[0] - c.x) ** 2 + (p[1] - c.y) ** 2;
    for (let i = 1; i < win.length; i++) expect(d2(win[i])).toBeGreaterThanOrEqual(d2(win[i - 1]));
  });

  it('clamps the window to the tile pyramid', () => {
    expect(enumerateTileWindow(1, 0, 0, 2)).toHaveLength(4);
  });

  it('expands every placeholder', () => {
    expect(expandTileUrl('https://h/{z}/{x}/{y}.spz?v={z}', 16, 11614, 23875)).toBe(
      'https://h/16/11614/23875.spz?v=16'
    );
  });
});

// ---------------------------------------------------------------------------
// Ripple reveal maths (pure; mirrored in GLSL by the layer).
// ---------------------------------------------------------------------------

describe('ripple maths', () => {
  const P = DEFAULT_RIPPLE_PARAMS;

  it('has the documented defaults and fills them in for partial specs', () => {
    expect(P).toEqual({ durationMs: 1800, speedMps: 250, ringWidthM: 40 });
    expect(resolveRippleParams()).toEqual(P);
    expect(resolveRippleParams({ durationMs: 500 })).toEqual({ ...P, durationMs: 500 });
    expect(resolveRippleParams({ speedMps: 0, durationMs: NaN })).toEqual(P); // invalid → default
    expect(rippleMaxRadius(P)).toBe(450);
  });

  it('R(t) = speed·t, clamped to the duration; out plays it backwards', () => {
    expect(rippleFrontRadius(0, P)).toBe(0);
    expect(rippleFrontRadius(300, P)).toBeCloseTo(75, 9);
    expect(rippleFrontRadius(1000, P)).toBeCloseTo(250, 9);
    expect(rippleFrontRadius(5000, P)).toBe(450); // clamped at the end
    expect(rippleFrontRadius(-10, P)).toBe(0);
    expect(rippleFrontRadius(0, P, 'out')).toBe(450);
    expect(rippleFrontRadius(900, P, 'out')).toBeCloseTo(225, 9);
    expect(rippleFrontRadius(1800, P, 'out')).toBe(0);
    expect(isRippleFinished(1799, P)).toBe(false);
    expect(isRippleFinished(1800, P)).toBe(true);
  });

  it('reveal / opacity: 0 beyond the front, smoothstep across the band, 1 behind it', () => {
    const R = 200;
    const w = 40;
    expect(rippleReveal(250, R, w)).toBe(0);
    expect(rippleReveal(200, R, w)).toBe(0);
    expect(rippleReveal(180, R, w)).toBeCloseTo(0.5, 9); // midway = smoothstep(0.5)
    expect(rippleReveal(160, R, w)).toBe(1);
    expect(rippleReveal(0, R, w)).toBe(1);
    expect(rippleOpacity(180, R, w)).toBe(rippleReveal(180, R, w));
    // monotonic across the band
    let prev = -1;
    for (let d = 200; d >= 160; d -= 1) {
      const v = rippleReveal(d, R, w);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('scale: collapsed beyond the front, overshoots inside the band, exactly 1 behind it', () => {
    const R = 200;
    const w = 40;
    expect(rippleScale(300, R, w)).toBe(0);
    expect(rippleScale(200, R, w)).toBe(0);
    expect(rippleScale(159, R, w)).toBe(1);
    expect(rippleScale(0, R, w, 1.23)).toBe(1); // the ring never leaks behind the band
    // The envelope is a back-ease: 0 → ≈1.35 → 1.
    expect(rippleEnvelope(0)).toBeCloseTo(0, 12);
    expect(rippleEnvelope(1)).toBeCloseTo(1, 12);
    let envPeak = 0;
    for (let g = 0; g <= 1; g += 0.001) envPeak = Math.max(envPeak, rippleEnvelope(g));
    expect(envPeak).toBeCloseTo(1 + RIPPLE_OVERSHOOT, 1);
    // Somewhere in the band the scale exceeds 1 (the pop) …
    let peak = 0;
    for (let d = 200; d >= 160; d -= 0.1) peak = Math.max(peak, rippleScale(d, R, w));
    expect(peak).toBeGreaterThan(1 + RIPPLE_OVERSHOOT * 0.8);
    expect(peak).toBeLessThanOrEqual(1 + RIPPLE_OVERSHOOT + RIPPLE_RING_AMPLITUDE + 0.02);
    // … and it is never negative.
    for (let d = 0; d <= 300; d += 0.25) expect(rippleScale(d, R, w, 0.4)).toBeGreaterThanOrEqual(0);
  });

  it('the sine ring modulates scale by ±10 % around the grow envelope', () => {
    const R = 200;
    const w = 40;
    for (let d = 199; d > 160; d -= 0.5) {
      const grow = rippleReveal(d, R, w);
      const envelope = rippleEnvelope(grow);
      const v = rippleScale(d, R, w);
      expect(Math.abs(v - envelope)).toBeLessThanOrEqual(RIPPLE_RING_AMPLITUDE * grow + 1e-9);
    }
  });

  it('ground brightness is a single positive lobe just inside the front', () => {
    expect(rippleGroundBrightness(250, 200, 40)).toBe(1);
    expect(rippleGroundBrightness(200, 200, 40)).toBe(1);
    expect(rippleGroundBrightness(180, 200, 40)).toBeCloseTo(1 + 4 * RIPPLE_RING_AMPLITUDE, 9);
    expect(rippleGroundBrightness(100, 200, 40)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SplatsLayer — driven with a stub Spark module and an injected fetch.
// ---------------------------------------------------------------------------

class FakeSplatMesh extends THREE.Object3D {
  initialized: Promise<unknown>;
  numSplats: number;
  disposed = false;
  worldModifier?: DynoNode;
  objectModifier?: DynoNode;
  generatorUpdates = 0;
  versionBumps = 0;
  constructor(opts: SparkSplatMeshOptions) {
    super();
    this.numSplats = opts.fileBytes.byteLength; // 1 "splat" per byte
    this.initialized = Promise.resolve(this);
  }
  updateGenerator(): void {
    this.generatorUpdates++;
  }
  updateVersion(): void {
    this.versionBumps++;
  }
  dispose(): void {
    this.disposed = true;
  }
}
class FakeSparkRenderer extends THREE.Object3D {
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

/** Stub dyno namespace: every op returns an opaque node; the block runs its
 *  construct closure once so a graph-building bug shows up in node. */
function makeFakeDyno(): SparkDynoLike & { blocks: number } {
  const node = (): DynoNode => ({});
  const bin = (): DynoNode => node();
  const dyno: SparkDynoLike & { blocks: number } = {
    blocks: 0,
    Gsplat: { type: 'Gsplat' },
    dynoBlock(_in, _out, construct) {
      dyno.blocks++;
      const out = construct({ gsplat: node() });
      if (!out.gsplat) throw new Error('modifier must return gsplat');
      return { modifier: dyno.blocks };
    },
    // Raw-GLSL node: run the generators once so a broken template throws.
    Dyno: class {
      outputs: Record<string, DynoNode>;
      constructor(opts: {
        inTypes: Record<string, string>;
        outTypes: Record<string, string>;
        globals?: () => string[];
        statements: (io: { inputs: Record<string, string>; outputs: Record<string, string> }) => string[];
      }) {
        const names = (o: Record<string, string>): Record<string, string> =>
          Object.fromEntries(Object.keys(o).map((k) => [k, `_${k}`]));
        const glsl = opts.statements({ inputs: names(opts.inTypes), outputs: names(opts.outTypes) });
        if (!glsl.join('\n').includes('hbdRoundedUnionMask(')) throw new Error('bad union statements');
        if (!opts.globals?.().some((g) => g.includes('float hbdRoundedUnionMask('))) {
          throw new Error('union GLSL missing from globals');
        }
        if (!glsl.join('\n').includes('hbdThin(') || !opts.globals?.().some((g) => g.includes('vec2 hbdThin('))) {
          throw new Error('motion-thinning GLSL missing');
        }
        this.outputs = Object.fromEntries(Object.keys(opts.outTypes).map((k) => [k, node()]));
      }
    },
    dynoFloat: (value) => ({ value }),
    dynoVec2: (value) => ({ value }),
    dynoVec3: (value) => ({ value }),
    dynoVec4: (value) => ({ value }),
    dynoConst: () => node(),
    splitGsplat: () => ({ outputs: { center: node(), scales: node(), opacity: node() } }),
    combineGsplat: () => node(),
    swizzle: bin,
    add: bin,
    sub: bin,
    mul: bin,
    div: bin,
    length: node,
    abs: node,
    sin: node,
    max: bin,
    clamp: node,
    lessThan: bin,
    select: node
  };
  return dyno;
}

function makeFakeSpark(withDyno = true): SparkModule {
  return {
    SparkRenderer: FakeSparkRenderer,
    SplatMesh: FakeSplatMesh,
    SplatFileType: { PLY: 'ply', SPZ: 'spz' },
    dyno: withDyno ? makeFakeDyno() : undefined
  };
}

interface Harness {
  layer: SplatsLayer;
  scene: THREE.Scene;
  view: CameraView;
  fetchTile: ReturnType<typeof vi.fn<(url: string) => Promise<ArrayBuffer | null>>>;
  loadTexture: ReturnType<typeof vi.fn<(url: string) => Promise<THREE.Texture | null>>>;
  hidden: boolean[];
  sceneChanges: () => number;
  setTime: (ms: number) => void;
  meshes: () => FakeSplatMesh[];
}

function makeLayer(
  config: Partial<import('../src/splats/types.js').SplatsConfig> = {},
  deps: {
    loadSpark?: () => Promise<SparkModule>;
    cutout?: import('../src/splats/SplatsLayer.js').SplatCutoutSink;
    prefersReducedMotion?: () => boolean;
    prewarmShaders?: boolean;
    getCamera?: () => THREE.Camera | null;
  } = {}
): Harness {
  const scene = new THREE.Scene();
  // Looking straight down: the window is centred on the target and tiles rank
  // by ground distance (tilted views are covered by the relevance tests).
  const view: CameraView = { lat: ORIGIN.lat, lon: ORIGIN.lon, zoom: 17, tilt: 0, bearing: 0 };
  const fetchTile = vi.fn<(url: string) => Promise<ArrayBuffer | null>>(async () => new ArrayBuffer(10));
  const loadTexture = vi.fn<(url: string) => Promise<THREE.Texture | null>>(
    async () => new THREE.Texture()
  );
  const hidden: boolean[] = [];
  let changes = 0;
  let now = 0;
  const layer = new SplatsLayer(
    {
      renderer: {} as THREE.WebGLRenderer, // never touched by the stub
      scene,
      camera: { getView: () => view },
      projection: new Projection(ORIGIN.lat, ORIGIN.lon),
      onSceneChange: () => { changes++; },
      setBasemapHidden: (h) => hidden.push(h),
      cutout: deps.cutout,
      prefersReducedMotion: deps.prefersReducedMotion,
      loadSpark: deps.loadSpark ?? (async () => makeFakeSpark()),
      // off by default: several tests count generator rebuilds, which the one-frame
      // shader pre-warm would otherwise add to. The pre-warm has its own test.
      prewarmShaders: deps.prewarmShaders === true,
      getCamera: deps.getCamera,
      fetchTile,
      loadTexture
    },
    {
      urlTemplate: 'https://tiles.test/{z}/{x}/{y}.spz',
      radius: 1,
      maxInFlight: 100,
      // These tests pin the tile loop against the GLOBAL hide and the plain
      // camera-zoom level; `'covered'` and the 1.5 bias have their own below.
      hideBasemap: true,
      lodBias: 0,
      lowTierLodBias: -1,
      // The cover level has its own tests; the rest pin single-level windows.
      cover: false,
      clock: () => now,
      ...config
    }
  );
  const meshes = (): FakeSplatMesh[] => {
    const out: FakeSplatMesh[] = [];
    scene.getObjectByName('hbd-splats')?.traverse((o) => {
      if (o instanceof FakeSplatMesh) out.push(o);
    });
    return out;
  };
  return {
    layer,
    scene,
    view,
    fetchTile,
    loadTexture,
    hidden,
    sceneChanges: () => changes,
    setTime: (ms) => { now = ms; },
    meshes
  };
}

/** Let the fetch → decode microtask chain drain (tiles end up QUEUED). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Tick the layer like the RAF loop would: each `update()` admits at most one
 * decoded tile into the scene (the per-frame upload cap) and kicks off the
 * next loads, so a 3×3 window needs a handful of frames to fill.
 */
async function drain(h: Harness, frames = 12): Promise<void> {
  for (let i = 0; i < frames; i++) {
    h.layer.update();
    await settle();
  }
}

const GOVERNOR_IDLE = { enabled: true, frameMs: 0, targetFrameMs: 33, scale: 1, maxScale: 1, biasDrop: 0 , splatMaxDistance: 0, thinKeep: 1 } as const;
const IDLE = {
  reveal: 'none', basemapHidden: false, basemapCovered: false, maxSplats: 1_200_000, tileZoom: 16,
  governor: GOVERNOR_IDLE
} as const;
const FULL = { ...IDLE, basemapHidden: true } as const;

describe('SplatsLayer', () => {
  it('adds exactly one SparkRenderer on layer 8 when opened', async () => {
    const h = makeLayer();
    await h.layer.open();
    const sr = h.scene.children.filter((c) => c instanceof FakeSparkRenderer);
    expect(sr).toHaveLength(1);
    expect(sr[0].layers.mask).toBe(1 << SPLAT_THREE_LAYER);
    await h.layer.open(); // idempotent
    expect(h.scene.children.filter((c) => c instanceof FakeSparkRenderer)).toHaveLength(1);
  });

  it('stays inert (no throw, no loads) when Spark fails to import', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeLayer({}, { loadSpark: async () => { throw new Error('nope'); } });
    await h.layer.open();
    h.layer.update();
    await settle();
    expect(h.fetchTile).not.toHaveBeenCalled();
    expect(h.layer.getStats()).toEqual({ tiles: 0, splats: 0, ...IDLE });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('update() no-ops below minZoom and drops tiles when zooming back out', async () => {
    const h = makeLayer({ minZoom: 15 });
    await h.layer.open();
    h.view.zoom = 14.9;
    h.layer.update();
    await settle();
    expect(h.fetchTile).not.toHaveBeenCalled();
    expect(h.layer.getStats().tiles).toBe(0);

    h.view.zoom = 16;
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);

    h.view.zoom = 14;
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(0);
  });

  it('loads the z16 window at the fixed authored zoom and places each tile', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);

    expect(h.fetchTile).toHaveBeenCalledTimes(9);
    // Centre tile fetched first, at zoomLevel 16 regardless of camera zoom 17.
    expect(h.fetchTile.mock.calls[0][0]).toBe('https://tiles.test/16/11614/23927.spz');
    expect(h.layer.getStats()).toEqual({ tiles: 9, splats: 90, ...FULL });

    const group = h.scene.getObjectByName('hbd-splats')!;
    expect(group.children).toHaveLength(9);
    const root = group.getObjectByName('splat-tile-root:16/11614/23927')!;
    const xf = splatTileTransform(16, 11614, 23927, ORIGIN.lat, ORIGIN.lon);
    expect(root.position.toArray()).toEqual(xf.position);
    expect(root.rotation.x).toBeCloseTo(-Math.PI / 2, 12);
    expect(root.scale.x).toBeCloseTo(xf.scale, 12);
    const mesh = root.children[0] as FakeSplatMesh;
    expect(mesh).toBeInstanceOf(FakeSplatMesh);
    expect(mesh.layers.mask).toBe(1 << SPLAT_THREE_LAYER);
    expect(mesh.worldModifier).toBeUndefined(); // no ripple → no per-splat modifier
    expect(h.hidden).toEqual([true]);
    expect(h.sceneChanges()).toBeGreaterThan(0);

    // Steady state: nothing new to fetch.
    await drain(h, 3);
    expect(h.fetchTile).toHaveBeenCalledTimes(9);
  });

  it('at rest every decoded tile lands in the same update (one re-sort for the batch); in motion one per frame', async () => {
    const h = makeLayer(); // maxInFlight 100 → all 9 fetches start at once
    await h.layer.open();
    h.layer.update();
    await settle(); // every tile has decoded, none is in the scene yet
    expect(h.fetchTile).toHaveBeenCalledTimes(9);
    expect(h.layer.getStats().tiles).toBe(0);
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(9);
    expect(h.layer.getStats().splats).toBe(90);
    // Imagery queues the same way: requested on landing, every texture lands at the next update.
    await settle();
    expect(h.loadTexture).toHaveBeenCalledTimes(9);
    const ground = h.scene.getObjectByName('splat-tile-ground:16/11614/23927') as THREE.Mesh;
    const mat = ground.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uHasMap.value).toBe(0);
    h.layer.update();
    expect(mat.uniforms.uHasMap.value).toBe(1);

    // Moving (no motion LoD here, so splat tiles still land): one landing per update, so a
    // frame mid-gesture never carries more than one upload.
    const m = makeLayer();
    await m.layer.open();
    m.layer.update();
    await settle();
    m.layer.setCameraMoving(true);
    m.layer.update();
    expect(m.layer.getStats().tiles).toBe(1);
    m.layer.update();
    expect(m.layer.getStats().tiles).toBe(2);
    m.layer.setCameraMoving(false);
    m.layer.update();
    expect(m.layer.getStats().tiles).toBe(9);
  });


  it('gives every tile a satellite ground plane 5 cm above the vector ground', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h, 24); // tiles, then their imagery, one landing per frame
    expect(h.loadTexture).toHaveBeenCalledTimes(9);
    expect(h.loadTexture.mock.calls[0][0]).toBe('https://tiles.test/16/11614/23927.webp'); // derived imagery: WebP twin first, PNG as the fallback

    const root = h.scene.getObjectByName('splat-tile-root:16/11614/23927')!;
    const ground = root.getObjectByName('splat-tile-ground:16/11614/23927') as THREE.Mesh;
    expect(ground).toBeInstanceOf(THREE.Mesh);
    expect(ground.layers.mask).toBe(1 << SPLAT_THREE_LAYER);
    expect(ground.renderOrder).toBeLessThan(0); // before the splat mesh
    const mat = ground.material as THREE.ShaderMaterial;
    // Finer levels win the depth test over coarser ones during a level transition, but a level
    // shown on its own is NOT biased: splats depth-test against this plane, and any slope-scaled
    // offset on it hides the base of the walls standing on it (see `groundDepthBias`).
    expect(mat.polygonOffset).toBe(true);
    expect(mat.polygonOffsetFactor).toBe(0);
    expect(mat.polygonOffsetUnits).toBe(0);
    expect(mat.uniforms.map.value).toBeInstanceOf(THREE.Texture);
    expect(mat.uniforms.uHasMap.value).toBe(1);
    expect(mat.transparent).toBe(true);
    expect(mat.fog).toBe(true);

    // Centre of the plane lands at the tile centre, GROUND_LIFT above y = 0.
    root.updateMatrixWorld(true);
    const centre = new THREE.Vector3();
    ground.getWorldPosition(centre);
    const tileMercator = (2 * Math.PI * 6378137) / 2 ** 16;
    const xf = splatTileTransform(16, 11614, 23927, ORIGIN.lat, ORIGIN.lon);
    const [ex, , ez] = splatLocalToScene(xf, tileMercator / 2, tileMercator / 2, 0);
    expect(centre.x).toBeCloseTo(ex, 6);
    expect(centre.z).toBeCloseTo(ez, 6);
    expect(centre.y).toBeCloseTo(0.05, 9);
    // The plane's +z (local up) normal maps onto scene +Y.
    const n = new THREE.Vector3(0, 0, 1).transformDirection(ground.matrixWorld);
    expect(n.y).toBeCloseTo(1, 9);
  });

  it('imageryTemplate overrides the .png default; null disables the ground', async () => {
    expect(imageryTemplateFrom('https://t/{z}/{x}/{y}.spz')).toBe('https://t/{z}/{x}/{y}.png');
    expect(imageryTemplateFrom('https://t/{z}/{x}/{y}.ply?v=2')).toBe('https://t/{z}/{x}/{y}.png?v=2');

    const custom = makeLayer({ imageryTemplate: 'https://img.test/{z}/{x}/{y}.jpg' });
    await custom.layer.open();
    await drain(custom);
    expect(custom.loadTexture.mock.calls[0][0]).toBe('https://img.test/16/11614/23927.jpg');

    const none = makeLayer({ imageryTemplate: null });
    await none.layer.open();
    await drain(none);
    expect(none.loadTexture).not.toHaveBeenCalled();
    const root = none.scene.getObjectByName('splat-tile-root:16/11614/23927')!;
    expect(root.children).toHaveLength(1); // just the SplatMesh
  });

  it('honours maxInFlight and remembers 404s', async () => {
    const h = makeLayer({ maxInFlight: 2 });
    // The centre row (y = 23927) has no tiles → 404 → null.
    h.fetchTile.mockImplementation(async (url) => (url.endsWith('/23927.spz') ? null : new ArrayBuffer(1)));
    await h.layer.open();
    h.layer.update();
    expect(h.fetchTile).toHaveBeenCalledTimes(2);
    await settle();
    // Drain the rest over a few ticks.
    await drain(h);
    expect(h.fetchTile).toHaveBeenCalledTimes(9);
    expect(h.layer.getStats().tiles).toBe(6); // 3 tiles in row y=23927 were 404
    await drain(h, 2);
    expect(h.fetchTile).toHaveBeenCalledTimes(9); // 404s not re-requested
  });

  it('setEnabled(false) clears tiles, restores the basemap, and discards in-flight loads', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    const meshes = h.meshes();
    expect(meshes).toHaveLength(9);

    // Start a load that is still in flight when we disable.
    let release!: (b: ArrayBuffer) => void;
    h.fetchTile.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    h.view.lon += 360 / 2 ** 16; // shift the window exactly one tile east
    h.layer.update();

    h.layer.setEnabled(false);
    expect(h.layer.isEnabled()).toBe(false);
    expect(h.layer.getStats()).toEqual({ tiles: 0, splats: 0, ...IDLE });
    expect(h.scene.getObjectByName('hbd-splats')!.children).toHaveLength(0);
    expect(h.scene.getObjectByName('hbd-splats')!.visible).toBe(false);
    expect(meshes.every((m) => m.disposed)).toBe(true);
    expect(h.hidden).toEqual([true, false]);

    release(new ArrayBuffer(5));
    await settle();
    expect(h.layer.getStats().tiles).toBe(0); // stale result discarded
    const calls = h.fetchTile.mock.calls.length;
    h.layer.update(); // disabled → no loads
    expect(h.fetchTile.mock.calls.length).toBe(calls);

    h.layer.setEnabled(true);
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    expect(h.hidden).toEqual([true, false, true]);
  });

  it('is forced off by the quality tier without forgetting the user choice', async () => {
    const h = makeLayer();
    await h.layer.open();
    h.layer.setTierAllowed(false);
    expect(h.layer.isEnabled()).toBe(false);
    h.layer.update();
    await settle();
    expect(h.fetchTile).not.toHaveBeenCalled();
    h.layer.setTierAllowed(true);
    expect(h.layer.isEnabled()).toBe(true);
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
  });

  it("'low' / 'mobile' tiers keep the overlay under lowTierMaxSplats (radius ≤ 1), evicting farthest-first", async () => {
    // (prefetchBand 0: on the low tier this camera sits right on the z16 / z15
    // threshold, where the prefetch would — rightly — fetch the z15 tile.)
    const h = makeLayer({ radius: 2, lowTierMaxSplats: 25, prefetchBand: 0 });
    await h.layer.open();
    await drain(h, 30);
    expect(h.layer.getStats()).toMatchObject({ tiles: 25, splats: 250, maxSplats: 1_200_000 });

    h.layer.setQualityTier('low');
    expect(h.layer.isEnabled()).toBe(true); // still on, just smaller
    // Radius capped at 1 → the 5×5 ring goes; then the budget (25 → 2 tiles)
    // drops the farthest of the 3×3, keeping the centre.
    let s = h.layer.getStats();
    expect(s).toMatchObject({ tiles: 2, splats: 20, maxSplats: 25, basemapHidden: true });
    expect(h.scene.getObjectByName('splat-tile-root:16/11614/23927')).toBeDefined();
    const calls = h.fetchTile.mock.calls.length;
    await drain(h);
    expect(h.fetchTile.mock.calls.length).toBe(calls); // nothing fits → no loads
    expect(h.layer.getStats().tiles).toBe(2);

    h.layer.setQualityTier('mobile'); // same class of budget, no churn
    expect(h.layer.getStats().tiles).toBe(2);

    h.layer.setQualityTier('high');
    await drain(h, 30);
    s = h.layer.getStats();
    expect(s).toMatchObject({ tiles: 25, splats: 250, maxSplats: 1_200_000 });
  });

  it('lowTierMaxSplats: 0 forces the overlay off on the low tiers (the old behaviour)', async () => {
    const h = makeLayer({ lowTierMaxSplats: 0 });
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    h.layer.setQualityTier('low');
    expect(h.layer.isEnabled()).toBe(false);
    expect(h.layer.getStats()).toEqual({ ...IDLE, tiles: 0, splats: 0, maxSplats: 0 });
    expect(h.hidden).toEqual([true, false]);
    h.layer.setQualityTier('high');
    expect(h.layer.isEnabled()).toBe(true);
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
  });

  it('maxSplats budget: loads nearest-first, stops at the budget, first tile always lands', async () => {
    // 10 "splats" per tile, budget 35 → centre + two edge tiles; with one
    // fetch at a time the mean-size estimate stops the 4th fetch cold.
    const h = makeLayer({ maxSplats: 35, maxInFlight: 1 });
    await h.layer.open();
    await drain(h, 20);
    expect(h.layer.getStats()).toMatchObject({ tiles: 3, splats: 30, maxSplats: 35 });
    expect(h.fetchTile).toHaveBeenCalledTimes(3);
    const keys = h.meshes().map((m) => m.name.replace('splat-tile:', ''));
    expect(keys).toContain('16/11614/23927'); // centre
    for (const k of keys) {
      const [, x, y] = k.split('/').map(Number);
      expect(Math.abs(x - 11614) + Math.abs(y - 23927)).toBe(k === '16/11614/23927' ? 0 : 1); // edges only
    }

    // A budget smaller than one tile still shows the centre tile.
    const tiny = makeLayer({ maxSplats: 4, maxInFlight: 1 });
    await tiny.layer.open();
    await drain(tiny);
    expect(tiny.layer.getStats()).toMatchObject({ tiles: 1, splats: 10 });
    expect(tiny.fetchTile).toHaveBeenCalledTimes(1);
  });

  it('maxSplats budget: with parallel fetches, tiles that decode over budget are dropped, not admitted', async () => {
    const h = makeLayer({ maxSplats: 35 }); // maxInFlight 100 → all 9 fetched before any lands
    await h.layer.open();
    await drain(h);
    expect(h.fetchTile).toHaveBeenCalledTimes(9);
    expect(h.layer.getStats()).toMatchObject({ tiles: 3, splats: 30 });
    const meshes = h.meshes();
    expect(meshes.every((m) => !m.disposed)).toBe(true);
    // Over-budget tiles are remembered for this centre — no refetch churn.
    await drain(h);
    expect(h.fetchTile).toHaveBeenCalledTimes(9);
  });

  it('maxSplats budget: when the view moves, farther tiles give way to nearer ones', async () => {
    const h = makeLayer({ maxSplats: 35, maxInFlight: 1 });
    await h.layer.open();
    await drain(h, 20);
    expect(h.layer.getStats().tiles).toBe(3);
    const before = new Set(h.meshes().map((m) => m.name));

    // One tile east: the old centre becomes an edge, the old west edge is now
    // 2 tiles away and must give way to the new centre. Residency stays at 3
    // tiles ≤ 35 splats, most relevant first — but a resident tile is only
    // swapped for one that matters CLEARLY more (hysteresis), so a neighbour
    // about as far away as the ideal one may stay.
    h.view.lon += 360 / 2 ** 16;
    await drain(h, 20);
    expect(h.layer.getStats()).toMatchObject({ tiles: 3, splats: 30 });
    const names = h.meshes().map((m) => m.name);
    expect(names).toContain('splat-tile:16/11615/23927'); // new centre
    for (const n of names) {
      const [, x, y] = n.replace('splat-tile:', '').split('/').map(Number);
      expect(Math.max(Math.abs(x - 11615), Math.abs(y - 23927))).toBeLessThanOrEqual(1);
    }
    expect(names).not.toContain('splat-tile:16/11613/23927'); // the old west edge went
    expect(names).not.toEqual([...before]);
  });

  it('evicts tiles that drift out of the keep zone', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    // Jump ~10 tiles east: the old window is far outside keepRadius (2).
    h.view.lon += 10 * (360 / 2 ** 16);
    h.layer.update();
    // Rounded union: they shrink out of the union first (UNION_LEAVE_MS) …
    expect(h.layer.getStats().tiles).toBe(9);
    h.setTime(UNION_LEAVE_MS);
    h.layer.update();
    // … and are gone once that has played.
    expect(h.layer.getStats().tiles).toBe(0);
    expect(h.hidden).toEqual([true, false]); // basemap back while nothing is resident
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    expect(h.hidden).toEqual([true, false, true]);
  });

  it('hideBasemap:false never touches the basemap mask', async () => {
    const h = makeLayer({ hideBasemap: false });
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    expect(h.layer.getStats().basemapHidden).toBe(false);
    expect(h.hidden).toEqual([]);
    h.layer.setEnabled(false);
    expect(h.hidden).toEqual([]);
  });

  it('names the basemap layers an app would expect to disappear', () => {
    expect([...SPLATS_HIDDEN_BASEMAP_LAYERS]).toEqual([
      'buildings', 'roads', 'landuse', 'water', 'waves', 'trees', 'grass', 'labels'
    ]);
  });

  it('dispose removes the group and the SparkRenderer', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    const sr = h.scene.children.find((c) => c instanceof FakeSparkRenderer) as FakeSparkRenderer;
    h.layer.dispose();
    expect(h.scene.getObjectByName('hbd-splats')).toBeUndefined();
    expect(h.scene.children.includes(sr)).toBe(false);
    expect(sr.disposed).toBe(true);
  });
});

describe('SplatsLayer ripple reveal', () => {
  async function loaded(config: Partial<import('../src/splats/types.js').SplatsConfig> = {}): Promise<Harness> {
    const h = makeLayer(config);
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    return h;
  }

  it('reveal:"ripple" on enable attaches the per-splat modifier and drives R(t) from the clock', async () => {
    const h = await loaded();
    h.layer.setEnabled(false);
    h.setTime(1000);
    h.layer.setEnabled(true, { reveal: 'ripple', durationMs: 1000, speedMps: 100 });
    expect(h.layer.isEnabled()).toBe(true);
    expect(h.layer.getStats().reveal).toBe('in');

    // Tiles that land mid-ripple join the current front (shared uniforms).
    await drain(h);
    const meshes = h.meshes();
    expect(meshes).toHaveLength(9);
    expect(meshes.every((m) => m.worldModifier !== undefined)).toBe(true);
    expect(meshes.every((m) => m.generatorUpdates === 1)).toBe(true);
    const modifier = meshes[0].worldModifier;
    expect(meshes.every((m) => m.worldModifier === modifier)).toBe(true); // one shared graph

    // The ground planes see the same front through the shared uniforms.
    const ground = h.scene.getObjectByName('splat-tile-ground:16/11614/23927') as THREE.Mesh;
    const u = (ground.material as THREE.ShaderMaterial).uniforms;
    expect(u.uActive.value).toBe(1);
    expect(u.uW.value).toBe(40);
    const p = new Projection(ORIGIN.lat, ORIGIN.lon).project(ORIGIN.lon, ORIGIN.lat);
    expect(u.uOrigin.value.x).toBeCloseTo(p.x, 9);
    expect(u.uOrigin.value.y).toBeCloseTo(-p.y, 9);

    h.setTime(1300); // 300 ms in → R = 30 m
    const bumps = meshes[0].versionBumps;
    h.layer.update();
    expect(u.uR.value).toBeCloseTo(30, 9);
    expect(u.uTime.value).toBeCloseTo(0.3, 9);
    // Spark re-runs the modifier (the union grow-in, also animating, may bump too).
    expect(meshes[0].versionBumps).toBeGreaterThan(bumps);
    expect(h.layer.getStats().reveal).toBe('in');

    h.setTime(2000); // done → steady state, modifier removed
    h.layer.update();
    expect(h.layer.getStats().reveal).toBe('none');
    expect(u.uActive.value).toBe(0);
    expect(meshes.every((m) => m.worldModifier === undefined)).toBe(true);
    expect(meshes.every((m) => m.generatorUpdates === 2)).toBe(true);
    expect(h.layer.getStats().tiles).toBe(9);
  });

  it('uses an explicit origin and replays the reveal over already-loaded tiles', async () => {
    const h = await loaded();
    const origin = { lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon - 0.002 };
    h.layer.setEnabled(true, { reveal: 'ripple', origin });
    expect(h.layer.getStats().reveal).toBe('in');
    const ground = h.scene.getObjectByName('splat-tile-ground:16/11614/23927') as THREE.Mesh;
    const u = (ground.material as THREE.ShaderMaterial).uniforms;
    const p = new Projection(ORIGIN.lat, ORIGIN.lon).project(origin.lon, origin.lat);
    expect(u.uOrigin.value.x).toBeCloseTo(p.x, 9);
    expect(u.uOrigin.value.y).toBeCloseTo(-p.y, 9);
    expect(h.meshes().every((m) => m.worldModifier !== undefined)).toBe(true);
  });

  it('reveal:"ripple" on disable collapses the front first, then unloads and restores the basemap', async () => {
    const h = await loaded();
    expect(h.hidden).toEqual([true]);
    h.setTime(500);
    h.layer.setEnabled(false, { reveal: 'ripple', durationMs: 1000, speedMps: 200 });
    expect(h.layer.isEnabled()).toBe(false); // the intent is immediate …
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, reveal: 'out', basemapHidden: true }); // … the teardown deferred
    expect(h.scene.getObjectByName('hbd-splats')!.visible).toBe(true);
    const ground = h.scene.getObjectByName('splat-tile-ground:16/11614/23927') as THREE.Mesh;
    const u = (ground.material as THREE.ShaderMaterial).uniforms;
    expect(u.uR.value).toBe(200); // starts at the max radius and shrinks

    // No new loads while collapsing.
    const calls = h.fetchTile.mock.calls.length;
    h.setTime(1000);
    h.layer.update();
    expect(u.uR.value).toBeCloseTo(100, 9);
    expect(h.fetchTile.mock.calls.length).toBe(calls);
    expect(h.layer.getStats().tiles).toBe(9);

    h.setTime(1500);
    h.layer.update();
    expect(h.layer.getStats()).toEqual({ tiles: 0, splats: 0, ...IDLE });
    expect(h.scene.getObjectByName('hbd-splats')!.visible).toBe(false);
    expect(h.hidden).toEqual([true, false]);
  });

  it('re-enabling mid-collapse cancels the out-ripple and keeps the tiles', async () => {
    const h = await loaded();
    h.layer.setEnabled(false, { reveal: 'ripple' });
    expect(h.layer.getStats().reveal).toBe('out');
    h.layer.setEnabled(true);
    expect(h.layer.isEnabled()).toBe(true);
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, reveal: 'none', basemapHidden: true });
    expect(h.meshes().every((m) => m.worldModifier === undefined)).toBe(true);
    h.setTime(10_000);
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(9);
  });

  it('a tier downgrade during a collapse tears down immediately', async () => {
    const h = await loaded();
    h.layer.setEnabled(false, { reveal: 'ripple' });
    h.layer.setTierAllowed(false);
    expect(h.layer.getStats()).toEqual({ tiles: 0, splats: 0, ...IDLE });
    expect(h.hidden).toEqual([true, false]);
  });

  it('falls back to an instant toggle when Spark has no dyno namespace', async () => {
    const h = makeLayer({}, { loadSpark: async () => makeFakeSpark(false) });
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    h.layer.setEnabled(false, { reveal: 'ripple' });
    expect(h.layer.getStats()).toEqual({ tiles: 0, splats: 0, ...IDLE });
    h.layer.setEnabled(true, { reveal: 'ripple' });
    expect(h.layer.getStats().reveal).toBe('none');
    await drain(h);
    expect(h.meshes().every((m) => m.worldModifier === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rounded union of the loaded tiles (pure maths; mirrored in GLSL).
// ---------------------------------------------------------------------------

describe('rounded union maths', () => {
  const W = (o: Partial<UnionWeights>): UnionWeights => ({ ...NO_NEIGHBOURS, ...o });

  it('one tile is a circle of radius half a tile about its centre', () => {
    expect(roundedUnionSigned(0.5, 0.5, NO_NEIGHBOURS)).toBeCloseTo(0.5, 12);
    for (const [u, v] of [[1, 0.5], [0, 0.5], [0.5, 1], [0.5, 0]]) {
      expect(roundedUnionSigned(u, v, NO_NEIGHBOURS)).toBeCloseTo(0, 12); // tangent to each side
    }
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      expect(roundedUnionSigned(u, v, NO_NEIGHBOURS)).toBeCloseTo(0.5 - Math.SQRT1_2, 12);
      expect(roundedUnionMask(u, v, NO_NEIGHBOURS)).toBe(0); // square corners are gone
    }
    expect(roundedUnionMask(0.5, 0.5, NO_NEIGHBOURS)).toBe(1);
    // Rotationally symmetric.
    for (let a = 0; a < 6.28; a += 0.37) {
      const s = roundedUnionSigned(0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a), NO_NEIGHBOURS);
      expect(s).toBeCloseTo(0.2, 12);
    }
  });

  it('growth g scales the radius: a new tile grows from its centre', () => {
    expect(roundedUnionMask(0.5, 0.5, NO_NEIGHBOURS, 0)).toBe(0);
    expect(roundedUnionSigned(0.75, 0.5, NO_NEIGHBOURS, 0.5)).toBeCloseTo(0, 12);
    expect(roundedUnionMask(0.6, 0.5, NO_NEIGHBOURS, 0.5)).toBe(1);
    expect(roundedUnionMask(0.9, 0.5, NO_NEIGHBOURS, 0.5)).toBe(0);
  });

  it('two edge-adjacent tiles make a pill: shared side fully joined, outer corners round', () => {
    const a = W({ e: 1 });
    for (const v of [0.1, 0.5, 0.9]) {
      expect(roundedUnionSigned(1, v, a)).toBeCloseTo(0.5 - Math.abs(v - 0.5), 12);
    }
    expect(roundedUnionMask(1, 0.5, a)).toBe(1);
    expect(roundedUnionMask(1, 0.2, a)).toBe(1);
    expect(roundedUnionSigned(1, 1, a)).toBeCloseTo(0, 12); // the straight side ends at the boundary
    expect(roundedUnionMask(0, 0, a)).toBe(0); // far corners still round
    expect(roundedUnionMask(0, 1, a)).toBe(0);
    // The west half is still the circle.
    expect(roundedUnionSigned(0.2, 0.5, a)).toBeCloseTo(0.2, 12);
  });

  it('the two tiles agree along the shared side (A at u=1 ≡ B at u=0), at rest and mid-animation', () => {
    for (const w of [1, 0.5, 0.31, 0.07, 0]) {
      for (let v = 0; v <= 1.0001; v += 0.05) {
        expect(roundedUnionSigned(1, v, W({ e: w }))).toBeCloseTo(roundedUnionSigned(0, v, W({ w })), 12);
        expect(roundedUnionSigned(v, 1, W({ n: w }))).toBeCloseTo(roundedUnionSigned(v, 0, W({ s: w })), 12);
      }
    }
    // Unequal growth: grown A (g=1) next to a still-growing B (g=0.7). The
    // bridge is as thick as the thinner tile on BOTH sides.
    for (const w of [0.1, 0.3, 0.5]) {
      for (let v = 0; v <= 1.0001; v += 0.05) {
        // (Compared inside the shape — outside it each side just reports the
        // distance to its own nearest piece, which nobody draws.)
        const a = roundedUnionSigned(1, v, W({ e: w }), 1, { ...ALL_NEIGHBOURS, e: 0.7 });
        const b = roundedUnionSigned(0, v, W({ w }), 0.7, ALL_NEIGHBOURS);
        expect(Math.max(a, 0)).toBeCloseTo(Math.max(b, 0), 12);
        expect(roundedUnionMask(1, v, W({ e: w }), 1, 0.03, { ...ALL_NEIGHBOURS, e: 0.7 })).toBeCloseTo(
          roundedUnionMask(0, v, W({ w }), 0.7, 0.03), 12
        );
      }
    }
    // … whereas ignoring the neighbour's growth would leave a step there.
    expect(roundedUnionSigned(1, 0.5, W({ e: 0.3 }), 1)).toBeGreaterThan(
      roundedUnionSigned(0, 0.5, W({ w: 0.3 }), 0.7) + 0.1
    );
  });

  it('with every neighbour at least as grown, s = r·g − d (the distance to the eroded set)', () => {
    const w = W({ e: 1, n: 0.4, ne: 1, s: 0.2, sw: 1 });
    for (let u = 0; u <= 1; u += 0.125) {
      for (let v = 0; v <= 1; v += 0.125) {
        expect(roundedUnionSigned(u, v, w, 0.8)).toBeCloseTo(0.4 - roundedUnionDistance(u, v, w), 12);
      }
    }
  });

  it('a complete 2×2 block is a rounded square; an L keeps its concave corner open', () => {
    const block = W({ e: 1, n: 1, ne: 1 });
    expect(roundedUnionSigned(1, 1, block)).toBeCloseTo(0.5, 12); // the 4-tile corner is filled
    expect(roundedUnionMask(0.9, 0.9, block)).toBe(1);
    expect(roundedUnionMask(0, 0, block)).toBe(0); // outer corner round
    const ell = W({ e: 1, n: 1 }); // diagonal missing
    expect(roundedUnionSigned(1, 1, ell)).toBeCloseTo(0, 12);
    expect(roundedUnionSigned(0.9, 0.9, ell)).toBeCloseTo(0.1, 12);
    // A block only counts as far as BOTH its edges do.
    expect(roundedUnionSigned(0.9, 0.9, W({ e: 1, ne: 1 }))).toBeCloseTo(
      roundedUnionSigned(0.9, 0.9, W({ e: 1 })), 12
    );
    // Fractional block weight grows the fill out from the centre.
    expect(roundedUnionSigned(1, 1, W({ e: 1, n: 1, ne: 0.25 }))).toBeCloseTo(
      0.5 - Math.hypot(0.25, 0.25), 12
    );
  });

  it('an interior tile (all 8 neighbours) is fully shown, corners included', () => {
    for (let u = 0; u <= 1; u += 0.1) {
      for (let v = 0; v <= 1; v += 0.1) expect(roundedUnionMask(u, v, ALL_NEIGHBOURS)).toBe(1);
    }
  });

  it('matches a brute-force morphological opening of the tile union', () => {
    // Loaded tiles on a 3×3 grid (x east, y NORTH here), everything else empty.
    const layouts: string[][] = [
      ['#..', '##.', '.##'], // staircase (rows listed north → south)
      ['###', '#.#', '###'], // ring
      ['.#.', '###', '.#.'], // plus
      ['##.', '##.', '..#'] // block + a diagonal-only neighbour
    ];
    for (const rows of layouts) {
      const has = (x: number, y: number): boolean =>
        x >= 0 && x < 3 && y >= 0 && y < 3 && rows[2 - y][x] === '#';
      // Distance from a point to the nearest UNLOADED tile square.
      const clearance = (px: number, py: number): number => {
        let best = Infinity;
        for (let x = -1; x <= 3; x++) {
          for (let y = -1; y <= 3; y++) {
            if (has(x, y)) continue;
            const dx = Math.max(x - px, 0, px - (x + 1));
            const dy = Math.max(y - py, 0, py - (y + 1));
            best = Math.min(best, Math.hypot(dx, dy));
          }
        }
        return best;
      };
      // Erosion by r = 0.5, sampled on a fine lattice that includes the tile
      // centres / centre segments / centre squares.
      const eroded: Array<[number, number]> = [];
      for (let i = 0; i <= 60; i++) {
        for (let j = 0; j <= 60; j++) {
          const cx = i / 20;
          const cy = j / 20;
          if (clearance(cx, cy) >= 0.5 - 1e-9) eroded.push([cx, cy]);
        }
      }
      for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 3; y++) {
          if (!has(x, y)) continue;
          const on = (dx: number, dy: number): number => (has(x + dx, y + dy) ? 1 : 0);
          const w: UnionWeights = {
            e: on(1, 0), w: on(-1, 0), n: on(0, 1), s: on(0, -1),
            ne: on(1, 1), nw: on(-1, 1), se: on(1, -1), sw: on(-1, -1)
          };
          for (let u = 0.04; u < 1; u += 0.115) {
            for (let v = 0.04; v < 1; v += 0.115) {
              let d = Infinity;
              for (const [cx, cy] of eroded) d = Math.min(d, Math.hypot(x + u - cx, y + v - cy));
              const brute = 0.5 - d;
              const ours = roundedUnionSigned(u, v, w);
              // Same OUTLINE (and the same values across the soft edge beside
              // it). Deep inside they may differ: at a concave corner the true
              // erosion is a little fatter than the centre segments, which
              // moves no outline — both are far past the feather there.
              const where = `${rows.join('|')} tile ${x},${y} p ${u.toFixed(2)},${v.toFixed(2)}`;
              if (brute < 0.12 || ours < 0.12) {
                expect(Math.abs(brute - ours), where).toBeLessThan(0.04); // ≤ half a lattice diagonal
              } else {
                expect(ours, where).toBeLessThanOrEqual(brute + 0.04);
              }
            }
          }
        }
      }
    }
  });

  it('the soft edge lies inside the shape: 0 on the outline, 1 two feathers in', () => {
    expect(roundedUnionMask(1, 0.5, NO_NEIGHBOURS, 1, 0.03)).toBe(0); // on the circle
    expect(roundedUnionMask(0.97, 0.5, NO_NEIGHBOURS, 1, 0.03)).toBeCloseTo(0.5, 9);
    expect(roundedUnionMask(0.94, 0.5, NO_NEIGHBOURS, 1, 0.03)).toBe(1);
    let prev = -1;
    for (let u = 1; u >= 0.9; u -= 0.005) {
      const m = roundedUnionMask(u, 0.5, NO_NEIGHBOURS, 1, 0.03);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
    // feather 0 → a hard step.
    expect(roundedUnionMask(0.99, 0.5, NO_NEIGHBOURS, 1, 0)).toBe(1);
    expect(roundedUnionMask(1, 0.5, NO_NEIGHBOURS, 1, 0)).toBe(0);
  });

  it('animation curves: ease-out growth, bridge after g passes 0.6, linear leave', () => {
    expect(unionGrowth(-5, 700)).toBe(0);
    expect(unionGrowth(0, 700)).toBe(0);
    expect(unionGrowth(700, 700)).toBe(1);
    expect(unionGrowth(9999, 700)).toBe(1);
    expect(unionGrowth(350, 700)).toBeCloseTo(0.875, 12); // ease-out: most of it early
    expect(unionGrowth(0, 0)).toBe(1); // growMs 0 = no animation
    for (const g of [0, 0.3, 0.6, 0.99, 1]) {
      expect(unionGrowth(unionGrowthElapsed(g, 700), 700)).toBeCloseTo(g, 12);
    }
    const delay = unionBridgeDelayMs(700);
    expect(unionGrowth(delay, 700)).toBeCloseTo(0.6, 12);
    expect(delay).toBeGreaterThan(150);
    expect(delay).toBeLessThan(220);
    expect(unionBridgeWeight(delay, 700)).toBe(0);
    expect(unionBridgeWeight(delay - 50, 700)).toBe(0);
    // The join closes at 0.5 (each tile draws its own half), so the ramp
    // spends the whole duration getting there and then reads "joined".
    expect(unionBridgeWeight(delay + 350, 700)).toBeCloseTo(0.25, 12);
    expect(unionBridgeWeight(delay + 699, 700)).toBeLessThan(0.5);
    expect(unionBridgeWeight(delay + 700, 700)).toBe(1);
    expect(unionSettleMs(700)).toBeCloseTo(delay + 700, 12);
    expect(unionBridgeWeight(0, 0)).toBe(1);
    expect(unionSettleMs(0)).toBe(0);
    // … and 0.5 → 1 really is invisible inside the tile's own square.
    for (let u = 0; u <= 1; u += 0.1) {
      for (let v = 0; v <= 1; v += 0.1) {
        expect(roundedUnionSigned(u, v, { ...ALL_NEIGHBOURS })).toBeCloseTo(
          roundedUnionSigned(u, v, { e: 0.5, w: 0.5, n: 0.5, s: 0.5, ne: 0.5, nw: 0.5, se: 0.5, sw: 0.5 }), 12
        );
      }
    }
    expect(unionLeaveFactor(0)).toBe(1);
    expect(unionLeaveFactor(150)).toBeCloseTo(0.5, 12);
    expect(unionLeaveFactor(UNION_LEAVE_MS)).toBe(0);
    expect(UNION_LEAVE_MS).toBe(300);
  });

  it('resolves the roundedUnion option', () => {
    expect(resolveRoundedUnion(undefined)).toEqual({ enabled: true, feather: 0.03, growMs: 700 });
    expect(resolveRoundedUnion(true)).toEqual({ enabled: true, feather: 0.03, growMs: 700 });
    expect(resolveRoundedUnion(false).enabled).toBe(false);
    expect(resolveRoundedUnion({ feather: 0.1, growMs: 0 })).toEqual({ enabled: true, feather: 0.1, growMs: 0 });
    expect(resolveRoundedUnion({ feather: NaN, growMs: -1 })).toEqual({ enabled: true, feather: 0.03, growMs: 700 });
    expect(resolveRoundedUnion({ feather: 9 }).feather).toBe(0.25); // never wider than the shape
  });

  it('ships one GLSL twin for both the ground and the splat modifier', () => {
    expect(ROUNDED_UNION_GLSL).toContain('float hbdRoundedUnionMask(vec2 p, vec4 edge, vec4 corner, vec4 edgeG, vec4 cornerG');
    expect(ROUNDED_UNION_GLSL).toContain('const float R = 0.5;');
  });
});

describe('SplatsLayer rounded union', () => {
  const CX = 11614;
  const CY = 23927;
  const SETTLE = Math.ceil(unionSettleMs(700)) + 1;

  function unionOf(h: Harness, x: number, y: number): {
    g: number; edge: number[]; corner: number[]; feather: number;
  } {
    const ground = h.scene.getObjectByName(`splat-tile-ground:16/${x}/${y}`) as THREE.Mesh;
    const u = (ground.material as THREE.ShaderMaterial).uniforms;
    return {
      g: u.uUnionG.value as number,
      edge: (u.uUnionEdge.value as THREE.Vector4).toArray(),
      corner: (u.uUnionCorner.value as THREE.Vector4).toArray(),
      feather: u.uUnionFeather.value as number
    };
  }
  const meshOf = (h: Harness, x: number, y: number): FakeSplatMesh =>
    h.meshes().find((m) => m.name === `splat-tile:16/${x}/${y}`)!;

  it('masks every tile (splat objectModifier + ground uniforms) and settles to the union of the 3×3', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    expect(h.meshes().every((m) => m.objectModifier !== undefined)).toBe(true);
    expect(h.meshes().every((m) => m.worldModifier === undefined)).toBe(true);
    // Per-tile graphs (the weights differ per tile), never a rebuilt generator.
    expect(new Set(h.meshes().map((m) => m.objectModifier)).size).toBe(9);
    expect(h.meshes().every((m) => m.generatorUpdates === 0)).toBe(true);

    h.setTime(SETTLE);
    h.layer.update();
    // Centre: all eight neighbours → a plain full square.
    expect(unionOf(h, CX, CY)).toEqual({ g: 1, edge: [1, 1, 1, 1], corner: [1, 1, 1, 1], feather: 0.03 });
    // Tile y grows SOUTH: the tile at y − 1 is the NORTH neighbour, so the
    // window's north-west tile joins only E, S and the SE block.
    expect(unionOf(h, CX - 1, CY - 1)).toMatchObject({ edge: [1, 0, 0, 1], corner: [0, 0, 1, 0] });
    // North-middle tile: E, W, S + both southern blocks.
    expect(unionOf(h, CX, CY - 1)).toMatchObject({ edge: [1, 1, 0, 1], corner: [0, 0, 1, 1] });
    // South-east tile: W, N + the NW block.
    expect(unionOf(h, CX + 1, CY + 1)).toMatchObject({ edge: [0, 1, 1, 0], corner: [0, 1, 0, 0] });
  });

  it('a landed tile grows from its centre, then the bridges grow; frames are requested only meanwhile', async () => {
    const h = makeLayer({ maxSplats: 25, maxInFlight: 1 }); // centre + one edge tile
    // The centre tile answers at once; the next one waits at a gate.
    const gates: Array<() => void> = [];
    h.fetchTile.mockImplementation((url) =>
      url.endsWith(`/${CX}/${CY}.spz`)
        ? Promise.resolve(new ArrayBuffer(10))
        : new Promise((res) => gates.push(() => res(new ArrayBuffer(10))))
    );
    await h.layer.open();
    await drain(h, 3); // the centre tile lands at t = 0
    expect(h.layer.getStats().tiles).toBe(1);
    expect(unionOf(h, CX, CY).g).toBe(0);
    h.setTime(350);
    h.layer.update();
    expect(unionOf(h, CX, CY).g).toBeCloseTo(0.875, 9);
    expect(unionOf(h, CX, CY).edge).toEqual([0, 0, 0, 0]); // a lone circle

    h.setTime(1000);
    gates[0]();
    await drain(h, 6); // the second tile lands at t = 1000
    expect(h.layer.getStats().tiles).toBe(2);
    const second = h.meshes().find((m) => m.name !== `splat-tile:16/${CX}/${CY}`)!;
    const [, sx, sy] = second.name.replace('splat-tile:', '').split('/').map(Number);
    const side = sx > CX ? 0 : sx < CX ? 1 : sy < CY ? 2 : 3; // E, W, N, S of the centre
    const back = [1, 0, 3, 2][side];
    expect(unionOf(h, CX, CY).edge).toEqual([0, 0, 0, 0]); // circle first …
    expect(unionOf(h, sx, sy).g).toBe(0);

    const delay = unionBridgeDelayMs(700);
    h.setTime(1000 + delay + 350); // … then the bridge, from BOTH sides alike
    const centre = meshOf(h, CX, CY);
    const bumps = centre.versionBumps;
    h.layer.update();
    expect(unionOf(h, CX, CY).edge[side]).toBeCloseTo(0.25, 9);
    expect(unionOf(h, sx, sy).edge[back]).toBeCloseTo(0.25, 9);
    expect(unionOf(h, CX, CY).g).toBe(1);
    expect(centre.versionBumps).toBe(bumps + 1); // Spark re-runs the grown tile's modifier too

    h.setTime(1000 + SETTLE);
    h.layer.update();
    expect(unionOf(h, CX, CY).edge[side]).toBe(1);
    expect(unionOf(h, sx, sy)).toMatchObject({ g: 1 });
    // Settled: no more version bumps, no more frames requested.
    const b2 = centre.versionBumps;
    const changes = h.sceneChanges();
    h.setTime(5000);
    await drain(h, 3);
    expect(centre.versionBumps).toBe(b2);
    expect(h.sceneChanges()).toBe(changes);
  });

  it('out-of-range tiles shrink away over 300 ms; coming back in range regrows them', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    h.setTime(SETTLE);
    h.layer.update();
    // Two tiles east: the old western column (now 3 away) leaves the keep zone.
    h.view.lon += 2 * (360 / 2 ** 16);
    h.fetchTile.mockImplementation(async () => null); // nothing new to load
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(9);
    h.setTime(SETTLE + 150);
    h.layer.update();
    expect(unionOf(h, CX - 1, CY).g).toBeCloseTo(0.5, 9); // shrinking …
    expect(unionOf(h, CX, CY).edge[1]).toBeCloseTo(0.5, 9); // … and its neighbour's join retracts
    expect(unionOf(h, CX, CY).g).toBe(1);

    // Back before it finished: it regrows from where it got to.
    h.view.lon -= 2 * (360 / 2 ** 16);
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(9);
    expect(unionOf(h, CX - 1, CY).g).toBeCloseTo(0.5, 9);
    h.setTime(SETTLE + 150 + SETTLE);
    h.layer.update();
    expect(unionOf(h, CX - 1, CY).g).toBe(1);
    expect(unionOf(h, CX, CY).edge).toEqual([1, 1, 1, 1]);

    // Away again, and this time let it finish.
    h.view.lon += 2 * (360 / 2 ** 16);
    h.layer.update();
    h.setTime(SETTLE + 150 + SETTLE + UNION_LEAVE_MS);
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(6);
    expect(meshOf(h, CX - 1, CY)).toBeUndefined();
    expect(unionOf(h, CX, CY).edge).toEqual([1, 0, 1, 1]);
  });

  it('budget evictions are immediate; only the neighbours\' joins animate (a ghost, no memory held)', async () => {
    const h = makeLayer({ lowTierMaxSplats: 25 });
    await h.layer.open();
    await drain(h);
    h.setTime(SETTLE);
    h.layer.update();
    const before = h.meshes();
    h.layer.setQualityTier('low'); // 90 → ≤ 25 splats, farthest first, at once
    expect(h.layer.getStats().tiles).toBe(2);
    expect(before.filter((m) => m.disposed)).toHaveLength(7);
    const kept = h.meshes().find((m) => m.name !== `splat-tile:16/${CX}/${CY}`)!;
    const [, kx, ky] = kept.name.replace('splat-tile:', '').split('/').map(Number);
    const side = kx > CX ? 0 : kx < CX ? 1 : ky < CY ? 2 : 3;
    h.setTime(SETTLE + 150);
    h.layer.update();
    const mid = unionOf(h, CX, CY).edge;
    mid.forEach((w, i) => expect(w).toBeCloseTo(i === side ? 1 : 0.5, 9));
    h.setTime(SETTLE + UNION_LEAVE_MS);
    h.layer.update();
    expect(unionOf(h, CX, CY).edge).toEqual([0, 1, 2, 3].map((i) => (i === side ? 1 : 0)));
    expect(unionOf(h, CX, CY).corner).toEqual([0, 0, 0, 0]);
    // Settled again → idle.
    const changes = h.sceneChanges();
    h.setTime(SETTLE + 5000);
    await drain(h, 3);
    expect(h.sceneChanges()).toBe(changes);
  });

  it('composes with the ripple reveal: both modifiers attached, independently driven', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    h.layer.setEnabled(true, { reveal: 'ripple' });
    expect(h.meshes().every((m) => m.worldModifier !== undefined && m.objectModifier !== undefined)).toBe(true);
    h.setTime(60_000);
    h.layer.update();
    expect(h.layer.getStats().reveal).toBe('none');
    expect(h.meshes().every((m) => m.worldModifier === undefined && m.objectModifier !== undefined)).toBe(true);
    expect(unionOf(h, CX, CY).g).toBe(1);
  });

  it('growMs: 0 applies the union without animating', async () => {
    const h = makeLayer({ roundedUnion: { growMs: 0, feather: 0.05 } });
    await h.layer.open();
    await drain(h);
    expect(unionOf(h, CX, CY)).toEqual({ g: 1, edge: [1, 1, 1, 1], corner: [1, 1, 1, 1], feather: 0.05 });
    h.view.lon += 10 * (360 / 2 ** 16);
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(0); // no shrink-out either
  });

  it('roundedUnion: false restores plain square tiles', async () => {
    const h = makeLayer({ roundedUnion: false });
    await h.layer.open();
    await drain(h, 24); // tiles, then their imagery
    expect(h.layer.getStats().tiles).toBe(9);
    // The per-tile modifier stays (it carries the level dissolve); the union
    // mask inside it — like the ground shader's — is skipped (feather < 0).
    expect(h.meshes().every((m) => m.objectModifier !== undefined)).toBe(true);
    expect(unionOf(h, CX, CY).feather).toBeLessThan(0);
    const changes = h.sceneChanges();
    h.setTime(5000);
    await drain(h, 3);
    expect(h.sceneChanges()).toBe(changes);
    h.view.lon += 10 * (360 / 2 ** 16);
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(0); // evicted at once, as before
  });

  it('still masks the ground when this Spark build has no raw-GLSL dyno node', async () => {
    const spark = makeFakeSpark();
    delete (spark.dyno as Partial<SparkDynoLike>).Dyno;
    const h = makeLayer({}, { loadSpark: async () => spark });
    await h.layer.open();
    await drain(h);
    expect(h.meshes().every((m) => m.objectModifier === undefined)).toBe(true);
    h.setTime(SETTLE);
    h.layer.update();
    expect(unionOf(h, CX, CY)).toMatchObject({ g: 1, edge: [1, 1, 1, 1] });
  });
});

// ---------------------------------------------------------------------------
// Live options (`map.setSplatsOptions` → `SplatsLayer.applyOptions`).
// ---------------------------------------------------------------------------

describe('SplatsLayer.applyOptions', () => {
  const BASE = { urlTemplate: 'https://tiles.test/{z}/{x}/{y}.spz', radius: 1, maxInFlight: 100 };
  const opts = (patch: Partial<import('../src/splats/types.js').SplatsConfig>) =>
    resolveSplatsOptions({ cover: false,  ...BASE, ...patch });
  const sparkRendererOf = (h: Harness): FakeSparkRenderer & { maxStdDev?: number; minSortIntervalMs?: number } =>
    h.scene.children.find((c) => c instanceof FakeSparkRenderer) as FakeSparkRenderer;

  it('shrinking the budget evicts farthest-first at once; growing it lets the window refill', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, splats: 90 });

    h.layer.applyOptions(opts({ maxSplats: 30 }));
    expect(h.layer.getStats()).toMatchObject({ tiles: 3, splats: 30, maxSplats: 30 });
    // The survivors are the nearest: the centre tile and two edge neighbours.
    const c = lonLatToTile(ORIGIN.lon, ORIGIN.lat, 16);
    expect(h.scene.getObjectByName(`splat-tile:16/${c.x}/${c.y}`)).toBeDefined();
    await drain(h, 6);
    expect(h.layer.getStats().tiles).toBe(3); // and it stays within the budget

    h.layer.applyOptions(opts({ maxSplats: 1_000 }));
    await drain(h);
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, maxSplats: 1_000 });
  });

  it('radius and minZoom apply on the next update', async () => {
    const h = makeLayer({ radius: 0 });
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(1);
    h.layer.applyOptions(opts({ radius: 1 }));
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
    h.layer.applyOptions(opts({ radius: 1, minZoom: 18 })); // the view is at z17
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(0);
  });

  it('hideBasemap releases / re-takes the basemap without touching the tiles', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    expect(h.hidden).toEqual([true]);
    h.layer.applyOptions(opts({ hideBasemap: false }));
    expect(h.hidden).toEqual([true, false]);
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, basemapHidden: false });
    h.layer.applyOptions(opts({ hideBasemap: true }));
    expect(h.hidden).toEqual([true, false, true]);
  });

  it('feather retunes ground + splat uniforms in place; growMs applies to the next landing', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h, 24);
    const c = lonLatToTile(ORIGIN.lon, ORIGIN.lat, 16);
    const ground = h.scene.getObjectByName(`splat-tile-ground:16/${c.x}/${c.y}`) as THREE.Mesh;
    const feather = (): number => (ground.material as THREE.ShaderMaterial).uniforms.uUnionFeather.value as number;
    expect(feather()).toBeCloseTo(0.03, 9);
    const mesh = h.meshes().find((m) => m.name === `splat-tile:16/${c.x}/${c.y}`)!;
    const bumps = mesh.versionBumps;
    const generators = mesh.generatorUpdates;

    h.layer.applyOptions(opts({ roundedUnion: { feather: 0.1, growMs: 0 } }));
    expect(feather()).toBeCloseTo(0.1, 9);
    expect(mesh.versionBumps).toBe(bumps + 1); // Spark re-runs the modifier…
    expect(mesh.generatorUpdates).toBe(generators); // …without recompiling it
    expect(h.layer.getStats().tiles).toBe(9); // nothing reloaded
    expect(h.fetchTile).toHaveBeenCalledTimes(9);
  });

  it("drives Spark's maxStdDev and sort spacing (with the low-tier floor)", async () => {
    const h = makeLayer();
    await h.layer.open();
    h.layer.applyOptions(opts({ maxStdDev: 2, sortIntervalMs: 40 }));
    expect(sparkRendererOf(h).maxStdDev).toBe(2);
    expect(sparkRendererOf(h).minSortIntervalMs).toBe(40);
    h.layer.setQualityTier('low');
    h.layer.applyOptions(opts({ maxStdDev: 2, sortIntervalMs: 40 }));
    expect(sparkRendererOf(h).minSortIntervalMs).toBe(250);
    h.layer.applyOptions(opts({ sortIntervalMs: 400 }));
    expect(sparkRendererOf(h).minSortIntervalMs).toBe(400);
  });

  it('lowTierMaxSplats crossing 0 opens / closes the low-tier gate live', async () => {
    const h = makeLayer({ lowTierMaxSplats: 0 });
    await h.layer.open();
    h.layer.setQualityTier('low');
    await drain(h);
    expect(h.layer.isEnabled()).toBe(false);
    h.layer.applyOptions(opts({ lowTierMaxSplats: 25 }));
    expect(h.layer.isEnabled()).toBe(true);
    await drain(h);
    expect(h.layer.getStats()).toMatchObject({ tiles: 2, maxSplats: 25 });
    h.layer.applyOptions(opts({ lowTierMaxSplats: 0 }));
    expect(h.layer.isEnabled()).toBe(false);
    expect(h.layer.getStats().tiles).toBe(0);
  });

  it('two overlapping open() calls still add exactly one SparkRenderer', async () => {
    const h = makeLayer();
    await Promise.all([h.layer.open(), h.layer.open()]);
    expect(h.scene.children.filter((c) => c instanceof FakeSparkRenderer)).toHaveLength(1);
  });
});

describe('SplatsLayer.rebuild', () => {
  const URL_2 = 'https://other.test/{z}/{x}/{y}.ply';
  it('drops every tile, keeps the one Spark renderer, and refills from the new source', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h, 24);
    expect(h.layer.getStats().tiles).toBe(9);
    const spark = h.scene.children.filter((c) => c instanceof FakeSparkRenderer);
    const old = h.meshes();

    h.layer.rebuild(resolveSplatsOptions({ cover: false,  urlTemplate: URL_2, maxInFlight: 100, roundedUnion: false, imageryTemplate: null }));
    expect(h.layer.getStats()).toMatchObject({ tiles: 0, basemapHidden: false });
    expect(h.hidden).toEqual([true, false]); // the basemap is back until new tiles land
    expect(old.every((m) => m.disposed)).toBe(true);
    expect(h.layer.isEnabled()).toBe(true); // the enabled state carries over

    h.fetchTile.mockClear();
    h.loadTexture.mockClear();
    await drain(h, 24);
    expect(h.layer.getStats().tiles).toBe(9);
    expect(h.fetchTile.mock.calls.every(([u]) => u.startsWith('https://other.test/16/') && u.endsWith('.ply'))).toBe(true);
    expect(h.loadTexture).not.toHaveBeenCalled(); // imageryTemplate: null
    expect(h.meshes().length).toBe(9); // union off → square tiles (the modifier only carries the level fade)
    const after = h.scene.children.filter((c) => c instanceof FakeSparkRenderer);
    expect(after).toEqual(spark);
    expect((after[0] as FakeSparkRenderer).disposed).toBe(false);
  });

  it('forgets 404s from the old source and stays off when disabled', async () => {
    const h = makeLayer({ enabled: false });
    h.fetchTile.mockImplementation(async () => null);
    await h.layer.open();
    h.layer.setEnabled(true);
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(0);
    const misses = h.fetchTile.mock.calls.length;
    await drain(h, 3);
    expect(h.fetchTile.mock.calls.length).toBe(misses); // remembered as missing

    h.fetchTile.mockImplementation(async () => new ArrayBuffer(10));
    h.layer.setEnabled(false);
    h.layer.rebuild(resolveSplatsOptions({ cover: false,  urlTemplate: URL_2, maxInFlight: 100 }));
    await drain(h, 3);
    expect(h.layer.getStats().tiles).toBe(0); // still off
    h.layer.setEnabled(true);
    await drain(h);
    expect(h.layer.getStats().tiles).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Tile pyramid — level selection, transitions, budget, per-level union.
// ---------------------------------------------------------------------------

describe('SplatsLayer tile pyramid', () => {
  // ORIGIN's tile per level: z16 11614/23927 → z15 5807/11963 → z14 2903/5981.
  const FADE = 350; // levelFadeMs default
  const levels = (h: Harness): Record<number, number> => {
    const out: Record<number, number> = {};
    for (const m of h.meshes()) {
      const z = Number(m.name.replace('splat-tile:', '').split('/')[0]);
      out[z] = (out[z] ?? 0) + 1;
    }
    return out;
  };
  const fetched = (h: Harness, z: number): number =>
    h.fetchTile.mock.calls.filter(([u]) => u.includes(`/${z}/`)).length;
  /** Advance the clock past the dissolve, tick (the outgoing splats are
   *  released, their grounds linger), then past the ground fade, tick. */
  const finishTransition = async (h: Harness, from: number): Promise<number> => {
    h.setTime(from + FADE);
    await drain(h, 2);
    h.setTime(from + 2 * FADE);
    await drain(h, 2);
    return from + 2 * FADE;
  };

  it('the level follows the camera zoom; the window is always `radius` tiles of that level', async () => {
    for (const [zoom, z, centre] of [
      [16.5, 16, '16/11614/23927'],
      [15.5, 15, '15/5807/11963'],
      [14.5, 14, '14/2903/5981'],
      [13.5, 13, '13/1451/2990']
    ] as Array<[number, number, string]>) {
      const h = makeLayer();
      h.view.zoom = zoom;
      await h.layer.open();
      await drain(h);
      expect(h.fetchTile.mock.calls[0][0]).toBe(`https://tiles.test/${centre}.spz`);
      // Same tile count and resident splats at every level — the dynamic quality.
      expect(h.layer.getStats()).toEqual({ tiles: 9, splats: 90, ...FULL, tileZoom: z });
      expect(levels(h)).toEqual({ [z]: 9 });
      // Imagery is requested at the tile's own level.
      expect(h.loadTexture.mock.calls[0][0]).toBe(`https://tiles.test/${centre}.webp`);
    }
  });

  it('honours the hysteresis: a camera hovering on a boundary keeps its level (no refetch)', async () => {
    const h = makeLayer({ prefetchBand: 0 }); // (the prefetch has its own tests below)
    h.view.zoom = 15.5;
    await h.layer.open();
    await drain(h);
    for (const zoom of [15.95, 16.05, 16.1, 15.9, 16.14]) {
      h.view.zoom = zoom;
      await drain(h, 2);
    }
    expect(h.layer.getStats().tileZoom).toBe(15);
    expect(fetched(h, 16)).toBe(0);
    h.view.zoom = 16.2;
    await drain(h, 1);
    expect(h.layer.getStats().tileZoom).toBe(16);
    h.view.zoom = 15.9; // back under 16 but inside the band → stays z16
    await drain(h, 1);
    expect(h.layer.getStats().tileZoom).toBe(16);
  });

  it('zoom OUT: old tiles stay until the parent over them has LANDED, then dissolve out under it', async () => {
    const h = makeLayer();
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    expect(levels(h)).toEqual({ 16: 9 });

    h.setTime(10_000);
    h.view.zoom = 15.5;
    h.layer.update(); // switch: nothing of z15 has landed — every z16 tile stays, untouched
    expect(h.layer.getStats().tileZoom).toBe(15);
    expect(levels(h)).toEqual({ 16: 9 });
    expect(h.layer.getTransitionState().tiles.every((t) => t.fade === 1)).toBe(true);
    await drain(h); // the z15 window lands (nearest-first) …
    expect(h.fetchTile.mock.calls[9][0]).toBe('https://tiles.test/15/5807/11963.spz');
    // … and both levels are resident for the length of the dissolve.
    expect(levels(h)).toEqual({ 16: 9, 15: 9 });

    h.setTime(10_000 + FADE - 1);
    await drain(h, 2);
    expect(levels(h)).toEqual({ 16: 9, 15: 9 });

    // Done → the z16 splats are released at once; the basemap never flashed.
    h.setTime(10_000 + FADE);
    await drain(h, 2);
    expect(levels(h)).toEqual({ 15: 9 });
    expect(h.layer.getStats()).toEqual({ tiles: 9, splats: 90, ...FULL, tileZoom: 15 });
    expect(h.hidden).toEqual([true]);
  });

  it('zoom OUT: a tile whose parent is missing stays as the fallback', async () => {
    const h = makeLayer();
    // Only the centre z15 tile exists.
    h.fetchTile.mockImplementation(async (url) =>
      url.includes('/15/') && !url.includes('/15/5807/11963') ? null : new ArrayBuffer(10));
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    h.setTime(1000);
    h.view.zoom = 15.5;
    await drain(h);
    await finishTransition(h, 1000);
    // z15 5807/11963 covers z16 x 11614–11615, y 23926–23927: those four
    // went, the other five z16 tiles have no parent and stay.
    expect(levels(h)).toEqual({ 15: 1, 16: 5 });
    for (const m of h.meshes()) {
      const [z, x, y] = m.name.replace('splat-tile:', '').split('/').map(Number);
      if (z === 16) expect(x >> 1 === 5807 && y >> 1 === 11963).toBe(false);
    }
  });

  it('zoom IN: a coarse tile goes when its children in the new window are settled; the periphery when the window is', async () => {
    const h = makeLayer();
    h.view.zoom = 15.5;
    await h.layer.open();
    await drain(h);
    expect(levels(h)).toEqual({ 15: 9 });

    h.setTime(5000);
    h.view.zoom = 16.5;
    h.layer.update(); // switch: nothing of z16 has landed — all nine z15 stay
    await settle();
    expect(h.layer.getStats().tileZoom).toBe(16);
    expect(levels(h)[15]).toBe(9);
    await drain(h);
    expect(levels(h)).toEqual({ 15: 9, 16: 9 });
    await finishTransition(h, 5000);
    expect(levels(h)).toEqual({ 16: 9 });
    expect(h.layer.getStats()).toEqual({ tiles: 9, splats: 90, ...FULL, tileZoom: 16 });
  });

  it('zooming back before the transition finished brings the old level back instead of refetching it', async () => {
    const h = makeLayer({ prefetchBand: 0 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    h.setTime(1000);
    h.view.zoom = 15.5;
    await drain(h); // z15 landed: the z16 tiles are dissolving out
    h.setTime(1000 + 100);
    h.view.zoom = 16.5; // changed our mind
    await drain(h, 2);
    expect(h.layer.getStats().tileZoom).toBe(16);
    expect(fetched(h, 16)).toBe(9); // nothing refetched
    await finishTransition(h, 1000 + 100);
    expect(levels(h)).toEqual({ 16: 9 });
  });

  it('budget (transitionOvershoot: 0): counts both levels, never exceeded, and gives up the OLD level first', async () => {
    const h = makeLayer({ maxSplats: 35, maxInFlight: 1, transitionOvershoot: 0 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 20);
    expect(levels(h)).toEqual({ 16: 3 });

    h.setTime(1000);
    h.view.zoom = 15.5;
    let sawBoth = false;
    let new15 = 0;
    for (let i = 0; i < 30; i++) {
      h.layer.update();
      await settle();
      expect(h.layer.getStats().splats).toBeLessThanOrEqual(35);
      const l = levels(h);
      if (l[15] && l[16]) sawBoth = true;
      // Each z15 landing pushed ONE old tile out; the new level itself never
      // gave way while an old tile was still there to go.
      expect((l[15] ?? 0) + (l[16] ?? 0)).toBeLessThanOrEqual(3);
      expect(l[15] ?? 0).toBeGreaterThanOrEqual(new15);
      new15 = l[15] ?? 0;
    }
    expect(sawBoth).toBe(true);
    // The old level is gone without waiting for any animation (with no
    // allowance, budget evictions are immediate); the budget is full of the
    // new level.
    expect(levels(h)).toEqual({ 15: 3 });
    expect(h.layer.getStats()).toMatchObject({ tiles: 3, splats: 30, tileZoom: 15 });
    expect(h.hidden).toEqual([true]);
  });

  it('budget: a tier downgrade mid-transition drops the old level before any new-level tile', async () => {
    const h = makeLayer({ lowTierMaxSplats: 90, lowTierLodBias: 0 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    h.setTime(1000);
    h.view.zoom = 15.5;
    await drain(h);
    expect(levels(h)).toEqual({ 16: 9, 15: 9 }); // 180 splats, mid-transition
    h.layer.setQualityTier('low'); // budget 90
    expect(levels(h)).toEqual({ 15: 9 });
  });

  it('the rounded union is computed per level: a tile only joins neighbours of its own level', async () => {
    const h = makeLayer({ roundedUnion: { growMs: 0 }, radius: 0 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    const u = (name: string): { g: number; edge: number[] } => {
      const ground = h.scene.getObjectByName(`splat-tile-ground:${name}`) as THREE.Mesh;
      const un = (ground.material as THREE.ShaderMaterial).uniforms;
      return { g: un.uUnionG.value as number, edge: (un.uUnionEdge.value as THREE.Vector4).toArray() };
    };
    expect(u('16/11614/23927')).toEqual({ g: 1, edge: [0, 0, 0, 0] });

    // Widen the window at z15: the z15 tiles join EACH OTHER …
    h.layer.applyOptions(
      resolveSplatsOptions({ cover: false, 
        urlTemplate: 'x', radius: 1, maxInFlight: 100, lodBias: 0, hideBasemap: true, roundedUnion: { growMs: 0 }
      })
    );
    h.view.zoom = 15.5;
    h.layer.setCameraMoving(true); // one landing per update (at rest the batch would land at once)
    h.layer.update(); // switch + start the z15 fetches
    await settle();
    h.layer.update(); // first z15 tile (the centre) admitted
    // … while the lone z16 tile, which sits INSIDE z15 5807/11963, is a
    // neighbour of nothing: same coordinates space, different level.
    expect(u('15/5807/11963').edge).toEqual([0, 0, 0, 0]);
    h.layer.update();
    h.layer.update();
    const centre = u('15/5807/11963');
    expect(centre.edge.filter((w) => w === 1).length).toBe(2); // two z15 edge neighbours landed
    h.layer.setCameraMoving(false);
    await drain(h);
    expect(u('15/5807/11963').edge).toEqual([1, 1, 1, 1]);
    // The covered z16 tile dissolved out under its parent, never joined.
    h.setTime(FADE);
    await drain(h, 2);
    expect(levels(h)).toEqual({ 15: 9 });
  });

  it('a level that is missing here falls back to the next finer one (partial pyramids keep showing)', async () => {
    const h = makeLayer();
    h.fetchTile.mockImplementation(async (url) => (url.includes('/16/') ? new ArrayBuffer(10) : null));
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    h.view.zoom = 14.5; // wants z14 → all 404 → z15 → all 404 → z16
    await drain(h, 30);
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, tileZoom: 16 });
    expect(levels(h)).toEqual({ 16: 9 });
    expect(fetched(h, 14)).toBe(9);
    expect(fetched(h, 15)).toBe(9);
    expect(fetched(h, 16)).toBe(9); // the resident z16 tiles were never dropped
    await drain(h, 5);
    expect(h.fetchTile).toHaveBeenCalledTimes(27); // 404s remembered — no probing loop
  });

  it("'low' / 'mobile' tiers run one level coarser (lowTierLodBias −1); lodBias does the same on 'high'", async () => {
    const low = makeLayer();
    low.view.zoom = 16.5;
    low.layer.setQualityTier('low');
    await low.layer.open();
    await drain(low);
    expect(low.layer.getStats().tileZoom).toBe(15);

    const biased = makeLayer({ lodBias: -1 });
    biased.view.zoom = 16.5;
    await biased.layer.open();
    await drain(biased);
    expect(biased.layer.getStats().tileZoom).toBe(15);
  });

  it('level bounds apply live: the active level is re-evaluated, nothing is rebuilt', async () => {
    const h = makeLayer();
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    h.setTime(1000);
    h.layer.applyOptions(resolveSplatsOptions({ cover: false,  urlTemplate: 'x', radius: 1, maxTileZoom: 15 }));
    h.layer.update();
    expect(h.layer.getStats().tileZoom).toBe(15);
    expect(levels(h)).toEqual({ 16: 9 }); // retained, not dropped: a transition, not a rebuild
    await drain(h);
    await finishTransition(h, 1000);
    expect(levels(h)).toEqual({ 15: 9 });

    // The deprecated alias pins the level whatever the camera does.
    const pinned = makeLayer({ zoomLevel: 16, minZoom: 10 });
    pinned.view.zoom = 12;
    await pinned.layer.open();
    await drain(pinned);
    expect(pinned.layer.getStats()).toMatchObject({ tiles: 9, tileZoom: 16 });
  });

  it('dropping below minZoom forgets the level; coming back selects afresh', async () => {
    const h = makeLayer({ minZoom: 13 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h);
    h.view.zoom = 12.9;
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(0);
    h.view.zoom = 13.2;
    await drain(h);
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, tileZoom: 13 });
  });
});

// ---------------------------------------------------------------------------
// hideBasemap: 'covered' — the cut-out sink, and the frame-time governor
// ---------------------------------------------------------------------------

interface SinkLog {
  sink: import('../src/splats/SplatsLayer.js').SplatCutoutSink;
  reserved: Array<[boolean, number | undefined]>;
  modes: number[];
  pushes: Array<Array<{ key: string; g: number; values: number[] | null }>>;
  ripples: Array<[boolean, number, number, number, number]>;
}

function makeSink(): SinkLog {
  const log: SinkLog = {
    reserved: [], modes: [], pushes: [], ripples: [],
    sink: {
      setCutoutReserved: (on, finest) => { log.reserved.push([on, finest]); },
      setCutoutMode: (m) => { if (log.modes[log.modes.length - 1] !== m) log.modes.push(m); },
      setCutout: (tiles) => {
        log.pushes.push(tiles.map((t) => ({
          key: `${t.z}/${t.x}/${t.y}`, g: t.g, values: t.values ? Array.from(t.values) : null
        })));
      },
      setCutoutRipple: (active, x = 0, z = 0, r = 0, w = 0) => { log.ripples.push([active, x, z, r, w]); }
    }
  };
  return log;
}

describe("SplatsLayer hideBasemap: 'covered'", () => {
  it('is the default, reserves the cut-out for the finest level, and hides NOTHING globally', async () => {
    expect(resolveSplatsOptions({ urlTemplate: 'x' }).hideBasemap).toBe('covered');
    const log = makeSink();
    const h = makeLayer({ hideBasemap: undefined, radius: 0 }, { cutout: log.sink });
    expect(log.reserved).toEqual([[true, 16]]);
    await h.layer.open();
    await drain(h);
    expect(h.layer.getStats()).toMatchObject({ tiles: 1, basemapHidden: false, basemapCovered: true });
    expect(h.layer.isCovering()).toBe(true);
    expect(h.hidden).toEqual([]); // the layers were never hidden (nor suspended)
    expect(log.modes).toEqual([1]); // cut the basemap, keep the labels
  });

  it("pushes each tile with the mask values its GPU mask is using, as it grows and joins", async () => {
    const log = makeSink();
    const h = makeLayer({ hideBasemap: 'covered', radius: 1, maxSplats: 25 }, { cutout: log.sink });
    await h.layer.open();
    h.layer.update();
    await settle();
    h.layer.setCameraMoving(true); // one landing per update: the centre tile alone first
    h.layer.update(); // the centre tile is admitted: growth 0
    const first = log.pushes[log.pushes.length - 1];
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ key: '16/11614/23927', g: 0 });
    h.setTime(350);
    h.layer.update();
    const mid = log.pushes[log.pushes.length - 1][0];
    expect(mid.g).toBeGreaterThan(0.5);
    expect(mid.g).toBeLessThan(1);
    // What the sink got IS what the imagery ground's uniforms hold.
    const ground = h.scene.getObjectByName('splat-tile-ground:16/11614/23927') as THREE.Mesh;
    const un = (ground.material as THREE.ShaderMaterial).uniforms;
    expect(mid.g).toBe(un.uUnionG.value);
    await drain(h, 6);
    h.setTime(10_000);
    h.layer.update();
    const last = log.pushes[log.pushes.length - 1];
    expect(last).toHaveLength(2); // the 25-splat budget holds two tiles
    const centre = last.find((t) => t.key === '16/11614/23927')!;
    expect(centre.g).toBe(1);
    expect(centre.values!.slice(0, 4)).toEqual((un.uUnionEdge.value as THREE.Vector4).toArray());
    expect(centre.values!.slice(0, 4).filter((w) => w === 1)).toHaveLength(1); // joined to its one neighbour
    // Settled: nothing more is pushed.
    const n = log.pushes.length;
    h.layer.update();
    h.layer.update();
    expect(log.pushes.length).toBe(n);
  });

  it('keepLabels: false cuts the labels too; switching modes live swaps cut-out for global hide', async () => {
    const log = makeSink();
    const h = makeLayer({ hideBasemap: 'covered', keepLabels: false, radius: 0 }, { cutout: log.sink });
    await h.layer.open();
    await drain(h);
    expect(log.modes).toEqual([2]);
    const base = { urlTemplate: 'x', radius: 0, maxInFlight: 100, lodBias: 0 } as const;
    h.layer.applyOptions(resolveSplatsOptions({ cover: false,  ...base, hideBasemap: 'covered' }));
    expect(log.modes).toEqual([2, 1]);
    h.layer.applyOptions(resolveSplatsOptions({ cover: false,  ...base, hideBasemap: true }));
    expect(log.modes).toEqual([2, 1, 0]);
    expect(log.pushes[log.pushes.length - 1]).toEqual([]);
    expect(h.hidden).toEqual([true]);
    expect(h.layer.getStats()).toMatchObject({ basemapHidden: true, basemapCovered: false });
    expect(log.reserved[log.reserved.length - 1][0]).toBe(false);
    h.layer.applyOptions(resolveSplatsOptions({ cover: false,  ...base, hideBasemap: false }));
    expect(h.hidden).toEqual([true, false]);
    expect(h.layer.getStats()).toMatchObject({ basemapHidden: false, basemapCovered: false });
  });

  it('gives the basemap back the moment the overlay goes off, and follows the ripple front', async () => {
    const log = makeSink();
    const h = makeLayer({ hideBasemap: 'covered', radius: 0 }, { cutout: log.sink });
    await h.layer.open();
    await drain(h);
    h.layer.setEnabled(false);
    expect(log.modes).toEqual([1, 0]);
    expect(log.pushes[log.pushes.length - 1]).toEqual([]);
    expect(h.layer.isCovering()).toBe(false);

    h.layer.setEnabled(true, { reveal: 'ripple' });
    const start = log.ripples[log.ripples.length - 1];
    expect(start[0]).toBe(true);
    expect(start[3]).toBe(0); // front radius 0: nothing is cut yet
    await drain(h);
    h.setTime(h.layer.getStats().reveal === 'in' ? 600 : 0);
    h.layer.update();
    const mid = log.ripples[log.ripples.length - 1];
    expect(mid[0]).toBe(true);
    expect(mid[3]).toBeGreaterThan(0);
    expect(mid[4]).toBe(DEFAULT_RIPPLE_PARAMS.ringWidthM);
    h.setTime(60_000);
    h.layer.update();
    expect(log.ripples[log.ripples.length - 1][0]).toBe(false); // fully revealed
    h.layer.dispose();
    expect(log.modes[log.modes.length - 1]).toBe(0);
    expect(log.reserved[log.reserved.length - 1][0]).toBe(false);
  });

  it('rounded union off: tiles are pushed as plain squares', async () => {
    const log = makeSink();
    const h = makeLayer({ hideBasemap: 'covered', roundedUnion: false, radius: 0 }, { cutout: log.sink });
    await h.layer.open();
    await drain(h);
    expect(log.pushes[log.pushes.length - 1]).toEqual([{ key: '16/11614/23927', g: 1, values: null }]);
  });
});

describe('SplatsLayer frame-time governor', () => {
  /** Report `n` moving frames of `dt` ms (advancing the layer clock). */
  const frames = (h: Harness, clock: { now: number }, dt: number, n: number): void => {
    for (let k = 0; k < n; k++) {
      clock.now += dt;
      h.setTime(clock.now);
      h.layer.reportFrame(dt, true);
      h.layer.update();
    }
  };

  it('over target while moving: the budget shrinks, the least relevant tiles shrink out, none are admitted', async () => {
    const h = makeLayer({ maxSplats: 90 }); // 9 tiles × 10 splats
    await h.layer.open();
    await drain(h, 24); // 9 tiles + 9 imagery textures, one landing per frame
    const clock = { now: 100_000 };
    h.setTime(clock.now);
    h.layer.update();
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, maxSplats: 90 });
    const fetches = h.fetchTile.mock.calls.length;

    // Walk past the distance ladder first (the governor's gentler opening move) and stop at the
    // FIRST budget step, which is what this test is about.
    let guard = 0;
    while (h.layer.getStats().governor.scale === 1 && guard++ < 400) frames(h, clock, 66, 1);
    const s1 = h.layer.getStats();
    expect(s1.governor.splatMaxDistance).toBeGreaterThan(0); // ladder was used first
    expect(s1.governor.scale).toBeCloseTo(0.6, 6);
    expect(s1.maxSplats).toBe(54);
    // Graceful: the four that have to go are shrinking out, still resident…
    expect(s1.tiles).toBe(9);
    frames(h, clock, 20, Math.ceil(UNION_LEAVE_MS / 20) + 1); // (20 ms frames: in the dead band)
    // …and gone 300 ms later: five tiles ≤ 54 splats, the centre among them.
    expect(h.layer.getStats()).toMatchObject({ tiles: 5, splats: 50 });
    expect(h.meshes().map((m) => m.name)).toContain('splat-tile:16/11614/23927');
    // Nothing is re-requested while the budget is held.
    await drain(h, 6);
    expect(h.fetchTile.mock.calls.length).toBe(fetches);

    frames(h, clock, 90, 120);
    const s2 = h.layer.getStats();
    expect(s2.governor).toMatchObject({ scale: 0.25, biasDrop: 1 });
    expect(s2.maxSplats).toBe(23);
  });

  it('on the floor the lodBias in effect drops: a coarser level takes over', async () => {
    const h = makeLayer({ maxSplats: 90, lodBias: 1.5, minZoom: 10 });
    h.view.zoom = 14.6; // floor(14.6 + 1.5) = 16
    await h.layer.open();
    await drain(h, 24);
    expect(h.layer.getStats().tileZoom).toBe(16);
    const clock = { now: 100_000 };
    frames(h, clock, 90, 160);
    expect(h.layer.getStats().governor.biasDrop).toBe(1);
    await drain(h, 30);
    expect(h.layer.getStats().tileZoom).toBe(15); // floor(14.6 + 0.5)
  });

  it('ignores idle frames, frames around a tile landing, and everything when switched off', async () => {
    const h = makeLayer({ maxSplats: 90 });
    await h.layer.open();
    h.layer.update();
    await settle();
    h.layer.setCameraMoving(true); // one landing per update, so each reported frame sits next to one
    // Tiles are landing one per update(): those frames carry upload hitches.
    for (let k = 0; k < 9; k++) { h.layer.update(); h.layer.reportFrame(200, true); }
    expect(h.layer.getStats().governor.frameMs).toBe(0);
    h.layer.setCameraMoving(false);
    await drain(h, 24);
    h.setTime(50_000);
    h.layer.update();
    h.layer.update();
    for (let k = 0; k < 40; k++) h.layer.reportFrame(200, false); // nothing moving
    expect(h.layer.getStats().governor).toMatchObject({ frameMs: 0, scale: 1 });

    const off = makeLayer({ maxSplats: 90, governor: false });
    await off.layer.open();
    await drain(off, 24);
    off.setTime(50_000);
    off.layer.update();
    off.layer.update();
    for (let k = 0; k < 60; k++) off.layer.reportFrame(200, true);
    expect(off.layer.getStats()).toMatchObject({ tiles: 9, maxSplats: 90, governor: { enabled: false, scale: 1 } });
  });

  it('a quality-tier change starts the governor over', async () => {
    const h = makeLayer({ maxSplats: 90, lowTierMaxSplats: 30 });
    await h.layer.open();
    await drain(h, 24);
    const clock = { now: 100_000 };
    // motion thinning (on by default) is the first rung, then the distance ladder, then the budget
    frames(h, clock, 66, 14 * (MOTION_THIN_LADDER.length + GOVERNOR_DEFAULTS.distanceLadder.length + 1));
    expect(h.layer.getStats().governor.scale).toBeLessThan(1);
    expect(h.layer.getStats().governor.thinKeep).toBe(MOTION_THIN_LADDER[MOTION_THIN_LADDER.length - 1]);
    h.layer.setQualityTier('low');
    expect(h.layer.getStats()).toMatchObject({
      maxSplats: 30, governor: { scale: 1, biasDrop: 0, frameMs: 0, splatMaxDistance: 0, thinKeep: 1 }
    });
  });

  it('motion thinning: the governor thins while moving, every splat is back at rest', async () => {
    const h = makeLayer({ maxSplats: 90 });
    await h.layer.open();
    await drain(h, 24);
    const keep = (): number => (h.layer as unknown as { thinDyno: { value: number } }).thinDyno.value;
    const meshes = h.scene.getObjectsByProperty('name', 'hbd-splats')[0].children
      .flatMap((r) => r.children.filter((c) => c.name.startsWith('splat-tile:'))) as unknown as FakeSplatMesh[];
    expect(meshes.length).toBeGreaterThan(0);
    const clock = { now: 100_000 };
    h.layer.setCameraMoving(true);
    frames(h, clock, 66, 14);
    const thin = h.layer.getStats().governor.thinKeep;
    expect(thin).toBe(MOTION_THIN_LADDER[0]);
    expect(h.layer.getStats().governor.scale).toBe(1);   // no tile evicted for it
    // a step mid-gesture EASES into the tiles' modifier (no density pop while moving)…
    expect(keep()).toBeGreaterThan(thin);
    expect(keep()).toBeLessThan(1);
    frames(h, clock, 16, 40);                            // ~0.6 s of quick frames: no new step
    expect(keep()).toBe(thin);                           // …and gets there
    const bumps = meshes.map((m) => m.versionBumps);
    expect(bumps.every((b) => b > 0)).toBe(true);        // regenerating the tiles
    h.layer.setCameraMoving(false);
    h.layer.update();
    expect(keep()).toBe(1);                              // at rest: everything drawn
    expect(meshes.every((m, i) => m.versionBumps > bumps[i])).toBe(true);
    h.layer.setCameraMoving(true);
    h.layer.update();
    expect(keep()).toBe(thin);                           // the next gesture starts thinned
    // motionThin off mid-gesture: the rung is gone at once, the picture eases back to every splat
    h.layer.applyOptions(resolveSplatsOptions({ cover: false, 
      urlTemplate: 'https://tiles.test/{z}/{x}/{y}.spz', maxSplats: 90, motionThin: false
    }));
    expect(h.layer.getStats().governor.thinKeep).toBe(1);
    frames(h, clock, 16, 40);
    expect(keep()).toBe(1);
  });
});

describe('SplatsLayer tile ranking (screen-space relevance)', () => {
  it('a tilted camera spends a small budget ahead of the target, not behind it', async () => {
    const h = makeLayer({ maxSplats: 45, maxInFlight: 1 });
    h.view.tilt = 60;
    h.view.zoom = 16; // one z16 tile ≈ 1.7 camera distances across
    h.view.bearing = 0; // looking north: tile y decreases ahead
    await h.layer.open();
    await drain(h, 30);
    const ys = h.meshes().map((m) => Number(m.name.split('/')[2]));
    expect(ys).toHaveLength(4);
    const centreY = Math.max(...ys); // the row the camera target is in (or the focus row)
    expect(ys.filter((y) => y < centreY).length).toBeGreaterThanOrEqual(2); // most of the budget is AHEAD
    expect(ys.every((y) => y <= 23927)).toBe(true); // nothing behind the target

    // Turn round: the budget follows the view.
    h.view.bearing = 180;
    await drain(h, 40);
    const after = h.meshes().map((m) => Number(m.name.split('/')[2]));
    expect(after.every((y) => y >= 23927)).toBe(true);
  });
});

describe('viewFocus cap (window stays on the camera target)', () => {
  it('returns the target itself when the cap is 0 (default 3×3 window)', async () => {
    const { viewFocus } = await import('../src/splats/lod.js');
    const f = { cx: 0.3, cy: 0.4, dist: 0.001, bearingDeg: 30, tiltDeg: 55 };
    const c = viewFocus(f, 0);
    expect(c.x).toBeCloseTo(0.3, 12);
    expect(c.y).toBeCloseTo(0.4, 12);
  });

  it('never pushes further than the cap, and is unchanged when the cap is loose', async () => {
    const { viewFocus } = await import('../src/splats/lod.js');
    const f = { cx: 0.3, cy: 0.4, dist: 0.001, bearingDeg: 0, tiltDeg: 60 };
    const free = viewFocus(f);
    const capped = viewFocus(f, 0.0001);
    expect(Math.hypot(capped.x - f.cx, capped.y - f.cy)).toBeCloseTo(0.0001, 9);
    expect(Math.hypot(free.x - f.cx, free.y - f.cy)).toBeGreaterThan(0.0001);
    const loose = viewFocus(f, 1);
    expect(loose.x).toBeCloseTo(free.x, 12);
    expect(loose.y).toBeCloseTo(free.y, 12);
  });
});

describe('tile relevance keeps the tile under the camera target first', () => {
  it('ranks the target tile ahead of the tiles in front of it at high tilt', async () => {
    const { rankTilesByRelevance } = await import('../src/splats/lod.js');
    const z = 16, n = 2 ** z, tx = 18057, ty = 25935;
    // target near the NORTH edge of its tile, camera looking north at 55° tilt: by tile centres
    // the row ahead (ty − 1) used to win.
    const f = { cx: (tx + 0.5) / n, cy: (ty + 0.1) / n, dist: 3.0 / n, bearingDeg: 0, tiltDeg: 55 };
    const window: Array<[number, number]> = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) window.push([tx + dx, ty + dy]);
    const ranked = rankTilesByRelevance(z, window, f);
    expect(ranked[0]).toEqual([tx, ty]);
  });
});

// ---------------------------------------------------------------------------
// Level cross-dissolve (levelFade.ts + the layer's transition bookkeeping)
// ---------------------------------------------------------------------------

describe('level cross-dissolve maths', () => {
  it('a fade track is linear in time, smoothstep in value, and reverses from where it got to', () => {
    const t = createFade(0, 1000);
    expect(fadeToward(t, 1, 1000, 400)).toBe(0);
    expect(fadeProgress(t, 1100, 400)).toBeCloseTo(0.25, 12);
    expect(fadeValue(0.25)).toBeCloseTo(0.15625, 12);
    expect(fadeValue(0.5)).toBe(0.5);
    // Reverse at 60 %: no restart from 0 or 1, it turns round at 0.6 …
    expect(fadeToward(t, 0, 1240, 400)).toBeCloseTo(0.6, 12);
    expect(fadeProgress(t, 1240 + 120, 400)).toBeCloseTo(0.3, 12);
    // … and again.
    expect(fadeToward(t, 1, 1360, 400)).toBeCloseTo(0.3, 12);
    expect(fadeToward(t, 1, 1360 + 280, 400)).toBe(1);
    expect(t.dir).toBe(0);
    // Ticking every frame toward the same target arrives EXACTLY (no drift).
    const u = createFade(1, 0);
    for (let ms = 0; ms <= 450; ms += 7) fadeToward(u, 0, ms, 450);
    expect(fadeToward(u, 0, 450, 450)).toBe(0);
    // fadeMs 0 → the target at once.
    const i = createFade(0, 0);
    expect(fadeToward(i, 1, 0, 0)).toBe(1);
    expect(i.dir).toBe(0);
  });

  it('appear kind: dissolve over ground another level shows, grow on new ground', () => {
    const parent = { z: 15, x: 5807, y: 11963 };
    expect(tilesOverlap(parent, { z: 16, x: 11614, y: 23927 })).toBe(true);
    expect(tilesOverlap({ z: 16, x: 11615, y: 23926 }, parent)).toBe(true);
    expect(tilesOverlap(parent, { z: 16, x: 11616, y: 23927 })).toBe(false);
    expect(tilesOverlap({ z: 14, x: 2903, y: 5981 }, { z: 16, x: 11614, y: 23927 })).toBe(true);
    expect(appearKind(parent, [{ z: 16, x: 11614, y: 23927 }])).toBe('dissolve');
    expect(appearKind({ z: 16, x: 11614, y: 23927 }, [parent])).toBe('dissolve');
    // Same-level neighbours, or another level elsewhere, are not cover.
    expect(appearKind(parent, [{ z: 15, x: 5808, y: 11963 }, { z: 16, x: 11620, y: 23927 }])).toBe('grow');
    expect(appearKind(parent, [])).toBe('grow');
    // Quadrants in the GPU frame (v north; tile y grows south): SW, SE, NW, NE.
    expect(childQuadrant(parent, { z: 16, x: 11614, y: 23927 })).toBe(0);
    expect(childQuadrant(parent, { z: 16, x: 11615, y: 23927 })).toBe(1);
    expect(childQuadrant(parent, { z: 16, x: 11614, y: 23926 })).toBe(2);
    expect(childQuadrant(parent, { z: 16, x: 11615, y: 23926 })).toBe(3);
    expect(childQuadrant(parent, { z: 16, x: 11616, y: 23926 })).toBe(-1);
    expect(childQuadrant(parent, { z: 17, x: 23228, y: 47854 })).toBe(-1);
  });

  it('prefetch level: the neighbour whose threshold is within the band, honouring the hysteresis', () => {
    const p = { minTileZoom: 13, maxTileZoom: 16, lodBias: 0 };
    // From z15 the switch to z16 happens at 16.15, to z14 below 14.85.
    expect(prefetchLevel(15.5, 15, p, 0.2)).toBeNull();
    expect(prefetchLevel(15.94, 15, p, 0.2)).toBeNull();
    expect(prefetchLevel(15.96, 15, p, 0.2)).toBe(16);
    expect(prefetchLevel(15.06, 15, p, 0.2)).toBeNull();
    expect(prefetchLevel(15.04, 15, p, 0.2)).toBe(14);
    // Just crossed to z16 at 16.15: the way BACK is 0.3 off — no ping-pong.
    expect(prefetchLevel(16.15, 16, p, 0.2)).toBeNull();
    // Nothing beyond the pyramid, nothing with the band off / no level yet.
    expect(prefetchLevel(17.2, 16, p, 0.2)).toBeNull();
    expect(prefetchLevel(13.0, 13, p, 0.2)).toBeNull();
    expect(prefetchLevel(15.96, 15, p, 0)).toBeNull();
    expect(prefetchLevel(15.96, null, p, 0.2)).toBeNull();
    expect(prefetchLevel(14.46, 15, { ...p, lodBias: 1.5 }, 0.2)).toBe(16);
  });

  it('transition allowance: one tile, capped at overshoot × the configured budget, 0 with fades off', () => {
    expect(transitionAllowance(300_000, 1_200_000, 0.35, 450)).toBe(300_000);
    expect(transitionAllowance(500_000, 1_200_000, 0.35, 450)).toBe(420_000);
    expect(transitionAllowance(300_000, 1_200_000, 0, 450)).toBe(0);
    expect(transitionAllowance(300_000, 1_200_000, 0.35, 0)).toBe(0);
    expect(DEFAULT_LEVEL_FADE_MS).toBe(350);
    expect(DEFAULT_TRANSITION_OVERSHOOT).toBe(0.35);
    expect(DEFAULT_PREFETCH_BAND).toBe(0.2);
  });

  it('options: defaults, clamping, live-apply (no rebuild) and export elision', () => {
    const d = resolveSplatsOptions({ urlTemplate: 'x' });
    expect(d).toMatchObject({ levelFadeMs: 350, transitionOvershoot: 0.35, prefetchBand: 0.2 });
    const o = resolveSplatsOptions({
      urlTemplate: 'x', levelFadeMs: 99_999, transitionOvershoot: 7, prefetchBand: 3
    });
    expect(o).toMatchObject({ levelFadeMs: 5000, transitionOvershoot: 1, prefetchBand: 0.5 });
    expect(resolveSplatsOptions({ urlTemplate: 'x', levelFadeMs: -1, prefetchBand: NaN })).toMatchObject({
      levelFadeMs: 350, prefetchBand: 0.2
    });
    const off = resolveSplatsOptions({ urlTemplate: 'x', levelFadeMs: 0, transitionOvershoot: 0, prefetchBand: 0 });
    expect(planSplatsUpdate(d, off, true)).toEqual({
      kind: 'live', changed: ['levelFadeMs', 'transitionOvershoot', 'prefetchBand']
    });
    expect(exportSplatsOptions(d)).toEqual({ urlTemplate: 'x' });
    expect(exportSplatsOptions(off)).toEqual({
      urlTemplate: 'x', levelFadeMs: 0, transitionOvershoot: 0, prefetchBand: 0
    });
    // An import that leaves them out resets them.
    const patch = splatsReplacePatch({ urlTemplate: 'x' });
    expect('levelFadeMs' in patch && 'transitionOvershoot' in patch && 'prefetchBand' in patch).toBe(true);
  });
});

describe('SplatsLayer level cross-dissolve', () => {
  // These timelines were hand-computed for a 450 ms dissolve; the layer here is pinned to it
  // (the default is DURATION.base, 350 ms).
  const FADE = 450;
  const Z16 = '16/11614/23927'; // ORIGIN's tile …
  const Z15 = '15/5807/11963'; // … and its parent (Z16 is the parent's SW quadrant)
  const levels = (h: Harness): Record<number, number> => {
    const out: Record<number, number> = {};
    for (const m of h.meshes()) {
      const z = Number(m.name.replace('splat-tile:', '').split('/')[0]);
      out[z] = (out[z] ?? 0) + 1;
    }
    return out;
  };
  const fetched = (h: Harness, z: number): number =>
    h.fetchTile.mock.calls.filter(([u]) => u.includes(`/${z}/`)).length;
  const tileState = (h: Harness, key: string) => h.layer.getTransitionState().tiles.find((t) => t.key === key);
  const groundU = (h: Harness, key: string): Record<string, { value: unknown }> => {
    const ground = h.scene.getObjectByName(`splat-tile-ground:${key}`) as THREE.Mesh;
    return (ground.material as THREE.ShaderMaterial).uniforms as Record<string, { value: unknown }>;
  };
  /** One tile per level (radius 0), everything else default. */
  const single = (config: Partial<import('../src/splats/types.js').SplatsConfig> = {}): Harness =>
    makeLayer({ levelFadeMs: FADE, radius: 0, prefetchBand: 0, ...config });

  it('appear kind: first load and panning GROW; a level change over resident ground DISSOLVES at full shape', async () => {
    const h = makeLayer({ levelFadeMs: FADE, prefetchBand: 0 });
    h.view.zoom = 16.5;
    await h.layer.open();
    h.setTime(1000);
    h.layer.update();
    await settle();
    h.layer.update(); // the centre tile is admitted
    expect(tileState(h, Z16)).toMatchObject({ appear: 'grow', fade: 1, groundFade: 1 });
    expect(groundU(h, Z16).uUnionG.value).toBe(0); // grows from its centre
    await drain(h);
    h.setTime(3000);
    await drain(h, 2);
    expect(h.layer.getTransitionState().tiles.every((t) => t.appear === 'grow')).toBe(true);

    // Pan one tile east: the new column is NEW GROUND → grows.
    h.view.lon += 360 / 2 ** 16;
    h.setTime(4000);
    await drain(h);
    expect(tileState(h, '16/11616/23927')).toMatchObject({ appear: 'grow', fade: 1 });
    expect(h.layer.getTransitionState().fading).toBe(false);

    // Zoom out: the z15 tiles land over resident z16 ground → dissolve, with
    // the union shape complete from the first frame (g = 1, not growing).
    h.setTime(8000);
    h.view.zoom = 15.5;
    h.layer.update();
    await settle();
    h.layer.update();
    const centre15 = '15/5807/11963';
    expect(tileState(h, centre15)).toMatchObject({ appear: 'dissolve', fade: 0 });
    expect(groundU(h, centre15).uUnionG.value).toBe(1);
    const mesh = h.meshes().find((m) => m.name === `splat-tile:${centre15}`);
    expect(mesh?.objectModifier).toBeDefined();
    expect(h.layer.getTransitionState().fading).toBe(true);
    // A z15 tile with NO z16 tile under it is new ground even mid-transition.
    await drain(h);
    expect(tileState(h, '15/5805/11963')).toBeUndefined(); // (outside the 3×3)
    expect(tileState(h, '15/5808/11964')?.appear).toBe('dissolve'); // z16 11616 column is under it
    expect(tileState(h, '15/5806/11962')?.appear).toBe('grow');
  });

  it('zoom OUT timeline: in ramps 0→1 while out ramps 1→0 over levelFadeMs; the ground underneath is never see-through', async () => {
    const h = single();
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 4);
    expect(levels(h)).toEqual({ 16: 1 });

    h.setTime(10_000);
    h.view.zoom = 15.5;
    await drain(h, 4); // z15 lands at t = 10 000 (imagery with it)
    expect(levels(h)).toEqual({ 16: 1, 15: 1 });
    expect(tileState(h, Z15)).toMatchObject({ appear: 'dissolve', fade: 0 });
    expect(tileState(h, Z16)).toMatchObject({ fade: 1, groundFade: 1 });

    for (const [dt, v] of [[112.5, 0.15625], [225, 0.5], [337.5, 0.84375]] as Array<[number, number]>) {
      h.setTime(10_000 + dt);
      h.layer.update();
      const a = tileState(h, Z15)!;
      const b = tileState(h, Z16)!;
      expect(a.fade).toBeCloseTo(v, 9);
      expect(b.fade).toBeCloseTo(1 - v, 9); // complementary: never both at full opacity
      expect(a.groundFade).toBeCloseTo(v, 9);
      expect(b.groundFade).toBe(1); // the outgoing ground HOLDS while the incoming one is translucent
      expect(groundU(h, Z15).uLevelFade.value).toBeCloseTo(v, 9);
    }
    // Spark re-runs the modifiers only while the fades move.
    const z16mesh = h.meshes().find((m) => m.name === `splat-tile:${Z16}`)!;
    const bumps = z16mesh.versionBumps;
    h.layer.update();
    expect(z16mesh.versionBumps).toBe(bumps);

    // Fade complete: the z16 SPLATS are released at once; its ground lingers
    // as a ghost, fades over the (now opaque) z15 ground, then goes.
    h.setTime(10_000 + FADE);
    h.layer.update();
    expect(levels(h)).toEqual({ 15: 1 });
    expect(z16mesh.disposed).toBe(true);
    expect(h.layer.getStats()).toMatchObject({ tiles: 1, splats: 10 });
    expect(h.layer.getTransitionState()).toMatchObject({ ghosts: [Z16] });
    expect(groundU(h, Z16).uLevelFade.value).toBe(1);
    h.setTime(10_000 + FADE + 225);
    h.layer.update();
    expect(groundU(h, Z16).uLevelFade.value).toBeCloseTo(0.5, 9);
    expect(h.layer.getTransitionState().fading).toBe(true);
    h.setTime(10_000 + 2 * FADE);
    h.layer.update();
    expect(h.layer.getTransitionState()).toMatchObject({ ghosts: [], fading: false });
    expect(h.scene.getObjectByName(`splat-tile-ground:${Z16}`)).toBeUndefined();
    expect(h.hidden).toEqual([true]);
    // Settled: no more frames are requested.
    const changes = h.sceneChanges();
    h.setTime(20_000);
    await drain(h, 3);
    expect(h.sceneChanges()).toBe(changes);
  });

  it('zoom IN timeline: the parent fades per QUADRANT under each child, then as a whole once its children have landed', async () => {
    const h = makeLayer({ levelFadeMs: FADE, prefetchBand: 0, maxInFlight: 1 });
    h.view.zoom = 15.5;
    await h.layer.open();
    await drain(h, 24);
    expect(levels(h)).toEqual({ 15: 9 });
    const parentMesh = h.meshes().find((m) => m.name === `splat-tile:${Z15}`)!;
    expect(parentMesh.objectModifier).toBeDefined();
    const quadOf = (_m: FakeSplatMesh): number[] => tileState(h, Z15)!.quad;

    h.setTime(5000);
    h.view.zoom = 16.5;
    h.layer.update(); // switch + first z16 fetch (maxInFlight 1: one at a time)
    await settle();
    h.layer.update(); // Z16 (the centre) admitted at t = 5000
    expect(tileState(h, Z16)).toMatchObject({ appear: 'dissolve', fade: 0 });
    // The parent is NOT covered yet (eight more children to come): it stays
    // whole — except where the child is dissolving in (SW quadrant).
    h.setTime(5000 + 225);
    h.layer.update();
    expect(tileState(h, Z15)!.fade).toBe(1);
    expect(tileState(h, Z16)!.fade).toBeCloseTo(0.5, 9);
    expect(quadOf(parentMesh)[0]).toBeCloseTo(0.5, 9);
    expect(quadOf(parentMesh).slice(1)).toEqual([0, 0, 0]);

    // All nine children land → every z15 tile is covered → whole-tile fade,
    // splats released, grounds linger until the z16 grounds are opaque, gone.
    await drain(h, 24);
    expect(levels(h)).toEqual({ 15: 9, 16: 9 });
    h.setTime(5000 + 225 + FADE);
    await drain(h, 2);
    expect(levels(h)).toEqual({ 16: 9 });
    expect(h.layer.getTransitionState().ghosts.length).toBe(9);
    h.setTime(5000 + 225 + 2 * FADE);
    await drain(h, 2);
    expect(h.layer.getTransitionState()).toMatchObject({ ghosts: [], fading: false });
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, splats: 90, tileZoom: 16 });
    expect(h.hidden).toEqual([true]);
  });

  it('reversal mid-fade: both fades turn round where they are — no restart, no refetch, never both at full', async () => {
    const h = single();
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 4);
    h.setTime(1000);
    h.view.zoom = 15.5;
    await drain(h, 4); // z15 landed at t = 1000
    h.setTime(1000 + 180); // 40 % through
    h.layer.update();
    const in40 = tileState(h, Z15)!.fade;
    expect(in40).toBeCloseTo(fadeValue(0.4), 9);
    expect(tileState(h, Z16)!.fade).toBeCloseTo(fadeValue(0.6), 9);

    h.view.zoom = 16.5; // changed our mind
    h.layer.update();
    expect(h.layer.getStats().tileZoom).toBe(16);
    // Same instant, same values: nothing jumped.
    expect(tileState(h, Z15)!.fade).toBeCloseTo(in40, 9);
    expect(tileState(h, Z16)!.fade).toBeCloseTo(fadeValue(0.6), 9);
    let last16 = tileState(h, Z16)!.fade;
    for (let t = 1180; t <= 1180 + FADE; t += 30) {
      h.setTime(t);
      h.layer.update();
      const a = tileState(h, Z16);
      const b = tileState(h, Z15);
      if (a && b) expect(Math.min(a.fade, b.fade)).toBeLessThan(1);
      expect(a!.fade).toBeGreaterThanOrEqual(last16); // z16 only ever comes BACK
      last16 = a!.fade;
    }
    // z16 needed 40 % of the window to return, z15 40 % to leave.
    h.setTime(1180 + 0.4 * FADE + 1);
    h.layer.update();
    expect(tileState(h, Z16)!.fade).toBe(1);
    expect(levels(h)).toEqual({ 16: 1 });
    expect(fetched(h, 16)).toBe(1); // never refetched
    expect(fetched(h, 15)).toBe(1);

    // Rapid back-and-forth across the boundary: still one fetch per level
    // while the tiles are resident, and never two full levels.
    const r = single();
    r.view.zoom = 16.5;
    await r.layer.open();
    await drain(r, 4);
    let now = 1000;
    for (let k = 0; k < 12; k++) {
      r.view.zoom = k % 2 === 0 ? 15.5 : 16.5;
      for (let f = 0; f < 5; f++) {
        now += 20;
        r.setTime(now);
        r.layer.update();
        await settle();
        const st = r.layer.getTransitionState().tiles;
        if (st.length === 2) expect(Math.min(st[0].fade, st[1].fade)).toBeLessThan(1);
      }
    }
    // z16 only ever dipped to ~0.9 and came back: never released, never
    // refetched. z15 got a few % in, turned round and dissolved OUT completely
    // each time — so it is fetched again, but only once per crossing to it.
    expect(fetched(r, 16)).toBe(1);
    expect(fetched(r, 15)).toBeLessThanOrEqual(6);
  });

  it('budget allowance: a one-tile budget still cross-dissolves; the old splats go when the fade completes, within levelFadeMs + 250', async () => {
    // Exactly one 10-splat tile. (The allowance cap is a fraction of the
    // CONFIGURED budget — 0.35 × 1.2 M in production, where the governor holds
    // the budget in effect near one tile; here the two are the same number,
    // so lift the cap to one tile.)
    const h = single({ maxSplats: 10, transitionOvershoot: 1 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 4);
    expect(h.layer.getStats()).toMatchObject({ tiles: 1, splats: 10, maxSplats: 10 });

    h.setTime(1000);
    h.view.zoom = 15.5;
    let overFrom = -1;
    let overTo = -1;
    for (let t = 1000; t <= 2500; t += 25) {
      h.setTime(t);
      h.layer.update();
      await settle();
      const s = h.layer.getStats();
      // Never more than budget + one tile (the allowance).
      expect(s.splats).toBeLessThanOrEqual(10 + 10);
      if (s.splats > 10) {
        if (overFrom < 0) overFrom = t;
        overTo = t;
      }
    }
    expect(overFrom).toBeGreaterThanOrEqual(1000);
    expect(overTo - overFrom).toBeLessThanOrEqual(FADE + 250);
    expect(overTo - overFrom).toBeGreaterThanOrEqual(FADE - 50); // it really did fade, not swap
    expect(levels(h)).toEqual({ 15: 1 });
    expect(h.layer.getStats()).toMatchObject({ tiles: 1, splats: 10 });

    // Pressure starts the fade-out at once even though the parent is NOT
    // covered yet (zoom in, 3×3 window, budget for one tile).
    const p = makeLayer({ levelFadeMs: FADE, maxSplats: 10, transitionOvershoot: 1, prefetchBand: 0, maxInFlight: 1 });
    p.view.zoom = 15.5;
    await p.layer.open();
    await drain(p, 6);
    expect(levels(p)).toEqual({ 15: 1 });
    p.setTime(1000);
    p.view.zoom = 16.5;
    await drain(p, 4);
    expect(levels(p)).toEqual({ 15: 1, 16: 1 });
    p.setTime(1000 + 225);
    p.layer.update();
    expect(tileState(p, Z15)!.fade).toBeCloseTo(0.5, 9);
    p.setTime(1000 + FADE);
    await drain(p, 2);
    expect(levels(p)).toEqual({ 16: 1 });

    // Real pressure — more than the allowance — still evicts at once.
    const big = single({ maxSplats: 10, transitionOvershoot: 0.5 }); // cap: 5 splats < one tile
    big.view.zoom = 16.5;
    await big.layer.open();
    await drain(big, 4);
    big.setTime(1000);
    big.view.zoom = 15.5;
    for (let k = 0; k < 6; k++) {
      big.layer.update();
      await settle();
      expect(big.layer.getStats().splats).toBeLessThanOrEqual(10);
    }
    expect(levels(big)).toEqual({ 15: 1 });
  });

  it('the over-budget overlap is time-limited: flapping across the boundary cannot hold two levels past levelFadeMs + 250', async () => {
    const h = single({ maxSplats: 10, transitionOvershoot: 1 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 4);
    // 200 ms toward z15, 100 ms back, … — neither dissolve ever completes
    // by itself within 700 ms, so both tiles would stay resident.
    let now = 1000;
    let overSince = -1;
    let longest = 0;
    for (let k = 0; k < 40; k++) {
      h.view.zoom = k % 3 === 2 ? 16.5 : 15.5;
      for (let f = 0; f < 5; f++) {
        now += 20;
        h.setTime(now);
        h.layer.update();
        await settle();
        const s = h.layer.getStats().splats;
        expect(s).toBeLessThanOrEqual(20);
        if (s > 10) {
          if (overSince < 0) overSince = now;
          longest = Math.max(longest, now - overSince);
        } else overSince = -1;
      }
    }
    expect(longest).toBeGreaterThan(0);
    expect(longest).toBeLessThanOrEqual(FADE + 250 + 20);
  });

  it('one allowance for the whole overlap: a tile that would exceed it waits off-scene for the old level to release', async () => {
    const h = makeLayer({ levelFadeMs: FADE, maxSplats: 95, prefetchBand: 0 }); // 3×3 = 90 splats
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 24);
    h.view.zoom = 15.5;
    let sawBoth = false;
    for (let t = 1000; t < 4000; t += 50) {
      h.setTime(t);
      h.layer.update();
      await settle();
      const s = h.layer.getStats();
      expect(s.splats).toBeLessThanOrEqual(95 + 10); // never more than ONE tile over
      const l = levels(h);
      if (l[15] && l[16]) sawBoth = true;
    }
    expect(sawBoth).toBe(true);
    expect(levels(h)).toEqual({ 15: 9 });
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, splats: 90 });
    expect(fetched(h, 15)).toBe(9); // parked tiles are not re-requested
  });

  it('the governor ignores frames drawn during a dissolve (like landing frames)', async () => {
    const h = single({ maxSplats: 10, transitionOvershoot: 1 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 4);
    h.setTime(1000);
    h.view.zoom = 15.5;
    await drain(h, 4);
    expect(h.layer.getTransitionState().fading).toBe(true);
    // Two tiles are being drawn: slow frames, reported as MOVING frames.
    for (let t = 1020; t < 1000 + FADE; t += 20) {
      h.setTime(t);
      h.layer.update();
      h.layer.reportFrame(200, true);
    }
    expect(h.layer.getStats().governor).toMatchObject({ frameMs: 0, scale: 1, biasDrop: 0 });
    // Once the dissolve is over (ghost ground included) frames count again.
    h.setTime(1000 + 2 * FADE);
    h.layer.update();
    h.layer.update();
    expect(h.layer.getTransitionState().fading).toBe(false);
    h.layer.reportFrame(200, true);
    expect(h.layer.getStats().governor.frameMs).toBeGreaterThan(0);
  });

  it('prefetch lifecycle: fetched in the band (never attached), dropped on leaving, promoted on crossing', async () => {
    const h = makeLayer({ levelFadeMs: FADE, maxSplats: 95 }); // the 3×3 (90) + nothing more
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 24);
    expect(fetched(h, 15)).toBe(0);
    expect(h.layer.getTransitionState()).toMatchObject({ prefetchZ: null, prefetched: [] });
    const textures = h.loadTexture.mock.calls.length;

    // Into the band (the switch to z15 is at 15.85): the z15 tile UNDER THE
    // CAMERA TARGET is fetched + decoded with its imagery — and held off-scene.
    h.view.zoom = 16.0;
    await drain(h, 4);
    expect(h.layer.getStats()).toMatchObject({ tiles: 9, splats: 90, tileZoom: 16 });
    expect(h.layer.getTransitionState()).toMatchObject({ prefetchZ: 15, prefetched: [Z15], fading: false });
    expect(fetched(h, 15)).toBe(1);
    expect(h.fetchTile.mock.calls[h.fetchTile.mock.calls.length - 1][0]).toBe(`https://tiles.test/${Z15}.spz`);
    expect(h.loadTexture.mock.calls.length).toBe(textures + 1);
    expect(levels(h)).toEqual({ 16: 9 }); // not in the scene
    await drain(h, 6);
    expect(fetched(h, 15)).toBe(1); // held, not re-requested

    // Out of the band again → dropped (and its texture with it).
    h.view.zoom = 16.5;
    h.layer.update();
    expect(h.layer.getTransitionState()).toMatchObject({ prefetchZ: null, prefetched: [] });

    // Back in, then ACROSS: the prefetched tile is admitted in the very frame
    // of the switch — no fetch, no decode wait — and dissolves in.
    h.view.zoom = 15.95;
    await drain(h, 4);
    expect(fetched(h, 15)).toBe(2);
    expect(h.layer.getTransitionState().prefetched).toEqual([Z15]);
    h.setTime(7000);
    h.view.zoom = 15.8;
    h.layer.update();
    expect(h.layer.getStats().tileZoom).toBe(15);
    expect(tileState(h, Z15)).toMatchObject({ appear: 'dissolve', fade: 0 });
    expect(h.layer.getTransitionState().prefetched).toEqual([]);
    // (The rest of the z15 window starts loading now; Z15 itself is not re-requested.)
    expect(h.fetchTile.mock.calls.filter(([u]) => u.includes(`/${Z15}.`)).length).toBe(2);
    // Never beyond budget + allowance, prefetched tile included.
    for (let t = 7000; t < 9000; t += 50) {
      h.setTime(t);
      h.layer.update();
      await settle();
      expect(h.layer.getStats().splats).toBeLessThanOrEqual(95 + 10);
    }
    expect(levels(h)).toEqual({ 15: 9 });
  });

  it('prefetch respects maxInFlight, remembers 404s, holds at most two tiles and yields to the window', async () => {
    const h = makeLayer({ levelFadeMs: FADE, maxInFlight: 1 });
    h.view.zoom = 16.0; // in the band from the start
    await h.layer.open();
    h.layer.update(); // the window's first fetch takes the only slot
    expect(h.fetchTile).toHaveBeenCalledTimes(1);
    expect(h.fetchTile.mock.calls[0][0]).toContain('/16/');
    await drain(h, 30);
    // The window (9 × z16) went first; the prefetch only once it was idle.
    const urls = h.fetchTile.mock.calls.map(([u]) => u);
    expect(urls.slice(0, 9).every((u) => u.includes('/16/'))).toBe(true);
    expect(urls[9]).toBe(`https://tiles.test/${Z15}.spz`);
    // Panning along the boundary: at most two decoded tiles are ever held.
    for (let k = 1; k <= 4; k++) {
      h.view.lon += 2 * (360 / 2 ** 16);
      await drain(h, 16);
      expect(h.layer.getTransitionState().prefetched.length).toBeLessThanOrEqual(2);
    }

    const m = makeLayer();
    m.fetchTile.mockImplementation(async (url) => (url.includes('/15/') ? null : new ArrayBuffer(10)));
    m.view.zoom = 16.0;
    await m.layer.open();
    await drain(m, 30);
    expect(fetched(m, 15)).toBe(1); // the 404 is remembered — no probing loop
    expect(m.layer.getTransitionState().prefetched).toEqual([]);
  });

  it("cut-out: during a dissolve the sink gets BOTH levels' settled shapes (max), fading tiles still cover", async () => {
    const pushes: Array<Array<{ key: string; g: number; fade: number; edge: number[] }>> = [];
    const sink: import('../src/splats/SplatsLayer.js').SplatCutoutSink = {
      setCutoutReserved: () => {},
      setCutoutMode: () => {},
      setCutoutRipple: () => {},
      setCutout: (tiles) => {
        pushes.push(tiles.map((t) => ({
          key: `${t.z}/${t.x}/${t.y}`, g: t.g, fade: t.fade ?? 1,
          edge: t.values ? Array.from(t.values).slice(0, 4) : []
        })));
      }
    };
    const h = makeLayer({ levelFadeMs: FADE, hideBasemap: 'covered', radius: 0, prefetchBand: 0 }, { cutout: sink });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 4);
    h.setTime(5000);
    await drain(h, 2); // the z16 tile has grown: g = 1
    expect(pushes[pushes.length - 1]).toEqual([{ key: Z16, g: 1, fade: 1, edge: [0, 0, 0, 0] }]);

    h.setTime(10_000);
    h.view.zoom = 15.5;
    await drain(h, 4);
    const at = (key: string) => pushes[pushes.length - 1].find((t) => t.key === key);
    // The incoming tile cuts with its FULL shape from the first frame (g = 1),
    // capped by its ground fade — which only matters off the z16 tile, where
    // the vector map fades out exactly as the imagery fades in. The outgoing
    // tile keeps cutting whole: under it the max is 1 throughout.
    h.setTime(10_000 + 225);
    h.layer.update();
    expect(at(Z15)).toMatchObject({ g: 1 });
    expect(at(Z15)!.fade).toBeCloseTo(0.5, 9);
    expect(at(Z16)).toEqual({ key: Z16, g: 1, fade: 1, edge: [0, 0, 0, 0] });
    // Splats released, ground lingering: STILL covering.
    h.setTime(10_000 + FADE);
    h.layer.update();
    expect(h.layer.getStats().tiles).toBe(1);
    expect(at(Z16)).toMatchObject({ g: 1, fade: 1 });
    expect(at(Z15)).toMatchObject({ g: 1, fade: 1 });
    h.setTime(10_000 + 2 * FADE);
    h.layer.update();
    expect(pushes[pushes.length - 1].map((t) => t.key)).toEqual([Z15]);
    // At no push during the transition was the z16 ground uncovered.
    const during = pushes.filter((p) => p.some((t) => t.key === Z15) && p.some((t) => t.key === Z16));
    expect(during.length).toBeGreaterThan(2);
    for (const p of during) {
      const covered = Math.max(...p.filter((t) => t.key === Z15 || t.key === Z16).map((t) => Math.min(t.g, t.fade)));
      expect(covered).toBe(1);
    }
  });

  it('levelFadeMs: 0 — instant swap: the old level goes in the very frame the new tile lands', async () => {
    const h = single({ levelFadeMs: 0 });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 4);
    h.setTime(1000);
    h.view.zoom = 15.5;
    h.layer.update(); // switch + fetch
    await settle();
    expect(levels(h)).toEqual({ 16: 1 });
    h.layer.update(); // z15 admitted → z16 released, same update()
    expect(levels(h)).toEqual({ 15: 1 });
    expect(tileState(h, Z15)).toMatchObject({ appear: 'dissolve', fade: 1 });
    expect(groundU(h, Z15).uUnionG.value).toBe(1); // full shape at once — no grow animation either
    expect(h.layer.getStats()).toMatchObject({ tiles: 1, splats: 10 });
    // (The old ground waits one landing for the new imagery, then goes at once.)
    await drain(h, 3);
    expect(h.layer.getTransitionState()).toMatchObject({ ghosts: [], fading: false });
    expect(h.hidden).toEqual([true]);
    // prefers-reduced-motion does the same whatever `levelFadeMs` says — and
    // is re-read at every level switch.
    let reduced = true;
    const r = makeLayer({ radius: 0, prefetchBand: 0, levelFadeMs: FADE }, { prefersReducedMotion: () => reduced });
    r.view.zoom = 16.5;
    await r.layer.open();
    await drain(r, 4);
    r.view.zoom = 15.5;
    await drain(r, 4);
    expect(levels(r)).toEqual({ 15: 1 });
    expect(r.layer.getTransitionState()).toMatchObject({ ghosts: [], fading: false });
    reduced = false;
    r.view.zoom = 16.5;
    await drain(r, 4);
    expect(levels(r)).toEqual({ 15: 1, 16: 1 }); // dissolving again
    // No allowance without a fade: a one-tile budget never holds two levels.
    const b = single({ levelFadeMs: 0, maxSplats: 10 });
    b.view.zoom = 16.5;
    await b.layer.open();
    await drain(b, 4);
    b.view.zoom = 15.5;
    for (let k = 0; k < 6; k++) {
      b.layer.update();
      await settle();
      expect(b.layer.getStats().splats).toBeLessThanOrEqual(10);
    }
    expect(levels(b)).toEqual({ 15: 1 });
  });
});

describe('ripple shader pre-warm', () => {
  it('compiles the ripple modifier during load, then leaves every mesh detached', async () => {
    const warm = makeLayer({}, { prewarmShaders: true });
    await warm.layer.open();
    await drain(warm);
    for (let i = 0; i < 4; i++) warm.layer.update();
    const cold = makeLayer();
    await cold.layer.open();
    await drain(cold);
    for (let i = 0; i < 4; i++) cold.layer.update();

    expect(warm.meshes().length).toBeGreaterThan(0);
    // The pre-warm attaches the modifier (a generator rebuild) and detaches it again, so it
    // costs exactly one extra attach/detach pair on one mesh and nothing is left attached.
    const warmUpdates = warm.meshes().reduce((n, m) => n + m.generatorUpdates, 0);
    const coldUpdates = cold.meshes().reduce((n, m) => n + m.generatorUpdates, 0);
    expect(warmUpdates).toBeGreaterThan(coldUpdates);
    expect(warm.meshes().some((m) => !!m.worldModifier)).toBe(false);
  });

  it('never attaches anything when disabled', async () => {
    const h = makeLayer();
    await h.layer.open();
    await drain(h);
    for (let i = 0; i < 4; i++) h.layer.update();
    expect(h.meshes().some((m) => !!m.worldModifier)).toBe(false);
  });
});

describe('resolution-matched level selection', () => {
  const P = { minTileZoom: 13, maxTileZoom: 16, lodBias: 0, imagePx: 1024, latDeg: 35.105, margin: 0.5 };
  it('picks the coarsest level whose imagery still out-resolves the screen', async () => {
    const { selectTileZoomByResolution, tileImageryMpp } = await import('../src/splats/lod.js');
    // measured metres-per-pixel of this map at those camera zooms
    expect(selectTileZoomByResolution(15.63, null, P)).toBe(13);
    expect(selectTileZoomByResolution(5.16, null, P)).toBe(14);
    expect(selectTileZoomByResolution(2.76, null, P)).toBe(15);
    expect(selectTileZoomByResolution(1.05, null, P)).toBe(16);
    // and the chosen level's imagery really is at least `margin` finer than the screen
    for (const mpp of [15.63, 5.16, 2.76]) {
      const z = selectTileZoomByResolution(mpp, null, P);
      expect(tileImageryMpp(z, P.latDeg, P.imagePx)).toBeLessThanOrEqual(mpp * P.margin);
    }
  });

  it('clamps to the configured range and survives nonsense input', async () => {
    const { selectTileZoomByResolution } = await import('../src/splats/lod.js');
    expect(selectTileZoomByResolution(1e-6, null, P)).toBe(16);   // absurdly fine screen
    expect(selectTileZoomByResolution(1e6, null, P)).toBe(13);    // absurdly coarse
    expect(selectTileZoomByResolution(0, 15, P)).toBe(15);        // keeps previous
    expect(selectTileZoomByResolution(NaN, null, P)).toBe(16);
  });

  it('ignores lodBias (margin is the knob) and hysteresis stops boundary flapping', async () => {
    const { selectTileZoomByResolution } = await import('../src/splats/lod.js');
    // `lodBias` belongs to the camera-zoom rule and must NOT also apply here, or the two
    // policies cancel (a 1.5 bias would drag the level straight back to the finest).
    expect(selectTileZoomByResolution(5.16, null, { ...P, lodBias: 1.5 })).toBe(14);
    // the margin is the detail knob instead: halving it buys one level finer
    expect(selectTileZoomByResolution(5.16, null, { ...P, margin: 0.25 })).toBe(15);
    // sitting just either side of a threshold keeps the level it already had
    const z = selectTileZoomByResolution(3.9, null, P);
    expect(selectTileZoomByResolution(3.95, z, P)).toBe(z);
    expect(selectTileZoomByResolution(3.85, z, P)).toBe(z);
  });
});

describe('tilt-aware resolution matching', () => {
  it('reports the near edge as finer than the target, more so with tilt', async () => {
    const { nearEdgeMppFactor } = await import('../src/splats/lod.js');
    expect(nearEdgeMppFactor(0, 50)).toBeCloseTo(1, 6);        // straight down: no foreshortening
    const t50 = nearEdgeMppFactor(50, 50);
    const t70 = nearEdgeMppFactor(70, 50);
    expect(t50).toBeLessThan(1);
    expect(t70).toBeLessThan(t50);                              // more tilt, finer near field
    // softened by sqrt so one level does not get bought for the near edge alone
    expect(t50).toBeCloseTo(Math.sqrt(Math.cos((50 * Math.PI) / 180) / Math.cos((25 * Math.PI) / 180)), 6);
    expect(nearEdgeMppFactor(50, 50, 1)).toBeLessThan(t50); // blend 1 = the raw factor
    expect(nearEdgeMppFactor(89, 170)).toBeGreaterThanOrEqual(0.25); // clamped, never absurd
    expect(nearEdgeMppFactor(NaN as unknown as number, 50)).toBeGreaterThan(0);
  });

  it('can pull the level one finer when the camera is pitched over', async () => {
    const { nearEdgeMppFactor, selectTileZoomByResolution } = await import('../src/splats/lod.js');
    const P = { minTileZoom: 13, maxTileZoom: 16, lodBias: 0, imagePx: 1024, latDeg: 35.105, margin: 0.5 };
    const mpp = 3.9;
    const flat = selectTileZoomByResolution(mpp, null, P);
    const tilted = selectTileZoomByResolution(mpp * nearEdgeMppFactor(65, 50), null, P);
    expect(tilted).toBeGreaterThanOrEqual(flat);
  });
});


describe('groundDepthBias', () => {
  it('is zero for a lone level, so the ground never hides the base of the walls', async () => {
    const { groundDepthBias } = await import('../src/splats/lod.js');
    // The old rule was -2 * z: -32 at zoom 16, enough slope-scaled offset to swallow ~32 px of wall.
    expect(groundDepthBias(16, 16)).toBe(0);
    expect(groundDepthBias(13, 13)).toBe(0);
    expect(Object.is(groundDepthBias(16, 16), -0)).toBe(false);
  });

  it('lets the finer level win a cross-fade by the level difference only', async () => {
    const { groundDepthBias } = await import('../src/splats/lod.js');
    expect(groundDepthBias(16, 15)).toBe(-2);
    expect(groundDepthBias(16, 13)).toBe(-6);
    expect(groundDepthBias(15, 15)).toBe(0);            // the coarser one stays put
    expect(groundDepthBias(16, 15)).toBeLessThan(groundDepthBias(15, 15));
  });

  it('never biases a tile coarser than the reference', async () => {
    const { groundDepthBias } = await import('../src/splats/lod.js');
    expect(groundDepthBias(14, 16)).toBe(0);
  });
});


describe('lowTierUrlTemplate', () => {
  const LITE = 'https://lite.test/{z}/{x}/{y}.spz';

  it("the low tiers fetch the lite pyramid; 'high' fetches the main one", async () => {
    const h = makeLayer({ lowTierUrlTemplate: LITE });
    h.layer.setQualityTier('low');
    await h.layer.open();
    await drain(h, 12);
    const urls = h.fetchTile.mock.calls.map((c) => c[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://lite.test/'))).toBe(true);
    expect(h.layer.activeUrlTemplate()).toBe(LITE);
  });

  it('without a lite template the low tiers fetch the main pyramid as before', async () => {
    const h = makeLayer();
    h.layer.setQualityTier('low');
    await h.layer.open();
    await drain(h, 12);
    const urls = h.fetchTile.mock.calls.map((c) => c[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://tiles.test/'))).toBe(true);
  });

  it('a tier flip drops the resident tiles and refills from the other pyramid', async () => {
    // motion LoD off: with it on, the high tier ALSO fetches lite tiles (see the next test)
    const h = makeLayer({ lowTierUrlTemplate: LITE, motionLod: false });
    await h.layer.open();
    await drain(h, 12);
    expect(h.fetchTile.mock.calls.every((c) => c[0].startsWith('https://tiles.test/'))).toBe(true);
    const before = h.fetchTile.mock.calls.length;
    h.layer.setQualityTier('low');
    await drain(h, 12);
    const after = h.fetchTile.mock.calls.slice(before).map((c) => c[0]);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((u) => u.startsWith('https://lite.test/'))).toBe(true);
  });

  it('motion LoD: each resident tile also holds its lite version and draws it while the camera moves', async () => {
    const h = makeLayer({ lowTierUrlTemplate: LITE });
    await h.layer.open();
    await drain(h, 16);
    const urls = h.fetchTile.mock.calls.map((c) => c[0]);
    const full = urls.filter((u) => u.startsWith('https://tiles.test/'));
    const lite = urls.filter((u) => u.startsWith('https://lite.test/'));
    expect(full.length).toBeGreaterThan(0);
    expect(lite.length).toBe(full.length);                     // one lite per resident tile
    const roots = h.scene.getObjectsByProperty('name', 'hbd-splats')[0]?.children ?? [];
    const meshes = (kind: string) => roots.flatMap((r) => r.children.filter((c) => c.name.startsWith(kind)));
    const fullMeshes = meshes('splat-tile:');
    const liteMeshes = meshes('splat-tile-lite:');
    expect(liteMeshes.length).toBe(fullMeshes.length);
    // at rest: full drawn, lite hidden
    expect(fullMeshes.every((m) => m.visible) && liteMeshes.every((m) => !m.visible)).toBe(true);
    // moving: the swap is a visibility flip, nothing refetched
    const fetched = h.fetchTile.mock.calls.length;
    h.layer.setCameraMoving(true);
    h.layer.update();
    expect(fullMeshes.every((m) => !m.visible) && liteMeshes.every((m) => m.visible)).toBe(true);
    h.layer.setCameraMoving(false);
    h.layer.update();
    expect(fullMeshes.every((m) => m.visible) && liteMeshes.every((m) => !m.visible)).toBe(true);
    expect(h.fetchTile.mock.calls.length).toBe(fetched);
    // the low tier reads the lite pyramid as its main source: no second copy, no swap
    h.layer.setQualityTier('low');
    await drain(h, 16);
    expect(meshes('splat-tile-lite:').length).toBe(0);
  });

  it('motion detail: the end of a glide draws the full meshes, density rising to every splat', async () => {
    const h = makeLayer({ lowTierUrlTemplate: LITE });
    await h.layer.open();
    await drain(h, 16);
    const roots = h.scene.getObjectsByProperty('name', 'hbd-splats')[0]?.children ?? [];
    const meshes = (kind: string) => roots.flatMap((r) => r.children.filter((c) => c.name.startsWith(kind)));
    const full = meshes('splat-tile:');
    const lite = meshes('splat-tile-lite:');
    const keep = (): number => (h.layer as unknown as { thinDyno: { value: number } }).thinDyno.value;
    h.layer.setCameraMoving(true);
    h.layer.setMotionDetail(0);
    h.layer.update();
    expect(lite.every((m) => m.visible) && full.every((m) => !m.visible)).toBe(true);
    expect(keep()).toBe(1);
    // second half of the glide: full meshes, thinned to the lite density (the fake lite tiles have
    // as many "splats" as the full ones, so that is ratio 1 here) — check the ramp shape instead
    h.layer.setMotionDetail(0.5);
    h.layer.update();
    expect(full.every((m) => m.visible) && lite.every((m) => !m.visible)).toBe(true);
    const half = keep();
    h.layer.setMotionDetail(1);
    h.layer.update();
    expect(keep()).toBe(1);
    expect(half).toBeLessThanOrEqual(1);
    // momentum again: back to the lite set
    h.layer.setMotionDetail(0);
    h.layer.update();
    expect(lite.every((m) => m.visible)).toBe(true);
  });

  it('motion detail: lite → full mid-glide cross-fades (full in over opaque lite, then lite out)', async () => {
    const h = makeLayer({ lowTierUrlTemplate: LITE });
    await h.layer.open();
    await drain(h, 16);
    const sr = h.scene.children.find((c) => c instanceof FakeSparkRenderer) as FakeSparkRenderer & {
      display?: { mappingVersion: number };
    };
    sr.display = { mappingVersion: 1 };
    const roots = h.scene.getObjectsByProperty('name', 'hbd-splats')[0]?.children ?? [];
    const meshes = (kind: string) => roots.flatMap((r) => r.children.filter((c) => c.name.startsWith(kind))) as unknown as
      Array<THREE.Object3D & { opacity?: number }>;
    const full = meshes('splat-tile:');
    const lite = meshes('splat-tile-lite:');
    let now = 50_000;
    h.setTime(now);
    h.layer.setCameraMoving(true);
    h.layer.setMotionDetail(0);
    h.layer.update();
    h.layer.setMotionDetail(0.2);
    h.layer.update();
    // both drawn; the full set waits invisible until Spark displays the combined mapping
    expect(full.every((m) => m.visible) && lite.every((m) => m.visible)).toBe(true);
    expect(full[0].opacity).toBe(0);
    sr.display = { mappingVersion: 2 };
    h.layer.update();                                   // clock starts
    now += 60; h.setTime(now); h.layer.update();        // first half: full fading in, lite opaque
    expect(full[0].opacity).toBeGreaterThan(0);
    expect(full[0].opacity).toBeLessThan(1);
    expect(lite[0].opacity).toBe(1);
    now += 120; h.setTime(now); h.layer.update();       // second half: full opaque, lite fading out
    expect(full[0].opacity).toBe(1);
    expect(lite[0].opacity).toBeLessThan(1);
    now += 200; h.setTime(now); h.layer.update();       // done: lite hidden, opacities reset
    expect(lite.every((m) => !m.visible)).toBe(true);
    expect(full.every((m) => m.visible && m.opacity === 1)).toBe(true);
  });

  it('motion LoD swap hold: primes Spark without drawing, holds until the lite set is sorted, bounded', async () => {
    const camera = new THREE.PerspectiveCamera();
    const h = makeLayer({ lowTierUrlTemplate: LITE }, { getCamera: () => camera });
    await h.layer.open();
    await drain(h, 16);
    const sr = h.scene.children.find((c) => c instanceof FakeSparkRenderer) as FakeSparkRenderer & {
      current?: { mappingVersion: number }; display?: { mappingVersion: number }; sorting?: boolean;
      update?: (o: { scene: THREE.Object3D; camera: THREE.Camera }) => Promise<void>;
    };
    sr.current = { mappingVersion: 1 };
    sr.display = sr.current;
    sr.sorting = false;
    const update = vi.fn(async (o: { scene: THREE.Object3D }) => {
      expect(o.scene.parent).toBeNull();           // the root scene, so Spark finds every mesh
      sr.current = { mappingVersion: 2 };          // new set generated, its sort started
      sr.sorting = true;
    });
    sr.update = update;
    expect(h.layer.holdForSwap()).toBe(false);     // at rest: nothing to hold
    h.layer.setCameraMoving(true);
    h.layer.update();
    expect(h.layer.holdForSwap()).toBe(true);      // first held tick primes Spark…
    expect(update).toHaveBeenCalledTimes(1);
    expect(h.layer.holdForSwap()).toBe(true);      // …then waits for the sort, no second prime
    expect(update).toHaveBeenCalledTimes(1);
    sr.display = sr.current;                       // the sort landed: Spark draws the lite set
    sr.sorting = false;
    expect(h.layer.holdForSwap()).toBe(false);
    expect(h.layer.holdForSwap()).toBe(false);
    // back to rest: no hold (the cheap lite set keeps drawing while the full one sorts)
    h.layer.setCameraMoving(false);
    h.layer.update();
    expect(h.layer.holdForSwap()).toBe(false);
    // a sort that never lands cannot hold the map hostage
    h.layer.setCameraMoving(true);
    h.layer.update();
    expect(h.layer.holdForSwap()).toBe(true);
    h.setTime(1_000_000);
    expect(h.layer.holdForSwap()).toBe(false);
    // Spark already mid-sort at the flip: no hold at all (it could not be cut short)
    h.layer.setCameraMoving(false);
    h.layer.update();
    sr.display = sr.current;
    sr.sorting = true;
    h.layer.setCameraMoving(true);
    h.layer.update();
    const primes = update.mock.calls.length;
    expect(h.layer.holdForSwap()).toBe(false);
    expect(update.mock.calls.length).toBe(primes);
    // …and none while the GPU still has frames queued
    h.layer.setCameraMoving(false);
    h.layer.update();
    sr.sorting = false;
    h.layer.setCameraMoving(true);
    h.layer.update();
    expect(h.layer.holdForSwap(false)).toBe(false);
    expect(update.mock.calls.length).toBe(primes);
  });
});


describe('SplatsLayer cover level', () => {
  const FADE = 350;
  const levels = (h: Harness): Record<number, number> => {
    const out: Record<number, number> = {};
    for (const m of h.meshes()) {
      const z = Number(m.name.replace('splat-tile:', '').split('/')[0]);
      out[z] = (out[z] ?? 0) + 1;
    }
    return out;
  };
  const LITE = 'https://lite.test/{z}/{x}/{y}.spz';

  it('keeps the next coarser level resident under the detail window: focus tile, then the cover, outside the budget, fetched once', async () => {
    const h = makeLayer({ cover: true, maxSplats: 30 }); // 3 detail tiles of 10 "splats"
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 30);
    const urls = h.fetchTile.mock.calls.map(([u]) => u);
    // the detail tile under the view focus first (what the user looks at), then the whole z15
    // cover window, then the rest of the detail
    expect(urls[0]).toBe('https://tiles.test/16/11614/23927.spz');
    expect(urls.slice(1, 10).every((u) => u.includes('/15/'))).toBe(true);
    expect(urls.slice(10).every((u) => u.includes('/16/'))).toBe(true);
    // every cover tile resident whatever the budget; the budget buys 3 detail tiles
    expect(levels(h)).toEqual({ 15: 9, 16: 3 });
    expect(h.layer.getStats()).toMatchObject({ tiles: 12, splats: 120, coverTiles: 9, coverSplats: 90 });
    // no fetch loop: nothing wanted is asked for twice
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('detail dissolves in over its parent; the parent fades per quadrant, never as a whole, and draws under the budget\'s eviction', async () => {
    const h = makeLayer({ cover: true });
    h.view.zoom = 16.5;
    h.setTime(1000);
    await h.layer.open();
    await drain(h, 30);
    h.setTime(1000 + FADE);
    await drain(h, 2);
    const st = h.layer.getTransitionState();
    const parent = st.tiles.find((t) => t.key === '15/5807/11963');
    expect(parent).toBeDefined();
    expect(parent!.fade).toBe(1);
    expect(parent!.quad).toEqual([1, 1, 1, 1]);          // all four children have landed over it
    // the focus tile landed first and grew in; the others arrived over ground the cover already
    // showed and dissolved in
    expect(st.tiles.find((t) => t.key === '16/11614/23927')?.appear).toBe('grow');
    const child = st.tiles.find((t) => t.key === '16/11613/23927');
    expect(child?.appear).toBe('dissolve');
    expect(child?.fade).toBe(1);
    // the budget shrinking takes detail, not cover
    h.layer.applyOptions(resolveSplatsOptions({ cover: true, urlTemplate: 'https://tiles.test/{z}/{x}/{y}.spz', radius: 1, maxInFlight: 100, hideBasemap: true, lodBias: 0, maxSplats: 10 }));
    await drain(h, 4);
    expect(levels(h)[15]).toBe(9);
    expect(levels(h)[16]).toBe(1);
  });

  it('a detail tile over a LANDED cover parent draws without the rounded mask; the cover keeps it', async () => {
    const h = makeLayer({ cover: true });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 30);
    const tiles = (h.layer as unknown as { tiles: Map<string, { unionFeather: { value: number } | null }> }).tiles;
    expect(tiles.get('16/11614/23927')!.unionFeather!.value).toBe(-1);
    expect(tiles.get('15/5807/11963')!.unionFeather!.value).toBeGreaterThanOrEqual(0);
  });

  it('cover tiles come from the lite pyramid when one is configured, and fetch no lite twin of their own', async () => {
    const h = makeLayer({ cover: true, lowTierUrlTemplate: LITE });
    h.view.zoom = 16.5;
    await h.layer.open();
    await drain(h, 40);
    const urls = h.fetchTile.mock.calls.map(([u]) => u);
    const cover = urls.filter((u) => u.includes('/15/'));
    expect(cover.length).toBe(9);
    expect(cover.every((u) => u.startsWith('https://lite.test/'))).toBe(true);
    // detail tiles: full from the main source, plus their motion-LoD twins from the lite one
    expect(urls.filter((u) => u.startsWith('https://tiles.test/16/')).length).toBe(9);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('in motion, every detail tile stays drawn (lite) over its cover parent; nothing to bring back at rest', async () => {
    const h = makeLayer({ cover: true, lowTierUrlTemplate: LITE });
    h.view.zoom = 16.5;
    h.setTime(1000);
    await h.layer.open();
    await drain(h, 40);
    h.setTime(1000 + FADE);
    await drain(h, 2);
    const roots = h.scene.getObjectsByProperty('name', 'hbd-splats')[0]?.children ?? [];
    const vis = (prefix: string): Record<string, boolean> => {
      const out: Record<string, boolean> = {};
      for (const r of roots) for (const c of r.children) if (c.name.startsWith(prefix)) out[c.name.slice(prefix.length)] = c.visible;
      return out;
    };
    // moving: all 9 detail tiles draw their lite mesh — none gives way to the cover
    h.layer.setCameraMoving(true);
    h.layer.setMotionDetail(0);
    h.layer.update();
    const lite = vis('splat-tile-lite:');
    expect(Object.entries(lite).filter(([k, v]) => k.startsWith('16/') && v).length).toBe(9);
    // the parent's quadrants stay handed to its children (1 = that child's detail covers it)
    let st = h.layer.getTransitionState();
    expect(st.tiles.find((t) => t.key === '15/5807/11963')!.quad).toEqual([1, 1, 1, 1]);
    // at rest: the full meshes are back with no dissolve to wait for
    h.layer.setCameraMoving(false);
    h.layer.update();
    st = h.layer.getTransitionState();
    expect(st.tiles.find((t) => t.key === '16/11613/23927')!.fade).toBe(1);
    expect(vis('splat-tile:')['16/11613/23927']).toBe(true);
  });

  it('zooming out hands over: the cover level becomes the detail level, a new cover loads beneath, the old detail dissolves out', async () => {
    const h = makeLayer({ cover: true, prefetchBand: 0 });
    h.view.zoom = 16.5;
    h.setTime(1000);
    await h.layer.open();
    await drain(h, 30);
    expect(levels(h)).toEqual({ 15: 9, 16: 9 });
    h.view.zoom = 15.5;
    await drain(h, 30);
    h.setTime(1000 + FADE);
    await drain(h, 4);
    h.setTime(1000 + 2 * FADE);
    await drain(h, 4);
    const l = levels(h);
    expect(l[14]).toBe(9);
    expect(l[15]).toBe(9);
    expect(l[16]).toBeUndefined();
  });

  it('zooming out with a lite pyramid: the promoted cover tiles get their FULL versions, the lite ones stay as their motion twins; back in, the cover draws lite', async () => {
    const h = makeLayer({ cover: true, lowTierUrlTemplate: LITE, prefetchBand: 0 });
    // lite tiles hold 4 "splats", full ones 10
    h.fetchTile.mockImplementation(async (u: string) => new ArrayBuffer(u.startsWith('https://lite.test/') ? 4 : 10));
    h.view.zoom = 16.5;
    h.setTime(1000);
    await h.layer.open();
    await drain(h, 40);
    h.view.zoom = 15.5;
    await drain(h, 40);
    h.setTime(1000 + FADE);
    await drain(h, 6);
    h.setTime(1000 + 2 * FADE);
    await drain(h, 6);
    type T = { mesh: { name: string; visible: boolean; numSplats: number }; lite: { name: string; visible: boolean } | null; fromLite: boolean; splats: number };
    const tiles = (h.layer as unknown as { tiles: Map<string, T> }).tiles;
    const z15 = [...tiles.entries()].filter(([k]) => k.startsWith('15/'));
    expect(z15.length).toBe(9);
    for (const [k, t] of z15) {
      // the detail level draws the full splats now (before: the lite cover data, for good)
      expect(t.fromLite).toBe(false);
      expect(t.splats).toBe(10);
      expect(t.mesh.name).toBe(`splat-tile:${k}`);
      expect(t.mesh.visible).toBe(true);
      expect(t.lite?.name).toBe(`splat-tile-lite:${k}`);
    }
    const urls = h.fetchTile.mock.calls.map(([u]) => u);
    // each z15 tile fetched twice in all: lite as cover, full as detail — no loop
    expect(urls.filter((u) => u.includes('/15/') && u.startsWith('https://lite.test/')).length).toBe(9);
    expect(urls.filter((u) => u.includes('/15/') && u.startsWith('https://tiles.test/')).length).toBe(9);
    expect(new Set(urls).size).toBe(urls.length);
    // back in: z15 is the cover again and draws its lite version (cover sits outside the budget)
    h.view.zoom = 16.5;
    await drain(h, 40);
    const back = (h.layer as unknown as { tiles: Map<string, T> }).tiles.get(z15[0][0]);
    expect(back?.lite?.visible).toBe(true);
    expect(back?.mesh.visible).toBe(false);
  });
});
