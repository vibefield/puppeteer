import { describe, expect, it } from 'vitest';
import {
  absorbBriefingRefusal,
  agentBriefingReceipt,
  settleAgentBriefing,
  validateAgentBriefing,
  withAgentBriefing,
  withholdUntilAccepted,
} from './briefing.js';
import { AgentLaunchRefusedError } from './launch.js';

const supported = { mcpServers: true, allowTools: true, instructions: true };
const full = {
  mcpServers: { field: { command: 'door' } },
  allowTools: ['field/*'],
  instructions: 'role',
};

describe('settling a briefing a launch cannot wholly honour', () => {
  it('refuses as it always did when the policy is refuse or unset', () => {
    for (const policy of [undefined, 'refuse'] as const) {
      expect(() => settleAgentBriefing(full, undefined, 'Example', policy)).toThrow(AgentLaunchRefusedError);
    }
    expect(settleAgentBriefing(full, supported, 'Example')).toEqual({ briefing: full, withheld: [] });
  });

  it('withholds what the provider cannot take, field by field, and keeps the rest', () => {
    expect(settleAgentBriefing(full, { ...supported, instructions: false }, 'Example', 'withhold')).toEqual({
      briefing: { mcpServers: full.mcpServers, allowTools: full.allowTools },
      withheld: [{ field: 'instructions', code: 'UNSUPPORTED_LAUNCH_FIELD' }],
    });
  });

  it('withholds the allowances with their servers: an allowance names a server of this briefing', () => {
    expect(settleAgentBriefing(full, { ...supported, mcpServers: false }, 'Example', 'withhold')).toEqual({
      briefing: { instructions: 'role' },
      withheld: [
        { field: 'mcpServers', code: 'UNSUPPORTED_LAUNCH_FIELD' },
        { field: 'allowTools', code: 'UNSUPPORTED_LAUNCH_FIELD' },
      ],
    });
  });

  it('withholds an allowance alone when only the allowance cannot be taken', () => {
    expect(settleAgentBriefing(full, { ...supported, allowTools: false }, 'Example', 'withhold')).toEqual({
      briefing: { mcpServers: full.mcpServers, instructions: 'role' },
      withheld: [{ field: 'allowTools', code: 'UNSUPPORTED_LAUNCH_FIELD' }],
    });
  });

  it('never withholds invalid data: that is the host saying something wrong, not a launch unable to take it', () => {
    expect(() => settleAgentBriefing({ instructions: 123 as never }, supported, 'Example', 'withhold')).toThrow(
      expect.objectContaining({ code: 'INVALID_LAUNCH_FIELD' }),
    );
  });

  it('carries what an earlier settle withheld', () => {
    const earlier = settleAgentBriefing(full, { ...supported, instructions: false }, 'Example', 'withhold');
    expect(settleAgentBriefing(earlier.briefing, undefined, 'Example imposter', 'withhold', earlier.withheld)).toEqual({
      briefing: {},
      withheld: [
        { field: 'instructions', code: 'UNSUPPORTED_LAUNCH_FIELD' },
        { field: 'mcpServers', code: 'UNSUPPORTED_LAUNCH_FIELD' },
        { field: 'allowTools', code: 'UNSUPPORTED_LAUNCH_FIELD' },
      ],
    });
  });
});

describe('absorbing an adapter refusal', () => {
  const start = { briefing: full, withheld: [] };
  const named = new AgentLaunchRefusedError('CONFLICTING_LAUNCH_FIELD', 'conflict', 'mcpServers');

  it('rethrows under refuse, and any refusal that names no field in the briefing', () => {
    expect(() => absorbBriefingRefusal(start, 'refuse', named)).toThrow(named);
    const unnamed = new AgentLaunchRefusedError('RUN_HELPER_UNNAMED', 'no');
    expect(() => absorbBriefingRefusal(start, 'withhold', unnamed)).toThrow(unnamed);
    const other = new Error('network');
    expect(() => absorbBriefingRefusal(start, 'withhold', other)).toThrow(other);
    expect(() => absorbBriefingRefusal({ briefing: {}, withheld: [] }, 'withhold', named)).toThrow(named);
  });

  it('withholds the named field under the refusal code, with its dependent allowances', () => {
    expect(absorbBriefingRefusal(start, 'withhold', named)).toEqual({
      briefing: { instructions: 'role' },
      withheld: [
        { field: 'mcpServers', code: 'CONFLICTING_LAUNCH_FIELD' },
        { field: 'allowTools', code: 'CONFLICTING_LAUNCH_FIELD' },
      ],
    });
  });

  it('retries a check until it accepts what is left', async () => {
    const seen: string[][] = [];
    const { result, settled } = await withholdUntilAccepted(start, 'withhold', async (briefing) => {
      seen.push(Object.keys(briefing));
      if (briefing.mcpServers) throw new AgentLaunchRefusedError('CONFLICTING_LAUNCH_FIELD', 'x', 'mcpServers');
      return 'accepted';
    });
    expect(result).toBe('accepted');
    expect(seen).toEqual([['mcpServers', 'allowTools', 'instructions'], ['instructions']]);
    expect(settled.withheld.map(({ field }) => field)).toEqual(['mcpServers', 'allowTools']);
  });

  it('does not retry under refuse', async () => {
    await expect(
      withholdUntilAccepted(start, 'refuse', () => {
        throw new AgentLaunchRefusedError('CONFLICTING_LAUNCH_FIELD', 'x', 'mcpServers');
      }),
    ).rejects.toMatchObject({ code: 'CONFLICTING_LAUNCH_FIELD' });
  });
});

describe('the launch options a settled briefing leaves', () => {
  it('drops every withheld field, so spreading can never restore one', () => {
    const options = { cwd: '/work', ...full };
    const left = withAgentBriefing(options, { instructions: 'role' });
    expect(left).toEqual({ cwd: '/work', instructions: 'role' });
    expect(validateAgentBriefing(left, { ...supported, mcpServers: false, allowTools: false }, 'X')).toEqual({
      instructions: 'role',
    });
  });
});

describe('the receipt', () => {
  it('says nothing about a launch that asked for nothing', () => {
    expect(agentBriefingReceipt([], [])).toBeUndefined();
  });

  it('names what applied and what was withheld, each field once', () => {
    expect(
      agentBriefingReceipt(
        ['mcpServers', 'allowTools', 'instructions'],
        [
          { field: 'mcpServers', code: 'CONFLICTING_LAUNCH_FIELD' },
          { field: 'allowTools', code: 'CONFLICTING_LAUNCH_FIELD' },
          { field: 'mcpServers', code: 'CONFLICTING_LAUNCH_FIELD' },
        ],
      ),
    ).toEqual({
      applied: ['instructions'],
      withheld: [
        { field: 'mcpServers', code: 'CONFLICTING_LAUNCH_FIELD' },
        { field: 'allowTools', code: 'CONFLICTING_LAUNCH_FIELD' },
      ],
    });
  });
});
