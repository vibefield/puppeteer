import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaneLaunchChrome, type PaneLaunchChromeProps } from './PaneLaunchChrome.js';
import { LAUNCH_PATCH_RADIUS, launchCaption, launchCentre, launchReach } from './launch-model.js';

// The launch's MARKUP, statically, for each face of pass 4 §30 (C · Cells):
// what a host's catalog shows and what a screen reader reaches. The flights
// themselves need a pane and a clock and are the host's smoke to witness.

const WIDTH = 800;
const HEIGHT = 400;
const CENTRE = launchCentre(WIDTH, HEIGHT);

function render(overrides: Partial<PaneLaunchChromeProps> = {}): string {
  return renderToStaticMarkup(
    <PaneLaunchChrome
      launchId="launch-1"
      verb="launch"
      providerId="codex"
      label="Codex"
      phase="starting"
      caption={launchCaption('launch', 'starting', 2_400)}
      color="hsl(140 52% 40%)"
      centre={CENTRE}
      reach={LAUNCH_PATCH_RADIUS}
      lit
      waiting
      {...overrides}
    />,
  );
}

describe('the launch as markup (C · Cells)', () => {
  it('starts lit and waiting, with the grid a patch around the mark and the caption under it', () => {
    const html = render();
    expect(html).toContain('class="vf-pane-launch is-starting is-lit is-waiting"');
    expect(html).toContain('data-vf-pane-launch="launch-1"');
    expect(html).toContain(`--launch-cx:${CENTRE.x}px;--launch-cy:${CENTRE.y}px;--pane-color:hsl(140 52% 40%)`);
    expect(html).toContain(`--vf-launch-r:${LAUNCH_PATCH_RADIUS}px`);
    expect(html).toContain('<b>Codex</b><span>starting · 2.4s</span>');
  });

  it('puts the mark at the middle of the pane, the size the launch flies it at', () => {
    expect(render()).toContain(`transform:translate(${CENTRE.x - 13}px, ${CENTRE.y - 13}px)`);
    expect(render()).toContain('class="vf-pane-launch-mark"');
    expect(render()).toContain('<svg');
  });

  it('reaches past the corners once the agent runs', () => {
    const reach = launchReach(WIDTH, HEIGHT);
    const html = render({ phase: 'opening', reach, caption: launchCaption('launch', 'opening', 3_100) });
    expect(html).toContain('class="vf-pane-launch is-opening is-lit is-waiting"');
    expect(html).toContain(`--vf-launch-r:${reach}px`);
    expect(html).toContain(`--launch-ripple-max:${reach}px`);
    expect(html).toContain('<span>opening · 3.1s</span>');
  });

  it('says what it is doing to a screen reader, and not the seconds', () => {
    expect(render()).toContain('role="status" aria-live="polite">Starting Codex</span>');
    expect(render({ verb: 'resume', label: 'Claude Code' })).toContain('>Resuming Claude Code</span>');
    expect(render({ phase: 'home', waiting: false })).toContain('>Codex is open</span>');
    expect(render({ phase: 'refused', waiting: false, lit: false })).toContain('>Codex did not launch</span>');
    expect(render()).toMatch(/class="vf-pane-launch-caption" aria-hidden="true"/);
  });

  it('draws no indicator once the launch is on its way out', () => {
    expect(render({ phase: 'home', waiting: false })).toContain('class="vf-pane-launch is-home is-lit"');
    expect(render({ phase: 'refused', waiting: false, lit: false })).toContain('class="vf-pane-launch is-refused"');
  });

  it('keeps a mark for a session whose agent has none, and says when motion is reduced', () => {
    const html = render({ verb: 'resume', providerId: undefined, label: 'untitled session', reduced: true });
    expect(html).not.toContain('<svg');
    expect(html).toContain('<span class="vf-pane-launch-glyph">·</span>');
    expect(html).toContain('is-reduced');
    const bare = renderToStaticMarkup(
      <PaneLaunchChrome
        launchId="launch-2"
        verb="launch"
        label="Codex"
        phase="depart"
        caption="starting"
        centre={CENTRE}
        reach={0}
        lit={false}
        waiting={false}
      />,
    );
    expect(bare).toContain('class="vf-pane-launch is-depart"');
    expect(bare).not.toContain('--pane-color');
  });
});
