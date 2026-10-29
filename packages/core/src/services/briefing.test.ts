import { describe, expect, it } from 'vitest';
import { AgentRunBriefingSchema, validateAgentBriefing } from './briefing.js';
import { isAgentLaunchRefusedError } from './launch.js';

const supported = { mcpServers: true, allowTools: true, instructions: true };
describe('per-run briefing', () => {
  it('copies nested launch data without coercing instructions or arguments', () => {
    const input = {
      mcpServers: { field: { command: '/bin/door', args: ['a b'], env: { TOKEN: 'secret' } } },
      allowTools: ['field/*'],
      instructions: '  briefing\n',
    };
    const parsed = validateAgentBriefing(input, supported, 'Example');
    expect(parsed).toEqual(input);
    input.mcpServers.field.env.TOKEN = 'changed';
    input.allowTools.push('field/read');
    expect(parsed.mcpServers!.field!.env!.TOKEN).toBe('secret');
    expect(parsed.allowTools).toEqual(['field/*']);
  });

  it.each(['*', 'Bash', 'field/read*', 'mcp__field__*', 'other/read', 'field/*/read'])(
    'rejects unscoped or ambiguous allowance %s',
    (allowance) => {
      expect(
        AgentRunBriefingSchema.safeParse({ mcpServers: { field: { command: 'door' } }, allowTools: [allowance] })
          .success,
      ).toBe(false);
    },
  );

  const invalids: unknown[] = [
    { mcpServers: { 'field.name': { command: 'door' } } },
    { mcpServers: { constructor: { command: 'door' } } },
    { mcpServers: { field: { command: ' ' } } },
    { mcpServers: { field: { command: 'door', args: ['nul\0'] } } },
    { mcpServers: { field: { command: 'door', env: { 'BAD=NAME': 'value' } } } },
    { mcpServers: { field: { command: 'door', unknown: 'value' } } },
    { instructions: 123 },
  ];
  it.each(invalids)('rejects invalid launch data without echoing its value', (input) => {
    try {
      validateAgentBriefing(input as never, supported, 'Example');
      expect.fail('expected refusal');
    } catch (error) {
      expect(isAgentLaunchRefusedError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'INVALID_LAUNCH_FIELD' });
      expect(String(error)).not.toContain('BAD=NAME');
    }
  });

  it.each([{ mcpServers: {} }, { allowTools: [] }, { instructions: '' }])(
    'refuses supplied unsupported fields even when empty',
    (input) => {
      expect(() => validateAgentBriefing(input, undefined, 'Example')).toThrow(
        `launch field: ${Object.keys(input)[0]}`,
      );
      expect(validateAgentBriefing({}, undefined, 'Example')).toEqual({});
    },
  );
});
