import { describe, expect, it } from 'vitest';
import {
  fakeClaudeHookPayload,
  listHookFixtureEvents,
  loadHookFixtures,
  loadOrderedHookLane,
} from '../test-support/claude-fixtures.js';
import { ClaudeHookNormalizer, type ClaudeHookPayload } from './pipeline.js';
import { getHookSpec } from '../generated/registry.js';

const normalizeOne = (body: ClaudeHookPayload) => new ClaudeHookNormalizer().normalize(body);

describe('registry coverage', () => {
  it('every captured fixture event is registered as verified', () => {
    for (const event of listHookFixtureEvents()) {
      const spec = getHookSpec(event);
      expect(spec, `registry entry for ${event}`).toBeDefined();
      expect(spec!.confidence).not.toBe('unverified');
    }
  });
});

describe('ClaudeHookNormalizer against captured fixtures', () => {
  it('normalizes every fixture payload without throwing, extracting the envelope', () => {
    const normalizer = new ClaudeHookNormalizer();
    for (const record of loadHookFixtures()) {
      const result = normalizer.normalize(record as ClaudeHookPayload);
      expect(result.events.length, record.hook_event_name).toBeGreaterThan(0);
      expect(result.sessionId).toBe(record.session_id);
      expect(result.transcriptPath).toBe(record.transcript_path);
    }
  });

  it('maps the turn lifecycle: prompt → turn:started, Stop → turn:completed', () => {
    const prompt = loadHookFixtures('UserPromptSubmit')[0]!;
    const started = normalizeOne(prompt as ClaudeHookPayload);
    expect(started.events[0]).toMatchObject({ type: 'turn:started', turnId: prompt.prompt_id, prompt: prompt.prompt });

    const stop = fakeClaudeHookPayload('Stop', {
      prompt_id: prompt.prompt_id,
      last_assistant_message: 'complete',
      stop_hook_active: false,
    });
    const completed = normalizeOne(stop as ClaudeHookPayload);
    expect(completed.events[0]).toMatchObject({
      type: 'turn:completed',
      lastAssistantMessage: stop.last_assistant_message,
    });
  });

  it('maps tool events with their native ids', () => {
    const pre = fakeClaudeHookPayload('PreToolUse', {
      prompt_id: 'prompt-tool',
      tool_name: 'Read',
      tool_input: { file_path: '/workspace/README.md' },
      tool_use_id: 'tool-read',
    });
    expect(normalizeOne(pre as ClaudeHookPayload).events.at(-1)).toMatchObject({
      type: 'tool:requested',
      toolCallId: pre.tool_use_id,
      tool: pre.tool_name,
    });

    const post = fakeClaudeHookPayload('PostToolUse', {
      prompt_id: 'prompt-tool',
      tool_name: 'Read',
      tool_input: { file_path: '/workspace/README.md' },
      tool_response: { content: 'ok' },
      tool_use_id: 'tool-read',
      duration_ms: 12,
    });
    expect(normalizeOne(post as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'tool:completed',
      toolCallId: post.tool_use_id,
      durationMs: post.duration_ms,
    });

    const failure = fakeClaudeHookPayload('PostToolUseFailure', {
      prompt_id: 'prompt-tool',
      tool_name: 'Read',
      tool_input: { file_path: '/workspace/missing' },
      tool_use_id: 'tool-failed',
      error: 'not found',
    });
    expect(normalizeOne(failure as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'tool:failed',
      toolCallId: failure.tool_use_id,
    });
  });

  it('reports Write/Edit intent separately from a successful applied operation', () => {
    const normalizer = new ClaudeHookNormalizer();
    const input = {
      file_path: '/workspace/src/index.ts',
      old_string: 'const oldValue = 1;',
      new_string: 'const newValue = 1;',
      replace_all: false,
    };
    const proposed = normalizer.normalize(
      fakeClaudeHookPayload('PreToolUse', {
        prompt_id: 'prompt-edit',
        tool_name: 'Edit',
        tool_input: input,
        tool_use_id: 'tool-edit',
      }),
    );
    const applied = normalizer.normalize(
      fakeClaudeHookPayload('PostToolUse', {
        prompt_id: 'prompt-edit',
        tool_name: 'Edit',
        tool_input: input,
        tool_response: { ok: true },
        tool_use_id: 'tool-edit',
      }),
    );

    expect(proposed.events).toContainEqual({
      type: 'workspace:file-operation',
      toolCallId: 'tool-edit',
      phase: 'proposed',
      changes: [
        {
          path: '/workspace/src/index.ts',
          kind: 'modify',
          details: [
            {
              representation: 'replacement',
              basis: 'tool-input',
              oldText: 'const oldValue = 1;',
              newText: 'const newValue = 1;',
              replaceAll: false,
            },
          ],
        },
      ],
    });
    expect(applied.events).toContainEqual(
      expect.objectContaining({
        type: 'workspace:file-operation',
        toolCallId: 'tool-edit',
        phase: 'applied',
      }),
    );
  });

  it('preserves explicitly empty Write and Edit strings', () => {
    const normalizer = new ClaudeHookNormalizer();
    const write = normalizer.normalize(
      fakeClaudeHookPayload('PreToolUse', {
        tool_name: 'Write',
        tool_use_id: 'tool-empty-write',
        tool_input: { file_path: '/workspace/empty.txt', content: '' },
      }),
    );
    const edit = normalizer.normalize(
      fakeClaudeHookPayload('PreToolUse', {
        tool_name: 'Edit',
        tool_use_id: 'tool-empty-edit',
        tool_input: { file_path: '/workspace/a.txt', old_string: 'remove', new_string: '' },
      }),
    );

    expect(write.events).toContainEqual(
      expect.objectContaining({
        type: 'workspace:file-operation',
        changes: [expect.objectContaining({ details: [expect.objectContaining({ content: '' })] })],
      }),
    );
    expect(edit.events).toContainEqual(
      expect.objectContaining({
        type: 'workspace:file-operation',
        changes: [expect.objectContaining({ details: [expect.objectContaining({ newText: '' })] })],
      }),
    );
  });

  it('classifies native tool names into provider-neutral UI presentations', () => {
    const command = normalizeOne(
      fakeClaudeHookPayload('PreToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'tool-command',
        tool_input: { command: 'pnpm test' },
      }) as ClaudeHookPayload,
    );
    const search = normalizeOne(
      fakeClaudeHookPayload('PreToolUse', {
        tool_name: 'WebSearch',
        tool_use_id: 'tool-search',
        tool_input: { query: 'ACP protocol' },
      }) as ClaudeHookPayload,
    );
    expect(command.events.at(-1)).toMatchObject({
      presentation: { kind: 'command', title: 'Running command', detail: 'pnpm test' },
    });
    expect(search.events.at(-1)).toMatchObject({
      presentation: { kind: 'web-search', title: 'Searching the web', detail: 'ACP protocol' },
    });
  });

  it('surfaces MessageDisplay turn_id for envelope stamping', () => {
    const display = loadHookFixtures('MessageDisplay')[0]!;
    const result = normalizeOne(display as ClaudeHookPayload);
    expect(result.turnId).toBe(display.turn_id);
    expect(result.promptId).toBe(display.prompt_id);
    expect(result.events[0]).toMatchObject({ type: 'conversation:assistant-message', messageId: display.message_id });
  });
});

describe('MessageDisplay delta accumulation', () => {
  it('accumulates per message_id and finalizes', () => {
    const normalizer = new ClaudeHookNormalizer();
    const chunk = (delta: string, final: boolean) =>
      normalizer.normalize(
        fakeClaudeHookPayload('MessageDisplay', {
          message_id: 'm-1',
          turn_id: 't-1',
          delta,
          final,
          index: 0,
        }) as ClaudeHookPayload,
      ).events[0] as { text: string; final?: boolean };

    expect(chunk('Hel', false).text).toBe('Hel');
    expect(chunk('lo', false).text).toBe('Hello');
    const done = chunk('!', true);
    expect(done.text).toBe('Hello!');
    expect(done.final).toBe(true);
    // Buffer cleared: a new message starts fresh.
    expect(chunk('x', false).text).toBe('x');
  });
});

describe('environment telemetry', () => {
  it('captures startup cwd/model and live CwdChanged updates', () => {
    const normalizer = new ClaudeHookNormalizer();
    expect(
      normalizer.normalize({
        hook_event_name: 'SessionStart',
        session_id: 's1',
        cwd: '/repo',
        model: 'claude-sonnet-5',
      }).events,
    ).toEqual(
      expect.arrayContaining([
        { type: 'environment:updated', currentCwd: '/repo' },
        { type: 'model:updated', model: { id: 'claude-sonnet-5', provider: 'anthropic' } },
      ]),
    );
    expect(
      normalizer.normalize({ hook_event_name: 'CwdChanged', session_id: 's1', old_cwd: '/repo', new_cwd: '/tmp' })
        .events,
    ).toEqual([{ type: 'environment:updated', currentCwd: '/tmp' }]);
  });

  it('preserves open-ended permission/effort values and actor/version envelope metadata', () => {
    const normalizer = new ClaudeHookNormalizer();
    const first = normalizer.normalize(
      fakeClaudeHookPayload('UserPromptSubmit', {
        prompt_id: 'p-env',
        prompt: 'observe me',
        permission_mode: 'future-manual-plus',
        effort: { level: 'future-ultra' },
        agent_id: 'agent-child',
        agent_type: 'Explore',
        version: '2.1.999',
      }),
    );
    expect(first).toMatchObject({
      agentId: 'agent-child',
      agentType: 'Explore',
      providerVersion: '2.1.999',
    });
    expect(first.events).toEqual(
      expect.arrayContaining([
        { type: 'effort:updated', intent: 'observed', effort: 'future-ultra' },
        {
          type: 'mode:updated',
          intent: 'observed',
          modeKind: 'provider-permission',
          mode: { raw: 'future-manual-plus' },
        },
      ]),
    );

    const unchanged = normalizer.normalize(
      fakeClaudeHookPayload('MessageDisplay', {
        prompt_id: 'p-env',
        message_id: 'm-env',
        turn_id: 't-env',
        delta: 'x',
        final: true,
        permission_mode: 'future-manual-plus',
        effort: { level: 'future-ultra' },
      }),
    );
    expect(
      unchanged.events.filter((event) => event.type === 'effort:updated' || event.type === 'mode:updated'),
    ).toEqual([]);
  });
});

describe('structured AskUserQuestion lifecycle', () => {
  const ask = {
    prompt_id: 'prompt-question',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'tool-question',
    tool_input: {
      questions: [
        {
          header: 'Strategy',
          question: 'Which approach?',
          options: [
            { label: 'Safe', description: 'Use the proven path' },
            { label: 'Fast', description: '' },
          ],
          multiSelect: true,
        },
        {
          id: 'scope',
          question: 'What scope?',
          options: [{ label: 'Focused', description: 'Only this package' }],
          multi_select: false,
          allow_free_form: false,
        },
      ],
    },
  };

  it('emits both generic tool evidence and a typed provisional question', () => {
    const normalizer = new ClaudeHookNormalizer();
    const result = normalizer.normalize(fakeClaudeHookPayload('PreToolUse', ask));
    expect(result.events[0]).toMatchObject({ type: 'tool:requested', toolCallId: 'tool-question' });
    expect(result.events[1]).toEqual({
      type: 'interaction:question-requested',
      requestId: 'question:tool-question',
      questions: [
        {
          header: 'Strategy',
          prompt: 'Which approach?',
          options: [
            { label: 'Safe', description: 'Use the proven path' },
            { label: 'Fast', description: '' },
          ],
          allowMultiple: true,
          allowFreeForm: true,
        },
        {
          id: 'scope',
          prompt: 'What scope?',
          options: [{ label: 'Focused', description: 'Only this package' }],
          allowMultiple: false,
          allowFreeForm: false,
        },
      ],
    });
    expect(normalizer.pendingQuestionRequests()).toHaveLength(1);
  });

  it('answers, fails, cancels, and supersedes only on matching evidence or an owning boundary', () => {
    const answered = new ClaudeHookNormalizer();
    answered.normalize(fakeClaudeHookPayload('PreToolUse', ask));
    expect(
      answered.normalize(fakeClaudeHookPayload('PostToolUse', { ...ask, tool_response: { answers: ['Safe'] } }))
        .events[0],
    ).toEqual({ type: 'interaction:question-resolved', requestId: 'question:tool-question', outcome: 'answered' });

    const failed = new ClaudeHookNormalizer();
    failed.normalize(fakeClaudeHookPayload('PreToolUse', ask));
    expect(
      failed.normalize(fakeClaudeHookPayload('PostToolUseFailure', { ...ask, error: 'dialog failed' })).events[0],
    ).toEqual({ type: 'interaction:question-resolved', requestId: 'question:tool-question', outcome: 'failed' });

    const cancelled = new ClaudeHookNormalizer();
    cancelled.normalize(fakeClaudeHookPayload('PreToolUse', ask));
    expect(
      cancelled.normalize(fakeClaudeHookPayload('Stop', { prompt_id: ask.prompt_id, last_assistant_message: 'done' }))
        .events[0],
    ).toEqual({ type: 'interaction:question-resolved', requestId: 'question:tool-question', outcome: 'cancelled' });

    const superseded = new ClaudeHookNormalizer();
    superseded.normalize(fakeClaudeHookPayload('PreToolUse', ask));
    expect(
      superseded.normalize(
        fakeClaudeHookPayload('UserPromptSubmit', { prompt_id: 'new-prompt', prompt: 'new request' }),
      ).events[0],
    ).toEqual({ type: 'interaction:question-resolved', requestId: 'question:tool-question', outcome: 'superseded' });
  });

  it('keeps permissions and questions independent', () => {
    const normalizer = new ClaudeHookNormalizer();
    normalizer.normalize(fakeClaudeHookPayload('PreToolUse', ask));
    normalizer.normalize(
      fakeClaudeHookPayload('PermissionRequest', {
        prompt_id: ask.prompt_id,
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      }),
    );
    normalizer.normalize(fakeClaudeHookPayload('PostToolUse', { ...ask, tool_response: { answers: ['Safe'] } }));
    expect(normalizer.pendingQuestionRequests()).toHaveLength(0);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(1);
  });

  it("does not turn Claude's AskUserQuestion picker event into a permission blocker", () => {
    const normalizer = new ClaudeHookNormalizer();
    normalizer.normalize(fakeClaudeHookPayload('PreToolUse', ask));
    const permission = normalizer.normalize(fakeClaudeHookPayload('PermissionRequest', ask));

    expect(permission.events).toEqual([
      { type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'PermissionRequest' },
    ]);
    expect(normalizer.pendingQuestionRequests()).toHaveLength(1);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(0);
  });
});

describe('tool, team, and compaction semantics', () => {
  it('uses collision-safe fallback tool ids for repeated same-name calls in one prompt', () => {
    const normalizer = new ClaudeHookNormalizer();
    const call = () =>
      normalizer.normalize(
        fakeClaudeHookPayload('PreToolUse', {
          prompt_id: 'same-prompt',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/a' },
          tool_use_id: undefined,
        }),
      ).events[0] as { toolCallId: string };
    expect(call().toolCallId).not.toBe(call().toolCallId);
  });

  it.each([
    ['TodoWrite', { todos: [{ content: 'Inspect code', status: 'in_progress' }] }],
    ['ExitPlanMode', { plan: '# Plan\n1. Inspect code', planFilePath: '/private/plan.md' }],
    ['TaskCreate', { subject: 'Research', description: 'Inspect provider' }],
    ['TaskUpdate', { taskId: 'task-1', status: 'completed' }],
  ])('retains %s as generic tool activity without task or plan projection', (toolName, input) => {
    const normalizer = new ClaudeHookNormalizer();
    const tool = { prompt_id: 'p-1', tool_name: toolName, tool_use_id: 'call-1', tool_input: input };
    const requested = normalizer.normalize(fakeClaudeHookPayload('PreToolUse', tool));
    expect(requested.events).toEqual([
      expect.objectContaining({ type: 'tool:requested', toolCallId: 'call-1', tool: toolName, input }),
    ]);
    const output = { ok: true };
    const completed = normalizer.normalize(fakeClaudeHookPayload('PostToolUse', { ...tool, tool_response: output }));
    expect(completed.events).toEqual([
      expect.objectContaining({ type: 'tool:completed', toolCallId: 'call-1', tool: toolName, output }),
    ]);
  });

  it.each(['TaskCreated', 'TaskCompleted'])('retains %s as native evidence', (nativeType) => {
    const normalizer = new ClaudeHookNormalizer();
    const payload = fakeClaudeHookPayload(nativeType, {
      task_id: 'task-1',
      task_subject: 'Research',
      task_description: 'Inspect provider',
    });
    expect(normalizer.normalize(payload).events).toEqual([
      { type: 'adapter:native-event', adapter: 'claude-code', nativeType },
    ]);
  });

  it('continues to observe teammate lifecycle independently of task tracking', () => {
    const normalizer = new ClaudeHookNormalizer();
    expect(
      normalizer.normalize(fakeClaudeHookPayload('TeammateIdle', { team_name: 'alpha', teammate_name: 'researcher' }))
        .events,
    ).toEqual([{ type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'TeammateIdle' }]);
  });

  it('correlates PreCompact and PostCompact and closes a blocked attempt at the turn boundary', () => {
    const normalizer = new ClaudeHookNormalizer();
    const started = normalizer.normalize(
      fakeClaudeHookPayload('PreCompact', { prompt_id: 'p-compact', trigger: 'auto', custom_instructions: '' }),
    );
    const compactionId = (started.events[0] as { compactionId: string }).compactionId;
    expect(started.events[0]).toMatchObject({ type: 'compaction:started', compactionId, trigger: 'auto' });
    expect(
      normalizer.normalize(
        fakeClaudeHookPayload('PostCompact', { prompt_id: 'p-compact', trigger: 'auto', compact_summary: 'summary' }),
      ).events[0],
    ).toMatchObject({ type: 'compaction:completed', compactionId, trigger: 'auto', outcome: 'completed' });

    normalizer.normalize(
      fakeClaudeHookPayload('PreCompact', { prompt_id: 'p-blocked', trigger: 'manual', custom_instructions: '' }),
    );
    expect(
      normalizer.normalize(
        fakeClaudeHookPayload('Stop', { prompt_id: 'p-blocked', last_assistant_message: 'not compacted' }),
      ).events[0],
    ).toMatchObject({ type: 'compaction:completed', trigger: 'manual', outcome: 'cancelled' });

    const boundaryStart = normalizer.normalize(
      fakeClaudeHookPayload('PreCompact', { trigger: 'manual', custom_instructions: '' }),
    );
    const boundaryId = (boundaryStart.events[0] as { compactionId: string }).compactionId;
    const nextPrompt = normalizer.normalize(
      fakeClaudeHookPayload('UserPromptSubmit', { prompt_id: 'p-after-compact', prompt: 'continue' }),
    );
    expect(nextPrompt.events).toEqual([
      expect.objectContaining({
        type: 'compaction:completed',
        compactionId: boundaryId,
        trigger: 'manual',
        outcome: 'unknown',
      }),
      expect.objectContaining({ type: 'turn:started', turnId: 'p-after-compact' }),
    ]);
    expect(
      normalizer.normalize(fakeClaudeHookPayload('PostCompact', { trigger: 'manual', compact_summary: 'late' }))
        .events[0],
    ).toMatchObject({ type: 'compaction:completed', compactionId: boundaryId, outcome: 'completed' });
  });
});

describe('permission correlation (no native request id)', () => {
  const tool = {
    prompt_id: 'prompt-permission',
    tool_name: 'Bash',
    tool_input: { description: 'say hi', command: 'echo hi' },
    tool_use_id: 'toolu_permission',
  };

  it('correlates the current PreToolUse → PermissionRequest order and resolves on execution completion', () => {
    const normalizer = new ClaudeHookNormalizer();
    const pre = normalizer.normalize(fakeClaudeHookPayload('PreToolUse', tool) as ClaudeHookPayload);
    expect(pre.events).toEqual([expect.objectContaining({ type: 'tool:requested', toolCallId: tool.tool_use_id })]);

    const requested = normalizer.normalize(
      fakeClaudeHookPayload('PermissionRequest', {
        prompt_id: tool.prompt_id,
        tool_name: tool.tool_name,
        // Key order deliberately differs: correlation is canonical, not raw JSON.
        tool_input: { command: 'echo hi', description: 'say hi' },
      }) as ClaudeHookPayload,
    );
    const requestedEvent = requested.events[0] as { type: string; requestId: string };
    expect(requestedEvent.type).toBe('interaction:permission-requested');
    expect(requestedEvent).toMatchObject({ toolCallId: tool.tool_use_id });
    expect(normalizer.pendingPermissionRequests()).toHaveLength(1);

    const resolved = normalizer.normalize(
      fakeClaudeHookPayload('PostToolUse', { ...tool, tool_response: { output: 'hi' } }) as ClaudeHookPayload,
    );
    expect(resolved.events[0]).toEqual({
      type: 'interaction:permission-resolved',
      requestId: requestedEvent.requestId,
      outcome: 'allowed',
    });
    expect(resolved.events[1]).toMatchObject({ type: 'tool:completed', toolCallId: tool.tool_use_id });
    expect(normalizer.pendingPermissionRequests()).toHaveLength(0);
  });

  it('tolerates the legacy PermissionRequest → PreToolUse order without claiming allow early', () => {
    const normalizer = new ClaudeHookNormalizer();
    const requested = normalizer.normalize(fakeClaudeHookPayload('PermissionRequest', tool) as ClaudeHookPayload);
    const requestId = (requested.events[0] as { requestId: string }).requestId;
    const pre = normalizer.normalize(fakeClaudeHookPayload('PreToolUse', tool) as ClaudeHookPayload);
    expect(pre.events).toEqual([expect.objectContaining({ type: 'tool:requested', toolCallId: tool.tool_use_id })]);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(1);

    const post = normalizer.normalize(
      fakeClaudeHookPayload('PostToolUse', { ...tool, tool_response: 'hi' }) as ClaudeHookPayload,
    );
    expect(post.events[0]).toEqual({ type: 'interaction:permission-resolved', requestId, outcome: 'allowed' });
  });

  it('resolves auto-mode PermissionDenied by native tool_use_id', () => {
    const normalizer = new ClaudeHookNormalizer();
    normalizer.normalize(fakeClaudeHookPayload('PreToolUse', tool) as ClaudeHookPayload);
    const requested = normalizer.normalize(fakeClaudeHookPayload('PermissionRequest', tool) as ClaudeHookPayload);
    const requestId = (requested.events[0] as { requestId: string }).requestId;
    const denied = normalizer.normalize(
      fakeClaudeHookPayload('PermissionDenied', { ...tool, reason: 'Blocked by classifier' }) as ClaudeHookPayload,
    );
    expect(denied.events).toEqual([
      { type: 'interaction:permission-resolved', requestId, outcome: 'denied' },
      expect.objectContaining({
        type: 'tool:failed',
        toolCallId: tool.tool_use_id,
        tool: tool.tool_name,
        error: 'Blocked by classifier',
      }),
    ]);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(0);
  });

  it('closes a denied Edit as both a failed tool and a failed file operation', () => {
    const normalizer = new ClaudeHookNormalizer();
    const deniedEdit = {
      prompt_id: 'prompt-denied-edit',
      tool_name: 'Edit',
      tool_use_id: 'tool-denied-edit',
      tool_input: {
        file_path: '/workspace/a.ts',
        old_string: 'old',
        new_string: 'new',
      },
    };
    normalizer.normalize(fakeClaudeHookPayload('PreToolUse', deniedEdit) as ClaudeHookPayload);
    const denied = normalizer.normalize(
      fakeClaudeHookPayload('PermissionDenied', { ...deniedEdit, reason: 'Denied' }) as ClaudeHookPayload,
    );
    expect(denied.events).toEqual([
      expect.objectContaining({ type: 'tool:failed', toolCallId: 'tool-denied-edit' }),
      expect.objectContaining({
        type: 'workspace:file-operation',
        toolCallId: 'tool-denied-edit',
        phase: 'failed',
      }),
    ]);
  });

  it('closes a manual denial at the turn boundary so no permission is orphaned', () => {
    const normalizer = new ClaudeHookNormalizer();
    const requested = normalizer.normalize(fakeClaudeHookPayload('PermissionRequest', tool) as ClaudeHookPayload);
    const requestId = (requested.events[0] as { requestId: string }).requestId;
    const stop = normalizer.normalize(
      fakeClaudeHookPayload('Stop', {
        prompt_id: tool.prompt_id,
        stop_hook_active: false,
        last_assistant_message: 'Permission denied.',
      }) as ClaudeHookPayload,
    );
    expect(stop.events).toEqual([
      { type: 'interaction:permission-resolved', requestId, outcome: 'denied' },
      expect.objectContaining({ type: 'turn:completed', turnId: tool.prompt_id }),
    ]);
    expect(stop.diagnostics).toEqual([
      {
        code: 'permission-outlived-turn',
        hookEventName: 'Stop',
        issues: ['1 pending permission request(s) closed at the owning turn boundary'],
      },
    ]);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(0);
  });

  it('closes an Esc-interrupted request, which has no Stop, when the next prompt starts', () => {
    const normalizer = new ClaudeHookNormalizer();
    normalizer.normalize(fakeClaudeHookPayload('PreToolUse', tool) as ClaudeHookPayload);
    const requested = normalizer.normalize(fakeClaudeHookPayload('PermissionRequest', tool) as ClaudeHookPayload);
    const requestId = (requested.events[0] as { requestId: string }).requestId;
    // A background agent's own request may still be waiting when the person types again.
    const worker = { ...tool, agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose', tool_use_id: 'toolu_bg' };
    normalizer.normalize(fakeClaudeHookPayload('PreToolUse', worker) as ClaudeHookPayload);
    normalizer.normalize(fakeClaudeHookPayload('PermissionRequest', worker) as ClaudeHookPayload);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(2);

    const next = normalizer.normalize(
      fakeClaudeHookPayload('UserPromptSubmit', {
        prompt_id: 'prompt-next',
        prompt: 'try another way',
      }) as ClaudeHookPayload,
    );
    expect(next.events).toEqual([
      { type: 'interaction:permission-resolved', requestId, outcome: 'unknown' },
      expect.objectContaining({ type: 'turn:started', turnId: 'prompt-next' }),
    ]);
    expect(next.diagnostics).toEqual([
      {
        code: 'permission-outlived-turn',
        hookEventName: 'UserPromptSubmit',
        issues: ['1 pending permission request(s) of an interrupted turn closed when the next prompt started'],
      },
    ]);
    expect(normalizer.pendingPermissionRequests()).toEqual([
      expect.objectContaining({ agentId: worker.agent_id, toolCallId: 'toolu_bg' }),
    ]);
  });

  it('replays the 2.1.308 TUI lane with no request pending past the next prompt', () => {
    const normalizer = new ClaudeHookNormalizer();
    const resolved: Array<{ seq: number; requestId: string; outcome: string }> = [];
    let requested: { seq: number; requestId: string } | undefined;
    for (const { seq, record } of loadOrderedHookLane('interactive')) {
      const result = normalizer.normalize(record as ClaudeHookPayload);
      for (const event of result.events) {
        if (event.type === 'interaction:permission-requested') requested = { seq, requestId: event.requestId };
        if (event.type === 'interaction:permission-resolved') {
          resolved.push({ seq, requestId: event.requestId, outcome: event.outcome });
        }
      }
      if (record.hook_event_name === 'UserPromptSubmit') {
        // Every request still open belongs to the prompt that just started.
        expect(
          normalizer.pendingPermissionRequests().filter((permission) => permission.promptId !== record.prompt_id),
        ).toEqual([]);
      }
    }
    // The lane's Esc at the Bash prompt (seq 31): no Stop follows, the next prompt (seq 34) closes it.
    expect(requested?.seq).toBe(31);
    expect(resolved).toEqual([{ seq: 34, requestId: requested!.requestId, outcome: 'unknown' }]);
  });

  it('resolves an evicted request before bounding the permission queue', () => {
    const normalizer = new ClaudeHookNormalizer();
    let oldestRequestId = '';
    for (let index = 0; index < 64; index += 1) {
      const result = normalizer.normalize(
        fakeClaudeHookPayload('PermissionRequest', {
          prompt_id: 'busy-turn',
          tool_name: 'Bash',
          tool_input: { command: `echo ${index}` },
        }) as ClaudeHookPayload,
      );
      if (index === 0) oldestRequestId = (result.events[0] as { requestId: string }).requestId;
    }

    const overflow = normalizer.normalize(
      fakeClaudeHookPayload('PermissionRequest', {
        prompt_id: 'busy-turn',
        tool_name: 'Bash',
        tool_input: { command: 'echo overflow' },
      }) as ClaudeHookPayload,
    );
    expect(overflow.events).toEqual([
      { type: 'interaction:permission-resolved', requestId: oldestRequestId, outcome: 'unknown' },
      expect.objectContaining({ type: 'interaction:permission-requested' }),
    ]);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(64);

    const stop = normalizer.normalize(
      fakeClaudeHookPayload('Stop', { prompt_id: 'busy-turn', last_assistant_message: 'done' }) as ClaudeHookPayload,
    );
    expect(stop.events.filter((event) => event.type === 'interaction:permission-resolved')).toHaveLength(64);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(0);
  });
});

describe('SubagentStop re-entrancy', () => {
  it('normalizes only the first stop per agent; repeats stay native', () => {
    const normalizer = new ClaudeHookNormalizer();
    const stop = fakeClaudeHookPayload('SubagentStop', {
      prompt_id: 'prompt-subagent',
      agent_id: 'agent-1',
      agent_type: 'Explore',
    });
    expect(normalizer.normalize(stop as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'delegation:subagent-stopped',
      subagentId: stop.agent_id,
    });
    expect(normalizer.normalize({ ...stop, stop_hook_active: true } as ClaudeHookPayload).events[0]).toMatchObject({
      type: 'adapter:native-event',
      nativeType: 'SubagentStop',
    });
  });

  it('allows a fresh lifecycle if Claude reuses an agent id', () => {
    const normalizer = new ClaudeHookNormalizer();
    const payload = fakeClaudeHookPayload('SubagentStop', { agent_id: 'agent-reused', agent_type: 'Explore' });
    normalizer.normalize(payload as ClaudeHookPayload);
    normalizer.normalize(
      fakeClaudeHookPayload('SubagentStart', { agent_id: 'agent-reused', agent_type: 'Explore' }) as ClaudeHookPayload,
    );
    expect(normalizer.normalize(payload as ClaudeHookPayload).events[0]).toEqual({
      type: 'delegation:subagent-stopped',
      subagentId: 'agent-reused',
    });
  });
});

describe('Claude 2.1.226 hook additions', () => {
  it('marks a /clear SessionStart as an in-process native identity rebind', () => {
    expect(
      normalizeOne(
        fakeClaudeHookPayload('SessionStart', {
          session_id: 'new-native-session',
          source: 'clear',
        }),
      ).events[0],
    ).toMatchObject({
      type: 'session:started',
      nativeSessionId: 'new-native-session',
      startSource: 'clear',
      rebind: true,
    });
  });

  it('keeps directory configuration separate from direct file observations', () => {
    expect(normalizeOne(fakeClaudeHookPayload('DirectoryAdded', { directory: '/workspace/other' })).events).toEqual([
      { type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'DirectoryAdded' },
    ]);
    expect(
      normalizeOne(fakeClaudeHookPayload('FileChanged', { file_path: '/workspace/.env', event: 'change' })).events,
    ).toEqual([{ type: 'workspace:file-changed', changes: [{ path: '/workspace/.env', kind: 'modify' }] }]);
  });

  it('maps completed compaction hooks', () => {
    expect(
      normalizeOne(fakeClaudeHookPayload('PostCompact', { trigger: 'auto', compact_summary: '...' })).events,
    ).toEqual([
      expect.objectContaining({ type: 'compaction:completed', trigger: 'auto', outcome: 'completed' }),
      { type: 'context-window:invalidated', reason: 'compacted' },
    ]);
  });

  it('retains new hooks without a portable semantic projection as native events', () => {
    for (const event of ['Setup', 'UserPromptExpansion', 'PostToolBatch', 'Elicitation', 'ElicitationResult']) {
      expect(normalizeOne(fakeClaudeHookPayload(event)).events[0]).toEqual({
        type: 'adapter:native-event',
        adapter: 'claude-code',
        nativeType: event,
      });
    }
  });
});

describe('Claude 2.1.308 hook additions', () => {
  it('maps the landed model switch to an observed model and keeps the cancellable request native', () => {
    const [request] = loadHookFixtures('PreModelSwitch');
    const [landed] = loadHookFixtures('PostModelSwitch');
    expect(normalizeOne(request as ClaudeHookPayload).events).toEqual([
      { type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'PreModelSwitch' },
    ]);
    expect(normalizeOne(landed as ClaudeHookPayload).events).toEqual([
      { type: 'model:updated', intent: 'observed', model: { id: landed!.to_model, provider: 'anthropic' } },
    ]);
    // Claude resolved the requested id to another model: the event names the one serving.
    expect(landed!.to_model).not.toBe(landed!.requested_model);
    for (const source of ['auto', 'resume']) {
      expect(
        normalizeOne(
          fakeClaudeHookPayload('PostModelSwitch', {
            from_model: 'claude-opus-5-5',
            to_model: 'claude-sonnet-4-5-20250929',
            requested_model: null,
            source,
          }),
        ).events,
      ).toEqual([
        {
          type: 'model:updated',
          intent: 'observed',
          model: { id: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        },
      ]);
    }
  });

  it('retains a PostModelSwitch without a target model natively and reports it', () => {
    const result = normalizeOne(fakeClaudeHookPayload('PostModelSwitch', { from_model: 'a', source: 'command' }));
    expect(result.events).toEqual([
      { type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'PostModelSwitch' },
    ]);
    expect(result.diagnostics).toEqual([
      { code: 'malformed-known-hook', hookEventName: 'PostModelSwitch', issues: ['to_model must be string'] },
    ]);
  });

  it('keeps the compaction agent native: an empty agent_type stop with no start delegated nothing', () => {
    const normalizer = new ClaudeHookNormalizer();
    const [internal] = loadHookFixtures('SubagentStop').filter((record) => record.agent_type === '');
    expect(internal).toBeDefined();
    const result = normalizer.normalize(internal as ClaudeHookPayload);
    expect(result.events[0]).toEqual({
      type: 'adapter:native-event',
      adapter: 'claude-code',
      nativeType: 'SubagentStop',
    });
    expect(result.events.some((event) => event.type.startsWith('delegation:'))).toBe(false);
    // Runtime refuses empty candidate actor metadata, so the empty type is not stamped.
    expect(result.agentId).toBe(internal!.agent_id);
    expect(result.agentType).toBeUndefined();
    // A started agent with an empty type still stops as delegation.
    normalizer.normalize(fakeClaudeHookPayload('SubagentStart', { agent_id: 'agent-blank', agent_type: '' }));
    expect(
      normalizer.normalize(fakeClaudeHookPayload('SubagentStop', { agent_id: 'agent-blank', agent_type: '' })).events,
    ).toEqual([{ type: 'delegation:subagent-stopped', subagentId: 'agent-blank' }]);
  });

  it('completes /compact once, at PostCompact, across the compact SessionStart between them', () => {
    const normalizer = new ClaudeHookNormalizer();
    // 2.1.308 TUI order: PreCompact → SubagentStop(internal) → SessionStart(compact) → PostCompact.
    const started = normalizer.normalize(
      fakeClaudeHookPayload('PreCompact', { prompt_id: 'p-compact', trigger: 'manual', custom_instructions: '' }),
    );
    const compactionId = (started.events[0] as { compactionId: string }).compactionId;
    normalizer.normalize(
      fakeClaudeHookPayload('SubagentStop', { prompt_id: 'p-compact', agent_id: 'anon-compact', agent_type: '' }),
    );
    const restarted = normalizer.normalize(fakeClaudeHookPayload('SessionStart', { source: 'compact' }));
    expect(restarted.events.filter((event) => event.type.startsWith('compaction:'))).toEqual([]);
    expect(restarted.events[0]).toMatchObject({ type: 'session:started', startSource: 'compact' });
    expect(
      normalizer.normalize(fakeClaudeHookPayload('PostCompact', { trigger: 'manual', compact_summary: '...' })).events,
    ).toEqual([
      { type: 'compaction:completed', compactionId, trigger: 'manual', outcome: 'completed' },
      { type: 'context-window:invalidated', reason: 'compacted' },
    ]);
    // Any other start still ends an attempt that never reported its outcome.
    normalizer.normalize(fakeClaudeHookPayload('PreCompact', { trigger: 'auto', custom_instructions: '' }));
    expect(
      normalizer
        .normalize(fakeClaudeHookPayload('SessionStart', { source: 'resume' }))
        .events.filter((event) => event.type === 'compaction:completed'),
    ).toEqual([expect.objectContaining({ trigger: 'auto', outcome: 'unknown' })]);
  });
});

describe('unknown events (ADR-008)', () => {
  it('retains unrecognized hook names as adapter:native-event', () => {
    const result = normalizeOne(fakeClaudeHookPayload('SomeFutureEvent') as ClaudeHookPayload);
    expect(result.events[0]).toEqual({
      type: 'adapter:native-event',
      adapter: 'claude-code',
      nativeType: 'SomeFutureEvent',
    });
  });
});

describe('malformed known hooks', () => {
  it('retains the raw hook path and reports missing fields without mutating correlation state', () => {
    const normalizer = new ClaudeHookNormalizer();
    const result = normalizer.normalize({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tool-1',
      tool_input: { command: 'pwd' },
    });

    expect(result.events).toEqual([{ type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'PreToolUse' }]);
    expect(result.diagnostics).toEqual([
      {
        code: 'malformed-known-hook',
        hookEventName: 'PreToolUse',
        issues: ['tool_name must be string'],
      },
    ]);
    expect(normalizer.pendingPermissionRequests()).toHaveLength(0);
  });

  it('does not apply complete Surface schemas to unrelated fields on the live path', () => {
    const result = normalizeOne({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tool-1',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.events[0]).toMatchObject({ type: 'tool:completed', toolCallId: 'tool-1' });
  });
});
