import { describe, it, expect, vi } from 'vitest';
import {
  SPLATS_DEFAULTS,
  diffSplatsOptions,
  exportSplatsOptions,
  mergeSplatsOptions,
  planSplatsUpdate,
  resolveRevealCall,
  resolveSplatsOptions,
  splatsReplacePatch
} from '../src/splats/options.js';
import { SplatsController, type SplatsLayerLike } from '../src/splats/SplatsController.js';
import { selectTileZoom } from '../src/splats/lod.js';
import type { SplatsConfig, SplatsRevealOptions, SplatsStats } from '../src/splats/types.js';
import { exportTileReveal, resolveTileReveal } from '../src/tiles/CoverageField.js';

/**
 * The pure half of `map.setSplatsOptions()` and of the Studio's Export /
 * Import: option resolution, the live-vs-rebuild decision, defaults elision
 * and its inverse — plus the `SplatsController` driven against a stub layer
 * (no THREE, no Spark, no DOM).
 */

const URL_A = 'https://tiles.test/a/{z}/{x}/{y}.spz';
const URL_B = 'https://tiles.test/b/{z}/{x}/{y}.spz';

describe('resolveSplatsOptions', () => {
  it('fills in the documented defaults', () => {
    const o = resolveSplatsOptions({ urlTemplate: URL_A });
    expect(o).toEqual({
      urlTemplate: URL_A,
      lowTierUrlTemplate: '',
      imageryTemplate: undefined,
      enabled: true,
      minZoom: 13,
      minTileZoom: 13,
      maxTileZoom: 16,
      lodBias: 1.5,
      levelSelection: 'bias',
      resolutionMargin: 0.5,
      resolutionTiltAware: true,
      lowTierLodBias: 0.5,
      maxCameraZoom: 15,
      maxCameraTilt: 45,
      radius: 1,
      maxInFlight: 4,
      maxSplats: 1_200_000,
      lowTierMaxSplats: 400_000,
      maxStdDev: Math.sqrt(5),
      lodRenderScale: 1,
      frustumCull: true,
      visibleFirst: true,
      splatMaxDistance: 0,
      lowTierSplatMaxDistance: 1200,
      splatFadeMs: 350,
      sortIntervalMs: 100,
      hideBasemap: 'covered',
      keepLabels: true,
      neutralGrade: true,
      leanMap: true,
      motionLod: true,
      motionThin: true,
      densityLod: 2,
      miniature: false,
      cover: true,
      cullBackFaces: true,
      governor: true,
      targetFrameMs: 33,
      budgetGrowth: 1,
      levelFadeMs: 350,
      transitionOvershoot: 0.35,
      prefetchBand: 0.2,
      roundedUnion: { enabled: true, feather: 0.03, growMs: 700 },
      reveal: { reveal: 'none', durationMs: 1800, speedMps: 250 }
    });
    expect(resolveSplatsOptions(undefined).urlTemplate).toBe('');
  });

  it('clamps and rejects garbage', () => {
    const o = resolveSplatsOptions({
      urlTemplate: `  ${URL_A} `,
      radius: 2.7,
      maxInFlight: 0,
      maxSplats: -5,
      lowTierMaxSplats: 0,
      maxStdDev: NaN,
      sortIntervalMs: -1,
      roundedUnion: { feather: 9, growMs: -1 },
      reveal: { reveal: 'spin' as 'ripple', durationMs: 0, speedMps: NaN, origin: { lat: 1, lon: 2 } }
    });
    expect(o.urlTemplate).toBe(URL_A);
    expect(o.radius).toBe(2);
    expect(o.maxInFlight).toBe(1);
    expect(o.maxSplats).toBe(SPLATS_DEFAULTS.maxSplats);
    expect(o.lowTierMaxSplats).toBe(0); // 0 is meaningful: off on the low tiers
    expect(o.maxStdDev).toBe(SPLATS_DEFAULTS.maxStdDev);
    expect(o.sortIntervalMs).toBe(100);
    expect(o.roundedUnion).toEqual({ enabled: true, feather: 0.25, growMs: 700 });
    expect(o.reveal).toEqual({ reveal: 'none', durationMs: 1800, speedMps: 250, origin: { lat: 1, lon: 2 } });
  });
});

describe('mergeSplatsOptions', () => {
  it('leaves absent keys alone, resets keys present as undefined, merges the two sub-objects', () => {
    const base: Partial<SplatsConfig> = {
      urlTemplate: URL_A,
      maxSplats: 500_000,
      roundedUnion: { feather: 0.1 },
      reveal: { reveal: 'ripple', durationMs: 900 }
    };
    const out = mergeSplatsOptions(base, {
      maxSplats: undefined,
      radius: 2,
      roundedUnion: { growMs: 100 },
      reveal: { durationMs: undefined, speedMps: 400 }
    });
    expect(out).toEqual({
      urlTemplate: URL_A,
      radius: 2,
      roundedUnion: { feather: 0.1, growMs: 100 },
      reveal: { reveal: 'ripple', speedMps: 400 }
    });
    expect(base.maxSplats).toBe(500_000); // not mutated
    // A boolean replaces the object outright, and an object replaces a boolean.
    expect(mergeSplatsOptions(out, { roundedUnion: false }).roundedUnion).toBe(false);
    expect(mergeSplatsOptions({ roundedUnion: false }, { roundedUnion: { growMs: 5 } }).roundedUnion).toEqual({ growMs: 5 });
  });
});

describe('planSplatsUpdate — live-apply vs rebuild', () => {
  const base = resolveSplatsOptions({ urlTemplate: URL_A });
  const plan = (patch: Partial<SplatsConfig>, hasLayer = true) =>
    planSplatsUpdate(base, resolveSplatsOptions({ urlTemplate: URL_A, ...patch }), hasLayer);

  it('nothing changed → none', () => {
    expect(plan({})).toEqual({ kind: 'none', changed: [] });
    // Spelling out the derived imagery template is not a change.
    expect(plan({ imageryTemplate: 'https://tiles.test/a/{z}/{x}/{y}.png' }).kind).toBe('none');
  });

  it.each([
    ['minZoom', { minZoom: 14 }],
    ['minTileZoom', { minTileZoom: 14 }],
    ['maxTileZoom', { maxTileZoom: 15 }],
    ['lodBias', { lodBias: -1 }],
    ['lowTierLodBias', { lowTierLodBias: -2 }],
    ['maxCameraZoom', { maxCameraZoom: 18 }],
    ['radius', { radius: 2 }],
    ['maxInFlight', { maxInFlight: 3 }],
    ['maxSplats', { maxSplats: 300_000 }],
    ['lowTierMaxSplats', { lowTierMaxSplats: 0 }],
    ['maxStdDev', { maxStdDev: 2 }],
    ['sortIntervalMs', { sortIntervalMs: 0 }],
    ['hideBasemap', { hideBasemap: false }],
    ['neutralGrade', { neutralGrade: false }],
    ['enabled', { enabled: false }],
    ['roundedUnion.feather', { roundedUnion: { feather: 0.08 } }],
    ['roundedUnion.growMs', { roundedUnion: { growMs: 0 } }],
    ['reveal', { reveal: { reveal: 'ripple' } }]
  ] as Array<[string, Partial<SplatsConfig>]>)('%s applies live', (key, patch) => {
    expect(plan(patch)).toEqual({ kind: 'live', changed: [key] });
  });

  it.each([
    ['urlTemplate', { urlTemplate: URL_B }],
    ['imageryTemplate', { imageryTemplate: 'https://img.test/{z}/{x}/{y}.png' }],
    ['imageryTemplate', { imageryTemplate: null }],
    ['roundedUnion.enabled', { roundedUnion: false }]
  ] as Array<[string, Partial<SplatsConfig>]>)('%s rebuilds the layer', (key, patch) => {
    const p = plan(patch);
    expect(p.kind).toBe('rebuild');
    expect(p.changed).toContain(key);
  });

  it('a rebuild key wins over live ones in the same patch', () => {
    expect(plan({ maxSplats: 1, roundedUnion: false }).kind).toBe('rebuild');
  });

  it('the pyramid bounds — and the deprecated zoomLevel alias — re-evaluate the level, no rebuild', () => {
    expect(plan({ zoomLevel: 15 })).toEqual({ kind: 'live', changed: ['minTileZoom', 'maxTileZoom'] });
    expect(plan({ zoomLevel: 16 })).toEqual({ kind: 'live', changed: ['minTileZoom'] });
    expect(plan({ minTileZoom: 13, maxTileZoom: 16, lodBias: 1.5, maxCameraZoom: 15 }).kind).toBe('none');
  });

  it('no layer: a URL creates it, anything else is just remembered; clearing the URL disposes', () => {
    const none = resolveSplatsOptions({});
    expect(planSplatsUpdate(none, resolveSplatsOptions({ urlTemplate: URL_A }), false).kind).toBe('create');
    expect(planSplatsUpdate(none, resolveSplatsOptions({ maxSplats: 5 }), false).kind).toBe('live');
    expect(planSplatsUpdate(none, none, false).kind).toBe('none');
    // Same URL but no layer yet (e.g. it was never built) still creates.
    expect(planSplatsUpdate(base, base, false).kind).toBe('create');
    expect(planSplatsUpdate(base, resolveSplatsOptions({ urlTemplate: '' }), true).kind).toBe('dispose');
  });

  it('diffSplatsOptions lists every changed key', () => {
    const next = resolveSplatsOptions({ urlTemplate: URL_B, radius: 0, reveal: { speedMps: 10 } });
    expect(diffSplatsOptions(base, next)).toEqual(['urlTemplate', 'radius', 'imageryTemplate', 'reveal']);
  });
});

describe('exportSplatsOptions — defaults elision', () => {
  it('never exports a block without a URL', () => {
    expect(exportSplatsOptions(resolveSplatsOptions(undefined))).toBeUndefined();
    expect(exportSplatsOptions(resolveSplatsOptions({ maxSplats: 5, reveal: { reveal: 'ripple' } }))).toBeUndefined();
  });

  it('an all-default overlay exports just its URL', () => {
    expect(exportSplatsOptions(resolveSplatsOptions({ urlTemplate: URL_A }))).toEqual({ urlTemplate: URL_A });
    // Explicit defaults — and the derived imagery template — are elided too.
    expect(
      exportSplatsOptions(
        resolveSplatsOptions({
          urlTemplate: URL_A,
          imageryTemplate: 'https://tiles.test/a/{z}/{x}/{y}.png',
          enabled: true,
          minZoom: 13,
          minTileZoom: 13,
          maxTileZoom: 16,
          lodBias: 1.5,
          lowTierLodBias: 0.5,
          maxCameraZoom: 15,
          hideBasemap: 'covered',
          keepLabels: true,
          leanMap: true,
          governor: true,
          targetFrameMs: 33,
          maxStdDev: 2.236, // a slider's rounding of √5
          roundedUnion: { feather: 0.03, growMs: 700 },
          reveal: { reveal: 'none', durationMs: 1800, speedMps: 250 },
          clock: () => 0
        })
      )
    ).toEqual({ urlTemplate: URL_A });
  });

  it('keeps exactly the non-default keys, and never the clock', () => {
    const out = exportSplatsOptions(
      resolveSplatsOptions({
        urlTemplate: URL_A,
        imageryTemplate: null,
        enabled: false,
        maxSplats: 600_000,
        lowTierMaxSplats: 0,
        neutralGrade: false,
        roundedUnion: { feather: 0.08 },
        reveal: { reveal: 'ripple', durationMs: 1200 },
        clock: () => 0
      })
    );
    expect(out).toEqual({
      urlTemplate: URL_A,
      imageryTemplate: null,
      enabled: false,
      maxSplats: 600_000,
      lowTierMaxSplats: 0,
      neutralGrade: false,
      roundedUnion: { feather: 0.08 },
      reveal: { reveal: 'ripple', durationMs: 1200 }
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out); // a JSON literal
    expect(exportSplatsOptions(resolveSplatsOptions({ urlTemplate: URL_A, roundedUnion: false }))).toEqual({
      urlTemplate: URL_A,
      roundedUnion: false
    });
  });
});

describe('import round-trip', () => {
  const live: Partial<SplatsConfig> = {
    urlTemplate: URL_A,
    maxSplats: 600_000,
    radius: 2,
    hideBasemap: false,
    roundedUnion: { feather: 0.08, growMs: 300 },
    reveal: { reveal: 'ripple', speedMps: 400 },
    maxStdDev: 1.9
  };

  it('export → JSON → replace-patch reproduces the options, from any starting state', () => {
    const exported = JSON.parse(JSON.stringify(exportSplatsOptions(resolveSplatsOptions(live)))) as SplatsConfig;
    // Start from a DIFFERENT config with other non-default keys set: the
    // patch must reset those (the export elided them as defaults).
    const other: Partial<SplatsConfig> = {
      urlTemplate: URL_B,
      minZoom: 12,
      neutralGrade: false,
      lowTierMaxSplats: 0,
      roundedUnion: false,
      reveal: { durationMs: 500 },
      clock: () => 42
    };
    const merged = mergeSplatsOptions(other, splatsReplacePatch(exported));
    expect(resolveSplatsOptions(merged)).toEqual(resolveSplatsOptions(live));
    expect(merged.clock?.()).toBe(42); // the clock is not part of a literal
    // …and exporting again is a fixed point.
    expect(exportSplatsOptions(resolveSplatsOptions(merged))).toEqual(exported);
  });

  it('tileReveal elides defaults and round-trips', () => {
    expect(exportTileReveal(resolveTileReveal(undefined))).toBeUndefined();
    expect(exportTileReveal(resolveTileReveal(true))).toBeUndefined();
    expect(exportTileReveal(resolveTileReveal(false))).toBe(false);
    expect(exportTileReveal(resolveTileReveal({ growMs: 700, feather: 0.03 }))).toBeUndefined();
    const custom = { growMs: 1200, feather: 0.06, rise: true };
    expect(exportTileReveal(resolveTileReveal(custom))).toEqual(custom);
    expect(exportTileReveal(resolveTileReveal({ growMs: 0 }))).toEqual({ growMs: 0 });
    for (const v of [false, custom, { growMs: 0 }] as const) {
      expect(resolveTileReveal(exportTileReveal(resolveTileReveal(v)))).toEqual(resolveTileReveal(v));
    }
  });
});

// ---------------------------------------------------------------------------
// SplatsController against a stub layer.
// ---------------------------------------------------------------------------

class StubLayer implements SplatsLayerLike {
  opened = 0;
  disposed = false;
  enabled: boolean;
  tier: string | null = null;
  basemapHidden = false;
  readonly applied: Array<ReturnType<typeof resolveSplatsOptions>> = [];
  readonly rebuilt: Array<ReturnType<typeof resolveSplatsOptions>> = [];
  readonly enableCalls: Array<[boolean, SplatsRevealOptions | undefined]> = [];
  constructor(readonly config: SplatsConfig) {
    this.enabled = config.enabled !== false;
  }
  async open(): Promise<void> { this.opened++; }
  setEnabled(on: boolean, opts?: SplatsRevealOptions): void {
    this.enabled = on;
    this.enableCalls.push([on, opts]);
  }
  isEnabled(): boolean { return this.enabled; }
  getStats(): SplatsStats {
    return {
      tiles: 3, tileZoom: 16, splats: 30, maxSplats: 100, reveal: 'none', basemapHidden: this.basemapHidden,
      basemapCovered: false,
      governor: { enabled: true, frameMs: 0, targetFrameMs: 33, scale: 1, maxScale: 1, biasDrop: 0 , splatMaxDistance: 0, thinKeep: 1 }
    };
  }
  applyOptions(o: ReturnType<typeof resolveSplatsOptions>): void { this.applied.push(o); }
  rebuild(o: ReturnType<typeof resolveSplatsOptions>): void { this.rebuilt.push(o); }
  setQualityTier(tier: 'low' | 'mobile' | 'high'): void { this.tier = tier; }
  update(): void {}
  dispose(): void { this.disposed = true; }
}

function makeController(initial?: Partial<SplatsConfig>) {
  const layers: StubLayer[] = [];
  const neutral: boolean[] = [];
  const zoomCaps: Array<number | null> = [];
  const onChange = vi.fn();
  const ctl = new SplatsController(
    {
      createLayer: (config) => {
        const l = new StubLayer(config);
        layers.push(l);
        return l;
      },
      onNeutralGradeChange: (on) => neutral.push(on),
      onCameraZoomCapChange: (z) => zoomCaps.push(z),
      onChange
    },
    initial
  );
  return { ctl, layers, neutral, zoomCaps, onChange };
}

describe('SplatsController.setOptions', () => {
  it('without a URL there is no layer, no cost, and zeroed stats', () => {
    const { ctl, layers } = makeController();
    expect(layers).toHaveLength(0);
    expect(ctl.layer).toBeNull();
    expect(ctl.isEnabled()).toBe(false);
    expect(ctl.getStats()).toEqual({
      tiles: 0, tileZoom: 0, splats: 0, maxSplats: 0, reveal: 'none', basemapHidden: false,
      basemapCovered: false,
      governor: { enabled: false, frameMs: 0, targetFrameMs: 0, scale: 1, maxScale: 1, biasDrop: 0, splatMaxDistance: 0, thinKeep: 1 }
    });
    expect(ctl.getOptions().urlTemplate).toBe('');
    // Options set ahead of the URL are remembered, still without a layer.
    expect(ctl.setOptions({ maxSplats: 250_000 }).kind).toBe('live');
    expect(layers).toHaveLength(0);
    expect(ctl.getOptions().maxSplats).toBe(250_000);
  });

  it('a pasted URL CREATES the layer at runtime — opened on the spot once the map is open, on the current tier', async () => {
    const { ctl, layers } = makeController();
    ctl.setQualityTier('mobile');
    await ctl.open(); // map.init() ran with nothing to open
    ctl.setOptions({ maxSplats: 250_000 });
    const plan = ctl.setOptions({ urlTemplate: URL_A, enabled: false, reveal: { reveal: 'ripple' } });
    expect(plan.kind).toBe('create');
    expect(layers).toHaveLength(1);
    expect(layers[0].config).toMatchObject({ urlTemplate: URL_A, enabled: false, maxSplats: 250_000 });
    expect(layers[0].opened).toBe(1);
    expect(layers[0].tier).toBe('mobile');
    expect(ctl.isEnabled()).toBe(false);
  });

  it('before open(), a created layer waits for the map to open it', async () => {
    const { ctl, layers } = makeController({ urlTemplate: URL_A });
    expect(layers[0].opened).toBe(0);
    await ctl.open();
    expect(layers[0].opened).toBe(1);
  });

  it('cheap options go to the running layer; nothing is rebuilt', async () => {
    const { ctl, layers, onChange } = makeController({ urlTemplate: URL_A });
    await ctl.open();
    const plan = ctl.setOptions({ maxSplats: 300_000, radius: 2, roundedUnion: { feather: 0.1 }, maxStdDev: 2 });
    expect(plan.kind).toBe('live');
    expect(layers).toHaveLength(1);
    expect(layers[0].disposed).toBe(false);
    expect(layers[0].applied).toHaveLength(1);
    expect(layers[0].applied[0]).toMatchObject({
      maxSplats: 300_000,
      radius: 2,
      maxStdDev: 2,
      roundedUnion: { enabled: true, feather: 0.1, growMs: 700 }
    });
    expect(onChange).toHaveBeenCalled();
    // A no-op patch does nothing at all.
    onChange.mockClear();
    expect(ctl.setOptions({ maxSplats: 300_000 }).kind).toBe('none');
    expect(layers[0].applied).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('urlTemplate / imageryTemplate / union on-off REBUILD the same layer (Spark renderer kept), with the whole config', async () => {
    const { ctl, layers } = makeController({ urlTemplate: URL_A, maxSplats: 300_000 });
    await ctl.open();
    ctl.setEnabled(false);
    expect(ctl.setOptions({ urlTemplate: URL_B, radius: 2 }).kind).toBe('rebuild');
    expect(layers).toHaveLength(1);
    expect(layers[0].disposed).toBe(false);
    expect(layers[0].applied).toHaveLength(0); // rebuild() applies the live options itself
    expect(layers[0].rebuilt[0]).toMatchObject({ urlTemplate: URL_B, maxSplats: 300_000, radius: 2, enabled: false });
    expect(layers[0].enableCalls).toHaveLength(1); // only the explicit toggle above — nothing replayed

    expect(ctl.setOptions({ roundedUnion: false }).kind).toBe('rebuild');
    // The pyramid bounds are live: the layer re-evaluates its level itself.
    expect(ctl.setOptions({ zoomLevel: 17 }).kind).toBe('live');
    expect(layers[0].applied[0]).toMatchObject({ minTileZoom: 17, maxTileZoom: 17 });
    expect(ctl.setOptions({ imageryTemplate: null }).kind).toBe('rebuild');
    expect(layers).toHaveLength(1);
    expect(layers[0].rebuilt).toHaveLength(3);
    expect(layers[0].rebuilt[2]).toMatchObject({
      urlTemplate: URL_B, minTileZoom: 17, maxTileZoom: 17, imageryTemplate: null,
      roundedUnion: { enabled: false }
    });

    // A rebuild that also flips `enabled` toggles through the configured reveal.
    ctl.setOptions({ urlTemplate: URL_A, enabled: true, reveal: { reveal: 'ripple' } });
    expect(layers[0].enableCalls[1]).toEqual([true, { reveal: 'ripple', durationMs: 1800, speedMps: 250 }]);

    // Clearing the URL removes the overlay; the other options are kept, and a
    // new URL creates a fresh layer from them.
    expect(ctl.setOptions({ urlTemplate: '' }).kind).toBe('dispose');
    expect(layers[0].disposed).toBe(true);
    expect(ctl.layer).toBeNull();
    expect(ctl.getOptions().maxSplats).toBe(300_000);
    expect(ctl.setOptions({ urlTemplate: URL_B }).kind).toBe('create');
    expect(layers).toHaveLength(2);
    expect(layers[1].config).toMatchObject({ urlTemplate: URL_B, maxSplats: 300_000, zoomLevel: 17 });
    expect(layers[1].opened).toBe(1);
  });

  it('neutralGrade flips take effect at once while the basemap is held hidden', () => {
    const { ctl, layers, neutral } = makeController({ urlTemplate: URL_A });
    ctl.setOptions({ neutralGrade: false });
    expect(neutral).toEqual([]); // nothing showing → nothing to release
    layers[0].basemapHidden = true;
    ctl.setOptions({ neutralGrade: true });
    ctl.setOptions({ neutralGrade: false });
    expect(neutral).toEqual([true, false]);
    expect(ctl.getOptions().neutralGrade).toBe(false);
  });

  it('importing an exported literal (replace patch) creates the layer and resets elided keys', () => {
    const { ctl, layers } = makeController();
    ctl.setOptions({ minZoom: 12 }); // stale local tweak the import must not keep
    const literal = exportSplatsOptions(
      resolveSplatsOptions({ urlTemplate: URL_A, maxSplats: 600_000, reveal: { reveal: 'ripple' } })
    )!;
    expect(ctl.setOptions(splatsReplacePatch(literal)).kind).toBe('create');
    expect(layers).toHaveLength(1);
    expect(ctl.getOptions()).toEqual(
      resolveSplatsOptions({ urlTemplate: URL_A, maxSplats: 600_000, reveal: { reveal: 'ripple' } })
    );
    expect(exportSplatsOptions(ctl.getOptions())).toEqual(literal);
  });
});

describe('SplatsController.setEnabled — reveal defaults', () => {
  it('a plain toggle uses the configured reveal; per-call opts are laid over it', () => {
    const { ctl, layers } = makeController({
      urlTemplate: URL_A,
      reveal: { reveal: 'ripple', durationMs: 1200 }
    });
    ctl.setEnabled(false);
    ctl.setEnabled(true, { speedMps: 500 });
    ctl.setEnabled(false, { reveal: 'none' });
    expect(layers[0].enableCalls).toEqual([
      [false, { reveal: 'ripple', durationMs: 1200, speedMps: 250 }],
      [true, { reveal: 'ripple', durationMs: 1200, speedMps: 500 }],
      [false, { reveal: 'none', durationMs: 1200, speedMps: 250 }]
    ]);
  });

  it('defaults to instant, follows live changes to `reveal`, and remembers the choice in the config', () => {
    const { ctl, layers } = makeController({ urlTemplate: URL_A });
    ctl.setEnabled(false);
    expect(layers[0].enableCalls[0]).toEqual([false, { reveal: 'none', durationMs: 1800, speedMps: 250 }]);
    expect(ctl.getOptions().enabled).toBe(false);
    expect(exportSplatsOptions(ctl.getOptions())).toEqual({ urlTemplate: URL_A, enabled: false });

    expect(ctl.setOptions({ reveal: { reveal: 'ripple', origin: { lat: 1, lon: 2 } } }).kind).toBe('live');
    ctl.setEnabled(true);
    expect(layers[0].enableCalls[1]).toEqual([
      true,
      { reveal: 'ripple', durationMs: 1800, speedMps: 250, origin: { lat: 1, lon: 2 } }
    ]);
    // `enabled` through setOptions is the same toggle (same reveal).
    ctl.setOptions({ enabled: false });
    expect(layers[0].enableCalls[2][0]).toBe(false);
    expect(layers[0].enableCalls[2][1]).toMatchObject({ reveal: 'ripple' });
  });

  it('is a remembered no-op without a layer', () => {
    const { ctl, layers } = makeController();
    ctl.setEnabled(false);
    ctl.setOptions({ urlTemplate: URL_A });
    expect(layers[0].config.enabled).toBe(false);
  });

  it('resolveRevealCall ignores undefined fields', () => {
    const d = resolveSplatsOptions({ reveal: { reveal: 'ripple' } }).reveal;
    expect(resolveRevealCall(d, { reveal: undefined, durationMs: 10 })).toEqual({
      reveal: 'ripple', durationMs: 10, speedMps: 250
    });
  });
});

describe('tile-pyramid options', () => {
  it('zoomLevel is a deprecated alias that pins both bounds; the new keys win over it', () => {
    expect(resolveSplatsOptions({ urlTemplate: URL_A, zoomLevel: 15 })).toMatchObject({
      minTileZoom: 15, maxTileZoom: 15
    });
    expect(resolveSplatsOptions({ urlTemplate: URL_A, zoomLevel: 16, minTileZoom: 14 })).toMatchObject({
      minTileZoom: 14, maxTileZoom: 16
    });
    expect('zoomLevel' in resolveSplatsOptions({ urlTemplate: URL_A, zoomLevel: 15 })).toBe(false);
  });

  it('floors, clamps, and repairs an inverted pair toward the explicit bound', () => {
    expect(resolveSplatsOptions({ minTileZoom: 13.9, maxTileZoom: 99 })).toMatchObject({
      minTileZoom: 13, maxTileZoom: 24
    });
    // Only `minTileZoom` given, above the default max → the max follows it.
    expect(resolveSplatsOptions({ minTileZoom: 18 })).toMatchObject({ minTileZoom: 18, maxTileZoom: 18 });
    // Only `maxTileZoom` given, below the default min → the min follows it.
    expect(resolveSplatsOptions({ maxTileZoom: 11 })).toMatchObject({ minTileZoom: 11, maxTileZoom: 11 });
    // Both given and inverted → collapse onto the max.
    expect(resolveSplatsOptions({ minTileZoom: 16, maxTileZoom: 14 })).toMatchObject({
      minTileZoom: 14, maxTileZoom: 14
    });
    expect(resolveSplatsOptions({ lodBias: NaN, maxCameraZoom: -3 })).toMatchObject({
      lodBias: 1.5, lowTierLodBias: 0.5, maxCameraZoom: 15
    });
  });

  it('exports only what differs — and never the deprecated alias', () => {
    expect(
      exportSplatsOptions(
        resolveSplatsOptions({ urlTemplate: URL_A, zoomLevel: 15, lodBias: -0.5, maxCameraZoom: 18 })
      )
    ).toEqual({ urlTemplate: URL_A, minTileZoom: 15, maxTileZoom: 15, lodBias: -0.5, maxCameraZoom: 18 });
    expect(
      exportSplatsOptions(resolveSplatsOptions({ urlTemplate: URL_A, lowTierLodBias: 0 }))
    ).toEqual({ urlTemplate: URL_A, lowTierLodBias: 0 });
  });

  it('an imported literal replaces the pyramid keys (elided → back to the defaults)', () => {
    const stored: Partial<SplatsConfig> = {
      urlTemplate: URL_A, zoomLevel: 15, minTileZoom: 12, lodBias: -1, maxCameraZoom: 19
    };
    const next = resolveSplatsOptions(
      mergeSplatsOptions(stored, splatsReplacePatch({ urlTemplate: URL_A, maxTileZoom: 15 }))
    );
    expect(next).toMatchObject({ minTileZoom: 13, maxTileZoom: 15, lodBias: 1.5, maxCameraZoom: 15 });
  });
});

describe('SplatsController — camera zoom cap (maxCameraZoom)', () => {
  it('caps the camera while the overlay is on and lifts the cap when it goes off', () => {
    const { ctl, zoomCaps } = makeController({ urlTemplate: URL_A });
    expect(zoomCaps).toEqual([15]); // enabled by default → capped from the start
    ctl.setEnabled(false);
    expect(zoomCaps).toEqual([15, null]); // previous limit back
    ctl.setEnabled(true);
    expect(zoomCaps).toEqual([15, null, 15]);
    ctl.setEnabled(true); // no change → no call
    expect(zoomCaps).toHaveLength(3);
  });

  it('maxCameraZoom applies live; `enabled` through the options counts too', () => {
    const { ctl, layers, zoomCaps } = makeController({ urlTemplate: URL_A, maxCameraZoom: 18 });
    expect(zoomCaps).toEqual([18]);
    expect(ctl.setOptions({ maxCameraZoom: 16.5 })).toEqual({ kind: 'live', changed: ['maxCameraZoom'] });
    expect(zoomCaps).toEqual([18, 16.5]);
    expect(layers).toHaveLength(1); // no rebuild
    ctl.setOptions({ enabled: false });
    expect(zoomCaps).toEqual([18, 16.5, null]);
  });

  it('no overlay → no cap: created with the URL, lifted when the URL is cleared or on dispose', () => {
    const { ctl, zoomCaps } = makeController({ maxCameraZoom: 16 });
    expect(zoomCaps).toEqual([]);
    ctl.setOptions({ urlTemplate: URL_A });
    expect(zoomCaps).toEqual([16]);
    ctl.setOptions({ urlTemplate: '' });
    expect(zoomCaps).toEqual([16, null]);
    ctl.setOptions({ urlTemplate: URL_A });
    ctl.dispose();
    expect(zoomCaps).toEqual([16, null, 16, null]);
  });

  it('an overlay held off by the quality tier does not cap the camera', () => {
    const { ctl, layers, zoomCaps } = makeController({ urlTemplate: URL_A });
    layers[0].enabled = false; // what the real layer reports when the tier gates it
    ctl.setQualityTier('low');
    expect(zoomCaps).toEqual([15, null]);
  });
});

describe("hideBasemap: 'covered', keepLabels, governor, targetFrameMs", () => {
  it('resolve: covered unless told otherwise; booleans keep their old meaning', () => {
    expect(resolveSplatsOptions({}).hideBasemap).toBe('covered');
    expect(resolveSplatsOptions({ hideBasemap: 'covered' }).hideBasemap).toBe('covered');
    expect(resolveSplatsOptions({ hideBasemap: true }).hideBasemap).toBe(true);
    expect(resolveSplatsOptions({ hideBasemap: false }).hideBasemap).toBe(false);
    // Garbage falls back to the default.
    expect(resolveSplatsOptions({ hideBasemap: 'nope' as unknown as boolean }).hideBasemap).toBe('covered');
    expect(resolveSplatsOptions({ keepLabels: false, governor: false })).toMatchObject({
      keepLabels: false, governor: false
    });
    // leanMap: on unless switched off; anything but `false` means on.
    expect(resolveSplatsOptions({}).leanMap).toBe(true);
    expect(resolveSplatsOptions({ leanMap: false }).leanMap).toBe(false);
    expect(resolveSplatsOptions({ leanMap: undefined }).leanMap).toBe(true);
    expect(resolveSplatsOptions({ targetFrameMs: 50 }).targetFrameMs).toBe(50);
    expect(resolveSplatsOptions({ targetFrameMs: 2 }).targetFrameMs).toBe(8); // nothing to measure under 8 ms
    expect(resolveSplatsOptions({ targetFrameMs: -1 }).targetFrameMs).toBe(33);
    expect(resolveSplatsOptions({ targetFrameMs: NaN }).targetFrameMs).toBe(33);
  });

  it('the default bias is 1.5, the low tiers one level coarser — and fractions select as documented', () => {
    const o = resolveSplatsOptions({});
    expect([o.lodBias, o.lowTierLodBias]).toEqual([1.5, 0.5]);
    const p = { minTileZoom: o.minTileZoom, maxTileZoom: o.maxTileZoom, lodBias: o.lodBias };
    expect(selectTileZoom(13, null, p)).toBe(14); // at minZoom: floor(14.5)
    expect(selectTileZoom(14.4, null, p)).toBe(15);
    expect(selectTileZoom(14.5, null, p)).toBe(16); // half a zoom early
    expect(selectTileZoom(17, null, p)).toBe(16); // clamped to the pyramid
    // Hysteresis still straddles the (shifted) boundary.
    expect(selectTileZoom(14.6, 15, p)).toBe(15);
    expect(selectTileZoom(14.7, 15, p)).toBe(16);
    expect(selectTileZoom(14.4, 16, p)).toBe(16);
    expect(selectTileZoom(14.3, 16, p)).toBe(15);
    expect(selectTileZoom(14.5, null, { ...p, lodBias: o.lowTierLodBias })).toBe(15);
  });

  it('all four are applied LIVE — no rebuild', () => {
    const base = resolveSplatsOptions({ urlTemplate: URL_A });
    const next = (patch: Partial<SplatsConfig>) =>
      planSplatsUpdate(base, resolveSplatsOptions({ urlTemplate: URL_A, ...patch }), true);
    expect(next({ hideBasemap: true })).toEqual({ kind: 'live', changed: ['hideBasemap'] });
    expect(next({ hideBasemap: false })).toEqual({ kind: 'live', changed: ['hideBasemap'] });
    expect(next({ hideBasemap: 'covered' }).kind).toBe('none');
    expect(next({ keepLabels: false })).toEqual({ kind: 'live', changed: ['keepLabels'] });
    expect(next({ governor: false, targetFrameMs: 16 })).toEqual({ kind: 'live', changed: ['governor', 'targetFrameMs'] });
  });

  it('export elides the defaults and round-trips the rest; an import resets what it leaves out', () => {
    expect(exportSplatsOptions(resolveSplatsOptions({
      urlTemplate: URL_A, hideBasemap: 'covered', keepLabels: true, governor: true, targetFrameMs: 33, lodBias: 1.5,
      lowTierLodBias: 0.5
    }))).toEqual({ urlTemplate: URL_A });
    const literal = exportSplatsOptions(resolveSplatsOptions({
      urlTemplate: URL_A, hideBasemap: true, keepLabels: false, governor: false, targetFrameMs: 20, lodBias: 0
    }));
    expect(literal).toEqual({
      urlTemplate: URL_A, hideBasemap: true, keepLabels: false, governor: false, targetFrameMs: 20, lodBias: 0
    });
    expect(exportSplatsOptions(resolveSplatsOptions({ urlTemplate: URL_A, hideBasemap: false })))
      .toEqual({ urlTemplate: URL_A, hideBasemap: false });
    // Round trip.
    expect(resolveSplatsOptions(literal)).toEqual(resolveSplatsOptions({
      urlTemplate: URL_A, hideBasemap: true, keepLabels: false, governor: false, targetFrameMs: 20, lodBias: 0
    }));
    // Importing a literal that leaves them out puts every one back on its default.
    const stored: Partial<SplatsConfig> = {
      urlTemplate: URL_A, hideBasemap: true, keepLabels: false, governor: false, targetFrameMs: 20
    };
    expect(resolveSplatsOptions(mergeSplatsOptions(stored, splatsReplacePatch({ urlTemplate: URL_A }))))
      .toMatchObject({ hideBasemap: 'covered', keepLabels: true, governor: true, targetFrameMs: 33 });
  });

  it('the controller forwards governor frames and the cover state to the layer', () => {
    const { ctl, layers } = makeController({ urlTemplate: URL_A });
    const seen: Array<[number, boolean]> = [];
    Object.assign(layers[0], {
      reportFrame: (dt: number, moving: boolean) => { seen.push([dt, moving]); },
      isCovering: () => true,
      isHidingBasemap: () => false,
      hasTiles: () => true,
      governorFrameMs: () => 41
    });
    ctl.reportFrame(20, true);
    expect(seen).toEqual([[20, true]]);
    expect([ctl.isCovering(), ctl.isHidingBasemap(), ctl.hasTiles(), ctl.governorFrameMs, ctl.neutralGrade])
      .toEqual([true, false, true, 41, true]);
    // No layer: all quiet.
    const none = makeController().ctl;
    none.reportFrame(20, true);
    expect([none.isCovering(), none.hasTiles(), none.governorFrameMs]).toEqual([false, false, 0]);
  });
});

describe('imagery candidates (WebP first, PNG fallback, @2x on capable devices)', () => {
  it('a derived template tries .webp then .png; @2x.webp leads when hiRes', async () => {
    const { imageryCandidates } = await import('../src/splats/options.js');
    const t = 'https://t/{z}/{x}/{y}.png';
    expect(imageryCandidates(t, true, false)).toEqual(['https://t/{z}/{x}/{y}.webp', t]);
    expect(imageryCandidates(t, true, true)).toEqual([
      'https://t/{z}/{x}/{y}@2x.webp', 'https://t/{z}/{x}/{y}.webp', t
    ]);
  });

  it('an explicit template is used as given, and query strings survive the swap', async () => {
    const { imageryCandidates, imageryIsDerived } = await import('../src/splats/options.js');
    expect(imageryCandidates('https://cdn/{z}/{x}/{y}.jpg', false, true)).toEqual(['https://cdn/{z}/{x}/{y}.jpg']);
    expect(imageryCandidates('https://t/{z}/{x}/{y}.png?v=3', true, false)[0]).toBe('https://t/{z}/{x}/{y}.webp?v=3');
    expect(imageryIsDerived({ imageryTemplate: undefined })).toBe(true);
    expect(imageryIsDerived({ imageryTemplate: '' })).toBe(true);
    expect(imageryIsDerived({ imageryTemplate: 'https://cdn/{z}/{x}/{y}.jpg' })).toBe(false);
  });
});

describe('every option reaches the live path', () => {
  it('no option is assigned in the constructor but forgotten in applyOptions', async () => {
    // A constructor-only option looks fine on a page reload and silently does nothing when set
    // at runtime — which is exactly how `splatMaxDistance` and four others shipped broken.
    const fs = await import('node:fs/promises');
    const url = new URL('../src/splats/SplatsLayer.ts', import.meta.url);
    const src = await fs.readFile(url, 'utf8');
    const body = (start: string): string => {
      const i = src.indexOf(start);
      expect(i, `could not find ${start}`).toBeGreaterThan(-1);
      return src.slice(i, src.indexOf('\n  }\n', i));
    };
    const names = (text: string): Set<string> =>
      new Set([...text.matchAll(/this\.\w+\s*=\s*o\.(\w+)\s*;/g)].map((m) => m[1]));
    const ctor = names(body('const o = resolveSplatsOptions(config);'));
    const live = names(body('applyOptions(o: ResolvedSplatsOptions): void {'));
    // `enabled` and the two tile templates have their own paths (setEnabled / rebuild).
    const exempt = new Set(['enabled', 'urlTemplate', 'lowTierUrlTemplate']);
    const missing = [...ctor].filter((k) => !live.has(k) && !exempt.has(k)).sort();
    expect(missing, `constructor-only options: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('lowTierUrlTemplate — a lite pyramid for weak devices', () => {
  it('is empty unless given, trimmed when given, and exported only when set', () => {
    expect(resolveSplatsOptions({ urlTemplate: URL_A }).lowTierUrlTemplate).toBe('');
    const o = resolveSplatsOptions({ urlTemplate: URL_A, lowTierUrlTemplate: '  https://lite.test/{z}/{x}/{y}.spz ' });
    expect(o.lowTierUrlTemplate).toBe('https://lite.test/{z}/{x}/{y}.spz');
    expect(exportSplatsOptions(o)).toEqual({ urlTemplate: URL_A, lowTierUrlTemplate: 'https://lite.test/{z}/{x}/{y}.spz' });
  });

  it('changing it is a rebuild, like changing the main template', () => {
    const a = resolveSplatsOptions({ urlTemplate: URL_A });
    const b = resolveSplatsOptions({ urlTemplate: URL_A, lowTierUrlTemplate: 'https://lite.test/{z}/{x}/{y}.spz' });
    expect(diffSplatsOptions(a, b)).toEqual(['lowTierUrlTemplate']);
    expect(planSplatsUpdate(a, b, true).kind).toBe('rebuild');
  });
});
