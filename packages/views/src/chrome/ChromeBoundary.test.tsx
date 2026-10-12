// @vitest-environment happy-dom
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonitorViewHost } from '@vibefield/puppeteer-view-sdk/host';
import {
  agentViewsFixture,
  createFixtureReplica,
  createFrameDriver,
  createRecordingView,
  fixtureStage,
  fixtureTheme,
  type FixtureReplica,
  type RecordingView,
} from '@vibefield/puppeteer-view-sdk/testing';
import { CHROME_RETRY_CAP_MS, CHROME_RETRY_FIRST_MS, ChromeBoundary } from './ChromeBoundary.js';

// M49: a chrome reader's render error must not unmount the monitor and its views. The host here is Godview's shape:
// a stage with the view host and its chrome beside it, each chrome piece behind its own boundary.

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A chrome reader that reads a fact the way M47's find sheet did: `session` was not promised, and it threw. */
function FindRows({ rows }: { rows: readonly { session?: { id: string } }[] }): ReactElement {
  return (
    <ul className="find">
      {rows.map((row) => (
        <li key={row.session!.id}>{row.session!.id}</li>
      ))}
    </ul>
  );
}

interface Harness {
  readonly container: HTMLElement;
  readonly root: Root;
  readonly recording: RecordingView;
  readonly replica: FixtureReplica;
  readonly frames: ReturnType<typeof createFrameDriver>;
  render(rows: readonly { session?: { id: string } }[], guarded?: boolean, retryKey?: number): Promise<void>;
}

function harness(onError?: (error: unknown, name: string) => void): Harness {
  const container = document.createElement('main');
  document.body.append(container);
  const root = createRoot(container, { onUncaughtError: () => undefined, onCaughtError: () => undefined });
  const recording = createRecordingView('swarm');
  const replica = createFixtureReplica(agentViewsFixture(2));
  const frames = createFrameDriver();
  const stage = fixtureStage('default');
  const theme = fixtureTheme('dark');
  const commands = { select: () => undefined, create: () => undefined };
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    root,
    recording,
    replica,
    frames,
    render: (rows, guarded = true, retryKey) =>
      act(async () => {
        const find = <FindRows rows={rows} />;
        const usage = <p className="usage">usage</p>;
        root.render(
          <section className="stage">
            <MonitorViewHost
              replica={replica}
              view={recording.view}
              stage={stage}
              theme={theme}
              parameters={{}}
              commands={commands}
              scheduler={frames.scheduler}
            />
            {guarded ? (
              <>
                <ChromeBoundary name="find" onError={onError} {...(retryKey === undefined ? {} : { retryKey })}>
                  {find}
                </ChromeBoundary>
                <ChromeBoundary name="usage" onError={onError}>
                  {usage}
                </ChromeBoundary>
              </>
            ) : (
              <>
                {find}
                {usage}
              </>
            )}
          </section>,
        );
      }),
  };
}

const viewRoots = (container: HTMLElement) => container.querySelectorAll('[data-monitor-view-root]');

describe('a chrome piece behind its own boundary (M49)', () => {
  it('fails alone: the stage, the view host and the other chrome stay mounted, and the view keeps updating', async () => {
    const errors: [string, string][] = [];
    const test = harness((error, name) => errors.push([name, (error as Error).name]));
    await test.render([{ session: { id: 'a' } }]);
    expect(test.container.querySelector('.find')?.textContent).toBe('a');
    expect(test.recording.mounts).toBe(1);

    // The read that blanked M47's window: a row with no session.
    await test.render([{ session: { id: 'a' } }, {}]);
    expect(errors).toEqual([['find', 'TypeError']]);
    expect(test.container.querySelector('.find')).toBeNull();
    expect(test.container.querySelector('[role="status"]')?.textContent).toBe('find unavailable');
    expect(test.container.querySelector('.usage')?.textContent).toBe('usage');
    expect(test.container.querySelector('.stage')).not.toBeNull();
    expect(viewRoots(test.container)).toHaveLength(1);
    expect([test.recording.mounts, test.recording.unmounts, test.recording.live]).toEqual([1, 0, 1]);

    // The monitor is alive: a model change still reaches the view at the next frame.
    const updates = test.recording.updates;
    await act(async () => {
      test.replica.apply({ remove: [test.replica.getSnapshot().model.agents[0]!.id] });
    });
    await act(async () => test.frames.step());
    expect(test.recording.updates).toBe(updates + 1);
    expect(test.recording.lastInput?.model.agents).toHaveLength(1);
  });

  it('without a key, stays unavailable through the host’s next renders: only a remount tries it again', async () => {
    const onError = vi.fn();
    const test = harness(onError);
    await test.render([{}]);
    await test.render([{}, {}]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(test.container.querySelector('.find')).toBeNull();
    expect(test.container.querySelector('[role="status"]')?.textContent).toBe('find unavailable');
    // Healthy rows on the host's next render are no reason to retry (M176 item 1): nothing says the read is fixed.
    await test.render([{ session: { id: 'b' } }]);
    expect(test.container.querySelector('.find')).toBeNull();
    expect(test.container.querySelector('[role="status"]')?.textContent).toBe('find unavailable');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(viewRoots(test.container)).toHaveLength(1);
  });

  it('retries on new owning facts, not the parent observing its fallback', async () => {
    vi.useFakeTimers();
    const test = harness();
    await test.render([{}], true, 1);
    expect(test.container.querySelector('[role="status"]')?.textContent).toBe('find unavailable');
    // A DOM observer can republish the host while the source facts still stand.
    // Even a new child must wait for the fact key, rather than remounting on that feedback.
    await test.render([{ session: { id: 'ready' } }], true, 1);
    expect(test.container.querySelector('.find')).toBeNull();
    await act(async () => vi.advanceTimersByTime(CHROME_RETRY_FIRST_MS));
    expect(test.container.querySelector('.find')).toBeNull();
    // The facts move: the piece is tried again, and it renders.
    await test.render([{ session: { id: 'ready' } }], true, 2);
    expect(test.container.querySelector('.find')?.textContent).toBe('ready');
    expect(test.container.querySelector('[role="status"]')).toBeNull();
    expect(test.recording.unmounts).toBe(0);
  });

  it('adds nothing to a healthy piece’s DOM', async () => {
    const test = harness();
    await test.render([{ session: { id: 'a' } }]);
    expect(test.container.querySelector('.stage > .find')).not.toBeNull();
    expect(test.container.querySelector('.stage > .usage')).not.toBeNull();
  });

  it('without it, the same read unmounts the whole tree: the monitor and its view with it (the control)', async () => {
    const test = harness();
    await test.render([{ session: { id: 'a' } }], false);
    expect(viewRoots(test.container)).toHaveLength(1);
    // act() hands the uncaught render error back once React has unmounted the root.
    let thrown: unknown;
    try {
      await test.render([{ session: { id: 'a' } }, {}], false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(test.container.querySelector('.stage')).toBeNull();
    expect(viewRoots(test.container)).toHaveLength(0);
    expect(test.recording.unmounts).toBe(1);
  });
});

// M176 item 1: the retry rule. No automatic retry without a fact key; with one, a backoff that doubles from
// CHROME_RETRY_FIRST_MS to CHROME_RETRY_CAP_MS; one report per failure episode. React replays a throwing render
// within the same attempt (it invokes the component three times in 19.2), so these count ATTEMPTS: the distinct
// moments the piece was rendered, read off the fake clock, which stands still inside one attempt.

/** A chrome piece that throws while `state.broken`, noting the clock at each render. */
function piece(state: { broken: boolean; renders: number[] }) {
  return function Piece({ tick }: { tick: number }): ReactNode {
    state.renders.push(Date.now());
    if (state.broken) throw new Error(`the read failed (${tick})`);
    return <p className="piece">tick {tick}</p>;
  };
}

/** How many distinct attempts the renders were. */
const attempts = (renders: readonly number[]): number => new Set(renders).size;

function retryHarness(options: { keyed: boolean; onError?: (error: unknown, name: string) => void }) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container, { onUncaughtError: () => undefined, onCaughtError: () => undefined });
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const state = { broken: true, renders: [] as number[] };
  const Piece = piece(state);
  let tick = 0;
  return {
    container,
    root,
    state,
    /** The host renders again, with fresh children (a new element every time), and the key it holds. */
    render: (retryKey?: unknown, boundaryKey = 'once') =>
      act(async () => {
        tick += 1;
        root.render(
          <ChromeBoundary
            key={boundaryKey}
            name="usage"
            onError={options.onError}
            {...(options.keyed ? { retryKey } : {})}
          >
            <Piece tick={tick} />
          </ChromeBoundary>,
        );
      }),
    advance: (ms: number) => act(async () => vi.advanceTimersByTime(ms)),
    /** To the next timer exactly, so the retry it starts renders at its own moment (act defers the render). */
    nextTimer: () => act(async () => vi.advanceTimersToNextTimer()),
    status: () => container.querySelector('[role="status"]')?.textContent ?? null,
  };
}

describe('the retry rule (M176 item 1)', () => {
  it('without a key: a throwing child under 100 host renders with fresh children fails once, and stays unavailable', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const test = retryHarness({ keyed: false, onError });
    await test.render();
    expect(attempts(test.state.renders)).toBe(1);
    expect(test.status()).toBe('usage unavailable');
    for (let render = 0; render < 100; render += 1) {
      await test.advance(400);
      await test.render();
    }
    expect(attempts(test.state.renders)).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(test.status()).toBe('usage unavailable');
  });

  it('without a key: the host remounting the piece is what tries it again', async () => {
    vi.useFakeTimers();
    const test = retryHarness({ keyed: false });
    await test.render(undefined, 'first');
    test.state.broken = false;
    await test.render(undefined, 'first');
    expect(test.status()).toBe('usage unavailable');
    await test.render(undefined, 'second');
    expect(test.status()).toBeNull();
    expect(test.container.querySelector('.piece')).not.toBeNull();
  });

  it('with a key: a key change after the window retries once', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const test = retryHarness({ keyed: true, onError });
    await test.render(1);
    expect(attempts(test.state.renders)).toBe(1);
    await test.advance(CHROME_RETRY_FIRST_MS);
    await test.render(2);
    expect(attempts(test.state.renders)).toBe(2);
    // The same key again is no new fact: no retry, however long it stands.
    await test.advance(CHROME_RETRY_CAP_MS * 2);
    await test.render(2);
    expect(attempts(test.state.renders)).toBe(2);
    expect(test.status()).toBe('usage unavailable');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('with a key: rapid key changes inside the window retry at most once, when it ends', async () => {
    vi.useFakeTimers();
    const test = retryHarness({ keyed: true });
    await test.render(1);
    // A key that changes on every publish: 60 changes 10 ms apart, all inside the first window.
    for (let key = 2; key <= 61; key += 1) {
      await test.advance(10);
      await test.render(key);
    }
    expect(Date.now() - test.state.renders[0]!).toBeLessThan(CHROME_RETRY_FIRST_MS);
    expect(attempts(test.state.renders)).toBe(1);
    await test.advance(CHROME_RETRY_FIRST_MS);
    expect(attempts(test.state.renders)).toBe(2);
    // Nothing else retries until the facts move again.
    await test.advance(CHROME_RETRY_CAP_MS * 2);
    expect(attempts(test.state.renders)).toBe(2);
  });

  it('with a key: the window doubles from 1 s to its 30 s cap while the failure persists', async () => {
    vi.useFakeTimers();
    const test = retryHarness({ keyed: true });
    let key = 0;
    await test.render((key += 1));
    // The facts change at once after every failure, so each retry waits out the whole window.
    for (let retry = 0; retry < 8; retry += 1) {
      await test.render((key += 1));
      await test.nextTimer();
    }
    const moments = [...new Set(test.state.renders)];
    const gaps = moments.slice(1).map((moment, index) => moment - moments[index]!);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('a child that recovers shows again; its next failure is a new episode, reported, with the window back at 1 s', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const test = retryHarness({ keyed: true, onError });
    await test.render(1);
    await test.advance(CHROME_RETRY_FIRST_MS);
    await test.render(2);
    await test.advance(2 * CHROME_RETRY_FIRST_MS);
    test.state.broken = false;
    await test.render(3);
    expect(test.status()).toBeNull();
    expect(test.container.querySelector('.piece')?.textContent).toMatch(/^tick \d+$/);
    expect(onError).toHaveBeenCalledTimes(1);

    test.state.broken = true;
    await test.render(4);
    expect(test.status()).toBe('usage unavailable');
    expect(onError).toHaveBeenCalledTimes(2);
    const failedAt = Date.now();
    await test.render(5);
    await test.nextTimer();
    const moments = [...new Set(test.state.renders)];
    expect(moments.at(-1)! - failedAt).toBe(CHROME_RETRY_FIRST_MS);
  });

  it('a retry waiting on its window dies with the piece', async () => {
    vi.useFakeTimers();
    const test = retryHarness({ keyed: true });
    await test.render(1);
    await test.render(2);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => test.root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    expect(attempts(test.state.renders)).toBe(1);
  });
});
