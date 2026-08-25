import type { AgentProviderMode } from '@vibecook/puppeteer-core';

const CLAUDE_PERMISSION_LABELS: Readonly<Record<string, string>> = {
  // Claude 2.1.234 accepts `manual` at launch but reports and persists the
  // effective native value as `default`. They are the same user-facing mode.
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
