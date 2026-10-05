// THE TOOLKIT SAYS WHAT THE VIEWS SAY (MV-D11: identical wording, identical numbers).
//
// The toolkit ports helpers the views package still carries: the views keep
// their own copies until they are moved onto the SDK (wave 3). Until then this
// suite runs each original beside its port over the same inputs, so an edit to
// either copy — a reworded wait, a recoloured project — fails here instead of
// quietly forking what two views draw. It reads the originals by path, as a
// test only: the SDK itself imports nothing from puppeteer (L3). Delete each
// part with the views' copy it guards: the marks went with MV-4, when the views'
// AgentIcon and ProfileGlyph moved into `/react` (M6) and left one copy.

import { describe, expect, it } from 'vitest';
import * as originalTint from '../../views/src/colour/project-tint.js';
import { toMonitorAgent, type LegacyShimOptions } from '../../views/src/legacy/from-agent-view.js';
import { formatUsd as originalFormatUsd } from '../../views/src/monitor/cost-format.js';
import { hexToRgb255 as originalHexToRgb255 } from '../../views/src/monitor/palette.js';
import * as originalRecede from '../../views/src/monitor/recede.js';
import * as originalRemoteWrite from '../../views/src/monitor/remote-write.js';
import {
  formatRatePerHour as originalRatePerMinute,
  formatTokens as originalFormatTokens,
} from '../../views/src/views/swarm/bubble-model.js';
// The timeline moved onto the SDK in MV-6: its words as it shipped are the frozen copy's, and its wait words were
// its status ledger's (frozen beside it).
import { EMPTY_STATUS_LEDGER, observeStatuses } from '../../views/src/legacy/frozen/timeline/status-ledger.js';
import * as originalTimelineWords from '../../views/src/legacy/frozen/timeline/timeline-words.js';
import type { AgentView } from '../src/model.js';
import { agentViewFixture, type AgentViewFixturePartial } from '../src/testing/fixtures.js';
import * as toolkit from '../src/toolkit/index.js';

const MONEY = [0, 0.0004, 0.001, 0.0042, 0.009, 0.01, 0.5, 1, 7.034, 12.5, 999.999, 1234.5, -1];
const LENGTHS = [
  0, 999, 1000, 59_000, 60_000, 61_000, 659_000, 3_599_000, 3_600_000, 8_040_000, 86_399_000, 90_000_000,
];
const COUNTS = [0, 1, 999, 999.6, 1000, 8100, 9999, 10_000, 384_400, 999_999, 1_200_000, 9_999_999, 24_000_000];
const SEQS = Array.from({ length: 64 }, (_, index) => index);
const TINTS = [originalTint.DEFAULT_PROJECT_TINT.light, originalTint.DEFAULT_PROJECT_TINT.dark, { l: 0.5, c: 0.3 }];

describe('formats match the views', () => {
  it('money', () => {
    for (const value of [...MONEY, undefined]) expect(toolkit.formatUsd(value)).toBe(originalFormatUsd(value));
  });

  it('a burn by the hour: the swarm took USD a minute, the toolkit takes USD an hour', () => {
    for (const perMinute of [...MONEY, undefined]) {
      const perHour = perMinute === undefined ? undefined : perMinute * 60;
      expect(toolkit.formatRatePerHour(perHour)).toBe(originalRatePerMinute(perMinute));
    }
  });

  it('lengths of time', () => {
    for (const ms of LENGTHS) {
      expect(toolkit.formatElapsed(ms)).toBe(originalTimelineWords.formatElapsed(ms));
      expect(toolkit.formatShort(ms)).toBe(originalTimelineWords.formatShort(ms));
      expect(toolkit.formatWords(ms)).toBe(originalTimelineWords.formatWords(ms));
      expect(toolkit.formatClock(ms)).toBe(originalTimelineWords.formatClock(ms));
      expect(toolkit.formatClock(ms, true)).toBe(originalTimelineWords.formatClock(ms, true));
    }
  });

  it('token counts', () => {
    for (const count of COUNTS) expect(toolkit.formatTokens(count)).toBe(originalFormatTokens(count));
  });
});

describe('state words match the views', () => {
  it('a wait is said as the timeline says it', () => {
    for (const kind of ['permission', 'question', 'failure', 'sandbox', '', undefined]) {
      expect(toolkit.waitWord(kind)).toBe(originalTimelineWords.blockerWord(kind));
    }
  });

  it('a timeline lane says what a wait is about as its status ledger did: detail, then prompt (M2, M14)', () => {
    // What the ledger kept of a blocked row, through the shim exactly as Godview's host fed it; the ported timeline
    // says `laneWaitWords(row.wait)` where the frozen one said the book's blocker words.
    const ledgerWords = (view: AgentView, options: LegacyShimOptions): string | undefined =>
      observeStatuses(EMPTY_STATUS_LEDGER, [toMonitorAgent(view, options)], SINCE).lanes.get(view.id)?.changes[0]
        ?.blocker?.detail;
    const long = `${'a'.repeat(158)} the tail`;
    const waits: readonly AgentView['wait'][] = [
      { kind: 'permission', since: SINCE, tool: 'Bash' },
      { kind: 'permission', since: SINCE, tool: 'Bash', detail: 'Bash · git push origin main' },
      { kind: 'question', since: SINCE, header: 'Deploy', question: 'Ship it?', detail: 'the detail' },
      { kind: 'question', since: SINCE, header: 'Deploy', question: 'Ship it?' },
      { kind: 'question', since: SINCE, question: '  Keep the flag?  ' },
      { kind: 'question', since: SINCE, header: 'Deploy' },
      { kind: 'question', since: SINCE, detail: '', question: 'Ship it?' },
      { kind: 'question', since: SINCE, detail: '   ', question: 'Ship it?' },
      { kind: 'failure', since: SINCE, code: 'E_RATE', detail: 'rate limited · retrying' },
      { kind: 'failure', since: SINCE, detail: long },
      { kind: 'question', since: SINCE, question: long },
      undefined,
    ];
    for (const [index, wait] of waits.entries()) {
      for (const options of [GODVIEW, REPLY_FIRST]) {
        for (const device of [undefined, LAPTOP]) {
          const view = agentViewFixture({ id: `w${index}`, status: 'blocked', ...(device ? { device } : {}), wait });
          const legacy = ledgerWords(view, options);
          // M9: VibeField's peers carried no Core facts (`omit`), so their lanes had no words; the model's do now.
          if (device && options.peerMonitor === 'omit') {
            expect(legacy).toBeUndefined();
            continue;
          }
          expect(`${index}: ${toolkit.laneWaitWords(wait)}`).toBe(`${index}: ${legacy}`);
        }
      }
    }
    expect(toolkit.laneWaitWords(waits[9])).toHaveLength(160);
    // A kind Core does not name (it names three today) was no blocker to the legacy rows, so the lane said nothing.
    const unnamed = agentViewFixture({
      id: 'w-unnamed',
      status: 'blocked',
      wait: { kind: 'sandbox', since: SINCE, detail: 'sandbox denied' },
    });
    expect(ledgerWords(unnamed, GODVIEW)).toBeUndefined();
    expect(toolkit.laneWaitWords(unnamed.wait)).toBe('sandbox denied');
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

/** VibeField's shim options, whose line ported views compose by (M4); and puppeteer Godview's, for the fallbacks. */
const REPLY_FIRST: LegacyShimOptions = { detail: 'reply-first', peerMonitor: 'omit' };
const GODVIEW: LegacyShimOptions = { detail: 'headline-cost', peerMonitor: 'map' };
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

describe('row words match the shim', () => {
  it('covers every branch of the line: starting, pending, reply, wait, headline, cost, peers, terminals', () => {
    const names = LINE_CASES.map(([name]) => name).join(' | ');
    for (const branch of ['starting', 'pending', 'reply', 'wait', 'headline', 'cost', 'peer', 'terminal']) {
      expect(names).toContain(branch);
    }
  });

  it('detailLine is the shim’s reply-first line, for every case (M4)', () => {
    for (const [index, view] of lineViews.entries()) {
      const name = LINE_CASES[index]![0];
      expect(`${name}: ${toolkit.detailLine(view)}`).toBe(`${name}: ${toMonitorAgent(view, REPLY_FIRST).detail}`);
      // The peer cut changes no word of the line.
      expect(toolkit.detailLine(view)).toBe(toMonitorAgent(view, { ...REPLY_FIRST, peerMonitor: 'map' }).detail);
    }
  });

  it('names a row and what runs it as the shim does, under either host’s options', () => {
    for (const view of lineViews) {
      for (const options of [REPLY_FIRST, GODVIEW]) {
        const legacy = toMonitorAgent(view, options);
        expect(toolkit.projectName(view)).toBe(legacy.project);
        if (legacy.agent) expect(toolkit.modelWord(view)).toBe(legacy.agent.model ?? legacy.agent.provider.label);
      }
    }
  });

  it('says a host’s write policy as the views say it', () => {
    for (const writable of [true, false]) {
      expect(toolkit.hostWriteWord({ writable })).toBe(
        originalRemoteWrite.remoteWriteLabel({ hostWritable: writable }),
      );
      expect(toolkit.hostWriteTitle({ writable })).toBe(
        originalRemoteWrite.remoteWriteTitle({ hostWritable: writable }),
      );
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
