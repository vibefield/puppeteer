/**
 * The React root a React-drawn view lives in: the adapter's, one per mount, on
 * the element the host hands the view.
 *
 * A view's root is its own, never a branch of the host's tree. It shares no
 * context with the host and no `useId` space: every mount gets its own
 * identifier prefix, so a view's ids can never collide with the host's or
 * another view's.
 */

import { createRoot, type Root } from 'react-dom/client';

let mounts = 0;
let hostCommits = 0;

export function createViewRoot(element: HTMLElement, viewId: string): Root {
  mounts += 1;
  return createRoot(element, { identifierPrefix: `${viewId}-${mounts}-` });
}

/**
 * Runs `work` as part of a React host's commit (`MonitorViewHost`'s layout
 * effects). React will not unmount a root synchronously while any root is
 * committing: it warns and finishes later. A view unmounted from inside a
 * host's commit therefore lets go of its root a microtask later, after the
 * host has already taken the root's element out of the document.
 */
export function duringHostCommit<T>(work: () => T): T {
  hostCommits += 1;
  try {
    return work();
  } finally {
    hostCommits -= 1;
  }
}

export function releaseViewRoot(root: Root): void {
  if (hostCommits > 0) queueMicrotask(() => root.unmount());
  else root.unmount();
}
