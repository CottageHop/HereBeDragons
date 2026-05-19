import * as THREE from 'three';
import earcut from 'earcut';
import type { Projection } from '../core/Projection.js';
import type { PolygonHandle, PolygonOptions, PolygonPoint } from './types.js';

interface PolygonEntry {
  options: PolygonOptions;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  geometry: THREE.BufferGeometry;
  handle: PolygonHandle;
}

export interface PolygonsManagerDeps {
  scene: THREE.Scene;
  projection: Projection;
}

/**
 * Registry of developer-added polygons rendered as flat fills sitting just
 * above the ground plane. Each polygon is triangulated with earcut at add /
 * setPoints time and rebuilt in place when its outline changes.
 *
 * Polygons render with `depthWrite: false` so they don't occlude the stylized
 * scene behind them but still respect the depth buffer (tall buildings clip
 * a polygon behind them). DoubleSide means a tilted camera can see the fill
 * from any angle.
 */
export class PolygonsManager {
  private readonly scene: THREE.Scene;
  private readonly projection: Projection;
  private readonly group: THREE.Group;
  private readonly polygons = new Map<string, PolygonEntry>();

  constructor(deps: PolygonsManagerDeps) {
    this.scene = deps.scene;
    this.projection = deps.projection;
    this.group = new THREE.Group();
    this.group.name = 'hbd-polygons';
    this.scene.add(this.group);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  addPolygon(options: PolygonOptions): PolygonHandle {
    if (this.polygons.has(options.id)) this.removePolygon(options.id);

    const geometry = this.buildGeometry(options.points, options.holes, options.elevation ?? 2);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(options.color),
      transparent: true,
      opacity: options.opacity ?? 0.55,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `hbd-polygon:${options.id}`;
    mesh.renderOrder = 1; // draw after opaque scene geometry
    this.group.add(mesh);

    const entry: PolygonEntry = {
      options,
      mesh,
      material,
      geometry,
      handle: this.makeHandle(options.id)
    };
    this.polygons.set(options.id, entry);
    return entry.handle;
  }

  removePolygon(id: string): void {
    const entry = this.polygons.get(id);
    if (!entry) return;
    this.group.remove(entry.mesh);
    entry.geometry.dispose();
    entry.material.dispose();
    this.polygons.delete(id);
  }

  clearPolygons(): void {
    for (const id of this.polygons.keys()) this.removePolygon(id);
  }

  getPolygon(id: string): PolygonHandle | undefined {
    return this.polygons.get(id)?.handle;
  }

  dispose(): void {
    this.clearPolygons();
    this.scene.remove(this.group);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Build a triangulated flat geometry at `elevation` above Y=0. Returns a
   * BufferGeometry with `position` (Float32Array) and an index buffer suitable
   * for indexed drawing.
   */
  private buildGeometry(
    outer: PolygonPoint[],
    holes: PolygonPoint[][] | undefined,
    elevation: number
  ): THREE.BufferGeometry {
    // Flatten outer + holes into a single [x, z, x, z, ...] array; track hole
    // start indices for earcut's hole-aware triangulation.
    const flat: number[] = [];
    const holeIndices: number[] = [];

    for (const p of outer) {
      const m = this.projection.project(p.lon, p.lat);
      // Scene convention: Mercator Y → scene -Z (north is -Z).
      flat.push(m.x, -m.y);
    }
    if (holes) {
      for (const ring of holes) {
        holeIndices.push(flat.length / 2);
        for (const p of ring) {
          const m = this.projection.project(p.lon, p.lat);
          flat.push(m.x, -m.y);
        }
      }
    }

    const tris = earcut(flat, holeIndices.length ? holeIndices : undefined, 2);

    // Expand flat (x, z) → (x, y, z) with y = elevation, since earcut returns
    // indices into the flat 2D array and the THREE BufferGeometry needs 3D.
    const vertexCount = flat.length / 2;
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3 + 0] = flat[i * 2 + 0];
      positions[i * 3 + 1] = elevation;
      positions[i * 3 + 2] = flat[i * 2 + 1];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(tris);
    geometry.computeBoundingSphere();
    return geometry;
  }

  private makeHandle(id: string): PolygonHandle {
    const self = this;
    return {
      get id() {
        return id;
      },
      get data() {
        return self.polygons.get(id)?.options.data;
      },
      setColor(color: string): void {
        const entry = self.polygons.get(id);
        if (!entry) return;
        entry.options.color = color;
        entry.material.color.set(color);
      },
      setOpacity(opacity: number): void {
        const entry = self.polygons.get(id);
        if (!entry) return;
        entry.options.opacity = opacity;
        entry.material.opacity = opacity;
      },
      setPoints(points: PolygonPoint[], holes?: PolygonPoint[][]): void {
        const entry = self.polygons.get(id);
        if (!entry) return;
        entry.options.points = points;
        entry.options.holes = holes;
        const elevation = entry.options.elevation ?? 2;
        entry.geometry.dispose();
        entry.geometry = self.buildGeometry(points, holes, elevation);
        entry.mesh.geometry = entry.geometry;
      },
      remove(): void {
        self.removePolygon(id);
      }
    };
  }
}
