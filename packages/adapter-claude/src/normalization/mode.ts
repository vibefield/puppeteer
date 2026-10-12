import type { AgentProviderMode } from '@vibefield/puppeteer-core';
import type { ClaudeHookPayload, NormalizedHook } from './types.js';
import { claudeString } from './wire.js';

const CLAUDE_PERMISSION_LABELS: Readonly<Record<string, string>> = {
  // Claude accepts `manual` at launch but reports and persists the effective
  // native value as `default`. They are the same user-facing mode.
  default: 'Manual',
  manual: 'Manual',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: "Don't Ask",
  bypassPermissions: 'Bypass Permissions',
};

/** Preserve Claude's open raw value while adding a known user-facing label. */
export function claudePermissionMode(raw: string): AgentProviderMode {
  const normalized = CLAUDE_PERMISSION_LABELS[raw];
  return { raw, ...(normalized ? { normalized } : {}) };
}

/** Deduplicates observed Claude permission modes for the Core mode service. */
export class ClaudeModeNormalizer {
  private permissionMode: string | undefined;

  append(result: NormalizedHook, body: ClaudeHookPayload): void {
    const permissionMode = claudeString(body.permission_mode);
    if (permissionMode === undefined || permissionMode === this.permissionMode) return;
    result.events.push({
      type: 'mode:updated',
      intent: 'observed',
      modeKind: 'provider-permission',
      mode: claudePermissionMode(permissionMode),
    });
    this.permissionMode = permissionMode;
  }

  reset(): void {
    this.permissionMode = undefined;
  }
}
