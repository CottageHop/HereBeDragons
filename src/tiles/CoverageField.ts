import * as THREE from 'three';
import type { Projection } from '../core/Projection.js';
import { tileKey, tileWorldRect } from '../core/TileId.js';
import {
  DEFAULT_UNION_FEATHER,
  DEFAULT_UNION_GROW_MS,
  type UnionPresence,
  roundedUnionSignedPacked,
  smoothstep,
  unionGrowthElapsed,
  unionPresenceGrowth,
  unionPresenceStay,
  unionSettleMs,
  unionTileValues
} from '../core/roundedUnion.js';
import type { CoverageUniforms } from '../materials/coverageShader.js';

/**
 * Basemap "tile reveal": the vector basemap is only drawn inside the rounded
 * union of the loaded tiles — the morphological opening (radius half a tile)
 * of their squares. One tile shows as a circle, two adjacent tiles as a pill
 * with the shared side fully joined, a 2×2 block as a rounded square — and
 * the shape GROWS as tiles land (the same maths and animation curves as the
 * splat overlay, `core/roundedUnion.ts`).
 *
 * The basemap's materials are shared across tiles (one toon material per
 * palette slot), so per-tile uniforms are out. Instead this class bakes the
 * shape into one small world-space texture that every material samples by
 * world XZ (`materials/coverageShader.ts`):
 *
 *  - The texture covers the TileManager's keep zone — a (2R+1)² window of
 *    tiles around the camera-centre tile, snapped to tile boundaries, so it
 *    only re-anchors when the centre tile changes (contents are shifted, not
 *    re-baked). Each tile gets a whole number of texels (17 at the defaults).
 *  - Texels hold the SIGNED EDGE DISTANCE `s` of `roundedUnionSigned`, not
 *    the mask: a distance field is nearly linear, so bilinear filtering
 *    reconstructs a crisp round outline at any magnification, and the shader
 *    applies the feather (`smoothstep(0, 2·feather, s)`) at screen
 *    resolution. `s` is clamped to [lo, hi] with `hi` just past the feather,
 *    so settled interior texels are exactly 255 → mask exactly 1.
 *  - A tile's own texels are evaluated in its own frame. An ABSENT tile next
 *    to a present one gets a 2-texel fringe holding the neighbour's field
 *    extended past its side, so interpolation right at a free side (a pill's
 *    straight edge) sees the true slope instead of a clamp.
 *  - Re-baked at most once per frame and only for tiles whose 17 mask values
 *    changed; a settled interior tile is a `fill(255)`. With nothing
 *    animating and no window move, `tick()` is a no-op.
 *
 * Tiles outside the window count as absent (the union is rounded off at the
 * window's rim); a resident tile that re-enters the window grows in again.
 *
 * SECOND CHANNEL — the satellite cut-out. The texture is RG: R is the reveal
 * above, G is the rounded union of the splat overlay's resident tiles, which
 * the shader uses as an INVERSE mask (`reveal · (1 − cut)`): the vector map is
 * removed exactly where the 3D satellite has landed. The overlay pushes its
 * tiles with the very 17 mask values its own GPU mask uses (`setCutout`), of
 * every resident level — the bake takes the max over them, so both levels of
 * a level transition cut. Splat tiles live on their own grid (any level, not
 * the basemap's), so G is not cell-structured: each tile is evaluated over
 * its own texel rectangle (plus a 2-texel fringe) and stored as the RAMP
 * COORDINATE `s / (2·feather)`, which is unit-free across levels. Only G's
 * bounding box is touched, only when the pushed values changed or the window
 * moved; R is never re-baked for it. G works with the reveal switched off
 * (the window is then maintained for the cut-out alone), and the texture is
 * allocated at twice the resolution while a cut-out is in use, because a
 * z16 splat tile is a quarter of a z14 basemap tile across.
 */

/** Option shape of `HereBeDragonsOptions.tileReveal`. */
export interface TileRevealOptions {
  /** Grow-in length in ms (`0` = the shape changes at once). Default 700. */
  growMs?: number;
  /** Soft-edge half-width in tile units. Default 0.03, capped at 0.2. */
  feather?: number;
  /**
   * Also keep the legacy 30 m "rise from below ground" slab animation on new
   * tiles. Default false: a growing disc and a rising slab fight each other,
   * so with the reveal on tiles land at ground level and late-arriving
   * buildings grow up out of the ground instead (`tileSpawnDurationMs`).
   */
  rise?: boolean;
}

export interface ResolvedTileReveal {
  enabled: boolean;
  growMs: number;
  feather: number;
  rise: boolean;
}

/** Largest feather the distance encoding keeps exact interiors for. */
export const MAX_TILE_REVEAL_FEATHER = 0.2;

/** `true` / `undefined` → defaults; `false` → off; object → overrides. */
export function resolveTileReveal(opt: boolean | TileRevealOptions | undefined): ResolvedTileReveal {
  const o = typeof opt === 'object' && opt !== null ? opt : {};
  const num = (v: number | undefined, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
  return {
    enabled: opt !== false,
    growMs: num(o.growMs, DEFAULT_UNION_GROW_MS),
    feather: Math.min(num(o.feather, DEFAULT_UNION_FEATHER), MAX_TILE_REVEAL_FEATHER),
    rise: o.rise === true
  };
}

/**
 * The smallest `tileReveal` option value that reproduces `r`: `undefined`
 * when everything is at its default (leave the key out), `false` when off,
 * else an object carrying only the non-default params.
 */
export function exportTileReveal(r: ResolvedTileReveal): false | TileRevealOptions | undefined {
  if (!r.enabled) return false;
  const out: TileRevealOptions = {};
  if (r.growMs !== DEFAULT_UNION_GROW_MS) out.growMs = r.growMs;
  if (Math.abs(r.feather - DEFAULT_UNION_FEATHER) > 1e-6) out.feather = r.feather;
  if (r.rise) out.rise = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Default texture edge, texels. Grows (×2) only for very large windows. */
const DEFAULT_TEXTURE_SIZE = 256;
/** …and while a cut-out is in use (finer splat tiles need the texels): the
 *  edge doubles until the FINEST splat level gets this many texels per tile
 *  (512² for a z16 pyramid over a z14 basemap), up to this cap. */
const CUTOUT_MIN_TEXELS_PER_TILE = 8;
const CUTOUT_DEFAULT_FINEST_ZOOM = 16;
const CUTOUT_MAX_TEXTURE_SIZE = 1024;
/** Channels per texel: R = tile reveal, G = satellite cut-out. */
const CH = 2;
/** Stored range of the cut-out's ramp coordinate `t = s / (2·feather)`: the
 *  ramp [0, 1] plus room for a bilinear footprint on either side. */
const CUT_LO = -4;
const CUT_HI = 5;
/** Texels baked past a cut-out tile's own square (true field, not a clamp). */
const CUT_FRINGE_TEXELS = 2;

/** One splat tile of the cut-out, as the overlay pushes it (`setCutout`). */
export interface CutoutTile {
  z: number;
  x: number;
  y: number;
  /** The tile's own growth. */
  g: number;
  /** The 16 values of `unionTileValues` (weights ×8, bridge growths ×8);
   *  omitted = a plain square tile (rounded union off). */
  values?: ArrayLike<number>;
  /** Level cross-dissolve of the tile's imagery ground, 0‥1 (default 1): the
   *  tile's cut is capped at this, so on NEW ground the vector map fades out
   *  exactly as the imagery fades in. Where another level already cuts, the
   *  max over tiles keeps the cut whole — nothing flashes through. */
  fade?: number;
}

/** 0 = no cut-out, 1 = cut the basemap (labels stay), 2 = cut labels too. */
export type CutoutMode = 0 | 1 | 2;

interface StoredCutoutTile {
  z: number;
  x: number;
  y: number;
  g: number;
  square: boolean;
  values: Float64Array;
  /** Cap on the stored ramp coordinate (`+∞` = none): smoothstep⁻¹(fade). */
  cap: number;
}
/** Fewest texels a tile may get before the texture is doubled. */
const MIN_TEXELS_PER_TILE = 12;
/** Width (texels) of the fringe baked into an absent tile beside a present one. */
const FRINGE_TEXELS = 2;

const CELL_BLANK = 0;
const CELL_TILE = 1;
const CELL_FRINGE = 2;

/** Values per tile: growth + the 16 of `unionTileValues`. */
const PARAMS = 17;

/** The 8 neighbour offsets (dx east, dy SOUTH). */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]
];

export class CoverageField {
  private readonly presence = new Map<string, UnionPresence>();
  private cfg: ResolvedTileReveal;
  private readonly clock: () => number;

  // --- window -------------------------------------------------------------
  private radius = 7;
  private z = -1;
  /** Pending centre tile (applied by the next `tick`). */
  private wantX = 0;
  private wantY = 0;
  private hasCentre = false;
  /** Tile coords of window cell (0, 0) as baked; NaN before the first bake. */
  private x0 = NaN;
  private y0 = NaN;

  // --- texture ------------------------------------------------------------
  private size = 0;
  /** Texels per tile. */
  private ppt = 0;
  private data: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private scratch: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private texture: THREE.DataTexture | null = null;
  /** Decode: s = (byte / 255) · (hi − lo) + lo. */
  private lo = 0;
  private hi = 1;

  // --- per-cell bake state (window cells, row-major, j south) ---------------
  private cellKind = new Uint8Array(0);
  private cellParams = new Float32Array(0);
  private cellChanged = new Uint8Array(0);
  /** Cells whose mask values may have moved this tick: the 3×3 around every
   *  animating tile and every membership change. Everything else is skipped
   *  without even recomputing its values. */
  private cellHot = new Uint8Array(0);
  /** Presence per window cell, rebuilt each bake (no string keys in the loop). */
  private cellPresence: Array<UnionPresence | undefined> = [];
  /** Evaluate every cell on the next bake (window moved / invalidated). */
  private hotAll = true;
  /** Tile coords (x, y pairs) whose membership changed since the last bake. */
  private touched: number[] = [];

  // --- cut-out (G channel) --------------------------------------------------
  private cutMode: CutoutMode = 0;
  /** Texture allocated at the cut-out resolution (`setCutoutReserved`). */
  private cutReserved = false;
  /** Finest splat level the cut-out has to resolve. */
  private cutFinestZoom = CUTOUT_DEFAULT_FINEST_ZOOM;
  private cutTiles: StoredCutoutTile[] = [];
  private cutFeather = DEFAULT_UNION_FEATHER;
  /** The pushed tiles changed since the last bake. */
  private cutDirty = false;
  /** Texel bounding box of what is baked into G (x0 > x1 = nothing). */
  private cutBox = { x0: 1, y0: 1, x1: 0, y1: 0 };
  /** G-channel re-bakes so far (tests / HUD). */
  cutBakeCount = 0;

  private dirty = true;
  private animating = false;
  /** Texture uploads so far — lets tests (and the HUD) see that an idle
   *  field does no work. */
  bakeCount = 0;

  private readonly values = new Float64Array(PARAMS - 1);
  /** Scratch the texel loops read (always the same array type → the hot
   *  evaluator stays monomorphic). */
  private readonly evalValues = new Float64Array(PARAMS - 1);
  /** Tiles still moving as of the last tick — each gets one final bake on
   *  the tick it settles, so the rest state is exact (interiors → 255). */
  private readonly live = new Set<UnionPresence>();

  constructor(
    private readonly projection: Projection,
    readonly uniforms: CoverageUniforms,
    config: ResolvedTileReveal,
    clock: () => number = () => performance.now()
  ) {
    this.cfg = { ...config };
    this.clock = clock;
    this.layout();
    this.writeParams();
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Whether new tiles should keep the legacy rise-from-below animation. */
  get slabRise(): boolean {
    return !this.cfg.enabled || this.cfg.rise;
  }

  get config(): Readonly<ResolvedTileReveal> {
    return this.cfg;
  }

  /**
   * Turn the mask on / off at runtime. Membership is tracked either way, so
   * switching on shows the settled union of whatever is loaded.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.cfg.enabled) return;
    this.cfg.enabled = enabled;
    if (enabled) {
      // Whatever landed while the mask was off is simply there.
      for (const p of this.presence.values()) p.inMs = -Infinity;
      this.invalidate();
    }
    this.writeParams();
  }

  /**
   * Retune the reveal at runtime. `growMs` applies to whatever lands next
   * (tiles mid-growth simply finish on the new curve); `feather` re-derives
   * the distance encoding and re-bakes the window; `rise` is read by the
   * TileManager for each new tile. Invalid values are ignored, `feather` is
   * capped like the constructor option. Does not touch `enabled`.
   */
  setOptions(opts: TileRevealOptions): void {
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (ok(opts.growMs) && opts.growMs !== this.cfg.growMs) {
      this.cfg.growMs = opts.growMs;
      this.dirty = true;
    }
    if (typeof opts.rise === 'boolean') this.cfg.rise = opts.rise;
    if (ok(opts.feather)) {
      const feather = Math.min(opts.feather, MAX_TILE_REVEAL_FEATHER);
      if (feather !== this.cfg.feather) {
        this.cfg.feather = feather;
        this.encodeRange();
        this.invalidate();
        this.writeParams();
      }
    }
  }

  /** Chebyshev radius (tiles) of the window — the TileManager's keep radius. */
  setWindowRadius(radius: number): void {
    const r = Math.max(0, Math.floor(radius));
    if (r === this.radius) return;
    this.radius = r;
    this.layout();
  }

  /**
   * The camera-centre tile. A new `z` (quality-tier flip, zoom-offset change:
   * another grid, another tile size) drops everything — tiles of the old
   * zoom are evicted wholesale by the TileManager anyway.
   */
  setCentre(z: number, x: number, y: number): void {
    if (z !== this.z) this.reset(z);
    if (this.hasCentre && x === this.wantX && y === this.wantY) return;
    this.wantX = x;
    this.wantY = y;
    this.hasCentre = true;
    this.dirty = true;
  }

  /** A tile landed (its first geometry was added to the scene). */
  addTile(z: number, x: number, y: number): void {
    if (z !== this.z) this.reset(z);
    const key = tileKey(z, x, y);
    const now = this.clock();
    const p = this.presence.get(key);
    if (p) {
      // A leaving tile came back: regrow from its current size.
      if (p.outMs !== null) {
        const g = unionPresenceGrowth(p, now, this.cfg.growMs);
        p.inMs = now - unionGrowthElapsed(g, this.cfg.growMs);
        p.outMs = null;
      }
    } else {
      this.presence.set(key, { x, y, inMs: this.animated() ? now : -Infinity, outMs: null });
    }
    this.touched.push(x, y);
    this.dirty = true;
  }

  /**
   * A tile left (evicted). Never blocks the eviction: the geometry is gone
   * NOW; what stays behind for `UNION_LEAVE_MS` is a timestamp, so the
   * neighbours' joins toward it retract instead of snapping to round corners.
   */
  removeTile(z: number, x: number, y: number): void {
    if (z !== this.z) return;
    const key = tileKey(z, x, y);
    const p = this.presence.get(key);
    if (!p) return;
    if (this.animated()) p.outMs ??= this.clock();
    else this.presence.delete(key);
    this.touched.push(x, y);
    this.dirty = true;
  }

  /** Forget every tile (and ghost) at once. */
  clear(): void {
    this.presence.clear();
    this.live.clear();
    this.invalidate();
  }

  /** Resident (non-leaving) tiles being tracked. */
  get tileCount(): number {
    let n = 0;
    for (const p of this.presence.values()) if (p.outMs === null) n++;
    return n;
  }

  /** True while the shape is still moving (or a re-bake is pending). */
  get active(): boolean {
    return (this.cfg.enabled && (this.dirty || this.animating)) || (this.cutMode > 0 && this.cutDirty);
  }

  // --- cut-out API -----------------------------------------------------------

  /**
   * Reserve (or release) the cut-out resolution: the texture is re-allocated
   * at twice the edge and the reveal re-baked once (membership and growth are
   * kept). Done when an overlay that may cut is configured — not when its
   * first tile lands, which is a bad moment for a hitch.
   */
  setCutoutReserved(on: boolean, finestZoom = CUTOUT_DEFAULT_FINEST_ZOOM): void {
    if (on === this.cutReserved && (!on || finestZoom === this.cutFinestZoom)) return;
    this.cutReserved = on;
    this.cutFinestZoom = finestZoom;
    this.layout();
    this.cutDirty = true;
  }

  /**
   * Switch the satellite cut-out: 0 = off, 1 = cut the basemap but keep
   * labels, 2 = cut labels too. A uniform write (plus one G bake when it
   * comes on).
   */
  setCutoutMode(mode: CutoutMode): void {
    if (mode === this.cutMode) return;
    this.cutMode = mode;
    this.cutDirty = true;
    this.writeParams();
  }

  get cutoutMode(): CutoutMode {
    return this.cutMode;
  }

  /**
   * The overlay's resident tiles (every level) with their current mask
   * values, and the feather of its soft edge (tile units). Values are copied.
   * Call only when something changed — each call costs one G re-bake.
   */
  setCutout(tiles: ReadonlyArray<CutoutTile>, feather: number): void {
    if (tiles.length === 0 && this.cutTiles.length === 0) return;
    const out: StoredCutoutTile[] = [];
    for (const t of tiles) {
      const values = new Float64Array(PARAMS - 1);
      if (t.values) for (let k = 0; k < PARAMS - 1; k++) values[k] = t.values[k];
      // The shader takes smoothstep(ramp): capping the ramp at smoothstep⁻¹(f)
      // caps the cut at f.
      const f = t.fade === undefined ? 1 : Math.min(Math.max(t.fade, 0), 1);
      if (f <= 0) continue;
      const cap = f >= 1 ? Infinity : 0.5 - Math.sin(Math.asin(1 - 2 * f) / 3);
      out.push({ z: t.z, x: t.x, y: t.y, g: t.g, square: !t.values, values, cap });
    }
    this.cutTiles = out;
    this.cutFeather = feather;
    this.cutDirty = true;
  }

  /** The overlay's ripple front (scene x / z, metres); `active: false` = none. */
  setCutoutRipple(active: boolean, originX = 0, originZ = 0, radius = 0, width = 0): void {
    this.uniforms.uCoverageRipple.value.set(originX, originZ, radius, active ? Math.max(width, 1e-3) : 0);
  }

  /**
   * CPU twin of the shader's cut: how much of the basemap the satellite has
   * taken at a scene position, 0‥1 (ripple front included). 0 when off.
   */
  cutoutAt(worldX: number, worldZ: number): number {
    if (this.cutMode === 0 || !this.texture || Number.isNaN(this.x0)) return 0;
    const g = this.sample(worldX, worldZ, 1);
    if (g < 0) return 0;
    let k = smoothstep(0, 1, (g / 255) * (CUT_HI - CUT_LO) + CUT_LO);
    const rp = this.uniforms.uCoverageRipple.value;
    if (rp.w > 0) k *= smoothstep(0, 1, (rp.z - Math.hypot(worldX - rp.x, worldZ - rp.y)) / rp.w);
    return k;
  }

  /**
   * Advance the animation and re-bake what changed. Call once per frame.
   * @returns true if the texture (or its rect) changed — a frame is needed.
   */
  tick(): boolean {
    const reveal = this.cfg.enabled;
    const cut = this.cutMode > 0;
    if (!reveal) {
      // Keep membership tidy while off; nothing to bake into R.
      if (this.dirty) this.retire(this.clock());
      this.touched.length = 0;
      this.animating = false;
      if (!cut) {
        this.dirty = false;
        return false;
      }
    }
    if (!this.dirty && !this.animating && !(cut && this.cutDirty)) return false;
    if (!this.hasCentre) return false;
    const now = this.clock();
    this.dirty = false;
    const moved = this.anchor(now);
    let changed = moved;
    if (reveal) {
      this.cellHot.fill(0);
      this.animating = this.retire(now);
      changed = this.bake(now) || changed;
    }
    if (cut && (moved || this.cutDirty)) changed = this.bakeCutout(moved) || changed;
    if (changed && this.texture) {
      this.texture.needsUpdate = true;
      this.bakeCount++;
    }
    return changed || this.animating;
  }

  /**
   * CPU twin of the shader's `hbdCoverage(worldXZ)`: the mask ∈ [0,1] at a
   * scene position (bilinear sample → decode → feather). 1 when the reveal is
   * off; 0 outside the window. Used to keep picking / elevation queries off
   * geometry the mask has hidden.
   */
  coverageAt(worldX: number, worldZ: number): number {
    let c = 1;
    if (this.cfg.enabled) {
      if (!this.texture || Number.isNaN(this.x0)) return 0;
      const r = this.sample(worldX, worldZ, 0);
      if (r < 0) return 0;
      const s = (r / 255) * (this.hi - this.lo) + this.lo;
      c = smoothstep(0, 2 * Math.max(this.cfg.feather, 1e-4), s);
    }
    return this.cutMode > 0 ? c * (1 - this.cutoutAt(worldX, worldZ)) : c;
  }

  /** Bilinear sample (0‥255) of channel `ch` at a scene position — GL_LINEAR
   *  with clamp-to-edge; −1 outside the window. */
  private sample(worldX: number, worldZ: number, ch: number): number {
    const rect = this.uniforms.uCoverageRect.value;
    const u = (worldX - rect.x) * rect.z;
    const v = (worldZ - rect.y) * rect.w;
    if (u < 0 || u > 1 || v < 0 || v > 1) return -1;
    const n = this.size;
    // Texel centres sit at (k + 0.5) / n.
    const fx = Math.min(Math.max(u * n - 0.5, 0), n - 1);
    const fy = Math.min(Math.max(v * n - 0.5, 0), n - 1);
    const ix = Math.min(Math.floor(fx), n - 2);
    const iy = Math.min(Math.floor(fy), n - 2);
    const ax = fx - ix;
    const ay = fy - iy;
    const d = this.data;
    const a = (iy * n + ix) * CH + ch;
    const b = a + n * CH;
    const r0 = d[a] * (1 - ax) + d[a + CH] * ax;
    const r1 = d[b] * (1 - ax) + d[b + CH] * ax;
    return r0 * (1 - ay) + r1 * ay;
  }

  /** Decoded signed edge distance (tile units) stored at a texel. Tests. */
  signedAtTexel(tx: number, ty: number): number {
    return (this.data[(ty * this.size + tx) * CH] / 255) * (this.hi - this.lo) + this.lo;
  }

  /** Decoded cut-out ramp coordinate `s / (2·feather)` stored at a texel. Tests. */
  cutRampAtTexel(tx: number, ty: number): number {
    return (this.data[(ty * this.size + tx) * CH + 1] / 255) * (CUT_HI - CUT_LO) + CUT_LO;
  }

  /** Bake geometry, for tests: texture edge, texels per tile, window origin. */
  get layoutInfo(): { size: number; texelsPerTile: number; x0: number; y0: number; z: number } {
    return { size: this.size, texelsPerTile: this.ppt, x0: this.x0, y0: this.y0, z: this.z };
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.presence.clear();
    // Leave the shared uniforms in the "off" state for whoever still holds them.
    this.uniforms.uCoverageParams.value.x = 0;
    this.uniforms.uCoverageCut.value.x = 0;
    this.uniforms.uCoverageRipple.value.w = 0;
  }

  // -------------------------------------------------------------------------

  private animated(): boolean {
    return this.cfg.enabled && this.cfg.growMs > 0;
  }

  private get cells(): number {
    return 2 * this.radius + 1;
  }

  /** New zoom: another grid. Drop all membership and the baked window. */
  private reset(z: number): void {
    const first = this.z < 0;
    this.z = z;
    // The cut-out resolution depends on the basemap's tile size.
    if (this.cutReserved && !first) this.layout();
    this.presence.clear();
    this.live.clear();
    this.hasCentre = false;
    this.invalidate();
  }

  /** Force a full re-bake on the next tick. */
  private invalidate(): void {
    this.x0 = NaN;
    this.y0 = NaN;
    this.hotAll = true;
    this.dirty = true;
  }

  /** Mark the 3×3 of window cells around tile (x, y) for re-evaluation. */
  private heat(x: number, y: number): void {
    const cells = this.cells;
    const ci = x - this.x0;
    const cj = y - this.y0;
    for (let j = Math.max(0, cj - 1); j <= Math.min(cells - 1, cj + 1); j++) {
      for (let i = Math.max(0, ci - 1); i <= Math.min(cells - 1, ci + 1); i++) {
        this.cellHot[j * cells + i] = 1;
      }
    }
  }

  /** (Re)allocate the texture + cell state for the current window radius. */
  private layout(): void {
    const cells = this.cells;
    let size = DEFAULT_TEXTURE_SIZE;
    while (Math.floor(size / cells) < MIN_TEXELS_PER_TILE && size < 2048) size *= 2;
    if (this.cutReserved) {
      // A splat tile of the finest level is 2^(finest − z) times smaller than
      // a basemap tile (z unknown before the first centre: assume z14).
      const ratio = 2 ** Math.max(0, this.cutFinestZoom - (this.z >= 0 ? this.z : 14));
      while (Math.floor(size / cells) / ratio < CUTOUT_MIN_TEXELS_PER_TILE && size < CUTOUT_MAX_TEXTURE_SIZE) size *= 2;
    }
    this.ppt = Math.max(1, Math.floor(size / cells));
    if (size !== this.size) {
      this.size = size;
      this.data = new Uint8Array(size * size * CH);
      this.scratch = new Uint8Array(size * size * CH);
      this.texture?.dispose();
      const tex = new THREE.DataTexture(this.data, size, size, THREE.RGFormat, THREE.UnsignedByteType);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.texture = tex;
      this.uniforms.uCoverageTex.value = tex;
    }
    this.cellKind = new Uint8Array(cells * cells);
    this.cellParams = new Float32Array(cells * cells * PARAMS);
    this.cellChanged = new Uint8Array(cells * cells);
    this.cellHot = new Uint8Array(cells * cells);
    this.cellPresence = new Array<UnionPresence | undefined>(cells * cells);
    this.encodeRange();
    this.invalidate();
    this.writeParams();
  }

  /**
   * Clamp range of the stored distance: the feather ramp [0, 2f] plus the
   * reach of one bilinear footprint (1.5 texels) on either side, so no
   * clamped texel ever takes part in interpolating a point on the ramp.
   */
  private encodeRange(): void {
    const margin = 1.5 / this.ppt;
    this.lo = -margin;
    this.hi = 2 * this.cfg.feather + margin;
  }

  private writeParams(): void {
    this.uniforms.uCoverageParams.value.set(
      this.cfg.enabled ? 1 : 0,
      this.hi - this.lo,
      this.lo,
      1 / (2 * Math.max(this.cfg.feather, 1e-4))
    );
    this.uniforms.uCoverageCut.value.set(this.cutMode, CUT_HI - CUT_LO, CUT_LO, 0);
  }

  /**
   * Retire finished ghosts and heat the cells around everything that moves.
   * @returns whether anything is still animating.
   */
  private retire(now: number): boolean {
    const settleMs = unionSettleMs(this.cfg.growMs);
    let animating = false;
    for (const [key, p] of this.presence) {
      if (p.outMs === null) {
        if (now - p.inMs >= settleMs) {
          if (!this.live.delete(p)) continue; // settled earlier: cold
        } else {
          animating = true;
          this.live.add(p);
        }
      } else if (unionPresenceStay(p, now) > 0) {
        animating = true;
      } else {
        this.presence.delete(key);
        this.live.delete(p);
      }
      this.heat(p.x, p.y);
    }
    return animating;
  }

  private inWindow(x: number, y: number, x0: number, y0: number): boolean {
    const c = this.cells;
    return x >= x0 && y >= y0 && x < x0 + c && y < y0 + c;
  }

  /**
   * Move the window onto the pending centre tile: shift the baked texels and
   * cell state (cells scrolling in start blank) and point the rect uniform
   * at the new footprint. @returns true if the window moved.
   */
  private anchor(now: number): boolean {
    const x0 = this.wantX - this.radius;
    const y0 = this.wantY - this.radius;
    if (x0 === this.x0 && y0 === this.y0) return false;
    this.hotAll = true; // cells scrolled in; rim tiles gained / lost neighbours
    const cells = this.cells;
    const dx = x0 - this.x0;
    const dy = y0 - this.y0;
    if (Number.isNaN(dx) || Number.isNaN(dy) || Math.abs(dx) >= cells || Math.abs(dy) >= cells) {
      this.data.fill(0);
      this.cellKind.fill(CELL_BLANK);
    } else {
      // A resident tile scrolling INTO the window was treated as absent until
      // now; let it grow in rather than pop.
      if (this.animated()) {
        for (const p of this.presence.values()) {
          if (p.outMs === null && !this.inWindow(p.x, p.y, this.x0, this.y0) && this.inWindow(p.x, p.y, x0, y0)) {
            p.inMs = now;
            this.animating = true;
          }
        }
      }
      this.shift(dx, dy);
    }
    this.x0 = x0;
    this.y0 = y0;

    // The texture spans size / ppt tiles (the window plus a blank remainder).
    const a = tileWorldRect(this.projection, this.z, x0, y0);
    const tile = a.xMax - a.xMin;
    const span = (this.size / this.ppt) * tile;
    this.uniforms.uCoverageRect.value.set(a.xMin, a.zMin, 1 / span, 1 / span);
    return true;
  }

  /** New cell (i, j) ← old cell (i + dx, j + dy), texels and state alike. */
  private shift(dx: number, dy: number): void {
    const cells = this.cells;
    const n = this.size;
    const ppt = this.ppt;
    this.scratch.set(this.data);
    this.data.fill(0);
    const used = cells * ppt;
    const sx = dx * ppt;
    const sy = dy * ppt;
    const xa = Math.max(0, -sx);
    const xb = Math.min(used, used - sx);
    // Both channels ride along; G is re-baked right after a move anyway.
    for (let ty = Math.max(0, -sy); ty < Math.min(used, used - sy); ty++) {
      const src = (ty + sy) * n + sx;
      this.data.set(this.scratch.subarray((src + xa) * CH, (src + xb) * CH), (ty * n + xa) * CH);
    }
    const kind = this.cellKind.slice();
    const params = this.cellParams.slice();
    this.cellKind.fill(CELL_BLANK);
    for (let j = 0; j < cells; j++) {
      const oj = j + dy;
      if (oj < 0 || oj >= cells) continue;
      for (let i = 0; i < cells; i++) {
        const oi = i + dx;
        if (oi < 0 || oi >= cells) continue;
        const to = j * cells + i;
        const from = oj * cells + oi;
        this.cellKind[to] = kind[from];
        this.cellParams.set(params.subarray(from * PARAMS, (from + 1) * PARAMS), to * PARAMS);
      }
    }
  }

  /** Presence of window cell (i, j); undefined when absent or out of window. */
  private at = (x: number, y: number): UnionPresence | undefined => {
    if (!this.inWindow(x, y, this.x0, this.y0)) return undefined;
    return this.cellPresence[(y - this.y0) * this.cells + (x - this.x0)];
  };

  /** Re-bake every cell whose inputs changed. @returns true if any texel did. */
  private bake(now: number): boolean {
    const cells = this.cells;
    const growMs = this.cfg.growMs;
    const values = this.values;
    const changedCells = this.cellChanged;
    changedCells.fill(0);
    let changed = false;
    const hot = this.cellHot;
    const all = this.hotAll;
    this.hotAll = false;
    for (let k = 0; k < this.touched.length; k += 2) this.heat(this.touched[k], this.touched[k + 1]);
    this.touched.length = 0;
    const where = this.cellPresence;
    where.fill(undefined);
    for (const p of this.presence.values()) {
      if (this.inWindow(p.x, p.y, this.x0, this.y0)) where[(p.y - this.y0) * cells + (p.x - this.x0)] = p;
    }

    // Pass 1 — tiles (and leaving ghosts): own-frame distance field.
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const c = j * cells + i;
        if (!all && hot[c] === 0) continue;
        const p = where[c];
        if (!p) {
          if (this.cellKind[c] === CELL_TILE) {
            // Became absent: pass 2 decides between blank and fringe.
            this.clearCell(i, j);
            this.cellKind[c] = CELL_BLANK;
            changedCells[c] = 1;
            changed = true;
          }
          continue;
        }
        const g = unionTileValues(p, this.at, now, growMs, values);
        const o = c * PARAMS;
        const cp = this.cellParams;
        let same = this.cellKind[c] === CELL_TILE && cp[o] === Math.fround(g);
        for (let k = 0; same && k < PARAMS - 1; k++) same = cp[o + 1 + k] === Math.fround(values[k]);
        if (same) continue;
        cp[o] = g;
        for (let k = 0; k < PARAMS - 1; k++) cp[o + 1 + k] = values[k];
        this.bakeTile(i, j, g, values);
        this.cellKind[c] = CELL_TILE;
        changedCells[c] = 1;
        changed = true;
      }
    }

    // Pass 2 — absent cells beside a changed cell: refresh their fringe.
    if (!changed) return false;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const c = j * cells + i;
        if (this.cellKind[c] === CELL_TILE) continue;
        let touched = changedCells[c] === 1;
        let anyTile = false;
        for (const [dx, dy] of NEIGHBOURS) {
          const ni = i + dx;
          const nj = j + dy;
          if (ni < 0 || nj < 0 || ni >= cells || nj >= cells) continue;
          const nc = nj * cells + ni;
          if (this.cellKind[nc] === CELL_TILE) {
            anyTile = true;
            if (changedCells[nc] === 1) touched = true;
          }
        }
        if (!touched) continue;
        if (this.cellKind[c] === CELL_FRINGE) this.clearCell(i, j);
        this.cellKind[c] = CELL_BLANK;
        if (anyTile) {
          this.bakeFringe(i, j);
          this.cellKind[c] = CELL_FRINGE;
        }
        changed = true;
      }
    }
    return changed;
  }

  private encode(s: number): number {
    const t = (s - this.lo) / (this.hi - this.lo);
    return t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
  }

  private clearCell(i: number, j: number): void {
    const ppt = this.ppt;
    const n = this.size;
    const data = this.data;
    for (let ty = 0; ty < ppt; ty++) {
      const row = ((j * ppt + ty) * n + i * ppt) * CH;
      for (let k = row, end = row + ppt * CH; k < end; k += CH) data[k] = 0;
    }
  }

  /** Bake one tile's texels from its growth + 16 mask values. */
  private bakeTile(i: number, j: number, g: number, values: ArrayLike<number>): void {
    const ppt = this.ppt;
    const n = this.size;
    const data = this.data;
    // Settled interior: grown, every join and block complete → all inside.
    let full = g >= 1;
    for (let k = 0; full && k < PARAMS - 1; k++) full = values[k] >= 1;
    if (full) {
      for (let ty = 0; ty < ppt; ty++) {
        const row = ((j * ppt + ty) * n + i * ppt) * CH;
        for (let k = row, end = row + ppt * CH; k < end; k += CH) data[k] = 255;
      }
      return;
    }
    const lo = this.lo;
    const k255 = 255 / (this.hi - lo);
    const vals = this.evalValues;
    for (let k = 0; k < PARAMS - 1; k++) vals[k] = values[k];
    for (let ty = 0; ty < ppt; ty++) {
      // Rows run SOUTH; the union frame's v runs north.
      const v = 1 - (ty + 0.5) / ppt;
      const row = ((j * ppt + ty) * n + i * ppt) * CH;
      for (let tx = 0; tx < ppt; tx++) {
        const u = (tx + 0.5) / ppt;
        // Uint8ClampedArray-style encode, inlined (hot loop).
        const e = (roundedUnionSignedPacked(u, v, vals, g) - lo) * k255;
        data[row + tx * CH] = e <= 0 ? 0 : e >= 255 ? 255 : e + 0.5;
      }
    }
  }

  /**
   * Absent cell (i, j): a band of `FRINGE_TEXELS` along each side / corner
   * that touches a tile, holding that tile's field evaluated past its own
   * square (max over the tiles that reach a texel).
   */
  private bakeFringe(i: number, j: number): void {
    const cells = this.cells;
    const ppt = this.ppt;
    const n = this.size;
    const data = this.data;
    const band = Math.min(FRINGE_TEXELS, ppt);
    for (const [dx, dy] of NEIGHBOURS) {
      const ni = i + dx;
      const nj = j + dy;
      if (ni < 0 || nj < 0 || ni >= cells || nj >= cells) continue;
      const nc = nj * cells + ni;
      if (this.cellKind[nc] !== CELL_TILE) continue;
      const o = nc * PARAMS;
      const g = this.cellParams[o];
      const values = this.evalValues;
      for (let k = 0; k < PARAMS - 1; k++) values[k] = this.cellParams[o + 1 + k];
      const txa = dx > 0 ? ppt - band : 0;
      const txb = dx < 0 ? band : ppt;
      const tya = dy > 0 ? ppt - band : 0;
      const tyb = dy < 0 ? band : ppt;
      for (let ty = tya; ty < tyb; ty++) {
        // In the NEIGHBOUR's frame: it lies dx east / dy south of this cell.
        const v = 1 - (ty + 0.5) / ppt + dy;
        const row = ((j * ppt + ty) * n + i * ppt) * CH;
        for (let tx = txa; tx < txb; tx++) {
          const u = (tx + 0.5) / ppt - dx;
          const e = this.encode(roundedUnionSignedPacked(u, v, values, g));
          if (e > data[row + tx * CH]) data[row + tx * CH] = e;
        }
      }
    }
  }

  /**
   * Re-bake the cut-out channel: clear what was there (its bounding box
   * only), then evaluate every pushed tile over its own texel rectangle plus
   * a small fringe, max-combined — a tile's field extended past its square is
   * a lower bound of the union's, so the max over tiles (and over the two
   * levels of a transition) is the union. `windowMoved` clears the whole
   * channel first. @returns true if G was touched.
   */
  private bakeCutout(windowMoved: boolean): boolean {
    this.cutDirty = false;
    if (Number.isNaN(this.x0)) return false;
    const n = this.size;
    const data = this.data;
    const box = this.cutBox;
    const had = box.x0 <= box.x1;
    if (windowMoved) {
      // The texels were shifted with the window: the old box is meaningless.
      for (let k = 1, end = n * n * CH; k < end; k += CH) data[k] = 0;
    } else if (had) {
      for (let ty = box.y0; ty <= box.y1; ty++) {
        const row = ty * n;
        for (let k = (row + box.x0) * CH + 1, end = (row + box.x1) * CH + 1; k <= end; k += CH) data[k] = 0;
      }
    }
    box.x0 = 1; box.y0 = 1; box.x1 = 0; box.y1 = 0;
    if (this.cutTiles.length === 0) return had;

    const rect = this.uniforms.uCoverageRect.value;
    const texel = 1 / (rect.z * n); // scene metres per texel
    const k255 = 255 / (CUT_HI - CUT_LO);
    const vals = this.evalValues;
    for (const t of this.cutTiles) {
      if (!(t.g > 0)) continue;
      const w = tileWorldRect(this.projection, t.z, t.x, t.y);
      const tile = w.xMax - w.xMin;
      const depth = w.zMax - w.zMin;
      const txa = Math.max(0, Math.floor((w.xMin - rect.x) / texel) - CUT_FRINGE_TEXELS);
      const txb = Math.min(n - 1, Math.ceil((w.xMax - rect.x) / texel) + CUT_FRINGE_TEXELS);
      const tya = Math.max(0, Math.floor((w.zMin - rect.y) / texel) - CUT_FRINGE_TEXELS);
      const tyb = Math.min(n - 1, Math.ceil((w.zMax - rect.y) / texel) + CUT_FRINGE_TEXELS);
      if (txa > txb || tya > tyb) continue;
      const square = t.square;
      const invRamp = 1 / (2 * Math.max(square ? 0 : this.cutFeather, 1e-3));
      if (!square) for (let k = 0; k < PARAMS - 1; k++) vals[k] = t.values[k];
      for (let ty = tya; ty <= tyb; ty++) {
        // Rows run SOUTH (+z); the union frame's v runs north.
        const v = 1 - (rect.y + (ty + 0.5) * texel - w.zMin) / depth;
        const row = ty * n;
        for (let tx = txa; tx <= txb; tx++) {
          const u = (rect.x + (tx + 0.5) * texel - w.xMin) / tile;
          const s = square
            ? Math.min(u, 1 - u, v, 1 - v)
            : roundedUnionSignedPacked(u, v, vals, t.g);
          const ramp = s * invRamp;
          const e = ((ramp > t.cap ? t.cap : ramp) - CUT_LO) * k255;
          const b = e <= 0 ? 0 : e >= 255 ? 255 : Math.round(e);
          const at = (row + tx) * CH + 1;
          if (b > data[at]) data[at] = b;
        }
      }
      if (box.x0 > box.x1) { box.x0 = txa; box.x1 = txb; box.y0 = tya; box.y1 = tyb; }
      else {
        if (txa < box.x0) box.x0 = txa;
        if (txb > box.x1) box.x1 = txb;
        if (tya < box.y0) box.y0 = tya;
        if (tyb > box.y1) box.y1 = tyb;
      }
    }
    this.cutBakeCount++;
    return true;
  }
}
