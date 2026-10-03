/**
 * Replaces one property for the length of a test and puts it back exactly.
 *
 * vitest's DOM environments define the window's members on the global as
 * accessors whose setter keeps an override: redefining the old accessor would
 * leave the override in place. An accessor with a setter is therefore given
 * the new value and, on restore, the value it answered before.
 */
export function overrideProperty(target: object, key: PropertyKey, value: unknown): () => void {
  const record = target as Record<PropertyKey, unknown>;
  const own = Object.getOwnPropertyDescriptor(target, key);
  if (own !== undefined && !('value' in own) && own.set !== undefined) {
    const previous = record[key];
    record[key] = value;
    return () => {
      record[key] = previous;
    };
  }
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: own?.enumerable ?? true,
    writable: true,
    value,
  });
  return () => {
    if (own === undefined) delete record[key];
    else Object.defineProperty(target, key, own);
  };
}
