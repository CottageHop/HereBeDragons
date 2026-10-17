/**
 * Level cross-dissolve maths for the splat tile pyramid. Pure — no THREE, no
 * DOM, no clock of its own (callers pass `nowMs`), unit-tested in node.
 *
 * A pyramid LEVEL change is a change of detail IN PLACE, so it must not look
 * like new ground arriving (the rounded-union grow animation): the incoming
 * tile appears at its full shape and DISSOLVES in while the tile(s) it
 * replaces dissolve out. This file holds the three pure pieces of that:
 *
 *  - `FadeTrack`        a reversible 0‥1 ramp (linear progress, smoothstep
 *                       output) — reversing mid-way continues from where it
 *                       got to, never restarts;
 *  - `tilesOverlap` / `appearKind`   is a landing tile's footprint already
 *                       covered by a resident tile of ANOTHER level
 *                       (→ `'dissolve'`) or is it new ground (→ `'grow'`);
 *  - `prefetchLevel`    which neighbouring level (if any) the camera zoom is
 *                       about to switch to, so its tile can be fetched and
 *                       decoded BEFORE the threshold is crossed;
 *  - `transitionAllowance`   how far over the budget a dissolve may go.
 */

import { LOD_HYSTERESIS, type TileLodParams } from './lod.js';

/** Default length of a level dissolve, ms. */
export const DEFAULT_LEVEL_FADE_MS = 350;
/** Default cap of the transition allowance, as a fraction of `maxSplats`. */
export const DEFAULT_TRANSITION_OVERSHOOT = 0.35;
/** Default half-width of the prefetch band, camera-zoom units. */
export const DEFAULT_PREFETCH_BAND = 0.2;
/** Grace added to `levelFadeMs` before an over-budget overlap is cut short. */
export const TRANSITION_GRACE_MS = 250;
/** Splat scale at fade 0 (→ 1 at fade 1): two dense, overlapping splat sets
 *  at full size read as doubled / over-bright mid-dissolve. */
export const LEVEL_FADE_MIN_SCALE = 0.6;

/** How a landing tile is revealed. */
export type AppearKind = 'grow' | 'dissolve';

// ---------------------------------------------------------------------------
// Reversible fade
// ---------------------------------------------------------------------------

/**
 * A reversible ramp. `p` is the LINEAR progress (0‥1) at clock time `atMs`,
 * `dir` where it is heading (+1 in, −1 out, 0 at rest). The visible value is
 * `smoothstep(p)`; keeping the state linear is what makes a reversal seamless
 * — the ramp turns round at the progress it had reached.
 */
export interface FadeTrack {
  p: number;
  dir: -1 | 0 | 1;
  atMs: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function createFade(p: 0 | 1, nowMs: number): FadeTrack {
  return { p, dir: 0, atMs: nowMs };
}

/** Linear progress at `nowMs` (`fadeMs` ≤ 0: the target, at once). */
export function fadeProgress(t: FadeTrack, nowMs: number, fadeMs: number): number {
  if (t.dir === 0) return t.p;
  if (!(fadeMs > 0)) return t.dir > 0 ? 1 : 0;
  return clamp01(t.p + (t.dir * Math.max(0, nowMs - t.atMs)) / fadeMs);
}

/** Visible value (smoothstep of the linear progress). */
export function fadeValue(p: number): number {
  const c = clamp01(p);
  return c * c * (3 - 2 * c);
}

/** Inverse of `fadeValue` on [0, 1]. */
export function fadeValueInverse(v: number): number {
  const c = clamp01(v);
  return 0.5 - Math.sin(Math.asin(1 - 2 * c) / 3);
}

/**
 * Advance `t` to `nowMs` and head it for `target`. Re-targeting mid-way keeps
 * the progress reached (no restart, no jump). @returns the linear progress.
 */
export function fadeToward(t: FadeTrack, target: 0 | 1, nowMs: number, fadeMs: number): number {
  let p = fadeProgress(t, nowMs, fadeMs);
  if (!(fadeMs > 0)) p = target;
  const dir = p === target ? 0 : target > p ? 1 : -1;
  // Still heading the same way: keep the base (re-basing every frame would
  // accumulate rounding and never quite arrive).
  if (dir !== t.dir || dir === 0) {
    t.p = p;
    t.atMs = nowMs;
    t.dir = dir;
  }
  return p;
}

/** Freeze `t` at its current progress (before `fadeMs` changes under it). */
export function fadeRebase(t: FadeTrack, nowMs: number, fadeMs: number): void {
  t.p = fadeProgress(t, nowMs, fadeMs);
  t.atMs = nowMs;
}

// ---------------------------------------------------------------------------
// Appear kind
// ---------------------------------------------------------------------------

export interface TileRef {
  z: number;
  x: number;
  y: number;
}

/** Do two tiles (any levels) share ground? */
export function tilesOverlap(a: TileRef, b: TileRef): boolean {
  if (a.z === b.z) return a.x === b.x && a.y === b.y;
  const [fine, coarse] = a.z > b.z ? [a, b] : [b, a];
  const d = 2 ** (fine.z - coarse.z);
  return Math.floor(fine.x / d) === coarse.x && Math.floor(fine.y / d) === coarse.y;
}

/**
 * `'dissolve'` when the landing tile's footprint is already (partly) shown by
 * a resident tile of another level — a change of detail in place; `'grow'`
 * when it is new ground (panning, first enable, a ripple). `residents` should
 * list only tiles that are actually showing (not ones on their way out of
 * range).
 */
export function appearKind(tile: TileRef, residents: Iterable<TileRef>): AppearKind {
  for (const r of residents) {
    if (r.z !== tile.z && tilesOverlap(tile, r)) return 'dissolve';
  }
  return 'grow';
}

/**
 * Index of the quadrant of `parent` that `child` (exactly one level finer)
 * occupies, in the tile-local frame the GPU mask uses (u east, v NORTH):
 * `(u ≥ ½) + 2·(v ≥ ½)` → 0 = SW, 1 = SE, 2 = NW, 3 = NE. −1 if `child` is
 * not a child of `parent`. (Tile y grows SOUTH.)
 */
export function childQuadrant(parent: TileRef, child: TileRef): number {
  if (child.z !== parent.z + 1) return -1;
  if (child.x >> 1 !== parent.x || child.y >> 1 !== parent.y) return -1;
  const east = child.x & 1;
  const north = 1 - (child.y & 1);
  return east + 2 * north;
}

// ---------------------------------------------------------------------------
// Prefetch across the threshold
// ---------------------------------------------------------------------------

/**
 * The level the camera is about to switch to, or null. Coming from level
 * `current` (the hysteresis state of `selectTileZoom`) the switch to the
 * finer level happens at `v ≥ current + 1 + h` and to the coarser one at
 * `v < current − h` (`v = cameraZoom + lodBias`); within `band` of either
 * threshold that level's tile is worth having decoded already.
 */
export function prefetchLevel(
  cameraZoom: number,
  current: number | null,
  p: TileLodParams,
  band: number
): number | null {
  if (current === null || !(band > 0)) return null;
  const lo = Math.min(p.minTileZoom, p.maxTileZoom);
  const hi = Math.max(p.minTileZoom, p.maxTileZoom);
  if (current < lo || current > hi) return null;
  const h = p.hysteresis ?? LOD_HYSTERESIS;
  const v = cameraZoom + p.lodBias;
  const toFiner = current + 1 + h - v;
  const toCoarser = v - (current - h);
  if (current < hi && toFiner <= band && (current <= lo || toFiner <= toCoarser)) return current + 1;
  if (current > lo && toCoarser <= band) return current - 1;
  return null;
}

// ---------------------------------------------------------------------------
// Budget allowance
// ---------------------------------------------------------------------------

/**
 * Splats a dissolve may hold ABOVE the effective budget while both levels
 * overlap: one tile's worth (the incoming tile), capped at `overshoot` × the
 * configured (un-governed) `maxSplats`. 0 when fades are off.
 */
export function transitionAllowance(
  incomingSplats: number,
  baseMaxSplats: number,
  overshoot: number,
  levelFadeMs: number
): number {
  if (!(levelFadeMs > 0) || !(overshoot > 0)) return 0;
  return Math.max(0, Math.min(incomingSplats, Math.round(overshoot * baseMaxSplats)));
}
