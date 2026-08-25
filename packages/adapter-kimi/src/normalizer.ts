/**
 * Kimi Code wire 1.5 -> Core normalization.
 *
 * The durable journal is the authority for native-TUI conversation state. A
 * normalizer instance is session-scoped because prompt/turn association,
 * assistant accumulation, permission correlation, and terminal tombstones all
 * span records. Hidden `think` text is never copied into a portable event; it
 * remains available only in the envelope's retained native record.
 */

import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventSource,
  ToolActivityKind,
  ToolPresentation,
} from '@vibecook/chopsticks-core';

export interface KimiWireRecord {
  type?: unknown;
  time?: unknown;
  [key: string]: unknown;
}

export type KimiNormalizationDisposition = 'mapped' | 'retained-native' | 'buffered' | 'no-output';

export interface KimiNormalizationContext {
  /** `main` owns the portable session. Other agent journals are retained without polluting its lifecycle. */
  agentId?: string;
}

export interface KimiNormalizedRecord {
  events: AgentEvent[];
  promptId?: string;
  turnId?: string;
  timestamp?: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  nativeEvent: unknown;
  disposition: KimiNormalizationDisposition;
  explanation?: string;
}

interface PendingPrompt {
  text?: string;
  origin?: string;
}

interface ToolFact {
  tool: string;
  turnId?: string;
  input?: unknown;
  presentation?: ToolPresentation;
}

interface InteractionFact {
  kind: string;
}

const MAX_CORRELATIONS = 1_024;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const string = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const nativeTurnId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function inputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => {
      const item = record(part);
      if (item?.type === 'text') return string(item.text) ?? '';
      if (item?.type === 'shell') return string(item.command) ?? '';
      return '';
    })
    .join('');
  return text.length > 0 ? text : undefined;
}

function originKind(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return string(record(value)?.kind);
}

function boundedSetAdd<T>(target: Set<T>, value: T): void {
  if (!target.has(value) && target.size >= MAX_CORRELATIONS) {
    const oldest = target.values().next().value as T | undefined;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.add(value);
}

function boundedMapSet<K, V>(target: Map<K, V>, key: K, value: V): void {
  if (!target.has(key) && target.size >= MAX_CORRELATIONS) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.set(key, value);
}

function presentation(tool: string, input: unknown, completed = false): ToolPresentation {
  const lower = tool.toLowerCase();
  let kind: ToolActivityKind = 'other';
  let title = completed ? `Used ${tool}` : `Using ${tool}`;
  if (['bash', 'shell', 'command', 'execute'].includes(lower)) {
    kind = 'command';
    title = completed ? 'Ran command' : 'Running command';
  } else if (['websearch', 'web_search', 'search'].includes(lower)) {
    kind = 'web-search';
    title = completed ? 'Searched the web' : 'Searching the web';
  } else if (['fetchurl', 'webfetch', 'fetch', 'browser'].includes(lower)) {
    kind = 'browser';
    title = completed ? 'Fetched web content' : 'Fetching web content';
  } else if (['read', 'grep', 'glob', 'readmediafile'].includes(lower)) {
    kind = 'file-read';
    title = completed ? 'Read files' : 'Reading files';
  } else if (['write', 'edit', 'apply_patch', 'notebookedit'].includes(lower)) {
    kind = 'file-edit';
    title = completed ? 'Edited files' : 'Editing files';
  } else if (lower.startsWith('mcp__') || lower.startsWith('mcp_')) {
    kind = 'mcp';
  }
  const details = record(input);
  const detail =
    string(details?.command) ??
    string(details?.query) ??
    string(details?.url) ??
    string(details?.path) ??
    string(details?.file_path) ??
    string(details?.pattern) ??
    string(details?.description);
  return { kind, title, ...(detail ? { detail } : {}) };
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const item = record(value);
  const direct = string(item?.message) ?? string(item?.output) ?? string(item?.error);
  if (direct) return direct;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function permissionOutcome(response: unknown): 'allowed' | 'denied' | 'dismissed' | 'unknown' {
  const body = record(response);
  if (body?.cancelled === true) return 'dismissed';
  const decision = (string(body?.decision) ?? string(body?.outcome) ?? string(response))?.toLowerCase();
  if (decision && ['approved', 'approve', 'allowed', 'allow', 'yes'].includes(decision)) return 'allowed';
  if (decision && ['denied', 'deny', 'rejected', 'reject', 'no'].includes(decision)) return 'denied';
  if (decision && ['dismissed', 'cancelled', 'canceled'].includes(decision)) return 'dismissed';
  return 'unknown';
}

function taskId(info: Record<string, unknown> | undefined): string | undefined {
  return string(info?.taskId) ?? string(info?.task_id) ?? string(info?.id);
}

function native(adapterType: string): AgentEvent {
  return { type: 'adapter.native-event', adapter: 'kimi', nativeType: adapterType };
}

/** One stateful instance per native Kimi session. */
export class KimiWireNormalizer {
  private readonly pendingPrompts: PendingPrompt[] = [];
  private readonly startedTurns = new Set<string>();
  private readonly terminalTurns = new Set<string>();
  private readonly reasoningTurns = new Set<string>();
  private readonly assistantByTurn = new Map<string, string>();
  private readonly tools = new Map<string, ToolFact>();
  private readonly settledTools = new Set<string>();
  private readonly interactions = new Map<string, InteractionFact>();
  private readonly settledTasks = new Set<string>();
  private activeTurnId: string | undefined;

  normalize(input: unknown, context: KimiNormalizationContext = {}): KimiNormalizedRecord {
    const body = record(input);
    const type = string(body?.type) ?? 'invalid-record';
    const base = {
      timestamp: timestamp(body?.time ?? body?.created_at),
      source: 'native-log' as const,
      confidence: 'authoritative' as const,
      nativeEvent: input,
    };
    const result = (
      events: AgentEvent[],
      disposition: KimiNormalizationDisposition,
      fields: Pick<KimiNormalizedRecord, 'promptId' | 'turnId' | 'explanation'> = {},
    ): KimiNormalizedRecord => ({ ...base, events, disposition, ...fields });

    const agentId = context.agentId ?? 'main';
    if (agentId !== 'main') {
      return result([native(type)], 'retained-native', {
        explanation: `The ${agentId} journal is retained without projecting its private lifecycle onto the main session.`,
      });
    }

    if (!body) return result([native(type)], 'retained-native');

    switch (type) {
      case 'turn.prompt': {
        this.pendingPrompts.push({ text: inputText(body.input), origin: originKind(body.origin) });
        if (this.pendingPrompts.length > MAX_CORRELATIONS) this.pendingPrompts.shift();
        return result([], 'buffered', {
          explanation: 'Kimi persists the prompt before its native turn id; step.begin releases the correlation.',
        });
      }

      case 'context.append_loop_event':
        return this.normalizeLoopEvent(body, input, base);

      case 'turn.ended': {
        const turnId = nativeTurnId(body.turnId) ?? this.activeTurnId;
        if (!turnId) return result([native(type)], 'retained-native');
        if (this.terminalTurns.has(turnId)) return result([], 'no-output', { turnId });
        const events = this.startTurnIfNeeded(turnId);
        if (this.reasoningTurns.delete(turnId)) {
          events.push({ type: 'reasoning.completed', reasoningId: `kimi-reasoning:${turnId}` });
        }
        const assistant = this.assistantByTurn.get(turnId);
        if (assistant !== undefined) {
          events.push({
            type: 'assistant.message',
            messageId: `kimi-assistant:${turnId}`,
            turnId,
            text: assistant,
            final: true,
            displayOnly: false,
          });
        }
        const reason = string(body.reason) ?? 'unknown';
        if (reason === 'failed' || reason === 'blocked') {
          events.push({ type: 'turn.failed', turnId, error: errorText(body.error) ?? reason });
        } else {
          events.push({
            type: 'turn.completed',
            turnId,
            stopReason: reason,
            ...(assistant !== undefined ? { lastAssistantMessage: assistant } : {}),
          });
        }
        boundedSetAdd(this.terminalTurns, turnId);
        if (this.activeTurnId === turnId) this.activeTurnId = undefined;
        return result(events, 'mapped', { promptId: turnId, turnId });
      }

      case 'profile.bind': {
        const model = string(body.modelAlias);
        const effort = string(body.thinkingEffort);
        const disclosure = record(body.environmentDisclosure);
        const cwd = string(disclosure?.cwd);
        if (!model && !effort && !cwd) return result([], 'no-output');
        return result(
          [
            {
              type: 'session.environment.updated',
              intent: 'configured',
              ...(cwd ? { currentCwd: cwd } : {}),
              ...(model ? { model: { id: model, provider: 'moonshot-ai' } } : {}),
              ...(effort ? { effort } : {}),
            },
          ],
          'mapped',
        );
      }

      case 'llm.request': {
        const model = string(body.model);
        const effort = string(body.thinkingEffort);
        if (!model && !effort) return result([], 'no-output');
        return result(
          [
            {
              type: 'session.environment.updated',
              intent: 'observed',
              ...(model ? { model: { id: model, provider: 'moonshot-ai' } } : {}),
              ...(effort ? { effort } : {}),
            },
          ],
          'mapped',
        );
      }

      case 'interaction.request': {
        const requestId = string(body.id);
        const kind = string(body.kind) ?? 'unknown';
        if (!requestId) return result([native(type)], 'retained-native');
        boundedMapSet(this.interactions, requestId, { kind });
        if (kind !== 'approval') return result([native(`${type}:${kind}`)], 'retained-native');
        const request = record(body.request);
        const tool = string(request?.tool) ?? string(request?.toolName);
        return result(
          [
            {
              type: 'permission.requested',
              requestId,
              ...(string(body.toolCallId) ? { toolCallId: string(body.toolCallId) } : {}),
              ...(tool ? { tool } : {}),
              ...(request?.input !== undefined ? { input: request.input } : {}),
              presentation: 'native-tui',
            },
          ],
          'mapped',
          { turnId: this.activeTurnId },
        );
      }

      case 'interaction.resolved': {
        const requestId = string(body.id);
        const fact = requestId ? this.interactions.get(requestId) : undefined;
        if (!requestId || fact?.kind !== 'approval') return result([native(type)], 'retained-native');
        this.interactions.delete(requestId);
        return result(
          [{ type: 'permission.resolved', requestId, outcome: permissionOutcome(body.response) }],
          'mapped',
          { turnId: this.activeTurnId },
        );
      }

      case 'full_compaction.complete':
        return result([{ type: 'context-window.invalidated', reason: 'compacted' }], 'mapped');

      case 'context.clear':
      case 'context.undo':
        return result([{ type: 'context-window.invalidated', reason: 'history-changed' }], 'mapped');

      case 'task.started': {
        const info = record(body.info);
        const id = taskId(info);
        if (!id) return result([native(type)], 'retained-native');
        const events: AgentEvent[] = [
          {
            type: 'task.created',
            taskId: id,
            ...(string(info?.description) ? { description: string(info?.description) } : {}),
          },
        ];
        if (info?.kind === 'agent' && string(info.agentId)) {
          events.push({
            type: 'subagent.started',
            subagentId: string(info.agentId)!,
            ...(string(info.subagentType) ? { agentType: string(info.subagentType) } : {}),
          });
        }
        return result(events, 'mapped', { turnId: this.activeTurnId });
      }

      case 'task.terminated': {
        const info = record(body.info);
        const id = taskId(info);
        if (!id) return result([native(type)], 'retained-native');
        if (this.settledTasks.has(id)) return result([], 'no-output');
        boundedSetAdd(this.settledTasks, id);
        const events: AgentEvent[] = [{ type: 'task.completed', taskId: id }];
        if (info?.kind === 'agent' && string(info.agentId)) {
          events.push({ type: 'subagent.stopped', subagentId: string(info.agentId)! });
        }
        return result(events, 'mapped', { turnId: this.activeTurnId });
      }

      case 'metadata':
      case 'permission.set_mode':
      case 'context.append_message':
      case 'context.apply_compaction':
      case 'llm.tools_snapshot':
      case 'usage.record':
        return result([], 'no-output');

      case 'full_compaction.begin':
      case 'full_compaction.cancel':
      case 'turn.steer':
      case 'turn.cancel':
      case 'forked':
      case 'config.update':
      case 'tools.reset_active_tools':
      case 'permission.record_approval_result':
      case 'plan.revision':
      case 'plan_mode.enter':
      case 'plan_mode.exit':
      case 'plan_mode.cancel':
      case 'swarm_mode.enter':
      case 'swarm_mode.exit':
      case 'tools.register_user_tool':
      case 'tools.unregister_user_tool':
      case 'tools.set_active_tools':
      case 'tools.update_store':
      case 'goal.create':
      case 'goal.update':
      case 'goal.clear':
      case 'mcp.tools_discovered':
      case 'interruptionReminder.recorded':
        return result([native(type)], 'retained-native', { turnId: this.activeTurnId });

      default:
        return result([native(type)], 'retained-native', { turnId: this.activeTurnId });
    }
  }

  private normalizeLoopEvent(
    body: Record<string, unknown>,
    input: unknown,
    base: Pick<KimiNormalizedRecord, 'timestamp' | 'source' | 'confidence' | 'nativeEvent'>,
  ): KimiNormalizedRecord {
    const loop = record(body.event);
    const loopType = string(loop?.type) ?? 'unknown';
    const turnId = nativeTurnId(loop?.turnId) ?? this.activeTurnId;
    const finish = (
      events: AgentEvent[],
      disposition: KimiNormalizationDisposition,
      explanation?: string,
      correlatedTurnId = turnId,
    ): KimiNormalizedRecord => ({
      ...base,
      nativeEvent: input,
      events,
      disposition,
      ...(correlatedTurnId ? { promptId: correlatedTurnId, turnId: correlatedTurnId } : {}),
      ...(explanation ? { explanation } : {}),
    });

    if (loopType === 'step.begin') {
      if (!turnId) return finish([native(`context.append_loop_event:${loopType}`)], 'retained-native');
      // A fresh durable prompt is stronger evidence than an old tombstone.
      // Real Kimi monotonically allocates ids, but this also makes replay
      // robust to a restarted emulator or a repaired journal that begins a
      // new generation at zero. A bare late step with no prompt stays inert.
      if (this.terminalTurns.has(turnId) && this.pendingPrompts.length > 0) {
        this.terminalTurns.delete(turnId);
        this.startedTurns.delete(turnId);
        this.reasoningTurns.delete(turnId);
        this.assistantByTurn.delete(turnId);
      }
      const events = this.startTurnIfNeeded(turnId);
      return finish(events, events.length > 0 ? 'mapped' : 'no-output');
    }

    if (loopType === 'content.part') {
      if (!turnId) return finish([native(`context.append_loop_event:${loopType}`)], 'retained-native');
      if (this.terminalTurns.has(turnId)) {
        return finish(
          [native(`late:context.append_loop_event:${loopType}`)],
          'retained-native',
          'Content after a terminal turn is retained but cannot mutate portable conversation state.',
        );
      }
      const events = this.startTurnIfNeeded(turnId);
      const part = record(loop?.part);
      if (part?.type === 'think') {
        const reasoningId = `kimi-reasoning:${turnId}`;
        if (this.reasoningTurns.has(turnId)) {
          events.push({ type: 'reasoning.progress', reasoningId });
        } else {
          boundedSetAdd(this.reasoningTurns, turnId);
          events.push({ type: 'reasoning.started', reasoningId });
        }
        return finish(events, 'mapped');
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        const text = (this.assistantByTurn.get(turnId) ?? '') + part.text;
        boundedMapSet(this.assistantByTurn, turnId, text);
        events.push({
          type: 'assistant.message',
          messageId: `kimi-assistant:${turnId}`,
          turnId,
          text,
          final: false,
          displayOnly: false,
        });
        return finish(events, 'mapped');
      }
      events.push(native(`context.append_loop_event:content.part:${string(part?.type) ?? 'unknown'}`));
      return finish(events, 'retained-native');
    }

    if (loopType === 'tool.call') {
      const id = string(loop?.toolCallId);
      const tool = string(loop?.name);
      if (!id || !tool) return finish([native(`context.append_loop_event:${loopType}`)], 'retained-native');
      if (this.settledTools.has(id)) return finish([], 'no-output');
      const toolPresentation = presentation(tool, loop?.args);
      boundedMapSet(this.tools, id, {
        tool,
        ...(turnId ? { turnId } : {}),
        input: loop?.args,
        presentation: toolPresentation,
      });
      return finish(
        [
          {
            type: 'tool.requested',
            toolCallId: id,
            tool,
            ...(loop?.args !== undefined ? { input: loop.args } : {}),
            presentation: toolPresentation,
          },
        ],
        'mapped',
      );
    }

    if (loopType === 'tool.result') {
      const id = string(loop?.toolCallId);
      if (!id) return finish([native(`context.append_loop_event:${loopType}`)], 'retained-native');
      if (this.settledTools.has(id)) return finish([], 'no-output');
      const fact = this.tools.get(id);
      boundedSetAdd(this.settledTools, id);
      this.tools.delete(id);
      if (fact?.turnId && this.terminalTurns.has(fact.turnId)) {
        return finish(
          [native(`late:context.append_loop_event:${loopType}`)],
          'retained-native',
          'A tool result after its terminal turn is retained but cannot mutate portable tool state.',
          fact.turnId,
        );
      }
      const output = record(loop?.result)?.output;
      const failed = record(loop?.result)?.isError === true;
      const donePresentation = fact ? presentation(fact.tool, fact.input, true) : undefined;
      if (failed) {
        return finish(
          [
            {
              type: 'tool.failed',
              toolCallId: id,
              ...(fact?.tool ? { tool: fact.tool } : {}),
              ...(errorText(output ?? loop?.result) ? { error: errorText(output ?? loop?.result) } : {}),
              ...(donePresentation ? { presentation: donePresentation } : {}),
            },
          ],
          'mapped',
          undefined,
          fact?.turnId,
        );
      }
      return finish(
        [
          {
            type: 'tool.completed',
            toolCallId: id,
            ...(fact?.tool ? { tool: fact.tool } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(donePresentation ? { presentation: donePresentation } : {}),
          },
        ],
        'mapped',
        undefined,
        fact?.turnId,
      );
    }

    if (loopType === 'step.end') return finish([], 'no-output');
    return finish([native(`context.append_loop_event:${loopType}`)], 'retained-native');
  }

  private startTurnIfNeeded(turnId: string): AgentEvent[] {
    this.activeTurnId = turnId;
    if (this.startedTurns.has(turnId)) return [];
    boundedSetAdd(this.startedTurns, turnId);
    const prompt = this.pendingPrompts.shift();
    return [
      {
        type: 'turn.started',
        turnId,
        ...(prompt?.text ? { prompt: prompt.text } : {}),
      },
    ];
  }
}
