import { describe, expect, it, vi } from 'vitest';
import type { AgentLaunchProvider, AgentNativeInvocation } from '@vibecook/puppeteer-core';
import type { ClassifyAgentInvocationResult } from '../../types.js';
import { prepareSpawnThroughLaunch, type SpawnThroughHost, type SpawnThroughRefusal } from './prepare.js';
import {
  MAX_REFUSAL_MESSAGE_LENGTH,
  type SpawnThroughDeclineCode,
  type SpawnThroughLaunchRequest,
} from './protocol.js';

const provider = {
  id: 'example',
  label: 'Example',
  resume: true,
  nativeInvocation: {
    commands: [{ name: 'example', executable: '/real/example' }],
    environmentVariables: ['EXAMPLE_HOME'],
    imposter: { state: 'isolated-root' },
  },
} satisfies AgentLaunchProvider;

/** Native invocation, and no imposter route. */
const bare = {
  id: 'bare',
  label: 'Bare',
  resume: false,
  nativeInvocation: { commands: [{ name: 'bare', executable: '/real/bare' }], environmentVariables: [] },
} satisfies AgentLaunchProvider;

const plain = { id: 'plain', label: 'Plain', resume: false } satisfies AgentLaunchProvider;

function launch(overrides: Partial<SpawnThroughLaunchRequest> = {}): SpawnThroughLaunchRequest {
  return {
    type: 'launch',
    token: 'secret',
    providerId: 'example',
    cwd: '/repo',
    argv: [],
    environment: {},
    pid: 456,
    parentPid: 123,
    command: 'example',
    interactive: true,
    ...overrides,
  };
}

const recipe = { command: '/managed/example', args: ['--managed'], cwd: '/repo', env: { INGRESS_TOKEN: 'x' } };

const UNSUPPORTED = {
  status: 'unsupported',
  code: 'NATIVE_INVOCATION_UNSUPPORTED',
  reason: 'agent provider does not support native terminal invocation',
} as const satisfies ClassifyAgentInvocationResult;

interface Script {
  host?: Partial<SpawnThroughHost>;
  /** Replacements for the runtime's calls, recorded under the same names as the defaults. */
  runtime?: Partial<Record<'launchProviders' | 'prepareInvocation' | 'adoptPrepared', () => unknown>>;
  /** The adapter's grammar for a provider the runtime offers native invocation for. */
  grammar?: ClassifyAgentInvocationResult;
  /** The host's answer to which of its terminals holds the process. */
  terminal?: { terminalSessionId: string } | undefined;
}

/** A runtime and a host scripted to succeed, recording the order in which the kit's calls arrive. */
function scripted(script: Script = {}) {
  const { host: hostOverrides = {}, runtime: overrides = {}, grammar } = script;
  const terminal = 'terminal' in script ? script.terminal : { terminalSessionId: 'terminal-1' };
  const calls: string[] = [];
  const answers = {
    prepareInvocation: async () => ({ preparationId: 'preparation-1', runtimeRunId: 'run-1', launch: recipe }),
    adoptPrepared: async () => ({ runtimeRunId: 'run-1', terminalSessionId: 'terminal-1', processId: 456 }),
    ...overrides,
  };
  const runtime = {
    launchProviders: vi.fn(overrides.launchProviders ?? (() => [provider, bare, plain])),
    // As the runtime does: the adapter's word for a provider it offers native invocation for, `unsupported` else.
    classifyInvocation: vi.fn((invocation: AgentNativeInvocation): ClassifyAgentInvocationResult => {
      calls.push('classify');
      const offered = [provider, bare].some((candidate) => candidate.id === invocation.providerId);
      return offered ? (grammar ?? { status: 'accepted' }) : UNSUPPORTED;
    }),
    prepareInvocation: vi.fn(() => {
      calls.push('prepare');
      return answers.prepareInvocation();
    }),
    adoptPrepared: vi.fn(() => {
      calls.push('adopt');
      return answers.adoptPrepared();
    }),
    cancelPrepared: vi.fn(async () => {
      calls.push('cancel');
      return { cancelled: true };
    }),
  };
  const host = {
    runtime: runtime as never,
    resolveTerminal: vi.fn(async () => {
      calls.push('resolve');
      return terminal;
    }),
    onAdopted: vi.fn(async () => {
      calls.push('adopted');
    }),
    ...hostOverrides,
  } satisfies SpawnThroughHost;
  return { calls, runtime, host };
}

/** Every refusal the kit answers is placed: the rule refuses only once the host resolved the terminal. */
const refusal = (code: SpawnThroughDeclineCode, reason: string, message = defaultSentence(reason)) => ({
  action: 'refuse',
  code,
  reason,
  message,
  placed: true,
});
const defaultSentence = (reason: string) => `not started, because it could not be run as a managed session: ${reason}`;

describe('prepareSpawnThroughLaunch', () => {
  it('classifies, resolves the terminal, prepares, adopts, records — in that order — and answers exec', async () => {
    const { calls, runtime, host } = scripted();
    const result = await prepareSpawnThroughLaunch(
      launch({ argv: ['--resume', 'native-1'], environment: { EXAMPLE_HOME: '/profiles/example' } }),
      host,
    );

    expect(calls).toEqual(['classify', 'resolve', 'prepare', 'adopt', 'adopted']);
    expect(runtime.classifyInvocation).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: '/repo',
      argv: ['--resume', 'native-1'],
      environment: { EXAMPLE_HOME: '/profiles/example' },
      implementation: { kind: 'native' },
    });
    expect(host.resolveTerminal).toHaveBeenCalledWith({ pid: 456, parentPid: 123 });
    expect(runtime.prepareInvocation).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: '/repo',
      argv: ['--resume', 'native-1'],
      environment: { EXAMPLE_HOME: '/profiles/example' },
      implementation: { kind: 'native' },
    });
    expect(runtime.adoptPrepared).toHaveBeenCalledWith('preparation-1', {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      processId: 456,
    });
    expect(host.onAdopted).toHaveBeenCalledWith({
      info: { runtimeRunId: 'run-1', terminalSessionId: 'terminal-1', processId: 456 },
      terminalSessionId: 'terminal-1',
      processId: 456,
      preparationId: 'preparation-1',
    });
    expect(result).toEqual({ action: 'exec', preparationId: 'preparation-1', launch: recipe });
  });

  it("hands the host's launch options to the preparation, and never lets them override the intent", async () => {
    const onBound = vi.fn();
    const launchOptions = vi.fn(() => ({
      title: 'typed',
      creationRequestId: 'typed-run-1',
      externalRefs: [{ namespace: 'host', kind: 'caller', id: 'pane-1' }],
      ingress: { token: 'pinned', onBound },
      // Not launch options: a host cannot rewrite what the person typed, nor slip the preparation anything else.
      providerId: 'plain',
      argv: ['--other'],
      implementation: { kind: 'imposter', executable: '/elsewhere' },
      agentOptions: { model: 'chosen-by-host' },
    }));
    const { runtime, host } = scripted({ host: { launchOptions: launchOptions as never } });
    await prepareSpawnThroughLaunch(launch({ argv: ['--typed'] }), host);

    expect(launchOptions).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: '/repo',
      argv: ['--typed'],
      environment: {},
    });
    expect(runtime.prepareInvocation).toHaveBeenCalledWith({
      title: 'typed',
      creationRequestId: 'typed-run-1',
      externalRefs: [{ namespace: 'host', kind: 'caller', id: 'pane-1' }],
      ingress: { token: 'pinned', onBound },
      providerId: 'example',
      cwd: '/repo',
      argv: ['--typed'],
      environment: {},
      implementation: { kind: 'native' },
    });
  });

  it('classifies the grammar alone, then prepares a descriptor-requested imposter root without knowing the provider', async () => {
    const { runtime, host } = scripted({
      host: { imposterBin: () => '/opt/ai', imposterStateRoot: (providerId) => `/state/${providerId}` },
    });
    await expect(prepareSpawnThroughLaunch(launch({ imposter: true }), host)).resolves.toMatchObject({
      action: 'exec',
    });
    expect(runtime.classifyInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ implementation: { kind: 'native' } }),
    );
    expect(runtime.prepareInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: '/state/example' },
      }),
    );
  });

  it('cancels a preparation no terminal adopted, and records nothing', async () => {
    const { calls, runtime, host } = scripted({
      runtime: {
        adoptPrepared: async () => ({ error: { code: 'PREPARATION_ADOPT_FAILED', message: 'terminal is busy' } }),
      },
    });
    await expect(prepareSpawnThroughLaunch(launch(), host)).resolves.toEqual({
      action: 'fallback',
      code: 'adopt-failed',
      reason: 'terminal is busy',
    });
    expect(runtime.cancelPrepared).toHaveBeenCalledWith('preparation-1');
    expect(host.onAdopted).not.toHaveBeenCalled();
    expect(calls).toEqual(['classify', 'resolve', 'prepare', 'adopt', 'cancel']);
  });

  describe('the rule of refusal: a strict host refuses only a session, interactive, in a terminal it owns', () => {
    const NOWHERE = { terminal: undefined };
    const cases: (Script & {
      name: string;
      request?: Partial<SpawnThroughLaunchRequest>;
      code: SpawnThroughDeclineCode;
      reason: string;
      reached: string[];
      /** What a strict host answers. A host that is not strict falls back, always. */
      strict: 'refuse' | 'fallback';
    })[] = [
      // 1. The request: nothing to place, so nothing to refuse.
      {
        name: 'an invalid pid',
        request: { pid: 0 },
        code: 'invalid-request',
        reason: 'invalid process identity',
        reached: [],
        strict: 'fallback',
      },
      {
        name: 'an invalid intent',
        request: { cwd: '' },
        code: 'invalid-request',
        reason: 'invalid launch request',
        reached: [],
        strict: 'fallback',
      },
      // 2. What it is: not a session, or not interactive — never a terminal lookup, never refused.
      ...(['utility', 'one-shot', 'elsewhere'] as const).map((kind) => ({
        name: `a ${kind} passthrough`,
        grammar: { status: 'passthrough', kind, reason: `a ${kind} invocation` } as const,
        code: 'passthrough' as const,
        reason: `a ${kind} invocation`,
        reached: ['classify'],
        strict: 'fallback' as const,
      })),
      {
        name: 'an accepted grammar whose input or output is not a terminal',
        request: { interactive: false },
        code: 'not-interactive',
        reason: 'its input or output is not a terminal: a one-shot run',
        reached: ['classify'],
        strict: 'fallback',
      },
      {
        name: 'a rejected grammar whose input or output is not a terminal',
        request: { interactive: false },
        grammar: { status: 'rejected', reason: 'cannot carry it', argument: '--other' },
        code: 'not-interactive',
        reason: 'its input or output is not a terminal: a one-shot run',
        reached: ['classify'],
        strict: 'fallback',
      },
      {
        name: 'an unknown provider whose input or output is not a terminal',
        request: { providerId: 'missing', interactive: false },
        code: 'not-interactive',
        reason: 'its input or output is not a terminal: a one-shot run',
        reached: ['classify'],
        strict: 'fallback',
      },
      // 3. Where it is: outside the host's terminals (the launcher's directory leaks), never refused.
      {
        name: 'an accepted session no terminal of the host contains',
        ...NOWHERE,
        code: 'outside-host-terminals',
        reason: 'not in a terminal this host owns',
        reached: ['classify', 'resolve'],
        strict: 'fallback',
      },
      {
        name: 'a rejected session no terminal of the host contains',
        ...NOWHERE,
        grammar: { status: 'rejected', reason: 'cannot carry it', argument: '--other' },
        code: 'outside-host-terminals',
        reason: 'not in a terminal this host owns',
        reached: ['classify', 'resolve'],
        strict: 'fallback',
      },
      {
        name: 'an unknown provider no terminal of the host contains',
        ...NOWHERE,
        request: { providerId: 'missing' },
        code: 'outside-host-terminals',
        reason: 'not in a terminal this host owns',
        reached: ['classify', 'resolve'],
        strict: 'fallback',
      },
      // 4. A session in one of the host's terminals that the host cannot manage.
      {
        name: 'an unknown provider',
        request: { providerId: 'missing' },
        code: 'unsupported-agent',
        reason: UNSUPPORTED.reason,
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      {
        name: 'a provider without the capability',
        request: { providerId: 'plain' },
        code: 'unsupported-agent',
        reason: UNSUPPORTED.reason,
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      {
        name: 'an invocation the runtime would not put to the adapter',
        grammar: {
          status: 'unsupported',
          code: 'INVALID_NATIVE_INVOCATION',
          reason: 'native invocation environment is not accepted by example: SECRET',
        },
        code: 'invalid-invocation',
        reason: 'native invocation environment is not accepted by example: SECRET',
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      {
        name: 'a provider the runtime classifies but does not list',
        runtime: { launchProviders: () => [plain] },
        code: 'unsupported-agent',
        reason: 'agent does not support managed native invocation',
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      {
        name: 'a rejected session, naming the argument',
        grammar: { status: 'rejected', reason: 'custom arguments are not compatible', argument: '--other' },
        code: 'rejected-argument',
        reason: 'custom arguments are not compatible (--other)',
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      // 5. The implementation.
      {
        name: 'an imposter the agent does not advertise',
        request: { providerId: 'bare', imposter: true },
        host: { imposterBin: () => '/opt/ai' },
        code: 'imposter-unavailable',
        reason: 'agent does not advertise a conformant pane imposter',
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      {
        name: 'an imposter this host cannot run',
        request: { imposter: true },
        code: 'imposter-unavailable',
        reason: 'the puppeteer imposter is not installed beside the host',
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      {
        name: 'an imposter without its isolated root',
        request: { imposter: true },
        host: { imposterBin: () => '/opt/ai' },
        code: 'imposter-unavailable',
        reason: 'an isolated imposter state root is unavailable',
        reached: ['classify', 'resolve'],
        strict: 'refuse',
      },
      // 6. Prepare, adopt: each failure keeps the runtime's own code distinguishable.
      {
        name: 'a failed preparation, naming its argument',
        runtime: {
          prepareInvocation: async () => ({
            error: { code: 'INVALID_NATIVE_INVOCATION', message: 'the imposter cannot carry it', argument: '--x' },
          }),
        },
        code: 'rejected-argument',
        reason: 'the imposter cannot carry it (--x)',
        reached: ['classify', 'resolve', 'prepare'],
        strict: 'refuse',
      },
      {
        name: 'a preparation the implementation does not fit',
        runtime: {
          prepareInvocation: async () => ({
            error: { code: 'INVALID_NATIVE_INVOCATION', message: 'imposter implementation does not match' },
          }),
        },
        code: 'invalid-invocation',
        reason: 'imposter implementation does not match',
        reached: ['classify', 'resolve', 'prepare'],
        strict: 'refuse',
      },
      {
        name: 'a preparation of an agent the runtime no longer offers',
        runtime: {
          prepareInvocation: async () => ({
            error: { code: 'NATIVE_INVOCATION_UNSUPPORTED', message: 'no longer offered' },
          }),
        },
        code: 'unsupported-agent',
        reason: 'no longer offered',
        reached: ['classify', 'resolve', 'prepare'],
        strict: 'refuse',
      },
      {
        name: 'a failed preparation of any other kind',
        runtime: {
          prepareInvocation: async () => ({
            error: { code: 'CREATION_REQUEST_CONFLICT', message: 'the run is already being created' },
          }),
        },
        code: 'prepare-failed',
        reason: 'the run is already being created',
        reached: ['classify', 'resolve', 'prepare'],
        strict: 'refuse',
      },
      {
        name: 'a passthrough only the real implementation reveals',
        runtime: {
          prepareInvocation: async () => ({
            error: { code: 'NATIVE_INVOCATION_PASSTHROUGH', message: 'not a session', passthrough: 'utility' },
          }),
        },
        code: 'passthrough',
        reason: 'not a session',
        reached: ['classify', 'resolve', 'prepare'],
        strict: 'fallback',
      },
      {
        name: 'a terminal that already runs a managed session',
        runtime: {
          adoptPrepared: async () => ({
            error: { code: 'RUNTIME_SESSION_CONFLICT', message: 'terminal already has an active agent session' },
          }),
        },
        code: 'terminal-conflict',
        reason: 'terminal already has an active agent session',
        reached: ['classify', 'resolve', 'prepare', 'adopt', 'cancel'],
        strict: 'refuse',
      },
      {
        name: 'a failed adoption',
        runtime: {
          adoptPrepared: async () => ({ error: { code: 'PREPARATION_ADOPT_FAILED', message: 'terminal is busy' } }),
        },
        code: 'adopt-failed',
        reason: 'terminal is busy',
        reached: ['classify', 'resolve', 'prepare', 'adopt', 'cancel'],
        strict: 'refuse',
      },
    ];

    for (const strict of [false, true]) {
      for (const { name, request, code, reason, reached, strict: answer, ...script } of cases) {
        const refused = strict && answer === 'refuse';
        it(`${name} (${strict ? 'strict' : 'not strict'}): ${refused ? 'refuse' : 'fallback'}`, async () => {
          const { calls, host } = scripted({ ...script, host: { ...script.host, strict } });
          const result = await prepareSpawnThroughLaunch(launch(request), host);
          expect(result).toEqual(refused ? refusal(code, reason) : { action: 'fallback', code, reason });
          expect(calls).toEqual(reached);
          expect(host.onAdopted).not.toHaveBeenCalled();
        });
      }
    }
  });

  it('never refuses a passthrough, nor looks for its terminal or prepares it, whatever the host', async () => {
    for (const kind of ['utility', 'one-shot', 'elsewhere'] as const) {
      for (const strict of [false, true, undefined]) {
        for (const interactive of [true, false]) {
          for (const imposter of [true, false]) {
            const { runtime, host } = scripted({
              host: { strict, imposterBin: () => '/opt/ai', imposterStateRoot: () => '/state' },
              grammar: { status: 'passthrough', kind, reason: 'not a session' },
            });
            await expect(prepareSpawnThroughLaunch(launch({ interactive, imposter }), host)).resolves.toEqual({
              action: 'fallback',
              code: 'passthrough',
              reason: 'not a session',
            });
            expect(host.resolveTerminal).not.toHaveBeenCalled();
            expect(runtime.prepareInvocation).not.toHaveBeenCalled();
            expect(runtime.adoptPrepared).not.toHaveBeenCalled();
          }
        }
      }
    }
  });

  describe("a refusal in the host's own words", () => {
    const rejected = {
      grammar: { status: 'rejected', reason: 'custom arguments are not compatible', argument: '--bare' } as const,
    };

    it('asks the host for the sentence, telling it the code, the reason, the argument, the agent and the command', async () => {
      const words = vi.fn((refused: SpawnThroughRefusal) => `${refused.command} runs here only as a managed session`);
      const { host } = scripted({ ...rejected, host: { strict: true, refusal: words } });
      await expect(prepareSpawnThroughLaunch(launch(), host)).resolves.toEqual(
        refusal(
          'rejected-argument',
          'custom arguments are not compatible (--bare)',
          'example runs here only as a managed session',
        ),
      );
      expect(words).toHaveBeenCalledWith({
        code: 'rejected-argument',
        reason: 'custom arguments are not compatible (--bare)',
        argument: '--bare',
        providerId: 'example',
        command: 'example',
      });

      // A shim from before the request named its command: the agent's id stands in for it.
      const { command: _command, ...older } = launch({ providerId: 'bare' });
      await prepareSpawnThroughLaunch(older, host);
      expect(words).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'bare', providerId: 'bare' }));
      await prepareSpawnThroughLaunch(launch({ command: 'ai', imposter: false }), host);
      expect(words).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'ai' }));
    });

    it('bounds the words: printable characters, two lines, and a length a terminal can hold', async () => {
      const answer = async (text: string) => {
        const { host } = scripted({ ...rejected, host: { strict: true, refusal: () => text } });
        const result = await prepareSpawnThroughLaunch(launch(), host);
        if (result.action !== 'refuse') throw new Error(`expected a refusal, got ${result.action}`);
        return result.message;
      };
      await expect(answer('red \u001b[31mtext\u0007 and \u202eflipped\u202c\u009b2J')).resolves.toBe(
        'red [31mtext and flipped 2J',
      );
      await expect(answer('first line\r\nsecond line\nthird line\n\n')).resolves.toBe(
        'first line\nsecond line third line',
      );
      const long = await answer('x'.repeat(MAX_REFUSAL_MESSAGE_LENGTH * 3));
      expect(Array.from(long)).toHaveLength(MAX_REFUSAL_MESSAGE_LENGTH);
      expect(long.endsWith('…')).toBe(true);
    });

    it("says the kit's own sentence when the host's words fail it", async () => {
      for (const words of [
        () => {
          throw new Error('no words today');
        },
        () => '',
        () => '\u0000\u001b \n\t',
        () => 42 as never,
      ]) {
        const { host } = scripted({ ...rejected, host: { strict: true, refusal: words } });
        await expect(prepareSpawnThroughLaunch(launch(), host)).resolves.toEqual(
          refusal('rejected-argument', 'custom arguments are not compatible (--bare)'),
        );
      }
    });

    it('never asks for words when the launch runs as typed', async () => {
      const words = vi.fn(() => 'refused');
      for (const script of [
        { ...rejected, host: { strict: false, refusal: words } },
        { ...rejected, terminal: undefined, host: { strict: true, refusal: words } },
        {
          grammar: { status: 'passthrough', kind: 'utility', reason: 'x' } as const,
          host: { strict: true, refusal: words },
        },
      ]) {
        const { host } = scripted(script);
        await expect(prepareSpawnThroughLaunch(launch(), host)).resolves.toMatchObject({ action: 'fallback' });
      }
      expect(words).not.toHaveBeenCalled();
    });
  });
});
