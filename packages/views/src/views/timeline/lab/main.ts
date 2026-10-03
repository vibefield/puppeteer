import { createElement, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { mountViewLab } from '../../../lab/lab-stage.js';
import { useMonitorPalette } from '../../../monitor/palette.js';
import { monitorParameterDefaults } from '../../../monitor/parameters.js';
import type { MonitorActions, MonitorAgent } from '../../../monitor/types.js';
import { timelineMonitorView } from '../index.js';
import { TimelineView } from '../TimelineView.js';
import { DEFAULT_TIMELINE_PARAMETERS } from '../timeline-parameters.js';
import { timelineWorld } from './timeline-fixtures.js';

// The timeline lab: the shipping view over the example afternoon, at the sizes
// Godview gives it, in either theme — plus the same rows with no book, which is
// what the view draws before a host keeps a ledger (TL-D9). What is drawn here
// is what Godview draws; a design change is reviewed here as pixels.
//
// `?theme=dark` opens dark; `?only=wide` (or narrow, bare) shows one stage; `?recede=<ids>` recedes rows; `?chrome=<px>` insets the view past a usage column.
//
// `?n=<rows>` (or `?capture=1`) swaps the afternoon for the seeded world in Godview's stage, as the
// other view labs show it (`lab/lab-stage.ts`): `?size=`, `?animations=0`, and `?book=0` for the
// rows with no book. That page is what the goldens capture.

interface Stage {
  id: string;
  title: string;
  note: string;
  width: number;
  height: number;
  book: boolean;
}

const STAGES: readonly Stage[] = [
  {
    id: 'wide',
    title: 'Godview, wide',
    note: '1320 × 300: the stage over a deck.',
    width: 1320,
    height: 300,
    book: true,
  },
  {
    id: 'narrow',
    title: 'Godview, narrow',
    note: '400 × 260: a window at its narrowest.',
    width: 400,
    height: 260,
    book: true,
  },
  {
    id: 'bare',
    title: 'Without the ledger',
    note: 'The same rows and no book: each lane born, unrecorded until its current state began (TL-D9).',
    width: 1320,
    height: 300,
    book: false,
  },
];

function StageView({ stage, nowMs }: { stage: Stage; nowMs: number }): ReactElement {
  const chrome = `${Number(new URLSearchParams(location.search).get('chrome') ?? 0) || 0}px`;
  const rootRef = useRef<HTMLDivElement>(null);
  const palette = useMonitorPalette(rootRef);
  const world = useMemo(() => {
    // `?recede=notes,dotfiles`: those rows as a host's profile tabs hand rows outside the chosen profile.
    const recede = new Set((new URLSearchParams(location.search).get('recede') ?? '').split(',').filter(Boolean));
    const base = timelineWorld(nowMs, palette.tint);
    const mark = (agent: MonitorAgent): MonitorAgent => (recede.has(agent.id) ? { ...agent, receded: true } : agent);
    return { agents: base.agents.map(mark), history: { ...base.history, ended: base.history.ended.map(mark) } };
  }, [nowMs, palette.tint]);
  const [selected, setSelected] = useState<string>();
  const actions = useMemo<MonitorActions>(
    () => ({ select: (agent: MonitorAgent) => setSelected(agent.project), createAt: () => undefined }),
    [],
  );
  return createElement(
    'figure',
    { className: 'timeline-lab-stage', 'data-stage': stage.id },
    createElement(
      'div',
      {
        ref: rootRef,
        className: 'timeline-lab-frame',
        // `?chrome=46`: the usage column's width, as Godview sets it when the column has tiles.
        style: { width: stage.width, height: stage.height, '--vf-monitor-chrome-right': chrome } as CSSProperties,
      },
      createElement(TimelineView, {
        agents: world.agents,
        ...(stage.book ? { history: world.history } : {}),
        parameters: { ...DEFAULT_TIMELINE_PARAMETERS },
        actions,
        palette,
      }),
    ),
    createElement(
      'figcaption',
      null,
      createElement('b', null, stage.title),
      createElement('span', null, selected ? `${stage.note} Selected: ${selected}.` : stage.note),
    ),
  );
}

function Lab(): ReactElement {
  const [nowMs] = useState(() => Date.now());
  const only = new URLSearchParams(location.search).get('only');
  return createElement(
    'div',
    { className: 'timeline-lab-stages' },
    STAGES.filter((stage) => !only || stage.id === only).map((stage) =>
      createElement(StageView, { key: stage.id, stage, nowMs }),
    ),
  );
}

function main(): void {
  const root = document.getElementById('timeline-lab');
  const mount = root?.querySelector('.timeline-lab-mount');
  if (!root || !mount) return;
  const params = new URLSearchParams(location.search);
  if (params.has('n') || params.get('capture') === '1') {
    const lab = mountViewLab({
      root,
      mount,
      Component: timelineMonitorView.Component,
      parameters: monitorParameterDefaults(timelineMonitorView.parameterGroups),
      book: true,
    });
    root
      .querySelector<HTMLButtonElement>('.timeline-lab-theme')
      ?.addEventListener('click', () => lab.setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark'));
    return;
  }
  const setTheme = (theme: 'light' | 'dark'): void => {
    root.classList.toggle('theme-light', theme === 'light');
    root.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
  };
  setTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
  const toggle = root.querySelector<HTMLButtonElement>('.timeline-lab-theme');
  toggle?.addEventListener('click', () => setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark'));
  createRoot(mount).render(createElement(Lab));
}

main();
