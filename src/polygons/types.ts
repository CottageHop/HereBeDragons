/** A single (lat, lon) vertex of a custom polygon. */
export interface PolygonPoint {
  lat: number;
  lon: number;
}

/** Options passed to `map.addPolygon(...)`. */
export interface PolygonOptions {
  /** Stable id used by removePolygon / getPolygon. */
  id: string;
  /**
   * Outer ring of the polygon as an ordered list of (lat, lon) points. Need
   * not repeat the first point at the end — the ring is closed automatically.
   * Either winding order works; earcut handles both.
   */
  points: PolygonPoint[];
  /**
   * Inner rings (holes). Each hole is an array of (lat, lon) points, same
   * winding rules as `points`. Optional.
   */
  holes?: PolygonPoint[][];
  /** Hex fill color, e.g. '#3b82f6'. */
  color: string;
  /** Fill opacity 0..1. Default 0.55 so the underlying map shows through. */
  opacity?: number;
  /**
   * Height in meters above the ground plane (Y=0). Default 2 — high enough
   * to clear water/landuse z-fighting but low enough to feel ground-attached.
   */
  elevation?: number;
  /** Arbitrary developer payload accessible via the returned handle. */
  data?: unknown;
}

/** Handle returned by `addPolygon`, used to mutate or remove the polygon later. */
export interface PolygonHandle {
  readonly id: string;
  readonly data: unknown;
  setColor(color: string): void;
  setOpacity(opacity: number): void;
  setPoints(points: PolygonPoint[], holes?: PolygonPoint[][]): void;
  remove(): void;
}
