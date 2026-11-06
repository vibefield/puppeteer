/**
 * The Claude forwarder: the one program Claude runs in the agent's process tree for the hooks it can only run as
 * commands and for both status lines. It relays what Claude writes on its stdin to the session's loopback bridge,
 * with the bearer read from the environment by name, never from an argument; for a status line it also runs the
 * person's own line beside it and answers with that line's output and exit.
 *
 * Self-contained by design: Node's builtins only, no relative import. The same code reaches a process three ways:
 * transpiled into the forwarder a launch stages (`generated/forwarder-source.ts`, run by this process's script
 * runner), sealed by a host into its own executable through `@vibefield/puppeteer-builtin-providers/forwarder` (core
 * `AgentHost.forwarderRuntime`), and imported by tests.
 *
 * The first argument is a versioned word, a protocol across releases: a Claude launched by one build runs the
 * forwarder a later build ships once its host has updated in place. The table is append-only. A shipped word keeps
 * its arguments and meaning; a change is a new word.
 */
import { spawn } from 'node:child_process';

/** `claude.hook.v1 <endpoint> <token variable> <timeout ms>`, the hook's JSON on stdin. */
export const CLAUDE_HOOK_FORWARDER_WORD = 'claude.hook.v1';
/** `claude.statusline.v1 [subagent]`, the line's JSON on stdin; its endpoint and delegate ride the environment. */
export const CLAUDE_STATUS_LINE_FORWARDER_WORD = 'claude.statusline.v1';
/** The status-line word's one argument: the child (task) line rather than the root line. */
export const CLAUDE_STATUS_LINE_SUBAGENT = 'subagent';
/** A word this forwarder does not know: the shell's own code for a command it cannot find. */
export const CLAUDE_FORWARDER_EXIT_UNKNOWN_WORD = 127;

/** What one run of the forwarder reads and writes: the process's own, or a test's. */
export interface ClaudeForwarderIo {
  /** Claude's JSON document for one hook or one status-line refresh. */
  stdin: AsyncIterable<string | Uint8Array>;
  env: NodeJS.ProcessEnv;
  /** Where the person's own status line runs. */
  cwd: string;
  /** One line, for a word this forwarder does not know. */
  stderr: { write(text: string): unknown };
}

type Relay = (args: readonly string[], io: ClaudeForwarderIo) => Promise<number>;

async function readInput(stdin: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  // Decoded once, whole: a character split across two reads stays one character.
  return Buffer.concat(chunks).toString('utf8');
}

/** A command-only hook: POST the hook's document to the bridge; 0 when it took it, 1 when not, 2 when unarmed. */
const relayHook: Relay = async ([endpoint, tokenEnvVar, timeoutText], io) => {
  const input = await readInput(io.stdin);
  const token = tokenEnvVar ? io.env[tokenEnvVar] : undefined;
  if (!endpoint || !tokenEnvVar || !token) return 2;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: input,
      signal: AbortSignal.timeout(Number(timeoutText)),
    });
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
};

/**
 * A status line: report the line's document as telemetry and run the person's original line concurrently, relaying
 * its output and exit without interpreting them. The telemetry never holds the line up beyond its bound.
 */
const relayStatusLine: Relay = async ([channel], io) => {
  const input = await readInput(io.stdin);
  const child = channel === CLAUDE_STATUS_LINE_SUBAGENT;
  const endpoint = io.env[child ? 'PUPPETEER_SUBAGENT_STATUSLINE_ENDPOINT' : 'PUPPETEER_STATUSLINE_ENDPOINT'];
  const delegateCommand = io.env[child ? 'PUPPETEER_SUBAGENT_STATUSLINE_DELEGATE' : 'PUPPETEER_STATUSLINE_DELEGATE'];
  const tokenEnvVar = io.env.PUPPETEER_STATUSLINE_TOKEN_ENV_VAR;
  const token = tokenEnvVar ? io.env[tokenEnvVar] : undefined;
  const configuredTimeout = Number(io.env.PUPPETEER_STATUSLINE_TIMEOUT_MS);
  const telemetryTimeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout >= 50 && configuredTimeout <= 5000
      ? configuredTimeout
      : 250;
  const telemetry =
    endpoint && token
      ? fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: input,
          signal: AbortSignal.timeout(telemetryTimeoutMs),
        }).catch(() => undefined)
      : Promise.resolve(undefined);
  const delegate = delegateCommand
    ? new Promise<number>((resolve) => {
        const line = spawn(delegateCommand, {
          shell: true,
          cwd: io.cwd,
          env: io.env,
          stdio: ['pipe', 'inherit', 'inherit'],
        });
        line.once('error', () => resolve(1));
        line.once('close', (code) => resolve(code ?? 1));
        // A line that exits without reading its input closes the pipe under the write: its exit is the answer.
        line.stdin.on('error', () => undefined);
        line.stdin.end(input);
      })
    : Promise.resolve(0);
  const [, code] = await Promise.all([telemetry, delegate]);
  return code;
};

const RELAYS: ReadonlyMap<string, Relay> = new Map<string, Relay>([
  [CLAUDE_HOOK_FORWARDER_WORD, relayHook],
  [CLAUDE_STATUS_LINE_FORWARDER_WORD, relayStatusLine],
]);

/** Every word this forwarder has shipped, in the order it shipped them. */
export const CLAUDE_FORWARDER_WORDS: readonly string[] = [...RELAYS.keys()];

function processIo(): ClaudeForwarderIo {
  return { stdin: process.stdin, env: process.env, cwd: process.cwd(), stderr: process.stderr };
}

/** Run one forwarder invocation, `<word> <word args...>`, and answer its exit code. */
export async function runClaudeForwarder(
  argv: readonly string[],
  io: ClaudeForwarderIo = processIo(),
): Promise<number> {
  const [word, ...args] = argv;
  const relay = word === undefined ? undefined : RELAYS.get(word);
  if (relay === undefined) {
    io.stderr.write('puppeteer: this Claude forwarder does not know the word it was given; nothing was forwarded.\n');
    return CLAUDE_FORWARDER_EXIT_UNKNOWN_WORD;
  }
  return relay(args, io);
}
