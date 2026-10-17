import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../src/core/EventBus.js';

type Events = { ready: { type: 'ready' }; tick: { n: number } };
const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe('EventBus', () => {
  it('calls every listener and survives one that throws', () => {
    const bus = new EventBus<Events>();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: number[] = [];
    bus.on('tick', () => { throw new Error('boom'); });
    bus.on('tick', (e) => seen.push(e.n));
    bus.emit('tick', { n: 1 });
    expect(seen).toEqual([1]);
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it('unsubscribes', () => {
    const bus = new EventBus<Events>();
    const cb = vi.fn();
    const off = bus.on('tick', cb);
    off();
    bus.emit('tick', { n: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not replay an ordinary event to a late listener', async () => {
    const bus = new EventBus<Events>();
    bus.emit('tick', { n: 1 });
    const cb = vi.fn();
    bus.on('tick', cb);
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });

  it('delivers a latched event to the listeners present when it fires', () => {
    const bus = new EventBus<Events>();
    const cb = vi.fn();
    bus.on('ready', cb);
    bus.emitLatched('ready', { type: 'ready' });
    expect(cb).toHaveBeenCalledOnce();
  });

  // The map's `ready` fires inside init(), before createHereBeDragons() resolves, so the
  // documented `(await createHereBeDragons(...)).on('ready', cb)` subscribes after the fact.
  it('delivers a latched event to a late listener once, on a microtask', async () => {
    const bus = new EventBus<Events>();
    const early = vi.fn();
    bus.on('ready', early);
    bus.emitLatched('ready', { type: 'ready' });
    const late = vi.fn();
    bus.on('ready', late);
    expect(late).not.toHaveBeenCalled(); // never from inside on()
    await flush();
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith({ type: 'ready' });
    expect(early).toHaveBeenCalledOnce(); // the early listener is not called again
  });

  it('skips a late listener that unsubscribes before the microtask', async () => {
    const bus = new EventBus<Events>();
    bus.emitLatched('ready', { type: 'ready' });
    const cb = vi.fn();
    const off = bus.on('ready', cb);
    off();
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });

  it('forgets latched events on clear()', async () => {
    const bus = new EventBus<Events>();
    bus.emitLatched('ready', { type: 'ready' });
    bus.clear();
    const cb = vi.fn();
    bus.on('ready', cb);
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });
});
