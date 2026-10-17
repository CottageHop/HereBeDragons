import {
  DEFAULT_UNION_FEATHER,
  DEFAULT_UNION_GROW_MS,
  type ResolvedRoundedUnion,
  resolveRoundedUnion
} from '../core/roundedUnion.js';
import { DEFAULT_RIPPLE_DURATION_MS, DEFAULT_RIPPLE_SPEED_MPS } from './ripple.js';
import {
  DEFAULT_LEVEL_FADE_MS,
  DEFAULT_PREFETCH_BAND,
  DEFAULT_TRANSITION_OVERSHOOT
} from './levelFade.js';
import type { SplatsConfig, SplatsRevealOptions } from './types.js';

/**
 * Pure option handling for the splats overlay — no THREE, no DOM. Everything
 * `map.setSplatsOptions()` / `getSplatsOptions()` and the Studio's Export /
 * Import need lives here so it can be unit-tested in node:
 *
 *  - `resolveSplatsOptions`  — defaults + clamping (one place, shared with
 *                              `SplatsLayer`).
 *  - `mergeSplatsOptions`    — lay a partial patch over a stored config.
 *  - `planSplatsUpdate`      — old vs new → apply live, rebuild the layer,
 *                              create it, or dispose it.
 *  - `exportSplatsOptions`   — the smallest literal `SplatsConfig` that
 *                              reproduces the state (defaults elided, no
 *                              `clock`, `undefined` when there is no URL).
 *  - `splatsReplacePatch`    — turn such a literal back into a patch that
 *                              REPLACES the stored config (elided keys reset).
 */

/** Documented defaults of `SplatsConfig` (see types.ts). */
export const SPLATS_DEFAULTS = Object.freeze({
  enabled: true,
  minZoom: 13,
  /** Coarsest / finest level of the splat tile pyramid. */
  minTileZoom: 13,
  maxTileZoom: 16,
  /** Added to the camera zoom when picking the tile level: tiles switch to
   *  the next finer level half a zoom early and run one level finer than the
   *  camera zoom — the satellite patch is smaller and sharper, and the vector
   *  map (`hideBasemap: 'covered'`) carries the rest of the view. */
  lodBias: 1.5,
  levelSelection: 'bias',
  resolutionMargin: 0.5,
  resolutionTiltAware: true,
  /** …and on the 'low' / 'mobile' tiers: one level coarser than that. */
  lowTierLodBias: 0.5,
  /** Camera max zoom while the overlay is on (surfels read as blobs closer). */
  maxCameraZoom: 15,
  maxCameraTilt: 45,
  radius: 1,
  maxInFlight: 4,
  maxSplats: 1_200_000,
  lowTierMaxSplats: 400_000,
  /** Spark's own default is √8; √5 trims the near-transparent fringe of
   *  every quad (≈ 40 % less fill) with no visible change at map distances. */
  maxStdDev: Math.sqrt(5),
  lodRenderScale: 1,
  frustumCull: true,
  visibleFirst: true,
  splatMaxDistance: 0,
  lowTierSplatMaxDistance: 1200,
  splatFadeMs: 350,
  sortIntervalMs: 100,
  /** `'covered'`: the vector map is cut out only under landed satellite. */
  hideBasemap: 'covered' as boolean | 'covered',
  keepLabels: true,
  neutralGrade: true,
  leanMap: true,
  motionLod: true,
  motionThin: true,
  densityLod: 2,
  miniature: true,
  cover: true,
  governor: true,
  targetFrameMs: 33,
  budgetGrowth: 1,
  /** Length of the cross-dissolve between pyramid levels, ms (0 = swap). */
  levelFadeMs: DEFAULT_LEVEL_FADE_MS,
  /** Cap of the budget allowance during a dissolve, × `maxSplats`. */
  transitionOvershoot: DEFAULT_TRANSITION_OVERSHOOT,
  /** Camera-zoom distance from a level boundary at which the next level's
   *  tile is fetched + decoded ahead of the switch (0 = never). */
  prefetchBand: DEFAULT_PREFETCH_BAND,
  roundedUnion: Object.freeze({
    enabled: true,
    feather: DEFAULT_UNION_FEATHER,
    growMs: DEFAULT_UNION_GROW_MS
  }),
  reveal: Object.freeze({
    reveal: 'none' as const,
    durationMs: DEFAULT_RIPPLE_DURATION_MS,
    speedMps: DEFAULT_RIPPLE_SPEED_MPS
  })
});

/** `SplatsConfig.reveal` with every default filled in. */
export interface ResolvedSplatsReveal {
  reveal: 'none' | 'ripple';
  durationMs: number;
  speedMps: number;
  /** Fixed ripple origin; absent = the view centre at toggle time. */
  origin?: { lat: number; lon: number };
}

/**
 * A `SplatsConfig` with every default filled in and every value clamped the
 * way the layer uses it — what `map.getSplatsOptions()` returns. `clock` is
 * left out (a function; never exported, never diffed).
 */
export interface ResolvedSplatsOptions {
  /** `''` when no overlay is configured. */
  urlTemplate: string;
  /** `''` = low tiers fetch `urlTemplate` too. */
  lowTierUrlTemplate: string;
  /** As configured: `undefined` = derive from `urlTemplate` (`.png`),
   *  `null` = no imagery ground, string = explicit template. */
  imageryTemplate: string | null | undefined;
  enabled: boolean;
  minZoom: number;
  /** Pyramid bounds, integers with `minTileZoom ≤ maxTileZoom` (the
   *  deprecated `zoomLevel` alias is folded into both). */
  minTileZoom: number;
  maxTileZoom: number;
  lodBias: number;
  levelSelection: 'bias' | 'resolution';
  resolutionMargin: number;
  resolutionTiltAware: boolean;
  lowTierLodBias: number;
  maxCameraZoom: number;
  maxCameraTilt: number;
  radius: number;
  maxInFlight: number;
  maxSplats: number;
  lowTierMaxSplats: number;
  maxStdDev: number;
  lodRenderScale: number;
  frustumCull: boolean;
  visibleFirst: boolean;
  splatMaxDistance: number;
  lowTierSplatMaxDistance: number;
  splatFadeMs: number;
  sortIntervalMs: number;
  hideBasemap: boolean | 'covered';
  keepLabels: boolean;
  neutralGrade: boolean;
  leanMap: boolean;
  motionLod: boolean;
  motionThin: boolean;
  densityLod: number;
  miniature: boolean;
  cover: boolean;
  governor: boolean;
  targetFrameMs: number;
  budgetGrowth: number;
  levelFadeMs: number;
  transitionOvershoot: number;
  prefetchBand: number;
  roundedUnion: ResolvedRoundedUnion;
  reveal: ResolvedSplatsReveal;
}

/** `…/{z}/{x}/{y}.spz` → `…/{z}/{x}/{y}.png` (query / hash preserved). */
export function imageryTemplateFrom(urlTemplate: string): string {
  return urlTemplate.replace(/\.[a-z0-9]+(\?|#|$)/i, '.png$1');
}

/**
 * URL templates to try, in order, for a tile's imagery ground.
 *
 * An EXPLICIT `imageryTemplate` is used as given. A DERIVED one (from `urlTemplate`, `.png`)
 * expands to the small WebP twin first, then the PNG: WebP grounds are ~9x smaller than PNG at
 * the same size, which is what matters on phones; older tile sets only have the PNG. With
 * `hiRes` (high tier, high-DPI screen, finest level) the 2048 px `@2x.webp` leads.
 */
export function imageryCandidates(template: string, derived: boolean, hiRes: boolean): string[] {
  if (!derived || !/\.png(\?|#|$)/i.test(template)) return [template];
  const swap = (ext: string): string => template.replace(/\.png(\?|#|$)/i, `${ext}$1`);
  const out = [swap('.webp'), template];
  if (hiRes) out.unshift(swap('@2x.webp'));
  return out;
}

/** Whether the imagery template is derived from `urlTemplate` (no explicit one given). */
export function imageryIsDerived(o: Pick<ResolvedSplatsOptions, 'imageryTemplate'>): boolean {
  return !(typeof o.imageryTemplate === 'string' && o.imageryTemplate !== '');
}

/** The imagery template actually in effect (`null` = no imagery ground). */
export function effectiveImageryTemplate(
  o: Pick<ResolvedSplatsOptions, 'urlTemplate' | 'imageryTemplate'>
): string | null {
  if (o.imageryTemplate === null) return null;
  if (typeof o.imageryTemplate === 'string' && o.imageryTemplate !== '') return o.imageryTemplate;
  return o.urlTemplate ? imageryTemplateFrom(o.urlTemplate) : null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positiveOr = (v: unknown, d: number): number => (isNum(v) && v > 0 ? v : d);
const nonNegativeOr = (v: unknown, d: number): number => (isNum(v) && v >= 0 ? v : d);

function resolveReveal(r: SplatsRevealOptions | undefined): ResolvedSplatsReveal {
  const o = r && typeof r === 'object' ? r : {};
  const out: ResolvedSplatsReveal = {
    reveal: o.reveal === 'ripple' ? 'ripple' : 'none',
    durationMs: positiveOr(o.durationMs, SPLATS_DEFAULTS.reveal.durationMs),
    speedMps: positiveOr(o.speedMps, SPLATS_DEFAULTS.reveal.speedMps)
  };
  if (o.origin && isNum(o.origin.lat) && isNum(o.origin.lon)) {
    out.origin = { lat: o.origin.lat, lon: o.origin.lon };
  }
  return out;
}

const MAX_TILE_ZOOM = 24;
/** Below a 120 Hz frame nothing can be measured, let alone held. */
const MIN_TARGET_FRAME_MS = 8;
/** A dissolve longer than this is a slideshow, not a transition. */
const MAX_LEVEL_FADE_MS = 5000;
/** Half a level: beyond it the "next" level is ambiguous. */
const MAX_PREFETCH_BAND = 0.5;
/** The governor grows in x1.25 steps on evidence; past 4x the configured budget it
 *  is no longer adapting to a device, it is ignoring the number it was given. */
const MAX_BUDGET_GROWTH = 4;
const tileZoomOf = (v: number): number => Math.max(0, Math.min(MAX_TILE_ZOOM, Math.floor(v)));

/**
 * The pyramid bounds. `zoomLevel` (deprecated) pins BOTH to one level — the
 * old fixed-zoom behaviour — unless the new keys say otherwise. An inverted
 * pair is repaired toward whichever bound was given explicitly.
 */
function resolveTileZoomBounds(c: Partial<SplatsConfig>): { minTileZoom: number; maxTileZoom: number } {
  const alias = isNum(c.zoomLevel) ? tileZoomOf(c.zoomLevel) : undefined;
  const hasMin = isNum(c.minTileZoom);
  const hasMax = isNum(c.maxTileZoom);
  let lo = hasMin ? tileZoomOf(c.minTileZoom as number) : (alias ?? SPLATS_DEFAULTS.minTileZoom);
  let hi = hasMax ? tileZoomOf(c.maxTileZoom as number) : (alias ?? SPLATS_DEFAULTS.maxTileZoom);
  if (lo > hi) {
    if (hasMin && !hasMax) hi = lo;
    else lo = hi;
  }
  return { minTileZoom: lo, maxTileZoom: hi };
}

/** Fill in defaults and clamp. Garbage (NaN, wrong type) falls back to the default. */
export function resolveSplatsOptions(
  config: Partial<SplatsConfig> | null | undefined
): ResolvedSplatsOptions {
  const c = config ?? {};
  const imagery = c.imageryTemplate;
  const bounds = resolveTileZoomBounds(c);
  return {
    urlTemplate: typeof c.urlTemplate === 'string' ? c.urlTemplate.trim() : '',
    lowTierUrlTemplate: typeof c.lowTierUrlTemplate === 'string' ? c.lowTierUrlTemplate.trim() : '',
    imageryTemplate:
      imagery === null ? null : typeof imagery === 'string' && imagery.trim() !== '' ? imagery.trim() : undefined,
    enabled: c.enabled !== false,
    minZoom: isNum(c.minZoom) ? c.minZoom : SPLATS_DEFAULTS.minZoom,
    minTileZoom: bounds.minTileZoom,
    maxTileZoom: bounds.maxTileZoom,
    lodBias: isNum(c.lodBias) ? c.lodBias : SPLATS_DEFAULTS.lodBias,
    levelSelection: c.levelSelection === 'resolution' ? 'resolution' : SPLATS_DEFAULTS.levelSelection,
    resolutionMargin: isNum(c.resolutionMargin) && c.resolutionMargin > 0
      ? Math.min(c.resolutionMargin, 4)
      : SPLATS_DEFAULTS.resolutionMargin,

    resolutionTiltAware: c.resolutionTiltAware !== false,
    lowTierLodBias: isNum(c.lowTierLodBias) ? c.lowTierLodBias : SPLATS_DEFAULTS.lowTierLodBias,
    maxCameraZoom: positiveOr(c.maxCameraZoom, SPLATS_DEFAULTS.maxCameraZoom),
    maxCameraTilt: isNum(c.maxCameraTilt) && c.maxCameraTilt >= 0 ? Math.min(c.maxCameraTilt, 89) : SPLATS_DEFAULTS.maxCameraTilt,
    radius: isNum(c.radius) ? Math.max(0, Math.floor(c.radius)) : SPLATS_DEFAULTS.radius,
    maxInFlight: isNum(c.maxInFlight) ? Math.max(1, Math.floor(c.maxInFlight)) : SPLATS_DEFAULTS.maxInFlight,
    maxSplats: positiveOr(c.maxSplats, SPLATS_DEFAULTS.maxSplats),
    lowTierMaxSplats: nonNegativeOr(c.lowTierMaxSplats, SPLATS_DEFAULTS.lowTierMaxSplats),
    maxStdDev: positiveOr(c.maxStdDev, SPLATS_DEFAULTS.maxStdDev),

    lodRenderScale: positiveOr(c.lodRenderScale, SPLATS_DEFAULTS.lodRenderScale),


    frustumCull: c.frustumCull !== false,



    visibleFirst: c.visibleFirst !== false,




    splatMaxDistance: isNum(c.splatMaxDistance) && c.splatMaxDistance > 0 ? c.splatMaxDistance : 0,





    lowTierSplatMaxDistance: isNum(c.lowTierSplatMaxDistance) && c.lowTierSplatMaxDistance >= 0





      ? c.lowTierSplatMaxDistance





      : SPLATS_DEFAULTS.lowTierSplatMaxDistance,






    splatFadeMs: isNum(c.splatFadeMs) && c.splatFadeMs >= 0 ? c.splatFadeMs : SPLATS_DEFAULTS.splatFadeMs,
    sortIntervalMs: nonNegativeOr(c.sortIntervalMs, SPLATS_DEFAULTS.sortIntervalMs),
    hideBasemap: c.hideBasemap === false ? false : c.hideBasemap === true ? true : 'covered',
    keepLabels: c.keepLabels !== false,
    neutralGrade: c.neutralGrade !== false,
    leanMap: c.leanMap !== false,
    motionLod: c.motionLod !== false,
    motionThin: c.motionThin !== false,
    densityLod: nonNegativeOr(c.densityLod, SPLATS_DEFAULTS.densityLod),
    miniature: c.miniature !== false,
    cover: c.cover !== false,
    governor: c.governor !== false,
    targetFrameMs: isNum(c.targetFrameMs) && c.targetFrameMs >= MIN_TARGET_FRAME_MS
      ? c.targetFrameMs
      : isNum(c.targetFrameMs) && c.targetFrameMs > 0
        ? MIN_TARGET_FRAME_MS
        : SPLATS_DEFAULTS.targetFrameMs,
    budgetGrowth: isNum(c.budgetGrowth) && c.budgetGrowth >= 1
      ? Math.min(c.budgetGrowth, MAX_BUDGET_GROWTH)
      : SPLATS_DEFAULTS.budgetGrowth,
    levelFadeMs: Math.min(nonNegativeOr(c.levelFadeMs, SPLATS_DEFAULTS.levelFadeMs), MAX_LEVEL_FADE_MS),
    transitionOvershoot: Math.min(nonNegativeOr(c.transitionOvershoot, SPLATS_DEFAULTS.transitionOvershoot), 1),
    prefetchBand: Math.min(nonNegativeOr(c.prefetchBand, SPLATS_DEFAULTS.prefetchBand), MAX_PREFETCH_BAND),
    roundedUnion: resolveRoundedUnion(c.roundedUnion),
    reveal: resolveReveal(c.reveal)
  };
}

/**
 * Lay `patch` over `base` and return the new stored config. A key that is
 * PRESENT in the patch with the value `undefined` resets that option to its
 * default; an absent key is left alone. `roundedUnion` and `reveal` merge
 * field by field when both sides are objects (a boolean `roundedUnion`
 * replaces whatever was there).
 */
export function mergeSplatsOptions(
  base: Partial<SplatsConfig>,
  patch: Partial<SplatsConfig>
): Partial<SplatsConfig> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch) as Array<keyof SplatsConfig>) {
    const v = patch[key];
    if (v === undefined) {
      delete out[key];
      continue;
    }
    const prev = out[key];
    if (
      (key === 'roundedUnion' || key === 'reveal') &&
      v !== null && typeof v === 'object' &&
      prev !== null && typeof prev === 'object'
    ) {
      const merged: Record<string, unknown> = { ...(prev as object) };
      for (const [k, sub] of Object.entries(v)) {
        if (sub === undefined) delete merged[k];
        else merged[k] = sub;
      }
      out[key] = merged;
    } else {
      out[key] = v;
    }
  }
  return out as Partial<SplatsConfig>;
}

/** Option names as reported by `diffSplatsOptions` (sub-keys are dotted). */
export type SplatsOptionKey =
  | Exclude<keyof ResolvedSplatsOptions, 'roundedUnion' | 'reveal'>
  | 'roundedUnion.enabled'
  | 'roundedUnion.feather'
  | 'roundedUnion.growMs'
  | 'reveal';

/**
 * Options that define the tile set — the tile source and whether tiles are
 * built with the union-mask modifier at all. Changing one rebuilds the layer
 * (every tile dropped and reloaded); everything else is applied to the
 * running layer — including the pyramid bounds (`minTileZoom` /
 * `maxTileZoom`, and with them the deprecated `zoomLevel` alias), which only
 * make the layer re-evaluate its active level.
 */
export const SPLATS_REBUILD_KEYS: ReadonlySet<SplatsOptionKey> = new Set<SplatsOptionKey>([
  'urlTemplate',
  'lowTierUrlTemplate',
  'imageryTemplate',
  'roundedUnion.enabled'
]);

/** Which options differ between two resolved configs. */
export function diffSplatsOptions(
  prev: ResolvedSplatsOptions,
  next: ResolvedSplatsOptions
): SplatsOptionKey[] {
  const changed: SplatsOptionKey[] = [];
  const scalar = [
    'urlTemplate', 'lowTierUrlTemplate', 'enabled', 'minZoom', 'minTileZoom', 'maxTileZoom', 'lodBias', 'lowTierLodBias',
    'maxCameraZoom', 'maxCameraTilt', 'radius', 'maxInFlight', 'maxSplats', 'lowTierMaxSplats', 'maxStdDev',
    'sortIntervalMs', 'lodRenderScale', 'frustumCull', 'visibleFirst', 'splatMaxDistance', 'lowTierSplatMaxDistance', 'splatFadeMs', 'hideBasemap', 'keepLabels', 'neutralGrade', 'motionLod', 'motionThin', 'densityLod', 'miniature', 'cover', 'governor', 'targetFrameMs', 'budgetGrowth',
    'levelFadeMs', 'transitionOvershoot', 'prefetchBand', 'levelSelection', 'resolutionMargin', 'resolutionTiltAware'
  ] as const;
  for (const k of scalar) if (prev[k] !== next[k]) changed.push(k);
  // Imagery is compared by what is actually fetched: spelling out the derived
  // `.png` template is not a change.
  if (effectiveImageryTemplate(prev) !== effectiveImageryTemplate(next)) changed.push('imageryTemplate');
  if (prev.roundedUnion.enabled !== next.roundedUnion.enabled) changed.push('roundedUnion.enabled');
  if (prev.roundedUnion.feather !== next.roundedUnion.feather) changed.push('roundedUnion.feather');
  if (prev.roundedUnion.growMs !== next.roundedUnion.growMs) changed.push('roundedUnion.growMs');
  const a = prev.reveal;
  const b = next.reveal;
  if (
    a.reveal !== b.reveal || a.durationMs !== b.durationMs || a.speedMps !== b.speedMps ||
    a.origin?.lat !== b.origin?.lat || a.origin?.lon !== b.origin?.lon
  ) {
    changed.push('reveal');
  }
  return changed;
}

/**
 * What `setSplatsOptions` has to do:
 *  - `'none'`    nothing changed;
 *  - `'live'`    apply to the running layer (or, with no layer and no URL,
 *                just remember the values);
 *  - `'rebuild'` drop every tile and start over from the new tile set;
 *  - `'create'`  no layer yet and a URL arrived → construct one;
 *  - `'dispose'` the URL was cleared → drop the layer.
 */
export type SplatsUpdateKind = 'none' | 'live' | 'rebuild' | 'create' | 'dispose';

export interface SplatsUpdatePlan {
  kind: SplatsUpdateKind;
  changed: SplatsOptionKey[];
}

export function planSplatsUpdate(
  prev: ResolvedSplatsOptions,
  next: ResolvedSplatsOptions,
  hasLayer: boolean
): SplatsUpdatePlan {
  const changed = diffSplatsOptions(prev, next);
  if (!hasLayer) {
    if (next.urlTemplate) return { kind: 'create', changed };
    return { kind: changed.length ? 'live' : 'none', changed };
  }
  if (!next.urlTemplate) return { kind: 'dispose', changed };
  if (changed.length === 0) return { kind: 'none', changed };
  if (changed.some((k) => SPLATS_REBUILD_KEYS.has(k))) return { kind: 'rebuild', changed };
  return { kind: 'live', changed };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(b));

/**
 * The smallest literal `SplatsConfig` that reproduces the resolved options
 * (`map.getSplatsOptions()`, or `resolveSplatsOptions(config)`) when handed
 * to `createHereBeDragons` — keys equal to their default are left out, there
 * is no `clock`, and the result is `undefined` when no URL is configured (an
 * export never carries an empty `splats` block).
 */
export function exportSplatsOptions(o: ResolvedSplatsOptions): SplatsConfig | undefined {
  if (!o.urlTemplate) return undefined;
  const D = SPLATS_DEFAULTS;
  const out: SplatsConfig = { urlTemplate: o.urlTemplate };
  if (o.imageryTemplate === null) out.imageryTemplate = null;
  else if (o.imageryTemplate && o.imageryTemplate !== imageryTemplateFrom(o.urlTemplate)) {
    out.imageryTemplate = o.imageryTemplate;
  }
  if (o.enabled !== D.enabled) out.enabled = o.enabled;
  if (o.minZoom !== D.minZoom) out.minZoom = o.minZoom;
  // The pyramid bounds are always written with the new keys — the
  // deprecated `zoomLevel` alias never appears in an export.
  if (o.minTileZoom !== D.minTileZoom) out.minTileZoom = o.minTileZoom;
  if (o.maxTileZoom !== D.maxTileZoom) out.maxTileZoom = o.maxTileZoom;
  if (o.lodBias !== D.lodBias) out.lodBias = o.lodBias;
  if (o.lowTierLodBias !== D.lowTierLodBias) out.lowTierLodBias = o.lowTierLodBias;
  if (o.maxCameraZoom !== D.maxCameraZoom) out.maxCameraZoom = o.maxCameraZoom;
  if (!near(o.maxCameraTilt, D.maxCameraTilt)) out.maxCameraTilt = o.maxCameraTilt;
  if (o.radius !== D.radius) out.radius = o.radius;
  if (o.maxInFlight !== D.maxInFlight) out.maxInFlight = o.maxInFlight;
  if (o.maxSplats !== D.maxSplats) out.maxSplats = o.maxSplats;
  if (o.lowTierMaxSplats !== D.lowTierMaxSplats) out.lowTierMaxSplats = o.lowTierMaxSplats;
  if (o.lowTierUrlTemplate) out.lowTierUrlTemplate = o.lowTierUrlTemplate;
  if (!near(o.maxStdDev, D.maxStdDev)) out.maxStdDev = Math.round(o.maxStdDev * 1000) / 1000;
  if (o.sortIntervalMs !== D.sortIntervalMs) out.sortIntervalMs = o.sortIntervalMs;
  if (o.hideBasemap !== D.hideBasemap) out.hideBasemap = o.hideBasemap;
  if (o.keepLabels !== D.keepLabels) out.keepLabels = o.keepLabels;
  if (o.neutralGrade !== D.neutralGrade) out.neutralGrade = o.neutralGrade;
  if (o.motionLod !== D.motionLod) out.motionLod = o.motionLod;
  if (o.motionThin !== D.motionThin) out.motionThin = o.motionThin;
  if (!near(o.densityLod, D.densityLod)) out.densityLod = o.densityLod;
  if (o.miniature !== D.miniature) out.miniature = o.miniature;
  if (o.cover !== D.cover) out.cover = o.cover;
  if (o.governor !== D.governor) out.governor = o.governor;
  if (o.targetFrameMs !== D.targetFrameMs) out.targetFrameMs = o.targetFrameMs;
  if (!near(o.budgetGrowth, D.budgetGrowth)) out.budgetGrowth = o.budgetGrowth;
  if (o.levelFadeMs !== D.levelFadeMs) out.levelFadeMs = o.levelFadeMs;
  if (!near(o.transitionOvershoot, D.transitionOvershoot)) out.transitionOvershoot = o.transitionOvershoot;
  if (!near(o.prefetchBand, D.prefetchBand)) out.prefetchBand = o.prefetchBand;
  if (!o.roundedUnion.enabled) {
    out.roundedUnion = false;
  } else {
    const u: { feather?: number; growMs?: number } = {};
    if (!near(o.roundedUnion.feather, D.roundedUnion.feather)) u.feather = o.roundedUnion.feather;
    if (o.roundedUnion.growMs !== D.roundedUnion.growMs) u.growMs = o.roundedUnion.growMs;
    if (Object.keys(u).length > 0) out.roundedUnion = u;
  }
  const r: SplatsRevealOptions = {};
  if (o.reveal.reveal !== D.reveal.reveal) r.reveal = o.reveal.reveal;
  if (o.reveal.durationMs !== D.reveal.durationMs) r.durationMs = o.reveal.durationMs;
  if (o.reveal.speedMps !== D.reveal.speedMps) r.speedMps = o.reveal.speedMps;
  if (o.reveal.origin) r.origin = { ...o.reveal.origin };
  if (Object.keys(r).length > 0) out.reveal = r;
  return out;
}

/** Every `SplatsConfig` key a config literal can carry (i.e. all but `clock`). */
const LITERAL_KEYS: ReadonlyArray<Exclude<keyof SplatsConfig, 'clock'>> = [
  'urlTemplate', 'imageryTemplate', 'enabled', 'minZoom', 'zoomLevel', 'minTileZoom', 'maxTileZoom',
  'lodBias', 'lowTierLodBias', 'maxCameraZoom', 'maxCameraTilt', 'radius', 'maxInFlight', 'maxSplats', 'lowTierMaxSplats',
  'maxStdDev', 'sortIntervalMs', 'lodRenderScale', 'frustumCull', 'hideBasemap', 'keepLabels', 'neutralGrade', 'motionLod', 'motionThin', 'densityLod', 'miniature', 'cover', 'governor', 'targetFrameMs', 'budgetGrowth',
  'levelFadeMs', 'transitionOvershoot', 'prefetchBand', 'roundedUnion', 'reveal',
  'levelSelection', 'resolutionMargin', 'resolutionTiltAware'
];

/**
 * Turn a config literal (e.g. an imported Studio export) into a patch that
 * REPLACES the stored options: keys the literal leaves out are present as
 * `undefined`, which `mergeSplatsOptions` reads as "back to the default" —
 * the inverse of the defaults-elision in `exportSplatsOptions`. `clock` is
 * untouched. `roundedUnion` / `reveal` objects are completed the same way so
 * they replace rather than merge.
 */
export function splatsReplacePatch(config: Partial<SplatsConfig>): Partial<SplatsConfig> {
  const patch: Record<string, unknown> = {};
  for (const k of LITERAL_KEYS) patch[k] = config[k];
  const ru = config.roundedUnion;
  if (ru && typeof ru === 'object') patch.roundedUnion = { feather: ru.feather, growMs: ru.growMs };
  const rv = config.reveal;
  if (rv && typeof rv === 'object') {
    patch.reveal = { reveal: rv.reveal, durationMs: rv.durationMs, speedMps: rv.speedMps, origin: rv.origin };
  }
  return patch as Partial<SplatsConfig>;
}

/** Lay per-call reveal options over the configured defaults. */
export function resolveRevealCall(
  defaults: ResolvedSplatsReveal,
  opts: SplatsRevealOptions | undefined
): SplatsRevealOptions {
  const out: SplatsRevealOptions = { ...defaults };
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
