const VERIFIED_CLAUDE_OTEL_VERSION = [2, 1, 245] as const;

function knownVersionSupportsClaudeOtelLogs(providerVersion: string | undefined): boolean | undefined {
  if (!providerVersion) return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(providerVersion.trim());
  if (!match) return undefined;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < VERIFIED_CLAUDE_OTEL_VERSION.length; index += 1) {
    if (current[index]! > VERIFIED_CLAUDE_OTEL_VERSION[index]!) return true;
    if (current[index]! < VERIFIED_CLAUDE_OTEL_VERSION[index]!) return false;
  }
  return true;
}

/** Unknown/new versions are probed safely; a known older binary stays on the transcript fallback. */
export function supportsClaudeOtelLogs(providerVersion: string | undefined): boolean {
  return knownVersionSupportsClaudeOtelLogs(providerVersion) ?? true;
}

export function isClaudeOtelLogsVerified(providerVersion: string | undefined): boolean {
  return knownVersionSupportsClaudeOtelLogs(providerVersion) === true;
}
