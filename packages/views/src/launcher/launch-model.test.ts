import { describe, expect, it } from 'vitest';
import {
  LAUNCH_FIGURE_MS,
  formatLaunchSeconds,
  initialLaunch,
  launchAnnouncement,
  launchCaption,
  launchCentre,
  launchDuration,
  launchReach,
  launchSettled,
  launchSource,
  launchWaiting,
  reduceLaunch,
  watchDrawnSessions,
  type LaunchEvent,
  type LaunchState,
} from './launch-model.js';

function run(...events: LaunchEvent[]): LaunchState {
  return events.reduce(reduceLaunch, initialLaunch());
}

describe('the launch reducer (pass 4 §27)', () => {
  it('starts in depart with no indicator, nothing running', () => {
    expect(initialLaunch()).toEqual({ phase: 'depart', running: false, fast: false });
    expect(launchWaiting('depart')).toBe(false);
  });

  it('shows the indicator as starting, then opening once the port answers (C3)', () => {
    const starting = run({ type: 'indicator' });
    expect(starting.phase).toBe('starting');
    expect(launchWaiting(starting.phase)).toBe(true);
    const opening = reduceLaunch(starting, { type: 'running', sessionId: 'agent-1' });
    expect(opening).toMatchObject({ phase: 'opening', running: true, sessionId: 'agent-1' });
  });

  it('opens straight into opening when the port answered before the indicator was due', () => {
    expect(run({ type: 'running' }, { type: 'indicator' }).phase).toBe('opening');
  });

  it('goes home on the first frame, having shown the indicator', () => {
    const home = run({ type: 'indicator' }, { type: 'running' }, { type: 'drawn' });
    expect(home).toMatchObject({ phase: 'home', fast: false });
    expect(launchSettled(home)).toBe(true);
  });

  it('never shows an indicator for a launch drawn before it was due (C5)', () => {
    const fast = run({ type: 'running' }, { type: 'drawn' });
    expect(fast).toMatchObject({ phase: 'home', fast: true });
    // …and the indicator's timer firing afterwards changes nothing.
    expect(reduceLaunch(fast, { type: 'indicator' })).toBe(fast);
  });

  it('releases a first frame that never comes, as a late one (C9)', () => {
    expect(run({ type: 'indicator' }, { type: 'running' }, { type: 'late' })).toMatchObject({
      phase: 'home',
      fast: false,
    });
  });

  it('takes no first frame before the port has answered', () => {
    const early = run({ type: 'indicator' }, { type: 'drawn' }, { type: 'late' });
    expect(early.phase).toBe('starting');
  });

  it('turns back on a refusal from any wait, and keeps the reason (C7)', () => {
    for (const before of [[], [{ type: 'indicator' } as const]]) {
      const refused = run(...before, { type: 'refused', reason: 'its profile is signed out' });
      expect(refused).toMatchObject({ phase: 'refused', reason: 'its profile is signed out' });
    }
  });

  it('lets the pane go when the born session leaves it before drawing, and only then', () => {
    const left = run({ type: 'indicator' }, { type: 'running', sessionId: 'agent-1' }, { type: 'left' });
    expect(left).toMatchObject({ phase: 'left', running: true, sessionId: 'agent-1' });
    expect(launchSettled(left)).toBe(true);
    expect(launchWaiting(left.phase)).toBe(false);
    // A first frame or C9 after it changes nothing.
    expect(reduceLaunch(left, { type: 'drawn' })).toBe(left);
    expect(reduceLaunch(left, { type: 'late' })).toBe(left);
    // Before the port names the session, the pane's session is the host's business.
    expect(run({ type: 'indicator' }, { type: 'left' }).phase).toBe('starting');
    expect(run({ type: 'running' }, { type: 'left' }).phase).toBe('depart');
    // A launch already home stays home.
    const home = run({ type: 'running', sessionId: 'a' }, { type: 'drawn' });
    expect(reduceLaunch(home, { type: 'left' })).toBe(home);
  });

  it('ignores every fact once settled, and a repeated fact is the first one', () => {
    const home = run({ type: 'running', sessionId: 'a' }, { type: 'drawn' });
    expect(reduceLaunch(home, { type: 'refused', reason: 'late' })).toBe(home);
    const refused = run({ type: 'refused', reason: 'no' });
    expect(reduceLaunch(refused, { type: 'running' })).toBe(refused);
    const running = run({ type: 'running', sessionId: 'a' });
    expect(reduceLaunch(running, { type: 'running', sessionId: 'b' })).toBe(running);
  });
});

describe('what the launch says', () => {
  it('counts the seconds in tenths, then whole seconds', () => {
    expect(formatLaunchSeconds(1_549)).toBe('1.5s');
    expect(formatLaunchSeconds(9_949)).toBe('9.9s');
    expect(formatLaunchSeconds(12_300)).toBe('12s');
    expect(formatLaunchSeconds(-5)).toBe('0.0s');
  });

  it('names the wait, and adds the seconds from 1.5s (C4)', () => {
    expect(launchCaption('launch', 'starting', 400)).toBe('starting');
    expect(launchCaption('launch', 'starting', LAUNCH_FIGURE_MS)).toBe('starting · 1.5s');
    expect(launchCaption('launch', 'opening', 2_420)).toBe('opening · 2.4s');
    expect(launchCaption('resume', 'starting', 3_000)).toBe('resuming · 3.0s');
    expect(launchCaption('resume', 'opening', 100)).toBe('opening');
  });

  it('announces the wait once the indicator is up, then how it ended, in words', () => {
    // Nothing while it departs: a region filled as it mounts is not reliably read.
    expect(launchAnnouncement('launch', 'Codex', 'depart')).toBe('');
    expect(launchAnnouncement('launch', 'Codex', 'starting')).toBe('Starting Codex');
    expect(launchAnnouncement('resume', 'Claude Code', 'starting')).toBe('Resuming Claude Code');
    expect(launchAnnouncement('launch', 'Codex', 'home')).toBe('Codex is open');
    expect(launchAnnouncement('launch', 'Codex', 'refused')).toBe('Codex did not launch');
    expect(launchAnnouncement('resume', 'Codex', 'refused')).toBe('Codex did not resume');
    expect(launchAnnouncement('launch', 'Codex', 'left')).toBe('Codex exited before it opened');
  });

  it('names the row a launch took its mark from, as the launcher marks it', () => {
    expect(launchSource('launch', 2)).toBe('agent:2');
    expect(launchSource('resume', 0)).toBe('session:0');
  });
});

describe("a runtime's first frame, as a launch watches it", () => {
  class Runtime extends EventTarget {
    readonly drawn = new Set<string>();
    sessionHasDrawn(sessionId: string): boolean {
      return this.drawn.has(sessionId);
    }
    draw(sessionId: string): void {
      this.drawn.add(sessionId);
      this.dispatchEvent(new CustomEvent('session-drawn', { detail: { sessionId } }));
    }
  }

  it('answers at once for a session that has already drawn', () => {
    const runtime = new Runtime();
    runtime.drawn.add('a');
    const seen: string[] = [];
    watchDrawnSessions(runtime)!('a', () => seen.push('a'));
    expect(seen).toEqual(['a']);
  });

  it('waits for its own session, once, and can be let go', () => {
    const runtime = new Runtime();
    const seen: string[] = [];
    const watch = watchDrawnSessions(runtime)!;
    watch('a', () => seen.push('a'));
    const stop = watch('b', () => seen.push('b'));
    runtime.draw('c');
    runtime.draw('a');
    runtime.draw('a');
    if (stop) stop();
    runtime.draw('b');
    expect(seen).toEqual(['a']);
  });

  it('is absent for a runtime without the signal, so the launch lands at the answer', () => {
    expect(watchDrawnSessions(new EventTarget())).toBeUndefined();
  });
});

describe('where the launch draws', () => {
  it('puts the middle half way across and 46% down', () => {
    expect(launchCentre(800, 400)).toEqual({ x: 400, y: 184 });
  });

  it('reaches past the farthest corner', () => {
    const centre = launchCentre(800, 400);
    const corner = Math.hypot(400, 400 - 184);
    expect(launchReach(800, 400)).toBeGreaterThan(corner);
    expect(launchReach(800, 400, centre)).toBe(Math.ceil(corner) + 12);
  });

  it('halves durations under reduced motion', () => {
    expect(launchDuration(420, false)).toBe(420);
    expect(launchDuration(420, true)).toBe(210);
  });
});
