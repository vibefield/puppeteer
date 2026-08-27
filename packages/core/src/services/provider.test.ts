import { describe, expect, it } from 'vitest';
import { AgentProviderDescriptorSchema } from './provider.js';

describe('AgentProviderDescriptorSchema', () => {
  it('accepts an opaque provider id and adapter-authored label', () => {
    expect(AgentProviderDescriptorSchema.parse({ id: 'company.agent-v2', label: 'Company Agent' })).toEqual({
      id: 'company.agent-v2',
      label: 'Company Agent',
    });
  });

  it('rejects malformed ids and unknown fields at the package boundary', () => {
    expect(AgentProviderDescriptorSchema.safeParse({ id: '../agent', label: 'Agent' }).success).toBe(false);
    expect(
      AgentProviderDescriptorSchema.safeParse({ id: 'agent', label: 'Agent', executable: '/bin/agent' }).success,
    ).toBe(false);
  });
});
