// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { FindAgent } from './find-agent.js';
import { FIND_DEBOUNCE_MS } from './find-model.js';
import type { HistorySearchHit, HistorySearchResponse, HistorySearchStatus } from './history-port.js';
import { FindSheet, type FindHistoryBridge } from './FindSheet.js';

const NEVER: FindHistoryBridge = {
  status: () => new Promise(() => undefined),
  facts: () => new Promise(() => undefined),
  search: () => new Promise(() => undefined),
};

function agent(id: string, project: string, native: string): FindAgent {
  return {
    id,
    createdAtMs: 1_000,
    status: 'working',
    project,
    detail: 'editing',
    color: '#abcdef',
    agent: {
      provider: { id: 'provider-x', label: 'Provider X' },
      model: 'model-1',
      branch: 'main',
      monitor: {
        statusSince: '2026-09-09T11:59:00.000Z',
        session: { nativeSessionId: native },
      },
      nativeSessionId: native,
    },
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
    const hosted = { ...agent('a', 'vibe-field', 'n-a'), hostSessionId: 'pty-1' };
    const markup = renderToStaticMarkup(
      <FindSheet
        open
        agents={[hosted, { ...agent('b', 'puppeteer', 'n-b'), hostSessionId: 'pty-2' }]}
        onClose={() => undefined}
        onSelect={(row) => {
          expectTypeOf(row.hostSessionId).toEqualTypeOf<string>();
        }}
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

/* ── the words lane, mounted ───────────────────────────────────────────── */

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const NOOP = () => undefined;
const READY: HistorySearchStatus = { reachable: true, readiness: 'ready', checkedAt: new Date(NOW).toISOString() };
/** One live set, kept across renders as a host keeps it. */
const LIVE: readonly FindAgent[] = [agent('a', 'vibe-field', 'n-a')];

function hit(timelineId: string, snippet: string): HistorySearchHit {
  return {
    sessionId: 'rs-a',
    rootSessionId: 'rs-a',
    nativeSessionId: 'n-a',
    timelineId,
    kind: 'user',
    at: NOW,
    snippet,
  };
}

/** A daemon that holds every search until the test answers it, in any order. */
function heldDaemon() {
  const answers: ((response: HistorySearchResponse) => void)[] = [];
  const search = vi.fn<FindHistoryBridge['search']>(
    () =>
      new Promise<HistorySearchResponse>((resolve) => {
        answers.push(resolve);
      }),
  );
  const history: FindHistoryBridge = { status: async () => READY, facts: async () => [], search };
  /** Answers the call-th search (from 0) with one hit carrying the snippet. */
  const answer = (call: number, snippet: string): void => {
    answers[call]!({ status: READY, answered: true, hits: [hit(`t-${call}`, snippet)], clipped: false });
  };
  return { history, search, answer };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

/** Types into the React-controlled field as a keyboard does: the native setter, then a bubbling input event. */
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The sheet mounted open on the live set. */
async function openSheet(history: FindHistoryBridge) {
  const container = document.createElement('main');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(<FindSheet open agents={LIVE} onClose={NOOP} onSelect={NOOP} history={history} nowMs={NOW} />);
  });
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  return {
    container,
    type: (value: string) => act(async () => typeInto(input, value)),
    /** Lets the debounce run out, so the words just typed are asked. */
    wait: () =>
      act(async () => {
        vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
      }),
  };
}

describe('the words lane lands only the answer to the question still asked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('drops an answer to words the field no longer holds', async () => {
    const daemon = heldDaemon();
    const sheet = await openSheet(daemon.history);
    await sheet.type('auth');
    await sheet.wait();
    expect(daemon.search).toHaveBeenCalledTimes(1);

    // The field is cleared while 'auth' is still out; its answer arrives after.
    await sheet.type('');
    await act(async () => daemon.answer(0, 'the [auth] bug'));
    expect(sheet.container.querySelector('.vf-find-evidence')).toBeNull();
    expect(sheet.container.textContent).not.toContain('auth');
    expect(sheet.container.querySelector('.vf-find-foot span:last-child')?.textContent).toBe('1 live session');
  });

  it('a late answer to an earlier question never overwrites a later one', async () => {
    const daemon = heldDaemon();
    const sheet = await openSheet(daemon.history);
    await sheet.type('au');
    await sheet.wait();
    await sheet.type('auth');
    await sheet.wait();
    expect(daemon.search.mock.calls.map(([request]) => request.query)).toEqual(['au', 'auth']);

    await act(async () => daemon.answer(1, 'the [auth] bug'));
    await act(async () => daemon.answer(0, 'an [au]x cable'));
    const evidence = sheet.container.querySelector('.vf-find-evidence')?.textContent;
    expect(evidence).toContain('the auth bug');
    expect(evidence).not.toContain('aux');
  });
});
