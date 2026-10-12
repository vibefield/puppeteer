// @vitest-environment happy-dom
import { createElement, type ComponentProps } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MonitorAgentRow, MonitorModelChange, MonitorModelSnapshot } from '@vibefield/puppeteer-view-sdk/model';
import { agentViewsFixture } from '@vibefield/puppeteer-view-sdk/testing';

// THE WITNESS FOR M176 ITEM 1, AT GODVIEW'S LEVEL: the real entry (`main.tsx`) mounts the real Godview into `#root`,
// with the usage column, the piece inside the ResizeObserver'd chrome, throwing on every render. Then the window is
// resized and the model published, many times. The monitor and its view stay mounted, the piece reads unavailable,
// and it is never rendered again: before MV-8b every Godview render retried it, and its fallback, by reflowing the
// observed chrome, asked for the next render itself.
//
// Only what a test cannot have is stood in for: the preload's two bridges, Ghosttea's runtime and workspace (no
// terminal daemon here), and layout (happy-dom measures every box as zero, so the stage and the chrome are given
// their rects, and the ResizeObserver is driven by hand). The tweak panel is wrapped to count Godview's renders.

const witness = vi.hoisted(() => ({ usageRenders: 0, godviewRenders: 0 }));

vi.mock('@vibefield/puppeteer-views', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vibefield/puppeteer-views')>();
  return {
    ...actual,
    // A persistent bad read in the piece that sits in the observed chrome.
    UsageColumn: (): never => {
      witness.usageRenders += 1;
      throw new TypeError("Cannot read properties of undefined (reading 'entries')");
    },
  };
});

vi.mock('./TweakPanel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./TweakPanel.js')>();
  return {
    ...actual,
    // Rendered by every Godview render (it is never memoized), so its count is Godview's.
    TweakPanel: (props: ComponentProps<typeof actual.TweakPanel>) => {
      witness.godviewRenders += 1;
      return createElement(actual.TweakPanel, props);
    },
  };
});

vi.mock('@vibecook/ghosttea-react', () => {
  const runtime = Object.assign(new EventTarget(), {
    configSnapshot: undefined,
    listSessions: () => Promise.resolve([]),
    createSession: () => Promise.reject(new Error('no terminal daemon in the witness')),
    sessionCreatedHere: () => false,
    sessionHasInput: () => false,
    remoteSession: () => undefined,
  });
  return {
    GhostteaProvider: ({ children }: { children?: unknown }) => children,
    createGhostteaTerminalRuntime: () => runtime,
    waitForGhostteaRendererPorts: () => new Promise(() => undefined),
    useGhostteaRuntime: () => runtime,
  };
});

vi.mock('@vibecook/ghosttea-react/workspace', () => ({
  GHOSTTY_COLOR_THEMES: [],
  TERMINAL_THEMES: { midnight: {}, daylight: {} },
  // No panes: the deck stays empty, which the witness does not need.
  GhostteaWorkspace: () => null,
  useRemoteSessionLifecycle: () => undefined,
}));

/** The rects layout would give: a 1180×252 stage with the usage column at its left. */
const layout = {
  stage: { left: 0, top: 0, width: 1180, height: 252 },
  chrome: { left: 12, top: 12, width: 168, height: 96 },
};
const rectOf = (box: { left: number; top: number; width: number; height: number }): DOMRect =>
  ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  }) as DOMRect;

/** The ResizeObserver, driven by hand: `tick()` is the browser reporting a resize to every observer. */
const observers = new Set<{ callback: ResizeObserverCallback; observer: ResizeObserver }>();
class HandResizeObserver {
  readonly entry: { callback: ResizeObserverCallback; observer: ResizeObserver };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, observer: this as unknown as ResizeObserver };
    observers.add(this.entry);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    observers.delete(this.entry);
  }
}
const tick = (): void => {
  for (const { callback, observer } of [...observers]) callback([], observer);
};

/** The model as main would send it on its one channel (M23). */
let listener: ((update: MonitorModelSnapshot | MonitorModelChange) => void) | undefined;
let revision = 1;
const toRow = (view: ReturnType<typeof agentViewsFixture>[number]): MonitorAgentRow => {
  const {
    colour: _colour,
    active: _active,
    receded: _receded,
    attachment: _attachment,
    spawnHint: _spawnHint,
    visualId: _visualId,
    ...row
  } = view;
  return row;
};
const rows = agentViewsFixture(24, { terminals: false }).map(toRow);
const send = (update: MonitorModelSnapshot | MonitorModelChange): void => listener?.(update);

const console_ = { errors: [] as unknown[][] };

function bridges(): void {
  const subscription = () => () => undefined;
  const nothing = () => Promise.resolve(undefined);
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      tabId: 'witness',
      resetWorkspace: false,
      platform: 'darwin',
      defaultShell: '/bin/zsh',
      remoteSessionsEnabled: false,
      claimExistingSessions: false,
      takeRestoreWorkspace: () => Promise.resolve(null),
      openExternal: nothing,
      writeClipboard: nothing,
      readClipboard: () => Promise.resolve(''),
      setTerminalCanCopy: () => undefined,
      showContextMenu: nothing,
      toggleFullscreen: nothing,
      closeWindow: nothing,
      newWindow: nothing,
      quit: nothing,
      closeAllWindows: nothing,
      openConfig: nothing,
      reloadConfig: nothing,
      newTab: nothing,
      selectTab: () => undefined,
      closeTab: nothing,
      onMenuAction: subscription,
      setTheme: () => undefined,
      onThemeChanged: subscription,
      onTerminalSessionHandoff: subscription,
      acknowledgeTerminalSessionHandoff: () => undefined,
      updateTabSessions: () => undefined,
      updateWorkspace: () => undefined,
      updateActiveCwd: () => undefined,
      resolveProcessCwd: () => Promise.resolve(undefined),
    },
  });
  Object.defineProperty(window, 'puppeteer', {
    configurable: true,
    value: {
      historyStatus: nothing,
      historyFacts: () => Promise.resolve([]),
      historySearch: nothing,
      accountUsage: nothing,
      onAccountUsage: subscription,
      onMonitorModel: (next: typeof listener) => {
        listener = next;
        return () => {
          if (listener === next) listener = undefined;
        };
      },
      requestMonitorSnapshot: () => queueMicrotask(() => send({ revision, rows: rows.slice(0, 4) })),
      reportMonitorShown: () => undefined,
      reportMonitorTerminals: () => undefined,
      acknowledgeMonitorRow: () => undefined,
      listAgentSessions: () => Promise.resolve([]),
      listChromeMonitors: () => Promise.resolve([]),
      onAgentSession: subscription,
      onAgentRemoved: subscription,
      onChromeMonitorState: subscription,
      onChromeMonitorRemoved: subscription,
      onAgentMonitorNotification: subscription,
      rehydratePane: () => Promise.resolve(null),
      onProfiles: subscription,
      profiles: () => Promise.resolve([]),
      profileDefaults: () => Promise.resolve({}),
      setProfileDefault: () => Promise.resolve({}),
      launcherAgents: () => Promise.resolve([]),
      launcherRecent: () => Promise.resolve([]),
      launcherWords: () => Promise.resolve([]),
    },
  });
}

/** A Storage in memory: what the renderer reads and writes its keys through. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
const stage = (): Element | null => document.querySelector('section.vf-godview-monitor-stage');
const viewRoot = (): Element | null =>
  document.querySelector('section.vf-godview-monitor-stage [data-monitor-view-root]');
const listRows = (): number => document.querySelectorAll('.vf-monitor-list-row').length;
const usageStatus = (): string | null =>
  document.querySelector('.vf-monitor-chrome [role="status"]')?.textContent ?? null;

/** Generous: importing the whole renderer and mounting it takes seconds on a loaded machine. */
const MOUNT_MS = 120_000;

beforeAll(async () => {
  // Node 25+ owns a global `localStorage` (absent without --localstorage-file) that hides happy-dom's, and under
  // vitest `window` is that same global: hand Godview storage of its own, as Electron's renderer has it.
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: memoryStorage() });
  }
  bridges();
  globalThis.ResizeObserver = HandResizeObserver as unknown as typeof ResizeObserver;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('vf-godview-monitor-stage')) return rectOf(layout.stage);
    if (this.classList.contains('vf-monitor-chrome')) return rectOf(layout.chrome);
    return measure.call(this);
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    console_.errors.push(args);
  });
  // The list draws rows as DOM, so the witness can read what the view shows.
  localStorage.setItem('godview:monitor-view:v1', 'list');
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  await import('./main.js');
  await vi.waitFor(
    () => {
      expect(viewRoot()).not.toBeNull();
      expect(listRows()).toBe(4);
      expect(usageStatus()).toBe('usage unavailable');
    },
    { timeout: MOUNT_MS },
  );
}, MOUNT_MS);

afterAll(() => {
  vi.restoreAllMocks();
});

describe('Godview with a chrome piece that keeps throwing (M176 item 1)', () => {
  it(
    'keeps the monitor and its view through resizes and publishes, and never renders the failed piece again',
    async () => {
      const usageAfterMount = witness.usageRenders;
      const reports = () => console_.errors.filter(([said]) => said === '[chrome] usage failed to render').length;

      // Equal ticks, each in its own task: the observer fires and nothing moved.
      const beforeEqual = witness.godviewRenders;
      for (let index = 0; index < 30; index += 1) {
        tick();
        await flush();
      }
      const equalTickRenders = witness.godviewRenders - beforeEqual;

      // Real resizes: each one moves the stage, and Godview renders it.
      const beforeResize = witness.godviewRenders;
      for (let index = 1; index <= 30; index += 1) {
        layout.stage.width = 1180 + index;
        layout.chrome.height = 96 + (index % 3);
        tick();
        await flush();
      }
      const resizeRenders = witness.godviewRenders - beforeResize;

      // Model publishes: twenty changes, each a new row, through the replica to the view.
      const beforePublish = witness.godviewRenders;
      for (let index = 4; index < 24; index += 1) {
        send({ since: revision, revision: revision + 1, upserts: [rows[index]!], removed: [] });
        revision += 1;
        await flush();
      }
      await vi.waitFor(() => expect(listRows()).toBe(24), { timeout: MOUNT_MS });
      const publishRenders = witness.godviewRenders - beforePublish;

      // Godview rendered for every real change, and for no equal tick.
      expect(resizeRenders).toBeGreaterThanOrEqual(30);
      expect(publishRenders).toBeGreaterThanOrEqual(20);
      // The monitor and its view stayed; the piece says what it is; it was rendered on mount only, and heard once.
      expect({
        equalTickRenders,
        stage: stage() !== null,
        viewRoot: viewRoot() !== null,
        rows: listRows(),
        usage: usageStatus(),
        usageRendersSinceMount: witness.usageRenders - usageAfterMount,
        reports: reports(),
      }).toEqual({
        equalTickRenders: 0,
        stage: true,
        viewRoot: true,
        rows: 24,
        usage: 'usage unavailable',
        usageRendersSinceMount: 0,
        reports: 1,
      });
    },
    MOUNT_MS,
  );
});
