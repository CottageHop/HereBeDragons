import * as THREE from 'three';
import { Palette } from '../materials/Palette.js';
import { RoadClass, WIDTH_M, ROAD_Y_BY_CLASS } from '../tiles/worker/extractors/roads.js';
import { BRIDGE_GROUPS, ROAD_GROUPS, bridgeVersion } from '../layers/RoadsLayer.js';
import type { StylizedMaterials } from '../materials/StylizedMaterials.js';
import type { LayerGeometry } from '../tiles/worker/decodeProtocol.js';

/**
 * Proximity (metres) for merging coincident bridge vertices into one graph
 * node. This is what stitches the per-tile pieces of one bridge together: tiles
 * clip a bridge at their boundary, so the two pieces share that boundary point
 * (to within float error). Matching by nearest-within-EPS — not exact grid
 * rounding — avoids the failure where a shared point straddles a grid-cell line
 * and the two copies round into different cells. Kept below the gap between
 * parallel decks (roadway vs bike path, ~5 m+) so those stay distinct.
 */
const NODE_EPS_M = 2;

/**
 * Max spacing (metres) between deck vertices. MVT simplifies long spans down to
 * as few as two points, which leaves no interior vertex to lift — the deck
 * needs samples along its length to rise. We resample each edge to this density.
 */
const RESAMPLE_STEP_M = 12;

/**
 * Deck height (metres) once a point is far enough from any ground connection,
 * and the distance over which it climbs there. Elevation is driven by distance
 * to the nearest point where the bridge meets a normal (non-bridge) road, NOT
 * by the chain's own endpoints — so a point at a tile boundary (far from
 * ground) stays at full height and meets the next tile's piece in the air
 * rather than dropping flat. Short spans whose midpoint never gets RAMP_LEN_M
 * from the ground simply peak lower, giving a gentle arch.
 */
const DECK_HEIGHT_M = 16;
const RAMP_LEN_M = 300;

/** Debounce (seconds) after the loaded-bridge set changes before rebuilding. */
const REBUILD_DEBOUNCE_S = 0.3;

interface Pt { x: number; z: number; }
interface Edge { u: number; v: number; len: number; cls: RoadClass; used: boolean; }

export interface BridgesManagerOptions {
  scene: THREE.Scene;
}

/**
 * Builds arched bridge decks from the bridge centerlines the roads extractor
 * splits out (see the protocol's `bridges` block). It stitches the per-tile
 * pieces into one graph, finds where bridges touch the ground (their shared
 * nodes with non-bridge roads), and lifts every point by how far it is from the
 * nearest such ground connection. The result rises off the ground at the ends,
 * sits up on a deck over the span, and — crucially — stays elevated at tile
 * boundaries so a bridge clipped across tiles meets itself in the air. Rebuilt
 * (debounced) whenever the loaded-bridge set changes.
 */
export class BridgesManager {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private seenVersion = -1;
  private rebuildIn = 0;

  constructor(private readonly materials: StylizedMaterials, opts: BridgesManagerOptions) {
    this.scene = opts.scene;
    this.group.name = 'Bridges';
    this.scene.add(this.group);
  }

  /** @returns true if the deck geometry was rebuilt this frame (scene changed). */
  update(dt: number): boolean {
    if (bridgeVersion !== this.seenVersion) {
      this.seenVersion = bridgeVersion;
      this.rebuildIn = REBUILD_DEBOUNCE_S;
    }
    if (this.rebuildIn > 0) {
      this.rebuildIn -= dt;
      if (this.rebuildIn <= 0) {
        this.rebuild();
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.clearGroup();
  }

  private clearGroup(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
  }

  private rebuild(): void {
    this.clearGroup();
    const segments = collectBridgeSegments();
    if (segments.length === 0) return;

    // --- Build the bridge graph with proximity-merged nodes ----------------
    const store = new NodeStore(NODE_EPS_M);
    const edges: Edge[] = [];
    const adj: number[][] = []; // node index → edge indices
    const seen = new Set<string>();
    const ensureAdj = (n: number): void => { while (adj.length <= n) adj.push([]); };
    for (const seg of segments) {
      for (let i = 0; i + 1 < seg.pts.length; i++) {
        const u = store.getOrCreate(seg.pts[i].x, seg.pts[i].z);
        const v = store.getOrCreate(seg.pts[i + 1].x, seg.pts[i + 1].z);
        if (u === v) continue;
        const ek = u < v ? `${u}#${v}` : `${v}#${u}`;
        if (seen.has(ek)) continue;
        seen.add(ek);
        const a = store.coord(u);
        const b = store.coord(v);
        const idx = edges.length;
        edges.push({ u, v, len: Math.hypot(a.x - b.x, a.z - b.z), cls: seg.cls, used: false });
        ensureAdj(u); ensureAdj(v);
        adj[u].push(idx); adj[v].push(idx);
      }
    }
    ensureAdj(store.count() - 1);

    // --- Ground anchors: bridge nodes where a non-bridge road endpoint sits -
    const anchors: number[] = [];
    for (const ep of collectRoadEndpoints()) {
      const idx = store.findNear(ep.x, ep.z);
      if (idx >= 0) anchors.push(idx);
    }

    // --- Multi-source shortest path: distance from every node to ground ----
    const dist = dijkstraFromSources(store.count(), adj, edges, anchors);

    // --- Stitch chains and build the arched decks --------------------------
    const chains = stitchChains(edges, adj);
    const buf = new Map<RoadClass, { positions: number[]; normals: number[]; indices: number[] }>();
    for (const chain of chains) {
      const dense = densifyWithElevation(chain, store, edges, dist);
      if (dense.length < 2) continue;
      const b = buf.get(chain.cls) ?? { positions: [], normals: [], indices: [] };
      buildDeckRibbon(dense, WIDTH_M[chain.cls] * 0.5, b.positions, b.normals, b.indices);
      buf.set(chain.cls, b);
    }

    for (const [cls, b] of buf) {
      if (b.indices.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
      geo.setIndex(b.indices);
      const mesh = new THREE.Mesh(geo, this.materials.get(slotForClass(cls)));
      mesh.renderOrder = -2;
      this.group.add(mesh);
      this.geometries.push(geo);
    }
  }
}

/** Pull every loaded tile's bridge centerlines into world-space segments. */
function collectBridgeSegments(): Array<{ pts: Pt[]; cls: RoadClass }> {
  const out: Array<{ pts: Pt[]; cls: RoadClass }> = [];
  for (const node of BRIDGE_GROUPS) {
    const lines = node.userData.bridgeLines as LayerGeometry['bridges'] | undefined;
    if (!lines) continue;
    node.updateWorldMatrix(true, false);
    const tx = node.matrixWorld.elements[12];
    const tz = node.matrixWorld.elements[14];
    const { positions, ranges, classes } = lines;
    for (let p = 0; p < ranges.length; p += 2) {
      const start = ranges[p];
      const end = ranges[p + 1];
      const cls = classes[p >> 1] as RoadClass;
      const pts: Pt[] = [];
      for (let i = start; i < end; i++) pts.push({ x: positions[i * 2] + tx, z: positions[i * 2 + 1] + tz });
      if (pts.length >= 2) out.push({ pts, cls });
    }
  }
  return out;
}

/** Endpoints of every loaded non-bridge road polyline — candidate ground
 *  connections where a bridge ramps down to street level. */
function collectRoadEndpoints(): Pt[] {
  const out: Pt[] = [];
  for (const node of ROAD_GROUPS) {
    const lines = node.userData.roadLines as LayerGeometry['lines'] | undefined;
    if (!lines) continue;
    node.updateWorldMatrix(true, false);
    const tx = node.matrixWorld.elements[12];
    const tz = node.matrixWorld.elements[14];
    const { positions, ranges } = lines;
    for (let p = 0; p < ranges.length; p += 2) {
      const start = ranges[p];
      const end = ranges[p + 1];
      if (end - start < 1) continue;
      out.push({ x: positions[start * 2] + tx, z: positions[start * 2 + 1] + tz });
      out.push({ x: positions[(end - 1) * 2] + tx, z: positions[(end - 1) * 2 + 1] + tz });
    }
  }
  return out;
}

function slotForClass(cls: RoadClass): typeof Palette[keyof typeof Palette] {
  if (cls === RoadClass.Major) return Palette.road_major;
  if (cls === RoadClass.Minor) return Palette.road_minor;
  return Palette.road_path;
}

/**
 * Spatial-hash point store that merges points within `eps` into one node, by
 * searching the cell and its 8 neighbours (so a coincident point near a cell
 * boundary still matches). Cell size = eps.
 */
class NodeStore {
  private readonly eps: number;
  private readonly eps2: number;
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly cells = new Map<string, number[]>();

  constructor(eps: number) {
    this.eps = eps;
    this.eps2 = eps * eps;
  }

  count(): number { return this.xs.length; }
  coord(i: number): Pt { return { x: this.xs[i], z: this.zs[i] }; }

  getOrCreate(x: number, z: number): number {
    const found = this.findNear(x, z);
    if (found >= 0) return found;
    const idx = this.xs.length;
    this.xs.push(x); this.zs.push(z);
    const key = `${Math.floor(x / this.eps)}|${Math.floor(z / this.eps)}`;
    const arr = this.cells.get(key);
    if (arr) arr.push(idx); else this.cells.set(key, [idx]);
    return idx;
  }

  findNear(x: number, z: number): number {
    const cx = Math.floor(x / this.eps);
    const cz = Math.floor(z / this.eps);
    let best = -1;
    let bestD = this.eps2;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.cells.get(`${cx + dx}|${cz + dz}`);
        if (!arr) continue;
        for (const i of arr) {
          const d = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
          if (d <= bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }
}

/** Multi-source Dijkstra: shortest graph distance from any source node. */
function dijkstraFromSources(n: number, adj: number[][], edges: Edge[], sources: number[]): Float64Array {
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (const s of sources) {
    if (s >= 0 && s < n && dist[s] !== 0) { dist[s] = 0; heap.push(0, s); }
  }
  while (heap.size() > 0) {
    const { dist: d, node: u } = heap.pop();
    if (d > dist[u]) continue;
    for (const ei of adj[u] ?? []) {
      const e = edges[ei];
      const v = e.u === u ? e.v : e.u;
      const nd = d + e.len;
      if (nd < dist[v]) { dist[v] = nd; heap.push(nd, v); }
    }
  }
  return dist;
}

class MinHeap {
  private readonly d: number[] = [];
  private readonly n: number[] = [];
  size(): number { return this.d.length; }
  push(dist: number, node: number): void {
    this.d.push(dist); this.n.push(node);
    let i = this.d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= this.d[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): { dist: number; node: number } {
    const dist = this.d[0];
    const node = this.n[0];
    const last = this.d.length - 1;
    this.swap(0, last); this.d.pop(); this.n.pop();
    let i = 0;
    const len = this.d.length;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < len && this.d[l] < this.d[m]) m = l;
      if (r < len && this.d[r] < this.d[m]) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return { dist, node };
  }
  private swap(a: number, b: number): void {
    [this.d[a], this.d[b]] = [this.d[b], this.d[a]];
    [this.n[a], this.n[b]] = [this.n[b], this.n[a]];
  }
}

interface Chain { nodes: number[]; edgeIdx: number[]; cls: RoadClass; }

/** Walk the edge graph into maximal polylines, splitting at junctions (deg ≥3).
 *  Records the edge index taken at each step so the deck builder can read its
 *  length / endpoint distances directly. */
function stitchChains(edges: Edge[], adj: number[][]): Chain[] {
  const degree = (n: number): number => adj[n]?.length ?? 0;
  const chains: Chain[] = [];
  const walk = (start: number, firstEdge: number): void => {
    const e0 = edges[firstEdge];
    e0.used = true;
    let prev = start;
    let cur = e0.u === start ? e0.v : e0.u;
    const nodes = [start, cur];
    const edgeIdx = [firstEdge];
    let cls = e0.cls;
    while (degree(cur) === 2) {
      const next = (adj[cur] ?? []).find((i) => !edges[i].used);
      if (next === undefined) break;
      const e = edges[next];
      e.used = true;
      const other = e.u === cur ? e.v : e.u;
      if (other === prev) break;
      nodes.push(other);
      edgeIdx.push(next);
      prev = cur; cur = other; cls = e.cls;
    }
    if (nodes.length >= 2) chains.push({ nodes, edgeIdx, cls });
  };
  for (let n = 0; n < adj.length; n++) {
    if (degree(n) === 2) continue;
    for (const idx of adj[n] ?? []) if (!edges[idx].used) walk(n, idx);
  }
  for (let i = 0; i < edges.length; i++) if (!edges[i].used) walk(edges[i].u, i);
  return chains;
}

interface DeckPt { x: number; z: number; y: number; }

/** Deck height for a point `d` metres (graph distance) from the nearest ground
 *  connection. Smoothstep ramp to a plateau — tangent to flat at both ends. */
function deckHeight(d: number): number {
  if (!Number.isFinite(d)) return DECK_HEIGHT_M; // never touches loaded ground
  const r = Math.min(1, d / RAMP_LEN_M);
  return DECK_HEIGHT_M * r * r * (3 - 2 * r);
}

/**
 * Resample a chain to fine spacing and assign each vertex a world Y. The
 * elevation comes from the distance to the nearest ground connection, computed
 * exactly per point: on the edge u→v at fraction f, that distance is
 * `min(dist[u] + f·len, dist[v] + (1−f)·len)` — reachable via either end. This
 * is what keeps tile-boundary points (far from ground) up in the air.
 */
function densifyWithElevation(chain: Chain, store: NodeStore, edges: Edge[], dist: Float64Array): DeckPt[] {
  const baseY = ROAD_Y_BY_CLASS[chain.cls];
  const out: DeckPt[] = [];
  for (let i = 0; i + 1 < chain.nodes.length; i++) {
    const u = chain.nodes[i];
    const v = chain.nodes[i + 1];
    const a = store.coord(u);
    const b = store.coord(v);
    const len = edges[chain.edgeIdx[i]].len;
    const du = dist[u];
    const dv = dist[v];
    const sub = Math.max(1, Math.ceil(len / RESAMPLE_STEP_M));
    // Emit f=0 only on the first edge; later edges start at f>0 to avoid
    // duplicating the shared node.
    for (let k = i === 0 ? 0 : 1; k <= sub; k++) {
      const f = k / sub;
      const d = Math.min(du + f * len, dv + (1 - f) * len);
      out.push({
        x: a.x + (b.x - a.x) * f,
        z: a.z + (b.z - a.z) * f,
        y: baseY + deckHeight(d)
      });
    }
  }
  return out;
}

/** Triangulate a deck centerline (with per-vertex Y) into a flat-across,
 *  sloped-along ribbon, with normals that follow the longitudinal slope. */
function buildDeckRibbon(
  pts: DeckPt[],
  half: number,
  positions: number[],
  normals: number[],
  indices: number[]
): void {
  const n = pts.length;
  if (n < 2) return;
  const baseVertex = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    let tx = pts[i1].x - pts[i0].x;
    let tz = pts[i1].z - pts[i0].z;
    const ty = pts[i1].y - pts[i0].y;
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl;
    const sz = tx / tl;
    positions.push(pts[i].x + sx * half, pts[i].y, pts[i].z + sz * half);
    positions.push(pts[i].x - sx * half, pts[i].y, pts[i].z - sz * half);

    const t3 = new THREE.Vector3(tx, ty, tz).normalize();
    const side3 = new THREE.Vector3(sx, 0, sz);
    const nrm = new THREE.Vector3().crossVectors(side3, t3).normalize();
    if (nrm.y < 0) nrm.negate();
    normals.push(nrm.x, nrm.y, nrm.z, nrm.x, nrm.y, nrm.z);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = baseVertex + i * 2;
    const b = a + 1;
    const c = baseVertex + (i + 1) * 2;
    const d = c + 1;
    indices.push(a, c, b, c, d, b);
  }
}
