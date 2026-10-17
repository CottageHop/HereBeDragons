/**
 * The quadtree CUT: which ground to load, and at what level, when the far field may go coarser.
 *
 * NOT CURRENTLY USED. The layer was wired to this and the result was measured and rejected — see
 * docs/per-tile-lod.md for the numbers and the reason. Kept because it is correct and tested, and
 * because anyone reattempting per-tile level selection needs exactly this plus the two findings
 * recorded alongside it (the hysteresis sign, and that `isInKeepZone` tests `radius + 1` at each
 * tile's OWN level, which is what made subdivided cells unadmittable).
 *
 * The window is enumerated at the COARSEST level in play and a cell is subdivided when it is near
 * enough to deserve something finer. That ordering matters: it is what extends the window's ground
 * REACH (radius cells at `zNear - maxLevelDrop` covers 2^maxLevelDrop times the linear ground of
 * radius cells at `zNear`), which is the only thing per-tile selection is actually for — the near
 * field is already served well by the single-level window plus a grown budget.
 *
 * A cut has the property the whole tile lifecycle depends on: every point of ground inside the
 * window is covered by EXACTLY ONE emitted tile. That falls out of the recursion — a cell is
 * either emitted or replaced by its four children, never both — rather than being checked for.
 *
 * Pure: the caller supplies distances, so this is unit-tested without a camera or a scene.
 */

export interface CutCell {
  z: number;
  x: number;
  y: number;
}

export interface CutParams {
  /** Finest level in play — what the camera-zoom (or resolution) rule asks for. */
  zNear: number;
  /** Never go coarser than this. */
  minTileZoom: number;
  /** Most levels the far field may drop below `zNear`. */
  maxLevelDrop: number;
  /** Distance (scene metres) at which the first level drop happens. 0 disables the cut. */
  dropDistance: number;
  /**
   * Dead band, in log2(distance). A cell must cross its threshold by this much before changing
   * level. Applied to the DISTANCE, never to the resulting level: rounding a level and then adding
   * hysteresis to it lets a cell sitting on a boundary flip every frame as the camera drifts.
   */
  hysteresis: number;
}

/** Key for the sticky level map — a cell is identified by its ground, so level is not part of it. */
export const cellKey = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

/**
 * Level a cell at distance `d` deserves: one level coarser per doubling of distance past `d0`.
 * Ground sampled per screen pixel is linear in distance and levels step by 2x, so halving the
 * level each time the distance doubles is the matching law.
 */
export function levelForDistance(d: number, p: CutParams): number {
  const floor = Math.max(p.minTileZoom, p.zNear - p.maxLevelDrop);
  if (!(p.dropDistance > 0) || !Number.isFinite(d) || d <= p.dropDistance) return p.zNear;
  const drop = Math.floor(Math.log2(d / p.dropDistance)) + 1;
  return Math.max(floor, p.zNear - drop);
}

/**
 * Build the cut.
 *
 * `cells` are the coarsest-level cells to start from (the window at `zNear - maxLevelDrop`).
 * `distanceOf` gives the camera distance to a cell's centre in scene metres. `sticky` carries the
 * previous level chosen for each cell so the hysteresis has something to be sticky about; it is
 * updated in place, and cells that no longer appear are pruned by the caller.
 */
export function quadtreeCut(
  cells: CutCell[],
  distanceOf: (z: number, x: number, y: number) => number,
  p: CutParams,
  sticky?: Map<string, number>
): CutCell[] {
  const floor = Math.max(p.minTileZoom, p.zNear - p.maxLevelDrop);
  const out: CutCell[] = [];
  if (!(p.dropDistance > 0)) {
    // Cut disabled: the window is whatever the caller passed, at the finest level.
    return cells.map((c) => ({ ...c }));
  }

  const wanted = (z: number, x: number, y: number): number => {
    const d = distanceOf(z, x, y);
    const raw = levelForDistance(d, p);
    if (!sticky || p.hysteresis <= 0) return raw;
    const prev = sticky.get(cellKey(z, x, y));
    if (prev === undefined) return raw;
    // Re-ask with the distance nudged AGAINST the change being considered, so a change only
    // happens when the threshold is crossed by the whole band:
    //   - to go FINER, pretend the cell is FURTHER than it is (d x 2^+h). If it still wants finer
    //     from there, it has genuinely come closer — not just jittered over the line.
    //   - to go COARSER, pretend it is NEARER (d x 2^-h), symmetrically.
    // Nudging the other way makes each change EASIER, which is the opposite of hysteresis and
    // lets a cell parked on a boundary flip on every frame.
    const finer = levelForDistance(d * Math.pow(2, p.hysteresis), p);
    if (finer > prev) return finer;
    const coarser = levelForDistance(d * Math.pow(2, -p.hysteresis), p);
    if (coarser < prev) return coarser;
    return prev;
  };

  const emit = (z: number, x: number, y: number): void => {
    if (z >= p.zNear) {
      out.push({ z, x, y });
      return;
    }
    const want = wanted(z, x, y);
    sticky?.set(cellKey(z, x, y), want);
    if (want <= z) {
      out.push({ z, x, y });
      return;
    }
    // Subdivide: the four children together cover exactly this cell's ground.
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) emit(z + 1, x * 2 + dx, y * 2 + dy);
    }
  };

  for (const c of cells) emit(Math.max(c.z, floor), c.x, c.y);
  return out;
}

/** Metres of ground per 1.0 of normalized mercator at `latDeg`. */
const EQUATOR_M = 40075016.686;

/**
 * Distance from the CAMERA to a cell's centre, in ground metres.
 *
 * `ViewFrame` works in normalized mercator (the whole world is 1.0) and reports the camera by its
 * target plus a distance and angles, so this reconstructs the camera's own position using the same
 * convention `tileScreenRelevance` uses — camera at `target + D·sin(tilt)·(sin b, cos b)`, height
 * `D·cos(tilt)` — and measures in 3D. Ground distance alone would call a cell directly below a
 * high camera "near", which is exactly backwards for choosing detail.
 */
export function cellDistanceMeters(
  z: number,
  x: number,
  y: number,
  f: { cx: number; cy: number; dist: number; bearingDeg: number; tiltDeg: number },
  latDeg: number
): number {
  const n = 2 ** z;
  const b = (f.bearingDeg * Math.PI) / 180;
  const t = (Math.min(Math.max(f.tiltDeg, 0), 89) * Math.PI) / 180;
  const camX = f.cx + f.dist * Math.sin(t) * Math.sin(b);
  const camY = f.cy + f.dist * Math.sin(t) * Math.cos(b);
  const camH = f.dist * Math.cos(t);
  const dx = (x + 0.5) / n - camX;
  const dy = (y + 0.5) / n - camY;
  const perMetre = EQUATOR_M * Math.cos((latDeg * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy + camH * camH) * perMetre;
}
