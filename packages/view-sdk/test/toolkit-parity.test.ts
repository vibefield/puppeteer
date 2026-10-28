// THE TOOLKIT SAYS WHAT THE VIEWS SAID (MV-D11: identical wording, identical numbers).
//
// The toolkit ported helpers the views carried. Where the views package still
// keeps its own copy (a project's colour, money, receding), this suite runs the
// original beside the port over the same inputs, so an edit to either copy fails
// here instead of quietly forking what two readers draw. It reads those
// originals by path, as a test only: the SDK itself imports nothing from
// puppeteer (L3).
//
// Where the original was a FROZEN legacy view or the legacy shim (the swarm's
// and the timeline's words, the status ledger's wait words, the line under the
// name), the copy went with MV-8 and the suite keeps the values the parity
// pinned, read from the toolkit while it still equalled them (`8bf0276`, green).
// An edit that moves one of these words is a visible change, named and shown.

import { describe, expect, it } from 'vitest';
import * as originalTint from '../../views/src/colour/project-tint.js';
import { formatUsd as originalFormatUsd } from '../../views/src/monitor/cost-format.js';
import { hexToRgb255 as originalHexToRgb255 } from '../../views/src/monitor/palette.js';
import * as originalRecede from '../../views/src/monitor/recede.js';
import type { AgentView } from '../src/model.js';
import { agentViewFixture, type AgentViewFixturePartial } from '../src/testing/fixtures.js';
import * as toolkit from '../src/toolkit/index.js';

const MONEY = [0, 0.0004, 0.001, 0.0042, 0.009, 0.01, 0.5, 1, 7.034, 12.5, 999.999, 1234.5, -1];
const SEQS = Array.from({ length: 64 }, (_, index) => index);
const TINTS = [originalTint.DEFAULT_PROJECT_TINT.light, originalTint.DEFAULT_PROJECT_TINT.dark, { l: 0.5, c: 0.3 }];

describe('formats match the views', () => {
  it('money', () => {
    for (const value of [...MONEY, undefined]) expect(toolkit.formatUsd(value)).toBe(originalFormatUsd(value));
  });

  it('a burn by the hour, as the swarm said it a minute times 60 (pinned from the frozen swarm)', () => {
    const said: readonly (readonly [number | undefined, string])[] = [
      [0, '$0.00/hr'],
      [1, '$60/hr'],
      [0.0004, '$0.02/hr'],
      [0.001, '$0.06/hr'],
      [0.0042, '$0.25/hr'],
      [0.009, '$0.54/hr'],
      [0.01, '$0.60/hr'],
      [0.5, '$30/hr'],
      [7.034, '$422/hr'],
      [12.5, '$750/hr'],
      [999.999, '$60000/hr'],
      [1234.5, '$74070/hr'],
      [-1, '$-60.00/hr'],
      [undefined, '—/hr'],
    ];
    for (const [perMinute, words] of said) {
      expect(toolkit.formatRatePerHour(perMinute === undefined ? undefined : perMinute * 60)).toBe(words);
    }
  });

  it('lengths of time, as the timeline said them (pinned from the frozen timeline); the clock from local midnight', () => {
    // [ms, [elapsed, short, words], [clock, clock with seconds]]
    const said: readonly (readonly [number, readonly string[], readonly string[]])[] = [
      [0, ['0:00', '0s', 'under a minute'], ['00:00', '00:00:00']],
      [999, ['0:00', '1s', 'under a minute'], ['00:00', '00:00:00']],
      [1000, ['0:01', '1s', 'under a minute'], ['00:00', '00:00:01']],
      [59000, ['0:59', '59s', '1 minute'], ['00:00', '00:00:59']],
      [60000, ['1:00', '1m', '1 minute'], ['00:01', '00:01:00']],
      [61000, ['1:01', '1m', '1 minute'], ['00:01', '00:01:01']],
      [659000, ['10:59', '10m', '11 minutes'], ['00:10', '00:10:59']],
      [3599000, ['59:59', '59m', '1 hour'], ['00:59', '00:59:59']],
      [3600000, ['1h 00m', '1h', '1 hour'], ['01:00', '01:00:00']],
      [8040000, ['2h 14m', '2h 14m', '2 hours 14 minutes'], ['02:14', '02:14:00']],
      [86399000, ['23h 59m', '23h 59m', '24 hours'], ['23:59', '23:59:59']],
      [90000000, ['1d 01h', '25h', '25 hours'], ['01:00', '01:00:00']],
    ];
    const midnight = new Date(2026, 0, 1).getTime();
    for (const [ms, [elapsed, short, words], [clock, seconds]] of said) {
      expect([ms, toolkit.formatElapsed(ms), toolkit.formatShort(ms), toolkit.formatWords(ms)]).toEqual([
        ms,
        elapsed,
        short,
        words,
      ]);
      expect([ms, toolkit.formatClock(midnight + ms), toolkit.formatClock(midnight + ms, true)]).toEqual([
        ms,
        clock,
        seconds,
      ]);
    }
  });

  it('token counts, as the swarm said them (pinned from the frozen swarm)', () => {
    const said: readonly (readonly [number, string])[] = [
      [0, '0'],
      [1, '1'],
      [999, '999'],
      [1000, '1.0k'],
      [8100, '8.1k'],
      [9999, '10.0k'],
      [10000, '10k'],
      [384400, '384k'],
      [999999, '1000k'],
      [1200000, '1.2M'],
      [9999999, '10.0M'],
      [24000000, '24M'],
      [999.6, '1000'],
    ];
    for (const [count, words] of said) expect([count, toolkit.formatTokens(count)]).toEqual([count, words]);
  });
});

describe('state words match the views', () => {
  it('a wait is said as the timeline said it (pinned from the frozen timeline)', () => {
    const said: readonly (readonly [string | undefined, string])[] = [
      ['permission', 'permission'],
      ['question', 'question'],
      ['failure', 'failed'],
      ['sandbox', 'sandbox'],
      ['', ''],
      [undefined, 'failed'],
    ];
    for (const [kind, words] of said) expect([kind, toolkit.waitWord(kind)]).toEqual([kind, words]);
  });

  it('a timeline lane says what a wait is about as its status ledger did: detail, then prompt (M2, M14; pinned)', () => {
    const long = `${'a'.repeat(158)} the tail`;
    const cut = `${'a'.repeat(158)} …`;
    const waits: readonly (readonly [AgentView['wait'], string | undefined])[] = [
      [{ kind: 'permission', since: SINCE, tool: 'Bash' }, undefined],
      [
        { kind: 'permission', since: SINCE, tool: 'Bash', detail: 'Bash · git push origin main' },
        'Bash · git push origin main',
      ],
      [{ kind: 'question', since: SINCE, header: 'Deploy', question: 'Ship it?', detail: 'the detail' }, 'the detail'],
      [{ kind: 'question', since: SINCE, header: 'Deploy', question: 'Ship it?' }, 'Ship it?'],
      [{ kind: 'question', since: SINCE, question: '  Keep the flag?  ' }, 'Keep the flag?'],
      [{ kind: 'question', since: SINCE, header: 'Deploy' }, undefined],
      [{ kind: 'question', since: SINCE, detail: '', question: 'Ship it?' }, undefined],
      [{ kind: 'question', since: SINCE, detail: '   ', question: 'Ship it?' }, undefined],
      [{ kind: 'failure', since: SINCE, code: 'E_RATE', detail: 'rate limited · retrying' }, 'rate limited · retrying'],
      [{ kind: 'failure', since: SINCE, detail: long }, cut],
      [{ kind: 'question', since: SINCE, question: long }, cut],
      [undefined, undefined],
    ];
    for (const [index, [wait, words]] of waits.entries()) {
      expect(`${index}: ${toolkit.laneWaitWords(wait)}`).toBe(`${index}: ${words}`);
    }
    expect(cut).toHaveLength(160);
    // A kind Core does not name was no blocker to the ledger, so its lane said nothing; the model's lane says it.
    expect(toolkit.laneWaitWords({ kind: 'sandbox', since: SINCE, detail: 'sandbox denied' })).toBe('sandbox denied');
  });

  it('receding steps by the same numbers', () => {
    expect(toolkit.RECEDED_OPACITY).toBe(originalRecede.RECEDED_OPACITY);
    expect(toolkit.RECEDED_EMPTY_OPACITY).toBe(originalRecede.RECEDED_EMPTY_OPACITY);
    expect(toolkit.RECEDE_MS).toBe(originalRecede.RECEDE_MS);
    for (const [current, target, delta] of [
      [1, 0.22, 16],
      [0.22, 1, 16],
      [0.5, 0.07, 1000],
      [0.3, 0.3, 16],
      [0.9, 1, -5],
    ] as const) {
      expect(toolkit.approachRecede(current, target, delta)).toBe(
        originalRecede.approachRecede(current, target, delta),
      );
    }
    for (const receded of [true, false]) {
      for (const every of [true, false]) {
        expect(toolkit.recedeTarget(receded, every)).toBe(originalRecede.recedeTarget(receded, every));
      }
    }
  });
});

const LAPTOP = { id: 'desk-2', name: 'Laptop', os: 'linux', self: false } as const;
const SINCE = Date.UTC(2026, 0, 1, 12);

/** Every branch of the line under the name, named: each one is a case below. */
const LINE_CASES: readonly (readonly [string, AgentViewFixturePartial])[] = [
  [
    'headline and cost, working',
    { status: 'working', detail: 'Reading src/app.ts', cost: { usd: 1.2, coverage: 'complete', burnPerHour: 6 } },
  ],
  ['partial cost, idle', { status: 'idle', detail: 'Idle', cost: { usd: 0.004, coverage: 'partial' } }],
  ['unpriced', { status: 'working', detail: 'Thinking', cost: { usd: 0, coverage: 'unavailable' } }],
  ['reply, working', { status: 'working', reply: { text: 'On it.', final: false } }],
  ['reply, idle, trimmed', { status: 'idle', reply: { text: '  Done. The suite passes.  ', final: true } }],
  ['blank reply', { status: 'idle', reply: { text: '   ' } }],
  ['wait: permission with its tool', { status: 'blocked', wait: { kind: 'permission', since: SINCE, tool: 'Bash' } }],
  ['wait: permission alone', { status: 'blocked', wait: { kind: 'permission', since: SINCE } }],
  [
    'wait: question, more behind it',
    { status: 'blocked', wait: { kind: 'question', since: SINCE, count: 3, header: 'Branch?', question: 'Merge it?' } },
  ],
  ['wait: failure', { status: 'blocked', wait: { kind: 'failure', since: SINCE, code: 'E_RATE', detail: 'retrying' } }],
  ['wait: a new kind', { status: 'blocked', wait: { kind: 'sandbox', since: SINCE } }],
  ['blocked with no wait', { status: 'blocked' }],
  ['starting', { observed: false, detail: 'starting' }],
  ['pending', { observed: false, pending: true, detail: 'unobserved · resumes when idle' }],
  ['peer: reply', { device: LAPTOP, status: 'working', reply: { text: 'On it.' } }],
  ['peer: status', { device: LAPTOP, status: 'idle', cost: { usd: 2, coverage: 'complete' } }],
  [
    'peer: question asked',
    { device: LAPTOP, status: 'blocked', wait: { kind: 'question', since: SINCE, question: ' Ship it? ' } },
  ],
  [
    'peer: question, no prompt',
    { device: LAPTOP, status: 'blocked', wait: { kind: 'question', since: SINCE, header: 'Deploy' } },
  ],
  ['peer: permission', { device: LAPTOP, status: 'blocked', wait: { kind: 'permission', since: SINCE, tool: 'Edit' } }],
  ['peer: blocked with no wait', { device: LAPTOP, status: 'blocked' }],
  ['peer: pending', { device: LAPTOP, observed: false, pending: true }],
  ['peer: starting', { device: LAPTOP, observed: false }],
  ['terminal', { kind: 'terminal', detail: '/Users/me/notes', status: 'working', project: { name: 'notes' } }],
  ['terminal, peer', { kind: 'terminal', detail: 'Unassigned terminal', device: LAPTOP, project: { name: '' } }],
  ['no folder', { project: { name: '' }, provider: { id: 'codex', label: 'Codex' }, model: 'GPT-5' }],
  ['no folder, no provider', { project: { name: '' } }],
  ['no model', { provider: { id: 'claude', label: 'Claude' } }],
];
const lineViews: readonly AgentView[] = LINE_CASES.map(([, partial], index) =>
  agentViewFixture({ id: `case-${index}`, ...partial }),
);

/** What the legacy shim said for each case (reply-first, VibeField's line, M4), pinned when it went (MV-8): the line,
 * the name and what runs it (`null` for a terminal, which has no agent facet). */
const SAID: readonly (readonly [string, string, string, string | null])[] = [
  ['headline and cost, working', 'working', 'project', ''],
  ['partial cost, idle', 'idle', 'project', ''],
  ['unpriced', 'working', 'project', ''],
  ['reply, working', 'On it.', 'project', ''],
  ['reply, idle, trimmed', 'Done. The suite passes.', 'project', ''],
  ['blank reply', 'idle', 'project', ''],
  ['wait: permission with its tool', 'permission · Bash', 'project', ''],
  ['wait: permission alone', 'permission', 'project', ''],
  ['wait: question, more behind it', 'question', 'project', ''],
  ['wait: failure', 'failure', 'project', ''],
  ['wait: a new kind', 'sandbox', 'project', ''],
  ['blocked with no wait', 'blocked', 'project', ''],
  ['starting', 'starting', 'project', ''],
  ['pending', 'unobserved · resumes when idle', 'project', ''],
  ['peer: reply', 'Laptop · On it.', 'project', ''],
  ['peer: status', 'Laptop · idle', 'project', ''],
  ['peer: question asked', 'Laptop · Ship it?', 'project', ''],
  ['peer: question, no prompt', 'Laptop · question', 'project', ''],
  ['peer: permission', 'Laptop · permission · Edit', 'project', ''],
  ['peer: blocked with no wait', 'Laptop · blocked', 'project', ''],
  ['peer: pending', 'Laptop · unobserved · resumes when idle', 'project', ''],
  ['peer: starting', 'Laptop · idle', 'project', ''],
  ['terminal', '/Users/me/notes', 'notes', null],
  ['terminal, peer', 'Unassigned terminal', 'terminal', null],
  ['no folder', 'idle', 'Codex', 'GPT-5'],
  ['no folder, no provider', 'idle', '', ''],
  ['no model', 'idle', 'project', 'Claude'],
];

describe('row words say what the shim said', () => {
  it('covers every branch of the line: starting, pending, reply, wait, headline, cost, peers, terminals', () => {
    const names = LINE_CASES.map(([name]) => name).join(' | ');
    for (const branch of ['starting', 'pending', 'reply', 'wait', 'headline', 'cost', 'peer', 'terminal']) {
      expect(names).toContain(branch);
    }
    expect(SAID.map(([name]) => name)).toEqual(LINE_CASES.map(([name]) => name));
  });

  it('detailLine is the shim’s reply-first line, for every case (M4)', () => {
    for (const [index, view] of lineViews.entries()) {
      const [name, line] = SAID[index]!;
      expect(`${name}: ${toolkit.detailLine(view)}`).toBe(`${name}: ${line}`);
    }
  });

  it('names a row and what runs it as the shim did', () => {
    for (const [index, view] of lineViews.entries()) {
      const [name, , project, model] = SAID[index]!;
      expect([name, toolkit.projectName(view)]).toEqual([name, project]);
      if (model !== null) expect([name, toolkit.modelWord(view)]).toEqual([name, model]);
      else expect(view.kind).toBe('terminal');
    }
  });
});

describe('colour matches the views', () => {
  it('deals every project and pane the same hue and hex', () => {
    for (const seq of SEQS) {
      expect(toolkit.projectHue(seq)).toBe(originalTint.projectHue(seq));
      expect(toolkit.paneHue(seq)).toBe(originalTint.paneHue(seq));
      for (const tint of TINTS) {
        expect(toolkit.projectColour(seq, tint)).toBe(originalTint.projectTint(seq, tint));
        expect(toolkit.paneColour(seq, tint)).toBe(originalTint.paneTint(seq, tint));
      }
    }
    expect(toolkit.DEFAULT_PROJECT_TINT).toEqual(originalTint.DEFAULT_PROJECT_TINT);
  });

  it('splits a hex into canvas channels the same way', () => {
    for (const hex of ['#ff8800', '#f80', ' #0a0B0c ', 'f80', '#12', 'rgb(1,2,3)', '']) {
      expect(toolkit.hexToRgb255(hex)).toBe(originalHexToRgb255(hex));
    }
  });
});
