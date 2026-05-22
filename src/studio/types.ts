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
 * JSON snapshot emitted by the studio. Same shape as `HereBeDragonsOptions`
 * except `pmtiles_url` is optional: the studio deliberately omits the tile
 * source URL from exports (it's environment-specific and often private), so
 * add it back before passing the config into `createHereBeDragons`. The
 * declarative `theme` / `customColors` / `clouds` / `compass` fields still
 * apply automatically on import. The distinct name lets application code
 * label "this came from Studio" vs. "this is hand-built options."
 */
export type StudioConfig = Omit<HereBeDragonsOptions, 'pmtiles_url'> & {
  /** Omitted from studio exports by design — supply it before constructing a map. */
  pmtiles_url?: string;
};

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
