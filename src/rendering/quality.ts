/**
 * Render-quality tiers. The headline knob is `pixelRatioCap` — on a Retina
 * display every render pass runs at `devicePixelRatio²` the logical pixel
 * count, so capping a 2× display to 1× is a 4× fill-rate cut across the
 * whole multi-pass pipeline. That single change is what makes the map
 * playable on integrated GPUs (e.g. the Intel Iris in a 2019 MacBook Pro).
 */

import { logger } from '../util/log.js';

export type QualityLevel = 'low' | 'high';
/** Value accepted by `HereBeDragonsOptions.quality`. `'auto'` detects the GPU. */
export type QualityOption = QualityLevel | 'auto';

export interface QualityProfile {
  /**
   * Hard cap on `devicePixelRatio`. 1 means no Retina super-sampling. An
   * explicit `pixelRatio` option always overrides this.
   */
  pixelRatioCap: number;
  /**
   * MSAA sample count on the color render target. 0 means FXAA alone
   * handles anti-aliasing — plenty for the stylized look and avoids the
   * 4×-write-bandwidth penalty during rasterization.
   */
  msaaSamples: number;
  /**
   * Default for the volumetric cloud pass when the developer doesn't pass
   * an explicit `clouds` option. The cloud pass is a full-screen RAYMARCH
   * (dozens of 3D-noise samples per pixel) — the heaviest fixed per-frame
   * GPU cost. An explicit `clouds` option always overrides this.
   */
  clouds: boolean;
  /**
   * Whether the sketch-outline pipeline runs. Disabling it drops a whole
   * second full-scene render (the normal pass) plus the full-screen Sobel
   * shader — roughly 30–40 % of the fixed per-frame GPU cost.
   */
  outlines: boolean;
  /**
   * Force buildings to render as flat footprints (no extrusion). Saves
   * geometry, wall draw calls, and depth complexity. Used on the very-low
   * tier so the map degrades to a 2D-style overhead view on devices that
   * can't sustain 3D extrusions.
   */
  flatBuildings: boolean;
  /**
   * Whether the FXAA edge-detection runs on the final composite pass.
   * `false` swaps the pass to a passthrough blit (still one fullscreen
   * pass, but no FXAA math) for very weak GPUs where even FXAA is
   * measurable. The grade + sRGB encode still happens either way.
   */
  fxaa: boolean;
  /**
   * Whether the labels layer is enabled. `false` skips label decode in
   * the worker AND label rendering on the main thread — a meaningful
   * win for label-dense city tiles (hundreds of glyph quads per tile).
   * Useful for tiers targeting devices that can barely sustain the base
   * geometry.
   */
  labels: boolean;
  /**
   * Whether the z11 low-resolution underlay is enabled. `false` skips
   * loading the underlay tiles entirely — saves ~10–30 MB of GPU memory
   * and the underlay's worker dispatch tick. The map shows blank canvas
   * during the brief z14 tile streaming window instead of a coarse
   * underlay; acceptable on mobile where streaming is fast.
   */
  underlay: boolean;
  /**
   * Subtracted from the PMTiles archive's `maxZoom` to choose the
   * requested z14 zoom level. 0 (default) = full detail. -1 drops one
   * zoom level (each requested tile covers 4× the area, ~3× less total
   * geometry across the viewport). Bigger negative values trade detail
   * for performance more aggressively.
   */
  tileZoomOffset: number;
  /**
   * Optional hard cap on camera tilt (degrees from top-down). `0` forces
   * a strict overhead view — appropriate when the device can't render a
   * full perspective scene cheaply. `undefined` means no cap from the
   * tier; the developer's own `tiltRange` option (if any) still applies.
   */
  maxTilt?: number;
  /**
   * Tile-pipeline overrides for this tier. Each field is merged UNDER the
   * developer's explicit `performance` options — an explicit setting
   * always wins; when both are absent the TileManager's own defaults
   * (the `'high'` values) apply.
   */
  tile?: Partial<{
    visibleRadius: number;
    tileWindowRadius: number;
    tileWindowRadiusFar: number;
    dispatchInterval: number;
  }>;
}

const PROFILES: Record<QualityLevel, QualityProfile> = {
  // `'high'`: full 3D map for the vast majority of modern devices. No clouds
  // raymarch, no outline pipeline, and — deliberately — NO MSAA. The headline
  // quality lever is:
  //
  //   • Retina rendering (pixelRatioCap 2). At 1× the scene rendered at CSS
  //     resolution and the browser upscaled the canvas to a HiDPI display —
  //     everything came out soft. min(dpr, 2) renders at the panel's real
  //     pixel grid. The `'high'` chain is just one color pass + FXAA, so even
  //     at 2× it's affordable, and dynamic resolution drops it to 1× while the
  //     camera moves so panning stays cheap.
  //
  // MSAA was tried here to tame the thin-ribbon shimmer (roads/rails fall below
  // a pixel zoomed out and crawl as the camera pans) but 4× MSAA on the
  // HalfFloat target cost far more per frame than the resolution itself —
  // it was the dominant pan stutter. The shimmer is handled for free instead by
  // fading sub-pixel ribbons into the ground colour (see StylizedMaterials'
  // setSubpixelFade), so MSAA stays off.
  //
  // A machine that can't sustain this auto-downgrades to `'low'` (which drops
  // pixelRatio back to 1 — the big fill-rate lever).
  high: {
    pixelRatioCap: 2,
    msaaSamples: 0,
    clouds: false,
    outlines: false,
    flatBuildings: false,
    fxaa: true,
    labels: true,
    underlay: true,
    tileZoomOffset: 0,
    tile: {
      visibleRadius: 2,
      tileWindowRadius: 4,
      tileWindowRadiusFar: 4,
      dispatchInterval: 6
    }
  },
  // `'low'` is now the floor: a 2D-style overhead view for VERY weak
  // devices. Buildings render as flat footprints (no wall geometry, no
  // extrusion), the camera is locked to top-down (no tilt), and the tile
  // window is even tighter than `'high'`. Strips the per-frame cost down
  // to a 2D-like render so a Chromebook-class GPU stays smooth.
  low: {
    pixelRatioCap: 1,
    msaaSamples: 0,
    clouds: false,
    outlines: false,
    flatBuildings: true,
    maxTilt: 0,
    fxaa: false,
    labels: false,
    underlay: false,
    tileZoomOffset: -1,
    tile: {
      visibleRadius: 2,
      tileWindowRadius: 3,
      tileWindowRadiusFar: 3,
      dispatchInterval: 8
    }
  }
};

/**
 * Keywords that confidently mark a GPU as "weak enough that the multi-pass
 * pipeline will struggle at Retina + 4× MSAA." Intel integrated graphics
 * (including the Iris Plus 645 in the 2019 MacBook Pro 13"), older Intel
 * codenames, and software rasterizers all qualify.
 */
const LOW_TIER_PATTERNS = [
  'intel', 'iris', 'uhd graphics', 'hd graphics',
  'haswell', 'broadwell', 'skylake', 'kaby lake', 'coffee lake', 'ice lake',
  'swiftshader', 'llvmpipe', 'microsoft basic', 'software', 'mesa offscreen'
];

/**
 * Best-effort GPU tier detection.
 *
 * Probes `WEBGL_debug_renderer_info` for the UNMASKED renderer string and
 * falls back to the masked `gl.getParameter(RENDERER)` if the extension is
 * unavailable. Logs both strings + the chosen tier via the project logger
 * so "why is auto-detect picking 'high' on my slow machine?" is debuggable
 * from the browser console without source diving.
 *
 * Stance: only DOWNGRADES on a confident keyword match. Apple Silicon
 * (`"Apple M1/M2/..."`), discrete GPUs (NVIDIA, AMD/Radeon), and renderer
 * strings the browser redacts for privacy all stay `'high'`, so a capable
 * machine never gets blurred by a guess. When the renderer is fully
 * redacted (Safari is the common case), pass `quality: 'low'` explicitly
 * to opt in — auto-detect can't safely decide for you in that case.
 */
export function detectGpuTier(): QualityLevel {
  try {
    if (typeof document === 'undefined') return 'high';
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) {
      logger.info('GPU detect: no WebGL — tier=low');
      return 'low'; // no WebGL at all — assume the worst
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const unmasked = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '').toLowerCase()
      : '';
    // Some browsers (Safari) redact the unmasked extension but still expose
    // a useful string via the plain RENDERER parameter — check both.
    const masked = String(gl.getParameter(gl.RENDERER) ?? '').toLowerCase();
    const renderer = unmasked || masked;
    // Release the probe context immediately — we only wanted the string.
    gl.getExtension('WEBGL_lose_context')?.loseContext();

    const matched = LOW_TIER_PATTERNS.find((p) => renderer.includes(p));
    const tier: QualityLevel = matched ? 'low' : 'high';
    logger.info(
      `GPU detect: renderer="${renderer || '(redacted)'}" ` +
      `${matched ? `matched "${matched}" → tier=low` : 'no low-tier match → tier=high'}` +
      `${!renderer ? ' (pass quality: "low" explicitly if your hardware is integrated/older)' : ''}`
    );
    return tier;
  } catch (err) {
    logger.warn('GPU detect: threw, defaulting to high', err);
    return 'high';
  }
}

/** A resolved profile plus the tier it came from (surfaced for HUD / logs). */
export interface ResolvedQuality extends QualityProfile {
  level: QualityLevel;
}

/**
 * Resolve a `QualityOption` (or `undefined`) into a concrete profile.
 * `'auto'` / `undefined` run GPU detection; `'low'` / `'high'` are forced.
 * The returned object carries `level` so callers can show / log which tier
 * actually won — critical for debugging "is auto-detect even matching my
 * GPU?" without guessing.
 */
export function resolveQualityProfile(option: QualityOption | undefined): ResolvedQuality {
  const level: QualityLevel =
    option === 'low' || option === 'high' ? option : detectGpuTier();
  return { level, ...PROFILES[level] };
}
