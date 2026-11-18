/**
 * The OpenCode server password variables.
 *
 * 1.x reads `OPENCODE_SERVER_PASSWORD`. 2.x reads `OPENCODE_PASSWORD` first and falls back to the legacy name
 * (upstream v2.2.5 `packages/cli/src/env.ts`), so a stale `OPENCODE_PASSWORD` in an inherited environment would win
 * over the credential Puppeteer generated if a 2.x binary were reached. Both names are bearer secrets: a password
 * Puppeteer did not generate never reaches an OpenCode child, and Puppeteer only ever sets its own.
 */
export const OPENCODE_SERVER_PASSWORD_VARIABLES = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_PASSWORD'] as const;

/** A copy of `env` without either server password variable; every other entry is kept as given. */
export function withoutOpenCodeServerPasswords<T extends string | undefined>(
  env: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const copy: Record<string, T> = { ...env };
  for (const name of OPENCODE_SERVER_PASSWORD_VARIABLES) delete copy[name];
  return copy;
}
