import { describe, expect, it } from 'vitest';
import {
  AgentContinuationSchema,
  AgentLaunchProviderSchema,
  AgentNativeInvocationPassthroughKindSchema,
  AgentNativeInvocationSchema,
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
