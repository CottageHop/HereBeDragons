import type { LayerName } from '../../types.js';

/** Decoded geometry for a single layer in a single tile. */
export interface LayerGeometry {
  positions: Float32Array; // XYZ triples
  indices: Uint32Array;
  normals?: Float32Array;
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
