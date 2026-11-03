/**
 * Curated ASM-subset projection of the exact Kimi Code 2.4.1 release source.
 *
 * `extract-source-reference.mjs` refuses to emit a reference unless the
 * checkout revision, generated wire manifest, durable record inventory,
 * per-record top-level fields and requiredness, protocol version, hook
 * inventory, engine-journal inventory, and CLI declarations all match. The
 * resulting tracked reference also pins every contributing source file by
 * SHA-256. The model generator consumes that reference instead of carrying a
 * second hand-written copy of these schemas.
 *
 * 2.4.1's manifest is drained from EVENT2_REGISTRY: every listed type is
 * durable, so the 0.34.0 persisted/transient split no longer exists. Nested
 * shapes the manifest leaves as bare type names (ContentPart, ToolCall,
 * TokenUsage, AgentTaskInfo, ...) are projected from the digest-pinned files in
 * `sourceFiles` below.
 */

export const VERSION = '2.4.1';
export const SOURCE_COMMIT = '2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7';
export const SOURCE_TAG = '@moonshot-ai/kimi-code@2.4.1';
export const WIRE_PROTOCOL_VERSION = '1.5';

export const string = (values) => ({ type: 'string', ...(values ? { enum: values } : {}) });
export const number = (bounds = {}) => ({ type: 'number', ...bounds });
export const integer = (bounds = {}) => ({ type: 'integer', ...bounds });
export const boolean = { type: 'boolean' };
export const object = (properties = {}, required = [], extra = {}) => ({
  type: 'object',
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
  ...extra,
});
export const array = (items) => ({ type: 'array', ...(items ? { items } : {}) });
export const nullableNumber = { anyOf: [number(), { type: 'null' }] };

export const promptOrigins = [
  'user',
  'skill_activation',
  'plugin_command',
  'injection',
  'shell_command',
  'compaction_summary',
  'system_trigger',
  'task',
  'cron_job',
  'cron_missed',
  'hook_result',
  'retry',
];

const urlValue = (extra = {}) => object({ url: string(), id: string(), ...extra }, ['url']);
export const contentPartSchema = {
  anyOf: [
    object({ type: string(['text']), text: string(), meta: object() }, ['type', 'text']),
    object(
      {
        type: string(['think']),
        think: string(),
        encrypted: string(),
        detailsIndex: number(),
        hidden: boolean,
        reasoningKey: string(),
      },
      ['type', 'think'],
    ),
    object({ type: string(['image_url']), imageUrl: urlValue({ name: string() }) }, ['type', 'imageUrl']),
    object({ type: string(['audio_url']), audioUrl: urlValue() }, ['type', 'audioUrl']),
    object({ type: string(['video_url']), videoUrl: urlValue({ name: string() }) }, ['type', 'videoUrl']),
  ],
};

const promptOriginFields = {
  kind: string(promptOrigins),
  activationId: string(),
  skillName: string(),
  skillArgs: string(),
  trigger: string(['user-slash', 'model-tool', 'nested-skill']),
  skillType: string(),
  skillPath: string(),
  skillSource: string(['project', 'user', 'extra', 'builtin']),
  pluginId: string(),
  commandName: string(),
  commandArgs: string(),
  variant: string(),
  ownerPromptId: string(),
  // 2.4.1 types InjectionOrigin.disclosure as `unknown`.
  disclosure: {},
  phase: string(['input', 'output']),
  isError: boolean,
  name: string(),
  taskId: string(),
  status: string(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  notificationId: string(),
  jobId: string(),
  cron: string(),
  recurring: boolean,
  coalescedCount: number(),
  stale: boolean,
  count: number(),
  event: string(),
  blocked: boolean,
  inTurn: boolean,
  clientMetadata: array(object()),
  skillActivations: array(object()),
  attachments: array(object({ name: string(), mediaType: string(), size: number(), path: string() })),
};
const originBranch = (kind, required = [], fields = {}) =>
  object({ kind: string([kind]), ...fields }, ['kind', ...required]);
export const promptOriginSchema = object(promptOriginFields, ['kind'], {
  anyOf: [
    originBranch('user'),
    originBranch('skill_activation', ['activationId', 'skillName', 'trigger'], {
      activationId: string(),
      skillName: string(),
      trigger: string(['user-slash', 'model-tool', 'nested-skill']),
    }),
    originBranch('plugin_command', ['activationId', 'pluginId', 'commandName', 'trigger'], {
      activationId: string(),
      pluginId: string(),
      commandName: string(),
      trigger: string(['user-slash']),
    }),
    originBranch('injection', ['variant'], { variant: string() }),
    originBranch('shell_command', ['phase'], { phase: string(['input', 'output']) }),
    originBranch('compaction_summary'),
    originBranch('system_trigger', ['name'], { name: string() }),
    originBranch('task', ['taskId', 'status', 'notificationId'], {
      taskId: string(),
      status: string(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
      notificationId: string(),
    }),
    originBranch('cron_job', ['jobId', 'cron', 'recurring', 'coalescedCount', 'stale'], {
      jobId: string(),
      cron: string(),
      recurring: boolean,
      coalescedCount: number(),
      stale: boolean,
    }),
    originBranch('cron_missed', ['count'], { count: number() }),
    originBranch('hook_result', ['event'], { event: string() }),
    originBranch('retry', [], { trigger: string() }),
  ],
});

export const tokenUsageSchema = object(
  { inputOther: number(), output: number(), inputCacheRead: number(), inputCacheCreation: number(), raw: object() },
  ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'],
);

const toolCallSchema = object(
  {
    type: string(['function']),
    id: string(),
    name: string(),
    arguments: { anyOf: [string(), { type: 'null' }] },
    extras: object(),
    rawId: string(),
    _streamIndex: { anyOf: [number(), string()] },
  },
  ['type', 'id', 'name', 'arguments'],
);
const toolSchema = object({ name: string(), description: string(), parameters: object(), deferred: boolean }, [
  'name',
  'description',
  'parameters',
]);
export const contextMessageSchema = object(
  {
    role: string(['system', 'user', 'assistant', 'tool']),
    name: string(),
    content: array(contentPartSchema),
    toolCalls: array(toolCallSchema),
    toolCallId: string(),
    partial: boolean,
    tools: array(toolSchema),
    id: string(),
    providerMessageId: string(),
    origin: promptOriginSchema,
    isError: boolean,
    toolCallDisplays: object(),
    note: string(),
    usage: tokenUsageSchema,
    llmTiming: object({ llmFirstTokenLatencyMs: number(), llmStreamDurationMs: number() }),
    durationMs: number(),
  },
  ['role', 'content', 'toolCalls'],
);

const errorSchema = object(
  { code: string(), message: string(), name: string(), details: object(), retryable: boolean, cause: object() },
  ['code', 'message', 'retryable'],
);
const toolResultSchema = object(
  { output: { anyOf: [string(), array(contentPartSchema)] }, isError: boolean, note: string(), durationMs: number() },
  ['output'],
);
const loopEventFields = {
  type: string(['step.begin', 'step.end', 'content.part', 'tool.call', 'tool.result']),
  uuid: string(),
  parentUuid: string(),
  turnId: string(),
  step: number(),
  stepUuid: string(),
  part: contentPartSchema,
  toolCallId: string(),
  name: string(),
  args: {},
  extras: object(),
  display: object(),
  result: toolResultSchema,
  finishReason: string(),
  usage: tokenUsageSchema,
  llmFirstTokenLatencyMs: number(),
  llmStreamDurationMs: number(),
  llmRequestBuildMs: number(),
  llmServerFirstTokenMs: number(),
  llmServerDecodeMs: number(),
  llmClientConsumeMs: number(),
  llmClientBlockedMs: number(),
  messageId: string(),
  providerFinishReason: string(['completed', 'tool_calls', 'truncated', 'filtered', 'paused', 'other']),
  rawFinishReason: string(),
};
const loopBranch = (type, required, fields) => object({ type: string([type]), ...fields }, ['type', ...required]);
export const loopEventSchema = object(loopEventFields, ['type'], {
  anyOf: [
    loopBranch('step.begin', ['uuid'], { uuid: string() }),
    loopBranch('step.end', ['uuid'], { uuid: string() }),
    loopBranch('content.part', ['stepUuid', 'part'], { stepUuid: string(), part: contentPartSchema }),
    loopBranch('tool.call', ['stepUuid', 'toolCallId', 'name'], {
      stepUuid: string(),
      toolCallId: string(),
      name: string(),
    }),
    loopBranch('tool.result', ['toolCallId', 'result'], { toolCallId: string(), result: toolResultSchema }),
  ],
});

const agentId = string();
const compactionMetrics = {
  agentId,
  tokensBefore: number(),
  tokensAfter: number(),
  summaryOutputTokens: number(),
  keptUserMessageCount: number(),
  keptHeadUserMessageCount: number(),
  droppedCount: number(),
  legacyTail: boolean,
  wireLines: object({ start: integer({ minimum: 0 }), end: integer({ minimum: 0 }) }, ['start', 'end']),
};
const budgetLimits = object({ tokenBudget: number(), turnBudget: number(), wallClockBudgetMs: number() });
const goalStatus = string(['active', 'paused', 'blocked', 'complete']);
const goalActor = string(['user', 'model', 'runtime', 'system']);
const taskStatus = string(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']);
const taskInfo = object(
  {
    taskId: string(),
    kind: string(['process', 'question', 'agent']),
    description: string(),
    status: taskStatus,
    detached: boolean,
    startedAt: number(),
    endedAt: nullableNumber,
    stopReason: string(),
    terminalNotificationSuppressed: boolean,
    resumeReminded: boolean,
    timeoutMs: number(),
    command: string(),
    pid: number(),
    exitCode: nullableNumber,
    parentToolCallId: string(),
    questionCount: number(),
    toolCallId: string(),
    agentId: string(),
    subagentType: string(),
    model: string(),
    thinkingEffort: string(),
    stopCode: string(),
  },
  ['taskId', 'kind', 'description', 'status', 'startedAt', 'endedAt'],
);
const mcpTransport = string(['stdio', 'http', 'sse']);
const tokenCount = (extra = {}, required = []) =>
  object({ agentId, length: number(), tokens: number(), ...extra }, ['agentId', 'length', 'tokens', ...required]);
const profileFields = {
  agentId,
  modelAlias: string(),
  profileName: string(),
  thinkingEffort: string(),
  systemPrompt: string(),
  environmentDisclosure: object({ cwd: string() }, ['cwd']),
  renderGeneration: number(),
  agentsMdPaths: array(string()),
  disallowedTools: array(string()),
};

// Every record below is durable in 2.4.1 (EVENT2_REGISTRY drains only
// `static durable = true` classes). Top-level fields and requiredness are
// checked against the generated manifest by the extractor.
export const persistedSchemas = {
  'changeNotifier.snapshot': object(
    {
      agentId,
      agentsMdHash: { anyOf: [string(), { type: 'null' }] },
      agentsMdFiles: { anyOf: [object(), { type: 'null' }] },
      skillsHash: { anyOf: [string(), { type: 'null' }] },
      subagentNames: { anyOf: [array(string()), { type: 'null' }] },
      modelPool: { anyOf: [object(), { type: 'null' }] },
    },
    ['agentId', 'agentsMdHash', 'skillsHash', 'subagentNames'],
  ),
  'config.update': object({ ...profileFields, thinkingLevel: string() }, ['agentId']),
  'context.append_loop_event': object({ agentId, event: loopEventSchema }, ['agentId', 'event']),
  'context.append_message': object({ agentId, message: contextMessageSchema }, ['agentId', 'message']),
  'context.apply_compaction': object(
    {
      ...compactionMetrics,
      summary: { anyOf: [string(), contextMessageSchema] },
      contextSummary: string(),
      count: number(),
      compactedCount: number(),
    },
    [],
    {
      anyOf: [
        object({ agentId, summary: string(), compactedCount: number() }, ['agentId', 'summary', 'compactedCount']),
        object({ agentId, contextSummary: string(), compactedCount: number() }, [
          'agentId',
          'contextSummary',
          'compactedCount',
        ]),
        object({ agentId, summary: contextMessageSchema, count: number() }, ['agentId', 'summary', 'count']),
      ],
    },
  ),
  'context.clear': object({ agentId }, ['agentId']),
  'context.undo': object({ agentId, count: integer({ exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, [
    'agentId',
    'count',
  ]),
  'cron.add': object(
    {
      task: object(
        {
          id: string(),
          cron: string(),
          prompt: string(),
          createdAt: number(),
          recurring: boolean,
          lastFiredAt: number(),
          tags: object(),
        },
        ['id', 'cron', 'prompt', 'createdAt'],
      ),
    },
    ['task'],
  ),
  'cron.cursor': object({ id: string(), lastFiredAt: number() }, ['id', 'lastFiredAt']),
  'cron.delete': object({ ids: array(string()) }, ['ids']),
  'file_history.checkpoint': object({ agentId, turnId: number(), phase: string(['start', 'end']), entries: object() }, [
    'agentId',
    'turnId',
    'entries',
  ]),
  'file_history.tracked': object(
    {
      agentId,
      turnId: number(),
      path: string(),
      entry: object(
        {
          key: { anyOf: [string(), { type: 'null' }] },
          version: number(),
          contentHash: string(),
          size: number(),
          oversize: boolean,
          mtimeMs: number(),
        },
        ['key', 'version'],
      ),
    },
    ['agentId', 'turnId', 'path', 'entry'],
  ),
  forked: object({ agentId }, ['agentId']),
  'full_compaction.begin': object({ agentId, instruction: string(), source: string(['manual', 'auto']) }, [
    'agentId',
    'source',
  ]),
  'full_compaction.cancel': object({ agentId }, ['agentId']),
  'full_compaction.complete': object({ agentId }, ['agentId']),
  'goal.clear': object({ agentId }, ['agentId']),
  'goal.create': object(
    {
      agentId,
      goalId: string(),
      objective: string(),
      completionCriterion: string(),
      wallClockResumedAt: number({ minimum: 0 }),
      status: goalStatus,
      actor: goalActor,
      budgetLimits,
    },
    ['agentId', 'goalId', 'objective'],
  ),
  'goal.update': object(
    {
      agentId,
      goalId: string(),
      status: goalStatus,
      reason: string(),
      turnsUsed: number(),
      tokensUsed: number(),
      wallClockMs: number(),
      wallClockResumedAt: number({ minimum: 0 }),
      budgetLimits,
      actor: goalActor,
    },
    ['agentId'],
  ),
  'interaction.request': object(
    {
      agentId,
      id: string(),
      kind: string(['approval', 'question', 'user_tool']),
      toolCallId: string(),
      request: {},
    },
    ['agentId', 'id', 'kind', 'request'],
  ),
  'interaction.resolved': object({ agentId, id: string(), response: {} }, ['agentId', 'id', 'response']),
  'interruptionReminder.recorded': object({ agentId, turnId: integer({ minimum: 0 }) }, ['agentId', 'turnId']),
  'llm.request': object(
    {
      agentId,
      kind: string(['loop', 'compaction']),
      provider: string(),
      model: string(),
      modelAlias: string(),
      thinkingEffort: string(),
      thinkingKeep: string(),
      temperature: number(),
      topP: number(),
      maxTokens: number(),
      betaApi: boolean,
      toolSelect: boolean,
      systemPromptHash: string(),
      systemPrompt: string(),
      toolsHash: string(),
      messageCount: number({ minimum: 0 }),
      turnStep: string(),
      attempt: string(),
      projection: string([
        'strict',
        'media-degraded',
        'media-stripped',
        'strict-media-degraded',
        'strict-media-stripped',
      ]),
      droppedCount: number(),
    },
    ['agentId', 'kind', 'provider', 'model', 'toolSelect', 'systemPromptHash', 'toolsHash', 'messageCount'],
  ),
  'llm.tools_snapshot': object(
    {
      agentId,
      hash: string(),
      tools: array(
        object({ name: string(), description: string(), parameters: object() }, ['name', 'description', 'parameters']),
      ),
    },
    ['agentId', 'hash', 'tools'],
  ),
  'mcp.server_failed': object({ agentId, serverName: string(), transport: mcpTransport, error: string() }, [
    'agentId',
    'serverName',
    'transport',
  ]),
  'mcp.server_failure_resolved': object(
    {
      agentId,
      serverName: string(),
      transport: mcpTransport,
      resolution: string(['recovered', 'needs-auth', 'disabled', 'removed']),
    },
    ['agentId', 'serverName', 'transport', 'resolution'],
  ),
  'mcp.tools_discovered': object(
    {
      agentId,
      serverName: string(),
      hash: string(),
      tools: array(),
      enabledNames: array(string()),
      collisions: array(
        object({ qualified: string(), toolName: string(), collidesWith: object() }, [
          'qualified',
          'toolName',
          'collidesWith',
        ]),
      ),
    },
    ['agentId', 'serverName', 'hash', 'tools', 'enabledNames'],
  ),
  'permission.record_approval_result': object(
    {
      agentId,
      turnId: number(),
      toolCallId: string(),
      toolName: string(),
      action: string(),
      sessionApprovalRule: string(),
      result: object(
        {
          decision: string(['approved', 'rejected', 'cancelled']),
          scope: string(['session']),
          feedback: string(),
          selectedLabel: string(),
        },
        ['decision'],
      ),
    },
    ['agentId', 'turnId', 'toolCallId', 'toolName', 'action', 'result'],
  ),
  'permission.set_mode': object({ agentId, mode: string(['manual', 'yolo', 'auto']) }, ['agentId', 'mode']),
  'plan_mode.cancel': object({ agentId, id: string() }, ['agentId']),
  'plan_mode.enter': object({ agentId, id: string() }, ['agentId', 'id']),
  'plan_mode.exit': object({ agentId, id: string() }, ['agentId']),
  'plan.revision': object(
    { agentId, id: string(), version: number(), key: string(), sha256: string(), bytes: number() },
    ['agentId', 'id', 'version', 'key', 'sha256', 'bytes'],
  ),
  'plugin.session_start': object({ agentId, content: { anyOf: [string(), { type: 'null' }] } }, ['agentId', 'content']),
  'profile.bind': object({ ...profileFields, activeToolNames: array(string()), subagents: array(string()) }, [
    'agentId',
    'thinkingEffort',
    'systemPrompt',
    'disallowedTools',
  ]),
  'prompt.aborted': object({ agentId, promptId: string(), abortedAt: string() }, ['agentId', 'promptId', 'abortedAt']),
  'prompt.completed': object(
    { agentId, promptId: string(), finishedAt: string(), reason: string(['completed', 'failed', 'blocked']) },
    ['agentId', 'promptId', 'finishedAt', 'reason'],
  ),
  'prompt.steered': object(
    {
      agentId,
      activePromptId: string(),
      promptIds: array(string()),
      content: array(contentPartSchema),
      steeredAt: string(),
      messageId: string(),
    },
    ['agentId', 'activePromptId', 'promptIds', 'content', 'steeredAt'],
  ),
  'runtime.set_binding': object({ agentId, workspaceId: string(), runtimeId: string() }, [
    'agentId',
    'workspaceId',
    'runtimeId',
  ]),
  // Subagent mirror records are written into the parent journal and carry the
  // child's id rather than an `agentId` field.
  'subagent.cancelled': object({ subagentId: string() }, ['subagentId']),
  'subagent.completed': object(
    { subagentId: string(), resultSummary: string(), usage: tokenUsageSchema, contextTokens: number() },
    ['subagentId', 'resultSummary'],
  ),
  'subagent.failed': object({ subagentId: string(), error: string() }, ['subagentId', 'error']),
  'subagent.spawned': object(
    {
      subagentId: string(),
      subagentName: string(),
      parentToolCallId: string(),
      parentToolCallUuid: string(),
      parentAgentId: string(),
      callerAgentId: string(),
      description: string(),
      swarmIndex: number(),
      runInBackground: boolean,
      model: string(),
      thinkingEffort: string(),
      taskId: string(),
    },
    ['subagentId', 'subagentName', 'parentToolCallId', 'runInBackground'],
  ),
  'subagent.started': object({ subagentId: string() }, ['subagentId']),
  'swarm_mode.enter': object({ agentId, trigger: string(['manual', 'task', 'tool']) }, ['agentId', 'trigger']),
  'swarm_mode.exit': object({ agentId }, ['agentId']),
  'task.started': object({ agentId, info: taskInfo }, ['agentId', 'info']),
  'task.terminated': object({ agentId, info: taskInfo, outputTail: string() }, ['agentId', 'info']),
  'task.waitDelivered': object({ agentId, keys: array(string()) }, ['agentId', 'keys']),
  'token_counting.measured': tokenCount(),
  'token_counting.rebased': tokenCount({ measured: boolean }, ['measured']),
  'token_counting.truncated': tokenCount(),
  'token_counting.turn_recorded': tokenCount({ turnId: number() }, ['turnId']),
  'tools.register_user_tool': object(
    {
      agentId,
      name: string(),
      description: string(),
      parameters: object(),
      disclosure: string(['inline', 'deferred']),
    },
    ['agentId', 'name', 'description', 'parameters'],
  ),
  'tools.reset_active_tools': object({ agentId }, ['agentId']),
  'tools.set_active_tools': object({ agentId, names: array(string()) }, ['agentId', 'names']),
  'tools.unregister_user_tool': object({ agentId, name: string() }, ['agentId', 'name']),
  'tools.update_store': object({ agentId, key: string(), value: {} }, ['agentId', 'key', 'value']),
  'tower_mode.enter': object({ agentId, sessionId: string() }, ['agentId']),
  'tower_mode.exit': object({ agentId }, ['agentId']),
  'turn.cancel': object(
    {
      agentId,
      turnId: number(),
      target: string(['active', 'queued']),
      reason: string(['user_cancelled', 'aborted']),
    },
    ['agentId'],
  ),
  'turn.ended': object(
    {
      agentId,
      turnId: number(),
      reason: string(['completed', 'cancelled', 'failed', 'blocked']),
      error: errorSchema,
      durationMs: number(),
      stopReason: string(),
      traceId: string(),
    },
    ['agentId', 'turnId', 'reason'],
  ),
  'turn.prompt': object(
    { agentId, input: array(contentPartSchema), origin: promptOriginSchema, promptId: string(), turnId: number() },
    ['agentId', 'input', 'origin'],
  ),
  'turn.steer': object(
    {
      agentId,
      input: array(contentPartSchema),
      origin: promptOriginSchema,
      messageId: string(),
      promptIds: array(string()),
      turnId: number(),
    },
    ['agentId', 'input', 'origin'],
  ),
  'turn.step.interrupted': object(
    { agentId, turnId: number(), step: number(), stepId: string(), reason: string(), message: string() },
    ['agentId', 'turnId', 'step', 'reason'],
  ),
  'turn.step.retrying': object(
    {
      agentId,
      turnId: number(),
      step: number(),
      stepId: string(),
      failedAttempt: number(),
      nextAttempt: number(),
      maxAttempts: number(),
      delayMs: number(),
      errorName: string(),
      errorMessage: string(),
      statusCode: number(),
    },
    [
      'agentId',
      'turnId',
      'step',
      'failedAttempt',
      'nextAttempt',
      'maxAttempts',
      'delayMs',
      'errorName',
      'errorMessage',
    ],
  ),
  'usage.record': object(
    { agentId, model: string(), usage: tokenUsageSchema, usageScope: string(['session', 'turn']) },
    ['agentId', 'model', 'usage'],
  ),
};

// 2.4.1 has no transient manifest entries; these 0.34.0 operations were retired.
export const transientTypes = [];
export const retiredTypes = ['permission.rules.add', 'skill.activate'];

/**
 * Durable records outside the generated manifest. The loop engine's journal
 * (`src/agent/loop/machine/storeJournal.ts`) appends `agent.<event>` records
 * from `src/human/agent/events.ts` with a `kind` discriminator, and undo
 * (`src/wire/tree/fork.ts`) appends an `agent.switched` branch edge plus a
 * paired legacy `context.undo` and a `context.undone` marker.
 */
export const engineJournalTypes = ['agent.message.appended', 'agent.turn.started', 'agent.turn.ended'];
export const supplementalSchemas = {
  'agent.message.appended': object({ kind: string(), message: object() }, ['kind', 'message']),
  'agent.turn.started': object({ kind: string(), turnId: integer(), queueItemId: string() }, ['kind', 'turnId']),
  'agent.turn.ended': object(
    { kind: string(), turnId: integer(), outcome: string(['done', 'failed', 'aborted']), errorMessage: string() },
    ['kind', 'turnId', 'outcome'],
  ),
  'agent.switched': object(
    {
      agentId,
      branch: string(),
      reason: string(),
      base: object({ branch: string(), line: number() }, ['branch', 'line']),
      turns: number(),
      legacyUndoLine: number(),
    },
    ['agentId', 'branch', 'base'],
  ),
  'context.undone': object({ agentId, turns: number(), fromTurnId: number() }, ['agentId', 'turns']),
};

export const hookEvents = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'UserPromptSubmit',
  'UserPromptQueued',
  'TurnStarted',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SessionHeartbeat',
  'SubagentStart',
  'SubagentStop',
  'TaskStarted',
  'PreCompact',
  'PostCompact',
  'Notification',
];

const commonHookFields = {
  hook_event_name: string(hookEvents),
  session_id: string(),
  cwd: string(),
  client_type: string(),
  session_title: string(),
};
const hook = (event, fields = {}, required = []) =>
  object({ ...commonHookFields, hook_event_name: string([event]), ...fields }, [
    'hook_event_name',
    'session_id',
    'cwd',
    'client_type',
    ...required,
  ]);
const permissionFields = {
  id: string(),
  agent_id: string(),
  turn_id: number(),
  tool_call_id: string(),
  tool_name: string(),
  action: string(),
  display: object(),
  tool_input: {},
};
export const hookSchemas = {
  PreToolUse: hook('PreToolUse', { tool_name: string(), tool_input: object(), tool_call_id: string() }, [
    'tool_name',
    'tool_input',
    'tool_call_id',
  ]),
  PostToolUse: hook(
    'PostToolUse',
    { tool_name: string(), tool_input: object(), tool_call_id: string(), tool_output: string() },
    ['tool_name', 'tool_input', 'tool_call_id', 'tool_output'],
  ),
  PostToolUseFailure: hook(
    'PostToolUseFailure',
    { tool_name: string(), tool_input: object(), tool_call_id: string(), error: errorSchema },
    ['tool_name', 'tool_input', 'tool_call_id', 'error'],
  ),
  PermissionRequest: hook('PermissionRequest', permissionFields, [
    'agent_id',
    'turn_id',
    'tool_call_id',
    'tool_name',
    'action',
    'display',
    'tool_input',
  ]),
  PermissionResult: hook(
    'PermissionResult',
    {
      ...permissionFields,
      decision: string(['approved', 'rejected', 'cancelled', 'error']),
      scope: string(['session']),
      feedback: string(),
      selected_label: string(),
      error: string(),
    },
    ['agent_id', 'turn_id', 'tool_call_id', 'tool_name', 'action', 'display', 'tool_input', 'decision'],
  ),
  UserPromptSubmit: hook('UserPromptSubmit', { prompt: array(contentPartSchema), is_steer: boolean }, [
    'prompt',
    'is_steer',
  ]),
  UserPromptQueued: hook(
    'UserPromptQueued',
    { prompt_id: string(), prompt: array(contentPartSchema), queue_length: number() },
    ['prompt_id', 'prompt', 'queue_length'],
  ),
  TurnStarted: hook(
    'TurnStarted',
    { turn_id: number(), origin_kind: string(promptOrigins), origin_name: string(), prompt: string() },
    ['turn_id', 'origin_kind'],
  ),
  Stop: hook('Stop', { stop_hook_active: boolean }, ['stop_hook_active']),
  StopFailure: hook('StopFailure', { error_type: string(), error_message: string() }, ['error_message']),
  Interrupt: hook('Interrupt', { turn_id: number(), reason: string(['cancelled']) }, ['turn_id', 'reason']),
  SessionStart: hook('SessionStart', { source: string(['startup', 'resume']), model: string(), profile: string() }, [
    'source',
    'model',
  ]),
  SessionEnd: hook('SessionEnd', { reason: string(['exit', 'archive']) }, ['reason']),
  SessionHeartbeat: hook('SessionHeartbeat', { uptime_ms: number({ minimum: 0 }) }, ['uptime_ms']),
  SubagentStart: hook('SubagentStart', { agent_name: string(), prompt: string() }, ['agent_name', 'prompt']),
  SubagentStop: hook('SubagentStop', { agent_name: string(), response: string() }, ['agent_name', 'response']),
  TaskStarted: hook(
    'TaskStarted',
    {
      task_id: string(),
      kind: string(['process', 'question', 'agent']),
      description: string(),
      status: string(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
      detached: boolean,
      started_at: number(),
    },
    ['task_id', 'kind', 'description', 'status', 'started_at'],
  ),
  PreCompact: hook('PreCompact', { trigger: string(['manual', 'auto']), token_count: number() }, [
    'trigger',
    'token_count',
  ]),
  PostCompact: hook('PostCompact', { trigger: string(['manual', 'auto']), estimated_token_count: number() }, [
    'trigger',
    'estimated_token_count',
  ]),
  Notification: hook(
    'Notification',
    {
      sink: string(['context']),
      agent_id: string(),
      notification_type: string(),
      title: string(),
      body: string(),
      severity: string(['info', 'warning']),
      source_kind: string(),
      source_id: string(),
    },
    ['sink', 'agent_id', 'notification_type', 'title', 'body', 'severity', 'source_kind', 'source_id'],
  ),
};

export const cliOptions = {
  session: ['-S', '--session', '-r', '--resume'],
  continue: ['-c', '-C', '--continue'],
  yolo: ['-y', '--yolo', '--yes', '--auto-approve'],
  auto: ['--auto'],
  model: ['-m', '--model'],
  prompt: ['-p', '--prompt'],
  outputFormat: ['--output-format'],
  skillsDir: ['--skills-dir'],
  agent: ['--agent'],
  agentFile: ['--agent-file'],
  addDir: ['--add-dir'],
  plan: ['--plan'],
};

export const sourceFiles = [
  'apps/kimi-code/src/cli/commands.ts',
  'apps/kimi-code/src/cli/options.ts',
  'packages/agent-core-v2/docs/wire-manifest.d.ts',
  'packages/agent-core-v2/src/_base/utils/workdir-slug.ts',
  'packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts',
  'packages/agent-core-v2/src/agent/contextMemory/types.ts',
  'packages/agent-core-v2/src/agent/fullCompaction/types.ts',
  'packages/agent-core-v2/src/agent/loop/loopService.ts',
  'packages/agent-core-v2/src/agent/loop/machine/storeJournal.ts',
  'packages/agent-core-v2/src/agent/permissionRules/permissionRules.ts',
  'packages/agent-core-v2/src/agent/task/task.ts',
  'packages/agent-core-v2/src/agent/task/types.ts',
  'packages/agent-core-v2/src/agent/toolApproval/toolApprovalService.ts',
  'packages/agent-core-v2/src/agent/tools/agent/subagent-task.ts',
  'packages/agent-core-v2/src/agent/tools/ask-user-question/question-background-task.ts',
  'packages/agent-core-v2/src/agent/tools/os/bash/process-task.ts',
  'packages/agent-core-v2/src/agent/undo/undoService.ts',
  'packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts',
  'packages/agent-core-v2/src/features/externalHooks/app/externalHooksRunnerService.ts',
  'packages/agent-core-v2/src/features/externalHooks/internal/runHook.ts',
  'packages/agent-core-v2/src/features/externalHooks/internal/types.ts',
  'packages/agent-core-v2/src/features/externalHooks/session/sessionExternalHooksService.ts',
  'packages/agent-core-v2/src/human/agent/events.ts',
  'packages/agent-core-v2/src/human/llm/finish-reason.ts',
  'packages/agent-core-v2/src/human/llm/message.ts',
  'packages/agent-core-v2/src/human/llm/thinking.ts',
  'packages/agent-core-v2/src/human/llm/usage.ts',
  'packages/agent-core-v2/src/llm-adapter/contract/message.ts',
  'packages/agent-core-v2/src/session/subagent/subagent.ts',
  'packages/agent-core-v2/src/tool/toolInputDisplay.ts',
  'packages/agent-core-v2/src/wire/human.ts',
  'packages/agent-core-v2/src/wire/migration/migration.ts',
  'packages/agent-core-v2/src/wire/tree/fork.ts',
  'packages/agent-core-v2/src/wire/tree/tree.ts',
];
