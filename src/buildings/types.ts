/**
 * Publicly-visible information about a building that the developer can render
 * inside a custom popup or use to look up external property data. Mirrors a
 * subset of the worker-side `BuildingMeta` plus runtime-only state (current
 * floor selection, world-space centroid).
 */
export interface BuildingInfo {
  /** Stable id — either the MVT feature id, or a synthesized `z/x/y/index`. */
  id: string;
  /** Extruded height in world meters. */
  height: number;
  /** Number of floors if present in the MVT properties. */
  levels?: number;
  /** Footprint area in m² (outer ring, holes ignored). */
  footprintArea: number;
  /** World-meter centroid of the building's footprint. */
  centroid: { x: number; z: number };
  /** Untouched MVT properties — name, address, building type, etc. */
  properties: Record<string, string | number | boolean>;
  /** When the building was opened via a tag-with-floor, the floor number (1-indexed). */
  floor?: number;
}

/** Return value of a popup-render function. */
export type BuildingPopupContent =
  | HTMLElement
  | { title?: string; body?: string; className?: string }
  | null
  | undefined;

export interface BuildingPopupConfig {
  /**
   * Whether building picking is enabled at all. Default true. Disable to
   * stop click→raycast entirely (no selection, no highlight, no popup).
   */
  enabled?: boolean;
  /**
   * Whether the popup itself is shown when a building is selected. Default
   * false — selection still highlights the building, but no popup appears.
   * Flip to true when the developer wants the floating popup UI.
   */
  popupEnabled?: boolean;
  /**
   * Render the popup body for a given building. Return null to suppress the
   * popup entirely (e.g. when no property data is available). If omitted,
   * the default renderer is used: shows name/address if present, otherwise
   * a minimal "Building" placeholder.
   */
  render?: (info: BuildingInfo) => BuildingPopupContent;
  /** Inject default CSS once. Default true. */
  injectDefaultStyles?: boolean;
  /**
   * Color of the silhouette wireframe drawn around a selected building.
   * Default '#00d4ff' (cyan). The active theme can also set this via
   * `ThemeColors.highlight.building`; an explicit value here wins.
   */
  highlightColor?: string;
  /**
   * Color of the floor band rendered when a tag pins a floor (or the dev
   * calls `selectBuilding(id, floor)`). Default '#f97316' (orange).
   */
  floorColor?: string;
}

export interface BuildingClickEvent {
  type: 'buildingclick';
  info: BuildingInfo;
}
