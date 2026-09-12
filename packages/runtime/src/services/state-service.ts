import {
  createInitialSessionState,
  reduceSessionState,
  type AgentEventEnvelope,
  type SessionRuntimeState,
} from '@vibecook/puppeteer-core';
import type { AgentProjectionService } from './projection-service.js';

function cloneSessionRuntimeState(state: SessionRuntimeState): SessionRuntimeState {
  const opaqueClones = new WeakMap<object, object>();
  const cloneOpaque = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    const existing = opaqueClones.get(value);
    if (existing) return existing;
    if (Array.isArray(value)) {
      const clone: unknown[] = [];
      opaqueClones.set(value, clone);
      for (const item of value) clone.push(cloneOpaque(item));
      return clone;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const clone: Record<string, unknown> = {};
    opaqueClones.set(value, clone);
    for (const [key, item] of Object.entries(value)) clone[key] = cloneOpaque(item);
    return clone;
  };
  return {
    ...state,
    ...(state.activeTurn ? { activeTurn: { ...state.activeTurn } } : {}),
    ...(state.activeReasoning ? { activeReasoning: { ...state.activeReasoning } } : {}),
    tools: new Map(
      [...state.tools].map(([id, tool]) => [
        id,
        {
          ...tool,
          ...(tool.input === undefined ? {} : { input: cloneOpaque(tool.input) }),
          ...(tool.presentation ? { presentation: { ...tool.presentation } } : {}),
        },
      ]),
    ),
    settledTools: new Map(state.settledTools),
    permissions: new Map([...state.permissions].map(([id, permission]) => [id, { ...permission }])),
    subagents: new Map([...state.subagents].map(([id, subagent]) => [id, { ...subagent }])),
    ...(state.contextWindow ? { contextWindow: { ...state.contextWindow } } : {}),
    environment: {
      ...(state.environment.currentCwd ? { currentCwd: { ...state.environment.currentCwd } } : {}),
      ...(state.environment.model
        ? { model: { ...state.environment.model, value: { ...state.environment.model.value } } }
        : {}),
      ...(state.environment.git
        ? {
            git: {
              ...state.environment.git,
              value: state.environment.git.value ? { ...state.environment.git.value } : null,
            },
          }
        : {}),
    },
    ...(state.exit ? { exit: { ...state.exit } } : {}),
    counters: { ...state.counters },
    diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

/** Agent-owned projection of normalized events into deterministic session state. */
export class AgentStateService implements AgentProjectionService<SessionRuntimeState> {
  readonly name = 'state';
  private current = createInitialSessionState();

  accepts(envelope: AgentEventEnvelope): boolean {
    return envelope.category !== 'monitor';
  }

  consume(envelope: AgentEventEnvelope): void {
    if (!this.accepts(envelope)) return;
    this.current = reduceSessionState(this.current, envelope);
  }

  snapshot(): SessionRuntimeState {
    return cloneSessionRuntimeState(this.current);
  }

  /** Runtime-only view used while applying the next pure reducer transition. */
  currentState(): SessionRuntimeState {
    return this.current;
  }
}
