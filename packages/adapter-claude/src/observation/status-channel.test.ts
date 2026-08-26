import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeContextWindowEvent,
  claudeEnvironmentEvents,
  claudeSubagentStatusTasks,
  resolveClaudeStatusChannels,
  resolveClaudeStatusLine,
} from './status-channel.js';

describe('claudeEnvironmentEvents', () => {
  it('extracts the live workspace cwd and human-facing model card', () => {
    expect(
      claudeEnvironmentEvents({
        cwd: '/old',
        workspace: { current_dir: '/repo/packages/app' },
        model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
        effort: { level: 'xhigh' },
      }),
    ).toEqual([
      { type: 'environment:updated', currentCwd: '/repo/packages/app' },
      {
        type: 'model:updated',
        intent: 'observed',
        model: { id: 'claude-opus-4-6', displayName: 'Opus 4.6', provider: 'anthropic' },
      },
      { type: 'effort:updated', intent: 'observed', effort: 'xhigh' },
    ]);
  });

  it('retracts observed effort when the active model omits unsupported effort', () => {
    expect(
      claudeEnvironmentEvents({
        model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
      }),
    ).toEqual([
      {
        type: 'model:updated',
        intent: 'observed',
        model: { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', provider: 'anthropic' },
      },
      { type: 'effort:updated', intent: 'observed', effort: null },
    ]);
  });
});

describe('claudeContextWindowEvent', () => {
  it('uses Claude input + cache usage and excludes output tokens', () => {
    expect(
      claudeContextWindowEvent({
        model: { id: 'claude-fable-5' },
        context_window: {
          context_window_size: 200_000,
          current_usage: {
            input_tokens: 8_500,
            output_tokens: 99_999,
            cache_creation_input_tokens: 5_000,
            cache_read_input_tokens: 2_000,
          },
        },
      }),
    ).toEqual({
      type: 'context-window:updated',
      usedTokens: 15_500,
      capacityTokens: 200_000,
      percentageSource: 'derived',
      modelId: 'claude-fable-5',
    });
  });

  it('invalidates the previous value when Claude reports null after startup/compaction', () => {
    expect(claudeContextWindowEvent({ context_window: { context_window_size: 200_000, current_usage: null } })).toEqual(
      { type: 'context-window:invalidated', reason: 'provider-reset' },
    );
  });

  it("reports an explicit empty context before a fresh session's first API response", () => {
    expect(
      claudeContextWindowEvent({
        model: { id: 'claude-haiku-4-5-20251001' },
        context_window: {
          total_input_tokens: 0,
          context_window_size: 200_000,
          current_usage: null,
          used_percentage: null,
        },
      }),
    ).toEqual({
      type: 'context-window:updated',
      usedTokens: 0,
      capacityTokens: 200_000,
      modelId: 'claude-haiku-4-5-20251001',
    });
  });

  it("uses Claude's pre-calculated percentage when the token breakdown is omitted", () => {
    expect(
      claudeContextWindowEvent({
        model: { id: 'claude-fable-5' },
        context_window: { context_window_size: 1_000_000, current_usage: {}, used_percentage: 13 },
      }),
    ).toEqual({
      type: 'context-window:updated',
      usedTokens: 130_000,
      capacityTokens: 1_000_000,
      usedPercentage: 13,
      percentageSource: 'provider',
      modelId: 'claude-fable-5',
    });
  });

  it('uses the provider remaining percentage when used percentage is absent', () => {
    expect(
      claudeContextWindowEvent({
        context_window: {
          context_window_size: 200_000,
          current_usage: {},
          remaining_percentage: 72.5,
        },
      }),
    ).toEqual({
      type: 'context-window:updated',
      usedTokens: 55_000,
      capacityTokens: 200_000,
      usedPercentage: 27.5,
      percentageSource: 'provider',
      modelId: undefined,
    });
  });

  it("preserves Claude's provider percentage even when its exact counts imply a different ratio", () => {
    expect(
      claudeContextWindowEvent({
        model: { id: 'claude-opus-5' },
        context_window: {
          context_window_size: 200_000,
          used_percentage: 19.5,
          current_usage: {
            input_tokens: 10_000,
            cache_creation_input_tokens: 2_000,
            cache_read_input_tokens: 3_000,
          },
        },
      }),
    ).toEqual({
      type: 'context-window:updated',
      usedTokens: 15_000,
      capacityTokens: 200_000,
      usedPercentage: 19.5,
      percentageSource: 'provider',
      modelId: 'claude-opus-5',
    });
  });
});

describe('claudeSubagentStatusTasks', () => {
  it('retains stable child/task metrics and open effort values from the documented snapshot', () => {
    expect(
      claudeSubagentStatusTasks({
        columns: 90,
        tasks: [
          {
            id: 'task-7',
            name: 'reviewer',
            type: 'local_agent',
            status: 'running',
            description: 'Review the patch',
            label: 'Reviewing',
            startTime: 1234,
            model: 'claude-sonnet-4-6',
            effort: 8_000,
            contextWindowSize: 200_000,
            tokenCount: 42_000,
            tokenSamples: [41_000, 'bad', 42_000],
            cwd: '/repo',
          },
          { id: '', tokenCount: 1 },
        ],
      }),
    ).toEqual([
      {
        id: 'task-7',
        name: 'reviewer',
        type: 'local_agent',
        status: 'running',
        description: 'Review the patch',
        label: 'Reviewing',
        startTime: 1234,
        model: 'claude-sonnet-4-6',
        effort: '8000',
        contextWindowSize: 200_000,
        tokenCount: 42_000,
        tokenSamples: [41_000, 42_000],
        cwd: '/repo',
      },
    ]);
  });
});

describe('resolveClaudeStatusLine', () => {
  it('uses cwd-only project settings and does not inherit status commands from ancestors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-claude-statusline-'));
    const home = join(directory, 'home');
    const project = join(directory, 'project');
    const nested = join(project, 'packages', 'app');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(project, '.claude'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'user-line', padding: 1 },
        subagentStatusLine: { type: 'command', command: 'user-child-line' },
      }),
    );
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'project-line', refreshInterval: 2 } }),
    );

    await expect(resolveClaudeStatusLine(nested, { home })).resolves.toEqual({
      type: 'command',
      command: 'user-line',
      padding: 1,
      refreshInterval: undefined,
      hideVimModeIndicator: undefined,
    });
    await expect(resolveClaudeStatusChannels(nested, { home })).resolves.toEqual({
      statusLine: {
        type: 'command',
        command: 'user-line',
        padding: 1,
        refreshInterval: undefined,
        hideVimModeIndicator: undefined,
      },
      subagentStatusLine: {
        type: 'command',
        command: 'user-child-line',
        padding: undefined,
        refreshInterval: undefined,
        hideVimModeIndicator: undefined,
      },
    });
  });

  it('reads user status commands from an explicit Claude config directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-claude-config-dir-'));
    const home = join(directory, 'home');
    const configDir = join(directory, 'claude-work');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'default-user-line' } }),
    );
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'relocated-user-line' } }),
    );

    await expect(resolveClaudeStatusLine(directory, { home, configDir, settingSources: ['user'] })).resolves.toEqual({
      type: 'command',
      command: 'relocated-user-line',
      padding: undefined,
      refreshInterval: undefined,
      hideVimModeIndicator: undefined,
    });
  });

  it('loads only selected native setting sources while retaining native precedence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-claude-status-sources-'));
    const home = join(directory, 'home');
    const project = join(directory, 'project');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'user-line' },
        subagentStatusLine: { type: 'command', command: 'user-child-line' },
      }),
    );
    await writeFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'project-line' } }),
    );
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'local-line' } }),
    );

    await expect(resolveClaudeStatusChannels(project, { home, settingSources: ['project', 'user'] })).resolves.toEqual({
      statusLine: {
        type: 'command',
        command: 'project-line',
        padding: undefined,
        refreshInterval: undefined,
        hideVimModeIndicator: undefined,
      },
      subagentStatusLine: {
        type: 'command',
        command: 'user-child-line',
        padding: undefined,
        refreshInterval: undefined,
        hideVimModeIndicator: undefined,
      },
    });
    await expect(resolveClaudeStatusChannels(project, { home, settingSources: ['local'] })).resolves.toEqual({
      statusLine: {
        type: 'command',
        command: 'local-line',
        padding: undefined,
        refreshInterval: undefined,
        hideVimModeIndicator: undefined,
      },
    });
  });
});
