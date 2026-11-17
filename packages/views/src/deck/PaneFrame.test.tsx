// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneFrame, PaneFrameChrome, STOPPING_TIMEOUT_MS, type PaneFrameVerbs } from './PaneFrame.js';
import { paneFrameModel, type PaneFrameAgent, type PaneFrameSession } from './pane-frame.js';

// The frame's MARKUP, statically: the badge, the readout, the verbs a host
// lends, the meter — what a host's rows and a screen reader reach. The stopping
// state is the portal's own, so the last rows mount `PaneFrame` into a pane
// element; a real pane's layout stays the host's smoke to witness.

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const ALL_VERBS: PaneFrameVerbs = {
  stop: () => ({ accepted: true }),
  resume: () => undefined,
  zoom: () => undefined,
  zoomShortcut: '⌘⇧↵',
};
const NOOP = () => undefined;

function session(overrides: Partial<PaneFrameSession> = {}): PaneFrameSession {
  return { id: 'term-1', exited: false, cwd: '/Users/james/Projects/rosetta', ...overrides };
}

function agent(overrides: Partial<PaneFrameAgent> = {}): PaneFrameAgent {
  return {
    providerId: 'codex',
    providerLabel: 'Codex',
    status: 'working',
    alive: true,
    statusSince: new Date(NOW - 65_000).toISOString(),
    project: 'rosetta',
    model: 'gpt-5.3-codex',
    effort: { value: 'high', configured: true },
    contextPercent: 88,
    ...overrides,
  };
}

function markup(
  input: { session: PaneFrameSession; agent?: PaneFrameAgent; remote?: string },
  verbs: PaneFrameVerbs = ALL_VERBS,
  options: { zoomed?: boolean; stopping?: boolean; pausing?: boolean; color?: string } = {},
): string {
  const model = paneFrameModel({
    session: input.session,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.remote ? { remoteDevice: input.remote } : {}),
    nowMs: NOW,
  });
  return renderToStaticMarkup(
    <PaneFrameChrome
      sessionId={input.session.id}
      model={model}
      {...(options.color ? { color: options.color } : {})}
      zoomed={options.zoomed ?? false}
      stopping={options.stopping ?? false}
      pausing={options.pausing ?? false}
      verbs={verbs}
      onStop={NOOP}
      onPause={NOOP}
      onResume={NOOP}
      onZoom={NOOP}
    />,
  );
}

describe('PaneFrameChrome', () => {
  it('offers fullscreen on a shell without agent controls', () => {
    const html = markup({ session: session() });
    expect(html).toContain('data-vf-pane-frame="term-1"');
    expect(html).toContain('class="vf-pane-name">rosetta<');
    expect(html).not.toContain('vf-pane-readout');
    expect(html).toContain('aria-label="Fullscreen the pane"');
    expect(html).not.toContain('is-stop');
    expect(html).not.toContain('is-resume');
    expect(html).not.toContain('vf-pane-meter');
    expect(html).not.toContain('vf-pane-mark');
  });

  it('draws an agent with its mark, the readout, the stop verb with the turn time, and a hot meter', () => {
    const html = markup({ session: session(), agent: agent() }, ALL_VERBS, { color: 'hsl(268 58% 56%)' });
    expect(html).toContain('class="vf-pane-frame is-hot"');
    expect(html).toContain('--pane-color:hsl(268 58% 56%)');
    expect(html).toContain('vf-pane-mark');
    expect(html).toContain('gpt-5.3-codex');
    expect(html).toContain('<em>high</em>');
    expect(html).toContain('aria-label="Stop the turn"');
    expect(html).toContain('class="vf-pane-verb-text">1:05<');
    expect(html).toContain('title="Fullscreen ⌘⇧↵"');
    expect(html).toContain('class="vf-pane-meter is-hot"');
    expect(html).toContain('--ctx:0.88');
    expect(html).toContain('class="vf-pane-figure is-hot"');
    expect(html).not.toContain('is-resume');
  });

  it('offers resume, not stop, once the run has ended', () => {
    const html = markup({ session: session({ exited: true }), agent: agent({ alive: false, status: 'idle' }) });
    expect(html).toContain('class="vf-pane-verb is-resume"');
    expect(html).not.toContain('is-stop');
  });

  it('draws no verb a host did not lend', () => {
    const html = markup({ session: session(), agent: agent() }, { zoom: () => undefined });
    expect(html).not.toContain('is-stop');
    expect(html).not.toContain('is-resume');
    expect(html).toContain('class="vf-pane-verb is-zoom"');
    expect(html).toContain('title="Fullscreen"');
    expect(markup({ session: session(), agent: agent() }, {})).not.toContain('vf-pane-verbs');
  });

  it('says stopping while a stop is out, and restore while zoomed', () => {
    const html = markup({ session: session(), agent: agent() }, ALL_VERBS, { stopping: true, zoomed: true });
    expect(html).toContain('class="vf-pane-frame is-hot is-stopping"');
    expect(html).toContain('aria-label="Stopping the turn"');
    expect(html).toContain('aria-label="Restore the pane"');
  });

  it('names a host end-session control accurately without a turn-interrupt key', () => {
    const input = { session: session(), agent: agent({ status: 'idle', stopKey: 'escape' }) };
    const verbs = { ...ALL_VERBS, stopKind: 'session' as const };
    const html = markup(input, verbs);
    expect(html).toContain('aria-label="Stop agent"');
    expect(html).toContain('title="Stop agent"');
    expect(html).not.toContain('⎋');
    const stopping = markup(input, verbs, { stopping: true });
    expect(stopping).toContain('aria-label="Stopping agent"');
    expect(stopping).toContain('title="Stopping agent…"');
  });

  it('separates Pause with the turn time and cancel key from Stop agent', () => {
    const verbs = { ...ALL_VERBS, stopKind: 'session' as const, pause: () => ({ accepted: true }) };
    const input = { session: session(), agent: agent({ stopKey: 'escape' }) };
    const html = markup(input, verbs);
    expect(html).toContain('aria-label="Pause current turn"');
    expect(html).toContain('title="Pause current turn, 1:05 in ⎋"');
    expect(html).toContain('aria-label="Stop agent"');
    expect(html.match(/>1:05</g)).toHaveLength(1);
    const pausing = markup(input, verbs, { pausing: true });
    expect(pausing).toContain('is-pausing');
    expect(pausing).toContain('title="Pausing current turn…"');
    expect(pausing).toMatch(/is-pause[^>]+disabled=""/);
    expect(pausing).not.toMatch(/is-stop[^>]+disabled=""/);
    const idle = markup({ session: session(), agent: agent({ status: 'idle' }) }, verbs);
    expect(idle).toMatch(/is-pause[^>]+disabled=""/);
    expect(idle).not.toMatch(/is-stop[^>]+disabled=""/);
    const shell = markup({ session: session() }, verbs);
    expect(shell).not.toContain('is-pause');
    expect(markup({ session: session({ exited: true }), agent: agent({ alive: false }) }, verbs)).not.toContain(
      'is-pause',
    );
  });

  it("names the key the stop presses, the agent's own, and none for a stop that presses no key", () => {
    const escape = agent({ stopKey: 'escape' });
    expect(markup({ session: session(), agent: escape })).toContain('title="Stop the turn, 1:05 in ⎋"');
    expect(markup({ session: session(), agent: { ...escape, status: 'idle' } })).toContain('title="Stop the turn ⎋"');
    expect(markup({ session: session(), agent: agent({ status: 'idle', stopKey: 'ctrl-c' }) })).toContain(
      'title="Stop the turn ⌃C"',
    );
    // a native stop (Hermes's gateway interrupt) presses no key, so the title invents none
    const native = markup({ session: session(), agent: agent() });
    expect(native).toContain('title="Stop the turn, 1:05 in"');
    expect(native).not.toContain('⌃C');
    const stopping = markup({ session: session(), agent: escape }, ALL_VERBS, { stopping: true });
    expect(stopping).toContain('title="Stopping the turn…"');
  });

  it('marks a remote session with the tether and names its device', () => {
    const html = markup({ session: session(), remote: 'studio' });
    expect(html).toContain('class="vf-pane-os"');
    expect(html).toContain('title="rosetta on studio"');
  });
});

describe('PaneFrame', () => {
  const SESSION_VERBS: PaneFrameVerbs = {
    stop: () => ({ accepted: true }),
    stopKind: 'session',
    pause: () => ({ accepted: true }),
  };
  const cleanups: (() => void)[] = [];

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.useRealTimers();
  });

  /** The frame as a host mounts it, on a fake clock: only a row's own `advance` reaches STOPPING_TIMEOUT_MS. */
  function mounted(verbs: PaneFrameVerbs = SESSION_VERBS) {
    const container = document.createElement('main');
    const pane = document.createElement('section');
    document.body.append(container, pane);
    const root = createRoot(container);
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
      pane.remove();
    });
    const verb = (kind: 'stop' | 'pause') => pane.querySelector<HTMLButtonElement>(`.vf-pane-verb.is-${kind}`)!;
    return {
      verb,
      stopping: () => pane.querySelector('.vf-pane-frame')!.classList.contains('is-stopping'),
      render: (running: PaneFrameAgent | undefined) =>
        act(async () => {
          root.render(
            <PaneFrame pane={pane} session={session()} agent={running} zoomed={false} nowMs={NOW} verbs={verbs} />,
          );
        }),
      pressStop: () => act(async () => verb('stop').click()),
      advance: (ms: number) => act(async () => vi.advanceTimersByTime(ms)),
    };
  }

  it('lets go of stopping when the agent is gone, with its session live and no exit heard', async () => {
    const test = mounted();
    await test.render(agent());
    await test.pressStop();
    expect(test.stopping()).toBe(true);
    await test.render(undefined);
    expect(test.stopping()).toBe(false);
  });

  it('gives the next run in that shell a live Stop and Pause before the timer would have let go', async () => {
    const stop = vi.fn(() => ({ accepted: true }));
    const test = mounted({ ...SESSION_VERBS, stop });
    await test.render(agent());
    await test.pressStop();
    await test.render(undefined);
    await test.render(agent());
    expect(test.verb('stop').disabled).toBe(false);
    expect(test.verb('stop').getAttribute('aria-label')).toBe('Stop agent');
    expect(test.verb('pause').disabled).toBe(false);
    await test.pressStop();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('holds stopping through an idle turn while the agent stays, until the timer lets go', async () => {
    const test = mounted();
    await test.render(agent());
    await test.pressStop();
    await test.render(agent({ status: 'idle' }));
    await test.advance(STOPPING_TIMEOUT_MS - 1);
    expect(test.stopping()).toBe(true);
    await test.advance(1);
    expect(test.stopping()).toBe(false);
  });
});
