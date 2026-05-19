export type Listener<E> = (event: E) => void;

export class EventBus<EventMap extends Record<string, unknown>> {
  private listeners: Map<keyof EventMap, Set<Listener<unknown>>> = new Map();

  on<K extends keyof EventMap>(name: K, listener: Listener<EventMap[K]>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as Listener<unknown>);
    return () => this.off(name, listener);
  }

  off<K extends keyof EventMap>(name: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(name)?.delete(listener as Listener<unknown>);
  }

  emit<K extends keyof EventMap>(name: K, event: EventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as Listener<EventMap[K]>)(event);
      } catch (err) {
        console.error('[HereBeDragons] listener error', err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
