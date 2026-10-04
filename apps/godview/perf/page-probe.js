// The perf harness's page probe, evaluated in Godview's renderer before any page script runs
// (offscreen-main.cjs adds it with `Page.addScriptToEvaluateOnNewDocument`). It records, all the
// time, into small buffers the harness reads per measurement window:
//
// - frames: one `performance.now()` per animation frame, from its own rAF loop;
// - long animation frames: Chromium's `long-animation-frame` entries (duration, blocking time);
// - rAF work: how long the page's own animation-frame callbacks ran — where the canvas views draw
//   (the swarm's loop and its inline physics, the rain, the timeline), so their per-frame cost shows
//   even while frames still land inside the 16.7 ms budget;
// - React commits, through a minimal DevTools global hook (React's own injection point, so the app
//   is unchanged): every commit counts, and a commit RENDERED the monitor view when the view's
//   fiber — the first child of the stage `<section class="vf-godview-monitor-stage">` — is a new
//   object carrying React's PerformedWork flag. Its `actualDuration` (development and profiling
//   builds time every render; Godview's renderer bundle is the development build) is what a
//   `<Profiler>` around the view would report;
// - every React root's commits and render time (build-mv M33): a view the host mounts in its OWN
//   root (view-sdk `/host`'s legacy bridge) never shows as a fiber in the host's tree, so the total
//   is read per root — each committed root's `current.actualDuration` is the time React spent
//   rendering that commit, every root of every renderer the hook sees.
//
// `window.__gvPerf.begin()` opens a window and `end()` closes it, returning that window's samples.
(() => {
  if (window.__gvPerf) return;
  const PERFORMED_WORK = 1;
  const frames = [];
  const loafs = [];
  const commits = [];
  const callbacks = [];
  // The page's callbacks are timed through a wrapper installed before any page script runs; the
  // probe's own sampler uses the original and is not counted.
  const nativeFrame = window.requestAnimationFrame.bind(window);
  // The harness's negative control (`--synthetic-b-ms`): arm B busy-waits this long in every callback.
  const slowMs = Number(window.__gvPerfSlowMs ?? 0);
  window.requestAnimationFrame = (callback) =>
    nativeFrame((time) => {
      const started = performance.now();
      try {
        callback(time);
        if (slowMs > 0) {
          const until = performance.now() + slowMs;
          while (performance.now() < until);
        }
      } finally {
        callbacks.push({ at: started, ms: performance.now() - started });
        if (callbacks.length > 60000) callbacks.splice(0, 30000);
      }
    });
  const step = (time) => {
    frames.push(time);
    if (frames.length > 20000) frames.splice(0, 10000);
    nativeFrame(step);
  };
  nativeFrame(step);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        loafs.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration ?? 0 });
      }
      if (loafs.length > 5000) loafs.splice(0, 2500);
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    // An engine without LoAF reports none; the harness says so.
  }

  let stageNode;
  /** The view's fiber as last committed: a new object only when React worked on it again. */
  let lastView;
  /** The child/sibling steps from the root to the stage's host fiber, found once and re-checked per commit. */
  let path;
  const follow = (root, steps) => {
    let node = root.current;
    for (const step of steps) {
      node = step === 'c' ? node?.child : node?.sibling;
      if (!node) return undefined;
    }
    return node;
  };
  const search = (root) => {
    // Depth first from the committed root: the stage sits ahead of the deck, so this stops early.
    const stack = [{ node: root.current.child, steps: ['c'] }];
    while (stack.length > 0) {
      const { node, steps } = stack.pop();
      if (!node) continue;
      if (node.stateNode === stageNode) return steps;
      stack.push({ node: node.sibling, steps: [...steps, 's'] });
      stack.push({ node: node.child, steps: [...steps, 'c'] });
    }
    return undefined;
  };
  const stageFiber = (root) => {
    if (!stageNode?.isConnected) {
      stageNode = document.querySelector('section.vf-godview-monitor-stage');
      path = undefined;
    }
    if (!stageNode) return undefined;
    let fiber = path && follow(root, path);
    if (fiber?.stateNode !== stageNode) {
      path = search(root);
      fiber = path && follow(root, path);
    }
    return fiber?.stateNode === stageNode ? fiber : undefined;
  };
  const viewName = (fiber) => fiber?.type?.displayName ?? fiber?.type?.name ?? null;
  /** Each root the hook has seen: its id, its container's name and where it sits (BELOW the stage: a
   * view's own root; HOLDING the stage: the host's). */
  const roots = new WeakMap();
  let rootCount = 0;
  const rootOf = (root) => {
    let known = roots.get(root);
    if (!known) {
      const container = root.containerInfo;
      const name = !container?.nodeName
        ? 'unknown'
        : `${container.nodeName.toLowerCase()}${container.id ? `#${container.id}` : ''}${typeof container.className === 'string' && container.className ? `.${container.className.trim().split(/\s+/).join('.')}` : ''}`;
      rootCount += 1;
      known = { id: rootCount, name, place: undefined };
      roots.set(root, known);
    }
    // Placed on the first commit that finds both in the document (the stage can arrive after a root).
    if (!known.place) {
      const stage = document.querySelector('section.vf-godview-monitor-stage');
      const container = root.containerInfo;
      if (stage && container?.isConnected) {
        known.place = container.contains?.(stage) ? 'host' : stage.contains(container) ? 'stage' : 'other';
      }
    }
    return known;
  };
  const seen = { commits: 0, stage: 0 };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      const at = performance.now();
      seen.commits += 1;
      const known = rootOf(root);
      const rootMs = typeof root.current?.actualDuration === 'number' ? root.current.actualDuration : 0;
      const stage = stageFiber(root);
      if (stage) seen.stage += 1;
      const view = stage?.child;
      const rendered = Boolean(view && view !== lastView && (view.flags & PERFORMED_WORK) !== 0);
      if (view) lastView = view;
      commits.push({
        at,
        view: rendered ? viewName(view) : null,
        ms: rendered && typeof view.actualDuration === 'number' ? view.actualDuration : 0,
        root: known,
        rootMs,
      });
      if (commits.length > 50000) commits.splice(0, 25000);
    },
  };

  let openedAt = 0;
  window.__gvPerf = {
    begin() {
      openedAt = performance.now();
      return openedAt;
    },
    end() {
      const closedAt = performance.now();
      const inside = (time) => time >= openedAt && time <= closedAt;
      const stamps = frames.filter(inside);
      const deltas = stamps.slice(1).map((time, index) => time - stamps[index]);
      const windowCommits = commits.filter((commit) => inside(commit.at));
      const windowCallbacks = callbacks.filter((entry) => inside(entry.at));
      const viewCommits = windowCommits.filter((commit) => commit.view !== null);
      const byRoot = new Map();
      for (const commit of windowCommits) {
        const entry = byRoot.get(commit.root) ?? {
          id: commit.root.id,
          name: commit.root.name,
          commits: 0,
          renderMs: 0,
        };
        entry.place = commit.root.place ?? 'unplaced';
        entry.commits += 1;
        entry.renderMs += commit.rootMs;
        byRoot.set(commit.root, entry);
      }
      return {
        ms: closedAt - openedAt,
        frameDeltas: deltas,
        loafs: loafs.filter((entry) => inside(entry.start)),
        loafSupported: PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame') ?? false,
        commits: windowCommits.length,
        viewCommits: viewCommits.length,
        viewRenderMs: viewCommits.reduce((sum, commit) => sum + commit.ms, 0),
        viewNames: [...new Set(viewCommits.map((commit) => commit.view))],
        rootRenderMs: windowCommits.reduce((sum, commit) => sum + commit.rootMs, 0),
        roots: [...byRoot.values()].sort((left, right) => left.id - right.id),
        rafWorkMs: windowCallbacks.reduce((sum, entry) => sum + entry.ms, 0),
        rafCallbacks: windowCallbacks.length,
        rafMaxMs: windowCallbacks.reduce((max, entry) => Math.max(max, entry.ms), 0),
        // Whether the instrument saw anything at all: React's renderers, every commit, commits that found the stage.
        seen: { renderers: window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size, roots: rootCount, ...seen },
      };
    },
  };
})();
