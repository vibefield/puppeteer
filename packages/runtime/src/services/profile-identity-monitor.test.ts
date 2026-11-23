import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ProfileFailure, ProfileIdentity } from '@vibefield/puppeteer-core';
import { PROFILE_IDENTITY_REFRESH_MS, createProfileIdentityMonitor } from './profile-identity-monitor.js';

const HOUR_MS = 60 * 60_000;
const T0 = Date.parse('2026-11-23T10:00:00.000Z');

function identity(verifiedAtMs: number, plan = 'Max'): ProfileIdentity {
  return {
    loggedIn: true,
    plan,
    verifiedAt: new Date(verifiedAtMs).toISOString(),
    source: { kind: 'native-status', stability: 'documented' },
  };
}

function profile(id: string, verifiedAtMs?: number, extra: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    provider: 'some-agent',
    label: id,
    kind: 'managed',
    dataRoot: `/roots/${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...(verifiedAtMs === undefined ? {} : { identity: identity(verifiedAtMs) }),
    ...extra,
  };
}

/** A registry of sign-ins and a verify that records its reading on them, as the runtime's does. */
function world(initial: AgentProfile[], startAtMs = T0) {
  let nowMs = startAtMs;
  const profiles = new Map(initial.map((each) => [each.id, each]));
  const failures = new Map<string, ProfileFailure>();
  const verify = vi.fn(async (profileId: string): Promise<ProfileIdentity | ProfileFailure> => {
    const failure = failures.get(profileId);
    if (failure) return failure;
    const read = identity(nowMs, 'Max 20x');
    profiles.set(profileId, { ...profiles.get(profileId)!, identity: read });
    return read;
  });
  return {
    verify,
    profiles,
    failures,
    listProfiles: vi.fn(async () => [...profiles.values()]),
    now: () => new Date(nowMs),
    advance(ms: number) {
      nowMs += ms;
    },
    asked: () => verify.mock.calls.map(([id]) => id),
  };
}

describe('createProfileIdentityMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a sign-in whose reading has aged or was never taken, and leaves a fresh one', async () => {
    const w = world([profile('aged', T0 - 2 * HOUR_MS), profile('fresh', T0 - 10 * 60_000), profile('unread')]);
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now: w.now });

    await expect(monitor.refresh()).resolves.toEqual({ read: ['aged', 'unread'], failed: [] });
    expect(w.profiles.get('aged')?.identity?.plan).toBe('Max 20x');
    expect(w.profiles.get('fresh')?.identity?.plan).toBe('Max');
  });

  it('holds a reading for the interval, an hour by default, whoever took it', async () => {
    expect(PROFILE_IDENTITY_REFRESH_MS).toBe(HOUR_MS);
    const w = world([profile('a', T0 - 2 * HOUR_MS)]);
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now: w.now });

    await monitor.refresh();
    w.advance(59 * 60_000);
    await monitor.refresh();
    expect(w.asked()).toEqual(['a']);

    // Another path reads it (a login pane closing): the wait starts again from that reading.
    w.profiles.set('a', profile('a', T0 + 59 * 60_000));
    w.advance(30 * 60_000);
    await monitor.refresh();
    expect(w.asked()).toEqual(['a']);

    w.advance(31 * 60_000);
    await monitor.refresh();
    expect(w.asked()).toEqual(['a', 'a']);
  });

  it('never reads a retired sign-in, and forgets one that has left the registry', async () => {
    const w = world([profile('kept'), profile('retired', undefined, { retiredAt: '2026-11-22T00:00:00.000Z' })]);
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now: w.now });

    await monitor.refresh({ force: true });
    expect(w.asked()).toEqual(['kept']);

    w.profiles.delete('kept');
    w.advance(2 * HOUR_MS);
    await expect(monitor.refresh({ force: true })).resolves.toEqual({ read: [], failed: [] });
  });

  it('a forced refresh reads a fresh reading, only the sign-ins named, and one sign-in once in 30 seconds', async () => {
    const w = world([profile('a', T0 - 60_000), profile('b', T0 - 60_000)]);
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now: w.now });

    await expect(monitor.refresh({ force: true, profileIds: ['b'] })).resolves.toEqual({ read: ['b'], failed: [] });
    w.advance(10_000);
    await expect(monitor.refresh({ force: true })).resolves.toEqual({ read: ['a'], failed: [] });
    w.advance(30_000);
    await expect(monitor.refresh({ force: true })).resolves.toEqual({ read: ['a', 'b'], failed: [] });
  });

  it('retries a failure that may pass sooner, doubling up to the interval, and one that will not at the interval', async () => {
    const w = world([profile('flaky'), profile('mute')]);
    w.failures.set('flaky', { status: 'unavailable', message: 'the command did not answer', retryable: true });
    w.failures.set('mute', { status: 'unsupported', message: 'no status surface', retryable: false });
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now: w.now });

    await expect(monitor.refresh()).resolves.toEqual({ read: ['flaky', 'mute'], failed: ['flaky', 'mute'] });
    w.advance(59_000);
    await expect(monitor.refresh()).resolves.toEqual({ read: [], failed: [] });
    w.advance(1_000);
    await expect(monitor.refresh()).resolves.toEqual({ read: ['flaky'], failed: ['flaky'] });
    // the second wait is two minutes
    w.advance(119_000);
    await expect(monitor.refresh()).resolves.toEqual({ read: [], failed: [] });
    w.failures.delete('flaky');
    w.advance(1_000);
    await expect(monitor.refresh()).resolves.toEqual({ read: ['flaky'], failed: [] });
    // the one that will not pass waited the whole interval
    w.advance(HOUR_MS - 3 * 60_000);
    await expect(monitor.refresh()).resolves.toEqual({ read: ['mute'], failed: ['mute'] });
  });

  it('a verify that throws is a failure that may pass, reported and never thrown', async () => {
    const w = world([profile('a')]);
    w.verify.mockRejectedValueOnce(new Error('spawn failed'));
    const onError = vi.fn();
    const monitor = createProfileIdentityMonitor({
      listProfiles: w.listProfiles,
      verify: w.verify,
      now: w.now,
      onError,
    });

    await expect(monitor.refresh()).resolves.toEqual({ read: ['a'], failed: ['a'] });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'spawn failed' }));
    w.advance(60_000);
    await expect(monitor.refresh()).resolves.toEqual({ read: ['a'], failed: [] });
  });

  it('reads at most `concurrency` sign-ins at once, in the registry order', async () => {
    const w = world([profile('a'), profile('b'), profile('c'), profile('d'), profile('e')]);
    let running = 0;
    let most = 0;
    const gates: Array<() => void> = [];
    w.verify.mockImplementation(async (id: string) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
      return identity(T0);
    });
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now: w.now });

    const done = monitor.refresh();
    for (let released = 0; released < 5; released += 1) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(released));
      gates[released]!();
    }
    await expect(done).resolves.toEqual({ read: ['a', 'b', 'c', 'd', 'e'], failed: [] });
    expect(most).toBe(2);
  });

  it('a plain refresh joins the run in flight; a forced one runs after it', async () => {
    const w = world([profile('a'), profile('b', T0 - 60_000)]);
    let release: (() => void) | undefined;
    w.verify.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return identity(T0);
    });
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now: w.now });

    const first = monitor.refresh();
    const joined = monitor.refresh();
    const forced = monitor.refresh({ force: true, profileIds: ['b'] });
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await expect(first).resolves.toEqual({ read: ['a'], failed: [] });
    await expect(joined).resolves.toEqual({ read: ['a'], failed: [] });
    await expect(forced).resolves.toEqual({ read: ['b'], failed: [] });
  });

  it('a registry that cannot be listed reads nothing and is reported', async () => {
    const w = world([profile('a')]);
    w.listProfiles.mockRejectedValueOnce(new Error('registry unreadable'));
    const onError = vi.fn();
    const monitor = createProfileIdentityMonitor({
      listProfiles: w.listProfiles,
      verify: w.verify,
      now: w.now,
      onError,
    });

    await expect(monitor.refresh()).resolves.toEqual({ read: [], failed: [] });
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(monitor.refresh()).resolves.toEqual({ read: ['a'], failed: [] });
  });

  it('started, it reads what is due at once and each sign-in again when its reading ages', async () => {
    vi.useFakeTimers({ now: T0 });
    const w = world([profile('aged', T0 - 2 * HOUR_MS), profile('recent', T0 - 45 * 60_000)]);
    const now = (): Date => new Date(Date.now());
    w.verify.mockImplementation(async (id: string) => {
      const read = identity(Date.now());
      w.profiles.set(id, { ...w.profiles.get(id)!, identity: read });
      return read;
    });
    const monitor = createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, now });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.asked()).toEqual(['aged']);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(w.asked()).toEqual(['aged', 'recent']);

    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(w.asked()).toEqual(['aged', 'recent', 'aged']);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(w.asked()).toEqual(['aged', 'recent', 'aged']);
  });

  it('refuses an interval that is not positive', () => {
    const w = world([]);
    expect(() =>
      createProfileIdentityMonitor({ listProfiles: w.listProfiles, verify: w.verify, refreshMs: 0 }),
    ).toThrow(RangeError);
  });
});
