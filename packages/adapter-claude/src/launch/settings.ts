/**
 * Generated Claude Code hook settings (DESIGN §16.5: settings are generated
 * from the registry, never handwritten). The passively observable subset of
 * the candidate's complete official event set is wired; confidence remains available to
 * consumers and tests so documentation-backed hooks cannot be mistaken for
 * runtime captures. Matcher-gated and behavior-replacing hooks stay explicit.
 *
 * A `timeout-blocks` hook (PreModelSwitch) is wired only when a caller selects it: an empty answer
 * preserves the native switch, and the bridge acknowledges before it fans out, but an answer that
 * misses the hook's timeout blocks the switch — never a default observer's trade. PostModelSwitch
 * (passive) is the default model-switch rail.
 *
 * Transport split follows the hybrid bridge (DESIGN §16.4): http events POST
 * straight to the loopback bridge; command-only events run a generated Node
 * forwarder that relays stdin JSON to the same bridge on every platform.
 *
 * SECURITY (DESIGN §16.5, §23): settings land on disk, so the token VALUE is
 * never written here. Only the `$<VAR>` reference goes in, resolved at hook
 * time via Claude's `allowedEnvVars` env interpolation.
 */

import { defaultHookEvents, supportedHookEvents, type HookEventSpec } from '../generated/registry.js';
import type { ClaudeStatusLineConfig } from '../observation/status-channel.js';

export interface HttpHookHandler {
  type: 'http';
  url: string;
  headers: Record<string, string>;
  allowedEnvVars: string[];
  timeout: number;
}

export interface CommandHookHandler {
  type: 'command';
  /** Absolute Node executable; `args` makes this Claude's shell-free exec form. */
  command: string;
  args: string[];
  timeout: number;
}

export type HookHandler = HttpHookHandler | CommandHookHandler;

/** One matcher block; Claude nests handlers under `hooks` (`[{ hooks: [...] }]`). */
export interface HookMatcher {
  matcher?: string;
  hooks: HookHandler[];
}

export interface ClaudeHookSettings {
  hooks: Record<string, HookMatcher[]>;
  statusLine?: ClaudeStatusLineConfig | undefined;
  subagentStatusLine?: ClaudeStatusLineConfig | undefined;
}

export interface GenerateHookSettingsOptions {
  /** Loopback bridge endpoint, e.g. http://127.0.0.1:<port>/hooks. */
  endpoint: string;
  /** Env var NAME holding the bearer token; only `$<name>` is written. */
  tokenEnvVar: string;
  /** Per-session, generated Node command-hook forwarder. */
  commandForwarderPath: string;
  /** Absolute Node executable used for shell-free command hooks; defaults to this process's executable. */
  commandExecutable?: string | undefined;
  /** Native matcher values. A FileChanged matcher also opts that event in. */
  matchers?: Readonly<Record<string, string>> | undefined;
  /**
   * Events to wire; defaults to passively observable events in the pinned Surface. Selecting a
   * `timeout-blocks` event opts into its native block-on-timeout behavior.
   */
  events?: readonly HookEventSpec[] | undefined;
  /** Internal multiplexer command plus presentation fields copied from the user's line. */
  statusLine?: ClaudeStatusLineConfig | undefined;
  /** Internal child-row multiplexer command plus fields copied from the user's line. */
  subagentStatusLine?: ClaudeStatusLineConfig | undefined;
}

export const CLAUDE_HOOK_FORWARDER_SOURCE = `const [endpoint, tokenEnvVar, timeoutText] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const token = process.env[tokenEnvVar];
if (!endpoint || !tokenEnvVar || !token) process.exit(2);
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: \`Bearer \${token}\` },
    body: input,
    signal: AbortSignal.timeout(Number(timeoutText)),
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
`;

function handlerFor(spec: HookEventSpec, options: GenerateHookSettingsOptions): HookHandler {
  if (spec.transport === 'http') {
    return {
      type: 'http',
      url: options.endpoint,
      headers: { Authorization: `Bearer $${options.tokenEnvVar}` },
      allowedEnvVars: [options.tokenEnvVar],
      timeout: spec.timeoutSec,
    };
  }
  return {
    type: 'command',
    command: options.commandExecutable ?? process.execPath,
    args: [options.commandForwarderPath, options.endpoint, options.tokenEnvVar, String(spec.timeoutSec * 1000)],
    timeout: spec.timeoutSec,
  };
}

function selectedEvents(options: GenerateHookSettingsOptions): readonly HookEventSpec[] {
  const supported = supportedHookEvents();
  const specs = new Map(supported.map((spec) => [spec.event, spec]));
  for (const [event, matcher] of Object.entries(options.matchers ?? {})) {
    if (!specs.has(event)) throw new Error(`Claude hook matcher references unsupported event ${event}`);
    if (!matcher.trim()) throw new Error(`Claude hook matcher for ${event} must be non-empty`);
  }
  if (options.events) {
    return options.events.map((requested) => {
      const canonical = specs.get(requested.event);
      if (!canonical) throw new Error(`Claude settings reference unsupported event ${requested.event}`);
      // Selection may override transport/timeout after a runtime probe, but it
      // cannot downgrade Surface-owned native behavior semantics.
      return { ...requested, registration: canonical.registration };
    });
  }
  return [
    ...defaultHookEvents(),
    ...supported.filter((spec) => spec.registration === 'matcher-required' && options.matchers?.[spec.event]?.trim()),
  ];
}

export function generateHookSettings(options: GenerateHookSettingsOptions): ClaudeHookSettings {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const spec of selectedEvents(options)) {
    if (spec.registration === 'response-required') {
      throw new Error(
        `Claude hook ${spec.event} replaces native behavior and requires a response; it cannot be passively observed`,
      );
    }
    const matcher = options.matchers?.[spec.event];
    if (spec.registration === 'matcher-required' && !matcher?.trim()) {
      throw new Error(`Claude hook ${spec.event} requires a non-empty matcher`);
    }
    hooks[spec.event] = [{ ...(matcher ? { matcher } : {}), hooks: [handlerFor(spec, options)] }];
  }
  return {
    hooks,
    statusLine: options.statusLine,
    subagentStatusLine: options.subagentStatusLine,
  };
}
