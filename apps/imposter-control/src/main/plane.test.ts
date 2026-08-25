/**
 * The control plane: one socket for imposters, one loopback HTTP server for the
 * console, push instead of poll (draft/IMPOSTER.md §5).
 *
 * The imposter side is exercised through the REAL client, not a hand-rolled
 * stub, so the two halves of the protocol cannot drift apart in this suite.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectControl,
  ControlError,
  REFUSED,
  type ControlClientOptions,
  type ImposterControl,
} from '@vibecook/chopsticks-imposter/control';
import { loadConsoleUi } from './main.js';
import { createControlPlane, type ControlPlane, type ControlPlaneProjection } from './plane.js';
import { collectEvents, controlPaths, IDLE_SCENARIO_DRIVER, waitFor, type EventCollector } from './testing.js';

const NATIVE_BEHAVIOR: ControlClientOptions['nativeBehavior'] = {
  behaviorVersion: 1,
  title: 'Claude native hooks',
  lanes: [
    { id: 'session', label: 'Session' },
    { id: 'turn', label: 'Turn' },
  ],
  nodes: [
    {
      id: 'session-start',
      event: 'SessionStart',
      confidence: 'verified-headless',
      lane: 'session',
      order: 0,
    },
    {
      id: 'notification',
      event: 'Notification',
      confidence: 'verified-interactive',
      lane: 'turn',
      order: 1,
    },
  ],
  relations: [
    {
      from: 'session-start',
      to: 'notification',
      kind: 'async',
      confidence: 'verified-interactive',
    },
  ],
};

const NATIVE_EVENTS: ControlClientOptions['nativeEvents'] = [
  { event: 'SessionStart', fields: [], channel: 'hooks', channels: ['hooks'], confidence: 'verified-headless' },
  {
    event: 'Notification',
    fields: ['message'],
    channel: 'hooks',
    channels: ['hooks'],
    confidence: 'verified-interactive',
  },
];

const RUNFLOWS: NonNullable<ControlClientOptions['runflows']> = [
  {
    id: 'happy-turn',
    intent: 'turn.basic',
    scenario: 'happy-turn',
    title: 'Basic turn',
    summary: 'A basic executable turn.',
    kind: 'typical',
    danger: 'safe',
    tags: ['turn'],
    defaultStimulus: { text: 'hello' },
    defaultSpeed: 4,
    steps: 3,
    events: ['UserPromptSubmit', 'Stop'],
    channels: ['hook'],
    requiresClient: false,
  },
];

const planes: ControlPlane[] = [];
const clients: ImposterControl[] = [];
const collectors: EventCollector[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const collector of collectors.splice(0)) collector.close();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const plane of planes.splice(0)) await plane.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function startPlane(options: Parameters<typeof createControlPlane>[0] = {}): Promise<ControlPlane> {
  const paths = controlPaths();
  roots.push(paths.root);
  const plane = createControlPlane({ socketPath: paths.socketPath, tokenPath: paths.tokenPath, ...options });
  planes.push(plane);
  await plane.start();
  return plane;
}

interface FakeImposter {
  triggered: Array<[string, Record<string, unknown>]>;
  ops: Array<[string, Record<string, unknown>]>;
  control: ImposterControl;
}

async function joinAs(
  plane: ControlPlane,
  overrides: Partial<Parameters<typeof connectControl>[0]> = {},
): Promise<FakeImposter> {
  const triggered: FakeImposter['triggered'] = [];
  const ops: FakeImposter['ops'] = [];
  const control = await connectControl({
    vendor: 'claude',
    version: '2.1.207',
    sessionId: 'a0000000-0000-4000-8000-000000000001',
    cwd: '/work',
    nativeBehavior: NATIVE_BEHAVIOR,
    nativeEvents: NATIVE_EVENTS,
    ops: [{ op: 'turn.start', channels: ['hook'], events: ['UserPromptSubmit'], fields: ['text'] }],
    runflows: RUNFLOWS,
    channels: () => ['hook', 'transcript'],
    scenarioDriver: () => IDLE_SCENARIO_DRIVER,
    emitted: () => [{ at: '2026-08-07T00:00:00.000Z', sequence: 1, event: 'SessionStart' }],
    trigger: async (event, payload) => void triggered.push([event, payload]),
    runOp: async (op, argument) => void ops.push([op, argument]),
    runScenario: async () => {},
    scenarioControl: () => {},
    fault: async () => {},
    socketPath: plane.socketPath,
    tokenPath: plane.tokenPath,
    ...overrides,
  });
  expect(control).toBeDefined();
  clients.push(control!);
  return { triggered, ops, control: control! };
}

const get = (plane: ControlPlane, path: string): Promise<Response> =>
  fetch(`${plane.url}${path}`, { headers: { authorization: `Bearer ${plane.token}` } });

const post = (plane: ControlPlane, path: string, body: unknown): Promise<Response> =>
  fetch(`${plane.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plane.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sessionPath = (action: string) => `/api/sessions/a0000000-0000-4000-8000-000000000001/${action}?vendor=claude`;

describe('control plane', () => {
  it('serves the packaged console only to the token holder', async () => {
    const plane = await startPlane({
      uiHtml: loadConsoleUi(),
      uiAsset: (path) =>
        path === '/assets/renderer.js'
          ? {
              body: 'const template = "{TOKEN}"; console.log("{ASSET_TOKEN}")',
              contentType: 'text/javascript; charset=utf-8',
            }
          : undefined,
    });
    expect((await fetch(`${plane.url}/`)).status).toBe(401);
    expect((await fetch(`${plane.url}/assets/renderer.js`)).status).toBe(401);
    const response = await fetch(plane.consoleUrl);
    const html = await response.text();
    expect(html).toContain('<title>chopsticks — agent adaptation devkit</title>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('/assets/renderer.js');
    expect(html).toContain('/assets/renderer.css');
    expect(html).toContain(plane.token);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('content-security-policy')).not.toContain("script-src 'unsafe-inline'");
    const asset = await get(plane, '/assets/renderer.js');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await asset.text()).toBe(`const template = "{TOKEN}"; console.log("${plane.token}")`);
    expect(await (await get(plane, '/api/sessions')).json()).toEqual({ sessions: [] });
  });

  it('owns the socket and the token file for exactly as long as it runs', async () => {
    const plane = await startPlane();
    expect(readFileSync(plane.tokenPath, 'utf8')).toHaveLength(36);
    if (process.platform !== 'win32') expect(existsSync(plane.socketPath)).toBe(true);
    await plane.stop();
    planes.splice(planes.indexOf(plane), 1);
    expect(existsSync(plane.tokenPath)).toBe(false);
    if (process.platform !== 'win32') expect(existsSync(plane.socketPath)).toBe(false);
  });

  it('refuses to start when another plane is already answering', async () => {
    const plane = await startPlane();
    const second = createControlPlane({ socketPath: plane.socketPath, tokenPath: plane.tokenPath });
    await expect(second.start()).rejects.toThrow(/another imposter control plane/);
  });

  it('lists a joined session and pushes it to the console without being asked', async () => {
    const plane = await startPlane();
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    await joinAs(plane);

    await waitFor(() => (collector.latest('sessions')?.sessions as unknown[] | undefined)?.length === 1, 'push');
    expect((collector.latest('sessions')!.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({
      vendor: 'claude',
      version: '2.1.207',
      channels: ['hook', 'transcript'],
      nativeBehavior: { title: 'Claude native hooks' },
      nativeEvents: expect.arrayContaining([expect.objectContaining({ event: 'Notification', channel: 'hooks' })]),
      runflows: [expect.objectContaining({ id: 'happy-turn', intent: 'turn.basic', steps: 3 })],
      scenarioDriver: { state: 'ready' },
    });
    const listed = (await (await get(plane, '/api/sessions')).json()) as { sessions: unknown[] };
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).not.toHaveProperty('state');
    expect(listed.sessions[0]).not.toHaveProperty('machine');
  });

  it('turns a socket close into an immediate departure, with no prune anywhere', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');
    await imposter.control.close();
    await waitFor(() => plane.sessions.length === 0, 'departure');
  });

  it('rejects a hello that does not hold the socket token', async () => {
    const plane = await startPlane();
    const paths = controlPaths();
    roots.push(paths.root);
    // Same socket, wrong secret.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(paths.tokenPath, 'not-the-token');
    const control = await connectControl({
      vendor: 'claude',
      version: '2.1.207',
      sessionId: 'b0000000-0000-4000-8000-000000000002',
      cwd: '/work',
      nativeBehavior: NATIVE_BEHAVIOR,
      nativeEvents: NATIVE_EVENTS,
      ops: [],
      channels: () => ['hook'],
      scenarioDriver: () => IDLE_SCENARIO_DRIVER,
      emitted: () => [],
      trigger: async () => {},
      runOp: async () => {},
      runScenario: async () => {},
      scenarioControl: () => {},
      fault: async () => {},
      socketPath: plane.socketPath,
      tokenPath: paths.tokenPath,
    });
    expect(control).toBeUndefined();
    expect(plane.sessions).toHaveLength(0);
  });

  it('proxies a trigger over the socket to the imposter that owns the session', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    const ok = await post(plane, sessionPath('trigger'), { event: 'Notification', with: { message: 'hi' } });
    expect(ok.status).toBe(200);
    expect(imposter.triggered).toEqual([['Notification', { message: 'hi' }]]);
  });

  it('proxies an op and labels its result as portable scenario intent', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    const ok = await post(plane, sessionPath('op'), { op: 'turn.start', with: { text: 'hello' } });
    expect(ok.status).toBe(200);
    expect(imposter.ops).toEqual([['turn.start', { text: 'hello' }]]);
    // The reply carries the secondary driver view so the console settles
    // without confusing it with a native observation.
    expect((await ok.json()) as { scenarioDriver: unknown }).toMatchObject({
      scenarioDriver: { state: 'ready' },
    });
  });

  it('serves the portable scenario graph under an explicitly secondary name', async () => {
    const plane = await startPlane();
    const description = (await (await get(plane, '/api/scenario-driver')).json()) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ op: string }>;
      globals: Array<{ op: string }>;
    };
    expect(description.nodes.map((node) => node.id)).toContain('turn.approval');
    expect(description.edges.some((edge) => edge.op === 'permission.ask')).toBe(true);
    expect(description.globals.map((global) => global.op)).toContain('session.end');
  });

  it('pushes scenario intent separately and keeps the secondary view current', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    await waitFor(() => plane.sessions.length === 1, 'join');

    imposter.control.pushScenarioDriver({ ...IDLE_SCENARIO_DRIVER, state: 'turn.tool', applied: 5 });
    await waitFor(() => collector.latest('scenario-driver') !== undefined, 'scenario-driver push');
    expect(collector.latest('scenario-driver')).toMatchObject({
      scenarioDriver: { state: 'turn.tool', applied: 5 },
    });
    // A console that connects later must see the same thing without a replay.
    expect(plane.sessions[0]!.scenarioDriver.state).toBe('turn.tool');
  });

  it('pushes runflow progress separately and retains it for reconnecting consoles', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    await waitFor(() => plane.sessions.length === 1, 'join');

    imposter.control.pushScenarioRun({
      runId: 'run-1',
      runflowId: 'happy-turn',
      scenario: 'happy-turn',
      mode: 'step',
      status: 'paused',
      step: 1,
      steps: 3,
      fromSequence: 2,
    });
    await waitFor(() => collector.latest('scenario-run') !== undefined, 'scenario-run push');
    expect(collector.latest('scenario-run')).toMatchObject({
      scenarioRun: { runId: 'run-1', runflowId: 'happy-turn', status: 'paused', step: 1 },
    });
    expect(plane.sessions[0]!.scenarioRun).toMatchObject({ runId: 'run-1', status: 'paused' });
    const listed = (await (await get(plane, '/api/sessions')).json()) as { sessions: Array<Record<string, unknown>> };
    expect(listed.sessions[0]!.scenarioRun).toMatchObject({ runId: 'run-1', step: 1 });
  });

  it('reports an imposter that declines as 422, distinct from a transport failure', async () => {
    const plane = await startPlane();
    await joinAs(plane, {
      trigger: async () => {
        throw new ControlError(REFUSED, 'imposter refused an off-model payload');
      },
    });
    await waitFor(() => plane.sessions.length === 1, 'join');
    const refused = await post(plane, sessionPath('trigger'), { event: 'Notification', with: {} });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain('off-model');
  });

  it('refuses a second connection claiming a session id that is already live', async () => {
    const plane = await startPlane();
    await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');
    // Same vendor + session id: the plane keeps the incumbent, and the newcomer
    // falls back to standalone rather than silently taking the address over.
    const logs: string[] = [];
    const duplicate = await connectControl({
      vendor: 'claude',
      version: '2.1.207',
      sessionId: 'a0000000-0000-4000-8000-000000000001',
      cwd: '/work',
      nativeBehavior: NATIVE_BEHAVIOR,
      nativeEvents: NATIVE_EVENTS,
      ops: [],
      channels: () => ['hook'],
      scenarioDriver: () => IDLE_SCENARIO_DRIVER,
      emitted: () => [],
      trigger: async () => {},
      runOp: async () => {},
      runScenario: async () => {},
      scenarioControl: () => {},
      fault: async () => {},
      socketPath: plane.socketPath,
      tokenPath: plane.tokenPath,
      log: (message) => logs.push(message),
    });
    expect(duplicate).toBeUndefined();
    expect(logs.join(' ')).toContain('already connected');
    expect(plane.sessions).toHaveLength(1);
  });

  it('validates control params at the socket edge, not at the channel', async () => {
    const plane = await startPlane();
    await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');
    expect((await post(plane, sessionPath('scenario'), { name: 'a', script: [] })).status).toBe(400);
    expect((await post(plane, sessionPath('fault'), { kind: 'meltdown' })).status).toBe(400);
    expect((await post(plane, sessionPath('scenario-control'), { action: 'rewind' })).status).toBe(400);
  });

  it('answers for a session nobody has joined with a 404', async () => {
    const plane = await startPlane();
    expect((await post(plane, sessionPath('trigger'), { event: 'Notification' })).status).toBe(404);
  });

  it('streams emissions and channel changes as they happen', async () => {
    const plane = await startPlane();
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    imposter.control.pushEmitted({ at: '2026-08-07T00:00:01.000Z', sequence: 2, event: 'Notification' });
    await waitFor(() => collector.latest('emitted') !== undefined, 'emitted push');
    expect(collector.latest('emitted')).toMatchObject({
      vendor: 'claude',
      sessionId: 'a0000000-0000-4000-8000-000000000001',
      entry: { event: 'Notification', sequence: 2 },
    });

    imposter.control.pushChannels(['transcript']);
    await waitFor(() => plane.sessions[0]?.channels.join() === 'transcript', 'channel push');
  });

  it('composes projections downstream of native traffic with live suffixes and log backfill', async () => {
    const calls: string[] = [];
    const projection: ControlPlaneProjection = {
      id: 'test-view',
      join(session) {
        calls.push(`join:${session.sessionId}`);
      },
      ingest(_session, entry) {
        calls.push(`ingest:${entry.sequence}`);
        return { fromNativeSequence: entry.sequence, records: [entry.event] };
      },
      synchronize(_session, entries) {
        calls.push(`sync:${entries.map((entry) => entry.sequence).join(',')}`);
        return { records: entries.map((entry) => entry.event) };
      },
      snapshot() {
        return { records: [] };
      },
      leave(session) {
        calls.push(`leave:${session.sessionId}`);
      },
    };
    const plane = await startPlane({ projections: [projection] });
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    imposter.control.pushEmitted({
      at: '2026-08-07T00:00:01.000Z',
      sequence: 2,
      event: 'Notification',
      payload: { message: 'hi' },
    });
    await waitFor(() => collector.latest('projection-test-view') !== undefined, 'projection push');
    expect(collector.latest('projection-test-view')).toMatchObject({
      update: { fromNativeSequence: 2, records: ['Notification'] },
    });

    const snapshot = await get(
      plane,
      '/api/sessions/a0000000-0000-4000-8000-000000000001/projections/test-view?vendor=claude',
    );
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual({ records: ['SessionStart'] });
    expect(calls).toEqual(expect.arrayContaining(['join:a0000000-0000-4000-8000-000000000001', 'ingest:2', 'sync:1']));

    await imposter.control.close();
    await waitFor(() => calls.some((call) => call.startsWith('leave:')), 'projection leave');
  });

  it('keeps slow and unserializable projection work off the native socket path', async () => {
    const logs: string[] = [];
    let started!: () => void;
    let release!: () => void;
    const ingestStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let cyclicSnapshots = false;
    const cyclic = (): Record<string, unknown> => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    };
    const projection: ControlPlaneProjection = {
      id: 'slow-view',
      join() {},
      async ingest() {
        started();
        await gate;
        return cyclic();
      },
      synchronize() {
        return cyclicSnapshots ? cyclic() : { ok: true };
      },
      snapshot() {
        return { ok: true };
      },
      leave() {},
    };
    const plane = await startPlane({ projections: [projection], log: (message) => logs.push(message) });
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    imposter.control.pushEmitted({
      at: '2026-08-07T00:00:01.000Z',
      sequence: 2,
      event: 'Notification',
    });
    await ingestStarted;
    imposter.control.pushChannels(['transcript']);
    await waitFor(() => plane.sessions[0]?.channels.join() === 'transcript', 'native channel while projection waits');

    release();
    await waitFor(() => logs.some((message) => message.includes('could not be published')), 'serialization isolation');

    cyclicSnapshots = true;
    const snapshot = await get(
      plane,
      '/api/sessions/a0000000-0000-4000-8000-000000000001/projections/slow-view?vendor=claude',
    );
    expect(snapshot.status).toBe(502);
    expect(await snapshot.json()).toMatchObject({ error: expect.stringMatching(/circular/i) });
    expect(plane.sessions).toHaveLength(1);
  });

  it('reconciles both a dropped tail and an observed sequence gap from the authoritative log', async () => {
    const nativeLog: Array<{ at: string; sequence: number; event: string }> = [
      { at: '2026-08-07T00:00:00.000Z', sequence: 1, event: 'SessionStart' },
    ];
    const synchronized: number[][] = [];
    const projection: ControlPlaneProjection = {
      id: 'gap-view',
      join() {},
      ingest(_session, entry) {
        return { sequence: entry.sequence };
      },
      synchronize(_session, entries) {
        synchronized.push(entries.map((entry) => entry.sequence));
        return { sequences: entries.map((entry) => entry.sequence) };
      },
      snapshot() {
        return { sequences: [] };
      },
      leave() {},
    };
    const plane = await startPlane({ projections: [projection] });
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    const imposter = await joinAs(plane, { emitted: () => nativeLog });
    await waitFor(() => synchronized.some((entries) => entries.join() === '1'), 'initial projection sync');

    const second = { at: '2026-08-07T00:00:01.000Z', sequence: 2, event: 'Notification' };
    nativeLog.push(second);
    imposter.control.pushEmitted(second);
    // No live push for #3: the trailing burst reconciliation must still find it.
    nativeLog.push({ at: '2026-08-07T00:00:02.000Z', sequence: 3, event: 'Notification' });
    await waitFor(() => synchronized.some((entries) => entries.join() === '1,2,3'), 'quiet tail reconciliation');

    // No live push for #4 either. Receiving #5 exposes the gap immediately,
    // before the trailing reconciliation timer is involved.
    nativeLog.push(
      { at: '2026-08-07T00:00:03.000Z', sequence: 4, event: 'Notification' },
      { at: '2026-08-07T00:00:04.000Z', sequence: 5, event: 'Notification' },
    );
    imposter.control.pushEmitted(nativeLog.at(-1)!);
    await waitFor(() => synchronized.some((entries) => entries.join() === '1,2,3,4,5'), 'gap reconciliation');
    await waitFor(
      () => collector.events.some((event) => event.event === 'native-snapshot' && event.data.reason === 'gap'),
      'gap snapshot',
    );
  });

  it('reconciles an unpushed tail before acknowledging graceful goodbye', async () => {
    const nativeLog: Array<{ at: string; sequence: number; event: string }> = [
      { at: '2026-08-07T00:00:00.000Z', sequence: 1, event: 'SessionStart' },
    ];
    const synchronized: number[][] = [];
    const projection: ControlPlaneProjection = {
      id: 'goodbye-view',
      join() {},
      ingest() {},
      synchronize(_session, entries) {
        synchronized.push(entries.map((entry) => entry.sequence));
        return { sequences: entries.map((entry) => entry.sequence) };
      },
      snapshot() {
        return { sequences: [] };
      },
      leave() {},
    };
    const plane = await startPlane({ projections: [projection] });
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    const imposter = await joinAs(plane, { emitted: () => nativeLog });
    await waitFor(() => synchronized.some((entries) => entries.join() === '1'), 'initial projection sync');

    nativeLog.push({ at: '2026-08-07T00:00:01.000Z', sequence: 2, event: 'Notification' });
    await imposter.control.close('test-complete');

    expect(synchronized.some((entries) => entries.join() === '1,2')).toBe(true);
    await waitFor(
      () =>
        collector.events.some(
          (event) =>
            event.event === 'native-snapshot' &&
            event.data.reason === 'goodbye' &&
            (event.data.entries as Array<{ sequence: number }>).at(-1)?.sequence === 2,
        ),
      'goodbye snapshot',
    );
    expect(
      collector.events.find(
        (event) =>
          event.event === 'native-snapshot' &&
          event.data.reason === 'goodbye' &&
          (event.data.entries as Array<{ sequence: number }>).at(-1)?.sequence === 2,
      ),
    ).toBeDefined();
  });

  it('reconciles an unpushed runflow tail at the terminal run boundary', async () => {
    const nativeLog: Array<{ at: string; sequence: number; event: string }> = [
      { at: '2026-08-07T00:00:00.000Z', sequence: 1, event: 'SessionStart' },
    ];
    const synchronized: number[][] = [];
    const projection: ControlPlaneProjection = {
      id: 'runflow-view',
      join() {},
      ingest() {},
      synchronize(_session, entries) {
        synchronized.push(entries.map((entry) => entry.sequence));
        return { sequences: entries.map((entry) => entry.sequence) };
      },
      snapshot() {
        return { sequences: [] };
      },
      leave() {},
    };
    const plane = await startPlane({ projections: [projection] });
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    const imposter = await joinAs(plane, { emitted: () => nativeLog });
    await waitFor(() => synchronized.some((entries) => entries.join() === '1'), 'initial runflow sync');

    nativeLog.push({ at: '2026-08-07T00:00:01.000Z', sequence: 2, event: 'Notification' });
    imposter.control.pushScenarioRun({
      runId: 'run-tail',
      runflowId: 'happy-turn',
      scenario: 'happy-turn',
      mode: 'play',
      status: 'completed',
      step: 3,
      steps: 3,
      fromSequence: 2,
      throughSequence: 2,
    });

    await waitFor(() => synchronized.some((entries) => entries.join() === '1,2'), 'terminal runflow reconciliation');
    await waitFor(
      () => collector.events.some((event) => event.event === 'native-snapshot' && event.data.reason === 'scenario'),
      'runflow native snapshot',
    );
  });
});
