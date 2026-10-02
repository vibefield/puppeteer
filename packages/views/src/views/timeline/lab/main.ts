import { createElement, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useMonitorPalette } from '../../../monitor/palette.js';
import type { MonitorActions, MonitorAgent } from '../../../monitor/types.js';
import { TimelineView } from '../TimelineView.js';
import { DEFAULT_TIMELINE_PARAMETERS } from '../timeline-parameters.js';
import { timelineWorld } from './timeline-fixtures.js';

// The timeline lab: the shipping view over the example afternoon, at the sizes
// Godview gives it, in either theme — plus the same rows with no book, which is
// what the view draws before a host keeps a ledger (TL-D9). What is drawn here
// is what Godview draws; a design change is reviewed here as pixels.
//
// `?theme=dark` opens dark; `?only=wide` (or narrow, bare) shows one stage.

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
  const rootRef = useRef<HTMLDivElement>(null);
  const palette = useMonitorPalette(rootRef);
  const world = useMemo(() => timelineWorld(nowMs, palette.tint), [nowMs, palette.tint]);
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
      { ref: rootRef, className: 'timeline-lab-frame', style: { width: stage.width, height: stage.height } },
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
