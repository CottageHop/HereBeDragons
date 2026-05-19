export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds2D {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function expand(bounds: Bounds2D, x: number, y: number): void {
  if (x < bounds.minX) bounds.minX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y > bounds.maxY) bounds.maxY = y;
}

export function intersects(a: Bounds2D, b: Bounds2D): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
