/**
 * Message builders for tile-decode worker startup failures.
 *
 * These live apart from `TileWorkerPool` on purpose: that module imports the decode worker through
 * Vite's `?worker&inline` specifier, which only Vite can resolve, so the pool cannot be loaded at
 * all under vitest/node. Keeping the wording here — pure, no imports — means the thing most likely
 * to be wrong (the text a stuck developer reads) is unit-tested rather than covered only by a
 * browser probe.
 */

/** The decoder is inlined as a blob, so a CSP must allow blob workers specifically. */
const CSP_HINT =
  'The usual cause is a Content-Security-Policy that does not allow workers — the decoder is ' +
  'inlined as a blob, so the policy needs `worker-src blob:` (or `child-src blob:` on older ' +
  'browsers).';

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** No worker could be started at all: the map cannot decode any tile, so this is fatal. */
export function workerPoolFatalMessage(err: unknown): string {
  return (
    'HereBeDragons could not start its tile-decode worker, so no tiles can be decoded. ' +
    `${CSP_HINT} Original error: ${reason(err)}`
  );
}

/** Some workers started and one did not: usable, just slower — say so and carry on. */
export function workerPoolPartialMessage(wanted: number, got: number, err: unknown): string {
  return (
    `tile decode pool: wanted ${wanted} workers, got ${got} — decoding will be slower. ` +
    `Original error: ${reason(err)}`
  );
}
