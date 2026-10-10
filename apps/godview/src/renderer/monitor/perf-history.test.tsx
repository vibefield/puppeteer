// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorModel, MonitorView } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, fixtureModel } from '@vibecook/puppeteer-view-sdk/testing';
import { MONITOR_VIEWS } from '@vibecook/puppeteer-views';
import { perfHistory, usePerfHistory } from './perf-history.js';

const NOW = Date.UTC(2026, 9, 9, 15, 0, 0);
const MIN = 60_000;
const PALETTE = { tint: { l: 0.7, c: 0.12 }, neutral: 'gray' };
const view = (id: string): MonitorView => MONITOR_VIEWS.find((entry) => entry.id === id)!.view;
const rows = [
  agentViewFixture({ id: 'b', createdAt: NOW - 20 * MIN, statusSince: NOW - 2 * MIN }),
  agentViewFixture({ id: 'a', createdAt: NOW - 30 * MIN, statusSince: NOW - 5 * MIN }),
  agentViewFixture({ id: 't', kind: 'terminal', createdAt: NOW - 40 * MIN, statusSince: NOW - 40 * MIN }),
];

function Probe({ model, of }: { model: MonitorModel; of: MonitorView }) {
  const capabilities = usePerfHistory(model, of, PALETTE);
  const history = capabilities?.history;
  return <i data-lent={history ? `${history.live.length}/${history.ended.length}` : 'none'} />;
}

describe('the perf harness’s history (TLV)', () => {
  afterEach(() => {
    delete window.__gvPerfHistory;
  });

  it('lends nothing unless the harness asks, and then only to a view that declares history', () => {
    const model = fixtureModel(rows);
    expect(renderToStaticMarkup(<Probe model={model} of={view('timeline')} />)).toContain('data-lent="none"');
    window.__gvPerfHistory = { ended: 40 };
    expect(renderToStaticMarkup(<Probe model={model} of={view('timeline')} />)).toContain('data-lent="2/40"');
    expect(renderToStaticMarkup(<Probe model={model} of={view('list')} />)).toContain('data-lent="none"');
  });

  it('gives each agent row a day of turns up to its status, and every ended run an end within the hour', () => {
    const history = perfHistory(rows, NOW, 40, PALETTE);
    // By birth order, not by id: every launch lends the same shape.
    expect(history.live.map((past) => past.id)).toEqual(['a', 'b']);
    for (const past of history.live) {
      expect(past.spans[0]!.from).toBe(NOW - 24 * 60 * MIN);
      expect(past.spans.at(-1)!.to).toBe(past.seamAt);
      expect(past.spans.some((span) => span.kind === 'worked')).toBe(true);
    }
    expect(history.ended).toHaveLength(40);
    for (const run of history.ended) {
      expect(run.endedAt).toBeGreaterThan(NOW - 60 * MIN);
      expect(run.id.startsWith('past:')).toBe(true);
      expect(run.colour).not.toBe('');
      expect(run.receded).toBe(false);
    }
    expect([...history.ended].sort((x, y) => x.startedAt - y.startedAt)).toEqual(history.ended);
    expect(perfHistory(rows, NOW, 40, PALETTE)).toEqual(history);
  });
});
