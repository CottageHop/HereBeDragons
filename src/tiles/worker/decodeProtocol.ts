import type { LayerName } from '../../types.js';

/**
 * One pre-split per-class chunk of a LayerGeometry. The worker emits these
 * for class-keyed layers (landuse, roads, rails) so the main thread can
 * upload each chunk directly without re-walking the index buffer.
 */
export interface SubmeshGeometry {
  classId: number;
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
}

/** Decoded geometry for a single layer in a single tile. */
export interface LayerGeometry {
  positions: Float32Array; // XYZ triples
  indices: Uint32Array;
  normals?: Float32Array;
  /**
   * Pre-split per-class submeshes. Present when the worker has already done
   * the splitByClass pass (landuse/roads/rails); consumers should prefer
   * these over re-splitting `positions + indices + attributes.class`.
   */
  submeshes?: SubmeshGeometry[];
  /** Optional per-feature attribute arrays (length = feature count). */
  attributes?: Record<string, Float32Array | Uint8Array | Uint32Array>;
  /**
   * Non-typed-array side data — e.g. label text strings. Carried alongside
   * the typed arrays in the worker message. Cannot be transferred zero-copy
   * but structured-clone handles strings/arrays-of-strings cheaply.
   */
  metadata?: Record<string, unknown>;
  /**
   * Polyline data for downstream consumers (e.g. car simulation). Computed
   * by the roads extractor and stashed on the road mesh so CarsLayer can
   * follow it. Not rendered directly.
   *  - `positions`: flat (X, Z) pairs, in scene-world meters.
   *  - `ranges`: pairs of (startVertexIndex, endVertexIndex) marking each
   *     polyline's slice in `positions` (indices are in XZ-pair units).
   *  - `classes`: one byte per polyline (matching RoadClass).
   */
  lines?: {
    positions: Float32Array;
    ranges: Uint32Array;
    classes: Uint8Array;
  };
  /**
   * Bridge centerlines, split out of the flat road ribbon by the roads
   * extractor (features tagged `is_bridge`). Same layout as `lines`. Not
   * rendered per-tile: the BridgesManager collects these across every loaded
   * tile, stitches the per-tile pieces into complete spans by matching shared
   * endpoints, and builds one continuous arched deck mesh per span — so a
   * bridge clipped across tile boundaries still rises as a single smooth arch.
   *  - `positions`: flat (X, Z) pairs, in scene-world meters.
   *  - `ranges`: pairs of (startVertexIndex, endVertexIndex) per polyline.
   *  - `classes`: one byte per polyline (matching RoadClass).
   */
  bridges?: {
    positions: Float32Array;
    ranges: Uint32Array;
    classes: Uint8Array;
  };
  /**
   * Tunnel ribbon geometry, split out of the flat road ribbon (features tagged
   * `is_tunnel`). Already triangulated into a flat ribbon; drawn dashed + faded
   * by the tunnel material so an underground roadway reads as "below".
   *  - `positions`: XYZ triples (world meters).
   *  - `indices`: triangle indices.
   *  - `dashU`: per-vertex distance along the centerline (meters) for the dash.
   *  - `dashV`: per-vertex across-width coord (0 left edge … 1 right edge), so
   *     the material can draw just the road's dashed outline at low opacity.
   */
  tunnels?: {
    positions: Float32Array;
    indices: Uint32Array;
    dashU: Float32Array;
    dashV: Float32Array;
  };
}

export interface DecodeRequest {
  type: 'decode';
  requestId: number;
  z: number;
  x: number;
  y: number;
  data: ArrayBuffer;
  /** Origin used to convert MVT-local coords into world meters. */
  originLat: number;
  originLon: number;
  layers: LayerName[];
}

/**
 * Phase identifiers emitted by the worker. `base` carries everything except
 * buildings — cheap to extract and the most useful "first paint" content.
 * `buildings` carries the (slow) extruded geometry afterwards.
 */
export type DecodePhase = 'base' | 'buildings';

/**
 * One phase of a tile decode. A single `DecodeRequest` produces multiple
 * responses — see decode.worker.ts. Splitting lets the cheap base-map
 * layers (water / landuse / roads / rails / labels) reach the scene without
 * waiting on the O(n²) buildings union-find. `final: true` marks the last
 * message so the worker pool knows when to release the pending entry.
 */
export interface DecodeResponse {
  type: 'decoded';
  requestId: number;
  z: number;
  x: number;
  y: number;
  phase: DecodePhase;
  final: boolean;
  geometries: Partial<Record<LayerName, LayerGeometry | null>>;
}

export interface DecodeErrorResponse {
  type: 'error';
  requestId: number;
  z: number;
  x: number;
  y: number;
  message: string;
}

export type WorkerMessageOut = DecodeResponse | DecodeErrorResponse;
export type WorkerMessageIn = DecodeRequest;
