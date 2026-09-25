import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults } from '../../monitor/parameters.js';
import { readMonitorPalette } from '../../monitor/palette.js';
import type { MonitorAgent } from '../../monitor/types.js';
import { agentFixture } from '../swarm/lab/fixtures.js';
import { AgentList } from './AgentList.js';
import { LIST_PARAMETER_GROUPS } from './list-parameters.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const NO_ACTIONS = { select: () => undefined, createAt: () => undefined };

function markup(agents: MonitorAgent[]): string {
  return renderToStaticMarkup(
    <AgentList
      agents={agents}
      parameters={monitorParameterDefaults(LIST_PARAMETER_GROUPS)}
      actions={NO_ACTIONS}
      palette={readMonitorPalette()}
    />,
  );
}

function projects(html: string): string[] {
  return [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map((match) => match[1]!);
}

describe('the list, receding', () => {
  const blocked = agentFixture({ id: 'a1', project: 'billing-api', status: 'blocked', accent: 1 }, NOW);
  const working = agentFixture({ id: 'a2', project: 'vibe-field', status: 'working', accent: 2 }, NOW);
  const idle = agentFixture({ id: 'a3', project: 'rosetta', status: 'idle', accent: 3 }, NOW);

  it('orders what the host shows first, keeps the rest below at the recede weight, and counts both', () => {
    const html = markup([{ ...blocked, receded: true }, working, idle]);
    expect(projects(html)).toEqual(['vibe-field', 'rosetta', 'billing-api']);
    expect(html.match(/is-receded/g)).toHaveLength(1);
    expect(html).toContain('2 OF 3 SESSIONS');
    expect(html).not.toContain('is-all-receded');
  });

  it('says every session when nothing recedes, and marks a stage where everything does', () => {
    expect(markup([blocked, working])).toContain('>2 SESSIONS<');
    const all = markup([
      { ...blocked, receded: true },
      { ...working, receded: true },
    ]);
    expect(all).toContain('vf-monitor-list is-all-receded');
    expect(all).toContain('0 OF 2 SESSIONS');
  });
});
