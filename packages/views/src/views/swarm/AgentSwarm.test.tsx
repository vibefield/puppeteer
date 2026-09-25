import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults } from '../../monitor/parameters.js';
import { readMonitorPalette } from '../../monitor/palette.js';
import type { MonitorAgent } from '../../monitor/types.js';
import { AgentSwarm } from './AgentSwarm.js';
import { agentFixture, terminalFixture } from './lab/fixtures.js';
import { SWARM_PARAMETER_GROUPS } from './swarm-parameters.js';

// The swarm's MARKUP, statically: what a harness, a screen reader or a host's
// smoke can reach before (and without) WebGPU. The drawing is the shader's and
// needs a device; the section's renderer word, and one button per body naming
// its status, its drawn state and its SOURCE, are DOM facts a consumer's rows
// select by (VibeField's Godview smoke clicks the local body by source).

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const NO_ACTIONS = { select: () => undefined, createAt: () => undefined };

function remoteRow(): MonitorAgent {
  return {
    id: 'r1',
    createdAtMs: 0,
    status: 'idle',
    project: 'mesh-console',
    detail: 'studio-mini · /Projects/mesh-console',
    color: '#6366f1',
    active: false,
    remote: {
      deviceId: 'mini',
      deviceName: 'studio-mini',
      remoteSessionId: 's1',
      attachable: true,
      hostWritable: false,
      cwdLabel: '/Projects/mesh-console',
    },
  };
}

function markup(agents: MonitorAgent[]): string {
  return renderToStaticMarkup(
    <AgentSwarm
      agents={agents}
      parameters={monitorParameterDefaults(SWARM_PARAMETER_GROUPS)}
      actions={NO_ACTIONS}
      palette={readMonitorPalette()}
    />,
  );
}

describe('the swarm as markup', () => {
  it('names its renderer on the section before a device has answered', () => {
    expect(markup([])).toContain('data-swarm-renderer="starting"');
    expect(markup([])).toContain('NO ACTIVE AGENTS');
  });

  it('gives every body a button naming its status, its drawn state and its source', () => {
    const html = markup([
      terminalFixture('t1', 'vibe-field', false, NOW),
      agentFixture({ id: 'a1', project: 'vibe-field', status: 'working', model: 'Sonnet 5', accent: 1 }, NOW),
      remoteRow(),
    ]);
    expect(html).toContain('data-agent-bubble-source="terminal"');
    expect(html).toContain('data-agent-bubble-source="agent"');
    expect(html).toContain('data-agent-bubble-source="remote"');
    expect(html).toContain('data-agent-bubble-status="working"');
    expect(html).toContain('data-agent-bubble-visual="terminal-empty"');
    expect(html).toContain('data-agent-bubble-visual="working"');
    // the peer named FIRST, the host's write policy last
    expect(html).toContain('aria-label="on studio-mini, mesh-console, remote session, idle, read-only host"');
    expect(html.match(/<button /g)).toHaveLength(3);
  });

  it('keeps a receded body on the stage and says so on its button', () => {
    const html = markup([
      agentFixture({ id: 'a1', project: 'vibe-field', status: 'working', accent: 1 }, NOW),
      { ...agentFixture({ id: 'a2', project: 'rosetta', status: 'idle', accent: 2 }, NOW), receded: true },
    ]);
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html.match(/data-agent-bubble-receded="true"/g)).toHaveLength(1);
  });
});
