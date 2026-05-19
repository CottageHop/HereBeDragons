import type { TileGroup } from '../scene/TileGroup.js';
import { LRU } from '../util/lru.js';
import { tileKey } from '../core/TileId.js';

export class TileCache {
  private lru: LRU<string, TileGroup>;

  constructor(capacity = 200, onEvict?: (tile: TileGroup) => void) {
    this.lru = new LRU(capacity, (_k, tile) => onEvict?.(tile));
  }

  get(z: number, x: number, y: number): TileGroup | undefined {
    return this.lru.get(tileKey(z, x, y));
  }

  has(z: number, x: number, y: number): boolean {
    return this.lru.has(tileKey(z, x, y));
  }

  set(z: number, x: number, y: number, tile: TileGroup): void {
    this.lru.set(tileKey(z, x, y), tile);
  }

  delete(z: number, x: number, y: number): boolean {
    return this.lru.delete(tileKey(z, x, y));
  }

  clear(): void {
    this.lru.clear();
  }

  *entries(): IterableIterator<[string, TileGroup]> {
    yield* this.lru.entries();
  }

  get size(): number {
    return this.lru.size;
  }
}
