/**
 * Claude hook → normalized AgentEvent translation (DESIGN §16.7), corrected
 * by the two censuses (packages/surface/vendors/claude/findings.md):
 *
 * - `prompt_id` is the native turn id; MessageDisplay additionally carries a
 *   distinct `turn_id` (assistant response cycle) — both are surfaced for
 *   envelope stamping.
 * - MessageDisplay STREAMS: deltas are accumulated per message_id and an
 *   assistant.message is emitted per delta with `final` marking completion.
 * - PermissionRequest carries NO tool_use_id or request id. As of 2.1.226,
 *   PreToolUse fires first for every call and PermissionRequest follows only
 *   when a decision is needed. We correlate by prompt, tool name, and canonical
 *   tool input, while still tolerating the legacy reverse ordering. Execution
 *   completion proves allow; PermissionDenied or a turn boundary closes denial.
 * - SubagentStop is re-entrant (1× stop_hook_active:false, then N× true):
 *   only the first occurrence per agent_id normalizes to subagent.stopped.
 * - Unknown events are RETAINED (ADR-008) as adapter.native-event; the raw
 *   body always rides the envelope's nativeEvent upstream.
 *
 * Stateful by necessity (delta accumulation, permission FIFO, stop dedup) —
 * one normalizer instance per Claude session.
 */

import type {
  AgentEvent,
  AgentStructuredQuestion,
  PlanUpdatedEvent,
  TaskUpdatedEvent,
  ToolActivityKind,
  ToolPresentation,
} from '@vibecook/chopsticks-core';
import { AGENT_MONITOR_COLLECTION_LIMITS } from '@vibecook/chopsticks-core';
import { claudePermissionMode } from './provider-modes.js';

export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt_id?: string;
  [key: string]: unknown;
}

export interface NormalizedHook {
  events: AgentEvent[];
  diagnostics: ClaudeHookDiagnostic[];
  sessionId?: string;
  transcriptPath?: string;
  /** User-turn correlation (`prompt_id`). */
  promptId?: string;
  /** Assistant response-cycle correlation (MessageDisplay `turn_id`). */
  turnId?: string;
  agentId?: string;
  agentType?: string;
  providerVersion?: string;
}

export interface ClaudeHookDiagnostic {
  code: 'malformed-known-hook' | 'permission-outlived-turn';
  hookEventName: string;
  issues: string[];
}

interface PendingPermission {
  requestId: string;
  promptId?: string;
  toolName: string;
  inputKey: string;
  toolCallId?: string;
}

interface RecentToolRequest {
  toolCallId: string;
  promptId?: string;
  toolName: string;
  inputKey: string;
  input?: unknown;
  permissionRequestId?: string;
  questionRequestId?: string;
  plan?: Pick<PlanUpdatedEvent, 'planId' | 'steps'>;
  task?: Omit<TaskUpdatedEvent, 'type' | 'provisional'>;
}

interface PendingQuestion {
  requestId: string;
  promptId?: string;
  toolCallId: string;
}

const MAX_TRACKED_ITEMS = 64;

type FieldRequirement = readonly [field: string, kind: 'string' | 'boolean' | 'present'];

/**
 * Narrow live checks for fields normalization actually depends on. Surface owns
 * complete schemas; the live adapter must remain forward-compatible and never
 * block Claude merely because an unrelated field drifted.
 */
const NORMALIZER_REQUIREMENTS: Readonly<Record<string, readonly FieldRequirement[]>> = {
  SessionStart: [['session_id', 'string']],
  UserPromptSubmit: [['prompt', 'string']],
  MessageDisplay: [
    ['message_id', 'string'],
    ['delta', 'string'],
    ['final', 'boolean'],
  ],
  PermissionRequest: [
    ['tool_name', 'string'],
    ['tool_input', 'present'],
  ],
  PreToolUse: [
    ['tool_name', 'string'],
    ['tool_input', 'present'],
  ],
  PostToolUse: [],
  PostToolUseFailure: [],
  PermissionDenied: [
    ['tool_name', 'string'],
    ['tool_input', 'present'],
  ],
  SubagentStart: [['agent_id', 'string']],
  SubagentStop: [['agent_id', 'string']],
  TaskCreated: [['task_id', 'string']],
  TaskCompleted: [['task_id', 'string']],
  TeammateIdle: [
    ['team_name', 'string'],
    ['teammate_name', 'string'],
  ],
  PreCompact: [['trigger', 'string']],
  PostCompact: [['trigger', 'string']],
  DirectoryAdded: [['directory', 'string']],
  FileChanged: [['file_path', 'string']],
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function nonEmpty(value: unknown): string | undefined {
  const candidate = str(value)?.trim();
  return candidate ? candidate : undefined;
}

function hookDiagnostic(name: string, body: ClaudeHookPayload): ClaudeHookDiagnostic | undefined {
  const requirements = NORMALIZER_REQUIREMENTS[name];
  if (!requirements) return undefined;
  const issues: string[] = [];
  for (const [field, kind] of requirements) {
    if (kind === 'present') {
      if (!Object.hasOwn(body, field)) issues.push(`missing ${field}`);
      continue;
    }
    if (typeof body[field] !== kind) issues.push(`${field} must be ${kind}`);
  }
  return issues.length > 0 ? { code: 'malformed-known-hook', hookEventName: name, issues } : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = rec(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function effortLevel(value: unknown): string | undefined {
  return str(value) ?? str(rec(value)?.level);
}

function parseStructuredQuestions(input: unknown): AgentStructuredQuestion[] | undefined {
  const root = rec(input);
  if (!root || !Array.isArray(root.questions)) return undefined;
  const questions = root.questions;
  const rootFreeForm = bool(root.allowFreeForm) ?? bool(root.allow_free_form);
  const parsed: AgentStructuredQuestion[] = [];
  for (const value of questions) {
    const question = rec(value);
    const prompt = nonEmpty(question?.question) ?? nonEmpty(question?.prompt);
    if (!question || !prompt) continue;
    const options = Array.isArray(question.options)
      ? (question.options.flatMap((option) => {
          const candidate = rec(option);
          const label = nonEmpty(candidate?.label);
          if (!candidate || !label) return [];
          const description = str(candidate.description);
          return [{ label, ...(description !== undefined ? { description } : {}) }];
        }) satisfies NonNullable<AgentStructuredQuestion['options']>)
      : undefined;
    const id = nonEmpty(question.id);
    const header = str(question.header);
    const allowMultiple = bool(question.multiSelect) ?? bool(question.multi_select) ?? false;
    // Claude's native chooser always offers its free-form "Other" path. Keep
    // honoring an explicit future field if the provider makes that optional.
    const allowFreeForm = bool(question.allowFreeForm) ?? bool(question.allow_free_form) ?? rootFreeForm ?? true;
    parsed.push({
      ...(id ? { id } : {}),
      ...(header !== undefined ? { header } : {}),
      prompt,
      ...(options ? { options } : {}),
      allowMultiple,
      allowFreeForm,
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseTodoPlan(
  toolName: string,
  input: unknown,
  agentId: string | undefined,
): Pick<PlanUpdatedEvent, 'planId' | 'steps'> | undefined {
  if (toolName.toLowerCase() !== 'todowrite') return undefined;
  const todos = rec(input)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const steps = todos.flatMap((value): PlanUpdatedEvent['steps'] => {
    const todo = rec(value);
    const text = nonEmpty(todo?.content) ?? nonEmpty(todo?.title) ?? nonEmpty(todo?.activeForm);
    if (!todo || !text) return [];
    return [{ text, status: str(todo.status) ?? 'unknown' }];
  });
  return { planId: `claude-todos:${agentId ?? 'root'}`, steps };
}

const MAX_PLAN_STEP_CHARS = 512;

function boundedPlanStepText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_PLAN_STEP_CHARS ? compact : `${compact.slice(0, MAX_PLAN_STEP_CHARS - 1)}…`;
}

/**
 * Claude writes its Markdown plan before ExitPlanMode and injects that content
 * into the hook input. Project list items conservatively; the native plan path
 * remains raw compatibility evidence rather than entering monitor plan state.
 */
function parseExitPlan(
  toolName: string,
  input: unknown,
  agentId: string | undefined,
): Pick<PlanUpdatedEvent, 'planId' | 'steps'> | undefined {
  if (toolName.toLowerCase() !== 'exitplanmode') return undefined;
  const markdown = nonEmpty(rec(input)?.plan);
  if (!markdown) return undefined;

  const steps: PlanUpdatedEvent['steps'] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/);
    const text = item?.[2] ? boundedPlanStepText(item[2]) : undefined;
    if (!text) continue;
    steps.push({ text, status: item?.[1]?.toLowerCase() === 'x' ? 'completed' : 'pending' });
    if (steps.length >= AGENT_MONITOR_COLLECTION_LIMITS.planSteps) break;
  }

  if (steps.length === 0) {
    const fallback = markdown
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trim())
      .find(Boolean);
    if (fallback) steps.push({ text: boundedPlanStepText(fallback), status: 'pending' });
  }

  return steps.length > 0 ? { planId: `claude-plan:${agentId ?? 'root'}`, steps } : undefined;
}

function parsePlanProjection(
  toolName: string,
  input: unknown,
  agentId: string | undefined,
): Pick<PlanUpdatedEvent, 'planId' | 'steps'> | undefined {
  return parseTodoPlan(toolName, input, agentId) ?? parseExitPlan(toolName, input, agentId);
}

function normalizedTaskStatus(value: string | undefined): TaskUpdatedEvent['status'] {
  switch (value?.toLowerCase().replaceAll('_', '-')) {
    case 'proposed':
      return 'proposed';
    case 'pending':
    case 'open':
      return 'pending';
    case 'in-progress':
    case 'active':
    case 'working':
      return 'in-progress';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'removed':
    case 'deleted':
      return 'removed';
    default:
      return 'unknown';
  }
}

function parseTaskProjection(toolName: string, input: unknown): RecentToolRequest['task'] {
  const name = toolName.toLowerCase();
  if (name !== 'taskcreate' && name !== 'taskupdate') return undefined;
  const body = rec(input);
  if (!body) return undefined;
  const providerStatus = str(body.status);
  const taskId = nonEmpty(body.task_id) ?? nonEmpty(body.taskId) ?? nonEmpty(body.id);
  const description =
    str(body.description) ?? str(body.task_description) ?? str(body.subject) ?? str(body.task_subject);
  return {
    taskId: taskId ?? '',
    ...(description !== undefined ? { description } : {}),
    status: name === 'taskcreate' ? 'pending' : normalizedTaskStatus(providerStatus),
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(str(body.team_name) !== undefined ? { teamName: str(body.team_name) } : {}),
    ...(str(body.teammate_name) !== undefined ? { teammateName: str(body.teammate_name) } : {}),
  };
}

function taskIdFromResponse(value: unknown): string | undefined {
  const body = rec(value);
  const structured =
    nonEmpty(body?.task_id) ?? nonEmpty(body?.taskId) ?? nonEmpty(body?.id) ?? nonEmpty(rec(body?.task)?.id);
  if (structured) return structured;
  const text = str(value) ?? str(body?.content) ?? str(body?.message);
  return text?.match(/\btask\s+#?([\w.-]+)\b/i)?.[1];
}

function questionOutcome(value: unknown): 'answered' | 'cancelled' {
  const body = rec(value);
  return body?.cancelled === true || body?.canceled === true ? 'cancelled' : 'answered';
}

function sameTool(
  left: Pick<PendingPermission, 'promptId' | 'toolName' | 'inputKey'>,
  right: Pick<RecentToolRequest, 'promptId' | 'toolName' | 'inputKey'>,
): boolean {
  return left.promptId === right.promptId && left.toolName === right.toolName && left.inputKey === right.inputKey;
}

function toolPresentation(tool: string, input: unknown, completed = false): ToolPresentation {
  const name = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  let title = completed ? `Used ${tool}` : `Using ${tool}`;
  if (['bash', 'shell', 'command', 'execute'].includes(name)) {
    kind = 'command';
    title = completed ? 'Ran command' : 'Running command';
  } else if (['websearch', 'web_search', 'search'].includes(name)) {
    kind = 'web-search';
    title = completed ? 'Searched the web' : 'Searching the web';
  } else if (['webfetch', 'fetch', 'browser'].includes(name)) {
    kind = 'browser';
    title = completed ? 'Fetched web content' : 'Fetching web content';
  } else if (['read', 'glob', 'grep'].includes(name)) {
    kind = 'file-read';
    title = completed ? 'Read files' : 'Reading files';
  } else if (['write', 'edit', 'multiedit', 'apply_patch', 'notebookedit'].includes(name)) {
    kind = 'file-edit';
    title = completed ? 'Edited files' : 'Editing files';
  } else if (name.startsWith('mcp__') || name.startsWith('mcp_')) {
    kind = 'mcp';
  }
  const data = rec(input);
  const detail =
    str(data?.command) ??
    str(data?.query) ??
    str(data?.url) ??
    str(data?.file_path) ??
    str(data?.path) ??
    str(data?.pattern) ??
    str(data?.prompt);
  return { kind, title, detail };
}

export class ClaudeHookNormalizer {
  private messageBuffers = new Map<string, string>();
  private pendingPermissions: PendingPermission[] = [];
  private pendingQuestions = new Map<string, PendingQuestion>();
  private recentToolRequests = new Map<string, RecentToolRequest>();
  private stoppedSubagents = new Set<string>();
  private permissionCounter = 0;
  private toolCounters = new Map<string, number>();
  private compactionCounter = 0;
  private activeCompaction: { id: string; promptId?: string; trigger?: string } | undefined;
  private lastClosedCompaction: { id: string; promptId?: string } | undefined;
  private observedPermissionMode: string | undefined;
  private observedEffort: string | undefined;

  private nextFallbackToolId(promptId: string | undefined, toolName: string): string {
    const key = promptId ?? 'unknown';
    const next = (this.toolCounters.get(key) ?? 0) + 1;
    if (!this.toolCounters.has(key) && this.toolCounters.size >= MAX_TRACKED_ITEMS) {
      const oldest = this.toolCounters.keys().next().value;
      if (oldest !== undefined) this.toolCounters.delete(oldest);
    }
    this.toolCounters.set(key, next);
    return `tool-${encodeURIComponent(key)}-${encodeURIComponent(toolName)}-${next}`;
  }

  private findRecentToolForPayload(
    promptId: string | undefined,
    toolName: string,
    input: unknown,
    inputWasSupplied: boolean,
  ): RecentToolRequest | undefined {
    const inputKey = canonical(input);
    const requests = [...this.recentToolRequests.values()];
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index]!;
      if (request.promptId !== promptId || request.toolName !== toolName) continue;
      if (!inputWasSupplied || request.inputKey === inputKey) return request;
    }
    return undefined;
  }

  private toolCallId(body: ClaudeHookPayload, promptId: string | undefined, toolName: string): string {
    return (
      str(body.tool_use_id) ??
      this.findRecentToolForPayload(promptId, toolName, body.tool_input, Object.hasOwn(body, 'tool_input'))
        ?.toolCallId ??
      this.nextFallbackToolId(promptId, toolName)
    );
  }

  private appendObservedEnvironment(result: NormalizedHook, body: ClaudeHookPayload): void {
    const permissionMode = str(body.permission_mode);
    const effort = effortLevel(body.effort);
    const permissionChanged = permissionMode !== undefined && permissionMode !== this.observedPermissionMode;
    const effortChanged = effort !== undefined && effort !== this.observedEffort;
    if (!permissionChanged && !effortChanged) return;
    result.events.push({
      type: 'session.environment.updated',
      intent: 'observed',
      ...(permissionChanged ? { providerPermissionMode: claudePermissionMode(permissionMode!) } : {}),
      ...(effortChanged ? { effort } : {}),
    });
    if (permissionChanged) this.observedPermissionMode = permissionMode;
    if (effortChanged) this.observedEffort = effort;
  }

  private resetObservedEnvironment(): void {
    this.observedPermissionMode = undefined;
    this.observedEffort = undefined;
  }

  private rememberTool(request: RecentToolRequest): void {
    if (!this.recentToolRequests.has(request.toolCallId) && this.recentToolRequests.size >= MAX_TRACKED_ITEMS) {
      const oldest = this.recentToolRequests.keys().next().value;
      if (oldest !== undefined) this.recentToolRequests.delete(oldest);
    }
    this.recentToolRequests.set(request.toolCallId, request);
  }

  private rememberQuestion(result: NormalizedHook, question: PendingQuestion): void {
    if (!this.pendingQuestions.has(question.toolCallId) && this.pendingQuestions.size >= MAX_TRACKED_ITEMS) {
      const oldest = this.pendingQuestions.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.pendingQuestions.get(oldest);
        this.pendingQuestions.delete(oldest);
        if (evicted) {
          result.events.push({ type: 'question.resolved', requestId: evicted.requestId, outcome: 'superseded' });
        }
      }
    }
    this.pendingQuestions.set(question.toolCallId, question);
  }

  private resolveQuestions(
    result: NormalizedHook,
    outcome: 'answered' | 'failed' | 'cancelled' | 'superseded',
    predicate: (question: PendingQuestion) => boolean,
  ): void {
    for (const [toolCallId, question] of this.pendingQuestions) {
      if (!predicate(question)) continue;
      result.events.push({ type: 'question.resolved', requestId: question.requestId, outcome });
      this.pendingQuestions.delete(toolCallId);
    }
  }

  private closeActiveCompaction(
    result: NormalizedHook,
    outcome: 'cancelled' | 'failed' | 'superseded' | 'unknown',
  ): void {
    if (!this.activeCompaction) return;
    result.events.push({
      type: 'compaction.completed',
      compactionId: this.activeCompaction.id,
      trigger: this.activeCompaction.trigger,
      outcome,
    });
    this.lastClosedCompaction = {
      id: this.activeCompaction.id,
      promptId: this.activeCompaction.promptId,
    };
    this.activeCompaction = undefined;
  }

  private permissionBoundaryDiagnostic(
    result: NormalizedHook,
    hookEventName: string,
    promptId: string | undefined,
  ): void {
    const count = this.pendingPermissions.filter(
      (permission) => permission.promptId === undefined || permission.promptId === promptId,
    ).length;
    if (count === 0) return;
    result.diagnostics.push({
      code: 'permission-outlived-turn',
      hookEventName,
      issues: [`${count} pending permission request(s) closed at the owning turn boundary`],
    });
  }

  private findRecentTool(permission: PendingPermission): RecentToolRequest | undefined {
    const requests = [...this.recentToolRequests.values()];
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index]!;
      if (!request.permissionRequestId && sameTool(permission, request)) return request;
    }
    return undefined;
  }

  private evictOldestPermission(result: NormalizedHook): void {
    const permission = this.pendingPermissions.shift();
    if (!permission) return;
    // Bounded adapter memory must not create unbounded reducer state. Close the
    // request honestly before forgetting its correlation details.
    result.events.push({ type: 'permission.resolved', requestId: permission.requestId, outcome: 'unknown' });
    if (permission.toolCallId) this.recentToolRequests.delete(permission.toolCallId);
  }

  private rememberStoppedSubagent(agentId: string): void {
    if (!this.stoppedSubagents.has(agentId) && this.stoppedSubagents.size >= MAX_TRACKED_ITEMS) {
      const oldest = this.stoppedSubagents.values().next().value;
      if (oldest !== undefined) this.stoppedSubagents.delete(oldest);
    }
    this.stoppedSubagents.add(agentId);
  }

  private resolvePermission(
    result: NormalizedHook,
    outcome: 'allowed' | 'denied' | 'dismissed' | 'unknown',
    predicate: (permission: PendingPermission) => boolean,
  ): void {
    const remaining: PendingPermission[] = [];
    for (const permission of this.pendingPermissions) {
      if (predicate(permission)) {
        result.events.push({ type: 'permission.resolved', requestId: permission.requestId, outcome });
        if (permission.toolCallId) this.recentToolRequests.delete(permission.toolCallId);
      } else {
        remaining.push(permission);
      }
    }
    this.pendingPermissions = remaining;
  }

  normalize(body: ClaudeHookPayload): NormalizedHook {
    const name = str(body.hook_event_name) ?? 'unknown';
    const promptId = str(body.prompt_id);
    const result: NormalizedHook = {
      events: [],
      diagnostics: [],
      sessionId: str(body.session_id),
      transcriptPath: str(body.transcript_path),
      promptId,
      agentId: str(body.agent_id),
      agentType: str(body.agent_type),
      providerVersion: str(body.version) ?? str(body.claude_version),
    };
    const isRebind = name === 'SessionStart' && str(body.source) === 'clear';
    if (isRebind) this.resetObservedEnvironment();
    const diagnostic = hookDiagnostic(name, body);
    if (diagnostic) {
      result.diagnostics.push(diagnostic);
      result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
      this.appendObservedEnvironment(result, body);
      return result;
    }

    switch (name) {
      case 'SessionStart':
        this.closeActiveCompaction(result, 'unknown');
        this.lastClosedCompaction = undefined;
        result.events.push({
          type: 'session.started',
          nativeSessionId: result.sessionId,
          title: str(body.session_title),
          startSource: str(body.source),
          ...(isRebind ? { rebind: true } : {}),
        });
        if (str(body.cwd) || str(body.model)) {
          result.events.push({
            type: 'session.environment.updated',
            ...(str(body.cwd) ? { currentCwd: str(body.cwd) } : {}),
            ...(str(body.model) ? { model: { id: str(body.model)!, provider: 'anthropic' } } : {}),
          });
        }
        if (isRebind) result.events.push({ type: 'context-window.invalidated', reason: 'history-changed' });
        break;

      case 'CwdChanged': {
        const currentCwd = str(body.new_cwd) ?? str(body.cwd);
        if (currentCwd) result.events.push({ type: 'session.environment.updated', currentCwd });
        else result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        break;
      }

      case 'InstructionsLoaded':
        // load_reason "session_start" is the closest thing to a boot-finished
        // signal; other loads (e.g. /memory edits) stay native-only.
        if (str(body.load_reason) === 'session_start') {
          result.events.push({ type: 'session.ready' });
        } else {
          result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        }
        break;

      case 'UserPromptSubmit':
        // PreCompact can be followed by a native cancellation (for example,
        // "not enough messages") with no PostCompact hook. A subsequently
        // accepted prompt proves the attempt is no longer active, but does not
        // prove whether compaction succeeded.
        if (this.activeCompaction) this.closeActiveCompaction(result, 'unknown');
        else this.lastClosedCompaction = undefined;
        this.resolveQuestions(
          result,
          'superseded',
          (question) => question.promptId === undefined || question.promptId !== promptId,
        );
        result.events.push({ type: 'turn.started', turnId: promptId, prompt: str(body.prompt) });
        break;

      case 'MessageDisplay': {
        const messageId = str(body.message_id) ?? 'unknown-message';
        const final = body.final === true;
        const text = (this.messageBuffers.get(messageId) ?? '') + (str(body.delta) ?? '');
        if (final) {
          this.messageBuffers.delete(messageId);
        } else {
          if (!this.messageBuffers.has(messageId) && this.messageBuffers.size >= MAX_TRACKED_ITEMS) {
            const oldest = this.messageBuffers.keys().next().value;
            if (oldest !== undefined) this.messageBuffers.delete(oldest);
          }
          this.messageBuffers.set(messageId, text);
        }
        result.turnId = str(body.turn_id);
        result.events.push({
          type: 'assistant.message',
          messageId,
          turnId: result.turnId,
          text,
          final,
          displayOnly: true,
        });
        break;
      }

      case 'PermissionRequest': {
        this.permissionCounter += 1;
        const toolName = str(body.tool_name) ?? 'unknown-tool';
        // Claude emits PermissionRequest while presenting AskUserQuestion's
        // picker. That record is the question interaction itself, not a second
        // request to authorize the tool. PreToolUse already published the
        // structured question; the raw envelope remains available as evidence.
        // Checking the native tool name also covers legacy reverse ordering.
        if (toolName.toLowerCase() === 'askuserquestion') {
          result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
          break;
        }
        const requestId = `perm-${promptId ?? 'unknown'}-${toolName}-${this.permissionCounter}`;
        const pending: PendingPermission = {
          requestId,
          promptId,
          toolName,
          inputKey: canonical(body.tool_input),
        };
        const tool = this.findRecentTool(pending);
        if (tool) {
          pending.toolCallId = tool.toolCallId;
          tool.permissionRequestId = requestId;
        }
        if (this.pendingPermissions.length >= MAX_TRACKED_ITEMS) this.evictOldestPermission(result);
        this.pendingPermissions.push(pending);
        result.events.push({
          type: 'permission.requested',
          requestId,
          ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
          tool: toolName,
          input: body.tool_input,
          presentation: 'native-tui',
        });
        break;
      }

      case 'PreToolUse': {
        const toolName = str(body.tool_name) ?? 'unknown-tool';
        const toolCallId = str(body.tool_use_id) ?? this.nextFallbackToolId(promptId, toolName);
        const request: RecentToolRequest = {
          toolCallId,
          promptId,
          toolName,
          inputKey: canonical(body.tool_input),
          input: body.tool_input,
          plan: parsePlanProjection(toolName, body.tool_input, result.agentId),
          task: parseTaskProjection(toolName, body.tool_input),
        };
        const legacyPending = this.pendingPermissions.find(
          (permission) => permission.toolCallId === undefined && sameTool(permission, request),
        );
        if (legacyPending) {
          legacyPending.toolCallId = toolCallId;
          request.permissionRequestId = legacyPending.requestId;
        }
        this.rememberTool(request);
        result.events.push({
          type: 'tool.requested',
          toolCallId,
          tool: toolName,
          input: body.tool_input,
          presentation: toolPresentation(toolName, body.tool_input),
        });
        if (request.plan) {
          result.events.push({ type: 'plan.updated', ...request.plan, provisional: true });
        }
        if (toolName.toLowerCase() === 'askuserquestion') {
          const questions = parseStructuredQuestions(body.tool_input);
          if (questions && !this.pendingQuestions.has(toolCallId)) {
            const questionRequestId = `question:${toolCallId}`;
            request.questionRequestId = questionRequestId;
            this.rememberQuestion(result, {
              requestId: questionRequestId,
              promptId,
              toolCallId,
            });
            result.events.push({ type: 'question.requested', requestId: questionRequestId, questions });
          }
        }
        break;
      }

      case 'PostToolUse': {
        const toolName = str(body.tool_name) ?? 'unknown-tool';
        const toolCallId = this.toolCallId(body, promptId, toolName);
        const request = this.recentToolRequests.get(toolCallId);
        this.resolvePermission(result, 'allowed', (permission) => permission.toolCallId === toolCallId);
        this.resolveQuestions(
          result,
          questionOutcome(body.tool_response),
          (question) => question.toolCallId === toolCallId,
        );
        const plan = request?.plan ?? parseExitPlan(toolName, body.tool_response, result.agentId);
        if (plan) {
          result.events.push({ type: 'plan.updated', ...plan, provisional: false });
        }
        if (request?.task) {
          const taskId = request.task.taskId || taskIdFromResponse(body.tool_response);
          if (taskId) {
            result.events.push({ type: 'task.updated', ...request.task, taskId, provisional: false });
          }
        }
        this.recentToolRequests.delete(toolCallId);
        result.events.push({
          type: 'tool.completed',
          toolCallId,
          tool: str(body.tool_name) ?? request?.toolName,
          output: body.tool_response,
          durationMs: num(body.duration_ms),
          presentation: toolPresentation(str(body.tool_name) ?? request?.toolName ?? 'tool', undefined, true),
        });
        break;
      }

      case 'PostToolUseFailure': {
        const toolName = str(body.tool_name) ?? 'unknown-tool';
        const toolCallId = this.toolCallId(body, promptId, toolName);
        const request = this.recentToolRequests.get(toolCallId);
        this.resolvePermission(result, 'allowed', (permission) => permission.toolCallId === toolCallId);
        this.resolveQuestions(result, 'failed', (question) => question.toolCallId === toolCallId);
        this.recentToolRequests.delete(toolCallId);
        result.events.push({
          type: 'tool.failed',
          toolCallId,
          tool: str(body.tool_name) ?? request?.toolName,
          error: str(body.error),
          presentation: toolPresentation(str(body.tool_name) ?? request?.toolName ?? 'tool', undefined, true),
        });
        break;
      }

      case 'PermissionDenied': {
        const toolCallId = str(body.tool_use_id);
        const toolName = str(body.tool_name) ?? 'unknown-tool';
        const signature = { promptId, toolName, inputKey: canonical(body.tool_input) };
        const before = result.events.length;
        this.resolvePermission(
          result,
          'denied',
          (permission) =>
            (toolCallId !== undefined && permission.toolCallId === toolCallId) || sameTool(permission, signature),
        );
        if (toolCallId) this.recentToolRequests.delete(toolCallId);
        if (result.events.length === before) {
          result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        }
        break;
      }

      case 'Stop':
        this.permissionBoundaryDiagnostic(result, name, promptId);
        this.resolvePermission(
          result,
          'denied',
          (permission) => permission.promptId === undefined || permission.promptId === promptId,
        );
        this.resolveQuestions(
          result,
          'cancelled',
          (question) => question.promptId === undefined || question.promptId === promptId,
        );
        if (this.activeCompaction && (!this.activeCompaction.promptId || this.activeCompaction.promptId === promptId)) {
          this.closeActiveCompaction(result, 'cancelled');
        }
        result.events.push({
          type: 'turn.completed',
          turnId: promptId,
          lastAssistantMessage: str(body.last_assistant_message),
        });
        break;

      case 'StopFailure':
        this.permissionBoundaryDiagnostic(result, name, promptId);
        this.resolvePermission(
          result,
          'unknown',
          (permission) => permission.promptId === undefined || permission.promptId === promptId,
        );
        this.resolveQuestions(
          result,
          'failed',
          (question) => question.promptId === undefined || question.promptId === promptId,
        );
        if (this.activeCompaction && (!this.activeCompaction.promptId || this.activeCompaction.promptId === promptId)) {
          this.closeActiveCompaction(result, 'failed');
        }
        result.events.push({ type: 'turn.failed', turnId: promptId, error: str(body.error_type) ?? str(body.error) });
        break;

      case 'SessionEnd':
        this.resolvePermission(result, 'dismissed', () => true);
        this.resolveQuestions(result, 'cancelled', () => true);
        this.closeActiveCompaction(result, 'cancelled');
        this.messageBuffers.clear();
        this.recentToolRequests.clear();
        this.stoppedSubagents.clear();
        this.toolCounters.clear();
        result.events.push({ type: 'session.exited', reason: str(body.reason) });
        break;

      case 'SubagentStart': {
        const agentId = str(body.agent_id) ?? 'unknown-agent';
        this.stoppedSubagents.delete(agentId);
        result.events.push({
          type: 'subagent.started',
          subagentId: agentId,
          agentType: str(body.agent_type),
        });
        break;
      }

      case 'SubagentStop': {
        const agentId = str(body.agent_id) ?? 'unknown-agent';
        // Re-entrant stop-hook guard: only the first Stop per agent is real.
        if (this.stoppedSubagents.has(agentId)) {
          result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        } else {
          this.rememberStoppedSubagent(agentId);
          result.events.push({ type: 'subagent.stopped', subagentId: agentId });
        }
        break;
      }

      case 'TaskCreated': {
        const taskId = str(body.task_id) ?? `task-${promptId ?? 'unknown'}`;
        const recent = [...this.recentToolRequests.values()]
          .reverse()
          .find((request) => request.promptId === promptId && request.toolName.toLowerCase() === 'taskcreate');
        if (recent?.task) {
          recent.task.taskId = taskId;
          recent.task.description ??= str(body.task_description) ?? str(body.task_subject) ?? str(body.description);
          recent.task.teamName ??= str(body.team_name);
          recent.task.teammateName ??= str(body.teammate_name);
        }
        result.events.push({
          type: 'task.updated',
          taskId,
          ...((str(body.task_description) ?? str(body.task_subject) ?? str(body.description)) !== undefined
            ? { description: str(body.task_description) ?? str(body.task_subject) ?? str(body.description) }
            : {}),
          status: 'proposed',
          ...(str(body.team_name) !== undefined ? { teamName: str(body.team_name) } : {}),
          ...(str(body.teammate_name) !== undefined ? { teammateName: str(body.teammate_name) } : {}),
          provisional: true,
        });
        break;
      }

      case 'TaskCompleted': {
        const taskId = str(body.task_id) ?? 'unknown-task';
        const recent = [...this.recentToolRequests.values()]
          .reverse()
          .find(
            (request) =>
              request.promptId === promptId &&
              request.toolName.toLowerCase() === 'taskupdate' &&
              (!request.task?.taskId || request.task.taskId === taskId),
          );
        if (recent?.task) {
          recent.task.taskId = taskId;
          recent.task.status = 'completed';
          recent.task.providerStatus ??= 'completed';
          recent.task.description ??= str(body.task_description) ?? str(body.task_subject);
          recent.task.teamName ??= str(body.team_name);
          recent.task.teammateName ??= str(body.teammate_name);
        }
        result.events.push({
          type: 'task.updated',
          taskId,
          ...((str(body.task_description) ?? str(body.task_subject)) !== undefined
            ? { description: str(body.task_description) ?? str(body.task_subject) }
            : {}),
          status: 'completed',
          providerStatus: 'completed',
          ...(str(body.team_name) !== undefined ? { teamName: str(body.team_name) } : {}),
          ...(str(body.teammate_name) !== undefined ? { teammateName: str(body.teammate_name) } : {}),
          provisional: true,
        });
        break;
      }

      case 'TeammateIdle':
        result.events.push({
          type: 'teammate.idle',
          ...(str(body.team_name) !== undefined ? { teamName: str(body.team_name) } : {}),
          teammateName: str(body.teammate_name) ?? 'unknown-teammate',
        });
        break;

      case 'Notification':
        result.events.push({
          type: 'notification',
          message: str(body.message),
          notificationType: str(body.notification_type),
        });
        break;

      case 'DirectoryAdded': {
        const directory = str(body.directory);
        result.events.push(
          directory
            ? { type: 'workspace.changed', paths: [directory] }
            : { type: 'adapter.native-event', adapter: 'claude-code', nativeType: name },
        );
        break;
      }

      case 'FileChanged':
      case 'ConfigChange': {
        const path = str(body.file_path);
        result.events.push(
          path
            ? { type: 'workspace.changed', paths: [path] }
            : { type: 'adapter.native-event', adapter: 'claude-code', nativeType: name },
        );
        break;
      }

      case 'PreCompact': {
        if (this.activeCompaction) this.closeActiveCompaction(result, 'superseded');
        this.lastClosedCompaction = undefined;
        this.compactionCounter += 1;
        const compactionId =
          str(body.compaction_id) ??
          `compaction-${result.sessionId ?? 'unknown'}-${promptId ?? 'session'}-${this.compactionCounter}`;
        this.activeCompaction = { id: compactionId, promptId, trigger: str(body.trigger) };
        result.events.push({ type: 'compaction.started', compactionId, trigger: str(body.trigger) });
        break;
      }

      case 'PostCompact': {
        const compactionId =
          str(body.compaction_id) ??
          this.activeCompaction?.id ??
          this.lastClosedCompaction?.id ??
          `compaction-${result.sessionId ?? 'unknown'}-${promptId ?? 'session'}-${++this.compactionCounter}`;
        this.activeCompaction = undefined;
        this.lastClosedCompaction = undefined;
        result.events.push(
          { type: 'compaction.completed', compactionId, trigger: str(body.trigger), outcome: 'completed' },
          { type: 'context-window.invalidated', reason: 'compacted' },
        );
        break;
      }

      default:
        result.events.push({ type: 'adapter.native-event', adapter: 'claude-code', nativeType: name });
        break;
    }

    this.appendObservedEnvironment(result, body);
    if (name === 'SessionEnd') this.resetObservedEnvironment();
    return result;
  }

  /** Pending (unresolved) permission requests — the deny-timeout input. */
  pendingPermissionRequests(): readonly PendingPermission[] {
    return this.pendingPermissions;
  }

  /** Pending native structured questions, kept independent from permissions. */
  pendingQuestionRequests(): readonly PendingQuestion[] {
    return [...this.pendingQuestions.values()];
  }
}
