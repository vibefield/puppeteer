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
 *   An Esc-interrupted turn has no boundary hook: the next accepted prompt
 *   closes its main-thread request with an unknown outcome.
 * - SubagentStop is re-entrant (1× stop_hook_active:false, then N× true):
 *   only the first occurrence per agent_id normalizes to delegation:subagent-stopped.
 *   `/compact` runs an internal agent whose SubagentStop has an empty agent_type and no
 *   SubagentStart (2.1.308 TUI lane); it delegated nothing the session can see, so it stays native.
 * - Compaction: PreCompact → SessionStart(compact) → PostCompact. The compact SessionStart is a
 *   step inside the attempt, so it leaves the attempt open for PostCompact to complete.
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
import { normalizeClaudeSubagentStarted, normalizeClaudeSubagentStopped } from './delegation.js';
import { ClaudeEffortNormalizer } from './effort.js';
import { normalizeClaudeCwd, normalizeClaudeSessionEnvironment } from './environment.js';
import {
  claudeQuestionOutcome,
  claudeQuestionRequestId,
  normalizeClaudePermissionRequested,
  normalizeClaudePermissionResolved,
  normalizeClaudeQuestionRequested,
  normalizeClaudeQuestionResolved,
  parseClaudeStructuredQuestions,
} from './interaction.js';
import { normalizeClaudeNotification } from './notification.js';
import { normalizeClaudeModelSwitched, normalizeClaudeSessionModel } from './model.js';
import { ClaudeModeNormalizer } from './mode.js';
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
import {
  canonicalClaudeValue,
  claudeHookDiagnostic,
  claudeNumber,
  claudeString,
  nonEmptyClaudeString,
} from './wire.js';
import { normalizeClaudeFileChanged, normalizeClaudeFileOperation } from './workspace.js';

export type { ClaudeHookDiagnostic, ClaudeHookPayload, NormalizedHook } from './types.js';

const MAX_TRACKED_ITEMS = 64;

export class ClaudeHookNormalizer {
  private messageBuffers = new Map<string, string>();
  private pendingPermissions: PendingPermission[] = [];
  private pendingQuestions = new Map<string, PendingQuestion>();
  private recentToolRequests = new Map<string, RecentToolRequest>();
  private stoppedSubagents = new Set<string>();
  private startedSubagents = new Set<string>();
  private permissionCounter = 0;
  private toolCounters = new Map<string, number>();
  private compactionCounter = 0;
  private activeCompaction: { id: string; promptId?: string | undefined; trigger?: string | undefined } | undefined;
  private lastClosedCompaction: { id: string; promptId?: string | undefined } | undefined;
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

  /**
   * A tool an attach found still open in the transcript (the re-attach study, §3.3), which no hook announced to this
   * normalizer. It is remembered as PreToolUse remembers one, so its PostToolUse or failure closes it and resolves
   * the question an AskUserQuestion call asks. Returns what remembering it superseded, for the caller to publish.
   */
  adoptOpenTool(tool: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    promptId?: string | undefined;
  }): NormalizedHook['events'] {
    const request: RecentToolRequest = {
      toolCallId: tool.toolCallId,
      promptId: tool.promptId,
      toolName: tool.toolName,
      inputKey: canonicalClaudeValue(tool.input),
      input: tool.input,
    };
    const superseded: NormalizedHook = { events: [], diagnostics: [] };
    if (tool.toolName.toLowerCase() === 'askuserquestion' && parseClaudeStructuredQuestions(tool.input)) {
      request.questionRequestId = claudeQuestionRequestId(tool.toolCallId);
      this.rememberQuestion(superseded, {
        requestId: request.questionRequestId,
        promptId: tool.promptId,
        toolCallId: tool.toolCallId,
      });
    }
    this.rememberTool(request);
    return superseded.events;
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

  /**
   * Esc at a permission prompt interrupts the turn and fires no Stop (2.1.308 TUI lane: the
   * PermissionRequest at seq 31 is followed by the next UserPromptSubmit at seq 34). The main
   * thread asks one dialog at a time, so a newly accepted main-thread prompt proves an earlier
   * turn's dialog is gone. Which answer closed it is not observable, so the outcome is unknown. A
   * subagent's request is left to its own boundary: a background agent can still be waiting on one.
   */
  private resolveInterruptedPermissions(
    result: NormalizedHook,
    hookEventName: string,
    promptId: string | undefined,
  ): void {
    const interrupted = (permission: PendingPermission) =>
      permission.agentId === undefined && (permission.promptId === undefined || permission.promptId !== promptId);
    const count = this.pendingPermissions.filter(interrupted).length;
    if (count === 0) return;
    result.diagnostics.push({
      code: 'permission-outlived-turn',
      hookEventName,
      issues: [`${count} pending permission request(s) of an interrupted turn closed when the next prompt started`],
    });
    this.resolvePermission(result, 'unknown', interrupted);
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

  private rememberStartedSubagent(agentId: string): void {
    if (!this.startedSubagents.has(agentId) && this.startedSubagents.size >= MAX_TRACKED_ITEMS) {
      const oldest = this.startedSubagents.values().next().value;
      if (oldest !== undefined) this.startedSubagents.delete(oldest);
    }
    this.startedSubagents.add(agentId);
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
      // Candidate actor metadata must be non-empty: the compaction agent's hooks carry `agent_type: ""`.
      agentId: nonEmptyClaudeString(body.agent_id),
      agentType: nonEmptyClaudeString(body.agent_type),
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
        // Claude announces the compacted context as a new SessionStart between PreCompact and
        // PostCompact; any other start ends an attempt that never reported its outcome.
        if (claudeString(body.source) !== 'compact') {
          this.closeActiveCompaction(result, 'unknown');
          this.lastClosedCompaction = undefined;
        }
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
        if (!result.agentId) this.resolveInterruptedPermissions(result, name, promptId);
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
          agentId: result.agentId,
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
        const workspace = normalizeClaudeFileOperation(toolCallId, toolName, body.tool_input, 'proposed');
        if (workspace) result.events.push(workspace);
        if (toolName.toLowerCase() === 'askuserquestion') {
          const questions = parseClaudeStructuredQuestions(body.tool_input);
          if (questions && !this.pendingQuestions.has(toolCallId)) {
            const questionRequestId = claudeQuestionRequestId(toolCallId);
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
        this.recentToolRequests.delete(toolCallId);
        result.events.push(
          normalizeClaudeToolCompleted(
            toolCallId,
            claudeString(body.tool_name) ?? request?.toolName,
            body.tool_response,
            claudeNumber(body.duration_ms),
          ),
        );
        const workspace = normalizeClaudeFileOperation(
          toolCallId,
          claudeString(body.tool_name) ?? request?.toolName ?? toolName,
          request?.input ?? body.tool_input,
          'applied',
        );
        if (workspace) result.events.push(workspace);
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
        const workspace = normalizeClaudeFileOperation(
          toolCallId,
          claudeString(body.tool_name) ?? request?.toolName ?? toolName,
          request?.input ?? body.tool_input,
          'failed',
        );
        if (workspace) result.events.push(workspace);
        break;
      }

      case 'PermissionDenied': {
        const toolCallId = claudeString(body.tool_use_id);
        const toolName = claudeString(body.tool_name) ?? 'unknown-tool';
        const signature = { promptId, toolName, inputKey: canonicalClaudeValue(body.tool_input) };
        const request = this.findRecentToolForPayload(promptId, toolName, body.tool_input, true);
        const resolvedToolCallId = toolCallId ?? request?.toolCallId;
        const terminalToolCallId = resolvedToolCallId ?? this.nextFallbackToolId(promptId, toolName);
        const before = result.events.length;
        this.resolvePermission(
          result,
          'denied',
          (permission) =>
            (toolCallId !== undefined && permission.toolCallId === toolCallId) || sameClaudeTool(permission, signature),
        );
        if (resolvedToolCallId) this.recentToolRequests.delete(resolvedToolCallId);
        result.events.push(
          normalizeClaudeToolFailed(terminalToolCallId, toolName, claudeString(body.reason) ?? 'permission denied'),
        );
        const workspace = normalizeClaudeFileOperation(
          terminalToolCallId,
          toolName,
          request?.input ?? body.tool_input,
          'failed',
        );
        if (workspace) result.events.push(workspace);
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
        this.startedSubagents.clear();
        this.toolCounters.clear();
        result.events.push(normalizeClaudeSessionExited(body));
        break;

      case 'SubagentStart': {
        const agentId = claudeString(body.agent_id) ?? 'unknown-agent';
        this.stoppedSubagents.delete(agentId);
        this.rememberStartedSubagent(agentId);
        result.events.push(normalizeClaudeSubagentStarted(agentId, nonEmptyClaudeString(body.agent_type)));
        break;
      }

      case 'SubagentStop': {
        const agentId = claudeString(body.agent_id) ?? 'unknown-agent';
        // Claude's own internal agent (compaction): an empty type and never started.
        const internalAgent = claudeString(body.agent_type) === '' && !this.startedSubagents.has(agentId);
        // Re-entrant stop-hook guard: only the first Stop per agent is real.
        if (internalAgent || this.stoppedSubagents.has(agentId)) {
          result.events.push(normalizeClaudeNativeEvent(name));
        } else {
          this.rememberStoppedSubagent(agentId);
          result.events.push(normalizeClaudeSubagentStopped(agentId));
        }
        break;
      }

      case 'Notification':
        result.events.push(normalizeClaudeNotification(body));
        break;

      case 'FileChanged': {
        const workspace = normalizeClaudeFileChanged(body);
        result.events.push(workspace ?? normalizeClaudeNativeEvent(name));
        break;
      }

      case 'PostModelSwitch':
        // The switch has landed (requested, an automatic fallback, opusplan, or restored on
        // resume). The cancellable request before it carries no settled model and stays native.
        result.events.push(normalizeClaudeModelSwitched(body) ?? normalizeClaudeNativeEvent(name));
        break;

      case 'DirectoryAdded':
      case 'ConfigChange':
        result.events.push(normalizeClaudeNativeEvent(name));
        break;

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
