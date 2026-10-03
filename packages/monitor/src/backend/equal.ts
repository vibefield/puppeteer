/**
 * Structural equality for the plain data the model is made of. A key whose
 * value is undefined counts as absent, so a row built with conditional spreads
 * and one built with explicit undefineds compare equal.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    if (!deepEqual(a[key], b[key])) return false;
  }
  for (const key of Object.keys(b)) {
    if (b[key] !== undefined && a[key] === undefined) return false;
  }
  return true;
}

/** Monitor data is JSON-plain; freezing it on the way in is what makes a shared row safe to hand out. */
export function freezeTree<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    for (const nested of Array.isArray(candidate) ? candidate : Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };
  freeze(value);
  return value;
}
