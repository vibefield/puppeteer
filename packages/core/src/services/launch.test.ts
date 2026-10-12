import { describe, expect, it, vi } from 'vitest';
import {
  AgentContinuationSchema,
  AgentLaunchProviderSchema,
  AgentLaunchRefusedError,
  AgentNativeInvocationPassthroughKindSchema,
  AgentNativeInvocationSchema,
  isAgentLaunchRefusedError,
} from './launch.js';

describe('agent launch contracts', () => {
  it('accepts a bounded opaque continuation and rejects provider-shaped extras', () => {
    expect(
      AgentContinuationSchema.parse({
        providerId: 'example',
        nativeSessionId: 'native-1',
        state: '{"version":1}',
      }),
    ).toEqual({
      providerId: 'example',
      nativeSessionId: 'native-1',
      implementation: 'native',
      state: '{"version":1}',
    });
    expect(
      AgentContinuationSchema.safeParse({
        providerId: 'example',
        nativeSessionId: 'native-1',
        executable: '/opt/example',
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate descriptor routes and environment declarations', () => {
    const result = AgentLaunchProviderSchema.safeParse({
      id: 'example',
      label: 'Example',
      resume: true,
      nativeInvocation: {
        commands: [
          { name: 'example', executable: 'example' },
          { name: 'example', executable: '/opt/example' },
        ],
        environmentVariables: ['EXAMPLE_HOME', 'EXAMPLE_HOME'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('carries whether an adapter classifies, absent reading as not', () => {
    const provider = {
      id: 'example',
      label: 'Example',
      resume: true,
      nativeInvocation: { commands: [{ name: 'example', executable: '/opt/example' }], environmentVariables: [] },
    };
    for (const classifies of [true, false]) {
      const withKey = { ...provider, nativeInvocation: { ...provider.nativeInvocation, classifies } };
      expect(AgentLaunchProviderSchema.parse(withKey)).toEqual(withKey);
    }
    // Absent stays absent: nothing is invented for an adapter that never said.
    expect(AgentLaunchProviderSchema.parse(provider).nativeInvocation).not.toHaveProperty('classifies');
    for (const classifies of ['yes', 1, null]) {
      expect(
        AgentLaunchProviderSchema.safeParse({
          ...provider,
          nativeInvocation: { ...provider.nativeInvocation, classifies },
        }).success,
      ).toBe(false);
    }
  });

  it('names exactly three kinds of passthrough', () => {
    expect(AgentNativeInvocationPassthroughKindSchema.options).toEqual(['utility', 'one-shot', 'elsewhere']);
    expect(AgentNativeInvocationPassthroughKindSchema.safeParse('session').success).toBe(false);
  });

  it('validates native invocation payloads independently of adapter callbacks', () => {
    const invocation = {
      providerId: 'example',
      cwd: '/repo',
      argv: ['--resume', 'native-1'],
      environment: { EXAMPLE_HOME: '/profiles/example' },
      implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: '/tmp/example' },
    };
    expect(AgentNativeInvocationSchema.parse(invocation)).toEqual(invocation);
    expect(
      AgentNativeInvocationSchema.safeParse({ ...invocation, environment: { 'INVALID-NAME': 'value' } }).success,
    ).toBe(false);
  });
});

describe("an adapter's refusal: the one error whose words are for a person", () => {
  class ExampleHooksOffError extends AgentLaunchRefusedError<'EXAMPLE_HOOKS_OFF'> {
    constructor(readonly settingsPath: string) {
      super('EXAMPLE_HOOKS_OFF', 'your settings turn hooks off, and a managed session is observed through hooks');
      this.name = 'ExampleHooksOffError';
    }
  }

  it('carries the adapter’s code and its sentence, and is known by its brand', () => {
    const refusal = new AgentLaunchRefusedError('EXAMPLE_REFUSED', 'not here');
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ name: 'AgentLaunchRefusedError', code: 'EXAMPLE_REFUSED', message: 'not here' });
    expect(isAgentLaunchRefusedError(refusal)).toBe(true);

    // A subclass keeps its own name, code and fields, and is a refusal all the same.
    const hooksOff = new ExampleHooksOffError('/home/someone/.example/settings.json');
    expect(hooksOff).toMatchObject({ name: 'ExampleHooksOffError', code: 'EXAMPLE_HOOKS_OFF' });
    expect(isAgentLaunchRefusedError(hooksOff)).toBe(true);

    // The brand is not data: it adds nothing of its own to an instance, so nothing that copies one carries it.
    expect(Object.getOwnPropertySymbols(hooksOff)).toEqual([]);
    expect(isAgentLaunchRefusedError({ ...hooksOff, message: hooksOff.message })).toBe(false);
  });

  it('is nothing else an adapter throws, whatever it carries', () => {
    const coded = Object.assign(new Error('secret path /home/someone/.token'), { code: 'EXAMPLE_HOOKS_OFF' });
    for (const value of [coded, new Error('no'), { code: 'EXAMPLE_REFUSED', message: 'x' }, 'x', null, undefined]) {
      expect(isAgentLaunchRefusedError(value)).toBe(false);
    }
    // Branded, but outside the class's rule: an internal failure still.
    for (const code of ['example-refused', 'EXAMPLE REFUSED', '_EXAMPLE', '', `E${'X'.repeat(64)}`]) {
      expect(isAgentLaunchRefusedError(new AgentLaunchRefusedError(code, 'not here')), code).toBe(false);
    }
    expect(isAgentLaunchRefusedError(new AgentLaunchRefusedError(`E${'X'.repeat(63)}`, 'not here'))).toBe(true);
    const wordless = new AgentLaunchRefusedError('EXAMPLE_REFUSED', 'not here');
    Object.defineProperty(wordless, 'message', { value: 42 });
    expect(isAgentLaunchRefusedError(wordless)).toBe(false);
  });

  it('is known across two copies of this package, where instanceof is not', async () => {
    vi.resetModules();
    const copy = await import('./launch.js');
    expect(copy.AgentLaunchRefusedError).not.toBe(AgentLaunchRefusedError);
    const fromCopy = new copy.AgentLaunchRefusedError('EXAMPLE_REFUSED', 'not here');
    expect(fromCopy).not.toBeInstanceOf(AgentLaunchRefusedError);
    expect(isAgentLaunchRefusedError(fromCopy)).toBe(true);
    expect(copy.isAgentLaunchRefusedError(new ExampleHooksOffError('/settings.json'))).toBe(true);
  });
});
