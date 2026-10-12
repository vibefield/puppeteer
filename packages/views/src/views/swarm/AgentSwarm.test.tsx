// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentView, MonitorSpawnMenu } from '@vibefield/puppeteer-view-sdk';
import {
  agentViewFixture,
  countingCommands,
  fixtureInput,
  fixtureSpawnMenu,
  fixtureTheme,
  parameterDefaults,
  runConformance,
} from '@vibefield/puppeteer-view-sdk/testing';
import { AgentSwarm } from './AgentSwarm.js';
import { BLOOM_SCENARIOS } from './bloom/scenarios.js';
import { SWARM_MANIFEST, swarmMonitorView } from './index.js';

// The swarm's MARKUP, statically: what a harness, a screen reader or a host's
// smoke can reach before (and without) WebGPU. The drawing is the shader's and
// needs a device; one button per body naming its status, its drawn state and
// its SOURCE are DOM facts a consumer's rows select by (Godview's launcher smoke
// finds the body a launched agent inherits by `data-agent-bubble-id`). What a
// host used to read off the section (`data-swarm-renderer`) it is told instead
// (`commands.report`, W5), so the markup carries no renderer word.
//
// And the conformance suite (MV-W4), with and without a spawn tree.

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const parameters = parameterDefaults(SWARM_MANIFEST);
const PEER = { id: 'mini', name: 'studio-mini', self: false } as const;

const terminal = (id: string, project: string): AgentView =>
  agentViewFixture({
    id,
    kind: 'terminal',
    createdAt: NOW,
    project: { name: project, seq: undefined },
    detail: `/Users/james/Projects/${project}`,
  });

const working = (id: string, project: string, model: string): AgentView =>
  agentViewFixture({
    id,
    createdAt: NOW,
    status: 'working',
    project: { name: project, seq: 1 },
    provider: { id: 'claude', label: 'Claude' },
    model,
  });

function markup(agents: readonly AgentView[], spawn?: MonitorSpawnMenu): string {
  return renderToStaticMarkup(
    <AgentSwarm
      input={fixtureInput({
        agents,
        parameters,
        theme: fixtureTheme('light'),
        ...(spawn ? { capabilities: { spawn } } : {}),
      })}
      commands={countingCommands().commands}
    />,
  );
}

describe('the swarm as markup', () => {
  it('says the field is empty, and carries no renderer word for a host to read (it reports instead)', () => {
    const html = markup([]);
    expect(html).toContain('NO ACTIVE AGENTS');
    expect(html).not.toContain('data-swarm-renderer');
    // the field is focusable, so a hold's ⎋ is heard on the view (MV-D8)
    expect(html).toContain('class="vf-monitor-swarm"');
    expect(html).toContain('tabindex="-1"');
  });

  it('wears the scheme and the motion switch as classes of its own, never a host’s', () => {
    const dark = renderToStaticMarkup(
      <AgentSwarm
        input={fixtureInput({ theme: fixtureTheme('dark', { animations: false }) })}
        commands={countingCommands().commands}
      />,
    );
    expect(dark).toContain('class="vf-monitor-swarm is-dark is-still"');
  });

  it('gives every body a button naming its status, its drawn state and its source', () => {
    const html = markup([
      terminal('t1', 'vibe-field'),
      working('a1', 'vibe-field', 'Sonnet 5'),
      agentViewFixture({
        id: 'r1',
        kind: 'terminal',
        createdAt: 0,
        project: { name: 'mesh-console' },
        detail: 'studio-mini · /Projects/mesh-console',
        device: PEER,
        writable: false,
      }),
    ]);
    expect(html).toContain('data-agent-bubble-source="terminal"');
    expect(html).toContain('data-agent-bubble-source="agent"');
    expect(html).toContain('data-agent-bubble-source="remote"');
    expect(html).toContain('data-agent-bubble-status="working"');
    expect(html).toContain('data-agent-bubble-visual="terminal-empty"');
    expect(html).toContain('data-agent-bubble-visual="working"');
    // the peer named FIRST, the host's write policy last (M41)
    expect(html).toContain('aria-label="on studio-mini, mesh-console, remote session, idle, read-only host"');
    expect(html.match(/<button /g)).toHaveLength(3);
  });

  it('keeps a receded body on the stage and says so on its button', () => {
    const html = markup([
      working('a1', 'vibe-field', 'Sonnet 5'),
      agentViewFixture({ id: 'a2', createdAt: NOW, project: { name: 'rosetta', seq: 2 }, receded: true }),
    ]);
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html.match(/data-agent-bubble-receded="true"/g)).toHaveLength(1);
  });

  it('keeps the shell’s spatial identity when the row carries one, and draws one body per identity', () => {
    const agent = Object.assign(working('run', 'vibe-field', 'Sonnet 5'), { visualId: 'old-shell' });
    expect(markup([agent])).toContain('data-agent-bubble-id="old-shell"');
    // the fresh shell still in its pane wears the same body: the earlier row (the agent) speaks for it
    const shell = Object.assign(terminal('old-shell', 'vibe-field'), {});
    const html = markup([agent, shell]);
    expect(html.match(/<button /g)).toHaveLength(1);
    expect(html).toContain('data-agent-bubble-source="agent"');
  });
});

describe('the swarm with a spawn menu (SB)', () => {
  const rows = [terminal('t1', 'vibe-field')];

  it('without one, the markup is today’s: no keys door, no bloom layer, no signifier', () => {
    const html = markup(rows);
    expect(html).not.toContain('data-swarm-new-terminal');
    expect(html).not.toContain('vf-bloom');
    expect(markup([])).not.toContain('Hold empty ground');
    expect(html.match(/<button /g)).toHaveLength(1);
  });

  it('with one, the hidden list opens with the keys door, and the bloom’s live region waits', () => {
    const html = markup(rows, BLOOM_SCENARIOS.two);
    expect(html).toMatch(
      /<ul class="vf-monitor-swarm-list" aria-label="Agents"><li><button type="button" aria-haspopup="menu" aria-expanded="false" data-swarm-new-terminal="">＋ New terminal…<\/button>/,
    );
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html).toContain('data-bloom-state="idle"');
    expect(html).toContain('<div class="vf-bloom-say-root" aria-live="polite"></div>');
    // nothing is open until a hold completes
    expect(html).not.toContain('role="menu"');
    expect(html).toContain('class="vf-monitor-swarm"');
  });

  it('the empty notice says what a hold does', () => {
    const html = markup([], BLOOM_SCENARIOS['one-three']);
    expect(html).toContain(
      '<small>Launch an agent from a terminal pane.</small><small>Hold empty ground for a terminal.</small>',
    );
  });

  it('a menu with nothing to choose still gets the keys door (it creates at once)', () => {
    expect(markup(rows, BLOOM_SCENARIOS['one-one'])).toContain('data-swarm-new-terminal');
  });
});

describe('the manifest', () => {
  it('declares the bloom’s keys (MV-D8), the spawn capability and a loop at rest', () => {
    expect(SWARM_MANIFEST.id).toBe('swarm');
    expect(SWARM_MANIFEST.keys?.map((key) => key.key)).toEqual(['Escape', 'Enter', 'ArrowRight', 'ArrowLeft']);
    expect(SWARM_MANIFEST.capabilities).toEqual({ optional: ['spawn'] });
    expect(SWARM_MANIFEST.motion).toEqual({ loops: true });
    expect(SWARM_MANIFEST.parametersRevision).toBe('2026-09-09');
    expect(swarmMonitorView.manifest).toBe(SWARM_MANIFEST);
  });
});

describe('without a spawn tree', () => {
  runConformance(swarmMonitorView);
});

describe('with a spawn tree', () => {
  runConformance(swarmMonitorView, { capabilities: { spawn: fixtureSpawnMenu() } });
});
