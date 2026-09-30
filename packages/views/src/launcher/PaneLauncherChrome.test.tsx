import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaneLauncherChrome, launcherOptionId, type PaneLauncherChromeProps } from './PaneLauncherChrome.js';
import { buildLauncherResults, cantLaunchLine, orderAgents, type LauncherScope } from './launcher-model.js';
import type { LauncherAgent, LauncherHistoryStatus, LauncherSession, LauncherWordHit } from './launcher-port.js';

// The launcher's MARKUP, statically, for every state of pass 3 §19: what a
// host's catalog shows and what a screen reader reaches. The portal and the
// keys need a pane and a window and are the host's smoke to witness.

const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime();
const HOUR = 3_600_000;

const AGENTS: LauncherAgent[] = orderAgents([
  { providerId: 'claude', label: 'Claude Code', lastLaunchedAt: NOW - HOUR, preview: 'Claude Code · work' },
  { providerId: 'codex', label: 'Codex', lastLaunchedAt: NOW - 2 * HOUR },
  { providerId: 'grok', label: 'Grok' },
  { providerId: 'pi', label: 'Pi' },
  { providerId: 'opencode', label: 'OpenCode' },
  { providerId: 'kimi', label: 'Kimi Code' },
  { providerId: 'hermes', label: 'Hermes' },
  { providerId: 'antigravity', label: 'Antigravity' },
  { providerId: 'copilot', label: 'GitHub Copilot' },
  { providerId: 'acp', label: 'ACP' },
]);

const HERE = '/Users/j/Projects/puppeteer';
const SESSIONS: LauncherSession[] = [
  {
    key: 's1',
    providerId: 'claude',
    nativeSessionId: 'n1',
    title: 'fold the bar and usage proposals into the record',
    cwd: HERE,
    here: true,
    branch: 'main',
    lastAt: NOW - 2 * HOUR,
    resumable: true,
  },
  {
    key: 's2',
    providerId: 'codex',
    nativeSessionId: 'n2',
    title: 'port the rain view parameters',
    cwd: HERE,
    here: true,
    branch: 'rain-port',
    lastAt: NOW - 26 * HOUR,
    resumable: true,
  },
  {
    key: 's3',
    providerId: 'codex',
    nativeSessionId: 'n3',
    title: 'port the fold recipe to tokens.css',
    cwd: '/Users/j/Projects/vibe-field',
    here: false,
    branch: 'mt-2',
    lastAt: NOW - 26 * HOUR,
    resumable: true,
  },
  {
    key: 's4',
    providerId: 'claude',
    nativeSessionId: 'n4',
    title: 'fold the minimal frame into §07',
    cwd: '/Users/j/Projects/vibe-field-old',
    here: false,
    lastAt: new Date(2026, 8, 10, 12).getTime(),
    resumable: false,
    unresumable: 'folder is gone',
  },
];
const HITS: LauncherWordHit[] = [
  { nativeSessionId: 'n2', kind: 'user', snippet: 'then [fold] the gauge into the frame' },
];

const READY: LauncherHistoryStatus = { readiness: 'ready' };

function props(overrides: Partial<PaneLauncherChromeProps> = {}): PaneLauncherChromeProps {
  return {
    sessionId: 'term-1',
    agents: AGENTS,
    folder: 'puppeteer',
    color: '#5f8f6a',
    active: true,
    open: false,
    query: '',
    scope: 'here',
    highlight: -1,
    ...overrides,
  };
}

function results(query: string, scope: LauncherScope, sessions = SESSIONS, hits = HITS) {
  return buildLauncherResults({ sessions, hits, query, scope, folder: 'puppeteer', agents: AGENTS, nowMs: NOW });
}

function render(overrides: Partial<PaneLauncherChromeProps> = {}): string {
  return renderToStaticMarkup(<PaneLauncherChrome {...props(overrides)} />);
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

describe('PaneLauncherChrome · at rest', () => {
  it('draws the field and the ten agents with their keys, last used first', () => {
    const markup = render();
    expect(markup).toContain('data-vf-pane-launcher="term-1"');
    expect(markup).toContain('--pane-color:#5f8f6a');
    expect(markup).toContain('class="vf-pane-launcher"');
    expect(markup).toContain('aria-label="Search past sessions"');
    expect(markup).toContain('aria-keyshortcuts="Alt+Enter"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('Resume a session…');
    expect(markup).toContain('Resume…');
    expect(markup).toContain('⌥↵');
    expect(markup).toContain('<span>New</span><span>last used first</span>');
    expect(count(markup, 'class="vf-pane-launcher-agent"')).toBe(10);
    expect(markup.indexOf('Claude Code')).toBeLessThan(markup.indexOf('Codex'));
    expect(markup).toContain('aria-keyshortcuts="Alt+1"');
    expect(markup).toContain('aria-keyshortcuts="Alt+0"');
    expect(markup).toContain('<kbd>⌥1</kbd>');
    expect(markup).toContain('<kbd>⌥0</kbd>');
    expect(markup).toContain('or just type · this is a shell');
    // the letter mark for a provider without a drawn one
    expect(markup).toMatch(/<span aria-hidden="true">A<\/span>/);
    // no preview, no list, no foot
    expect(markup).not.toContain('vf-pane-launcher-preview');
    expect(markup).not.toContain('role="listbox"');
    expect(markup).not.toContain('back to the shell');
  });

  it('marks the agent under the pointer and previews it in the readout slot', () => {
    const markup = render({ hoverIndex: 0 });
    expect(markup).toContain('class="vf-pane-launcher-agent is-hover"');
    expect(markup).toContain('<span class="vf-pane-launcher-preview">Claude Code · work</span>');
    expect(render({ hoverIndex: 1 })).toContain('<span class="vf-pane-launcher-preview">Codex</span>');
  });

  it('shows an agent that cannot launch with its reason where the key was, disabled to assistive tech', () => {
    const agents = AGENTS.map((agent, index) =>
      index === 0
        ? { ...agent, unavailable: 'hooks off' }
        : index === 7
          ? { ...agent, unavailable: 'not installed' }
          : agent,
    );
    const markup = render({ agents, hoverIndex: 0 });
    expect(count(markup, 'aria-disabled="true"')).toBe(2);
    expect(markup).toContain('class="vf-pane-launcher-agent is-off"');
    expect(markup).not.toContain('is-hover');
    expect(markup).toContain('<small>hooks off</small>');
    expect(markup).toContain('<small>not installed</small>');
    expect(markup).toContain('title="Claude Code · hooks off"');
    expect(markup).not.toContain('<kbd>⌥1</kbd>');
  });

  it('presses a launching agent in the pane colour, then leaves', () => {
    const pressed = render({ busy: { kind: 'launch', index: 1 } });
    expect(pressed).toContain('class="vf-pane-launcher is-busy"');
    expect(pressed).toContain('class="vf-pane-launcher-agent is-press"');
    expect(pressed).toContain('aria-busy="true"');
    expect(pressed).toContain('<span class="vf-pane-launcher-preview">Codex</span>');
    expect(render({ busy: { kind: 'launch', index: 1, leaving: true } })).toContain(
      'class="vf-pane-launcher is-leaving is-busy"',
    );
  });

  it('shrinks toward the mark a launch took, and keeps that row empty until the mark is back (QL-2)', () => {
    const leaving = render({ busy: { kind: 'launch', index: 1, leaving: true }, departOrigin: '41.5px 68.0px' });
    expect(leaving).toContain('class="vf-pane-launcher is-leaving is-busy" role="group"');
    expect(leaving).toContain('style="transform-origin:41.5px 68.0px"');
    expect(leaving).toContain('class="vf-pane-launcher-agent is-press is-flying"');
    const returning = render({ busy: { kind: 'launch', index: 1, returning: true }, departOrigin: '41.5px 68.0px' });
    expect(returning).toContain('class="vf-pane-launcher is-busy"');
    expect(returning).toContain('class="vf-pane-launcher-agent is-press is-flying"');
    expect(returning).toContain('style="transform-origin:41.5px 68.0px"');
    // At rest the origin is nobody's business.
    expect(render({ departOrigin: '41.5px 68.0px' })).not.toContain('transform-origin');
  });

  it('names every row a launch can take its mark from', () => {
    expect(render()).toContain('data-vf-launch-source="agent:0"');
    expect(render()).toContain('data-vf-launch-source="agent:9"');
    const open = render({ open: true, results: results('', 'here'), history: READY, highlight: 0 });
    expect(open).toContain('data-vf-launch-source="session:0"');
  });

  it('says why a launch was refused, under the rows', () => {
    const markup = render({ failure: 'Codex didn’t launch: no sign-in for this profile' });
    expect(markup).toContain(
      '<p class="vf-pane-launcher-failure" role="alert">Codex didn’t launch: no sign-in for this profile</p>',
    );
  });

  it('keeps only the field, quietly, on a resting pane', () => {
    const markup = render({ active: false, hoverIndex: 0 });
    expect(markup).toContain('class="vf-pane-launcher is-resting"');
    expect(markup).toContain('Resume a session…');
    expect(markup).not.toContain('vf-pane-launcher-agent');
    expect(markup).not.toContain('last used first');
    expect(markup).not.toContain('or just type');
    expect(markup).not.toContain('vf-pane-launcher-preview');
  });

  it('marks a short pane, and carries both placeholders for the narrow tiers', () => {
    const markup = render({ short: true });
    expect(markup).toContain('class="vf-pane-launcher is-short"');
    expect(markup).toContain('<span class="vf-pane-launcher-long">Resume a session…</span>');
    expect(markup).toContain('<span class="vf-pane-launcher-short">Resume…</span>');
  });
});

describe('PaneLauncherChrome · the field open', () => {
  it('lists this folder’s latest with nothing typed, the first highlighted', () => {
    const markup = render({ open: true, results: results('', 'here'), history: READY, highlight: 0 });
    expect(markup).toContain('class="vf-pane-launcher is-open"');
    expect(markup).toContain('class="vf-pane-launcher-field is-focus"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain(`aria-activedescendant="${launcherOptionId('term-1', 0)}"`);
    expect(markup).not.toContain('tabindex="-1"');
    expect(markup).toContain('Search past sessions</span>');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('Latest in puppeteer');
    expect(count(markup, 'role="option"')).toBe(2);
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-selected="false"');
    expect(markup).toContain('class="vf-pane-launcher-row is-cur"');
    expect(markup).toContain('Claude Code · main · 2 hours ago');
    expect(markup).toContain('Codex · rain-port · yesterday');
    // here · all, here chosen; the foot
    expect(markup).toMatch(/<button type="button" class="is-on" aria-pressed="true">here<\/button>/);
    expect(markup).toMatch(/<button type="button" aria-pressed="false">all<\/button>/);
    expect(markup).toContain('<b>↑↓</b> move');
    expect(markup).toContain('<b>↵</b> resume here');
    expect(markup).toContain('<b>⇥</b> here · all');
    expect(markup).toContain('<b>⎋</b> back to the shell');
    // the agents give way to the list
    expect(markup).not.toContain('vf-pane-launcher-agent');
    expect(markup).not.toContain('⌥↵');
  });

  it('searches here: the matched word marked, and a words hit as the third line', () => {
    const markup = render({
      open: true,
      query: 'fold',
      results: results('fold', 'here'),
      history: READY,
      highlight: 0,
    });
    expect(markup).toContain('value="fold"');
    expect(markup).not.toContain('vf-pane-launcher-ph');
    expect(markup).toContain('In puppeteer');
    expect(markup).not.toContain('Elsewhere');
    expect(markup).toContain('<b><mark>fold</mark><span> the bar and usage proposals into the record</span></b>');
    expect(markup).toContain(
      '<small class="vf-pane-launcher-ev">you: “<span>then </span><mark>fold</mark><span> the gauge into the frame</span>”</small>',
    );
  });

  it('searches all: elsewhere after here, folder first, and a gone folder withheld', () => {
    const markup = render({
      open: true,
      query: 'fold',
      scope: 'all',
      results: results('fold', 'all'),
      history: READY,
      highlight: 0,
    });
    expect(markup).toMatch(/<button type="button" class="is-on" aria-pressed="true">all<\/button>/);
    expect(markup.indexOf('In puppeteer')).toBeLessThan(markup.indexOf('Elsewhere'));
    expect(markup).toContain('vibe-field · Codex · mt-2 · yesterday');
    expect(markup).toContain('vibe-field-old · Claude Code · folder is gone · 18 days ago');
    expect(markup).toContain('class="vf-pane-launcher-row is-gone"');
    expect(count(markup, 'aria-disabled="true"')).toBe(1);
    expect(count(markup, '<kbd aria-hidden="true">↵</kbd>')).toBe(3);
    expect(count(markup, '<kbd aria-hidden="true"></kbd>')).toBe(1);
    expect(markup).toContain('role="group" aria-labelledby="vf-pane-launcher-term-1-list-elsewhere"');
  });

  it('says nothing matched here, and that ⇥ searches everywhere', () => {
    const markup = render({
      open: true,
      query: 'xyzzy',
      results: results('xyzzy', 'here', SESSIONS, []),
      history: READY,
      highlight: -1,
    });
    expect(markup).toContain(
      '<p class="vf-pane-launcher-empty">No session in puppeteer mentions “xyzzy”.<span>⇥ searches every folder · ⎋ back to the shell</span></p>',
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-activedescendant');
    expect(markup).not.toContain('role="listbox"');
    expect(markup).not.toContain('vf-pane-launcher-foot');
  });

  it('says a folder has no sessions yet', () => {
    const markup = render({ open: true, results: results('', 'here', []), history: READY });
    expect(markup).toContain('No past sessions in puppeteer yet.');
  });

  it('shows the rows found so far while history catches up, over a track', () => {
    const history: LauncherHistoryStatus = { readiness: 'catching-up', progress: { done: 1204, total: 3880 } };
    const markup = render({ open: true, query: 'fold', results: results('fold', 'here'), history, highlight: 0 });
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('--p:31%');
    expect(markup).toContain(
      '<span>History is catching up · 1,204 of 3,880 sessions read</span><i aria-hidden="true"></i>',
    );
  });

  it('says history is not answering, and that the digits still launch', () => {
    const markup = render({
      open: true,
      query: 'fold',
      results: results('fold', 'here'),
      history: { readiness: 'unreachable' },
      highlight: 0,
    });
    expect(markup).toContain(
      '<p class="vf-pane-launcher-empty">Past sessions can’t be searched: the history service isn’t answering.<span>⌥1–⌥0 still launch new agents · ⎋ back to the shell</span></p>',
    );
    expect(markup).not.toContain('role="listbox"');
    expect(markup).not.toContain('vf-pane-launcher-foot');
  });

  it('says it is reading while nothing has answered', () => {
    const markup = render({ open: true });
    expect(markup).toContain('<p class="vf-pane-launcher-empty" role="status">Reading past sessions…</p>');
  });

  it('presses the row being resumed', () => {
    const markup = render({
      open: true,
      results: results('', 'here'),
      history: READY,
      highlight: 0,
      busy: { kind: 'resume', index: 0 },
    });
    expect(markup).toContain('class="vf-pane-launcher-row is-cur is-press"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('vf-pane-launcher-preview');
  });

  it('keeps option ids unique per pane and well formed', () => {
    expect(launcherOptionId('term 1/a', 2)).toBe('vf-pane-launcher-term_1_a-option-2');
  });
});

describe('PaneLauncherChrome · a pane born under a profile (SB)', () => {
  const WORK = { label: 'Work', glyph: 'briefcase', kind: 'managed' as const, isDefault: true };

  it('captions the agents New · then the profile’s glyph and Under its name, and keeps last used first', () => {
    const markup = render({ under: WORK });
    expect(markup).toContain('<span class="vf-pane-launcher-cap-under">New · <svg');
    expect(markup).toContain('data-profile-glyph="briefcase"');
    // The desktop's default is drawn filled, as everywhere a profile is named.
    expect(markup).toMatch(/<svg[^>]*width="11"[^>]*fill="currentColor"[^>]*data-profile-glyph="briefcase"/);
    expect(markup).toContain('<b>Under Work</b></span><span>last used first</span>');
    expect(markup).toContain('aria-label="Launch an agent in this pane, under Work"');
    expect(markup).toContain('or just type · this shell is under Work');
    expect(markup).not.toContain('<span>New</span>');
  });

  it('outlines a profile that is not the default, and draws the machine’s own as the laptop', () => {
    const personal = render({ under: { label: 'Personal', glyph: 'house', kind: 'managed' } });
    expect(personal).toMatch(/<svg[^>]*fill="none"[^>]*data-profile-glyph="house"/);
    expect(personal).toContain('<b>Under Personal</b>');
    const native = render({ under: { label: 'This Mac', glyph: 'rocket', kind: 'native' } });
    expect(native).toContain('data-profile-glyph="laptop"');
  });

  it('shows the pane’s own agents, an agent without a sign-in off with its reason and its failure line', () => {
    const agents: LauncherAgent[] = orderAgents([
      { providerId: 'claude', label: 'Claude Code', lastLaunchedAt: NOW - HOUR },
      { providerId: 'codex', label: 'Codex', unavailable: 'no sign-in' },
    ]);
    const markup = render({ under: { ...WORK, agents }, agents });
    expect(count(markup, 'class="vf-pane-launcher-agent"')).toBe(1);
    expect(count(markup, 'class="vf-pane-launcher-agent is-off"')).toBe(1);
    expect(markup).toContain('<small>no sign-in</small>');
    expect(markup).toContain('title="Codex · no sign-in"');
    expect(count(markup, 'aria-disabled="true"')).toBe(1);
    expect(markup).toContain('<kbd>⌥1</kbd>');
    expect(markup).not.toContain('<kbd>⌥2</kbd>');
    const refused = render({ under: { ...WORK, agents }, agents, failure: cantLaunchLine(agents[1]!) });
    expect(refused).toContain('<p class="vf-pane-launcher-failure" role="alert">Codex can’t launch: no sign-in</p>');
  });

  it('says nothing of a profile in a pane born under none', () => {
    const markup = render();
    expect(markup).toContain('<span>New</span><span>last used first</span>');
    expect(markup).not.toContain('data-profile-glyph');
    expect(markup).toContain('aria-label="Launch an agent in this pane"');
  });
});
