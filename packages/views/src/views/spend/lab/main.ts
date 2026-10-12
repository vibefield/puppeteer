import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentView, ModelChanges, MonitorModel, MonitorTheme, StageGeometry } from '@vibefield/puppeteer-view-sdk';
import { MonitorViewHost, type MonitorReplicaLike, type ViewSlotCommands } from '@vibefield/puppeteer-view-sdk/host';
import { mountViewLab } from '../../../lab/lab-stage.js';
import { useMonitorPalette } from '../../../monitor/palette.js';
import { monitorParameterDefaults } from '../../../monitor/parameters.js';
import { spendMonitorView } from '../index.js';
import { SPEND_WINDOW_MS } from '../spend-scale.js';
import { geometryFor } from '../SpendView.js';
import { spendAfternoon, spendRows } from './spend-fixtures.js';

// The spend lab: the shipping view over a live afternoon's last ten minutes —
// each line what its agent spent in them, from $0; the list each run's total —
// mounted through the view host as Godview mounts it, at the sizes Godview
// gives it, in either theme, plus a moment set (SV-D18) and twenty agents (the
// dock, SV-D19). The rows are folded again every second, as the backend folds
// them whenever a reading moves and at every step boundary, so the window
// follows now. What is drawn here is what Godview draws; a design change is
// reviewed here as pixels.
//
// `?theme=dark` opens dark; `?only=<id>` shows one stage; `?chrome=<px>` insets the view past a usage column;
// `?weight=<px>&wash=<x>` sets the view's two tunables, as Godview's panel does; `?still=1` hands the view the
// animations switch off (the reduced-motion preference is read as Godview reads it).
//
// `?n=<rows>` (or `?capture=1`) swaps the afternoon for the seeded world in Godview's stage, as the other view labs
// show it (`lab/lab-stage.ts`): `?size=`, `?animations=0`. That page is what the goldens capture.

const MIN = 60_000;

interface Stage {
  id: string;
  title: string;
  note: string;
  width: number;
  height: number;
  crowd?: boolean;
  /** A moment set this long before the lab opened, by a press on empty chart there. */
  momentAgo?: number;
}

const STAGES: readonly Stage[] = [
  {
    id: 'wide',
    title: 'Godview, the terminals away',
    note: '1180 × 640: two-line rows.',
    width: 1180,
    height: 640,
  },
  {
    id: 'squeezed',
    title: 'Godview, the terminals up',
    note: '1180 × 300: one-line rows of 30 px.',
    width: 1180,
    height: 300,
  },
  {
    id: 'narrow',
    title: 'Godview, narrow',
    note: '400 × 260: a window at its narrowest.',
    width: 400,
    height: 260,
  },
  {
    id: 'held',
    title: 'A moment set',
    note: 'Six minutes back, as a click on empty chart sets it (SV-D18); End or the Now pill lets go. tower sends a total and no buckets, so then it is not recorded.',
    width: 1180,
    height: 640,
    momentAgo: 6 * MIN,
  },
  {
    id: 'crowd',
    title: 'Twenty agents',
    note: 'More rows than fit: whole-row scroll, waiting rows docked at the foot (SV-D19).',
    width: 1180,
    height: 520,
    crowd: true,
  },
];

const NO_CHANGES: ModelChanges = Object.freeze({ added: [], updated: [], removed: [] });
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** The tunables the address sets; the view clamps them as the panel's would be. */
function tunables(): Record<string, number> {
  const params = new URLSearchParams(location.search);
  const out: Record<string, number> = { ...monitorParameterDefaults(spendMonitorView.manifest.parameters) };
  for (const key of ['weight', 'wash']) {
    const value = params.get(key);
    if (value !== null && value !== '' && Number.isFinite(Number(value))) out[key] = Number(value);
  }
  return out;
}

/** A row whose cost reads the same as before keeps its object, as the replica keeps an unchanged row (MV-D21). */
function sameCost(a: AgentView, b: AgentView): boolean {
  const x = a.cost;
  const y = b.cost;
  if (x === y) return true;
  if (!x || !y || x.usd !== y.usd || x.coverage !== y.coverage) return false;
  const p = x.series;
  const q = y.series;
  if (p === q) return true;
  return (
    p !== undefined &&
    q !== undefined &&
    p.lastStepAt === q.lastStepAt &&
    p.stepMs === q.stepMs &&
    p.steps.length === q.steps.length &&
    p.steps.every((step, index) => step === q.steps[index])
  );
}

/** One afternoon as a replica: a new fold publishes the rows that moved, and keeps the rest. */
function afternoonReplica(): MonitorReplicaLike & { publish(rows: readonly AgentView[]): void } {
  let model: MonitorModel = { revision: 0, agents: [], byId: new Map() };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ model, changes: NO_CHANGES }),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    publish(rows) {
      let moved = rows.length !== model.agents.length;
      const agents = rows.map((row, index) => {
        const before = model.byId.get(row.id);
        const kept = before !== undefined && before.colour === row.colour && sameCost(before, row) ? before : row;
        if (kept !== model.agents[index]) moved = true;
        return kept;
      });
      if (!moved) return;
      model = { revision: model.revision + 1, agents, byId: new Map(agents.map((row) => [row.id, row])) };
      for (const listener of listeners) listener();
    },
  };
}

/** Press the plot where a person would, on empty chart at `t`, near its top: the view's own gesture (SV-D18). */
function pressChart(frame: HTMLElement, chrome: number, t: number, nowMs: number): void {
  // The view fills the frame inside its border, past the chrome it clears on the left.
  const g = geometryFor(frame.clientWidth - chrome, frame.clientHeight);
  const box = frame.getBoundingClientRect();
  const left = box.left + frame.clientLeft + chrome;
  const x = left + g.x0 + ((t - (nowMs - SPEND_WINDOW_MS)) / SPEND_WINDOW_MS) * (g.x1 - g.x0);
  const y = box.top + frame.clientTop + g.y0 + 2;
  const target = frame.ownerDocument.elementFromPoint(x, y);
  if (!target) return;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerId: 1 };
  target.dispatchEvent(new PointerEvent('pointerdown', init));
  target.dispatchEvent(new PointerEvent('pointerup', init));
}

function StageView({
  stage,
  originMs,
  nowMs,
  scheme,
  still,
}: {
  stage: Stage;
  originMs: number;
  nowMs: number;
  scheme: 'light' | 'dark';
  still: boolean;
}): ReactElement {
  const chrome = Number(new URLSearchParams(location.search).get('chrome') ?? 0) || 0;
  const parameters = useMemo(tunables, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const palette = useMonitorPalette(rootRef);
  const afternoon = useMemo(
    () => spendAfternoon(originMs, palette.tint, { crowd: stage.crowd === true, neutral: palette.neutral }),
    [originMs, palette.tint, palette.neutral, stage.crowd],
  );
  const replica = useMemo(() => afternoonReplica(), [afternoon]);
  // Folded again every second: the rows a host hands over then.
  useEffect(() => {
    replica.publish(spendRows(afternoon, nowMs));
  }, [replica, afternoon, nowMs]);
  const [selected, setSelected] = useState<string>();
  const commands = useMemo<ViewSlotCommands>(() => ({ select: setSelected, create: () => undefined }), []);
  const [reduced, setReduced] = useState(() => matchMedia(REDUCED_MOTION).matches);
  useEffect(() => {
    const query = matchMedia(REDUCED_MOTION);
    const read = (): void => setReduced(query.matches);
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);
  const theme = useMemo<MonitorTheme>(
    () => ({ scheme, tokens: palette, reducedMotion: reduced, animations: !still }),
    [palette, scheme, reduced, still],
  );
  // `?chrome=46`: the usage column's width, as Godview measures it when the column has tiles (MV-D19).
  const geometry = useMemo<StageGeometry>(
    () => ({
      width: stage.width,
      height: stage.height,
      insets: { top: 0, right: 0, bottom: 0, left: chrome },
      obstacles: chrome ? [{ x: 0, y: 0, width: chrome, height: stage.height }] : [],
    }),
    [chrome, stage.height, stage.width],
  );
  // The moment stage sets its moment as a person would, once the view has drawn the afternoon.
  const pressed = useRef(false);
  useEffect(() => {
    if (stage.momentAgo === undefined || pressed.current) return;
    const frame = rootRef.current;
    if (!frame) return;
    pressed.current = true;
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => pressChart(frame, chrome, originMs - stage.momentAgo!, Date.now())),
    );
    return () => cancelAnimationFrame(id);
  }, [chrome, originMs, stage]);
  return createElement(
    'figure',
    { className: 'spend-lab-stage', 'data-stage': stage.id },
    createElement(
      'div',
      { ref: rootRef, className: 'spend-lab-frame', style: { width: stage.width, height: stage.height } },
      createElement(MonitorViewHost, {
        replica,
        view: spendMonitorView,
        stage: geometry,
        theme,
        parameters,
        commands,
      }),
    ),
    createElement(
      'figcaption',
      null,
      createElement('b', null, stage.title),
      createElement(
        'span',
        { className: 'spend-lab-note' },
        selected ? `${stage.note} Selected: ${selected}.` : stage.note,
      ),
    ),
  );
}

/** The page's theme switch reaches the stages through this: the scheme is part of the view's input. */
let pushScheme: (scheme: 'light' | 'dark') => void = () => undefined;

function Lab({ initial }: { initial: 'light' | 'dark' }): ReactElement {
  const [originMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(originMs);
  const [scheme, setScheme] = useState(initial);
  pushScheme = setScheme;
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const params = new URLSearchParams(location.search);
  const only = params.get('only');
  const still = params.get('still') === '1';
  return createElement(
    'div',
    { className: 'spend-lab-stages' },
    STAGES.filter((stage) => !only || stage.id === only).map((stage) =>
      createElement(StageView, { key: stage.id, stage, originMs, nowMs, scheme, still }),
    ),
  );
}

function main(): void {
  const root = document.getElementById('spend-lab');
  const mount = root?.querySelector('.spend-lab-mount');
  if (!root || !mount) return;
  const params = new URLSearchParams(location.search);
  if (params.has('n') || params.get('capture') === '1') {
    const lab = mountViewLab({
      root,
      mount,
      view: spendMonitorView,
      parameters: monitorParameterDefaults(spendMonitorView.manifest.parameters),
    });
    root
      .querySelector<HTMLButtonElement>('.spend-lab-theme')
      ?.addEventListener('click', () => lab.setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark'));
    return;
  }
  const setTheme = (theme: 'light' | 'dark'): void => {
    root.classList.toggle('theme-light', theme === 'light');
    root.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
    pushScheme(theme);
  };
  const initial = params.get('theme') === 'dark' ? 'dark' : 'light';
  setTheme(initial);
  root
    .querySelector<HTMLButtonElement>('.spend-lab-theme')
    ?.addEventListener('click', () => setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark'));
  createRoot(mount).render(createElement(Lab, { initial }));
}

main();
