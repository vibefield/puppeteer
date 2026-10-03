/**
 * Freezes a view's input all the way down, so a view that writes to it throws
 * where the write happens (MV-W4: a view never mutates its input).
 *
 * `Object.freeze` cannot stop a Map's or a Set's own methods, so their
 * mutators are replaced on the instance with ones that throw. Everything is
 * frozen in place and returned.
 */

function refuse(kind: string): () => never {
  return () => {
    throw new TypeError(`Cannot modify a frozen ${kind}: a view never writes to its input`);
  };
}

export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    // Already frozen (a shared fixture, or an earlier call): its children may still not be.
    const frozen = Object.isFrozen(node);
    if (node instanceof Map) {
      for (const [key, entry] of node) {
        visit(key);
        visit(entry);
      }
      if (!frozen) {
        for (const method of ['set', 'delete', 'clear'] as const) {
          Object.defineProperty(node, method, { value: refuse('map') });
        }
      }
    } else if (node instanceof Set) {
      for (const entry of node) visit(entry);
      if (!frozen) {
        for (const method of ['add', 'delete', 'clear'] as const) {
          Object.defineProperty(node, method, { value: refuse('set') });
        }
      }
    }
    for (const key of Reflect.ownKeys(node)) {
      visit((node as Record<PropertyKey, unknown>)[key]);
    }
    if (!frozen) Object.freeze(node);
  };
  visit(value);
  return value;
}
