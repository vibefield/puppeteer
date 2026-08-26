/**
 * The pre-normalization Control flow, over one socket (docs/archive/EMULATOR.md §6.4,
 * docs/archive/IMPOSTER.md §5).
 *
 * A real driver spawns `ai`, the Imposter dials the plane, and controls issued
 * at the HTTP edge travel console → socket → Imposter → native channel. The
 * assertion boundary is the Imposter's raw emission log: no adapter or Core
 * reducer participates in this app-level suite.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from './plane.js';
import { createPersonaSpawner } from './spawner.js';
import { controlPaths, waitFor } from './testing.js';

let plane: ControlPlane;
let spawner: ReturnType<typeof createPersonaSpawner> | undefined;
const tmps: string[] = [];

beforeEach(async () => {
  const paths = controlPaths();
  tmps.push(paths.root);
  spawner = createPersonaSpawner('claude', 'Claude native surface', {
    controlSocketPath: paths.socketPath,
    controlTokenPath: paths.tokenPath,
  });
  plane = createControlPlane({ socketPath: paths.socketPath, tokenPath: paths.tokenPath });
  await plane.start();
});

afterEach(async () => {
  await spawner?.disposeAll();
  spawner = undefined;
  await plane.stop();
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const planeApi = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${plane.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${plane.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function spawnImposterSession(): Promise<string> {
  const { sessionId } = await spawner!.spawn();
  await waitFor(() => plane.sessions.some((session) => session.sessionId === sessionId), 'session join');
  await waitFor(
    () => plane.sessions.find((session) => session.sessionId === sessionId)?.scenarioDriver.state === 'ready',
    'scenario driver boot',
  );
  return sessionId;
}

const logFor = (sessionId: string): Promise<Array<{ event: string; payload?: Record<string, unknown> }>> =>
  planeApi(`/api/sessions/${sessionId}/log?vendor=claude`)
    .then(
      (response) =>
        response.json() as Promise<{ entries: Array<{ event: string; payload?: Record<string, unknown> }> }>,
    )
    .then((body) => body.entries);

/**
 * SKIPPED ON WINDOWS, and the gap is real rather than cosmetic.
 *
 * These are the tests that spawn `ai` and wait for it to dial back into the
 * control plane. The in-process plane suite still runs on Windows; spawned
 * named-pipe discovery remains unverified there (docs/archive/IMPOSTER.md §11.4).
 */
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('emulator native control channel', () => {
  it('joins with a native Surface, accepts raw traffic, and leaves on process death', async () => {
    const sessionId = await spawnImposterSession();
    const joined = plane.sessions.find((session) => session.sessionId === sessionId)!;

    expect(joined.nativeBehavior.nodes.map((node) => node.event)).toContain('PreCompact');
    expect(joined.nativeBehavior.nodes.map((node) => node.event)).toContain('TeammateIdle');
    expect(joined.nativeEvents.length).toBeGreaterThan(0);
    expect(joined.runflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'deep-research', intent: 'workflow.research.deep', steps: 30 }),
      ]),
    );
    expect(joined).not.toHaveProperty('state');

    const trigger = await planeApi(`/api/sessions/${sessionId}/trigger?vendor=claude`, {
      event: 'Notification',
      with: {
        message: 'hello from the control center',
        notification_type: 'emulator',
        prompt_id: crypto.randomUUID(),
      },
    });
    expect(trigger.status).toBe(200);
    await waitFor(
      async () => (await logFor(sessionId)).some((entry) => entry.event === 'Notification'),
      'native event',
    );
    expect((await logFor(sessionId)).find((entry) => entry.event === 'Notification')?.payload).toMatchObject({
      message: 'hello from the control center',
      notification_type: 'emulator',
    });

    // Unknown names still travel a known hook transport, preserving future
    // vendor traffic without inventing a normalized interpretation (ADR-008).
    const future = await planeApi(`/api/sessions/${sessionId}/trigger?vendor=claude`, {
      event: 'FutureHookEvent',
      with: { future_field: 'preserve me' },
    });
    expect(future.status).toBe(200);
    expect((await logFor(sessionId)).find((entry) => entry.event === 'FutureHookEvent')?.payload).toMatchObject({
      future_field: 'preserve me',
    });

    await spawner!.disposeAll();
    await waitFor(() => plane.sessions.length === 0, 'departure');
  });

  it('runs a named scenario paused and releases native events one step at a time', async () => {
    const sessionId = await spawnImposterSession();
    const before = (await logFor(sessionId)).length;

    const started = await planeApi(`/api/sessions/${sessionId}/scenario?vendor=claude`, {
      name: 'deep-research',
      runflowId: 'deep-research',
      mode: 'pause',
      speed: 100,
      stimulus: { text: 'from the control center' },
    });
    expect(started.status).toBe(200);
    await waitFor(
      () => plane.sessions.find((session) => session.sessionId === sessionId)?.scenarioRun?.status === 'paused',
      'paused runflow status',
    );
    expect(plane.sessions.find((session) => session.sessionId === sessionId)?.scenarioRun).toMatchObject({
      runflowId: 'deep-research',
      step: 0,
      steps: 30,
      fromSequence: before + 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await logFor(sessionId)).toHaveLength(before);

    await planeApi(`/api/sessions/${sessionId}/scenario-control?vendor=claude`, { action: 'step' });
    await waitFor(async () => (await logFor(sessionId)).length === before + 1, 'one released native event');
    await waitFor(
      () => plane.sessions.find((session) => session.sessionId === sessionId)?.scenarioRun?.step === 1,
      'one reported runflow step',
    );

    await planeApi(`/api/sessions/${sessionId}/scenario-control?vendor=claude`, { action: 'resume' });
    await waitFor(async () => (await logFor(sessionId)).length > before + 1, 'the rest of the native scenario');
    await waitFor(
      () => plane.sessions.find((session) => session.sessionId === sessionId)?.scenarioRun?.status === 'completed',
      'completed runflow status',
    );
    const completed = plane.sessions.find((session) => session.sessionId === sessionId)?.scenarioRun;
    expect(completed).toMatchObject({ step: 30 });
    expect(completed?.throughSequence).toBeGreaterThan(before + 1);
  });

  it('replays a Godview-style recorded hook scenario against the imposter session envelope', async () => {
    const sessionId = await spawnImposterSession();
    const response = await planeApi(`/api/sessions/${sessionId}/scenario?vendor=claude`, {
      script: {
        name: 'recorded-real-turn',
        recording: { version: 1, vendor: 'claude', source: 'godview-real-session' },
        steps: [
          {
            at: 0,
            do: {
              emit: {
                channel: 'hook',
                event: 'Notification',
                with: { message: 'captured from real Claude', notification_type: 'recorded' },
              },
            },
          },
        ],
      },
      mode: 'play',
    });

    expect(response.status).toBe(200);
    const replayed = (await logFor(sessionId)).find(
      (entry) => entry.event === 'Notification' && entry.payload?.notification_type === 'recorded',
    );
    expect(replayed?.payload).toMatchObject({
      session_id: sessionId,
      message: 'captured from real Claude',
      notification_type: 'recorded',
    });
    expect(replayed?.payload?.transcript_path).not.toBe('/private/real.jsonl');
    expect(replayed?.payload?.cwd).not.toBe('/private/real-repo');
  });

  it('refuses an off-model payload at the native Surface boundary', async () => {
    const sessionId = await spawnImposterSession();
    const refused = await planeApi(`/api/sessions/${sessionId}/trigger?vendor=claude`, {
      event: 'Notification',
      with: { message: 42 },
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toMatch(/message/);
  });
});
