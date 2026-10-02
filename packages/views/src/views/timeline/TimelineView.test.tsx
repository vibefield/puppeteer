import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults } from '../../monitor/parameters.js';
import { readMonitorPalette } from '../../monitor/palette.js';
import { DEFAULT_MONITOR_VIEW_ID, MONITOR_VIEWS } from '../../monitor/registry.js';
import type { MonitorHistoryBook } from '../../monitor/status-history.js';
import type { MonitorAgent } from '../../monitor/types.js';
import { timelineWorld } from './lab/timeline-fixtures.js';
import { TIMELINE_PARAMETER_GROUPS } from './timeline-parameters.js';
import { TimelineView } from './TimelineView.js';

// The view reads the clock itself; the world is drawn at it.
const NOW = Date.now();
const NO_ACTIONS = { select: () => undefined, createAt: () => undefined };

function markup(agents: MonitorAgent[], history?: MonitorHistoryBook): string {
  return renderToStaticMarkup(
    <TimelineView
      agents={agents}
      {...(history ? { history } : {})}
      parameters={monitorParameterDefaults(TIMELINE_PARAMETER_GROUPS)}
      actions={NO_ACTIONS}
      palette={readMonitorPalette()}
    />,
  );
}

const names = (html: string): string[] =>
  [...html.matchAll(/class="vf-monitor-timeline-who">(?:<svg.*?<\/svg>)+<b>([^<]+)<\/b>/g)].map((match) => match[1]!);

describe('the timeline view', () => {
  it('is registered after the rain, and the swarm stays the default', () => {
    expect(MONITOR_VIEWS.map((view) => view.id)).toEqual(['swarm', 'list', 'rain', 'timeline']);
    expect(DEFAULT_MONITOR_VIEW_ID).toBe('swarm');
    expect(MONITOR_VIEWS.find((view) => view.id === 'timeline')?.label).toBe('TIMELINE');
  });

  it('draws the example afternoon: agents in birth order with the ended one in its slot, terminals below', () => {
    const world = timelineWorld(NOW);
    const html = markup(world.agents, world.history);
    expect(names(html)).toEqual([
      'dotfiles',
      'vibe-field',
      'rosetta',
      'rosetta',
      'rosetta',
      'changelog',
      'notes',
      'refactor-auth',
      'billing-api',
      'swarm-lab',
      'vibe-field',
      '~',
    ]);
    expect(html).toContain('TERMINALS');
    expect(html).toMatch(/class="vf-monitor-timeline-name is-ended"/);
  });

  it('offers the map as a slider and every live lane as a button; an ended lane is said, not offered', () => {
    const world = timelineWorld(NOW);
    const html = markup(world.agents, world.history);
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="The head’s moment in the day"');
    const buttons = [...html.matchAll(/<li><button[^>]*>([^<]+)<\/button><\/li>/g)].map((match) => match[1]!);
    expect(buttons).toHaveLength(11);
    expect(buttons).toContain(
      'billing-api, gpt-5, blocked on a permission for 4 minutes: Bash · git push origin billing/ledger-reader',
    );
    expect(html).toMatch(/<li><span>changelog, haiku, ended 52 minutes ago<\/span><\/li>/);
  });

  it('works without a book (TL-D9): the ended lane goes, the live ones stay', () => {
    const world = timelineWorld(NOW);
    const html = markup(world.agents);
    expect(names(html)).not.toContain('changelog');
    expect(names(html)).toHaveLength(11);
  });

  it('draws a receded row quiet in its slot, still a button to open', () => {
    const world = timelineWorld(NOW);
    const agents = world.agents.map((agent) => (agent.id === 'notes' ? { ...agent, receded: true } : agent));
    const html = markup(agents, world.history);
    expect(names(html)[6]).toBe('notes');
    expect(html).toMatch(/class="vf-monitor-timeline-name is-receded"[^>]*>(?:<[^>]+>)*?<svg/);
    expect(html.match(/vf-monitor-timeline-head[^"]* is-receded/g)).toHaveLength(1);
    expect(html).toMatch(/<li><button type="button">on tower, notes, haiku, idle for 47 minutes<\/button><\/li>/);
  });

  it('says so when there is nothing to draw', () => {
    expect(markup([])).toContain('NO ACTIVE AGENTS');
  });
});
