export function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message ?? 'Assertion failed');
  }
}

export function unreachable(value: never, message?: string): never {
  throw new Error(message ?? `Unreachable: ${String(value)}`);
}
