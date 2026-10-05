import { createElement, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentView, ModelChanges, MonitorModel, MonitorTheme, StageGeometry } from '@vibecook/puppeteer-view-sdk';
import { MonitorViewHost, type MonitorReplicaLike, type ViewSlotCommands } from '@vibecook/puppeteer-view-sdk/host';
import { mountViewLab } from '../../../lab/lab-stage.js';
import { useMonitorPalette } from '../../../monitor/palette.js';
import { monitorParameterDefaults } from '../../../monitor/parameters.js';
import { timelineMonitorView } from '../index.js';
import { timelineWorld } from './timeline-fixtures.js';

// The timeline lab: the shipping view over the example afternoon, mounted
// through the view host as Godview mounts it, at the sizes Godview gives it, in
// either theme. Runtime only (MV-6): each lane is its birth and its current
// state. What is drawn here is what Godview draws; a design change is reviewed
// here as pixels.
//
// `?theme=dark` opens dark; `?only=wide` (or narrow) shows one stage; `?recede=<ids>` recedes rows; `?chrome=<px>`
// insets the view past a usage column.
//
// `?n=<rows>` (or `?capture=1`) swaps the afternoon for the seeded world in Godview's stage, as the other view labs
// show it (`lab/lab-stage.ts`): `?size=`, `?animations=0`. That page is what the goldens capture.

interface Stage {
  id: string;
  title: string;
  note: string;
  width: number;
  height: number;
}

const STAGES: readonly Stage[] = [
  { id: 'wide', title: 'Godview, wide', note: '1320 × 300: the stage over a deck.', width: 1320, height: 300 },
  { id: 'narrow', title: 'Godview, narrow', note: '400 × 260: a window at its narrowest.', width: 400, height: 260 },
];

const NO_CHANGES: ModelChanges = Object.freeze({ added: [], updated: [], removed: [] });

/** One world as a replica: the model it is, never changing; a new world is a new replica. */
function fixedReplica(model: MonitorModel): MonitorReplicaLike {
  return { getSnapshot: () => ({ model, changes: NO_CHANGES }), subscribe: () => () => undefined };
}

function StageView({ stage, nowMs, scheme }: { stage: Stage; nowMs: number; scheme: 'light' | 'dark' }): ReactElement {
  const params = new URLSearchParams(location.search);
  const chrome = Number(params.get('chrome') ?? 0) || 0;
  const recede = params.get('recede') ?? '';
  const rootRef = useRef<HTMLDivElement>(null);
  const palette = useMonitorPalette(rootRef);
  const replica = useMemo(() => {
    // `?recede=notes,dotfiles`: those rows as a host's profile tabs hand rows outside the chosen profile.
    const receded = new Set(recede.split(',').filter(Boolean));
    const agents: AgentView[] = timelineWorld(nowMs, palette.tint, palette.neutral).map((row) =>
      receded.has(row.id) ? { ...row, receded: true } : row,
    );
    return fixedReplica({ revision: 1, agents, byId: new Map(agents.map((row) => [row.id, row])) });
  }, [nowMs, palette.tint, palette.neutral, recede]);
  const [selected, setSelected] = useState<string>();
  const commands = useMemo<ViewSlotCommands>(() => ({ select: setSelected, create: () => undefined }), []);
  const theme = useMemo<MonitorTheme>(
    () => ({ scheme, tokens: palette, reducedMotion: false, animations: true }),
    [palette, scheme],
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
  const parameters = useMemo(() => monitorParameterDefaults(timelineMonitorView.manifest.parameters), []);
  return createElement(
    'figure',
    { className: 'timeline-lab-stage', 'data-stage': stage.id },
    createElement(
      'div',
      { ref: rootRef, className: 'timeline-lab-frame', style: { width: stage.width, height: stage.height } },
      createElement(MonitorViewHost, {
        replica,
        view: timelineMonitorView,
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
      createElement('span', null, selected ? `${stage.note} Selected: ${selected}.` : stage.note),
    ),
  );
}

/** The page's theme switch reaches the stages through this: the scheme is part of the view's input. */
let pushScheme: (scheme: 'light' | 'dark') => void = () => undefined;

function Lab({ initial }: { initial: 'light' | 'dark' }): ReactElement {
  const [nowMs] = useState(() => Date.now());
  const [scheme, setScheme] = useState(initial);
  pushScheme = setScheme;
  const only = new URLSearchParams(location.search).get('only');
  return createElement(
    'div',
    { className: 'timeline-lab-stages' },
    STAGES.filter((stage) => !only || stage.id === only).map((stage) =>
      createElement(StageView, { key: stage.id, stage, nowMs, scheme }),
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
      view: timelineMonitorView,
      parameters: monitorParameterDefaults(timelineMonitorView.manifest.parameters),
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
    pushScheme(theme);
  };
  const initial = params.get('theme') === 'dark' ? 'dark' : 'light';
  setTheme(initial);
  root
    .querySelector<HTMLButtonElement>('.timeline-lab-theme')
    ?.addEventListener('click', () => setTheme(root.classList.contains('theme-dark') ? 'light' : 'dark'));
  createRoot(mount).render(createElement(Lab, { initial }));
}

main();
