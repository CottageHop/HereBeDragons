export type Listener<E> = (event: E) => void;

export class EventBus<EventMap extends Record<string, unknown>> {
  private listeners: Map<keyof EventMap, Set<Listener<unknown>>> = new Map();
  /** Events sent with `emitLatched` — one-off facts such as `ready` — with their payloads. */
  private latched: Map<keyof EventMap, unknown> = new Map();

  on<K extends keyof EventMap>(name: K, listener: Listener<EventMap[K]>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as Listener<unknown>);
    if (!this.latched.has(name)) return () => this.off(name, listener);
    // The event has already happened: a late subscriber still hears it, once, on a microtask
    // (never from inside `on()`), unless it unsubscribes first.
    const event = this.latched.get(name) as EventMap[K];
    let live = true;
    queueMicrotask(() => {
      if (live && this.listeners.get(name)?.has(listener as Listener<unknown>)) this.call(listener, event);
    });
    return () => {
      live = false;
      this.off(name, listener);
    };
  }

  off<K extends keyof EventMap>(name: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(name)?.delete(listener as Listener<unknown>);
  }

  emit<K extends keyof EventMap>(name: K, event: EventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const listener of set) this.call(listener as Listener<EventMap[K]>, event);
  }

  /**
   * Emit a one-off event that stays true once it has happened (`ready`): the current listeners
   * get it now, and a listener added later gets it when it subscribes.
   */
  emitLatched<K extends keyof EventMap>(name: K, event: EventMap[K]): void {
    this.latched.set(name, event);
    this.emit(name, event);
  }

  clear(): void {
    this.listeners.clear();
    this.latched.clear();
  }

  private call<E>(listener: Listener<E>, event: E): void {
    try {
      listener(event);
    } catch (err) {
      console.error('[HereBeDragons] listener error', err);
    }
  }
}
