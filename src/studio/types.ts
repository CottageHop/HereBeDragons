import type { HereBeDragonsOptions, LayerName } from '../types.js';
import type { ThemeColors } from '../themes.js';

/** Options accepted by `createMapStudio(map, options?)`. */
export interface StudioOptions {
  /**
   * Where to mount the studio panel. Defaults to the map's container (the
   * panel floats over the top-right corner of the canvas).
   */
  container?: HTMLElement;
  /** Inject default CSS once on construction. Default: true. */
  injectDefaultStyles?: boolean;
  /** Initial open/closed state of the panel. Default: true. */
  open?: boolean;
  /** Show the compass overlay. Default: true. */
  compass?: boolean;
  /**
   * Theme names to show in the studio's theme picker. Order is preserved.
   * Unknown names are skipped. Default: every theme registered in `THEMES`.
   *
   * Pass an empty array to hide the Theme section entirely.
   */
  themes?: string[];
  /**
   * Original `HereBeDragonsOptions` (or relevant subset) used to bootstrap the
   * map. Populates the exported config's non-queryable fields (pmtiles_url,
   * pixelRatio, background) so the JSON round-trips into createHereBeDragons.
   */
  initialConfig?: Partial<HereBeDragonsOptions>;
  /**
   * Optional callback for "Export" — receives the JSON config that would be
   * downloaded. Return `false` to suppress the default file-download behavior.
   */
  onExport?: (config: StudioConfig) => boolean | void;
}

/**
 * JSON snapshot emitted by the studio. Same shape as `HereBeDragonsOptions` —
 * pass it straight into `createHereBeDragons(container, config)` and the
 * declarative `theme` / `customColors` / `clouds` / `compass` fields get
 * applied automatically. The alias exists as a distinct name so application
 * code can label "this came from Studio" vs. "this is hand-built options."
 */
export type StudioConfig = HereBeDragonsOptions;

/** Handle returned by `createMapStudio()`. */
export interface MapStudio {
  /** Read the current config without exporting. */
  getConfig(): StudioConfig;
  /** Trigger the export flow (download JSON or invoke onExport). */
  export(): StudioConfig;
  /** Show or hide the panel. */
  setOpen(open: boolean): void;
  /** Tear down DOM + listeners. */
  destroy(): void;
}

/** Re-exported here for studio-internal convenience. */
export type { LayerName, ThemeColors };
