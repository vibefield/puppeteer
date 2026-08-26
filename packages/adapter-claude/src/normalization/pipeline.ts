/**
 * Claude hook → normalized AgentEvent translation (DESIGN §16.7), corrected
 * by the two censuses (packages/surface/vendors/claude/findings.md):
 *
 * - `prompt_id` is the native turn id; MessageDisplay additionally carries a
 *   distinct `turn_id` (assistant response cycle) — both are surfaced for
 *   candidate correlation metadata.
 * - MessageDisplay STREAMS: deltas are accumulated per message_id and an
 *   conversation:assistant-message is emitted per delta with `final` marking completion.
 * - PermissionRequest carries NO tool_use_id or request id. As of 2.1.226,
 *   PreToolUse fires first for every call and PermissionRequest follows only
 *   when a decision is needed. We correlate by prompt, tool name, and canonical
 *   tool input, while still tolerating the legacy reverse ordering. Execution
 *   completion proves allow; PermissionDenied or a turn boundary closes denial.
 * - SubagentStop is re-entrant (1× stop_hook_active:false, then N× true):
 *   only the first occurrence per agent_id normalizes to delegation:subagent-stopped.
 * - Unknown events are RETAINED (ADR-008) as adapter:native-event; the raw
 *   body always rides the envelope's nativeEvent upstream.
 *
 * Stateful by necessity (delta accumulation, permission FIFO, stop dedup) —
 * one normalizer instance per Claude session.
 */

import { normalizeClaudeNativeEvent } from './adapter.js';
import { normalizeClaudeCompactionCompleted, normalizeClaudeCompactionStarted } from './compaction.js';
import { normalizeClaudeAssistantMessage } from './conversation.js';
import { normalizeClaudeContextInvalidated } from './context-window.js';
import {
  claudeTaskIdFromResponse,
  normalizeClaudeSubagentStarted,
  normalizeClaudeSubagentStopped,
  normalizeClaudeTaskUpdated,
  normalizeClaudeTeammateIdle,
  parseClaudeTask,
} from './delegation.js';
import { ClaudeEffortNormalizer } from './effort.js';
import { normalizeClaudeCwd, normalizeClaudeSessionEnvironment } from './environment.js';
import {
  claudeQuestionOutcome,
  normalizeClaudePermissionRequested,
  normalizeClaudePermissionResolved,
  normalizeClaudeQuestionRequested,
  normalizeClaudeQuestionResolved,
  parseClaudeStructuredQuestions,
} from './interaction.js';
import { normalizeClaudeNotification } from './notification.js';
import { normalizeClaudeSessionModel } from './model.js';
import { ClaudeModeNormalizer } from './mode.js';
import { normalizeClaudePlanUpdated, parseClaudeExitPlan, parseClaudePlan } from './planning.js';
import { normalizeClaudeSessionExited, normalizeClaudeSessionReady, normalizeClaudeSessionStarted } from './session.js';
import {
  normalizeClaudeToolCompleted,
  normalizeClaudeToolFailed,
  normalizeClaudeToolRequested,
  sameClaudeTool,
} from './tool.js';
import { normalizeClaudeTurnCompleted, normalizeClaudeTurnFailed, normalizeClaudeTurnStarted } from './turn.js';
import type {
  ClaudeHookPayload,
  NormalizedHook,
  PendingPermission,
  PendingQuestion,
  RecentToolRequest,
} from './types.js';
import { canonicalClaudeValue, claudeHookDiagnostic, claudeNumber, claudeString } from './wire.js';
import { normalizeClaudeWorkspaceChanged } from './workspace.js';

export type { ClaudeHookDiagnostic, ClaudeHookPayload, NormalizedHook } from './types.js';

const MAX_TRACKED_ITEMS = 64;

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
  private readonly effort = new ClaudeEffortNormalizer();
  private readonly mode = new ClaudeModeNormalizer();

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
    const inputKey = canonicalClaudeValue(input);
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
      claudeString(body.tool_use_id) ??
      this.findRecentToolForPayload(promptId, toolName, body.tool_input, Object.hasOwn(body, 'tool_input'))
        ?.toolCallId ??
      this.nextFallbackToolId(promptId, toolName)
    );
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
          result.events.push(normalizeClaudeQuestionResolved(evicted.requestId, 'superseded'));
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
      result.events.push(normalizeClaudeQuestionResolved(question.requestId, outcome));
      this.pendingQuestions.delete(toolCallId);
    }
  }

  private closeActiveCompaction(
    result: NormalizedHook,
    outcome: 'cancelled' | 'failed' | 'superseded' | 'unknown',
  ): void {
    if (!this.activeCompaction) return;
    result.events.push(
      normalizeClaudeCompactionCompleted(this.activeCompaction.id, this.activeCompaction.trigger, outcome),
    );
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
      if (!request.permissionRequestId && sameClaudeTool(permission, request)) return request;
    }
    return undefined;
  }

  private evictOldestPermission(result: NormalizedHook): void {
    const permission = this.pendingPermissions.shift();
    if (!permission) return;
    // Bounded adapter memory must not create unbounded reducer state. Close the
    // request honestly before forgetting its correlation details.
    result.events.push(normalizeClaudePermissionResolved(permission.requestId, 'unknown'));
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
        result.events.push(normalizeClaudePermissionResolved(permission.requestId, outcome));
        if (permission.toolCallId) this.recentToolRequests.delete(permission.toolCallId);
      } else {
        remaining.push(permission);
      }
    }
    this.pendingPermissions = remaining;
  }

  normalize(body: ClaudeHookPayload): NormalizedHook {
    const name = claudeString(body.hook_event_name) ?? 'unknown';
    const promptId = claudeString(body.prompt_id);
    const result: NormalizedHook = {
      events: [],
      diagnostics: [],
      sessionId: claudeString(body.session_id),
      transcriptPath: claudeString(body.transcript_path),
      promptId,
      agentId: claudeString(body.agent_id),
      agentType: claudeString(body.agent_type),
      providerVersion: claudeString(body.version) ?? claudeString(body.claude_version),
    };
    const isRebind = name === 'SessionStart' && claudeString(body.source) === 'clear';
    if (isRebind) {
      this.effort.reset();
      this.mode.reset();
    }
    const diagnostic = claudeHookDiagnostic(name, body);
    if (diagnostic) {
      result.diagnostics.push(diagnostic);
      result.events.push(normalizeClaudeNativeEvent(name));
      this.effort.append(result, body);
      this.mode.append(result, body);
      return result;
    }

    switch (name) {
      case 'SessionStart':
        this.closeActiveCompaction(result, 'unknown');
        this.lastClosedCompaction = undefined;
        result.events.push(normalizeClaudeSessionStarted(body, isRebind));
        const environment = normalizeClaudeSessionEnvironment(body);
        if (environment) result.events.push(environment);
        const model = normalizeClaudeSessionModel(body);
        if (model) result.events.push(model);
        if (isRebind) result.events.push(normalizeClaudeContextInvalidated('history-changed'));
        break;

      case 'CwdChanged': {
        const environment = normalizeClaudeCwd(body);
        if (environment) result.events.push(environment);
        else result.events.push(normalizeClaudeNativeEvent(name));
        break;
      }

      case 'InstructionsLoaded':
        // load_reason "session_start" is the closest thing to a boot-finished
        // signal; other loads (e.g. /memory edits) stay native-only.
        if (claudeString(body.load_reason) === 'session_start') {
          result.events.push(normalizeClaudeSessionReady());
        } else {
          result.events.push(normalizeClaudeNativeEvent(name));
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
        result.events.push(normalizeClaudeTurnStarted(body, promptId));
        break;

      case 'MessageDisplay': {
        const messageId = claudeString(body.message_id) ?? 'unknown-message';
        const final = body.final === true;
        const text = (this.messageBuffers.get(messageId) ?? '') + (claudeString(body.delta) ?? '');
        if (final) {
          this.messageBuffers.delete(messageId);
        } else {
          if (!this.messageBuffers.has(messageId) && this.messageBuffers.size >= MAX_TRACKED_ITEMS) {
            const oldest = this.messageBuffers.keys().next().value;
            if (oldest !== undefined) this.messageBuffers.delete(oldest);
          }
          this.messageBuffers.set(messageId, text);
        }
        result.turnId = claudeString(body.turn_id);
        result.events.push(normalizeClaudeAssistantMessage(messageId, result.turnId, text, final));
        break;
      }

      case 'PermissionRequest': {
        this.permissionCounter += 1;
        const toolName = claudeString(body.tool_name) ?? 'unknown-tool';
        // Claude emits PermissionRequest while presenting AskUserQuestion's
        // picker. That record is the question interaction itself, not a second
        // request to authorize the tool. PreToolUse already published the
        // structured question; the raw envelope remains available as evidence.
        // Checking the native tool name also covers legacy reverse ordering.
        if (toolName.toLowerCase() === 'askuserquestion') {
          result.events.push(normalizeClaudeNativeEvent(name));
          break;
        }
        const requestId = `perm-${promptId ?? 'unknown'}-${toolName}-${this.permissionCounter}`;
        const pending: PendingPermission = {
          requestId,
          promptId,
          toolName,
          inputKey: canonicalClaudeValue(body.tool_input),
        };
        const tool = this.findRecentTool(pending);
        if (tool) {
          pending.toolCallId = tool.toolCallId;
          tool.permissionRequestId = requestId;
        }
        if (this.pendingPermissions.length >= MAX_TRACKED_ITEMS) this.evictOldestPermission(result);
        this.pendingPermissions.push(pending);
        result.events.push(
          normalizeClaudePermissionRequested(requestId, toolName, body.tool_input, pending.toolCallId),
        );
        break;
      }

      case 'PreToolUse': {
        const toolName = claudeString(body.tool_name) ?? 'unknown-tool';
        const toolCallId = claudeString(body.tool_use_id) ?? this.nextFallbackToolId(promptId, toolName);
        const request: RecentToolRequest = {
          toolCallId,
          promptId,
          toolName,
          inputKey: canonicalClaudeValue(body.tool_input),
          input: body.tool_input,
          plan: parseClaudePlan(toolName, body.tool_input, result.agentId),
          task: parseClaudeTask(toolName, body.tool_input),
        };
        const legacyPending = this.pendingPermissions.find(
          (permission) => permission.toolCallId === undefined && sameClaudeTool(permission, request),
        );
        if (legacyPending) {
          legacyPending.toolCallId = toolCallId;
          request.permissionRequestId = legacyPending.requestId;
        }
        this.rememberTool(request);
        result.events.push(normalizeClaudeToolRequested(toolCallId, toolName, body.tool_input));
        if (request.plan) {
          result.events.push(normalizeClaudePlanUpdated(request.plan, true));
        }
        if (toolName.toLowerCase() === 'askuserquestion') {
          const questions = parseClaudeStructuredQuestions(body.tool_input);
          if (questions && !this.pendingQuestions.has(toolCallId)) {
            const questionRequestId = `question:${toolCallId}`;
            request.questionRequestId = questionRequestId;
            this.rememberQuestion(result, {
              requestId: questionRequestId,
              promptId,
              toolCallId,
            });
            result.events.push(normalizeClaudeQuestionRequested(questionRequestId, questions));
          }
        }
        break;
      }

      case 'PostToolUse': {
        const toolName = claudeString(body.tool_name) ?? 'unknown-tool';
        const toolCallId = this.toolCallId(body, promptId, toolName);
        const request = this.recentToolRequests.get(toolCallId);
        this.resolvePermission(result, 'allowed', (permission) => permission.toolCallId === toolCallId);
        this.resolveQuestions(
          result,
          claudeQuestionOutcome(body.tool_response),
          (question) => question.toolCallId === toolCallId,
        );
        const plan = request?.plan ?? parseClaudeExitPlan(toolName, body.tool_response, result.agentId);
        if (plan) {
          result.events.push(normalizeClaudePlanUpdated(plan, false));
        }
        if (request?.task) {
          const taskId = request.task.taskId || claudeTaskIdFromResponse(body.tool_response);
          if (taskId) {
            result.events.push(normalizeClaudeTaskUpdated({ ...request.task, taskId, provisional: false }));
          }
        }
        this.recentToolRequests.delete(toolCallId);
        result.events.push(
          normalizeClaudeToolCompleted(
            toolCallId,
            claudeString(body.tool_name) ?? request?.toolName,
            body.tool_response,
            claudeNumber(body.duration_ms),
          ),
        );
        break;
      }

      case 'PostToolUseFailure': {
        const toolName = claudeString(body.tool_name) ?? 'unknown-tool';
        const toolCallId = this.toolCallId(body, promptId, toolName);
        const request = this.recentToolRequests.get(toolCallId);
        this.resolvePermission(result, 'allowed', (permission) => permission.toolCallId === toolCallId);
        this.resolveQuestions(result, 'failed', (question) => question.toolCallId === toolCallId);
        this.recentToolRequests.delete(toolCallId);
        result.events.push(
          normalizeClaudeToolFailed(
            toolCallId,
            claudeString(body.tool_name) ?? request?.toolName,
            claudeString(body.error),
          ),
        );
        break;
      }

      case 'PermissionDenied': {
        const toolCallId = claudeString(body.tool_use_id);
        const toolName = claudeString(body.tool_name) ?? 'unknown-tool';
        const signature = { promptId, toolName, inputKey: canonicalClaudeValue(body.tool_input) };
        const before = result.events.length;
        this.resolvePermission(
          result,
          'denied',
          (permission) =>
            (toolCallId !== undefined && permission.toolCallId === toolCallId) || sameClaudeTool(permission, signature),
        );
        if (toolCallId) this.recentToolRequests.delete(toolCallId);
        if (result.events.length === before) {
          result.events.push(normalizeClaudeNativeEvent(name));
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
        result.events.push(normalizeClaudeTurnCompleted(body, promptId));
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
        result.events.push(normalizeClaudeTurnFailed(body, promptId));
        break;

      case 'SessionEnd':
        this.resolvePermission(result, 'dismissed', () => true);
        this.resolveQuestions(result, 'cancelled', () => true);
        this.closeActiveCompaction(result, 'cancelled');
        this.messageBuffers.clear();
        this.recentToolRequests.clear();
        this.stoppedSubagents.clear();
        this.toolCounters.clear();
        result.events.push(normalizeClaudeSessionExited(body));
        break;

      case 'SubagentStart': {
        const agentId = claudeString(body.agent_id) ?? 'unknown-agent';
        this.stoppedSubagents.delete(agentId);
        result.events.push(normalizeClaudeSubagentStarted(agentId, claudeString(body.agent_type)));
        break;
      }

      case 'SubagentStop': {
        const agentId = claudeString(body.agent_id) ?? 'unknown-agent';
        // Re-entrant stop-hook guard: only the first Stop per agent is real.
        if (this.stoppedSubagents.has(agentId)) {
          result.events.push(normalizeClaudeNativeEvent(name));
        } else {
          this.rememberStoppedSubagent(agentId);
          result.events.push(normalizeClaudeSubagentStopped(agentId));
        }
        break;
      }

      case 'TaskCreated': {
        const taskId = claudeString(body.task_id) ?? `task-${promptId ?? 'unknown'}`;
        const description =
          claudeString(body.task_description) ?? claudeString(body.task_subject) ?? claudeString(body.description);
        const recent = [...this.recentToolRequests.values()]
          .reverse()
          .find((request) => request.promptId === promptId && request.toolName.toLowerCase() === 'taskcreate');
        if (recent?.task) {
          recent.task.taskId = taskId;
          recent.task.description ??= description;
          recent.task.teamName ??= claudeString(body.team_name);
          recent.task.teammateName ??= claudeString(body.teammate_name);
        }
        result.events.push(
          normalizeClaudeTaskUpdated({
            taskId,
            ...(description !== undefined ? { description } : {}),
            status: 'proposed',
            ...(claudeString(body.team_name) !== undefined ? { teamName: claudeString(body.team_name) } : {}),
            ...(claudeString(body.teammate_name) !== undefined
              ? { teammateName: claudeString(body.teammate_name) }
              : {}),
            provisional: true,
          }),
        );
        break;
      }

      case 'TaskCompleted': {
        const taskId = claudeString(body.task_id) ?? 'unknown-task';
        const description = claudeString(body.task_description) ?? claudeString(body.task_subject);
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
          recent.task.description ??= description;
          recent.task.teamName ??= claudeString(body.team_name);
          recent.task.teammateName ??= claudeString(body.teammate_name);
        }
        result.events.push(
          normalizeClaudeTaskUpdated({
            taskId,
            ...(description !== undefined ? { description } : {}),
            status: 'completed',
            providerStatus: 'completed',
            ...(claudeString(body.team_name) !== undefined ? { teamName: claudeString(body.team_name) } : {}),
            ...(claudeString(body.teammate_name) !== undefined
              ? { teammateName: claudeString(body.teammate_name) }
              : {}),
            provisional: true,
          }),
        );
        break;
      }

      case 'TeammateIdle':
        result.events.push(normalizeClaudeTeammateIdle(body));
        break;

      case 'Notification':
        result.events.push(normalizeClaudeNotification(body));
        break;

      case 'DirectoryAdded': {
        const workspace = normalizeClaudeWorkspaceChanged(claudeString(body.directory));
        result.events.push(workspace ?? normalizeClaudeNativeEvent(name));
        break;
      }

      case 'FileChanged':
      case 'ConfigChange': {
        const workspace = normalizeClaudeWorkspaceChanged(claudeString(body.file_path));
        result.events.push(workspace ?? normalizeClaudeNativeEvent(name));
        break;
      }

      case 'PreCompact': {
        if (this.activeCompaction) this.closeActiveCompaction(result, 'superseded');
        this.lastClosedCompaction = undefined;
        this.compactionCounter += 1;
        const compactionId =
          claudeString(body.compaction_id) ??
          `compaction-${result.sessionId ?? 'unknown'}-${promptId ?? 'session'}-${this.compactionCounter}`;
        this.activeCompaction = { id: compactionId, promptId, trigger: claudeString(body.trigger) };
        result.events.push(normalizeClaudeCompactionStarted(compactionId, claudeString(body.trigger)));
        break;
      }

      case 'PostCompact': {
        const compactionId =
          claudeString(body.compaction_id) ??
          this.activeCompaction?.id ??
          this.lastClosedCompaction?.id ??
          `compaction-${result.sessionId ?? 'unknown'}-${promptId ?? 'session'}-${++this.compactionCounter}`;
        this.activeCompaction = undefined;
        this.lastClosedCompaction = undefined;
        result.events.push(
          normalizeClaudeCompactionCompleted(compactionId, claudeString(body.trigger), 'completed'),
          normalizeClaudeContextInvalidated('compacted'),
        );
        break;
      }

      default:
        result.events.push(normalizeClaudeNativeEvent(name));
        break;
    }

    this.effort.append(result, body);
    this.mode.append(result, body);
    if (name === 'SessionEnd') {
      this.effort.reset();
      this.mode.reset();
    }
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
