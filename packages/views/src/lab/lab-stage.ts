import { createElement, useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  FrameScheduler,
  ModelChanges,
  MonitorModel,
  MonitorTheme as SdkTheme,
  MonitorView,
  StageGeometry,
} from '@vibecook/puppeteer-view-sdk';
import { MonitorViewHost, type MonitorReplicaLike, type ViewSlotCommands } from '@vibecook/puppeteer-view-sdk/host';
import { MONITOR_CHROME_ATTRIBUTE, MONITOR_STAGE_CLASS } from '../monitor/chrome.js';
import { useMonitorPalette } from '../monitor/palette.js';
import type { MonitorParameters } from '../monitor/parameters.js';
import type { AgentMonitorProps, MonitorActions, MonitorAgent, MonitorTheme } from '../monitor/types.js';
import { installLabClock, type LabClock } from './lab-clock.js';
import { labModel } from './lab-model.js';
import { LAB_NOW_MS, LAB_SEED, labWorld } from './lab-world.js';

// One view in Godview's stage, over the seeded world (MV-0). Every view lab
// mounts its SHIPPING component through this, at the sizes Godview gives the
// stage, in either theme, with the host's animations switch — and with
// `capture=1` on the capture clock, stripped to the stage alone, so the golden
// tool can clip it at the page's origin.
//
// URL: `theme=light|dark` · `size=compact|default|wide` (all three when absent) ·
// `n=<rows>` · `animations=0|1` · `seed=<text>` · `capture=1`.

export type LabSize = 'compact' | 'default' | 'wide';

/** The stage as Godview lays it out: 35 % of the window's height, never under 170 px. */
export const LAB_SIZES: Readonly<
  Record<LabSize, { readonly width: number; readonly height: number; readonly note: string }>
> = {
  compact: {
    width: 680,
    height: 170,
    note: 'Godview at its narrowest window (680 wide), the stage at its 170 px floor.',
  },
  default: { width: 1180, height: 252, note: 'Godview’s default window (1180 × 720), the stage at 35 %.' },
  wide: {
    width: 1728,
    height: 378,
    note: 'A window filling a 1728-point display (1080 under the menu bar), the stage at 35 %.',
  },
};
const SIZE_ORDER: readonly LabSize[] = ['compact', 'default', 'wide'];

export interface LabParams {
  readonly theme: MonitorTheme;
  readonly sizes: readonly LabSize[];
  readonly n: number;
  readonly animations: boolean;
  readonly capture: boolean;
  readonly seed: string;
}

export function readLabParams(search: string, defaults: { n?: number } = {}): LabParams {
  const params = new URLSearchParams(search);
  const size = params.get('size');
  const n = Number(params.get('n'));
  return {
    theme: params.get('theme') === 'dark' ? 'dark' : 'light',
    sizes: SIZE_ORDER.includes(size as LabSize) ? [size as LabSize] : SIZE_ORDER,
    n: params.has('n') && Number.isFinite(n) && n >= 0 ? Math.floor(n) : (defaults.n ?? 20),
    animations: params.get('animations') !== '0',
    capture: params.get('capture') === '1',
    seed: params.get('seed') || LAB_SEED,
  };
}

/** What the golden tool reaches for on `window`. */
export interface LabHandle {
  readonly capture: boolean;
  /** Resolves once every stage has committed and the fonts are in. */
  ready(): Promise<void>;
  /** Capture mode: `frames` frames of virtual time at 60 Hz; otherwise that many real frames. */
  step(frames: number): Promise<void>;
  /** Move the world on (`labWorld({ churn: true })`) and let React commit it: a frame sequence's change. */
  churn(): Promise<void>;
}

declare global {
  interface Window {
    __vfLab?: LabHandle;
  }
}

export interface ViewLabOptions {
  /** The page's `.vf-godview` root: the theme and the animations switch live on it. */
  readonly root: HTMLElement;
  /** Where the stages go. */
  readonly mount: Element;
  /** A legacy view's component, handed the world's legacy rows. */
  readonly Component?: ComponentType<AgentMonitorProps> | undefined;
  /** A view on the SDK (MV-4 on): mounted through the view host, as Godview mounts it, over the same world said as
   * the model (`lab-model.ts`), in the same order. One of `Component` and `view`. */
  readonly view?: MonitorView | undefined;
  readonly parameters: MonitorParameters;
  /** Put around each stage's view: the swarm's physics provider. */
  readonly wrap?: (view: ReactElement) => ReactElement;
  readonly defaults?: { n?: number };
}

export interface ViewLab {
  readonly params: LabParams;
  setParameters(parameters: MonitorParameters): void;
  setTheme(theme: MonitorTheme): void;
  setAnimations(on: boolean): void;
}

interface StageProps {
  size: LabSize;
  params: LabParams;
  options: ViewLabOptions;
  parameters: MonitorParameters;
  churn: boolean;
  onCommit(): void;
}

/** The stage before its first measurement, as Godview starts it. */
const EMPTY_STAGE: StageGeometry = Object.freeze({
  width: 0,
  height: 0,
  insets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
  obstacles: Object.freeze([]),
});
const NO_CHANGES: ModelChanges = Object.freeze({ added: [], updated: [], removed: [] });

/**
 * Capture mode drives the slot's frame work in a microtask: a change the golden tool makes between stepped frames
 * (`churn`) then reaches the view before the next frame, as a legacy component took its props. On the display's
 * frames the slot's own callback would follow the view's, registered a frame earlier, and the view would draw the
 * change one frame later than the legacy drew it. That frame rule is the host's (M7); a view's goldens are the view's.
 */
const CAPTURE_SCHEDULER: FrameScheduler = {
  request(work) {
    let live = true;
    queueMicrotask(() => {
      if (live) work();
    });
    return () => {
      live = false;
    };
  },
};

/** One world as a replica: the model it is, never changing; a new world is a new replica. */
function labReplica(model: MonitorModel): MonitorReplicaLike {
  return { getSnapshot: () => ({ model, changes: NO_CHANGES }), subscribe: () => () => undefined };
}

function Stage({ size, params, options, parameters, churn, onCommit }: StageProps): ReactElement {
  const { width, height, note } = LAB_SIZES[size];
  const stageRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const palette = useMonitorPalette(stageRef);
  const sdkView = options.view;
  const world = useMemo(
    () =>
      sdkView
        ? undefined
        : labWorld({ n: params.n, seed: params.seed, tint: palette.tint, neutral: palette.neutral, churn }),
    [sdkView, params.n, params.seed, palette.tint, palette.neutral, churn],
  );
  const replica = useMemo(
    () =>
      sdkView
        ? labReplica(labModel({ n: params.n, seed: params.seed, tint: palette.tint, neutral: palette.neutral, churn }))
        : undefined,
    [sdkView, params.n, params.seed, palette.tint, palette.neutral, churn],
  );
  const [selected, setSelected] = useState<string>();
  const actions = useMemo<MonitorActions>(
    () => ({ select: (agent: MonitorAgent) => setSelected(agent.id), createAt: () => undefined }),
    [],
  );
  const commands = useMemo<ViewSlotCommands>(() => ({ select: setSelected, create: () => undefined }), []);
  const theme = useMemo<SdkTheme>(
    () => ({ scheme: params.theme, tokens: palette, reducedMotion: false, animations: params.animations }),
    [palette, params.animations, params.theme],
  );
  // As Godview publishes them: flowing legacy views clear the chrome with these, the swarm reads its rect, and a
  // view on the SDK is handed the same measurement as its stage (MV-D19): the chrome's right edge as the left inset.
  const [stageGeometry, setStageGeometry] = useState<StageGeometry>(EMPTY_STAGE);
  useEffect(() => {
    const stage = stageRef.current;
    const chrome = chromeRef.current;
    if (!stage || !chrome) return;
    const publish = (): void => {
      const rect = chrome.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const chromeRight = Math.round(rect.right - stageRect.left);
      stage.style.setProperty('--vf-monitor-chrome-height', `${Math.round(rect.height)}px`);
      stage.style.setProperty('--vf-monitor-chrome-right', `${chromeRight}px`);
      // A legacy view reads only the two properties above: its lab renders exactly as it always did.
      if (!sdkView) return;
      setStageGeometry({
        width: Math.round(stageRect.width),
        height: Math.round(stageRect.height),
        insets: { top: 0, right: 0, bottom: 0, left: chromeRight },
        obstacles: [
          {
            x: Math.round(rect.left - stageRect.left),
            y: Math.round(rect.top - stageRect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        ],
      });
    };
    const observer = new ResizeObserver(publish);
    observer.observe(chrome);
    if (sdkView) observer.observe(stage);
    publish();
    return () => observer.disconnect();
    // the view a stage mounts is fixed for the page's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // An SDK view mounts once the stage is measured (MV-D19): its first input then carries the chrome's rectangles,
  // as Godview's does within a frame of mounting, so a view that places bodies clear of the chrome (the swarm)
  // places its first world right. A legacy view renders as it always did. The stage counts as committed once its
  // view is on it.
  const ready = !sdkView || stageGeometry !== EMPTY_STAGE;
  useEffect(() => {
    if (ready) onCommit();
  }, [ready, onCommit]);
  const view = !sdkView
    ? createElement(options.Component!, { agents: world!.agents, parameters, actions, palette })
    : replica && ready
      ? createElement(MonitorViewHost, {
          replica,
          view: sdkView,
          stage: stageGeometry,
          theme,
          parameters,
          commands,
          scheduler: params.capture ? CAPTURE_SCHEDULER : undefined,
        })
      : null;
  return createElement(
    'figure',
    { className: 'view-lab-stage', 'data-lab-stage': size },
    createElement(
      'section',
      { ref: stageRef, className: MONITOR_STAGE_CLASS, style: { width, height }, 'aria-label': 'Agent monitor' },
      view === null ? null : options.wrap ? options.wrap(view) : view,
      createElement('div', { ref: chromeRef, className: 'vf-monitor-chrome', [MONITOR_CHROME_ATTRIBUTE]: '' }),
    ),
    params.capture
      ? null
      : createElement(
          'figcaption',
          null,
          createElement('b', null, `${size} · ${width} × ${height} · n = ${params.n}`),
          createElement('span', null, selected ? `${note} Selected: ${selected}.` : note),
        ),
  );
}

/**
 * Mount a view lab: read the URL, install the capture clock when asked, stamp
 * the theme and the animations switch on the root, and render one stage per
 * size. The returned handle lets a page's own controls drive the same stages.
 */
export function mountViewLab(options: ViewLabOptions): ViewLab {
  const params = readLabParams(location.search, options.defaults);
  const clock: LabClock | undefined = params.capture
    ? installLabClock({ nowMs: LAB_NOW_MS, seed: params.seed })
    : undefined;
  const { root } = options;
  // Capture mode hides everything on the page but this (`lab/view-lab.css`).
  options.mount.classList.add('view-lab-mount');
  if (params.capture) document.documentElement.dataset.labCapture = '1';
  const setTheme = (theme: MonitorTheme): void => {
    root.classList.toggle('theme-light', theme === 'light');
    root.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
  };
  const setAnimations = (on: boolean): void => root.setAttribute('data-godview-animations', on ? 'on' : 'off');
  setTheme(params.theme);
  setAnimations(params.animations);

  let committed = 0;
  let signalReady: () => void = () => undefined;
  const mounted = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const onCommit = (): void => {
    committed += 1;
    if (committed >= params.sizes.length) signalReady();
  };
  let pushParameters: (parameters: MonitorParameters) => void = () => undefined;
  let pushChurn: () => void = () => undefined;
  function Lab(): ReactElement {
    const [parameters, setParameters] = useState(options.parameters);
    const [churn, setChurn] = useState(false);
    pushParameters = setParameters;
    pushChurn = () => setChurn(true);
    return createElement(
      'div',
      { className: 'view-lab-stages' },
      params.sizes.map((size) =>
        createElement(Stage, { key: size, size, params, options, parameters, churn, onCommit }),
      ),
    );
  }
  createRoot(options.mount).render(createElement(Lab));

  const frames = async (count: number): Promise<void> => {
    for (let frame = 0; frame < count; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  };
  window.__vfLab = {
    capture: params.capture,
    ready: async () => {
      await mounted;
      await document.fonts.ready;
      // The first layout's observers (and what they re-render) land before any frame is stepped.
      await (clock ? clock.settle() : frames(2));
    },
    step: (count) => (clock ? clock.step(count) : frames(count)),
    churn: async () => {
      pushChurn();
      // React commits on a message: two turns of the real loop and the new rows are in.
      for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
  return { params, setParameters: (parameters) => pushParameters(parameters), setTheme, setAnimations };
}
