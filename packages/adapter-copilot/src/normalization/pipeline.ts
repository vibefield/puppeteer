import type { AgentEvent } from '@vibecook/puppeteer-core';
import { normalizeCopilotNative } from './adapter.js';
import { normalizeCopilotCompaction } from './compaction.js';
import { normalizeCopilotAssistantMessage } from './conversation.js';
import { normalizeCopilotDelegation } from './delegation.js';
import { normalizeCopilotEffort } from './effort.js';
import { normalizeCopilotEnvironment } from './environment.js';
import { normalizeCopilotInteraction } from './interaction.js';
import { normalizeCopilotMode } from './mode.js';
import { normalizeCopilotModel } from './model.js';
import { normalizeCopilotReasoning } from './reasoning.js';
import { normalizeCopilotSession } from './session.js';
import { copilotToolCompleted, copilotToolRequested, copilotToolStarted, type CopilotToolFact } from './tool.js';
import { normalizeCopilotMessageUsage, normalizeCopilotShutdownUsage } from './usage.js';
import { normalizeCopilotWorkflow } from './workflow.js';
import { copilotWorkspaceOperation, normalizeCopilotWorkspace } from './workspace.js';
import { copilotErrorText, copilotRecord, copilotString, type CopilotNormalizedRecord } from './types.js';

const MAX = 2_048;
const MAX_ACTORS = 256;
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V) {
  if (!map.has(key) && map.size >= MAX) map.delete(map.keys().next().value!);
  map.set(key, value);
}

interface CopilotActorState {
  currentInteractionId?: string;
  readonly internalTurns: Map<string, string>;
  readonly terminalInternalTurns: Set<string>;
  readonly tools: Map<string, CopilotToolFact>;
  readonly reasoning: Set<string>;
}

export class CopilotSessionNormalizer {
  private readonly actors = new Map<string, CopilotActorState>();

  private actor(agentId: string | undefined): CopilotActorState {
    const key = agentId ?? 'root';
    let state = this.actors.get(key);
    if (state) return state;
    if (this.actors.size >= MAX_ACTORS) {
      const evict =
        [...this.actors.keys()].find((candidate) => candidate !== 'root') ?? this.actors.keys().next().value;
      if (evict) this.actors.delete(evict);
    }
    state = {
      internalTurns: new Map(),
      terminalInternalTurns: new Set(),
      tools: new Map(),
      reasoning: new Set(),
    };
    this.actors.set(key, state);
    return state;
  }

  normalize(input: unknown): CopilotNormalizedRecord {
    const body = copilotRecord(input);
    const type = copilotString(body?.type) ?? 'invalid-record';
    const data = copilotRecord(body?.data) ?? {};
    const entryId = copilotString(body?.id) ?? `${type}:missing-id`;
    const agentId = copilotString(body?.agentId);
    const actor = this.actor(agentId);
    const base = {
      timestamp: copilotString(body?.timestamp),
      source: 'native-log' as const,
      confidence: 'authoritative' as const,
      nativeEvent: input,
    };
    const finish = (
      events: AgentEvent[],
      disposition: CopilotNormalizedRecord['disposition'],
      turnId = actor.currentInteractionId,
    ): CopilotNormalizedRecord => ({
      ...base,
      events,
      disposition,
      ...(turnId ? { promptId: turnId, turnId } : {}),
      ...(agentId ? { agentId } : {}),
    });
    if (!body) return finish(normalizeCopilotNative(type), 'retained-native');

    const session = normalizeCopilotSession(type, data);
    if (session) {
      const model = normalizeCopilotModel(type, data) ?? [];
      const effort = normalizeCopilotEffort(type, data) ?? [];
      return finish([...session, ...model, ...effort], 'mapped');
    }

    const direct =
      normalizeCopilotEnvironment(type, data) ??
      normalizeCopilotMode(type, data) ??
      normalizeCopilotWorkspace(type, data) ??
      normalizeCopilotInteraction(type, entryId, data) ??
      normalizeCopilotCompaction(type, data) ??
      normalizeCopilotDelegation(type, data) ??
      normalizeCopilotWorkflow(type, data);
    if (direct) return finish(direct, direct.length ? 'mapped' : 'no-output');
    const model = normalizeCopilotModel(type, data);
    const effort = normalizeCopilotEffort(type, data);
    if (model || effort)
      return finish([...(model ?? []), ...(effort ?? [])], model?.length || effort?.length ? 'mapped' : 'no-output');

    if (type === 'user.message') {
      const interactionId = copilotString(data.interactionId) ?? entryId;
      actor.currentInteractionId = interactionId;
      return finish(
        [
          {
            type: 'turn:started',
            turnId: interactionId,
            ...(typeof data.content === 'string' ? { prompt: data.content } : {}),
          },
        ],
        'mapped',
        interactionId,
      );
    }
    if (type === 'assistant.turn_start') {
      const internal = copilotString(data.turnId);
      const interaction = copilotString(data.interactionId) ?? actor.currentInteractionId;
      if (internal && interaction) boundedSet(actor.internalTurns, internal, interaction);
      return finish([], 'no-output', interaction);
    }
    if (type === 'assistant.reasoning') {
      const key = copilotString(data.reasoningId) ?? actor.currentInteractionId ?? entryId;
      const normalized = normalizeCopilotReasoning(data, actor.reasoning.has(key));
      actor.reasoning.add(key);
      return finish(normalized.events, 'mapped');
    }
    if (type === 'assistant.message') {
      const internal = copilotString(data.turnId);
      const interaction =
        copilotString(data.interactionId) ??
        (internal ? actor.internalTurns.get(internal) : undefined) ??
        actor.currentInteractionId ??
        entryId;
      const events = normalizeCopilotAssistantMessage(entryId, data, interaction);
      const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      for (const value of requests) {
        const request = copilotRecord(value);
        const id = copilotString(request?.toolCallId);
        const tool = copilotString(request?.name);
        if (!id || !tool) continue;
        const fact: CopilotToolFact = {
          tool,
          ...(request?.arguments !== undefined ? { input: request.arguments } : {}),
          turnId: interaction,
        };
        boundedSet(actor.tools, id, fact);
        events.push(copilotToolRequested(id, tool, request?.arguments));
        const workspace = copilotWorkspaceOperation(id, fact, 'proposed');
        if (workspace) events.push(workspace);
      }
      events.push(...normalizeCopilotMessageUsage(entryId, data));
      if (internal && requests.length === 0) actor.terminalInternalTurns.add(internal);
      return finish(events, events.length ? 'mapped' : 'no-output', interaction);
    }
    if (type === 'assistant.turn_end') {
      const internal = copilotString(data.turnId);
      const interaction = (internal ? actor.internalTurns.get(internal) : undefined) ?? actor.currentInteractionId;
      if (internal) actor.internalTurns.delete(internal);
      if (!internal || !actor.terminalInternalTurns.delete(internal) || !interaction)
        return finish([], 'no-output', interaction);
      const events: AgentEvent[] = [];
      for (const reasoningId of actor.reasoning) events.push({ type: 'reasoning:completed', reasoningId });
      actor.reasoning.clear();
      events.push({ type: 'turn:completed', turnId: interaction });
      actor.currentInteractionId = undefined;
      return finish(events, 'mapped', interaction);
    }
    if (type === 'tool.execution_start') {
      const id = copilotString(data.toolCallId);
      const tool = copilotString(data.toolName);
      if (!id || !tool) return finish(normalizeCopilotNative(type), 'retained-native');
      let fact = actor.tools.get(id);
      const events: AgentEvent[] = [];
      if (!fact) {
        fact = {
          tool,
          ...(data.arguments !== undefined ? { input: data.arguments } : {}),
          ...(actor.currentInteractionId ? { turnId: actor.currentInteractionId } : {}),
        };
        boundedSet(actor.tools, id, fact);
        events.push(copilotToolRequested(id, tool, data.arguments));
      }
      events.push(copilotToolStarted(id, fact));
      const workspace = copilotWorkspaceOperation(id, fact, 'in-progress');
      if (workspace) events.push(workspace);
      return finish(events, 'mapped', fact.turnId);
    }
    if (type === 'tool.execution_complete') {
      const id = copilotString(data.toolCallId);
      if (!id) return finish(normalizeCopilotNative(type), 'retained-native');
      const fact = actor.tools.get(id);
      actor.tools.delete(id);
      const event = copilotToolCompleted(id, data, fact);
      const workspace = fact
        ? copilotWorkspaceOperation(id, fact, data.success === false || data.error !== undefined ? 'failed' : 'applied')
        : undefined;
      return finish([event, ...(workspace ? [workspace] : [])], 'mapped', fact?.turnId);
    }
    if (type === 'abort' || type === 'session.error') {
      const interaction = actor.currentInteractionId;
      if (!interaction) return finish(normalizeCopilotNative(type), 'retained-native');
      actor.currentInteractionId = undefined;
      actor.internalTurns.clear();
      actor.terminalInternalTurns.clear();
      const error = copilotErrorText(data.message ?? data.reason);
      const events: AgentEvent[] = [];
      for (const reasoningId of actor.reasoning) events.push({ type: 'reasoning:completed', reasoningId });
      actor.reasoning.clear();
      for (const [toolCallId, fact] of actor.tools) {
        events.push({
          type: 'tool:failed',
          toolCallId,
          tool: fact.tool,
          ...(error ? { error } : {}),
        });
      }
      actor.tools.clear();
      return finish(
        [
          ...events,
          {
            type: 'turn:failed',
            turnId: interaction,
            ...(error ? { error } : {}),
          },
        ],
        'mapped',
        interaction,
      );
    }
    if (type === 'session.shutdown') {
      const events = normalizeCopilotShutdownUsage(entryId, data);
      const changes = copilotRecord(data.codeChanges);
      if (Array.isArray(changes?.filesModified) && changes.filesModified.length) {
        const files = changes.filesModified
          .filter((path): path is string => typeof path === 'string' && path.length > 0)
          .map((path) => ({ path, kind: 'unknown' as const }));
        if (files.length) events.push({ type: 'workspace:file-changed', changes: files });
      }
      return finish(
        events.length ? events : normalizeCopilotNative(type),
        events.length ? 'mapped' : 'retained-native',
      );
    }
    return finish(normalizeCopilotNative(type), 'retained-native');
  }
}
