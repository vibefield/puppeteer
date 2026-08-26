/**
 * Full-loop driver test: the test acts as Claude Code. The fake spawn port
 * captures the PreparedClaudeSession exactly as the pty-host would receive
 * it; the test then reads the generated settings file to discover the bridge
 * endpoint (proving the settings are what a real Claude would consume) and
 * POSTs fixture-shaped hook payloads with the env-carried token.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  safeParseAgentEvent,
  type AdapterEventCandidate,
  type AgentEventEnvelope,
  type TerminalAutomationOperation,
} from '@vibecook/puppeteer-core';
import { projectAgentSession } from '@vibecook/puppeteer-testing';
import { createClaudeSession, prepareClaudeTuiSession, type ClaudeSession } from './driver.js';
import type { PreparedClaudeSession } from './launch/prepare.js';
import type { ClaudeHookDiagnostic } from './normalizer.js';
import type { HookBridge, NativeHookEnvelope } from './observation/hook-bridge.js';
import type { SemanticObservationProvider } from './observation/semantic-provider.js';

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
    observeSubagentStatus?: boolean;
    hookRailFaultInjection?: Parameters<typeof createClaudeSession>[0]['hookRailFaultInjection'];
    onObservationPollHint?: Parameters<typeof createClaudeSession>[0]['onObservationPollHint'];
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
    observeSubagentStatus: options.observeSubagentStatus,
    hookRailFaultInjection: options.hookRailFaultInjection,
    onObservationPollHint: options.onObservationPollHint,
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
  const projection = projectAgentSession(session);

  const settings = JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; url?: string }> }>>;
  };
  const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url!;
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
    const res = await fetch(prepared!.env.PUPPETEER_STATUSLINE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: session.sessionId, ...fields }),
    });
    expect(res.status).toBe(200);
  };

  const subagentStatusLine = async (fields: Record<string, unknown>) => {
    const res = await fetch(prepared!.env.PUPPETEER_SUBAGENT_STATUSLINE_ENDPOINT, {
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
  it('keeps the child status channel absent when its rollout gate is disabled', async () => {
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

    const events: AgentEventEnvelope[] = [];
    const candidates: AdapterEventCandidate[] = [];
    first.onEvent((event) => events.push(event));
    expect(first.onEventCandidate).toBeTypeOf('function');
    first.onEventCandidate!((candidate) => candidates.push(candidate));
    const settings = JSON.parse(readFileSync(prepared.launch.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url!;
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
    expect(events.some((event) => event.event.type === 'turn.started')).toBe(true);
    const turn = candidates.find(({ type }) => type === 'state:turn-started');
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
      type: 'adapter.native-event',
      adapter: 'claude-code',
      nativeType: 'PreToolUse',
    });
    expect(projection.state.tools.size).toBe(0);
  });

  it('confirms injected prompts through the real bridge round-trip', async () => {
    const { session, automations, hook } = await startSession();
    await hook('SessionStart', {});

    const receiptPromise = session.submitPrompt({ text: 'injected task' });
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

    expect((await session.submitPrompt({ text: 'nope' })).status).toBe('rejected');
    expect(projection.state.permissions.size).toBe(1);

    await hook('PostToolUse', {
      prompt_id: 'p-2',
      tool_name: 'Bash',
      tool_input: { command: 'rm x' },
      tool_use_id: 'toolu_2',
      tool_response: { output: '' },
    });
    expect(projection.state.permissions.size).toBe(0);

    const receipt = session.submitPrompt({ text: 'now fine' });
    await hook('UserPromptSubmit', { prompt: 'now fine', prompt_id: 'p-3' });
    expect((await receipt).status).toBe('confirmed');
  });

  it('publishes configured intent separately and preserves observed hook actor/version metadata', async () => {
    const hints: Array<{ hookEventName: string }> = [];
    const { events, hook } = await startSession({
      model: 'configured-sonnet',
      effort: 'high',
      permissionMode: 'plan',
      providerVersion: '2.1.226',
      onObservationPollHint: (hint) => hints.push(hint),
    });
    const configured = events.find(
      (envelope) => envelope.event.type === 'session.environment.updated' && envelope.event.intent === 'configured',
    );
    expect(configured).toMatchObject({
      source: 'runtime',
      providerVersion: '2.1.226',
      event: {
        type: 'session.environment.updated',
        intent: 'configured',
        model: { id: 'configured-sonnet' },
        effort: 'high',
        providerPermissionMode: { raw: 'plan' },
      },
    });

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
      (envelope) => envelope.event.type === 'session.environment.updated' && envelope.event.intent === 'observed',
    );
    expect(observed).toMatchObject({
      source: 'native-hook',
      confidence: 'authoritative',
      agentId: 'agent-7',
      agentType: 'Explore',
      providerVersion: '2.1.999',
      event: {
        effort: 'future-ultra',
        providerPermissionMode: { raw: 'future-auto' },
      },
    });
    expect(hints).toContainEqual(expect.objectContaining({ hookEventName: 'UserPromptSubmit' }));
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
    const requested = events.find((envelope) => envelope.event.type === 'question.requested');
    expect(requested).toMatchObject({ confidence: 'inferred' });
    expect((await session.submitPrompt({ text: 'cannot bypass' })).status).toBe('rejected');

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
        event: { type: 'question.resolved', requestId: 'question:ask-1', outcome: 'answered' },
      }),
    );
    expect((await session.submitPrompt({ text: 'permission remains' })).status).toBe('rejected');

    await hook('Stop', { prompt_id: 'p-question', last_assistant_message: 'done' });
    const receipt = session.submitPrompt({ text: 'both blockers cleared' });
    await hook('UserPromptSubmit', { prompt: 'both blockers cleared', prompt_id: 'p-next' });
    expect((await receipt).status).toBe('confirmed');
  });

  it('feeds authoritative assistant text and usage from the typed scoped observer', async () => {
    const { session, projection, events, hook } = await startSession();
    const batches = projection.monitorBatches;
    const dir = mkdtempSync(join(tmpdir(), 'driver-transcript-'));
    const project = join(dir, '.claude', 'projects', '-driver-test');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${session.sessionId}.jsonl`);
    writeFileSync(transcript, '');

    await hook('SessionStart', { transcript_path: transcript });
    expect(session.transcriptPath()).toBe(transcript);
    await session.pollTranscript();

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
          type: 'assistant.message',
          text: 'authoritative answer',
          displayOnly: false,
        });
        expect(projection.state.lastAssistantMessage).toBe('authoritative answer');
        const scoped = JSON.stringify(batches.filter(({ producer }) => producer.id === 'claude:spaghetti-scoped'));
        expect(scoped).toContain('"canonical":true');
        expect(scoped).toContain('"inputTokens":12');
        expect(scoped).toContain('"outputTokens":4');
      },
      { timeout: 10_000, interval: 20 },
    );
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
          readArtifact: () => Promise.resolve({ status: 'unavailable', message: 'not exposed' }),
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
    expect(events.filter(({ event }) => event.type === 'context-window.updated')).toHaveLength(1);

    await statusLine({ context_window: { context_window_size: 200_000, current_usage: null } });
    expect(projection.state.contextWindow).toBeUndefined();
    expect(events.at(-1)?.event).toEqual({ type: 'context-window.invalidated', reason: 'provider-reset' });

    await statusLine({
      context_window: {
        context_window_size: 200_000,
        current_usage: { input_tokens: 11_000, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 3_000 },
      },
    });
    expect(projection.state.contextWindow?.usedTokens).toBe(16_000);

    await hook('PostCompact', { trigger: 'manual', compact_summary: 'Synthetic summary.' });

    expect(projection.state.contextWindow).toBeUndefined();
    expect(events.at(-1)?.event).toEqual({ type: 'context-window.invalidated', reason: 'compacted' });
    const rootBatches = monitorBatches.filter(({ producer }) => producer.id === 'claude:status-root');
    expect(rootBatches.at(-1)).toMatchObject({
      producer: { id: 'claude:status-root', sequence: 4 },
      evidence: [{ namespace: 'claude-native-hook' }],
      updates: [{ family: 'context', operation: 'replace', values: [], coverage: 'complete' }],
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
          family: 'usage',
          values: [
            expect.objectContaining({
              value: expect.objectContaining({
                canonical: false,
                actor: expect.objectContaining({ nativeAgentId: 'agent-7' }),
              }),
            }),
          ],
        }),
        expect.objectContaining({
          family: 'status',
          value: expect.objectContaining({ active: true, line: 'Reviewing patch' }),
        }),
      ]),
    );
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
      events.find(({ event }) => event.type === 'session.started' && event.nativeSessionId === after)?.event,
    ).toMatchObject({
      type: 'session.started',
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
    const projection = projectAgentSession(session);
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
      event: { type: 'adapter.native-event', nativeType: 'hook-bridge.unavailable' },
      nativeEvent: { reason: 'listener failed' },
    });
    expect(monitorBatches.at(-1)).toMatchObject({
      readiness: 'degraded',
      completeness: 'unavailable',
      updates: [],
    });
    expect(events.some(({ event }) => event.type === 'session.exited' || event.type === 'process.exited')).toBe(false);
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
    session.onEvent(({ event }) => {
      if (event.type === 'monitor.batch' && event.batch.readiness === 'degraded') {
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
      event: { type: 'adapter.native-event', nativeType: 'hook-bridge.unavailable' },
      nativeEvent: { reason: 'test canary rail fault' },
    });
    expect(events.some(({ event }) => event.type === 'session.exited' || event.type === 'process.exited')).toBe(false);
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

  it('resume spawns with the resumed id and its bridge accepts only that session', async () => {
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
          },
        }),
      ].join('\n') + '\n',
    );
    let prepared: PreparedClaudeSession | undefined;
    const session = await createClaudeSession({
      cwd: '/tmp',
      resume: resumeId,
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
    const historyEvents: AgentEventEnvelope[] = [];
    session.onEvent((event) => historyEvents.push(event));

    // The bridge is scoped to the resumed id — a hook for it lands in state.
    const endpoint = (
      JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
      }
    ).hooks.UserPromptSubmit[0].hooks[0].url!;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${prepared!.env.PUPPETEER_HOOK_TOKEN}` },
      body: JSON.stringify({
        session_id: resumeId,
        transcript_path: transcript,
        cwd: '/tmp',
        hook_event_name: 'SessionStart',
      }),
    });
    expect(res.status).toBe(200);
    await session.pollTranscript();
    expect(session.observationLevel()).toBe('native-hooks');
    expect(historyEvents.filter((event) => event.replay).map((event) => event.event)).toEqual([
      { type: 'turn.started', turnId: 'history-prompt', prompt: 'What did we decide?' },
      {
        type: 'assistant.message',
        messageId: 'history-assistant',
        turnId: 'history-prompt',
        text: 'Use the native resume path.',
        final: true,
        displayOnly: false,
      },
      {
        type: 'turn.completed',
        turnId: 'history-prompt',
        lastAssistantMessage: 'Use the native resume path.',
      },
    ]);
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
    const projection = projectAgentSession(session);
    expect(session.sessionId).toBe(provisionalId);

    const settings = JSON.parse(readFileSync(prepared.launch.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
    };
    const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url!;
    // Claude can start the highlighted picker preview before the user commits
    // the final selection. A later SessionStart must be allowed to rebind.
    const previewStart = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${prepared.launch.env.PUPPETEER_HOOK_TOKEN}`,
      },
      body: JSON.stringify({ session_id: previewId, cwd: '/preview', hook_event_name: 'SessionStart' }),
    });
    expect(previewStart.status).toBe(200);
    expect(session.sessionId).toBe(previewId);

    const preview = await fetch(prepared.launch.env.PUPPETEER_STATUSLINE_ENDPOINT, {
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
      body: JSON.stringify({ session_id: selectedId, cwd: '/tmp', hook_event_name: 'SessionStart' }),
    });
    expect(response.status).toBe(200);
    expect(session.sessionId).toBe(selectedId);
    expect(projection.state.lifecycle).toBe('ready');

    const selectedStatus = await fetch(prepared.launch.env.PUPPETEER_STATUSLINE_ENDPOINT, {
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

    const selectedTranscriptDirectory = mkdtempSync(join(tmpdir(), 'driver-picker-history-'));
    const selectedTranscript = join(selectedTranscriptDirectory, `${selectedId}.jsonl`);
    writeFileSync(selectedTranscript, '');
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

    const stalePreview = await fetch(prepared.launch.env.PUPPETEER_STATUSLINE_ENDPOINT, {
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
});
