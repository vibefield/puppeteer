import { createElement, useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MONITOR_CHROME_ATTRIBUTE, MONITOR_STAGE_CLASS } from '../monitor/chrome.js';
import { useMonitorPalette } from '../monitor/palette.js';
import type { MonitorParameters } from '../monitor/parameters.js';
import type { AgentMonitorProps, MonitorActions, MonitorAgent, MonitorTheme } from '../monitor/types.js';
import { installLabClock, type LabClock } from './lab-clock.js';
import { LAB_NOW_MS, LAB_SEED, labWorld } from './lab-world.js';

// One view in Godview's stage, over the seeded world (MV-0). Every view lab
// mounts its SHIPPING component through this, at the sizes Godview gives the
// stage, in either theme, with the host's animations switch — and with
// `capture=1` on the capture clock, stripped to the stage alone, so the golden
// tool can clip it at the page's origin.
//
// URL: `theme=light|dark` · `size=compact|default|wide` (all three when absent) ·
// `n=<rows>` · `animations=0|1` · `seed=<text>` · `capture=1` · `book=0|1` (views that read the book).

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
  readonly book: boolean;
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
    book: params.get('book') !== '0',
  };
}

/** What the golden tool reaches for on `window`. */
export interface LabHandle {
  readonly capture: boolean;
  /** Resolves once every stage has committed and the fonts are in. */
  ready(): Promise<void>;
  /** Capture mode: `frames` frames of virtual time at 60 Hz; otherwise that many real frames. */
  step(frames: number): Promise<void>;
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
  readonly Component: ComponentType<AgentMonitorProps>;
  readonly parameters: MonitorParameters;
  /** Hand the view the world's book (`history`), unless `book=0` says otherwise. */
  readonly book?: boolean;
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
  onCommit(): void;
}

function Stage({ size, params, options, parameters, onCommit }: StageProps): ReactElement {
  const { width, height, note } = LAB_SIZES[size];
  const stageRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const palette = useMonitorPalette(stageRef);
  const world = useMemo(
    () => labWorld({ n: params.n, seed: params.seed, tint: palette.tint, neutral: palette.neutral }),
    [params.n, params.seed, palette.tint, palette.neutral],
  );
  const [selected, setSelected] = useState<string>();
  const actions = useMemo<MonitorActions>(
    () => ({ select: (agent: MonitorAgent) => setSelected(agent.id), createAt: () => undefined }),
    [],
  );
  // As Godview publishes them: flowing views clear the chrome with these, the swarm reads its rect.
  useEffect(() => {
    const stage = stageRef.current;
    const chrome = chromeRef.current;
    if (!stage || !chrome) return;
    const publish = (): void => {
      const rect = chrome.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      stage.style.setProperty('--vf-monitor-chrome-height', `${Math.round(rect.height)}px`);
      stage.style.setProperty('--vf-monitor-chrome-right', `${Math.round(rect.right - stageRect.left)}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(chrome);
    publish();
    return () => observer.disconnect();
  }, []);
  useEffect(onCommit, [onCommit]);
  const view = createElement(options.Component, {
    agents: world.agents,
    parameters,
    actions,
    palette,
    ...(options.book && params.book ? { history: world.history } : {}),
  });
  return createElement(
    'figure',
    { className: 'view-lab-stage', 'data-lab-stage': size },
    createElement(
      'section',
      { ref: stageRef, className: MONITOR_STAGE_CLASS, style: { width, height }, 'aria-label': 'Agent monitor' },
      options.wrap ? options.wrap(view) : view,
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
  function Lab(): ReactElement {
    const [parameters, setParameters] = useState(options.parameters);
    pushParameters = setParameters;
    return createElement(
      'div',
      { className: 'view-lab-stages' },
      params.sizes.map((size) => createElement(Stage, { key: size, size, params, options, parameters, onCommit })),
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
  };
  return { params, setParameters: (parameters) => pushParameters(parameters), setTheme, setAnimations };
}
