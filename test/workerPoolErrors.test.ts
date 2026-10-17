import { describe, it, expect } from 'vitest';
import { workerPoolFatalMessage, workerPoolPartialMessage } from '../src/tiles/workerPoolErrors.js';

// Verbatim what a Content-Security-Policy without `worker-src` throws.
const CSP_ERR = new Error('Refused to create a worker');

describe('worker pool failure messages', () => {
  it('fatal: says what stopped working, not just what threw', () => {
    const m = workerPoolFatalMessage(CSP_ERR);
    expect(m).toMatch(/HereBeDragons/);
    expect(m).toMatch(/no tiles can be decoded/i);      // the consequence
    expect(m).toMatch(/worker-src blob:/);              // the exact directive to add
    expect(m).toContain('Refused to create a worker');  // the original, never dropped
  });

  it('fatal: names blob: specifically — a plain `worker-src self` would not fix it', () => {
    expect(workerPoolFatalMessage(CSP_ERR)).toMatch(/inlined as a blob/);
  });

  it('partial: reports the shortfall and that it is survivable', () => {
    const m = workerPoolPartialMessage(4, 2, CSP_ERR);
    expect(m).toMatch(/wanted 4 workers, got 2/);
    expect(m).toMatch(/slower/);
    expect(m).not.toMatch(/no tiles can be decoded/i);  // NOT fatal wording
  });

  it('survives whatever was thrown, including non-Errors', () => {
    for (const thrown of ['a string', 42, null, undefined, { weird: true }]) {
      expect(() => workerPoolFatalMessage(thrown)).not.toThrow();
      expect(workerPoolFatalMessage(thrown)).toMatch(/HereBeDragons/);
    }
  });
});
