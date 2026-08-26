import { AGENT_MONITOR_COLLECTION_LIMITS, type PlanUpdatedEvent } from '@vibecook/puppeteer-core';
import { claudeRecord, claudeString, nonEmptyClaudeString } from './wire.js';

function parseTodoPlan(
  toolName: string,
  input: unknown,
  agentId: string | undefined,
): Pick<PlanUpdatedEvent, 'planId' | 'steps'> | undefined {
  if (toolName.toLowerCase() !== 'todowrite') return undefined;
  const todos = claudeRecord(input)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const steps = todos.flatMap((value): PlanUpdatedEvent['steps'] => {
    const todo = claudeRecord(value);
    const text =
      nonEmptyClaudeString(todo?.content) ??
      nonEmptyClaudeString(todo?.title) ??
      nonEmptyClaudeString(todo?.activeForm);
    return todo && text ? [{ text, status: claudeString(todo.status) ?? 'unknown' }] : [];
  });
  return { planId: `claude-todos:${agentId ?? 'root'}`, steps };
}

const MAX_PLAN_STEP_CHARS = 512;
const boundedStep = (value: string): string => {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_PLAN_STEP_CHARS ? compact : `${compact.slice(0, MAX_PLAN_STEP_CHARS - 1)}…`;
};

export function parseClaudeExitPlan(
  toolName: string,
  input: unknown,
  agentId: string | undefined,
): Pick<PlanUpdatedEvent, 'planId' | 'steps'> | undefined {
  if (toolName.toLowerCase() !== 'exitplanmode') return undefined;
  const markdown = nonEmptyClaudeString(claudeRecord(input)?.plan);
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
    const text = item?.[2] ? boundedStep(item[2]) : undefined;
    if (!text) continue;
    steps.push({ text, status: item?.[1]?.toLowerCase() === 'x' ? 'completed' : 'pending' });
    if (steps.length >= AGENT_MONITOR_COLLECTION_LIMITS.planSteps) break;
  }
  if (steps.length === 0) {
    const fallback = markdown
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trim())
      .find(Boolean);
    if (fallback) steps.push({ text: boundedStep(fallback), status: 'pending' });
  }
  return steps.length > 0 ? { planId: `claude-plan:${agentId ?? 'root'}`, steps } : undefined;
}

export function parseClaudePlan(
  toolName: string,
  input: unknown,
  agentId: string | undefined,
): Pick<PlanUpdatedEvent, 'planId' | 'steps'> | undefined {
  return parseTodoPlan(toolName, input, agentId) ?? parseClaudeExitPlan(toolName, input, agentId);
}

export function normalizeClaudePlanUpdated(
  plan: Pick<PlanUpdatedEvent, 'planId' | 'steps'>,
  provisional: boolean,
): PlanUpdatedEvent {
  return { type: 'planning:updated', ...plan, provisional };
}
