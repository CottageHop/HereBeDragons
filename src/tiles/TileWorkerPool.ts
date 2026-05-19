import type { LayerName } from '../types.js';
import type {
  DecodeRequest,
  DecodeResponse,
  DecodeErrorResponse,
  WorkerMessageOut
} from './worker/decodeProtocol.js';
// Inline the decode worker (base64) into the bundle. The previous
// `new Worker(new URL('./worker/decode.worker.ts', import.meta.url))` pattern
// made Vite emit the worker as a SEPARATE `dist/assets/decode.worker-*.js`
// chunk referenced by a runtime-computed URL. That breaks any downstream
// bundler (Nuxt/Vite/Rollup) consuming the published package: the build either
// can't resolve the path or doesn't copy the worker file, so it 404s at
// runtime. Inlining makes the package self-contained for every consumer.
// `?worker&inline` is typed by `vite/client` (already in tsconfig types).
import DecodeWorker from './worker/decode.worker.ts?worker&inline';

interface Pending {
  /**
   * Fires every time the worker emits a phase for this request (potentially
   * more than once). The caller uses this to incrementally add geometry to
   * the scene as it arrives.
   */
  onPhase: (response: DecodeResponse) => void;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface TileWorkerPoolOptions {
  /**
   * Number of decoder workers. Each worker is a separate OS thread; more
   * workers = more tiles decoded in parallel until you saturate the CPU.
   * Default is `min(4, hardwareConcurrency - 1)` — leaves a core for the
   * main render thread.
   */
  size?: number;
}

export class TileWorkerPool {
  private workers: Worker[] = [];
  private next = 0;
  private nextRequestId = 1;
  private pending = new Map<number, Pending>();

  constructor(options: TileWorkerPoolOptions = {}) {
    // Match the docs: min(4, hardwareConcurrency - 1) by default. Leaves a
    // core for the main render thread, caps at 4 to avoid worker-creation
    // overhead on beefy CPUs (each worker is a separate JS heap + module
    // load). Previous implementation hardcoded this to 1 (the real
    // expression was commented out) — meaning every tile decoded serially
    // through one worker, which was the dominant bottleneck on tile load
    // speed. With 4 workers, decode parallelism matches PolyMap's setup.
    const detected = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2;
    const n = Math.max(1, options.size ?? Math.min(4, (detected ?? 2) - 1));
    for (let i = 0; i < n; i++) {
      const worker = new DecodeWorker();
      worker.onmessage = (e: MessageEvent<WorkerMessageOut>) => this.onMessage(e.data);
      worker.onerror = (e) => {
        console.error('[HereBeDragons] worker error', e.message);
      };
      this.workers.push(worker);
    }
  }

  /**
   * Submit a tile for decoding. The worker may emit MULTIPLE responses for a
   * single request — first the cheap base-map layers, then buildings. Each
   * phase fires `onPhase`. The returned promise resolves after the final
   * phase or rejects on error.
   */
  decode(
    z: number,
    x: number,
    y: number,
    data: ArrayBuffer,
    originLat: number,
    originLon: number,
    layers: LayerName[],
    onPhase: (response: DecodeResponse) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const req: DecodeRequest = {
        type: 'decode',
        requestId,
        z,
        x,
        y,
        data,
        originLat,
        originLon,
        layers
      };
      this.pending.set(requestId, { onPhase, resolve, reject });
      const worker = this.workers[this.next];
      this.next = (this.next + 1) % this.workers.length;
      worker.postMessage(req, [data]);
    });
  }

  private onMessage(msg: WorkerMessageOut): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending) return;
    if (msg.type === 'error') {
      this.pending.delete(msg.requestId);
      const e = msg as DecodeErrorResponse;
      pending.reject(new Error(`tile ${e.z}/${e.x}/${e.y}: ${e.message}`));
      return;
    }
    // Streaming phase result. Always notify the caller — base, buildings,
    // or anything we add later — then release the entry on the final one.
    pending.onPhase(msg);
    if (msg.final) {
      this.pending.delete(msg.requestId);
      pending.resolve();
    }
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    for (const p of this.pending.values()) p.reject(new Error('worker pool disposed'));
    this.pending.clear();
  }
}
