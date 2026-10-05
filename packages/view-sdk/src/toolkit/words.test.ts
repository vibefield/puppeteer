import { describe, expect, it } from 'vitest';
import type { MonitorAgentRow, MonitorDeviceRef, MonitorSpawnDevice } from '../model.js';
import { agentViewFixture } from '../testing/fixtures.js';
import {
  deviceWord,
  detailLine,
  hostWriteTitle,
  hostWriteWord,
  modelWord,
  projectName,
  THIS_DESKTOP,
  waitBodyLine,
} from './words.js';

const PEER: MonitorDeviceRef = { id: 'desk-2', name: 'Laptop', os: 'linux', self: false };
const rowDevice = (device: MonitorDeviceRef): MonitorDeviceRef => device;
const menuDevice = (device: MonitorSpawnDevice): MonitorSpawnDevice => device;

describe('a desktop’s word', () => {
  it('calls the desktop the model is read on "This desktop", keyed on self, never on an id (M34)', () => {
    expect(deviceWord(rowDevice({ id: 'here', name: 'Studio', self: true }))).toBe(THIS_DESKTOP);
    expect(deviceWord(menuDevice({ id: 'mbp-7', label: 'James’s MacBook', self: true, state: 'ready' }))).toBe(
      'This desktop',
    );
    // An id that reads like the old one says nothing: only `self` does.
    expect(deviceWord(menuDevice({ id: 'here', label: 'here', self: false, state: 'ready' }))).toBe('here');
  });

  it('names any other desktop by its own name, from a row’s device or a menu’s desktop', () => {
    expect(deviceWord(PEER)).toBe('Laptop');
    expect(deviceWord(menuDevice({ id: 'mini', label: 'mini', state: 'ready' }))).toBe('mini');
    expect(deviceWord({ name: 'tower', self: false })).toBe('tower');
  });
});

describe('a row’s names', () => {
  it('goes by its folder; an agent in none by its provider; a terminal in none, "terminal"', () => {
    expect(projectName(agentViewFixture({ project: { name: 'billing-api' } }))).toBe('billing-api');
    expect(projectName(agentViewFixture({ project: { name: '' }, provider: { id: 'codex', label: 'Codex' } }))).toBe(
      'Codex',
    );
    expect(projectName(agentViewFixture({ project: { name: '' } }))).toBe('');
    expect(projectName(agentViewFixture({ kind: 'terminal', project: { name: '' } }))).toBe('terminal');
    expect(projectName(agentViewFixture({ kind: 'terminal', project: { name: 'notes' } }))).toBe('notes');
  });

  it('is run by its model, else its provider’s label', () => {
    expect(modelWord({ model: 'Opus 5.5', provider: { id: 'claude', label: 'Claude' } })).toBe('Opus 5.5');
    expect(modelWord({ provider: { id: 'claude', label: 'Claude' } })).toBe('Claude');
    expect(modelWord({ model: '', provider: { id: 'claude', label: 'Claude' } })).toBe('Claude');
    expect(modelWord({})).toBe('');
  });
});

describe('a host’s write policy', () => {
  it('is said about the host, in both directions, from the row’s own fact (M41)', () => {
    expect(hostWriteWord({ writable: true })).toBe('writable host');
    expect(hostWriteWord({ writable: false })).toBe('read-only host');
    expect(hostWriteTitle({ writable: true })).toBe(
      'this host allows writes — whether yours arrive is decided when you attach',
    );
    expect(hostWriteTitle({ writable: false })).toBe('this host shares read-only — no viewer may type here');
  });
});

describe('the line under the name (M4: reply-first, one rule)', () => {
  const row = (partial: Parameters<typeof agentViewFixture>[0] = {}): MonitorAgentRow =>
    agentViewFixture({ detail: 'Reading src/app.ts', ...partial });
  const since = 1_000;

  it('an agent at work or at rest says its reply, else its status — never the headline or the cost', () => {
    expect(detailLine(row({ status: 'working' }))).toBe('working');
    expect(detailLine(row({ status: 'idle', cost: { usd: 3, coverage: 'complete', burnPerHour: 6 } }))).toBe('idle');
    expect(detailLine(row({ status: 'idle', reply: { text: '  Done. The suite passes.  ' } }))).toBe(
      'Done. The suite passes.',
    );
    expect(detailLine(row({ status: 'working', reply: { text: '   ' } }))).toBe('working');
  });

  it('a blocked agent says what it waits on: the kind, and a permission’s tool', () => {
    expect(detailLine(row({ status: 'blocked', wait: { kind: 'permission', since, tool: 'Bash' } }))).toBe(
      'permission · Bash',
    );
    expect(
      detailLine(
        row({ status: 'blocked', wait: { kind: 'question', since, question: 'Ship it?' }, reply: { text: 'x' } }),
      ),
    ).toBe('question');
    expect(detailLine(row({ status: 'blocked' }))).toBe('blocked');
  });

  it('one not heard from says so: pending first, then starting', () => {
    expect(detailLine(row({ observed: false, pending: true }))).toBe('unobserved · resumes when idle');
    expect(detailLine(row({ observed: false }))).toBe('starting');
  });

  it('a row from another desktop leads with its name and prefers the question it asks', () => {
    const peer = (partial: Parameters<typeof agentViewFixture>[0]) => row({ device: PEER, ...partial });
    expect(detailLine(peer({ status: 'working', reply: { text: 'On it.' } }))).toBe('Laptop · On it.');
    expect(detailLine(peer({ status: 'idle' }))).toBe('Laptop · idle');
    expect(detailLine(peer({ status: 'blocked', wait: { kind: 'question', since, question: ' Ship it? ' } }))).toBe(
      'Laptop · Ship it?',
    );
    expect(detailLine(peer({ status: 'blocked', wait: { kind: 'permission', since, tool: 'Edit' } }))).toBe(
      'Laptop · permission · Edit',
    );
    expect(detailLine(peer({ status: 'blocked' }))).toBe('Laptop · blocked');
    expect(detailLine(peer({ observed: false, pending: true }))).toBe('Laptop · unobserved · resumes when idle');
    // A peer's run not heard from yet has no line of its own: it says its status, as VibeField's peers did.
    expect(detailLine(peer({ observed: false, status: 'idle' }))).toBe('Laptop · idle');
  });

  it('a terminal says the backend’s own line', () => {
    expect(detailLine(row({ kind: 'terminal', detail: '/Users/me/notes', status: 'working' }))).toBe('/Users/me/notes');
  });
});

describe('waitBodyLine: what a blocked body says in the name’s place, in the swarm’s order (M14)', () => {
  const since = 1;
  it('a question as it was asked: its header, else its prompt, blank ones passed over', () => {
    expect(waitBodyLine({ kind: 'question', since, header: 'Which branch?', question: 'Merge or keep?' })).toBe(
      'Which branch?',
    );
    expect(waitBodyLine({ kind: 'question', since, header: '  ', question: ' Merge or keep? ' })).toBe('Merge or keep?');
    expect(waitBodyLine({ kind: 'question', since, question: '', detail: 'the adapter’s line' })).toBe(
      'the adapter’s line',
    );
  });

  it('the detail an adapter gave, before a permission’s tool or a failure’s code', () => {
    expect(waitBodyLine({ kind: 'permission', since, detail: ' pnpm test --run ', tool: 'Bash' })).toBe(
      'pnpm test --run',
    );
    expect(waitBodyLine({ kind: 'permission', since, detail: '   ', tool: 'Bash' })).toBe('Bash');
    expect(waitBodyLine({ kind: 'failure', since, code: 'E_RATE_LIMIT' })).toBe('E_RATE_LIMIT');
    // a tool or a code on the wrong kind is no evidence
    expect(waitBodyLine({ kind: 'failure', since, tool: 'Bash' })).toBe('failed');
    expect(waitBodyLine({ kind: 'permission', since, code: 'E' })).toBe('permission');
  });

  it('then the latest reply, then the bare word for the wait, a kind the toolkit does not know said as itself', () => {
    expect(waitBodyLine({ kind: 'permission', since }, 'Done with the refactor.')).toBe('Done with the refactor.');
    expect(waitBodyLine({ kind: 'permission', since })).toBe('permission');
    expect(waitBodyLine({ kind: 'question', since })).toBe('question');
    expect(waitBodyLine({ kind: 'failure', since })).toBe('failed');
    expect(waitBodyLine({ kind: 'sandbox', since })).toBe('sandbox');
  });
});
