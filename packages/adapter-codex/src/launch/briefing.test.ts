import { describe, expect, it, vi } from 'vitest';
import { codexBriefingParams, preflightCodexBriefing } from './briefing.js';

const servers = { field: { command: 'door', args: ['--stdio'], env: { TOKEN: 'secret' } } };
const hello = { userAgent: 'puppeteer/0.147.0 (test)' };
describe('Codex run briefing', () => {
  it('combines MCP, instructions and effort without widening sandbox or tool visibility', () => {
    expect(
      codexBriefingParams({ mcpServers: servers, allowTools: ['field/read'], instructions: 'new role' }, 'high'),
    ).toEqual({
      developerInstructions: 'new role',
      config: {
        model_reasoning_effort: 'high',
        'mcp_servers.field': {
          ...servers.field,
          enabled: true,
          required: true,
          tools: { read: { approval_mode: 'approve' } },
        },
      },
    });
    expect(
      codexBriefingParams({ mcpServers: servers, allowTools: ['field/*'] }).config!['mcp_servers.field'],
    ).toMatchObject({ default_tools_approval_mode: 'approve' });
    expect(codexBriefingParams({ mcpServers: servers }).config!['mcp_servers.field']).not.toHaveProperty(
      'default_tools_approval_mode',
    );
    expect(codexBriefingParams({ instructions: '' })).toEqual({ developerInstructions: '' });
  });

  it('checks project-effective configuration and refuses a merged native server table', async () => {
    const request = vi.fn(async () => ({
      config: { mcp_servers: { field: { url: 'private', tools: { write: { approval_mode: 'approve' } } } } },
    }));
    await expect(preflightCodexBriefing({ mcpServers: servers }, hello, '/work', request)).rejects.toMatchObject({
      code: 'CONFLICTING_LAUNCH_FIELD',
    });
    expect(request).toHaveBeenCalledWith('config/read', { cwd: '/work', includeLayers: false });
    request.mockResolvedValueOnce({ config: { mcp_servers: {} } } as never);
    await expect(preflightCodexBriefing({ mcpServers: servers }, hello, '/work', request)).resolves.toBeUndefined();
  });

  it.each([{}, { userAgent: 'codex/0.146.0' }])(
    'refuses a server that cannot establish briefing support',
    async (initialized) => {
      const request = vi.fn();
      await expect(
        preflightCodexBriefing({ instructions: 'private prompt' }, initialized, '/work', request),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_LAUNCH_FIELD', message: expect.stringContaining('instructions') });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('does not reinterpret a failed config read as empty configuration', async () => {
    await expect(
      preflightCodexBriefing({ mcpServers: servers }, hello, '/work', async () => {
        throw new Error('secret native failure');
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_LAUNCH_FIELD',
      message: 'Codex cannot verify launch field: mcpServers.',
    });
  });
});
