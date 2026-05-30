/**
 * Configuration for the optional parcels overlay. When `pmtilesUrl` is set
 * (and `enabled` is not explicitly false) the map opens a SECOND PMTiles
 * archive — separate from the basemap `pmtiles_url` — and renders county
 * parcel boundary polygons ("boxes") on top of the basemap.
 *
 * Off by default: a map constructed without a `parcels` option behaves
 * exactly as before and pays zero cost for this feature.
 */
export interface ParcelsConfig {
  /**
   * URL of the parcels PMTiles archive (e.g. an https URL or a `pmtiles://`
   * source). This is the only required field — its presence is what turns the
   * overlay on. The archive is expected to carry a single MVT layer named
   * `parcels` whose features are Polygons with at least a `parcel_id`
   * property (the Ada County tiles also carry `owner_name`, `site_address`,
   * `city`, `zip_code`, `property_class`, `land_use_desc`, `land_value`,
   * `improvement_value`, `total_value`, `acreage`).
   */
  pmtilesUrl: string;
  /**
   * Master on/off switch. Defaults to `true` when `pmtilesUrl` is set —
   * pass `false` to construct the overlay machinery but keep it hidden /
   * inactive (toggle later with `map.setParcelsEnabled(true)`).
   */
  enabled?: boolean;
  /** Hex color of the parcel boundary strokes. Default `'#374151'`. */
  lineColor?: string;
  /** Hex color of the optional faint fill. Default matches `lineColor`. */
  fillColor?: string;
  /**
   * Opacity (0..1) of the faint fill that sits inside each parcel boundary.
   * 0 (the default) draws outlines only — the lightest, least-cluttered look
   * for dense parcel grids. Raise it for a tinted fill.
   */
  fillOpacity?: number;
  /**
   * Minimum CAMERA zoom at which parcels draw. Parcels are dense, so they're
   * hidden when zoomed out. Default 15. Below this the overlay loads nothing
   * and renders nothing.
   */
  minZoom?: number;
}

/** Payload passed to `onParcelClick` subscribers. */
export interface ParcelClickEvent {
  /**
   * Stable parcel identifier — the feature's `parcel_id` MVT property when
   * present, otherwise a synthesized fallback. Use this to key your own data.
   */
  id: string;
  /** The clicked parcel feature's full MVT property bag. */
  properties: Record<string, string | number | boolean>;
  /**
   * Geographic location of the click on the parcel (the ground point the
   * ray hit), when it could be resolved.
   */
  lngLat?: { lat: number; lon: number };
}

/** Unsubscribe handle returned by `onParcelClick`. */
export type ParcelClickListener = (parcel: ParcelClickEvent) => void;
