/**
 * Equality and immutability for JSON-plain values.
 *
 * What crosses a transport is a new object every time, so the replica asks
 * whether a row CHANGED rather than whether it is the same object. Two values
 * are the same when they would serialize alike: a property holding `undefined`
 * is an absent one, and NaN (which no transport carries) equals itself.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') return Number.isNaN(left) && Number.isNaN(right);
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameJson(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  let defined = 0;
  for (const key of Object.keys(leftRecord)) {
    const value = leftRecord[key];
    if (value === undefined) continue;
    defined += 1;
    if (!sameJson(value, rightRecord[key])) return false;
  }
  for (const key of Object.keys(rightRecord)) {
    if (rightRecord[key] !== undefined) defined -= 1;
  }
  return defined === 0;
}

/** Freezes a JSON-plain tree in place: what the replica keeps, nobody downstream may change. */
export function freezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  // A frozen parent proves nothing about its children, so the walk always goes all the way down.
  for (const nested of Object.values(value)) freezeJson(nested);
  return Object.freeze(value);
}
