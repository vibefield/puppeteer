/**
 * Curated ASM-subset projection of the exact Kimi Code 0.34.0 release source.
 *
 * `extract-source-reference.mjs` refuses to emit a reference unless the
 * checkout revision, generated wire manifest, persisted/transient inventory,
 * protocol version, hook inventory, and CLI declarations all match. The
 * resulting tracked reference also pins every contributing source file by
 * SHA-256. The model generator consumes that reference instead of carrying a
 * second hand-written copy of these schemas.
 */

export const VERSION = '0.34.0';
export const SOURCE_COMMIT = 'f0614c53e59f7e1e257412063b059b9eb82764cf';
export const SOURCE_TAG = '@moonshot-ai/kimi-code@0.34.0';
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

const urlValue = object({ url: string(), id: string() }, ['url']);
export const contentPartSchema = {
  anyOf: [
    object({ type: string(['text']), text: string() }, ['type', 'text']),
    object({ type: string(['think']), think: string(), encrypted: string() }, ['type', 'think']),
    object({ type: string(['image_url']), imageUrl: urlValue }, ['type', 'imageUrl']),
    object({ type: string(['audio_url']), audioUrl: urlValue }, ['type', 'audioUrl']),
    object({ type: string(['video_url']), videoUrl: urlValue }, ['type', 'videoUrl']),
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
  disclosure: object({ kind: string(['date']), renderGeneration: number(), localDate: string(), timeZone: string() }, [
    'kind',
    'renderGeneration',
    'localDate',
    'timeZone',
  ]),
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
    originBranch('retry'),
  ],
});

const toolCallSchema = object(
  {
    type: string(['function']),
    id: string(),
    name: string(),
    arguments: { anyOf: [string(), { type: 'null' }] },
    extras: object(),
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
    note: string(),
  },
  ['role', 'content', 'toolCalls'],
);

export const tokenUsageSchema = object(
  { inputOther: number(), output: number(), inputCacheRead: number(), inputCacheCreation: number() },
  ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'],
);

const errorSchema = object(
  { code: string(), message: string(), name: string(), details: object(), retryable: boolean, cause: object() },
  ['code', 'message', 'retryable'],
);
const toolResultSchema = object(
  { output: { anyOf: [string(), array(contentPartSchema)] }, isError: boolean, note: string() },
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
  result: toolResultSchema,
  finishReason: string(),
  usage: tokenUsageSchema,
  llmFirstTokenLatencyMs: number(),
  llmStreamDurationMs: number(),
  llmRequestBuildMs: number(),
  llmServerFirstTokenMs: number(),
  llmServerDecodeMs: number(),
  llmClientConsumeMs: number(),
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

const compactionMetrics = {
  tokensBefore: number(),
  tokensAfter: number(),
  summaryOutputTokens: number(),
  keptUserMessageCount: number(),
  keptHeadUserMessageCount: number(),
  droppedCount: number(),
  legacyTail: boolean,
};
const budgetLimits = object({ tokenBudget: number(), turnBudget: number(), wallClockBudgetMs: number() });
const goalStatus = string(['active', 'paused', 'blocked', 'complete']);
const goalActor = string(['user', 'model', 'runtime', 'system']);
const taskInfo = object(
  {
    taskId: string(),
    kind: string(['process', 'question', 'agent']),
    description: string(),
    status: string(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
    detached: boolean,
    startedAt: number(),
    endedAt: nullableNumber,
    stopReason: string(),
    terminalNotificationSuppressed: boolean,
    timeoutMs: number(),
    command: string(),
    pid: number(),
    exitCode: nullableNumber,
    questionCount: number(),
    toolCallId: string(),
    agentId: string(),
    subagentType: string(),
    model: string(),
    thinkingEffort: string(),
  },
  ['taskId', 'kind', 'description', 'status', 'startedAt', 'endedAt'],
);

export const persistedSchemas = {
  'config.update': object({
    modelAlias: string(),
    profileName: string(),
    thinkingEffort: string(),
    thinkingLevel: string(),
    systemPrompt: string(),
    environmentDisclosure: object(),
    renderGeneration: number(),
    agentsMdPaths: array(string()),
    disallowedTools: array(string()),
  }),
  'context.append_loop_event': object({ event: loopEventSchema }, ['event']),
  'context.append_message': object({ message: contextMessageSchema }, ['message']),
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
        object({ summary: string(), compactedCount: number() }, ['summary', 'compactedCount']),
        object({ contextSummary: string(), compactedCount: number() }, ['contextSummary', 'compactedCount']),
        object({ summary: contextMessageSchema, count: number() }, ['summary', 'count']),
      ],
    },
  ),
  'context.clear': object(),
  'context.undo': object({ count: integer({ exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, ['count']),
  forked: object(),
  'full_compaction.begin': object({ instruction: string(), source: string(['manual', 'auto']) }, ['source']),
  'full_compaction.cancel': object(),
  'full_compaction.complete': object(),
  'goal.clear': object(),
  'goal.create': object(
    {
      goalId: string(),
      objective: string(),
      completionCriterion: string(),
      wallClockResumedAt: number({ minimum: 0 }),
      status: goalStatus,
      actor: goalActor,
      budgetLimits,
    },
    ['goalId', 'objective'],
  ),
  'goal.update': object({
    goalId: string(),
    status: goalStatus,
    reason: string(),
    turnsUsed: number(),
    tokensUsed: number(),
    wallClockMs: number(),
    wallClockResumedAt: number({ minimum: 0 }),
    budgetLimits,
    actor: goalActor,
  }),
  'interaction.request': object(
    {
      id: string(),
      kind: string(['approval', 'question', 'user_tool']),
      toolCallId: string(),
      agentId: string(),
      request: {},
    },
    ['id', 'kind', 'request'],
  ),
  'interaction.resolved': object({ id: string(), response: {} }, ['id', 'response']),
  'interruptionReminder.recorded': object({ turnId: integer({ minimum: 0 }) }, ['turnId']),
  'llm.request': object(
    {
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
      projection: string(['strict', 'media-degraded', 'media-stripped']),
      droppedCount: number(),
    },
    ['kind', 'provider', 'model', 'toolSelect', 'systemPromptHash', 'toolsHash', 'messageCount'],
  ),
  'llm.tools_snapshot': object(
    {
      hash: string(),
      tools: array(
        object({ name: string(), description: string(), parameters: object() }, ['name', 'description', 'parameters']),
      ),
    },
    ['hash', 'tools'],
  ),
  'mcp.tools_discovered': object(
    {
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
    ['serverName', 'hash', 'tools', 'enabledNames'],
  ),
  'permission.record_approval_result': object(
    {
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
    ['turnId', 'toolCallId', 'toolName', 'action', 'result'],
  ),
  'permission.set_mode': object({ mode: string(['manual', 'yolo', 'auto']) }, ['mode']),
  'plan_mode.cancel': object({ id: string() }),
  'plan_mode.enter': object({ id: string() }, ['id']),
  'plan_mode.exit': object({ id: string() }),
  'plan.revision': object({ id: string(), version: number(), path: string(), sha256: string(), bytes: number() }, [
    'id',
    'version',
    'path',
    'sha256',
    'bytes',
  ]),
  'profile.bind': object(
    {
      modelAlias: string(),
      profileName: string(),
      thinkingEffort: string(),
      systemPrompt: string(),
      environmentDisclosure: object(),
      renderGeneration: number(),
      agentsMdPaths: array(string()),
      activeToolNames: array(string()),
      disallowedTools: array(string()),
      subagents: array(string()),
    },
    ['thinkingEffort', 'systemPrompt', 'disallowedTools'],
  ),
  'swarm_mode.enter': object({ trigger: string(['manual', 'task', 'tool']) }, ['trigger']),
  'swarm_mode.exit': object(),
  'task.started': object({ info: taskInfo }, ['info']),
  'task.terminated': object({ info: taskInfo, outputTail: string() }, ['info']),
  'tools.register_user_tool': object(
    { name: string(), description: string(), parameters: object(), disclosure: string(['inline', 'deferred']) },
    ['name', 'description', 'parameters'],
  ),
  'tools.reset_active_tools': object(),
  'tools.set_active_tools': object({ names: array(string()) }, ['names']),
  'tools.unregister_user_tool': object({ name: string() }, ['name']),
  'tools.update_store': object({ key: string(), value: {} }, ['key', 'value']),
  'turn.cancel': object({
    turnId: number(),
    target: string(['active', 'queued']),
    reason: string(['user_cancelled', 'aborted']),
  }),
  'turn.ended': object(
    {
      turnId: number(),
      reason: string(['completed', 'cancelled', 'failed', 'blocked']),
      error: errorSchema,
      durationMs: number(),
    },
    ['turnId', 'reason'],
  ),
  'turn.prompt': object({ input: array(contentPartSchema), origin: promptOriginSchema }, ['input', 'origin']),
  'turn.steer': object({ input: array(contentPartSchema), origin: promptOriginSchema }, ['input', 'origin']),
  'usage.record': object({ model: string(), usage: tokenUsageSchema, usageScope: string(['session', 'turn']) }, [
    'model',
    'usage',
  ]),
};

export const transientTypes = [
  'cron.add',
  'cron.cursor',
  'cron.delete',
  'permission.rules.add',
  'skill.activate',
  'token_counting.measured',
  'token_counting.rebased',
  'token_counting.truncated',
];

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
    ['turn_id', 'tool_call_id', 'tool_name', 'action', 'display', 'tool_input', 'decision'],
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
      notification_type: string(),
      title: string(),
      body: string(),
      severity: string(['info', 'warning']),
      source_kind: string(),
      source_id: string(),
    },
    ['sink', 'notification_type', 'title', 'body', 'severity', 'source_kind', 'source_id'],
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
  'packages/agent-core-v2/src/agent/contextMemory/contextOps.ts',
  'packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts',
  'packages/agent-core-v2/src/agent/contextMemory/types.ts',
  'packages/agent-core-v2/src/agent/externalHooks/externalHooksService.ts',
  'packages/agent-core-v2/src/agent/fullCompaction/fullCompaction.ts',
  'packages/agent-core-v2/src/agent/fullCompaction/types.ts',
  'packages/agent-core-v2/src/agent/llmRequester/llmRequestOps.ts',
  'packages/agent-core-v2/src/agent/loop/turnEvents.ts',
  'packages/agent-core-v2/src/agent/permissionPolicy/types.ts',
  'packages/agent-core-v2/src/agent/prompt/promptService.ts',
  'packages/agent-core-v2/src/agent/task/types.ts',
  'packages/agent-core-v2/src/agent/toolApproval/toolApprovalService.ts',
  'packages/agent-core-v2/src/agent/tools/agent/subagent-task.ts',
  'packages/agent-core-v2/src/agent/tools/ask-user-question/question-background-task.ts',
  'packages/agent-core-v2/src/agent/tools/os/bash/process-task.ts',
  'packages/agent-core-v2/src/agent/externalHooks/types.ts',
  'packages/agent-core-v2/src/app/externalHooksRunner/externalHooksRunnerService.ts',
  'packages/agent-core-v2/src/app/externalHooksRunner/runner.ts',
  'packages/agent-core-v2/src/kosong/contract/message.ts',
  'packages/agent-core-v2/src/kosong/contract/provider.ts',
  'packages/agent-core-v2/src/kosong/contract/usage.ts',
  'packages/agent-core-v2/src/session/externalHooks/externalHooksService.ts',
  'packages/agent-core-v2/src/session/sessionLifecycleHooks/sessionLifecycleHooks.ts',
  'packages/agent-core-v2/src/session/subagent/subagent.ts',
  'packages/agent-core-v2/src/wire/migration/migration.ts',
];
