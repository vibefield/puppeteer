/**
 * A host's environment as a child process takes it, its unset names dropped. A service a host handed `env` starts
 * Codex with that one (and the profile's binding over it), never with this process's own.
 */
export function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
