import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import type { MonitorAgent } from '../monitor/types.js';
import { FindSheet, type FindHistoryBridge } from './FindSheet.js';

const NEVER: FindHistoryBridge = {
  status: () => new Promise(() => undefined),
  facts: () => new Promise(() => undefined),
  search: () => new Promise(() => undefined),
};

function agent(id: string, project: string, native: string): MonitorAgent {
  return {
    id,
    session: { id, createdAtMs: 1_000 },
    createdAtMs: 1_000,
    status: 'working',
    project,
    detail: 'editing',
    color: '#abcdef',
    active: false,
    agent: {
      provider: { id: 'provider-x', label: 'Provider X' },
      model: 'model-1',
      branch: 'main',
      monitor: {
        status: 'working',
        statusSince: '2026-09-09T11:59:00.000Z',
        session: { nativeSessionId: native },
        freshness: { level: 'native-hooks', families: {} },
      } as unknown as AgentMonitorState,
      recency: 'live',
      nativeSessionId: native,
    } as unknown as MonitorAgent['agent'],
  };
}

describe('FindSheet', () => {
  it('renders nothing while it is closed', () => {
    expect(
      renderToStaticMarkup(
        <FindSheet open={false} agents={[]} onClose={() => undefined} onSelect={() => undefined} history={NEVER} />,
      ),
    ).toBe('');
  });

  it('opens on the live agents with the field, the list, and an honest foot', () => {
    const markup = renderToStaticMarkup(
      <FindSheet
        open
        agents={[agent('a', 'vibe-field', 'n-a'), agent('b', 'puppeteer', 'n-b')]}
        onClose={() => undefined}
        onSelect={() => undefined}
        history={NEVER}
        nowMs={Date.parse('2026-09-09T12:00:00.000Z')}
      />,
    );
    expect(markup).toContain('aria-label="Find an agent by what was said"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('2 live sessions');
    expect(markup).toContain('vibe-field');
    expect(markup).toContain('puppeteer');
    expect(markup).toContain('model-1');
    expect(markup).toContain('HISTORY OFF');
    expect(markup).toContain('role="option"');
  });

  it('says so when no live agent can be listed', () => {
    const markup = renderToStaticMarkup(
      <FindSheet open agents={[]} onClose={() => undefined} onSelect={() => undefined} history={NEVER} />,
    );
    expect(markup).toContain('NO LIVE AGENTS');
    expect(markup).toContain('0 live sessions');
  });
});
