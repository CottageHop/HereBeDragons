/**
 * Pure maths for the "rounded union" tile mask shared by the splat overlay
 * and the vector basemap's tile reveal. No THREE, no DOM — the same formulas
 * are mirrored on the GPU (a Spark dyno `objectModifier` for the splats, GLSL
 * in the imagery-ground material) or baked on the CPU into a coverage texture
 * (`tiles/CoverageField.ts`, the basemap), and unit-tested here.
 *
 * Loaded tiles must not read as hard squares. The visible region is the
 * morphological OPENING of the union of loaded tile squares with a disc of
 * radius half a tile — "like a Bootstrap button group": one tile shows as a
 * circle, two edge-adjacent tiles as a pill (stadium) with the shared side
 * fully joined, a complete 2×2 block as a rounded square. Outer corners are
 * always rounded, interior joins are seamless.
 *
 * Everything is evaluated per tile in its normalised local frame
 * p = (u, v) ∈ [0,1]² (u east, v north), centre c = (0.5, 0.5), radius
 * r = 0.5. The opening is "every point within r of the eroded set E", and
 * with r = half a tile E is simply
 *
 *   - every loaded tile's centre point,
 *   - the segment between the centres of two edge-adjacent loaded tiles,
 *   - the filled square between the four centres of a complete 2×2 block,
 *
 * so the distance to E needs only this tile's 8 neighbour weights. Weights
 * are in [0,1] (1 = neighbour resident and revealed) and SCALE the segment /
 * box that reaches toward the neighbour, so a join grows out rather than
 * popping; the tile's own growth `g` scales the radius, so a new tile grows
 * from its centre.
 *
 * A point on a shared side is evaluated by BOTH tiles (A's east segment, B's
 * west segment); with symmetric weights the two agree exactly, which is what
 * makes the seam invisible.
 */

/** Disc radius of the opening, in tile units (half a tile). */
export const UNION_RADIUS = 0.5;
/** Default soft-edge half-width, in tile units (≈ 18 m on a z16 tile). */
export const DEFAULT_UNION_FEATHER = 0.03;
/** Default grow-in length (tile growth and neighbour bridges), ms. */
export const DEFAULT_UNION_GROW_MS = 700;
/** Shrink-out length when a tile drifts out of the keep zone, ms. */
export const UNION_LEAVE_MS = 300;
/** A bridge toward a newly landed tile starts once its growth passes this. */
export const UNION_BRIDGE_START_G = 0.6;

/** Neighbour weights of one tile, each in [0,1]. */
export interface UnionWeights {
  e: number;
  w: number;
  n: number;
  s: number;
  ne: number;
  nw: number;
  se: number;
  sw: number;
}

export const NO_NEIGHBOURS: Readonly<UnionWeights> = Object.freeze({
  e: 0, w: 0, n: 0, s: 0, ne: 0, nw: 0, se: 0, sw: 0
});

export const ALL_NEIGHBOURS: Readonly<UnionWeights> = Object.freeze({
  e: 1, w: 1, n: 1, s: 1, ne: 1, nw: 1, se: 1, sw: 1
});

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
const clamp01 = (x: number): number => clamp(x, 0, 1);

/** Distance from `(qx, qy)` to the box `[0,w]²` (a point when `w` = 0). */
function boxDistance(qx: number, qy: number, w: number): number {
  const dx = Math.max(Math.max(-qx, qx - w), 0);
  const dy = Math.max(Math.max(-qy, qy - w), 0);
  return Math.hypot(dx, dy);
}

/**
 * Distance (tile units) from `p = (u, v)` to this tile's share of the eroded
 * set: its centre, the four weight-scaled segments toward the edge
 * neighbours, and the four weight-scaled boxes toward the diagonal blocks.
 * A block only counts as far as its two edges do: its effective weight is
 * `min(edgeA, edgeB, diagonal)`.
 */
export function roundedUnionDistance(u: number, v: number, w: UnionWeights): number {
  const qx = u - 0.5;
  const qy = v - 0.5;
  // Segment toward a neighbour: t = clamp(q·axis, 0, weight). The E and W
  // segments share the centre, so min(dE, dW) is one clamp over [−wW, wE]
  // (that is the form the GPU twins use); likewise N / S.
  const dE = Math.hypot(qx - clamp(qx, 0, w.e), qy);
  const dW = Math.hypot(qx + clamp(-qx, 0, w.w), qy);
  const dN = Math.hypot(qx, qy - clamp(qy, 0, w.n));
  const dS = Math.hypot(qx, qy + clamp(-qy, 0, w.s));
  let d = Math.min(Math.hypot(qx, qy), dE, dW, dN, dS);
  const ne = Math.min(w.e, w.n, w.ne);
  const nw = Math.min(w.w, w.n, w.nw);
  const se = Math.min(w.e, w.s, w.se);
  const sw = Math.min(w.w, w.s, w.sw);
  if (ne > 0) d = Math.min(d, boxDistance(qx, qy, ne));
  if (nw > 0) d = Math.min(d, boxDistance(-qx, qy, nw));
  if (se > 0) d = Math.min(d, boxDistance(qx, -qy, se));
  if (sw > 0) d = Math.min(d, boxDistance(-qx, -qy, sw));
  return d;
}

/**
 * Signed edge value, positive inside the rounded union. With every
 * neighbour at least as grown as this tile it is exactly `r·g − d`
 * (`d = roundedUnionDistance`). `ng` carries the NEIGHBOURS' growths (default
 * all 1): a bridge is only as thick as the thinner of the two tiles it joins
 * (radius `r·min(g, g_neighbour)`; a 2×2 block: the min over its four
 * tiles), so
 *
 *   s = max( r·g − d0,  r·min(g, gE) − dE, …,  r·min(g, gE, gN, gNE) − dNE, … )
 *
 * Without this, a fully grown tile would draw a full-width bridge toward a
 * neighbour that is still a small circle; the half of that bridge's round
 * cap lying inside the NEIGHBOUR's square is nobody's to draw, so the bridge
 * would end in a hard straight cut along the shared side. With it the two
 * tiles evaluate mirror-image capsules and agree along the side at every
 * instant of the animation, not just at rest.
 */
export function roundedUnionSigned(
  u: number,
  v: number,
  w: UnionWeights,
  g = 1,
  ng: UnionWeights = ALL_NEIGHBOURS
): number {
  const qx = u - 0.5;
  const qy = v - 0.5;
  const r = UNION_RADIUS;
  let s = r * g - Math.hypot(qx, qy);
  const seg = (along: number, perp: number, weight: number, gn: number): void => {
    s = Math.max(s, r * Math.min(g, gn) - Math.hypot(along - clamp(along, 0, weight), perp));
  };
  seg(qx, qy, w.e, ng.e);
  seg(-qx, qy, w.w, ng.w);
  seg(qy, qx, w.n, ng.n);
  seg(-qy, qx, w.s, ng.s);
  const box = (mx: number, my: number, weight: number, gn: number): void => {
    if (weight > 0) s = Math.max(s, r * Math.min(g, gn) - boxDistance(mx, my, weight));
  };
  box(qx, qy, Math.min(w.e, w.n, w.ne), Math.min(ng.e, ng.n, ng.ne));
  box(-qx, qy, Math.min(w.w, w.n, w.nw), Math.min(ng.w, ng.n, ng.nw));
  box(qx, -qy, Math.min(w.e, w.s, w.se), Math.min(ng.e, ng.s, ng.se));
  box(-qx, -qy, Math.min(w.w, w.s, w.sw), Math.min(ng.w, ng.s, ng.sw));
  return s;
}

/**
 * `roundedUnionSigned()` over the packed 16-value layout of
 * `unionTileValues()` (weights E, W, N, S, NE, NW, SE, SW, then the eight
 * neighbour growths). Same result — also for points outside the tile's own
 * square — but allocation-free and with 4 square roots instead of 9: the
 * basemap's coverage field evaluates it per texel on the CPU, thousands of
 * times a frame while tiles stream in.
 *
 * Only the pieces of the point's own quadrant can win. Say `qx ≥ 0`: the W
 * segment's nearest point is then the centre, so it is the centre disc with a
 * radius no larger — dominated. A box on the W side is nearest along its
 * `x = 0` side, which is part of the N (or S) segment, whose weight and
 * radius are both at least the box's — dominated too. That leaves the disc,
 * one horizontal segment, one vertical segment and one box.
 */
export function roundedUnionSignedPacked(
  u: number,
  v: number,
  vals: ArrayLike<number>,
  g: number
): number {
  const qx = u - 0.5;
  const qy = v - 0.5;
  const r = UNION_RADIUS;
  const ie = qx >= 0 ? 0 : 1; // E : W
  const is = qy >= 0 ? 0 : 1; // N : S
  const ax = ie === 0 ? qx : -qx;
  const ay = is === 0 ? qy : -qy;
  const wx = vals[ie];
  const wy = vals[2 + is];
  let gx = vals[8 + ie];
  let gy = vals[10 + is];
  if (g < gx) gx = g;
  if (g < gy) gy = g;
  const ax2 = ax * ax;
  const ay2 = ay * ay;
  let s = r * g - Math.sqrt(ax2 + ay2);
  // Segment along x: nearest point clamp(ax, 0, wx) on the axis.
  let d = ax > wx ? ax - wx : 0;
  let t = r * gx - (d === 0 ? ay : Math.sqrt(d * d + ay2));
  if (t > s) s = t;
  d = ay > wy ? ay - wy : 0;
  t = r * gy - (d === 0 ? ax : Math.sqrt(ax2 + d * d));
  if (t > s) s = t;
  // The quadrant's block: the box [0, w]², only as far as its two edges go.
  const k = ie + 2 * is;
  let w = vals[4 + k];
  if (wx < w) w = wx;
  if (wy < w) w = wy;
  if (w > 0) {
    let gn = vals[12 + k];
    if (gx < gn) gn = gx;
    if (gy < gn) gn = gy;
    const dx = ax > w ? ax - w : 0;
    const dy = ay > w ? ay - w : 0;
    t = r * gn - (dx === 0 ? dy : dy === 0 ? dx : Math.sqrt(dx * dx + dy * dy));
    if (t > s) s = t;
  }
  return s;
}

/** GLSL `smoothstep`. A zero-width edge degenerates to a step. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x > edge0 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Mask in [0,1] — the splat scale / opacity factor and the imagery ground's
 * alpha. The soft edge is `2·feather` wide and lies wholly INSIDE the shape
 * (`smoothstep(0, 2·feather, s)`, i.e. the ±feather ramp shifted in by one
 * feather): a pill's straight sides run along the tile's own boundary, where
 * the tile's geometry simply ends, so a ramp centred on the boundary would be
 * cut off at 50 % there and read as a hard line beside the soft round caps.
 */
export function roundedUnionMask(
  u: number,
  v: number,
  w: UnionWeights,
  g = 1,
  feather = DEFAULT_UNION_FEATHER,
  ng: UnionWeights = ALL_NEIGHBOURS
): number {
  return smoothstep(0, 2 * feather, roundedUnionSigned(u, v, w, g, ng));
}

/**
 * GLSL twin of `roundedUnionMask()` — the ONE source both GPU consumers
 * compile (the imagery-ground fragment shader and the per-tile Spark dyno
 * modifier), so splats and ground cannot drift apart. `edge` = weights
 * (E, W, N, S), `corner` = block weights (NE, NW, SE, SW) already min'd with
 * their edges; `edgeG` / `cornerG` = the matching bridge growths, already
 * min'd with the tile's own `g`. A zero-weight segment / box degenerates to
 * the centre point with a radius ≤ the tile's own, so nothing needs a branch
 * — only min / max / clamp / sqrt / length / smoothstep.
 */
export const ROUNDED_UNION_GLSL = /* glsl */ `
  float hbdUnionBox(vec2 m, float w) {
    return length(max(max(-m, m - vec2(w)), vec2(0.0)));
  }
  float hbdMax4(vec4 v) {
    return max(max(v.x, v.y), max(v.z, v.w));
  }
  float hbdRoundedUnionMask(vec2 p, vec4 edge, vec4 corner, vec4 edgeG, vec4 cornerG,
                            float g, float feather) {
    const float R = ${UNION_RADIUS.toFixed(1)};
    vec2 q = p - vec2(0.5);
    vec4 a = vec4(q.x, -q.x, q.y, -q.y); // coordinate along E, W, N, S
    vec4 along = a - clamp(a, vec4(0.0), edge);
    vec4 dSeg = sqrt(along * along + q.yyxx * q.yyxx);
    vec4 dBox = vec4(
      hbdUnionBox(q, corner.x),
      hbdUnionBox(vec2(-q.x, q.y), corner.y),
      hbdUnionBox(vec2(q.x, -q.y), corner.z),
      hbdUnionBox(-q, corner.w));
    float s = R * g - length(q);
    s = max(s, hbdMax4(R * edgeG - dSeg));
    s = max(s, hbdMax4(R * cornerG - dBox));
    return smoothstep(0.0, 2.0 * max(feather, 1e-4), s);
  }
`;

// ---------------------------------------------------------------------------
// Animation curves
// ---------------------------------------------------------------------------

/** Tile growth `g` ∈ [0,1], `elapsedMs` after landing: ease-out cubic. */
export function unionGrowth(elapsedMs: number, growMs: number): number {
  if (!(growMs > 0)) return elapsedMs >= 0 ? 1 : 0;
  const u = 1 - clamp01(elapsedMs / growMs);
  return 1 - u * u * u;
}

/** Inverse of `unionGrowth`: ms after landing at which growth equals `g`. */
export function unionGrowthElapsed(g: number, growMs: number): number {
  return growMs * (1 - Math.cbrt(1 - clamp01(g)));
}

/** Ms after landing at which the bridges toward a new tile start growing
 *  (its growth passes `UNION_BRIDGE_START_G` — circle first, then bridge). */
export function unionBridgeDelayMs(growMs: number): number {
  return unionGrowthElapsed(UNION_BRIDGE_START_G, growMs);
}

/**
 * Weight ∈ [0,1] of the bridge between two tiles, `elapsedMs` after the LATER
 * of the two landed: 0 until its growth passes 0.6, then a linear ramp that
 * spends the whole of `growMs` on 0 → 0.5, then 1.
 *
 * Why 0.5: a tile only ever draws its own half of a bridge (the neighbour
 * draws the mirror image), so inside a tile's square the join is closed at
 * weight 0.5 and every value from there to 1 paints the same pixels. Ramping
 * on to 1 would re-run every resident splat's modifier each frame for
 * nothing; the step 0.5 → 1 ("joined") is invisible and costs one update.
 * Linear rather than eased so the join doesn't snap shut at the start.
 */
export function unionBridgeWeight(elapsedMs: number, growMs: number): number {
  if (!(growMs > 0)) return elapsedMs >= 0 ? 1 : 0;
  const t = (elapsedMs - unionBridgeDelayMs(growMs)) / growMs;
  return t >= 1 ? 1 : 0.5 * clamp01(t);
}

/** Ms after the later tile landed at which a bridge is complete. */
export function unionSettleMs(growMs: number): number {
  return growMs > 0 ? unionBridgeDelayMs(growMs) + growMs : 0;
}

/** Remaining presence ∈ [0,1] of a leaving tile (linear 1 → 0). */
export function unionLeaveFactor(elapsedMs: number, leaveMs = UNION_LEAVE_MS): number {
  if (!(leaveMs > 0)) return elapsedMs >= 0 ? 0 : 1;
  return 1 - clamp01(elapsedMs / leaveMs);
}

// ---------------------------------------------------------------------------
// Membership → per-tile mask values
// ---------------------------------------------------------------------------

/**
 * One tile's place in a rounded union. May outlive the tile itself for
 * `UNION_LEAVE_MS` so the neighbours' joins retract instead of popping.
 */
export interface UnionPresence {
  x: number;
  y: number;
  /** Clock time the tile landed (growth + bridges are derived from it). */
  inMs: number;
  /** Clock time the tile started leaving; null while it is staying. */
  outMs: number | null;
}

/** How present tile `p` is right now, 0‥1 (1 unless it is leaving). */
export function unionPresenceStay(p: UnionPresence | undefined, now: number): number {
  if (!p) return 0;
  return p.outMs === null ? 1 : unionLeaveFactor(now - p.outMs, UNION_LEAVE_MS);
}

/** Growth `g` of tile `p` right now (0 for an absent tile): the ease-out
 *  grow-in times what is left of it if it is leaving. */
export function unionPresenceGrowth(
  p: UnionPresence | undefined,
  now: number,
  growMs: number
): number {
  if (!p) return 0;
  return unionGrowth(now - p.inMs, growMs) * unionPresenceStay(p, now);
}

/**
 * Bridge weight between two tiles: grows once the LATER of the two has
 * mostly appeared, retracts with whichever is leaving. Symmetric in (a, b)
 * — that symmetry is what keeps the two sides of a seam identical.
 */
export function unionPairWeight(
  a: UnionPresence,
  b: UnionPresence | undefined,
  now: number,
  growMs: number
): number {
  if (!b) return 0;
  const grown = unionBridgeWeight(now - Math.max(a.inMs, b.inMs), growMs);
  return grown * Math.min(unionPresenceStay(a, now), unionPresenceStay(b, now));
}

/**
 * The 16 mask values of tile `p` at time `now`, written to `out` in the
 * layout the GLSL twin takes: edge weights (E, W, N, S), block weights
 * (NE, NW, SE, SW — already min'd with their edges), then the matching
 * bridge growths (already min'd with the tile's own growth). Returns the
 * tile's own growth `g`. `at(x, y)` looks a neighbour up; tile y grows
 * SOUTH, so the north neighbour is `y − 1`.
 *
 * A 2×2 block fills only as far as ALL six of its pairings have grown and
 * is only as thick as its least-grown tile, so its four tiles agree on it
 * (both mins are symmetric in the block).
 */
export function unionTileValues(
  p: UnionPresence,
  at: (x: number, y: number) => UnionPresence | undefined,
  now: number,
  growMs: number,
  out: { [i: number]: number }
): number {
  const { x, y } = p;
  const pe = at(x + 1, y);
  const pw = at(x - 1, y);
  const pn = at(x, y - 1);
  const ps = at(x, y + 1);
  const pne = at(x + 1, y - 1);
  const pnw = at(x - 1, y - 1);
  const pse = at(x + 1, y + 1);
  const psw = at(x - 1, y + 1);
  const e = unionPairWeight(p, pe, now, growMs);
  const w = unionPairWeight(p, pw, now, growMs);
  const n = unionPairWeight(p, pn, now, growMs);
  const s = unionPairWeight(p, ps, now, growMs);
  const g = unionPresenceGrowth(p, now, growMs);
  const ge = Math.min(g, unionPresenceGrowth(pe, now, growMs));
  const gw = Math.min(g, unionPresenceGrowth(pw, now, growMs));
  const gn = Math.min(g, unionPresenceGrowth(pn, now, growMs));
  const gs = Math.min(g, unionPresenceGrowth(ps, now, growMs));
  const block = (
    edgeA: number, pa: UnionPresence | undefined,
    edgeB: number, pb: UnionPresence | undefined,
    pd: UnionPresence | undefined
  ): number => {
    if (!pa || !pb || !pd || edgeA <= 0 || edgeB <= 0) return 0;
    return Math.min(
      edgeA, edgeB,
      unionPairWeight(p, pd, now, growMs),
      unionPairWeight(pa, pb, now, growMs),
      unionPairWeight(pa, pd, now, growMs),
      unionPairWeight(pb, pd, now, growMs)
    );
  };
  out[0] = e; out[1] = w; out[2] = n; out[3] = s;
  out[4] = block(e, pe, n, pn, pne);
  out[5] = block(w, pw, n, pn, pnw);
  out[6] = block(e, pe, s, ps, pse);
  out[7] = block(w, pw, s, ps, psw);
  out[8] = ge; out[9] = gw; out[10] = gn; out[11] = gs;
  out[12] = Math.min(ge, gn, unionPresenceGrowth(pne, now, growMs));
  out[13] = Math.min(gw, gn, unionPresenceGrowth(pnw, now, growMs));
  out[14] = Math.min(ge, gs, unionPresenceGrowth(pse, now, growMs));
  out[15] = Math.min(gw, gs, unionPresenceGrowth(psw, now, growMs));
  return g;
}

// ---------------------------------------------------------------------------
// Option
// ---------------------------------------------------------------------------

export interface RoundedUnionOptions {
  /** Soft-edge half-width in tile units. Default 0.03. */
  feather?: number;
  /** Grow-in length in ms (`0` = no animation). Default 700. */
  growMs?: number;
}

export interface ResolvedRoundedUnion {
  enabled: boolean;
  feather: number;
  growMs: number;
}

/** `true` / `undefined` → defaults; `false` → square tiles; object → overrides. */
export function resolveRoundedUnion(
  opt: boolean | RoundedUnionOptions | undefined
): ResolvedRoundedUnion {
  const o = typeof opt === 'object' && opt !== null ? opt : {};
  const num = (v: number | undefined, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
  return {
    enabled: opt !== false,
    feather: Math.min(num(o.feather, DEFAULT_UNION_FEATHER), UNION_RADIUS / 2),
    growMs: num(o.growMs, DEFAULT_UNION_GROW_MS)
  };
}
