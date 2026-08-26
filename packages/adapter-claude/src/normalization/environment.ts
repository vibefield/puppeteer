import { claudePermissionMode } from '../provider-modes.js';
import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { ClaudeHookPayload, NormalizedHook } from './types.js';
import { claudeEffortLevel, claudeString } from './wire.js';

export function normalizeClaudeSessionEnvironment(body: ClaudeHookPayload): AgentEvent | undefined {
  const currentCwd = claudeString(body.cwd);
  const model = claudeString(body.model);
  if (!currentCwd && !model) return undefined;
  return {
    type: 'session.environment.updated',
    ...(currentCwd ? { currentCwd } : {}),
    ...(model ? { model: { id: model, provider: 'anthropic' } } : {}),
  };
}

export function normalizeClaudeCwd(body: ClaudeHookPayload): AgentEvent | undefined {
  const currentCwd = claudeString(body.new_cwd) ?? claudeString(body.cwd);
  return currentCwd ? { type: 'session.environment.updated', currentCwd } : undefined;
}

/** Deduplicates observed Claude permission-mode and effort environment facts. */
export class ClaudeEnvironmentNormalizer {
  private permissionMode: string | undefined;
  private effort: string | undefined;

  append(result: NormalizedHook, body: ClaudeHookPayload): void {
    const permissionMode = claudeString(body.permission_mode);
    const effort = claudeEffortLevel(body.effort);
    const permissionChanged = permissionMode !== undefined && permissionMode !== this.permissionMode;
    const effortChanged = effort !== undefined && effort !== this.effort;
    if (!permissionChanged && !effortChanged) return;
    result.events.push({
      type: 'session.environment.updated',
      intent: 'observed',
      ...(permissionChanged ? { providerPermissionMode: claudePermissionMode(permissionMode!) } : {}),
      ...(effortChanged ? { effort } : {}),
    });
    if (permissionChanged) this.permissionMode = permissionMode;
    if (effortChanged) this.effort = effort;
  }

  reset(): void {
    this.permissionMode = undefined;
    this.effort = undefined;
  }
}
