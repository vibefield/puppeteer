import { describe, expect, it } from 'vitest';
import { SPEND_MANIFEST, spendMonitorView } from '../views/spend/index.js';
import { DEFAULT_MONITOR_VIEW_ID, MONITOR_VIEWS, monitorViewFor } from './registry.js';

describe('the registered views', () => {
  it('runs swarm, list, rain, timeline, then spend, in the held branch’s place (MV-7), and the swarm stays the default', () => {
    expect(MONITOR_VIEWS.map((view) => view.id)).toEqual(['swarm', 'list', 'rain', 'timeline', 'spend']);
    expect(DEFAULT_MONITOR_VIEW_ID).toBe('swarm');
    expect(monitorViewFor('nonesuch').id).toBe('swarm');
  });

  it('reads the spend view’s face from its manifest: label, mark, keys and its parameters’ revision', () => {
    const entry = monitorViewFor('spend');
    expect(entry.view).toBe(spendMonitorView);
    expect(entry.label).toBe('SPEND');
    expect(entry.mark).toBe(SPEND_MANIFEST.mark);
    expect(entry.keys).toBe(SPEND_MANIFEST.keys);
    expect(entry.parameterGroups).toBe(SPEND_MANIFEST.parameters);
    expect(entry.parametersRevision).toBe('2026-10-03');
  });
});
