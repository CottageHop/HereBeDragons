/**
 * Level-of-detail maths for the splat TILE PYRAMID. Pure — no THREE, no DOM.
 *
 * Splat tiles are authored as a pyramid: the finest level (z16 by default)
 * carries the full-detail surfels, and every coarser level merges its four
 * children and thins them back to the SAME per-tile splat budget. The overlay
 * keeps its window a fixed number of TILES wide whatever the level, so the
 * tiles on screen — and with them the resident splats, the sort and the fill
 * cost — stay roughly constant from street level out to the whole town. That
 * is the "dynamic quality": the level follows the camera, the cost does not.
 */

/** Half-width of the dead band around each level boundary, in zoom units. */
export const LOD_HYSTERESIS = 0.15;

export interface TileLodParams {
  /** Coarsest pyramid level that exists. */
  minTileZoom: number;
  /** Finest pyramid level that exists. */
  maxTileZoom: number;
  /** Added to the camera zoom before flooring (−1 = one level coarser). */
  lodBias: number;
  /** Dead band half-width; default `LOD_HYSTERESIS`. */
  hysteresis?: number;
}

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Tile level for a camera zoom:
 *
 *   tileZ = clamp(floor(cameraZoom + lodBias), minTileZoom, maxTileZoom)
 *
 * with hysteresis: coming from level `prev`, the level only goes FINER once
 * `cameraZoom + lodBias` has passed the boundary by `hysteresis`, and only
 * goes COARSER once it has dropped `hysteresis` below it — so a camera parked
 * on a boundary (or a pinch jittering across it) doesn't flap between two
 * levels, each flap costing a window's worth of fetches. `prev = null` (or a
 * `prev` outside the bounds, after they were changed) selects without it.
 */
export function selectTileZoom(cameraZoom: number, prev: number | null, p: TileLodParams): number {
  const lo = Math.min(p.minTileZoom, p.maxTileZoom);
  const hi = Math.max(p.minTileZoom, p.maxTileZoom);
  const v = cameraZoom + p.lodBias;
  if (prev === null || prev < lo || prev > hi) return clampInt(Math.floor(v), lo, hi);
  const h = p.hysteresis ?? LOD_HYSTERESIS;
  const finer = clampInt(Math.floor(v - h), lo, hi);
  if (finer > prev) return finer;
  const coarser = clampInt(Math.floor(v + h), lo, hi);
  if (coarser < prev) return coarser;
  return prev;
}

/** Ground metres covered by one tile of level `z` at latitude `lat`. */
export function tileGroundMeters(z: number, latDeg: number): number {
  const EQUATOR_M = 40075016.686;
  return (EQUATOR_M * Math.cos((latDeg * Math.PI) / 180)) / Math.pow(2, Math.max(z, 0));
}

/** Ground metres per pixel of a tile's imagery ground plane. */
export function tileImageryMpp(z: number, latDeg: number, imagePx: number): number {
  return tileGroundMeters(z, latDeg) / Math.max(imagePx, 1);
}

/**
 * How much finer the ground is at the NEAR edge of a tilted view than at the camera target.
 *
 * `getMetersPerPixel()` reports at the target, but under tilt the bottom of the screen is much
 * closer to the camera and therefore shows finer ground detail. Choosing a level from the target
 * alone leaves that near field under-resolved (visibly soft). For a camera at height `h`, a ray
 * making angle `b` with the ground plane meets it at distance `h / sin(b)`; the view axis has
 * `b = 90 - tilt` and the bottom-of-frame ray `b = 90 - tilt + fov/2`, so the near edge sits at
 * `cos(tilt) / cos(tilt - fov/2)` of the target's distance — and perspective scale is linear in
 * distance. Returns 1 looking straight down, falling toward ~0.5 at extreme tilt.
 *
 * The raw factor is SOFTENED by `blend` (default 0.5, i.e. its square root) because one level
 * serves the whole window: sizing it for the near edge alone over-serves the far field, and since
 * levels step by 2x a 1.4x near-field requirement would otherwise buy a full level — measured,
 * that cost 4x the splats and three quarters of the satellite coverage for a modest gain. The
 * blended value is the compromise; per-TILE level selection (near tiles finer, far tiles coarser)
 * is the real fix and is not implemented.
 */
export function nearEdgeMppFactor(tiltDeg: number, fovDeg = 50, blend = 0.5): number {
  const t = (Math.min(Math.max(tiltDeg, 0), 89) * Math.PI) / 180;
  const half = (Math.min(Math.max(fovDeg, 1), 170) * Math.PI) / 360;
  const denom = Math.cos(Math.max(t - half, 0));
  if (!(denom > 1e-6)) return 1;
  const raw = Math.min(1, Math.max(Math.cos(t) / denom, 0.25));
  return Math.pow(raw, Math.min(Math.max(blend, 0), 1));
}

export interface ResolutionLodParams extends TileLodParams {
  /** Pixel size of a tile's ground image (the satellite texture). */
  imagePx: number;
  /** Latitude, for the ground size of a tile. */
  latDeg: number;
  /**
   * How much finer than the screen the imagery must be. 1 = exactly matched, 0.5 = 2x
   * oversampled (the default: a tilted view foreshortens the ground, so some headroom keeps the
   * near field crisp).
   */
  margin: number;
}

/**
 * Pick the COARSEST pyramid level whose imagery still out-resolves the screen.
 *
 * The fixed-bias rule (`selectTileZoom`) keys off camera zoom alone, so it can load far finer
 * tiles than anything can show: measured on this map at camera zoom 14.6 the screen shows
 * 5.16 m per pixel while a level-16 tile's imagery is 0.49 m per pixel — 10x finer than the
 * display, at 16x the tiles for the same ground. Matching the level to the screen instead keeps
 * the picture identical (the imagery is still oversampled by `margin`) and spends the splat
 * budget on AREA rather than on invisible detail. At the zoom cap both rules agree.
 *
 * `screenMpp` is the map's own metres-per-pixel at the camera target.
 */
export function selectTileZoomByResolution(
  screenMpp: number,
  prev: number | null,
  p: ResolutionLodParams
): number {
  const lo = Math.min(p.minTileZoom, p.maxTileZoom);
  const hi = Math.max(p.minTileZoom, p.maxTileZoom);
  if (!(screenMpp > 0) || !Number.isFinite(screenMpp)) return clampInt(prev ?? hi, lo, hi);
  const want = (mpp: number): number => {
    for (let z = lo; z <= hi; z++) if (tileImageryMpp(z, p.latDeg, p.imagePx) <= mpp * p.margin) return z;
    return hi;
  };
  // NOTE: `lodBias` is deliberately NOT applied here. It biases the camera-zoom rule; in
  // resolution mode the detail policy IS `margin` (halve it for one level finer), and adding
  // both would silently cancel the point of matching the screen.
  const biased = (mpp: number): number => clampInt(want(mpp), lo, hi);
  if (prev === null || prev < lo || prev > hi) return biased(screenMpp);
  // Hysteresis in resolution space: the threshold must be crossed by `h` in log2 terms before
  // the level flips, so a camera parked on a boundary does not oscillate.
  const h = p.hysteresis ?? LOD_HYSTERESIS;
  // Pretend the screen is COARSER when testing a move to a finer level (and vice versa), so the
  // threshold must be crossed by `h` before the level flips.
  const finer = biased(screenMpp * Math.pow(2, h));
  if (finer > prev) return finer;
  const coarser = biased(screenMpp * Math.pow(2, -h));
  if (coarser < prev) return coarser;
  return prev;
}

/**
 * Levels to try for a wanted level, in order: the level itself, then every
 * FINER one up to `maxTileZoom` (same data, just more of it), then every
 * coarser one down to `minTileZoom`. The layer walks this when the whole
 * window of a level turned out to be 404 — a tile set that ships only part
 * of the pyramid (say z16 alone) still shows something at every camera zoom.
 */
export function lodFallbackOrder(wanted: number, minTileZoom: number, maxTileZoom: number): number[] {
  const out = [wanted];
  for (let z = wanted + 1; z <= maxTileZoom; z++) out.push(z);
  for (let z = wanted - 1; z >= minTileZoom; z--) out.push(z);
  return out;
}

/** Inclusive tile range `[x0..x1] × [y0..y1]`. */
export interface TileRange {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The tiles of level `targetZ` that overlap tile `z/x/y`: its one ancestor
 * when `targetZ` is coarser, the square of its descendants when finer (and
 * the tile itself at the same level).
 */
export function tileCoverRange(z: number, x: number, y: number, targetZ: number): TileRange {
  if (targetZ <= z) {
    const d = 2 ** (z - targetZ);
    const px = Math.floor(x / d);
    const py = Math.floor(y / d);
    return { x0: px, y0: py, x1: px, y1: py };
  }
  const d = 2 ** (targetZ - z);
  return { x0: x * d, y0: y * d, x1: (x + 1) * d - 1, y1: (y + 1) * d - 1 };
}

/**
 * Squared distance from a point to a tile's centre, both in NORMALISED
 * mercator units (the whole world = 1), so tiles of different levels rank on
 * one scale. `(cx, cy)` is the point as fractional tile coordinates at z0.
 */
export function tileCentreDist2(z: number, x: number, y: number, cx: number, cy: number): number {
  const n = 2 ** z;
  const dx = (x + 0.5) / n - cx;
  const dy = (y + 0.5) / n - cy;
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------
// Screen-space relevance — where the budget should be spent
// ---------------------------------------------------------------------------

/**
 * The camera as the tile ranking needs it, in NORMALISED mercator units (the
 * whole world = 1, x east, y SOUTH — tile coordinates at z0).
 */
export interface ViewFrame {
  /** The point the camera looks at. */
  cx: number;
  cy: number;
  /** Camera-to-target distance, same units. */
  dist: number;
  /** Degrees from north as `CameraView.bearing` reports it. */
  bearingDeg: number;
  /** Degrees from straight down. */
  tiltDeg: number;
  /** Vertical field of view, degrees. Default 50 (the map camera's). */
  fovDeg?: number;
  /** Viewport width / height. Default 1.6. */
  aspect?: number;
}

/** Added to the score of a tile whose centre is outside the view. */
export const OFFSCREEN_PENALTY = 1e3;
/** Slack (in half screen heights) on the on-screen test. */
const ONSCREEN_MARGIN = 0.1;

/**
 * How little a tile matters to the picture — LOWER is more relevant. It is
 * the squared distance of the tile centre's PROJECTION from the screen centre
 * (in units of the half screen height), so:
 *
 *  - looking straight down it is the squared ground distance from the view
 *    centre (scaled) — the old nearest-first order, but measured from where
 *    the camera actually looks rather than from the centre TILE, so with a
 *    four-tile budget the 2×2 block around the view centre wins instead of an
 *    arbitrary plus-shape;
 *  - tilted, perspective does the weighting: ground BEYOND the target is
 *    foreshortened (many tiles squeeze into the top of the screen — each
 *    matters, and scores low), ground toward the camera is magnified, and
 *    tiles beside or BEHIND the camera project off screen or not at all.
 *
 * A tile counts as on screen while any of it can be (its projected half-size
 * is allowed for — up close a tile is wider than the view). Tiles wholly off
 * screen, or behind the camera, are ranked after every on-screen one, among
 * themselves by ground distance, so the window still fills — last — when the
 * budget allows.
 */
export function tileScreenRelevance(z: number, x: number, y: number, f: ViewFrame): number {
  const n = 2 ** z;
  // Score the tile by its point NEAREST the camera target, not by its centre. Perspective
  // compresses distant ground, so by centres the tiles AHEAD of the target look closer to the
  // screen centre than the tile the target is actually in — with a tight budget the tile under
  // the crosshair lost to the row in front of it. With the nearest point, the tile containing
  // the target scores exactly 0 and always ranks first; neighbours follow by how close their
  // nearest edge is on screen.
  const dx = Math.min(Math.max(f.cx, x / n), (x + 1) / n) - f.cx;
  const dy = Math.min(Math.max(f.cy, y / n), (y + 1) / n) - f.cy;
  // Off-screen tiles keep ranking among themselves by CENTRE distance (stable, monotonic).
  const cdx = (x + 0.5) / n - f.cx;
  const cdy = (y + 0.5) / n - f.cy;
  const d2 = cdx * cdx + cdy * cdy;
  const dist = Math.max(f.dist, 1e-12);
  const b = (f.bearingDeg * Math.PI) / 180;
  const t = (Math.min(Math.max(f.tiltDeg, 0), 89) * Math.PI) / 180;
  // The camera sits at target + D·sin(tilt)·(sin b, cos b) in (east, south),
  // so it looks along (−sin b, −cos b); its right-hand side is (cos b, −sin b).
  const along = -dx * Math.sin(b) - dy * Math.cos(b);
  const side = dx * Math.cos(b) - dy * Math.sin(b);
  // Camera space: depth along the view axis, height on screen.
  const depth = along * Math.sin(t) + dist;
  const up = along * Math.cos(t);
  const tanY = Math.tan((((f.fovDeg ?? 50) / 2) * Math.PI) / 180);
  const offscreen = OFFSCREEN_PENALTY + d2 / (dist * dist);
  if (depth <= dist * 0.02) return offscreen; // beside / behind the camera
  const sx = side / (depth * tanY);
  const sy = up / (depth * tanY);
  // Half a tile (its half-diagonal, whatever the bearing) as seen at that depth.
  const half = (Math.SQRT1_2 / n) / (depth * tanY);
  const limX = (f.aspect ?? 1.6) + half + ONSCREEN_MARGIN;
  const limY = 1 + half + ONSCREEN_MARGIN;
  if (Math.abs(sx) > limX || Math.abs(sy) > limY) return offscreen;
  return sx * sx + sy * sy;
}

/**
 * Where the tile window should be centred: the camera target pushed FORWARD
 * along the view direction by half the camera's ground offset
 * (`½·D·sin(tilt)`). Looking straight down that is the target itself; tilted,
 * the visible ground reaches far beyond the target but barely behind it, so a
 * window centred on the target would spend a row of tiles under (and behind)
 * the camera. Returns normalised mercator coordinates.
 */
export function viewFocus(f: ViewFrame, maxShift = Infinity): { x: number; y: number } {
  const b = (f.bearingDeg * Math.PI) / 180;
  const t = (Math.min(Math.max(f.tiltDeg, 0), 89) * Math.PI) / 180;
  // `maxShift` (same units as `cx`) caps the push so the window always still CONTAINS the
  // camera target: with a small window (radius 1) an uncapped push of ~1.5 tiles at zoom 15 /
  // tilt 45 left the tile under the screen centre outside the window, so tiles appeared
  // off-centre and jumped as the map panned. Callers pass `(radius − 1)` tiles.
  const shift = Math.min(0.5 * f.dist * Math.sin(t), Math.max(maxShift, 0));
  return { x: f.cx - Math.sin(b) * shift, y: f.cy - Math.cos(b) * shift };
}

/**
 * Order a level's window by relevance, most relevant first (ties: nearest
 * the view centre, then by y / x so the order is total and stable).
 */
/** A load candidate that carries its OWN level, so a mixed-level cut can be ranked as one list. */
export interface RankCell {
  z: number;
  x: number;
  y: number;
}

/**
 * Rank candidates that may sit at DIFFERENT levels, most relevant first.
 *
 * `tileScreenRelevance` already works in normalized mercator, so scores from different levels are
 * directly comparable — a coarse tile is simply a bigger patch of the same space, and its score is
 * the distance to its nearest point exactly as for a fine one. The tie-breaks then prefer the FINER
 * level, so when a coarse cell and one of its own children score equally (they touch the same
 * nearest point) the detailed tile is fetched first and the coarse one fills in behind it.
 */
export function rankCellsByRelevance(cells: ReadonlyArray<RankCell>, f: ViewFrame): RankCell[] {
  const scored = cells.map((c) => ({
    c,
    s: tileScreenRelevance(c.z, c.x, c.y, f),
    d: tileCentreDist2(c.z, c.x, c.y, f.cx, f.cy)
  }));
  scored.sort((a, b) => a.s - b.s || a.d - b.d || b.c.z - a.c.z || a.c.y - b.c.y || a.c.x - b.c.x);
  return scored.map((e) => e.c);
}

export function rankTilesByRelevance(
  z: number,
  tiles: ReadonlyArray<readonly [number, number]>,
  f: ViewFrame
): Array<[number, number]> {
  const scored = tiles.map(([x, y]) => ({
    x, y,
    s: tileScreenRelevance(z, x, y, f),
    d: tileCentreDist2(z, x, y, f.cx, f.cy)
  }));
  scored.sort((a, b) => a.s - b.s || a.d - b.d || a.y - b.y || a.x - b.x);
  return scored.map((c) => [c.x, c.y]);
}

/**
 * Polygon-offset bias for a tile's imagery ground, in offset units (negative = toward the camera).
 *
 * The bias exists so that, while two pyramid levels cross-fade on the same plane, the FINER one
 * wins the depth test. Only the DIFFERENCE between the levels on screen matters for that, so it is
 * measured from the coarsest level currently resident and is ZERO when a single level is shown.
 *
 * It used to be `-perLevel * z`: -32 at zoom 16, applied to the slope-scaled factor. Splats depth-
 * test against the ground, and a slope-scaled offset of 32 hides everything within about 32 screen
 * pixels behind it -- which is the bottom of every wall. Buildings looked cut off above the ground
 * although their surfels were sampled all the way down to z = 0.
 */
export function groundDepthBias(z: number, coarsestResidentZ: number, perLevel = 2): number {
  const levels = Math.max(0, z - coarsestResidentZ);
  return levels === 0 ? 0 : -perLevel * levels;
}
