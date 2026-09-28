import { describe, expect, it } from 'vitest';
import {
  MAX_REFUSAL_MESSAGE_LENGTH,
  MAX_REQUEST_BYTES,
  SPAWN_THROUGH_DECLINE_CODES,
  boundSpawnThroughText,
  declineSpawnThrough,
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
    command: 'example',
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

  it("carries the typed command's name when it is one a launcher could have, and never needs it", () => {
    const { command: _command, ...older } = launch();
    expect(parseSpawnThroughRequest(older)).toEqual(older);
    expect(parseSpawnThroughRequest(launch({ command: 'ai' }))).toEqual(launch({ command: 'ai' }));
    for (const command of ['', ' example', 'ex ample', '-x', 'a\u001b[2J', 'x'.repeat(129), 7]) {
      expect(parseSpawnThroughRequest(launch({ command })), JSON.stringify(command)).toBeUndefined();
    }
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
      { action: 'fallback', code: 'passthrough', reason: 'not managed' },
      { action: 'refuse', code: 'rejected-argument', reason: 'rejected', message: 'the gateway refused' },
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
      { action: 'fallback', code: 'passthrough' },
      // A decline carries its code: without one, or with one the kit never wrote, it is not an answer.
      { action: 'fallback', reason: 'not managed' },
      { action: 'fallback', code: 'because', reason: 'not managed' },
      { action: 'refuse', code: 'rejected-argument', reason: 'rejected' },
      { action: 'refuse', reason: 'rejected', message: 'the gateway refused' },
    ]) {
      expect(parseSpawnThroughResponse(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('declines with a code: a fallback, or a refusal whose words are bounded and never empty', () => {
    const decline = { code: 'rejected-argument', reason: 'cannot carry --bare' } as const;
    expect(declineSpawnThrough(decline)).toEqual({ action: 'fallback', ...decline });
    expect(declineSpawnThrough(decline, { message: 'refused here\nrun it elsewhere' })).toEqual({
      action: 'refuse',
      ...decline,
      message: 'refused here\nrun it elsewhere',
    });
    const kitSentence = 'not started, because it could not be run as a managed session: cannot carry --bare';
    for (const message of [undefined, '', ' \u001b\n\t ']) {
      expect(declineSpawnThrough(decline, { message })).toEqual({ action: 'refuse', ...decline, message: kitSentence });
    }
    expect(new Set(SPAWN_THROUGH_DECLINE_CODES).size).toBe(SPAWN_THROUGH_DECLINE_CODES.length);
  });

  it('bounds text for a terminal: printable characters, two lines, a length', () => {
    expect(boundSpawnThroughText('plain words')).toBe('plain words');
    // C0 and C1 controls, DEL, bidirectional overrides and the Unicode line separators become spaces.
    expect(boundSpawnThroughText('a\u001b[2Jb\u0007c\u007fd\u009be‮f⁦g h i')).toBe('a [2Jb c d e f g h i');
    expect(boundSpawnThroughText('\n  one  \r\n\r\n  two \n three\rfour  ')).toBe('one\ntwo three four');
    expect(boundSpawnThroughText('\u0000 \t\n')).toBe('');
    const bounded = boundSpawnThroughText(`${'é'.repeat(MAX_REFUSAL_MESSAGE_LENGTH)}\n${'🙂'.repeat(10)}`);
    expect(Array.from(bounded)).toHaveLength(MAX_REFUSAL_MESSAGE_LENGTH);
    expect(bounded.endsWith('é…')).toBe(true);
    // A cut never splits a character in two.
    expect(Array.from(boundSpawnThroughText('🙂'.repeat(MAX_REFUSAL_MESSAGE_LENGTH + 1))).at(-2)).toBe('🙂');
  });
});
