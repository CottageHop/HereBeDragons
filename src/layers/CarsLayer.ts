import * as THREE from 'three';
import { Layer } from './Layer.js';
import { Palette } from '../materials/Palette.js';
import { RoadClass } from '../tiles/worker/extractors/roads.js';
import { ROAD_GROUPS } from './RoadsLayer.js';
import { BUILDING_MESHES } from './BuildingsLayer.js';
import type { LayerName } from '../types.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';

/** Directed lane segment between two adjacent polyline vertices. */
interface Edge {
  x1: number; z1: number;
  x2: number; z2: number;
  length: number;
  cls: RoadClass;
  /** Index of the reverse edge in `edges`, or -1 if absent. Used so cars
   *  don't immediately U-turn after picking the next edge at an intersection. */
  reverseIdx: number;
}

interface Car {
  /** Index into `edges`, or -1 if inactive. */
  edgeIdx: number;
  /** 0..1 progress along the current edge. */
  t: number;
  /** Forward speed in m/s. */
  speed: number;
  /** Color slot index in CAR_COLORS. */
  colorIdx: number;
}

/** Approximate visual scale of a car in meters. */
const CAR_LENGTH = 5.0;
const CAR_WIDTH = 2.4;
const CAR_HEIGHT = 1.6;

/** Y plane the car sits on — slightly above road_major (-0.30) so it doesn't z-fight. */
const CAR_Y_FLOOR = -0.20;

/** Speeds per road class (m/s). Roughly: major 45 km/h, minor 30 km/h. */
const SPEED_BY_CLASS: Record<RoadClass, number> = {
  [RoadClass.Major]: 12.5,
  [RoadClass.Minor]: 8.0,
  [RoadClass.Path]:  0   // not used; paths aren't drivable
};

/** Color palette. White, black, primary reds / blues, plus a couple muted tones. */
const CAR_COLORS = [
  new THREE.Color('#dddddd'),
  new THREE.Color('#1f1f1f'),
  new THREE.Color('#c0392b'),
  new THREE.Color('#2c3e50'),
  new THREE.Color('#27ae60'),
  new THREE.Color('#e1b12c'),
  new THREE.Color('#8e44ad'),
  new THREE.Color('#16a085')
];

/** Spatial-hash cell size for endpoint matching at intersections. */
const HASH_CELL = 8;
/** Maximum distance (m) between current car position and a candidate edge start
 *  for them to be considered "connected" at an intersection. */
const CONNECT_EPS = 8;

export interface CarsLayerOptions {
  scene: THREE.Scene;
  /** Pool size — the upper bound on simultaneous cars. Default 200. */
  max?: number;
  /** Cars only render at this camera zoom and above. Default 14. */
  minZoom?: number;
  /** Function returning the current camera zoom (used for LOD). */
  getCameraZoom: () => number;
  /**
   * Floor on active car count regardless of building density. Ensures rural
   * scenes still have at least a few cars. Default 6.
   */
  minCars?: number;
  /**
   * Cubic meters of building volume per active car. Lower = busier streets
   * in dense areas. Default 60_000 — a typical mid-rise NYC block of one
   * 30 m-tall building ~ 50 × 50 m fills the streets with ~1 car.
   */
  metersPerCar?: number;
}

/**
 * Animated traffic on top of the road network. CarsLayer doesn't receive
 * per-tile geometry (its `build` is a no-op); instead it scans the scene
 * each ~half-second for road groups (which stash centerlines via the roads
 * extractor + RoadsLayer) and rebuilds its driving graph. Cars drive along
 * directed lane edges and pick a connected next edge at intersections.
 */
export class CarsLayer extends Layer {
  readonly name: LayerName = 'cars';
  private readonly scene: THREE.Scene;
  private readonly minZoom: number;
  private readonly getCameraZoom: () => number;
  private readonly maxCars: number;
  private readonly minCars: number;
  private readonly metersPerCar: number;
  /** Most recent target active car count derived from building density. */
  private targetActive = 0;

  private edges: Edge[] = [];
  /** Spatial hash: cell key → indices of edges starting in that cell. */
  private edgeStartIndex = new Map<string, number[]>();
  private cars: Car[] = [];

  private mesh: THREE.InstancedMesh;
  private scratchMatrix = new THREE.Matrix4();
  private scratchPos = new THREE.Vector3();
  private scratchQuat = new THREE.Quaternion();
  private scratchScale = new THREE.Vector3(1, 1, 1);
  /**
   * Reusable buffer for `pickNextEdge`'s candidate list. The function fires
   * for every car that reaches the end of its current edge — typically every
   * few seconds per car, so with ~1000 active cars that's a steady allocation
   * stream. Sharing one buffer (cleared on entry) holds the count to zero.
   */
  private pickNextCandidates: number[] = [];

  private rescanTimer = 0;
  /** Re-scan interval in seconds. */
  private static RESCAN_INTERVAL = 0.5;

  constructor(materials: StylizedMaterials, opts: CarsLayerOptions) {
    super(materials);
    this.scene = opts.scene;
    this.maxCars = opts.max ?? 1200;
    this.minZoom = opts.minZoom ?? 14;
    this.getCameraZoom = opts.getCameraZoom;
    this.minCars = opts.minCars ?? 45;
    this.metersPerCar = opts.metersPerCar ?? 6_000;

    // Box geometry sized in meters; pivot at floor center so rotation around
    // Y keeps the car level on the road.
    const geo = new THREE.BoxGeometry(CAR_LENGTH, CAR_HEIGHT, CAR_WIDTH);
    geo.translate(0, CAR_HEIGHT * 0.5, 0);
    const mat = materials.get(Palette.car_body);
    this.mesh = new THREE.InstancedMesh(geo, mat, this.maxCars);
    // Per-instance color attribute — three.js automatically reads instanceColor
    // and multiplies it with the material's base color (white here, so each
    // instance's color reads through cleanly).
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.maxCars * 3),
      3
    );
    this.mesh.count = 0; // start hidden until edges exist + zoom is close enough
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    // Seed a car pool — all inactive until the graph is built.
    for (let i = 0; i < this.maxCars; i++) {
      this.cars.push({
        edgeIdx: -1,
        t: 0,
        speed: 0,
        colorIdx: i % CAR_COLORS.length
      });
    }

    // Pre-fill the instanceColor buffer once. Slot i is permanently bound to
    // CAR_COLORS[i % len] — the per-slot color never changes thereafter, so
    // the per-frame `setColorAt` + `instanceColor.needsUpdate = true` GPU
    // upload that used to run every frame is now skipped entirely (the
    // attribute is uploaded exactly once on the next render). Slot-to-car
    // assignment can still shift when active cars come and go, but since
    // colors are decorative-only, the slight reshuffle is undetectable.
    for (let i = 0; i < this.maxCars; i++) {
      this.mesh.setColorAt(i, CAR_COLORS[i % CAR_COLORS.length]);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** No per-tile geometry — cars are driven globally from the road network. */
  build(_geometry: LayerGeometry): THREE.Object3D {
    return new THREE.Group();
  }

  /** @returns true if cars moved this frame (the scene needs a redraw). */
  update(dt: number): boolean {
    this.rescanTimer += dt;
    if (this.rescanTimer >= CarsLayer.RESCAN_INTERVAL) {
      this.rescanTimer = 0;
      this.rebuildEdgeGraph();
    }

    const zoom = this.getCameraZoom();
    if (zoom < this.minZoom || this.edges.length === 0) {
      // Hide cars entirely; cheap (one matrix update / no draw call work).
      if (this.mesh.count !== 0) {
        this.mesh.count = 0;
        return true; // the cars just disappeared — that's a visible change
      }
      return false;
    }

    let visibleCount = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      // Above the density target → idle this slot (don't draw, don't sim).
      if (visibleCount >= this.targetActive) {
        car.edgeIdx = -1;
        continue;
      }
      if (car.edgeIdx < 0 || car.edgeIdx >= this.edges.length) {
        this.respawnCar(car);
        if (car.edgeIdx < 0) continue;
      }
      this.advanceCar(car, dt);
      if (car.edgeIdx < 0) continue;
      this.writeInstance(visibleCount, car);
      visibleCount++;
    }
    this.mesh.count = visibleCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    // instanceColor is never marked dirty here — it was uploaded once at
    // construction and slot-color is fixed. Skipping this avoids a per-frame
    // buffer re-upload of `maxCars * 12` bytes (~14 KB at maxCars=1200).
    // Cars were simulated this frame → the scene changed.
    return visibleCount > 0;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    (this.mesh.geometry as THREE.BufferGeometry).dispose();
    // Material is shared via StylizedMaterials cache — don't dispose here.
  }

  // -------------------------------------------------------------------------
  // Edge graph construction
  // -------------------------------------------------------------------------

  private rebuildEdgeGraph(): void {
    this.edges.length = 0;
    this.edgeStartIndex.clear();
    let totalVolume = 0;

    // Iterate the live registries instead of scene.traverse. Each loaded
    // road tile registers its group with centerlines; each building mesh
    // stashes its tile's cumulative volume. Cheaper than O(scene) every
    // time tiles change.
    for (const group of ROAD_GROUPS) {
      const lines = group.userData.roadLines as LayerGeometry['lines'] | undefined;
      if (lines) this.ingestRoadLines(lines, group);
    }
    for (const mesh of BUILDING_MESHES) {
      const v = mesh.userData.buildingVolume as number | undefined;
      if (typeof v === 'number') totalVolume += v;
    }

    // Map total building volume → active car count. Clamped between minCars
    // and the pool size so a sparse rural scene still has a handful of cars
    // and a Manhattan-dense view doesn't blow past the pool.
    const fromVolume = Math.round(totalVolume / this.metersPerCar);
    this.targetActive = Math.max(
      this.minCars,
      Math.min(this.maxCars, fromVolume)
    );

    if (this.edges.length === 0) return;

    // Compute reverse-edge indices. We added forward + reverse for every line
    // segment in lockstep, so the reverse of edge i is at edges[i ^ 1].
    for (let i = 0; i < this.edges.length; i++) {
      this.edges[i].reverseIdx = i ^ 1;
    }
  }

  private ingestRoadLines(lines: NonNullable<LayerGeometry['lines']>, node: THREE.Object3D): void {
    // The node's world transform applies on top of the locally stored XZ
    // values. In practice tile groups translate to their world position
    // (origin offset), so we bake that translation into the edge endpoints.
    node.updateWorldMatrix(true, false);
    const tx = node.matrixWorld.elements[12];
    const tz = node.matrixWorld.elements[14];

    const { positions, ranges, classes } = lines;
    for (let p = 0; p < ranges.length; p += 2) {
      const start = ranges[p];
      const end = ranges[p + 1];
      const cls = classes[p >> 1] as RoadClass;
      // Skip pedestrian paths — cars don't drive on footways.
      if (cls === RoadClass.Path) continue;
      for (let i = start; i < end - 1; i++) {
        const x1 = positions[i * 2 + 0] + tx;
        const z1 = positions[i * 2 + 1] + tz;
        const x2 = positions[(i + 1) * 2 + 0] + tx;
        const z2 = positions[(i + 1) * 2 + 1] + tz;
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len = Math.hypot(dx, dz);
        if (len < 1) continue; // ignore degenerate / sub-meter lane segments
        // Forward edge.
        const fwdIdx = this.edges.length;
        this.edges.push({ x1, z1, x2, z2, length: len, cls, reverseIdx: -1 });
        this.indexEdgeStart(fwdIdx, x1, z1);
        // Reverse edge — supports both driving directions.
        const revIdx = this.edges.length;
        this.edges.push({ x1: x2, z1: z2, x2: x1, z2: z1, length: len, cls, reverseIdx: -1 });
        this.indexEdgeStart(revIdx, x2, z2);
      }
    }
  }

  private indexEdgeStart(edgeIdx: number, x: number, z: number): void {
    const key = `${Math.floor(x / HASH_CELL)}|${Math.floor(z / HASH_CELL)}`;
    let bucket = this.edgeStartIndex.get(key);
    if (!bucket) {
      bucket = [];
      this.edgeStartIndex.set(key, bucket);
    }
    bucket.push(edgeIdx);
  }

  // -------------------------------------------------------------------------
  // Car simulation
  // -------------------------------------------------------------------------

  private respawnCar(car: Car): void {
    if (this.edges.length === 0) {
      car.edgeIdx = -1;
      return;
    }
    car.edgeIdx = Math.floor(Math.random() * this.edges.length);
    car.t = Math.random();
    car.speed = SPEED_BY_CLASS[this.edges[car.edgeIdx].cls] * (0.85 + Math.random() * 0.3);
  }

  private advanceCar(car: Car, dt: number): void {
    const edge = this.edges[car.edgeIdx];
    car.t += (dt * car.speed) / edge.length;
    if (car.t >= 1) {
      // Pick a connected next edge starting near the current edge's end.
      const next = this.pickNextEdge(edge.x2, edge.z2, edge.reverseIdx);
      if (next < 0) {
        // Dead end (or graph not yet populated nearby): respawn elsewhere.
        this.respawnCar(car);
        return;
      }
      const overflow = (car.t - 1) * edge.length;
      car.edgeIdx = next;
      const nextEdge = this.edges[next];
      car.t = Math.min(1, overflow / nextEdge.length);
      car.speed = SPEED_BY_CLASS[nextEdge.cls] * (0.85 + Math.random() * 0.3);
    }
  }

  private pickNextEdge(x: number, z: number, excludeIdx: number): number {
    const cellX = Math.floor(x / HASH_CELL);
    const cellZ = Math.floor(z / HASH_CELL);
    const candidates = this.pickNextCandidates;
    candidates.length = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.edgeStartIndex.get(`${cellX + dx}|${cellZ + dz}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (idx === excludeIdx) continue;
          const e = this.edges[idx];
          if (Math.hypot(e.x1 - x, e.z1 - z) <= CONNECT_EPS) candidates.push(idx);
        }
      }
    }
    if (candidates.length === 0) return -1;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private writeInstance(slot: number, car: Car): void {
    const edge = this.edges[car.edgeIdx];
    const x = edge.x1 + (edge.x2 - edge.x1) * car.t;
    const z = edge.z1 + (edge.z2 - edge.z1) * car.t;
    const heading = Math.atan2(edge.z2 - edge.z1, edge.x2 - edge.x1);

    this.scratchPos.set(x, CAR_Y_FLOOR, z);
    // Box's +X axis was the long axis; +Y in world is up. To turn the car
    // along its travel direction, rotate around world Y by -heading (atan2
    // returns the angle in the XZ plane measured from +X toward +Z).
    this.scratchQuat.setFromAxisAngle(_yAxis, -heading);
    this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
    this.mesh.setMatrixAt(slot, this.scratchMatrix);
    // instanceColor was pre-filled once at construction (slot i ↔ CAR_COLORS[i % len]);
    // no per-frame `setColorAt` here.
  }
}

const _yAxis = new THREE.Vector3(0, 1, 0);
