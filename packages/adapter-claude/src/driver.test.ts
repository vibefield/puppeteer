/**
 * Full-loop driver test: the test acts as Claude Code. The fake spawn port
 * captures the PreparedClaudeSession exactly as the pty-host would receive
 * it; the test then reads the generated settings file to discover the bridge
 * endpoint (proving the settings are what a real Claude would consume) and
 * POSTs fixture-shaped hook payloads with the env-carried token.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  safeParseAgentEvent,
  type AdapterEventCandidate,
  type TerminalAutomationOperation,
} from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import {
  attachClaudeTuiSession,
  createClaudeSession,
  prepareClaudeTuiSession,
  type ClaudeSession,
  type ClaudeSessionPorts,
} from './driver.js';
import type { PreparedClaudeSession } from './launch/prepare.js';
import { cleanupClaudeSession } from './launch/prepare.js';
import type { ClaudeHookDiagnostic } from './normalization/index.js';
import { createHookBridge, type HookBridge, type NativeHookEnvelope } from './observation/hook-bridge.js';
import type { SemanticObservationEvent, SemanticObservationProvider } from './observation/semantic-provider.js';

let sessions: ClaudeSession[] = [];
afterEach(async () => {
  for (const s of sessions) await s.dispose();
  sessions = [];
});

async function startSession(
  options: {
    fileChangeMatcher?: string;
    onDiagnostic?: (diagnostic: ClaudeHookDiagnostic) => void;
    permissionMode?: string;
    model?: string;
    effort?: string;
    settingSources?: Parameters<typeof createClaudeSession>[0]['settingSources'];
    providerVersion?: string;
    observeOtlpUsage?: boolean;
    observeSubagentStatus?: boolean;
    hookRailFaultInjection?: Parameters<typeof createClaudeSession>[0]['hookRailFaultInjection'];
    semanticProviderFactory?: () => SemanticObservationProvider;
  } = {},
) {
  let prepared: PreparedClaudeSession | undefined;
  const automations: TerminalAutomationOperation[] = [];
  const session = await createClaudeSession({
    cwd: '/tmp',
    title: 'driver-test',
    fileChangeMatcher: options.fileChangeMatcher,
    onDiagnostic: options.onDiagnostic,
    permissionMode: options.permissionMode,
    model: options.model,
    effort: options.effort,
    settingSources: options.settingSources,
    providerVersion: options.providerVersion,
    observeOtlpUsage: options.observeOtlpUsage,
    observeSubagentStatus: options.observeSubagentStatus,
    hookRailFaultInjection: options.hookRailFaultInjection,
    semanticProviderFactory: options.semanticProviderFactory,
    ports: {
      spawn: async (p) => {
        prepared = p;
        return { runtimeSessionId: 'rt-1' };
      },
      automate: async (id, operation) => {
        expect(id).toBe('rt-1');
        automations.push(operation);
        return { accepted: true };
      },
    },
  });
  sessions.push(session);
  const projection = projectAgentEvents(session);

  const settings = JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; url?: string }> }>>;
  };
  const endpoint = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
  const token = prepared!.env.PUPPETEER_HOOK_TOKEN;

  const events = projection.envelopes;

  const hook = async (name: string, fields: Record<string, unknown> = {}) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: session.sessionId,
        transcript_path: fields.transcript_path,
        cwd: '/tmp',
        hook_event_name: name,
        ...fields,
      }),
    });
    expect(res.status).toBe(200);
  };

  const statusLine = async (fields: Record<string, unknown>) => {
    const res = await fetch(prepared!.env.PUPPETEER_STATUSLINE_ENDPOINT!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: session.sessionId, ...fields }),
    });
    expect(res.status).toBe(200);
  };

  const subagentStatusLine = async (fields: Record<string, unknown>) => {
    const res = await fetch(prepared!.env.PUPPETEER_SUBAGENT_STATUSLINE_ENDPOINT!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: session.sessionId, ...fields }),
    });
    expect(res.status).toBe(200);
  };

  return {
    session,
    projection,
    prepared: prepared!,
    automations,
    events,
    hook,
    statusLine,
    subagentStatusLine,
    endpoint,
    token,
  };
}

describe('createClaudeSession (full loop, test-as-Claude)', () => {
  it('keeps the optional child status channel absent when explicitly disabled', async () => {
    const { prepared } = await startSession({ observeSubagentStatus: false });
    const settings = JSON.parse(readFileSync(prepared.settingsPath, 'utf8')) as {
      subagentStatusLine?: unknown;
    };

    expect(settings.subagentStatusLine).toBeUndefined();
    expect(prepared.env).not.toHaveProperty('PUPPETEER_SUBAGENT_STATUSLINE_ENDPOINT');
    expect(prepared.env).not.toHaveProperty('PUPPETEER_SUBAGENT_STATUSLINE_DELEGATE');
  });

  it('prepares launch wiring without spawning and adopts one existing terminal idempotently', async () => {
    const prepared = await prepareClaudeTuiSession({
      cwd: '/tmp',
      executable: '/opt/claude',
      permissionMode: 'plan',
      model: 'sonnet',
      effort: 'high',
      settingSources: ['project'],
      automate: async () => ({ accepted: true }),
    });

    expect(prepared.launch).toMatchObject({
      command: '/opt/claude',
      cwd: '/tmp',
      env: { PUPPETEER_HOOK_TOKEN: expect.any(String) },
    });
    expect(prepared.launch.args).toEqual(
      expect.arrayContaining([
        '--session-id',
        prepared.sessionId,
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--setting-sources',
        'project',
        '--permission-mode',
        'plan',
      ]),
    );
    expect(existsSync(prepared.launch.settingsPath)).toBe(true);

    const first = await prepared.adopt('existing-pane');
    expect(first.runtimeSessionId).toBe('existing-pane');
    expect(await prepared.adopt('existing-pane')).toBe(first);
    await expect(prepared.adopt('other-pane')).rejects.toThrow('already adopted');

    const events: AdapterEventCandidate[] = [];
    const candidates: AdapterEventCandidate[] = [];
    first.events.onCandidate((event) => events.push(event));
    expect(first.events.onCandidate).toBeTypeOf('function');
    first.events.onCandidate!((candidate) => candidates.push(candidate));
    const settings = JSON.parse(readFileSync(prepared.launch.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: prepared.sessionId,
        cwd: '/tmp',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'typed prompt',
        prompt_id: 'p-adopted',
      }),
    });
    expect(response.status).toBe(200);
    expect(first.observationLevel()).toBe('native-hooks');
    expect(events.some((event) => event.event.type === 'turn:started')).toBe(true);
    const turn = candidates.find(({ type }) => type === 'turn:started');
    expect(turn).not.toHaveProperty('sequence');
    expect(turn && safeParseAgentEvent(turn.type, turn.event).success).toBe(true);
    expect(candidates.every(({ type }) => type.includes(':'))).toBe(true);
    expect(candidates.every(({ type, event }) => safeParseAgentEvent(type, event).success)).toBe(true);

    await prepared.dispose();
    expect(existsSync(prepared.launch.settingsPath)).toBe(false);
  });

  it('spawns via the prepared join contract and tracks the hook lifecycle in reducer state', async () => {
    const { session, projection, prepared, hook } = await startSession();
    expect(prepared.sessionId).toBe(session.sessionId);
    expect(prepared.args).toContain('--session-id');
    expect(session.observationLevel()).toBe('terminal-only');

    await hook('SessionStart', { source: 'startup', session_title: 'driver-test' });
    expect(session.observationLevel()).toBe('native-hooks');
    expect(projection.state.lifecycle).toBe('ready');

    await hook('UserPromptSubmit', { prompt: 'do something', prompt_id: 'p-1' });
    expect(projection.state.lifecycle).toBe('running');
    expect(projection.state.activeTurn?.id).toBe('p-1');

    await hook('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'toolu_1',
      prompt_id: 'p-1',
    });
    expect(projection.state.tools.size).toBe(1);

    await hook('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_response: { ok: 1 },
      duration_ms: 3,
      prompt_id: 'p-1',
    });
    expect(projection.state.tools.size).toBe(0);
    expect(projection.state.counters.toolsCompleted).toBe(1);

    await hook('Stop', { prompt_id: 'p-1', last_assistant_message: 'done!' });
    expect(projection.state.lifecycle).toBe('ready');
    expect(projection.state.lastAssistantMessage).toBe('done!');
  });

  it('retains malformed known hooks and reports diagnostics without interrupting the bridge', async () => {
    const diagnostics: ClaudeHookDiagnostic[] = [];
    const { projection, prepared, events, hook } = await startSession({
      fileChangeMatcher: '.env',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const settings = JSON.parse(readFileSync(prepared.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };
    expect(settings.hooks.FileChanged?.[0]?.matcher).toBe('.env');

    await hook('PreToolUse', { prompt_id: 'p-bad', tool_use_id: 'bad-tool', tool_input: { command: 'pwd' } });

    expect(diagnostics).toEqual([
      {
        code: 'malformed-known-hook',
        hookEventName: 'PreToolUse',
        issues: ['tool_name must be string'],
      },
    ]);
    expect(events.at(-1)?.event).toEqual({
      type: 'adapter:native-event',
      adapter: 'claude-code',
      nativeType: 'PreToolUse',
    });
    expect(projection.state.tools.size).toBe(0);
  });

  it('confirms injected prompts through the real bridge round-trip', async () => {
    const { session, automations, hook } = await startSession();
    await hook('SessionStart', {});

    const receiptPromise = session.services.prompt.submit({ text: 'injected task' });
    expect(automations).toEqual([{ kind: 'paste', text: 'injected task', submit: true }]);

    await hook('UserPromptSubmit', { prompt: 'injected task', prompt_id: 'p-9' });
    expect(await receiptPromise).toEqual({ status: 'confirmed', turnId: 'p-9' });
  });

  it('gates injection for the current PreToolUse → PermissionRequest path, releasing after execution', async () => {
    const { session, projection, hook } = await startSession();
    await hook('SessionStart', {});
    await hook('UserPromptSubmit', { prompt: 'risky', prompt_id: 'p-2' });
    await hook('PreToolUse', {
      prompt_id: 'p-2',
      tool_name: 'Bash',
      tool_input: { command: 'rm x' },
      tool_use_id: 'toolu_2',
    });
    await hook('PermissionRequest', { prompt_id: 'p-2', tool_name: 'Bash', tool_input: { command: 'rm x' } });

    expect((await session.services.prompt.submit({ text: 'nope' })).status).toBe('rejected');
    expect(projection.state.permissions.size).toBe(1);

    await hook('PostToolUse', {
      prompt_id: 'p-2',
      tool_name: 'Bash',
      tool_input: { command: 'rm x' },
      tool_use_id: 'toolu_2',
      tool_response: { output: '' },
    });
    expect(projection.state.permissions.size).toBe(0);

    const receipt = session.services.prompt.submit({ text: 'now fine' });
    await hook('UserPromptSubmit', { prompt: 'now fine', prompt_id: 'p-3' });
    expect((await receipt).status).toBe('confirmed');
  });

  it('publishes configured intent separately and preserves observed hook actor/version metadata', async () => {
    const { events, hook } = await startSession({
      model: 'configured-sonnet',
      effort: 'high',
      permissionMode: 'plan',
      providerVersion: '2.1.226',
    });
    const configuredModel = events.find(
      (envelope) => envelope.event.type === 'model:updated' && envelope.event.intent === 'configured',
    );
    expect(configuredModel).toMatchObject({
      source: 'runtime',
      providerVersion: '2.1.226',
      event: {
        type: 'model:updated',
        intent: 'configured',
        model: { id: 'configured-sonnet' },
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: { type: 'effort:updated', intent: 'configured', effort: 'high' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: {
          type: 'mode:updated',
          intent: 'configured',
          modeKind: 'provider-permission',
          mode: { raw: 'plan', normalized: 'Plan' },
        },
      }),
    );

    await hook('UserPromptSubmit', {
      prompt_id: 'p-metadata',
      prompt: 'inspect metadata',
      permission_mode: 'future-auto',
      effort: { level: 'future-ultra' },
      agent_id: 'agent-7',
      agent_type: 'Explore',
      version: '2.1.999',
    });
    const observed = events.find(
      (envelope) => envelope.event.type === 'effort:updated' && envelope.event.intent === 'observed',
    );
    expect(observed).toMatchObject({
      source: 'native-hook',
      confidence: 'authoritative',
      agentId: 'agent-7',
      agentType: 'Explore',
      providerVersion: '2.1.999',
      event: {
        type: 'effort:updated',
        effort: 'future-ultra',
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        agentId: 'agent-7',
        event: expect.objectContaining({
          type: 'mode:updated',
          modeKind: 'provider-permission',
          mode: { raw: 'future-auto' },
        }),
      }),
    );
  });

  it('blocks injection for a structured question independently from permission lifecycle', async () => {
    const { session, events, hook } = await startSession();
    await hook('UserPromptSubmit', { prompt: 'ask me', prompt_id: 'p-question' });
    await hook('PreToolUse', {
      prompt_id: 'p-question',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'ask-1',
      tool_input: {
        questions: [
          {
            header: 'Choice',
            question: 'Proceed?',
            options: [
              { label: 'Yes', description: 'Continue' },
              { label: 'No', description: 'Stop' },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    const requested = events.find((envelope) => envelope.event.type === 'interaction:question-requested');
    expect(requested).toMatchObject({ confidence: 'inferred' });
    expect((await session.services.prompt.submit({ text: 'cannot bypass' })).status).toBe('rejected');

    await hook('PermissionRequest', {
      prompt_id: 'p-question',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    });
    await hook('PostToolUse', {
      prompt_id: 'p-question',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'ask-1',
      tool_response: { answers: ['Yes'] },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: { type: 'interaction:question-resolved', requestId: 'question:ask-1', outcome: 'answered' },
      }),
    );
    expect((await session.services.prompt.submit({ text: 'permission remains' })).status).toBe('rejected');

    await hook('Stop', { prompt_id: 'p-question', last_assistant_message: 'done' });
    const receipt = session.services.prompt.submit({ text: 'both blockers cleared' });
    await hook('UserPromptSubmit', { prompt: 'both blockers cleared', prompt_id: 'p-next' });
    expect((await receipt).status).toBe('confirmed');
  });

  it('uses only OTLP request usage, models and actor corrections despite conflicting transcript records', async () => {
    const { session, prepared, events, token, hook } = await startSession({ providerVersion: '2.1.245' });
    expect(prepared.env).toMatchObject({
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
    });
    const attribute = (key: string, value: unknown) => ({
      key,
      value:
        typeof value === 'number'
          ? Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value }
          : { stringValue: value },
    });
    const otlpBody = JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [attribute('service.version', '2.1.245')] },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'claude_code.api_request' },
                  attributes: [
                    attribute('event.name', 'api_request'),
                    attribute('event.timestamp', '2026-08-25T16:30:14.402Z'),
                    attribute('session.id', session.sessionId),
                    attribute('prompt.id', 'prompt-otel'),
                    attribute('request_id', 'request-otel'),
                    attribute('query_source', 'main'),
                    attribute('model', 'claude-haiku-4-5'),
                    attribute('input_tokens', 10),
                    attribute('output_tokens', 5),
                    attribute('cache_read_tokens', 100),
                    attribute('cache_creation_tokens', 20),
                    attribute('cost_usd', 0.125),
                    attribute('user.email', 'must-not-cross@example.com'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const postOtlp = (body = otlpBody) =>
      fetch(prepared.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
      });
    const foreignResponse = await fetch(prepared.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: otlpBody.replace(session.sessionId, 'foreign-session'),
    });
    expect(foreignResponse.status).toBe(200);
    expect(session.observationLevel()).toBe('terminal-only');
    expect(events.some(({ event }) => event.type === 'usage:tokens-used')).toBe(false);

    const emptyResponse = await fetch(prepared.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ resourceLogs: [] }),
    });
    expect(emptyResponse.status).toBe(200);
    expect(session.observationLevel()).toBe('terminal-only');

    const dir = mkdtempSync(join(tmpdir(), 'driver-otel-only-'));
    const transcript = join(dir, `${session.sessionId}.jsonl`);
    const children = join(dir, session.sessionId, 'subagents');
    mkdirSync(children, { recursive: true });
    const childTranscript = join(children, 'agent-worker.jsonl');
    const transcriptRow = (sequence: number, agentId?: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `transcript-${sequence}`,
        requestId: 'request-otel',
        sessionId: session.sessionId,
        timestamp: `2026-08-25T16:30:${10 + sequence}.000Z`,
        agentId,
        message: {
          role: 'assistant',
          model: 'transcript-model',
          content: [],
          usage: { input_tokens: 900, output_tokens: 800, cost_usd: 500 },
        },
      }) + '\n';
    writeFileSync(transcript, transcriptRow(1));
    writeFileSync(childTranscript, transcriptRow(2, 'transcript-worker'));
    await hook('SessionStart', { transcript_path: transcript });
    await session.pollTranscript();
    expect(events.filter(({ event }) => event.type === 'usage:tokens-used')).toEqual([]);
    const models = () => events.filter(({ event }) => event.type === 'model:updated');
    expect(models()).toEqual([]);

    const response = await postOtlp();

    expect(response.status).toBe(200);
    expect(session.observationLevel()).toBe('native-hooks');
    const usage = events.find(({ event }) => event.type === 'usage:tokens-used');
    expect(usage).toMatchObject({
      source: 'native-telemetry',
      promptId: 'prompt-otel',
      event: {
        usageId: 'claude-request:request-otel',
        totalTokens: 135,
        meterTokens: 15,
        costUsd: 0.125,
        breakdown: { freshInputTokens: 10, cacheReadTokens: 100 },
      },
    });
    expect(JSON.stringify(usage?.nativeEvent)).not.toContain('must-not-cross@example.com');
    expect(usage?.agentId).toBeUndefined();
    expect(safeParseAgentEvent('usage:tokens-used', usage!.event).success).toBe(true);
    expect(models()).toEqual([
      expect.objectContaining({
        source: 'native-telemetry',
        event: { type: 'model:updated', intent: 'observed', model: { id: 'claude-haiku-4-5', provider: 'anthropic' } },
      }),
    ]);
    expect(models()[0]?.agentId).toBeUndefined();

    appendFileSync(childTranscript, transcriptRow(3, 'later-transcript-worker'));
    appendFileSync(transcript, transcriptRow(4));
    await session.pollTranscript();
    expect((await postOtlp()).status).toBe(200);
    expect(events.filter(({ event }) => event.type === 'usage:tokens-used')).toHaveLength(1);
    expect(models()).toHaveLength(1);

    const corrected = JSON.parse(otlpBody);
    const attributes = corrected.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    attributes.find(({ key }: { key: string }) => key === 'output_tokens').value = { intValue: '9' };
    attributes.push(attribute('agent.id', 'api-worker'), attribute('agent.type', 'researcher'));
    expect((await postOtlp(JSON.stringify(corrected))).status).toBe(200);
    expect(events.filter(({ event }) => event.type === 'usage:tokens-used')).toHaveLength(2);
    expect(models()).toHaveLength(2);
    expect(models().at(-1)).toMatchObject({
      source: 'native-telemetry',
      agentId: 'api-worker',
      agentType: 'researcher',
      event: { type: 'model:updated', model: { id: 'claude-haiku-4-5' } },
    });
    expect(events.filter(({ event }) => event.type === 'usage:tokens-used').at(-1)).toMatchObject({
      source: 'native-telemetry',
      agentId: 'api-worker',
      agentType: 'researcher',
      event: { usageId: 'claude-request:request-otel', totalTokens: 139, meterTokens: 19, costUsd: 0.125 },
    });
    expect((await postOtlp(JSON.stringify(corrected))).status).toBe(200);
    expect(events.filter(({ event }) => event.type === 'usage:tokens-used')).toHaveLength(2);
  });

  describe('permission decisions on the OTLP logs rail', () => {
    // https://code.claude.com/docs/en/monitoring-usage#tool-decision-event
    async function startDecidingSession() {
      const started = await startSession({ providerVersion: '2.1.245' });
      const { session, prepared, token, events } = started;
      const decide = async (fields: Record<string, string>) => {
        const response = await fetch(prepared.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            resourceLogs: [
              {
                scopeLogs: [
                  {
                    logRecords: [
                      {
                        body: { stringValue: 'claude_code.tool_decision' },
                        attributes: Object.entries({
                          'event.name': 'tool_decision',
                          'event.timestamp': '2026-10-27T12:00:05.000Z',
                          'session.id': session.sessionId,
                          tool_name: 'Bash',
                          ...fields,
                        }).map(([key, value]) => ({ key, value: { stringValue: value } })),
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        });
        expect(response.status).toBe(200);
      };
      const resolved = () => events.filter(({ event }) => event.type === 'interaction:permission-resolved');
      return { ...started, decide, resolved };
    }

    it('clears the wait at the person’s accept, before the approved tool ends', async () => {
      const { session, projection, events, hook, decide, resolved } = await startDecidingSession();
      await hook('SessionStart', {});
      await hook('UserPromptSubmit', { prompt: 'slow', prompt_id: 'p-slow' });
      const call = { prompt_id: 'p-slow', tool_name: 'Bash', tool_input: { command: 'sleep 45' } };
      await hook('PreToolUse', { ...call, tool_use_id: 'toolu_slow' });
      await hook('PermissionRequest', call);
      expect(projection.state.permissions.size).toBe(1);
      expect((await session.services.prompt.submit({ text: 'blocked' })).status).toBe('rejected');

      await decide({ tool_use_id: 'toolu_slow', decision: 'accept', source: 'user_temporary' });
      expect(projection.state.permissions.size).toBe(0);
      expect(resolved()).toEqual([
        expect.objectContaining({
          source: 'native-telemetry',
          promptId: 'p-slow',
          event: { type: 'interaction:permission-resolved', requestId: expect.any(String), outcome: 'allowed' },
        }),
      ]);
      const receipt = session.services.prompt.submit({ text: 'queued while it runs' });

      // The tool ends 45 s later: its completion closes the tool, never the request a second time.
      await hook('PostToolUse', { ...call, tool_use_id: 'toolu_slow', tool_response: { output: '' } });
      expect(resolved()).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ type: 'tool:completed', toolCallId: 'toolu_slow' }),
        }),
      );

      await hook('UserPromptSubmit', { prompt: 'queued while it runs', prompt_id: 'p-queued' });
      expect((await receipt).status).toBe('confirmed');
    });

    it('closes the request at the person’s reject; a decision that closes nothing stays native', async () => {
      const { projection, events, hook, decide, resolved } = await startDecidingSession();
      await hook('SessionStart', {});
      await hook('UserPromptSubmit', { prompt: 'risky', prompt_id: 'p-risky' });
      const call = { prompt_id: 'p-risky', tool_name: 'Bash', tool_input: { command: 'rm x' } };
      await hook('PreToolUse', { ...call, tool_use_id: 'toolu_risky' });
      await hook('PermissionRequest', call);

      // A rule decided another call without asking.
      await decide({ tool_use_id: 'toolu_ruled', decision: 'accept', source: 'config' });
      expect(projection.state.permissions.size).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          source: 'native-telemetry',
          event: expect.objectContaining({ type: 'adapter:native-event', nativeType: 'otel:tool_decision' }),
        }),
      );

      await decide({ tool_use_id: 'toolu_risky', decision: 'reject', source: 'user_reject' });
      expect(projection.state.permissions.size).toBe(0);
      expect(resolved()).toEqual([
        expect.objectContaining({
          source: 'native-telemetry',
          promptId: 'p-risky',
          event: { type: 'interaction:permission-resolved', requestId: expect.any(String), outcome: 'denied' },
        }),
      ]);

      await hook('Stop', { prompt_id: 'p-risky', last_assistant_message: 'Not run.' });
      expect(resolved()).toHaveLength(1);
    });

    it('settles at PostToolUse when no decision arrived, and a late decision closes nothing twice', async () => {
      const { projection, hook, decide, resolved } = await startDecidingSession();
      await hook('SessionStart', {});
      await hook('UserPromptSubmit', { prompt: 'quick', prompt_id: 'p-quick' });
      const call = { prompt_id: 'p-quick', tool_name: 'Bash', tool_input: { command: 'echo hi' } };
      await hook('PreToolUse', { ...call, tool_use_id: 'toolu_quick' });
      await hook('PermissionRequest', call);

      await hook('PostToolUse', { ...call, tool_use_id: 'toolu_quick', tool_response: { output: 'hi' } });
      expect(projection.state.permissions.size).toBe(0);
      expect(resolved()).toEqual([
        expect.objectContaining({
          source: 'native-hook',
          event: { type: 'interaction:permission-resolved', requestId: expect.any(String), outcome: 'allowed' },
        }),
      ]);

      // OTLP exports in batches: the decision can land after a fast tool already ended.
      await decide({ tool_use_id: 'toolu_quick', decision: 'accept', source: 'user_temporary' });
      expect(resolved()).toHaveLength(1);
    });
  });

  it('ignores root and child transcript metadata and models while observing live root text', async () => {
    const { session, projection, events, hook } = await startSession();
    const dir = mkdtempSync(join(tmpdir(), 'driver-no-transcript-metadata-'));
    try {
      const row = (fields: Record<string, unknown>) =>
        JSON.stringify({ sessionId: session.sessionId, ...fields }) + '\n';
      const transcript = join(dir, `${session.sessionId}.jsonl`);
      writeFileSync(
        transcript,
        Array.from({ length: 2_000 }, (_, index) => row({ type: 'attachment', uuid: `metadata-${index}` })).join(''),
      );
      const children = join(dir, session.sessionId, 'subagents');
      mkdirSync(children, { recursive: true });
      const childTranscript = join(children, 'agent-worker.jsonl');
      writeFileSync(childTranscript, row({ type: 'future-type', uuid: 'child-metadata', agentId: 'worker' }));
      const unknownEvents = projection.state.counters.unknownEvents;

      await hook('SessionStart', { transcript_path: transcript });
      await session.pollTranscript();
      const transcriptEvents = () => events.filter(({ source }) => source === 'native-transcript');
      expect(transcriptEvents()).toEqual([]);
      expect(projection.state.counters.unknownEvents).toBe(unknownEvents);

      appendFileSync(transcript, row({ type: 'progress', uuid: 'later-metadata' }) + row({ uuid: 'untyped-metadata' }));
      appendFileSync(childTranscript, row({ type: 'system', uuid: 'later-child-metadata', agentId: 'worker' }));
      await session.pollTranscript();
      expect(transcriptEvents()).toEqual([]);
      expect(projection.state.counters.unknownEvents).toBe(unknownEvents);

      appendFileSync(
        transcript,
        row({
          type: 'assistant',
          uuid: 'live-reply',
          message: { role: 'assistant', model: 'root-model', content: 'New reply' },
        }),
      );
      appendFileSync(
        childTranscript,
        row({
          type: 'assistant',
          uuid: 'child-reply',
          agentId: 'worker',
          message: { role: 'assistant', model: 'child-model', content: 'Child reply' },
        }),
      );
      await session.pollTranscript();
      expect(transcriptEvents().map(({ event }) => event.type)).toEqual(['conversation:assistant-message']);
      expect(projection.state.lastAssistantMessage).toBe('New reply');
      expect(events.filter(({ event }) => event.type === 'model:updated')).toEqual([]);
      expect(projection.state.environment.model).toBeUndefined();
      expect(projection.state.counters.unknownEvents).toBe(unknownEvents);
    } finally {
      projection.dispose();
      await session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    'keeps hook/status models independent of transcript text when OTLP is enabled=%s',
    async (enabled) => {
      const { session, projection, events, hook, statusLine, subagentStatusLine } = await startSession({
        providerVersion: '2.1.245',
        observeOtlpUsage: enabled,
      });
      const dir = mkdtempSync(join(tmpdir(), 'driver-transcript-'));
      const project = join(dir, '.claude', 'projects', '-driver-test');
      mkdirSync(project, { recursive: true });
      const transcript = join(project, `${session.sessionId}.jsonl`);
      writeFileSync(transcript, '');

      await hook('SessionStart', { transcript_path: transcript, model: 'hook-model' });
      expect(session.transcriptPath()).toBe(transcript);
      await session.pollTranscript();
      expect(projection.state.environment.model?.value.id).toBe('hook-model');

      writeFileSync(
        transcript,
        `${JSON.stringify({
          parentUuid: null,
          type: 'assistant',
          uuid: 'u1',
          timestamp: '2026-07-13T00:00:00.000Z',
          sessionId: session.sessionId,
          cwd: '/tmp',
          version: '1',
          gitBranch: 'main',
          isSidechain: false,
          userType: 'external',
          requestId: 'request-1',
          message: {
            id: 'msg_real',
            type: 'message',
            role: 'assistant',
            model: 'm',
            content: [{ type: 'text', text: 'authoritative answer' }],
            stop_reason: null,
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 3,
            },
          },
        })}\n`,
      );
      await session.pollTranscript();

      await vi.waitFor(
        () => {
          const fromTranscript = events.find((e) => e.source === 'native-transcript');
          expect(fromTranscript?.event).toMatchObject({
            type: 'conversation:assistant-message',
            text: 'authoritative answer',
            displayOnly: false,
          });
          expect(projection.state.lastAssistantMessage).toBe('authoritative answer');
          expect(events.filter(({ event }) => event.type === 'usage:tokens-used')).toEqual([]);
          expect(events.filter(({ event }) => event.type === 'model:updated')).toEqual([
            expect.objectContaining({
              source: 'native-hook',
              event: expect.objectContaining({ model: { id: 'hook-model', provider: 'anthropic' } }),
            }),
          ]);
          expect(projection.state.environment.model?.value.id).toBe('hook-model');
        },
        { timeout: 10_000, interval: 20 },
      );

      await statusLine({ model: { id: 'status-model', display_name: 'Status Model' } });
      await hook('SubagentStart', { agent_id: 'worker', agent_type: 'researcher' });
      await subagentStatusLine({ tasks: [{ id: 'worker', model: 'child-status-model' }] });
      await session.pollTranscript();
      expect(projection.state.environment.model?.value).toEqual({
        id: 'status-model',
        displayName: 'Status Model',
        provider: 'anthropic',
      });
      expect(projection.monitorBatches.at(-1)?.updates).toContainEqual(
        expect.objectContaining({
          family: 'model',
          values: [
            expect.objectContaining({ value: expect.objectContaining({ providerModelId: 'child-status-model' }) }),
          ],
        }),
      );
      expect(
        events.filter(({ source, event }) => source === 'native-transcript' && event.type === 'model:updated'),
      ).toEqual([]);
    },
  );

  it('rejects token usage from an injected durable observer during replay and live delivery', async () => {
    let deliver: ((event: SemanticObservationEvent) => void) | undefined;
    const provider: SemanticObservationProvider = {
      capabilities: () => Promise.resolve([]),
      attach: () =>
        Promise.resolve({
          onEvent(listener) {
            deliver = listener;
            return () => undefined;
          },
          onBatch: () => () => undefined,
          onError: () => () => undefined,
          poll: () => Promise.resolve(),

          dispose: () => Promise.resolve(),
        }),
    };
    const { session, events, hook } = await startSession({ semanticProviderFactory: () => provider });
    await hook('SessionStart', { transcript_path: '/tmp/claude-no-durable-usage.jsonl' });
    await session.pollTranscript();
    expect(deliver).toBeTypeOf('function');
    for (const replay of [true, false]) {
      deliver!({
        timestamp: new Date().toISOString(),
        replay,
        event: {
          type: 'usage:tokens-used',
          usageId: `durable-usage-${replay}`,
          boundary: 'response',
          canonical: true,
          totalTokens: 100,
          meterTokens: 100,
        },
      });
    }
    expect(events.filter(({ event }) => event.type === 'usage:tokens-used')).toEqual([]);
  });

  it('retries a transient semantic attachment failure on the next native hook', async () => {
    let attachAttempts = 0;
    let polls = 0;
    const provider: SemanticObservationProvider = {
      capabilities: () => Promise.resolve([]),
      attach: () => {
        attachAttempts += 1;
        if (attachAttempts === 1) return Promise.reject(new Error('transient attach failure'));
        return Promise.resolve({
          onEvent: () => () => undefined,
          onBatch: () => () => undefined,
          onError: () => () => undefined,
          poll: () => {
            polls += 1;
            return Promise.resolve();
          },

          dispose: () => Promise.resolve(),
        });
      },
    };
    const { session, events, hook } = await startSession({ semanticProviderFactory: () => provider });
    const transcriptPath = '/tmp/claude-semantic-retry.jsonl';

    await hook('SessionStart', { transcript_path: transcriptPath });
    await Promise.resolve();
    expect(attachAttempts).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ nativeType: 'semantic-observer.unavailable' }),
      }),
    );

    await hook('InstructionsLoaded', {
      transcript_path: transcriptPath,
      file_path: '/tmp/CLAUDE.md',
      memory_type: 'Project',
      load_reason: 'session_start',
    });
    await session.pollTranscript();
    expect(attachAttempts).toBe(2);
    expect(polls).toBe(3); // initial attach, hook hint, and explicit refresh
  });

  it('routes semantic observer errors through the normalized candidate stream', async () => {
    let reportError: ((error: Error) => void) | undefined;
    const provider: SemanticObservationProvider = {
      capabilities: () => Promise.resolve([]),
      attach: () =>
        Promise.resolve({
          onEvent: () => () => undefined,
          onBatch: () => () => undefined,
          onError(listener) {
            reportError = listener;
            return () => undefined;
          },
          poll: () => Promise.resolve(),

          dispose: () => Promise.resolve(),
        }),
    };
    const { events, hook } = await startSession({ semanticProviderFactory: () => provider });

    await hook('SessionStart', { transcript_path: '/tmp/claude-semantic-error.jsonl' });
    await vi.waitFor(() => expect(reportError).toBeTypeOf('function'));
    reportError!(Object.assign(new Error('/tmp/private/error'), { code: 'EIO' }));

    expect(events.at(-1)).toMatchObject({
      source: 'runtime',
      event: { type: 'adapter:native-event', nativeType: 'semantic-observer.error' },
      nativeEvent: { name: 'Error', code: 'EIO' },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('/tmp/private/error');
  });

  it('tracks Claude context from status-line JSON and retracts both projections after compaction', async () => {
    const { projection, events, hook, statusLine } = await startSession();
    const monitorBatches = projection.monitorBatches;
    await statusLine({
      model: { id: 'claude-fable-5', display_name: 'Fable 5' },
      context_window: {
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 8_500,
          output_tokens: 9_999,
          cache_creation_input_tokens: 5_000,
          cache_read_input_tokens: 2_000,
        },
      },
    });

    expect(projection.state.contextWindow).toMatchObject({
      usedTokens: 15_500,
      capacityTokens: 200_000,
      usedPercent: 7.75,
      modelId: 'claude-fable-5',
      source: 'native-statusline',
    });
    expect(events.filter(({ event }) => event.type === 'context-window:updated')).toHaveLength(1);

    await statusLine({ context_window: { context_window_size: 200_000, current_usage: null } });
    expect(projection.state.contextWindow).toBeUndefined();
    expect(events.at(-1)?.event).toEqual({ type: 'context-window:invalidated', reason: 'provider-reset' });

    await statusLine({
      context_window: {
        context_window_size: 200_000,
        current_usage: { input_tokens: 11_000, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 3_000 },
      },
    });
    expect(projection.state.contextWindow?.usedTokens).toBe(16_000);

    await hook('PostCompact', { trigger: 'manual', compact_summary: 'Synthetic summary.' });

    expect(projection.state.contextWindow).toBeUndefined();
    expect(events.at(-1)?.event).toEqual({ type: 'context-window:invalidated', reason: 'compacted' });
    const rootBatches = monitorBatches.filter(({ producer }) => producer.id === 'claude:status-root');
    expect(rootBatches.at(-1)).toMatchObject({
      producer: { id: 'claude:status-root', sequence: 4 },
      evidence: [{ namespace: 'claude-native-hook' }],
      updates: [{ family: 'context', operation: 'replace', values: [], coverage: 'complete' }],
    });
  });

  it('takes a landed model switch from the hook rail without repeating or erasing the status line', async () => {
    const { projection, events, hook, statusLine } = await startSession();
    const modelEvents = () =>
      events.filter(({ event }) => event.type === 'model:updated' && event.intent !== 'configured');
    await statusLine({ model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet 4.5' } });
    // The switch lands before the next status-line refresh: the hook rail reports it at once.
    await hook('PostModelSwitch', {
      from_model: 'claude-sonnet-4-5-20250929',
      to_model: 'claude-opus-5-5',
      requested_model: 'claude-opus-4-1-20250805',
      source: 'command',
    });
    expect(projection.state.environment.model?.value).toEqual({ id: 'claude-opus-5-5', provider: 'anthropic' });
    await statusLine({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'medium' } });
    // The same id again, from the hook rail: not news, and the status line's display name stays.
    await hook('PostModelSwitch', {
      from_model: 'claude-sonnet-4-5-20250929',
      to_model: 'claude-opus-5-5',
      requested_model: null,
      source: 'auto',
    });
    await hook('SessionStart', { source: 'resume', model: 'claude-opus-5-5' });
    expect(modelEvents().map(({ source, event }) => [source, event])).toEqual([
      [
        'native-statusline',
        {
          type: 'model:updated',
          intent: 'observed',
          model: { id: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', provider: 'anthropic' },
        },
      ],
      [
        'native-hook',
        { type: 'model:updated', intent: 'observed', model: { id: 'claude-opus-5-5', provider: 'anthropic' } },
      ],
      [
        'native-statusline',
        {
          type: 'model:updated',
          intent: 'observed',
          model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5', provider: 'anthropic' },
        },
      ],
    ]);
    expect(projection.state.environment.model?.value).toEqual({
      id: 'claude-opus-5-5',
      displayName: 'Opus 5.5',
      provider: 'anthropic',
    });
    // A subagent's own switch is actor-scoped evidence, never deduplicated against the root.
    await hook('PostModelSwitch', {
      agent_id: 'agent-3',
      agent_type: 'Explore',
      from_model: 'claude-opus-5-5',
      to_model: 'claude-opus-5-5',
      requested_model: null,
      source: 'auto',
    });
    expect(modelEvents().at(-1)).toMatchObject({ source: 'native-hook', agentId: 'agent-3' });
  });

  it('lets the next status line restore its card after a switch away and back between refreshes', async () => {
    const { projection, hook, statusLine } = await startSession();
    const sonnet = { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet 4.5' };
    await statusLine({ model: sonnet });
    await hook('PostModelSwitch', { from_model: sonnet.id, to_model: 'claude-opus-5-5', source: 'command' });
    await hook('PostModelSwitch', { from_model: 'claude-opus-5-5', to_model: sonnet.id, source: 'command' });
    expect(projection.state.environment.model?.value).toEqual({ id: sonnet.id, provider: 'anthropic' });
    // The refresh reads exactly as the one before the switches; it is still news against the hooks.
    await statusLine({ model: sonnet });
    expect(projection.state.environment.model?.value).toEqual({
      id: sonnet.id,
      displayName: 'Sonnet 4.5',
      provider: 'anthropic',
    });
  });

  it('drops a PostModelSwitch that lands after a later switch, and the status line stays authoritative', async () => {
    const { projection, events, hook, statusLine } = await startSession();
    const rootModels = () =>
      events
        .filter(({ event, agentId }) => event.type === 'model:updated' && event.intent !== 'configured' && !agentId)
        .map(({ event }) => (event.type === 'model:updated' ? event.model?.id : undefined));
    await statusLine({ model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet 4.5' } });
    // The person switches sonnet → opus-4-1 → opus-5-5; Claude runs each PostModelSwitch as a
    // detached task, and the second switch's hook arrives first: it starts from a model never reported.
    await hook('PostModelSwitch', {
      from_model: 'claude-opus-4-1-20250805',
      to_model: 'claude-opus-5-5',
      source: 'command',
    });
    await statusLine({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } });
    await hook('PostModelSwitch', {
      from_model: 'claude-sonnet-4-5-20250929',
      to_model: 'claude-opus-4-1-20250805',
      source: 'command',
    });
    await statusLine({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } });
    expect(rootModels()).toEqual(['claude-sonnet-4-5-20250929', 'claude-opus-5-5']);
    expect(projection.state.environment.model?.value).toEqual({
      id: 'claude-opus-5-5',
      displayName: 'Opus 5.5',
      provider: 'anthropic',
    });
    // A switch the next refresh contradicts is corrected by it, card and all.
    await hook('PostModelSwitch', { from_model: 'claude-opus-5-5', to_model: 'claude-haiku-5-5', source: 'auto' });
    await statusLine({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } });
    expect(projection.state.environment.model?.value).toEqual({
      id: 'claude-opus-5-5',
      displayName: 'Opus 5.5',
      provider: 'anthropic',
    });
  });

  it('publishes root and correlated child status evidence through the monitor SPI', async () => {
    const { projection, hook, statusLine, subagentStatusLine } = await startSession();
    const batches = projection.monitorBatches;
    await hook('SubagentStart', { agent_id: 'agent-7', agent_type: 'Explore' });
    await statusLine({
      model: { id: 'claude-opus-5', display_name: 'Opus 5' },
      effort: { level: 'xhigh' },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 19.5,
        current_usage: {
          input_tokens: 10_000,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 3_000,
        },
      },
    });
    await subagentStatusLine({
      tasks: [
        {
          id: 'agent-7',
          name: 'reviewer',
          status: 'running',
          label: 'Reviewing patch',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          contextWindowSize: 200_000,
          tokenCount: 42_000,
        },
      ],
    });

    const root = batches.find(({ producer }) => producer.id === 'claude:status-root');
    const child = batches.find(({ producer }) => producer.id === 'claude:status-child');
    expect(root?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'context',
          values: [
            expect.objectContaining({
              value: expect.objectContaining({ usedPercentage: 19.5, percentageSource: 'provider' }),
            }),
          ],
        }),
        expect.objectContaining({ family: 'model' }),
        expect.objectContaining({ family: 'effort' }),
      ]),
    );
    expect(root?.updates.some(({ family }) => family === 'usage')).toBe(false);
    expect(child?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'status',
          value: expect.objectContaining({ active: true, line: 'Reviewing patch' }),
        }),
      ]),
    );
    expect(child?.updates.some(({ family }) => family === 'usage' || family === 'context')).toBe(false);
  });

  it('dispose tears down the bridge and removes the generated settings', async () => {
    const { session, prepared, hook } = await startSession();
    await hook('SessionStart', {});
    expect(existsSync(prepared.settingsPath)).toBe(true);

    await session.dispose();
    sessions = [];
    expect(existsSync(prepared.settingsPath)).toBe(false);
  });

  it('/clear rebinds native identity while keeping the same terminal runtime alive', async () => {
    const { session, projection, events, hook, endpoint, token } = await startSession();
    const before = session.sessionId;
    const after = '64a61b19-f4d8-4f96-ba56-07024b4708aa';
    await hook('SessionStart', { source: 'startup' });
    await hook('SessionEnd', { reason: 'clear' });
    expect(projection.state.lifecycle).toBe('exited');

    await hook('SessionStart', { session_id: after, source: 'clear' });
    expect(session.runtimeSessionId).toBe('rt-1');
    expect(session.sessionId).toBe(after);
    expect(projection.state.lifecycle).toBe('ready');
    expect(
      events.find(({ event }) => event.type === 'session:started' && event.nativeSessionId === after)?.event,
    ).toMatchObject({
      type: 'session:started',
      nativeSessionId: after,
      rebind: true,
    });

    const stale = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: before, cwd: '/tmp', hook_event_name: 'Stop' }),
    });
    expect(stale.status).toBe(403);
  });

  it('degrades hook observation on rail loss without ending the live session', async () => {
    let hookListener: ((envelope: NativeHookEnvelope) => void) | undefined;
    let unavailableListener: ((reason: string) => void) | undefined;
    const bridge: HookBridge = {
      token: 'fake-hook-token',
      endpoint: () => 'http://127.0.0.1:9/hooks',
      statusLineEndpoint: () => 'http://127.0.0.1:9/statusline',
      subagentStatusLineEndpoint: () => 'http://127.0.0.1:9/subagent-statusline',
      otelLogsEndpoint: () => 'http://127.0.0.1:9/v1/logs',
      async start() {},
      onEvent(listener) {
        hookListener = listener;
        return () => {
          hookListener = undefined;
        };
      },
      onStatusLine() {
        return () => undefined;
      },
      onSubagentStatusLine() {
        return () => undefined;
      },
      onOtelLogs() {
        return () => undefined;
      },
      onUnavailable(listener) {
        unavailableListener = listener;
        return () => {
          unavailableListener = undefined;
        };
      },
      async dispose() {},
    };
    const prepared = await prepareClaudeTuiSession({
      cwd: '/tmp',
      hookBridgeFactory: () => bridge,
      automate: async () => ({ accepted: true }),
    });
    const session = await prepared.adopt('rail-pane');
    sessions.push(session);
    const projection = projectAgentEvents(session);
    const events = projection.envelopes;
    const monitorBatches = projection.monitorBatches;
    hookListener?.({
      requestId: 'hook-start',
      receivedAt: '2026-08-16T20:00:00.000Z',
      body: {
        session_id: session.sessionId,
        cwd: '/tmp',
        hook_event_name: 'SessionStart',
        source: 'startup',
      },
    });
    expect(session.observationLevel()).toBe('native-hooks');
    expect(projection.state.lifecycle).toBe('ready');

    unavailableListener?.('listener failed');
    expect(session.observationLevel()).toBe('terminal-only');
    expect(projection.state.lifecycle).toBe('ready');
    expect(events.at(-1)).toMatchObject({
      source: 'runtime',
      event: { type: 'adapter:native-event', nativeType: 'hook-bridge.unavailable' },
      nativeEvent: { reason: 'listener failed' },
    });
    expect(monitorBatches.at(-1)).toMatchObject({
      readiness: 'degraded',
      completeness: 'unavailable',
      updates: [],
    });
    expect(events.some(({ event }) => event.type === 'session:exited' || event.type === 'process:exited')).toBe(false);
  });

  it('closes the real hook listener for an explicit canary fault without ending the session', async () => {
    const { session, projection, hook, endpoint, token, events } = await startSession({
      hookRailFaultInjection: {
        afterHookEvent: 'Stop',
        reason: 'test canary rail fault',
      },
    });
    const monitorBatches = projection.monitorBatches;
    const degradedObservationLevels: string[] = [];
    session.events.onCandidate(({ event }) => {
      if (event.type === 'monitor:batch' && event.batch.readiness === 'degraded') {
        degradedObservationLevels.push(session.observationLevel());
      }
    });

    await hook('SessionStart', { source: 'startup' });
    await hook('Stop', { last_assistant_message: 'still alive' });
    for (let attempt = 0; attempt < 100 && session.observationLevel() === 'native-hooks'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(session.observationLevel()).toBe('terminal-only');
    expect(degradedObservationLevels.at(-1)).toBe('terminal-only');
    expect(projection.state.lifecycle).toBe('ready');
    expect(monitorBatches.at(-1)).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });
    expect(events.at(-1)).toMatchObject({
      event: { type: 'adapter:native-event', nativeType: 'hook-bridge.unavailable' },
      nativeEvent: { reason: 'test canary rail fault' },
    });
    expect(events.some(({ event }) => event.type === 'session:exited' || event.type === 'process:exited')).toBe(false);
    await expect(
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          session_id: session.sessionId,
          cwd: '/tmp',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'after fault',
        }),
      }),
    ).rejects.toThrow();
  });

  it('resumes with the hook model without replaying historical conversation or models', async () => {
    const resumeId = '64a61b19-f4d8-4f96-ba56-07024b470813';
    const transcriptDirectory = mkdtempSync(join(tmpdir(), 'driver-resume-history-'));
    const projectDirectory = join(transcriptDirectory, '.claude', 'projects', '-driver-resume');
    mkdirSync(projectDirectory, { recursive: true });
    const transcript = join(projectDirectory, `${resumeId}.jsonl`);
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          parentUuid: null,
          type: 'user',
          uuid: 'history-prompt',
          timestamp: '2026-07-13T00:00:00.000Z',
          sessionId: resumeId,
          cwd: '/tmp',
          version: '1',
          gitBranch: 'main',
          isSidechain: false,
          userType: 'external',
          message: { role: 'user', content: [{ type: 'text', text: 'What did we decide?' }] },
        }),
        JSON.stringify({ type: 'attachment', uuid: 'history-metadata', sessionId: resumeId }),
        JSON.stringify({
          parentUuid: 'history-prompt',
          type: 'assistant',
          uuid: 'history-assistant',
          timestamp: '2026-07-13T00:00:01.000Z',
          sessionId: resumeId,
          cwd: '/tmp',
          version: '1',
          gitBranch: 'main',
          isSidechain: false,
          userType: 'external',
          requestId: 'history-request',
          message: {
            id: 'history-response',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-local',
            content: [{ type: 'text', text: 'Use the native resume path.' }],
            usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 5_000 },
          },
        }),
      ].join('\n') + '\n',
    );
    let prepared: PreparedClaudeSession | undefined;
    const session = await createClaudeSession({
      cwd: '/tmp',
      resume: resumeId,
      configDir: join(transcriptDirectory, '.claude'),
      ports: {
        spawn: async (p) => {
          prepared = p;
          return { runtimeSessionId: 'rt-resume' };
        },
        automate: async () => ({ accepted: true }),
      },
    });
    sessions.push(session);

    expect(session.sessionId).toBe(resumeId);
    expect(prepared!.args).toContain('--resume');
    expect(prepared!.args).not.toContain('--session-id');
    const historyEvents: AdapterEventCandidate[] = [];
    session.events.onCandidate((event) => historyEvents.push(event));

    // The bridge is scoped to the resumed id — a hook for it lands in state.
    const endpoint = (
      JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
      }
    ).hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${prepared!.env.PUPPETEER_HOOK_TOKEN}` },
      body: JSON.stringify({
        session_id: resumeId,
        transcript_path: transcript,
        cwd: '/tmp',
        hook_event_name: 'SessionStart',
        model: 'resumed-model',
      }),
    });
    expect(res.status).toBe(200);
    await session.pollTranscript();
    expect(session.observationLevel()).toBe('native-hooks');
    expect(historyEvents.filter((event) => event.replay)).toEqual([]);
    expect(historyEvents.filter(({ source }) => source === 'native-transcript')).toEqual([]);
    expect(historyEvents.filter(({ event }) => event.type === 'model:updated')).toEqual([
      expect.objectContaining({
        source: 'native-hook',
        event: { type: 'model:updated', model: { id: 'resumed-model', provider: 'anthropic' } },
      }),
    ]);
    expect(
      historyEvents.some(({ event }) => event.type.startsWith('turn:') || event.type.startsWith('conversation:')),
    ).toBe(false);
  });

  it('refuses a host’s own spawn whose person’s settings switch every hook off, launching nothing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'driver-hooks-off-cwd-'));
    const configDir = mkdtempSync(join(tmpdir(), 'driver-hooks-off-config-'));
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
    const spawn = vi.fn(async () => ({ runtimeSessionId: 'rt-hooks' }));
    const ports: ClaudeSessionPorts = { spawn, automate: async () => ({ accepted: true }) };

    await expect(createClaudeSession({ cwd, configDir, ports })).rejects.toMatchObject({
      name: 'ClaudeHooksOffError',
      code: 'CLAUDE_HOOKS_OFF',
      source: 'user',
    });
    expect(spawn).not.toHaveBeenCalled();

    // Hooks on: the same spawn launches as it always has.
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ disableAllHooks: false }));
    sessions.push(await createClaudeSession({ cwd, configDir, ports }));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('delivers live hooks during resume while the first durable read is still pending', async () => {
    let release!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const provider: SemanticObservationProvider = {
      capabilities: () => Promise.resolve([]),
      attach: () =>
        Promise.resolve({
          onEvent: () => () => undefined,
          onBatch: () => () => undefined,
          onError: () => () => undefined,
          poll: () => (++reads === 1 ? initialRead : Promise.resolve()),

          dispose: () => Promise.resolve(),
        }),
    };
    const prepared = await prepareClaudeTuiSession({
      cwd: '/tmp',
      resumeInvocation: ['--resume'],
      semanticProviderFactory: () => provider,
      automate: async () => ({ accepted: true }),
    });
    const session = await prepared.adopt('slow-transcript-pane');
    sessions.push(session);
    const projection = projectAgentEvents(session);
    const settings = JSON.parse(readFileSync(prepared.launch.settingsPath, 'utf8'));
    const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url;
    const post = (name: string, fields: Record<string, unknown> = {}) =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
        },
        body: JSON.stringify({
          session_id: '64a61b19-f4d8-4f96-ba56-07024b470891',
          transcript_path: '/tmp/slow-transcript.jsonl',
          cwd: '/tmp',
          hook_event_name: name,
          ...fields,
        }),
      });
    try {
      expect((await post('SessionStart', { source: 'resume' })).status).toBe(200);
      await vi.waitFor(() => expect(reads).toBe(1));
      expect((await post('UserPromptSubmit', { prompt_id: 'live-prompt', prompt: 'New prompt' })).status).toBe(200);
      expect(projection.state.lifecycle).toBe('running');
      expect(
        (
          await post('MessageDisplay', {
            prompt_id: 'live-prompt',
            turn_id: 'live-cycle',
            message_id: 'live-reply',
            delta: 'New reply',
            index: 0,
            final: true,
          })
        ).status,
      ).toBe(200);
      expect((await post('Stop', { prompt_id: 'live-prompt', last_assistant_message: 'New reply' })).status).toBe(200);
      expect(projection.state.lifecycle).toBe('ready');
      expect(projection.state.lastAssistantMessage).toBe('New reply');
      expect(projection.envelopes.filter(({ event }) => event.type === 'conversation:assistant-message')).toHaveLength(
        1,
      );
      expect(reads).toBe(1);
    } finally {
      release();
      await session.pollTranscript();
      projection.dispose();
    }
  });

  it('keeps the native resume picker and adopts the session selected after launch', async () => {
    const previewId = '64a61b19-f4d8-4f96-ba56-07024b470898';
    const selectedId = '64a61b19-f4d8-4f96-ba56-07024b470899';
    const prepared = await prepareClaudeTuiSession({
      cwd: '/tmp',
      resumeInvocation: ['--resume'],
      automate: async () => ({ accepted: true }),
    });
    expect(prepared.launch.args[0]).toBe('--resume');
    expect(prepared.launch.args).not.toContain('--session-id');
    const provisionalId = prepared.sessionId;
    const session = await prepared.adopt('resume-picker-pane');
    const projection = projectAgentEvents(session);
    expect(session.sessionId).toBe(provisionalId);

    const settings = JSON.parse(readFileSync(prepared.launch.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
    const transcriptDirectory = mkdtempSync(join(tmpdir(), 'driver-picker-baselines-'));
    const previewTranscript = join(transcriptDirectory, `${previewId}.jsonl`);
    const selectedTranscript = join(transcriptDirectory, `${selectedId}.jsonl`);
    for (const [path, id] of [
      [previewTranscript, previewId],
      [selectedTranscript, selectedId],
    ]) {
      writeFileSync(
        path!,
        JSON.stringify({
          type: 'assistant',
          uuid: `old-${id}`,
          sessionId: id,
          message: { role: 'assistant', content: 'Old picker conversation' },
        }) + '\n',
      );
    }
    // Claude can start the highlighted picker preview before the user commits
    // the final selection. A later SessionStart must be allowed to rebind.
    const previewStart = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: previewId,
        cwd: '/preview',
        hook_event_name: 'SessionStart',
        transcript_path: previewTranscript,
      }),
    });
    expect(previewStart.status).toBe(200);
    expect(session.sessionId).toBe(previewId);
    await session.pollTranscript();
    expect(projection.envelopes.some(({ event }) => event.type === 'conversation:assistant-message')).toBe(false);

    const preview = await fetch(prepared.launch.env.PUPPETEER_STATUSLINE_ENDPOINT!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: previewId,
        model: { id: 'claude-fable-5', display_name: 'Fable 5' },
        context_window: { context_window_size: 1_000_000, current_usage: {}, used_percentage: 13 },
      }),
    });
    expect(preview.status).toBe(200);
    expect(session.sessionId).toBe(previewId);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: selectedId,
        cwd: '/tmp',
        hook_event_name: 'SessionStart',
        transcript_path: selectedTranscript,
      }),
    });
    expect(response.status).toBe(200);
    expect(session.sessionId).toBe(selectedId);
    expect(projection.state.lifecycle).toBe('ready');
    await session.pollTranscript();
    expect(projection.envelopes.some(({ event }) => event.type === 'conversation:assistant-message')).toBe(false);

    const selectedStatus = await fetch(prepared.launch.env.PUPPETEER_STATUSLINE_ENDPOINT!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: selectedId,
        model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
        context_window: { context_window_size: 200_000, current_usage: {}, used_percentage: 16 },
      }),
    });
    expect(selectedStatus.status).toBe(200);
    expect(projection.state.environment.model?.value).toMatchObject({
      id: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku 4.5',
    });
    expect(projection.state.contextWindow?.usedPercent).toBe(16);

    const confirmed = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        session_id: selectedId,
        transcript_path: selectedTranscript,
        cwd: '/tmp',
        hook_event_name: 'InstructionsLoaded',
        load_reason: 'session_start',
      }),
    });
    expect(confirmed.status).toBe(200);
    expect(session.transcriptPath()).toBe(selectedTranscript);

    const stalePreviewStart = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({ session_id: previewId, cwd: '/preview', hook_event_name: 'SessionStart' }),
    });
    expect(stalePreviewStart.status).toBe(403);
    expect(session.sessionId).toBe(selectedId);

    const stalePreview = await fetch(prepared.launch.env.PUPPETEER_STATUSLINE_ENDPOINT!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({ session_id: previewId }),
    });
    expect(stalePreview.status).toBe(403);

    const selectedEnd = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({ session_id: selectedId, cwd: '/tmp', hook_event_name: 'SessionEnd', reason: 'clear' }),
    });
    expect(selectedEnd.status).toBe(200);

    const clearedId = '64a61b19-f4d8-4f96-ba56-07024b470900';
    const clearedStart = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({ session_id: clearedId, cwd: '/tmp', hook_event_name: 'SessionStart', source: 'clear' }),
    });
    expect(clearedStart.status).toBe(200);
    expect(session.sessionId).toBe(clearedId);
    expect(projection.state.lifecycle).toBe('ready');

    const staleSelected = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({ session_id: selectedId, cwd: '/tmp', hook_event_name: 'Stop' }),
    });
    expect(staleSelected.status).toBe(403);
    projection.dispose();
    await session.dispose();
  });

  it('binds a native resume to the session Claude announces, not the boot session that loads instructions first', async () => {
    // Claude 2.1.269 (probed 2026-09-11, packages/surface/vendors/claude/findings.md
    // §6.1): `claude --resume` boots a throwaway session and fires its
    // InstructionsLoaded before the picker is shown; the chosen session then
    // announces itself with a SessionStart whose source is `resume` and never
    // re-fires InstructionsLoaded.
    const bootId = '7f0d2c8e-1c3a-4c1e-9f3a-2d3c4b5a6f70';
    const selectedId = '7f0d2c8e-1c3a-4c1e-9f3a-2d3c4b5a6f71';
    const foreignId = '7f0d2c8e-1c3a-4c1e-9f3a-2d3c4b5a6f72';
    const prepared = await prepareClaudeTuiSession({
      cwd: '/tmp',
      resumeInvocation: ['--resume'],
      automate: async () => ({ accepted: true }),
    });
    const session = await prepared.adopt('resume-picker-pane');
    const projection = projectAgentEvents(session);
    const provisionalId = session.sessionId;
    const settings = JSON.parse(readFileSync(prepared.launch.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
    };
    const post = (url: string, body: Record<string, unknown>) =>
      fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const transcripts = mkdtempSync(join(tmpdir(), 'driver-picker-boot-'));
    const bootTranscript = join(transcripts, `${bootId}.jsonl`);
    const selectedTranscript = join(transcripts, `${selectedId}.jsonl`);
    writeFileSync(bootTranscript, '');
    writeFileSync(selectedTranscript, '');
    const eventTypes = () => projection.envelopes.map(({ event }) => event.type);

    // The boot session, whether it announces itself or only loads
    // instructions, is acknowledged and never observed.
    const bootStart = await post(endpoint, {
      session_id: bootId,
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'startup',
      transcript_path: bootTranscript,
    });
    expect(bootStart.status).toBe(200);
    const bootInstructions = await post(endpoint, {
      session_id: bootId,
      cwd: '/tmp',
      hook_event_name: 'InstructionsLoaded',
      load_reason: 'session_start',
      transcript_path: bootTranscript,
    });
    expect(bootInstructions.status).toBe(200);
    expect(session.sessionId).toBe(provisionalId);
    expect(session.transcriptPath()).toBeUndefined();
    expect(eventTypes()).not.toContain('session:started');
    expect(eventTypes()).not.toContain('session:ready');

    // The announcement binds the bridge and the transcript it names.
    const announced = await post(endpoint, {
      session_id: selectedId,
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'resume',
      transcript_path: selectedTranscript,
    });
    expect(announced.status).toBe(200);
    expect(session.sessionId).toBe(selectedId);
    expect(projection.state.lifecycle).toBe('ready');
    await session.pollTranscript();
    expect(session.transcriptPath()).toBe(selectedTranscript);

    const status = await post(prepared.launch.env.PUPPETEER_STATUSLINE_ENDPOINT!, {
      session_id: selectedId,
      model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' },
      effort: { level: 'max' },
      context_window: { context_window_size: 1_000_000, current_usage: {}, used_percentage: 4 },
    });
    expect(status.status).toBe(200);
    expect(projection.state.environment.model?.value).toMatchObject({
      id: 'claude-fable-5-1',
      displayName: 'Fable 5.1',
    });
    expect(projection.state.contextWindow?.usedPercent).toBe(4);

    // A late boot hook is still dropped; the chosen session's first turn is
    // observed and makes the choice final.
    const bootEnd = await post(endpoint, {
      session_id: bootId,
      cwd: '/tmp',
      hook_event_name: 'SessionEnd',
      reason: 'other',
    });
    expect(bootEnd.status).toBe(200);
    expect(eventTypes()).not.toContain('session:exited');
    const prompt = await post(endpoint, {
      session_id: selectedId,
      cwd: '/tmp',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'typed after resume',
      prompt_id: 'p-resumed',
    });
    expect(prompt.status).toBe(200);
    expect(projection.state.lifecycle).toBe('running');
    const foreignStart = await post(endpoint, {
      session_id: foreignId,
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'resume',
    });
    expect(foreignStart.status).toBe(403);
    expect(session.sessionId).toBe(selectedId);
    projection.dispose();
    await session.dispose();
  });
});

describe('stable ingress: the bridge a host can pin, learn, and rebind (AR-4 / PU-1)', () => {
  it('releases the bound listener when the host cannot persist its ingress', async () => {
    let bound: { port: number; token: string } | undefined;
    let bridge: HookBridge | undefined;
    try {
      await expect(
        prepareClaudeTuiSession({
          cwd: '/tmp',
          automate: async () => ({ accepted: true }),
          hookBridgeFactory: (options) => (bridge = createHookBridge(options)),
          ingress: {
            onBound(value) {
              bound = value;
              throw new Error('ingress persistence failed');
            },
          },
        }),
      ).rejects.toThrow('ingress persistence failed');
      expect(bound).toBeDefined();
      const replacement = createHookBridge({ ...bound!, allowSession: () => true });
      try {
        await replacement.start();
      } finally {
        await replacement.dispose();
      }
    } finally {
      await bridge?.dispose();
    }
  });

  it('reports the bound ingress before launch, and an attach on the same port and token observes the running process', async () => {
    let bound: { port: number; token: string } | undefined;
    let prepared: PreparedClaudeSession | undefined;
    const automations: TerminalAutomationOperation[] = [];
    const launched = await createClaudeSession({
      cwd: '/tmp',
      ingress: { onBound: (value) => void (bound = value) },
      ports: {
        spawn: async (p) => {
          prepared = p;
          return { runtimeSessionId: 'rt-attach' };
        },
        automate: async (_id, operation) => {
          automations.push(operation);
          return { accepted: true };
        },
      },
    });
    // What the host learned is exactly what the process was launched against.
    expect(bound).toBeDefined();
    const settings = JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
    expect(Number(new URL(endpoint).port)).toBe(bound!.port);
    expect(prepared!.env.PUPPETEER_HOOK_TOKEN).toBe(bound!.token);
    const sessionId = launched.sessionId;

    // The host RELEASES (stable ingress): its bridge goes, the process and
    // everything it reads stay — the staged settings and the hook forwarder in
    // particular, which the running process execs on every hook. A plain
    // dispose is the close that removes them.
    await launched.dispose({ release: true });
    expect(existsSync(prepared!.settingsPath)).toBe(true);
    expect(existsSync(prepared!.hookForwarderPath)).toBe(true);
    const configDir = mkdtempSync(join(tmpdir(), 'driver-attach-root-'));
    const project = join(configDir, 'projects', '-tmp');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${sessionId}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({
        parentUuid: null,
        type: 'assistant',
        uuid: 'u-attach',
        timestamp: '2026-09-12T00:00:00.000Z',
        sessionId,
        cwd: '/tmp',
        version: '1',
        gitBranch: 'main',
        isSidechain: false,
        userType: 'external',
        requestId: 'request-attach',
        message: {
          id: 'msg_attach',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'still here' }],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      })}\n`,
    );

    // A new host rebinds the same ingress and adopts the same terminal.
    const attached = await attachClaudeTuiSession({
      sessionId,
      runtimeSessionId: 'rt-attach',
      cwd: '/tmp',
      ingress: bound!,
      configDir,
      automate: async (id, operation) => {
        expect(id).toBe('rt-attach');
        automations.push(operation);
        return { accepted: true };
      },
    });
    sessions.push(attached);
    const projection = projectAgentEvents(attached);
    expect(attached.sessionId).toBe(sessionId);
    expect(attached.runtimeSessionId).toBe('rt-attach');
    // The durable rail was armed from the transcript the id names, not from a hook.
    expect(attached.transcriptPath()).toBe(transcript);
    await attached.pollTranscript();
    // The rail is armed; what was already on disk is the silent baseline
    // (no conversation replay), so the first read observes nothing.
    await vi.waitFor(() => expect(attached.observationLevel()).toBe('native-log'));
    expect(projection.envelopes.some((e) => e.source === 'native-transcript')).toBe(false);
    // …and what the running process appends from now on is live.
    appendFileSync(
      transcript,
      `${JSON.stringify({
        parentUuid: 'u-attach',
        type: 'assistant',
        uuid: 'u-attach-2',
        timestamp: '2026-09-12T00:00:01.000Z',
        sessionId,
        cwd: '/tmp',
        version: '1',
        gitBranch: 'main',
        isSidechain: false,
        userType: 'external',
        requestId: 'request-attach-2',
        message: {
          id: 'msg_attach_2',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'after the restart, still here' }],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      })}\n`,
    );
    await attached.pollTranscript();
    await vi.waitFor(() => {
      const live = projection.envelopes.find((e) => e.source === 'native-transcript');
      expect(live?.event).toMatchObject({
        type: 'conversation:assistant-message',
        text: 'after the restart, still here',
      });
    });

    // The running process keeps posting to the ingress it was launched with;
    // the rebound bridge accepts its bearer and its session.
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bound!.token}` },
      body: JSON.stringify({
        session_id: sessionId,
        transcript_path: transcript,
        cwd: '/tmp',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'after the restart',
        prompt_id: 'p-attach',
      }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(attached.observationLevel()).toBe('native-hooks');
      expect(projection.envelopes.some((e) => e.source === 'native-hook')).toBe(true);
    });
    // A foreign session on the same bridge is still refused.
    const foreign = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bound!.token}` },
      body: JSON.stringify({ session_id: 'someone-else', cwd: '/tmp', hook_event_name: 'UserPromptSubmit' }),
    });
    expect(foreign.status).toBe(403);
    // …and automation routes to the adopted terminal.
    const receipt = await attached.services.prompt.submit({ text: 'hello again', mode: 'paste-only' });
    expect(receipt.status).not.toBe('rejected');
    expect(automations.at(-1)).toMatchObject({ kind: 'paste', text: 'hello again' });
    rmSync(configDir, { recursive: true, force: true });
    // the released launch files are the close's to remove
    await cleanupClaudeSession(prepared!);
  });

  it('follows a /clear typed while no host listened: the first hook under a new id that has a transcript rotates the attached session, once', async () => {
    let bound: { port: number; token: string } | undefined;
    let prepared: PreparedClaudeSession | undefined;
    const launched = await createClaudeSession({
      cwd: '/tmp',
      ingress: { onBound: (value) => void (bound = value) },
      ports: {
        spawn: async (p) => {
          prepared = p;
          return { runtimeSessionId: 'rt-rotate' };
        },
        automate: async () => ({ accepted: true }),
      },
    });
    const pinned = launched.sessionId;
    const settings = JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
    await launched.dispose({ release: true });
    const configDir = mkdtempSync(join(tmpdir(), 'driver-rotate-root-'));
    const project = join(configDir, 'projects', '-tmp');
    mkdirSync(project, { recursive: true });
    const rotated = '11111111-1111-4111-8111-111111111111';
    const line = (sessionId: string, uuid: string): string =>
      `${JSON.stringify({
        parentUuid: null,
        type: 'assistant',
        uuid,
        timestamp: '2026-09-12T00:00:00.000Z',
        sessionId,
        cwd: '/tmp',
        version: '1',
        gitBranch: 'main',
        isSidechain: false,
        userType: 'external',
        requestId: `request-${uuid}`,
        message: {
          id: `msg_${uuid}`,
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'x' }],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      })}\n`;
    writeFileSync(join(project, `${pinned}.jsonl`), line(pinned, 'u-pinned'));
    writeFileSync(join(project, `${rotated}.jsonl`), line(rotated, 'u-rotated'));
    const attached = await attachClaudeTuiSession({
      sessionId: pinned,
      runtimeSessionId: 'rt-rotate',
      cwd: '/tmp',
      ingress: bound!,
      configDir,
      automate: async () => ({ accepted: true }),
    });
    sessions.push(attached);
    projectAgentEvents(attached);
    expect(attached.transcriptPath()).toBe(join(project, `${pinned}.jsonl`));
    const post = (sessionId: string): Promise<Response> =>
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bound!.token}` },
        body: JSON.stringify({
          session_id: sessionId,
          cwd: '/tmp',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'after /clear',
          prompt_id: `p-${sessionId.slice(0, 4)}`,
        }),
      });
    // an id with no transcript under the root is a stranger, rotation or not
    expect((await post('22222222-2222-4222-8222-222222222222')).status).toBe(403);
    // the rotation: the new id has a transcript, and nothing has spoken since the attach
    expect((await post(rotated)).status).toBe(200);
    await vi.waitFor(() => expect(attached.transcriptPath()).toBe(join(project, `${rotated}.jsonl`)));
    // once heard, the selection is final: the old id does not rotate back
    expect((await post(pinned)).status).toBe(403);
    expect((await post(rotated)).status).toBe(200);
    rmSync(configDir, { recursive: true, force: true });
    await cleanupClaudeSession(prepared!);
  });

  it('fails an attach before adopting anything when the pinned port is taken', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const address = holder.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await expect(
        attachClaudeTuiSession({
          sessionId: '00000000-0000-4000-8000-00000000abcd',
          runtimeSessionId: 'rt-taken',
          cwd: '/tmp',
          ingress: { port, token: 'pinned' },
          automate: async () => ({ accepted: true }),
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
