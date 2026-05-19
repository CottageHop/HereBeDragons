export class LRU<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly capacity: number, private readonly onEvict?: (key: K, value: V) => void) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value as K | undefined;
      if (oldestKey !== undefined) {
        const oldestValue = this.map.get(oldestKey)!;
        this.map.delete(oldestKey);
        this.onEvict?.(oldestKey, oldestValue);
      }
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    const value = this.map.get(key);
    if (value === undefined) return false;
    this.map.delete(key);
    this.onEvict?.(key, value);
    return true;
  }

  clear(): void {
    if (this.onEvict) {
      for (const [k, v] of this.map) this.onEvict(k, v);
    }
    this.map.clear();
  }

  *entries(): IterableIterator<[K, V]> {
    yield* this.map.entries();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
