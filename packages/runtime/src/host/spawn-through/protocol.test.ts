import { describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_BYTES,
  parseSpawnThroughRequest,
  parseSpawnThroughResponse,
  type SpawnThroughExecFailedRequest,
  type SpawnThroughLaunchRequest,
  type SpawnThroughResponse,
} from './protocol.js';

function launch(overrides: Record<string, unknown> = {}): SpawnThroughLaunchRequest {
  return {
    type: 'launch',
    token: 'secret',
    providerId: 'example',
    cwd: '/repo',
    argv: ['--resume', 'native-1'],
    environment: { EXAMPLE_HOME: '/profiles/example' },
    pid: 456,
    parentPid: 123,
    interactive: true,
    ...overrides,
  } as SpawnThroughLaunchRequest;
}

function execFailed(overrides: Record<string, unknown> = {}): SpawnThroughExecFailedRequest {
  return { type: 'exec-failed', token: 'secret', preparationId: 'p-1', message: 'boom', ...overrides } as never;
}

const overlong = 'x'.repeat(8_193);

describe('spawn-through protocol', () => {
  it('round-trips both request types through their wire form', () => {
    for (const request of [
      launch(),
      launch({ imposter: true }),
      launch({ interactive: false }),
      execFailed(),
      execFailed({ message: '' }),
    ]) {
      expect(parseSpawnThroughRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    }
    // `imposter: false` is the default, so it is not carried.
    expect(parseSpawnThroughRequest(launch({ imposter: false }))).toEqual(launch());
    expect(MAX_REQUEST_BYTES).toBe(64 * 1024);
  });

  it('reads a launch without `interactive` — a shim from before it — as interactive, and only a boolean as either', () => {
    const { interactive: _interactive, ...older } = launch();
    expect(parseSpawnThroughRequest(older)).toEqual(launch({ interactive: true }));
    for (const interactive of ['false', 0, 1, null]) {
      expect(parseSpawnThroughRequest(launch({ interactive })), String(interactive)).toBeUndefined();
    }
    expect(parseSpawnThroughRequest(execFailed({ interactive: true }))).toBeUndefined();
  });

  it('refuses anything that is not a request object with a bounded token', () => {
    for (const value of [null, 'launch', 42, [launch()], {}]) expect(parseSpawnThroughRequest(value)).toBeUndefined();
    for (const token of [undefined, '', 7, 'x'.repeat(257)]) {
      expect(parseSpawnThroughRequest(launch({ token }))).toBeUndefined();
      expect(parseSpawnThroughRequest(execFailed({ token }))).toBeUndefined();
    }
    expect(parseSpawnThroughRequest(launch({ token: 'x'.repeat(256) }))).toBeDefined();
    expect(parseSpawnThroughRequest(launch({ type: 'spawn' }))).toBeUndefined();
    expect(parseSpawnThroughRequest(launch({ type: undefined }))).toBeUndefined();
  });

  it('refuses an unknown key on either request type', () => {
    expect(parseSpawnThroughRequest(launch({ providerSpecificOption: true }))).toBeUndefined();
    expect(parseSpawnThroughRequest(launch({ implementation: { kind: 'native' } }))).toBeUndefined();
    expect(parseSpawnThroughRequest(execFailed({ pid: 456 }))).toBeUndefined();
  });

  it('refuses a process identity that is not a positive safe integer', () => {
    for (const pid of [undefined, 0, -1, 1.5, '456', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseSpawnThroughRequest(launch({ pid }))).toBeUndefined();
      expect(parseSpawnThroughRequest(launch({ parentPid: pid }))).toBeUndefined();
    }
    expect(parseSpawnThroughRequest(launch({ imposter: 'yes' }))).toBeUndefined();
  });

  it('holds the intent to the Core schema', () => {
    for (const overrides of [
      { providerId: '' },
      { providerId: '../example' },
      { cwd: '' },
      { cwd: overlong },
      { argv: 'one two' },
      { argv: [7] },
      { argv: [overlong] },
      { argv: Array.from({ length: 257 }, () => 'x') },
      { environment: { 'NOT VALID': 'x' } },
      { environment: { EXAMPLE_HOME: overlong } },
      { environment: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`NAME_${index}`, 'x'])) },
    ]) {
      expect(parseSpawnThroughRequest(launch(overrides)), JSON.stringify(overrides).slice(0, 80)).toBeUndefined();
    }
  });

  it('bounds the exec-failed fields', () => {
    expect(parseSpawnThroughRequest(execFailed({ preparationId: '' }))).toBeUndefined();
    expect(parseSpawnThroughRequest(execFailed({ preparationId: overlong }))).toBeUndefined();
    expect(parseSpawnThroughRequest(execFailed({ message: overlong }))).toBeUndefined();
    expect(parseSpawnThroughRequest(execFailed({ message: 7 }))).toBeUndefined();
  });

  it('reads each answer the shim acts on, and nothing it cannot act on', () => {
    const answers: SpawnThroughResponse[] = [
      { action: 'exec', preparationId: 'p-1', launch: { command: '/managed', args: ['--a'], cwd: '/repo' } },
      {
        action: 'exec',
        preparationId: 'p-1',
        launch: { command: '/managed', args: [], cwd: '/repo', env: { TOKEN: 'x' } },
      },
      { action: 'fallback', reason: 'not managed' },
      { action: 'refuse', reason: 'rejected', message: 'the gateway refused' },
      { action: 'ack' },
    ];
    for (const answer of answers) expect(parseSpawnThroughResponse(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
    // A newer gateway's extra keys are ignored; the recipe keeps only what the shim execs.
    expect(
      parseSpawnThroughResponse({
        action: 'exec',
        preparationId: 'p-1',
        launch: { command: '/managed', args: [], cwd: '/repo', cols: 80 },
        extra: true,
      }),
    ).toEqual({ action: 'exec', preparationId: 'p-1', launch: { command: '/managed', args: [], cwd: '/repo' } });
    for (const value of [
      null,
      { action: 'run' },
      { action: 'exec', preparationId: 'p-1' },
      { action: 'exec', launch: { command: '/managed', args: [], cwd: '/repo' } },
      { action: 'exec', preparationId: 'p-1', launch: { command: '', args: [], cwd: '/repo' } },
      { action: 'exec', preparationId: 'p-1', launch: { command: '/managed', args: '--a', cwd: '/repo' } },
      { action: 'exec', preparationId: 'p-1', launch: { command: '/managed', args: [1], cwd: '/repo' } },
      { action: 'exec', preparationId: 'p-1', launch: { command: '/managed', args: [], cwd: '/repo', env: { A: 1 } } },
      { action: 'fallback' },
      { action: 'refuse', reason: 'rejected' },
    ]) {
      expect(parseSpawnThroughResponse(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
