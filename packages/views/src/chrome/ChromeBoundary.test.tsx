// @vitest-environment happy-dom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonitorViewHost } from '@vibecook/puppeteer-view-sdk/host';
import {
  agentViewsFixture,
  createFixtureReplica,
  createFrameDriver,
  createRecordingView,
  fixtureStage,
  fixtureTheme,
  type FixtureReplica,
  type RecordingView,
} from '@vibecook/puppeteer-view-sdk/testing';
import { ChromeBoundary } from './ChromeBoundary.js';

// M49: a chrome reader's render error must not unmount the monitor and its views. The host here is Godview's shape:
// a stage with the view host and its chrome beside it, each chrome piece behind its own boundary.

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
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

  it('tries the piece again on the host’s next render, and reports a failure that repeats only once', async () => {
    const onError = vi.fn();
    const test = harness(onError);
    await test.render([{}]);
    await test.render([{}, {}]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(test.container.querySelector('.find')).toBeNull();
    expect(test.container.querySelector('[role="status"]')?.textContent).toBe('find unavailable');
    await test.render([{ session: { id: 'b' } }]);
    expect(test.container.querySelector('.find')?.textContent).toBe('b');
    expect(test.container.querySelector('[role="status"]')).toBeNull();
    expect(viewRoots(test.container)).toHaveLength(1);
  });

  it('retries on new owning facts, not the parent observing its fallback', async () => {
    const test = harness();
    await test.render([{}], true, 1);
    expect(test.container.querySelector('[role="status"]')?.textContent).toBe('find unavailable');
    // A DOM observer can republish the host while the source facts still stand.
    // Even a new child must wait for the fact key, rather than remounting on that feedback.
    await test.render([{ session: { id: 'ready' } }], true, 1);
    expect(test.container.querySelector('.find')).toBeNull();
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
