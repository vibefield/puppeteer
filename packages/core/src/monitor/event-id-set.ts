// The monitor is a pure reducer: old snapshots must keep their own dedup set.
// Copying a native Set for every event made a long run quadratic. A persistent
// AVL index copies only the search path; the shared log preserves Set iteration
// order and retains exact deduplication for the entire run.
interface Node {
  readonly value: string;
  readonly left: Node | undefined;
  readonly right: Node | undefined;
  readonly height: number;
}
interface Entry {
  readonly value: string;
  readonly previous: Entry | undefined;
}
const height = (node: Node | undefined): number => node?.height ?? 0;
function node(value: string, left?: Node, right?: Node): Node {
  return { value, left, right, height: 1 + Math.max(height(left), height(right)) };
}
function left(root: Node): Node {
  const pivot = root.right!;
  return node(pivot.value, node(root.value, root.left, pivot.left), pivot.right);
}
function right(root: Node): Node {
  const pivot = root.left!;
  return node(pivot.value, pivot.left, node(root.value, pivot.right, root.right));
}
function insert(root: Node | undefined, value: string): Node {
  if (!root) return node(value);
  if (value === root.value) return root;
  const updated =
    value < root.value
      ? node(root.value, insert(root.left, value), root.right)
      : node(root.value, root.left, insert(root.right, value));
  const balance = height(updated.left) - height(updated.right);
  if (balance > 1) {
    return right(
      height(updated.left!.left) >= height(updated.left!.right)
        ? updated
        : node(updated.value, left(updated.left!), updated.right),
    );
  }
  if (balance < -1) {
    return left(
      height(updated.right!.right) >= height(updated.right!.left)
        ? updated
        : node(updated.value, updated.left, right(updated.right!)),
    );
  }
  return updated;
}

export class EventIdSet implements ReadonlySet<string> {
  readonly [Symbol.toStringTag] = 'Set';
  readonly size: number;
  private readonly root: Node | undefined;
  private readonly tail: Entry | undefined;
  constructor(size = 0, root?: Node, tail?: Entry) {
    this.size = size;
    this.root = root;
    this.tail = tail;
  }
  has(value: string): boolean {
    let current = this.root;
    while (current) {
      if (value === current.value) return true;
      current = value < current.value ? current.left : current.right;
    }
    return false;
  }
  add(value: string): EventIdSet {
    if (this.has(value)) return this;
    return new EventIdSet(this.size + 1, insert(this.root, value), { value, previous: this.tail });
  }
  *values(): SetIterator<string> {
    const values: string[] = [];
    for (let entry = this.tail; entry; entry = entry.previous) values.push(entry.value);
    for (let index = values.length - 1; index >= 0; index--) yield values[index]!;
  }
  keys(): SetIterator<string> {
    return this.values();
  }
  [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }
  *entries(): SetIterator<[string, string]> {
    for (const value of this) yield [value, value];
  }
  forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const value of this) callback.call(thisArg, value, value, this);
  }
}

export function withEventId(previous: ReadonlySet<string>, value: string): EventIdSet {
  let set = previous instanceof EventIdSet ? previous : new EventIdSet();
  if (!(previous instanceof EventIdSet)) for (const id of previous) set = set.add(id);
  return set.add(value);
}
