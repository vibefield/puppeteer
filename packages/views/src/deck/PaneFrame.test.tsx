import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaneFrameChrome, type PaneFrameVerbs } from './PaneFrame.js';
import { paneFrameModel, type PaneFrameAgent, type PaneFrameSession } from './pane-frame.js';

// The frame's MARKUP, statically: the badge, the readout, the verbs a host
// lends, the meter — what a host's rows and a screen reader reach. The
// portal needs a pane element and is the host's smoke to witness.

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
  options: { zoomed?: boolean; stopping?: boolean; color?: string } = {},
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
      verbs={verbs}
      onStop={NOOP}
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

  it('marks a remote session with the tether and names its device', () => {
    const html = markup({ session: session(), remote: 'studio' });
    expect(html).toContain('class="vf-pane-os"');
    expect(html).toContain('title="rosetta on studio"');
  });
});
