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
import { open } from 'node:fs/promises';

/** `claude.hook.v1 <endpoint> <token variable> <timeout ms>`, the hook's JSON on stdin. */
export const CLAUDE_HOOK_FORWARDER_WORD = 'claude.hook.v1';
/**
 * `claude.hook.v2 <endpoint> <token variable> <timeout ms> <spool path>`: v1's relay, and a `SessionStart` the bridge
 * could not be reached for is kept as one line of the spool (observation/hook-spool.ts reads it at an attach).
 */
export const CLAUDE_HOOK_SPOOL_FORWARDER_WORD = 'claude.hook.v2';
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

/** POST one hook's document to the bridge: 0 when it took it, 1 when it answered otherwise, `unreached` on no answer. */
async function postHook(
  input: string,
  endpoint: string,
  token: string,
  timeoutText: string | undefined,
): Promise<0 | 1 | 'unreached'> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: input,
      signal: AbortSignal.timeout(Number(timeoutText)),
    });
    return response.ok ? 0 : 1;
  } catch {
    return 'unreached';
  }
}

/** A command-only hook: POST the hook's document to the bridge; 0 when it took it, 1 when not, 2 when unarmed. */
const relayHook: Relay = async ([endpoint, tokenEnvVar, timeoutText], io) => {
  const input = await readInput(io.stdin);
  const token = tokenEnvVar ? io.env[tokenEnvVar] : undefined;
  if (!endpoint || !tokenEnvVar || !token) return 2;
  const posted = await postHook(input, endpoint, token, timeoutText);
  return posted === 'unreached' ? 1 : posted;
};

/** The spool keeps at most this many lines and bytes; a start past either is not kept. */
export const CLAUDE_HOOK_SPOOL_MAX_LINES = 256;
export const CLAUDE_HOOK_SPOOL_MAX_BYTES = 64 * 1024;

/**
 * Keep one `SessionStart` the bridge could not be reached for: one JSON line, appended (the file is made owner-only),
 * holding the hook's ids and source and never the bearer. A document that is not a start with a session id, a spool
 * at its bound, or a spool that cannot be written keeps nothing: the hook is lost, as with v1.
 */
async function spoolStart(spoolPath: string, input: string): Promise<void> {
  let document: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    document = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (document.hook_event_name !== 'SessionStart') return;
  const sessionId = document.session_id;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return;
  const line = `${JSON.stringify({
    v: 1,
    at: new Date().toISOString(),
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    ...(typeof document.source === 'string' ? { source: document.source } : {}),
    ...(typeof document.transcript_path === 'string' ? { transcript_path: document.transcript_path } : {}),
  })}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // 'a+' reads what is kept and appends after it; a file it creates is the owner's alone.
    handle = await open(spoolPath, 'a+', 0o600);
    const { size } = await handle.stat();
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (size + lineBytes > CLAUDE_HOOK_SPOOL_MAX_BYTES) return;
    const kept = size === 0 ? '' : await handle.readFile('utf8');
    let lines = 0;
    for (let at = kept.indexOf('\n'); at !== -1; at = kept.indexOf('\n', at + 1)) lines += 1;
    if (lines >= CLAUDE_HOOK_SPOOL_MAX_LINES) return;
    // One write: an append of one line lands whole beside another forwarder's.
    await handle.write(line);
  } catch {
    // The spool's folder is gone (an OS temp sweep) or cannot be written: nothing is kept.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * v1's relay, and a `SessionStart` that reached no bridge is kept in the spool: only when the post had no answer (the
 * bridge is down, or did not answer in time), never on an answer of any status. A host that comes back reads it at its
 * attach (the start of a `/clear` typed meanwhile, say). A bridge that took the hook and did not answer within its
 * timeout leaves a start the host did hear: the bridge answers as soon as it has read a hook, so that needs a host that
 * hung mid-request.
 */
const relayHookWithSpool: Relay = async ([endpoint, tokenEnvVar, timeoutText, spoolPath], io) => {
  const input = await readInput(io.stdin);
  const token = tokenEnvVar ? io.env[tokenEnvVar] : undefined;
  if (!endpoint || !tokenEnvVar || !token) return 2;
  const posted = await postHook(input, endpoint, token, timeoutText);
  if (posted !== 'unreached') return posted;
  if (spoolPath) await spoolStart(spoolPath, input);
  return 1;
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
  [CLAUDE_HOOK_SPOOL_FORWARDER_WORD, relayHookWithSpool],
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
