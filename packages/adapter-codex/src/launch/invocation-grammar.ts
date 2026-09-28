/**
 * Codex's own CLI grammar as data, and the one walker that reads a typed argv the
 * way clap reads it (codex-cli 0.157.1).
 *
 * Each row says what an option or subcommand IS for a managed launch: a utility, a
 * one-shot or an agent elsewhere (a passthrough, which every host runs as typed), a
 * session argument the managed recipe carries, or one it cannot carry (rejected — a
 * strict host shows the person `why`). The census (`invocation-grammar.test.ts`)
 * holds every row to the help captured in `__fixtures__/`, and the probes the rows
 * cite are recorded under packages/surface/vendors/codex/probes/codex@0.157.1/.
 *
 * The managed launch is not the typed command with flags added: the adapter starts a
 * private app-server, starts the thread itself, and the terminal runs
 * `codex resume <thread> --remote <addr>` (tui-session.ts). So a carried argument
 * lands in one of three places — the thread's start parameters, the private
 * server's command line, or the TUI's — and each landing below was chosen by a probe
 * that compared the typed command with the managed recipe at the model's request.
 */

import type { AgentNativeInvocationPassthroughKind } from '@vibecook/puppeteer-core';

/** The codex release whose help the table and its census fixtures were captured from. */
export const CODEX_GRAMMAR_VERSION = '0.157.1';

/** `flag`: no value. `value`: exactly one (`<VALUE>`). `values`: one or more (`<VALUE>...`). */
export type CodexArity = 'flag' | 'value' | 'values';

/** Where a carried option lands in the managed recipe. */
export type CodexLanding =
  /** `thread/start`'s `model`. */
  | 'thread-model'
  /** `thread/start`'s `sandbox`. */
  | 'thread-sandbox'
  /** `thread/start`'s `approvalPolicy`. */
  | 'thread-approval'
  /** `thread/start`'s `sandbox: danger-full-access` and `approvalPolicy: never`. */
  | 'thread-bypass'
  /** The private app-server's command line and the TUI's: each process reads its own settings. */
  | 'server'
  /** `--search`: the server's `web_search = live` (what the TUI itself makes of it), and the TUI's own flag. */
  | 'server-search'
  /** The TUI's command line alone. */
  | 'tui'
  /** The resume picker's own selector, passed to the TUI as typed (today's `resume --last` / `--all`). */
  | 'selector';

export type CodexOptionClass = 'help' | 'version' | 'carried' | 'rejected';

export interface CodexOptionRow {
  readonly names: readonly string[];
  readonly arity: CodexArity;
  /** clap appends a second use; otherwise a second use is its error. */
  readonly repeatable: boolean;
  /** clap's closed value set, when it has one. */
  readonly values?: readonly string[];
  /** Accepted after `resume` only; every other row is the same at the root and after `resume`. */
  readonly resumeOnly?: true;
  readonly class: CodexOptionClass;
  readonly landing?: CodexLanding;
  /** Rejected: the one clause a person reads. Otherwise: why the row lands where it does. */
  readonly why: string;
  /** The probes that settle the row (their record: probes/codex@0.157.1/README.md). */
  readonly evidence: readonly string[];
}

export type CodexSubcommandClass = AgentNativeInvocationPassthroughKind | 'session' | 'rejected';

export interface CodexSubcommandRow {
  readonly name: string;
  /** Aliases the help shows. */
  readonly aliases: readonly string[];
  /** Aliases clap accepts that the help does not show, each with the probe that found it. */
  readonly hiddenAliases?: Readonly<Record<string, string>>;
  /** Present when the help does not list the subcommand at all: the probe that found it. */
  readonly hidden?: string;
  readonly class: CodexSubcommandClass;
  readonly why: string;
}

const NOT_YET = 'which a managed session cannot pass on yet';

/** One row per option in `codex --help` and `codex resume --help`. */
export const CODEX_OPTIONS: readonly CodexOptionRow[] = [
  {
    names: ['-c', '--config'],
    arity: 'value',
    repeatable: true,
    class: 'carried',
    landing: 'server',
    why: 'a thread takes a setting from the server that starts it, so the private server gets it (codex parses it there as typed) and so does the TUI; given only to the TUI on a resume it does not reach the thread',
    evidence: ['P2 S6', 'P3 S13', 'P4 S17', 'P4 S18', 'P5 S19'],
  },
  {
    names: ['--enable'],
    arity: 'value',
    repeatable: true,
    class: 'carried',
    landing: 'server',
    why: 'the same as -c features.<name>=true, which the app-server takes itself',
    evidence: ['help', 'app-server help', 'P5 S19'],
  },
  {
    names: ['--disable'],
    arity: 'value',
    repeatable: true,
    class: 'carried',
    landing: 'server',
    why: 'the same as -c features.<name>=false, which the app-server takes itself',
    evidence: ['help', 'app-server help', 'P4 S17', 'P4 S18', 'P5 S19'],
  },
  {
    names: ['--remote'],
    arity: 'value',
    repeatable: false,
    class: 'rejected',
    why: 'Codex remote transport arguments are owned by the adapter',
    evidence: ['tui-session.ts'],
  },
  {
    names: ['--remote-auth-token-env'],
    arity: 'value',
    repeatable: false,
    class: 'rejected',
    why: 'Codex remote transport arguments are owned by the adapter',
    evidence: ['tui-session.ts'],
  },
  {
    names: ['--strict-config'],
    arity: 'flag',
    repeatable: false,
    class: 'rejected',
    why: `it makes codex refuse settings it does not recognize, ${NOT_YET}`,
    evidence: ['unprobed: a config.toml with an unknown field, typed vs managed, must fail the same way'],
  },
  {
    names: ['-i', '--image'],
    arity: 'values',
    repeatable: true,
    class: 'carried',
    landing: 'tui',
    why: 'the TUI reads the images and sends them with its first turn, over a managed resume as typed',
    evidence: ['parse batch3', 'parse batch5', 'P2 S8', 'P2 S9', 'P5 S20', 'P5 S21'],
  },
  {
    names: ['-m', '--model'],
    arity: 'value',
    repeatable: false,
    class: 'carried',
    landing: 'thread-model',
    why: 'a start parameter the TUI adopts from the thread it resumes',
    evidence: ['P2 S3', 'P2 S4'],
  },
  {
    names: ['--oss'],
    arity: 'flag',
    repeatable: false,
    class: 'rejected',
    why: `it switches to a local open-source model provider, ${NOT_YET}`,
    evidence: ['unprobed: needs a local model server; the thread/start a typed --oss sends is unknown'],
  },
  {
    names: ['--local-provider'],
    arity: 'value',
    repeatable: false,
    class: 'rejected',
    why: `it picks a local model provider, ${NOT_YET}`,
    evidence: ['unprobed: needs a local model server; the thread/start a typed --local-provider sends is unknown'],
  },
  {
    names: ['-p', '--profile'],
    arity: 'value',
    repeatable: false,
    class: 'rejected',
    why: "it layers a settings file that a managed session's server cannot load",
    evidence: ['app-server help (no --profile)', 'P3 S13', 'P3 S14'],
  },
  {
    names: ['-s', '--sandbox'],
    arity: 'value',
    repeatable: false,
    values: ['read-only', 'workspace-write', 'danger-full-access'],
    class: 'carried',
    landing: 'thread-sandbox',
    why: 'a start parameter; the TUI refuses it on a remote resume',
    evidence: ['P2 S3', 'P2 S4', 'P2 S7', 'P2 S10', 'P2 S11'],
  },
  {
    names: ['--approve-for-me'],
    arity: 'flag',
    repeatable: false,
    class: 'rejected',
    why: `it hands approvals to automatic review, ${NOT_YET}`,
    evidence: ['unprobed: the approvals reviewer a typed --approve-for-me starts its thread with is unknown'],
  },
  {
    names: ['--dangerously-bypass-approvals-and-sandbox'],
    arity: 'flag',
    repeatable: false,
    class: 'carried',
    landing: 'thread-bypass',
    why: 'the model is told exactly what the typed flag tells it: no sandbox, and approval policy never',
    evidence: ['P2 S10', 'P2 S11'],
  },
  {
    names: ['--dangerously-bypass-hook-trust'],
    arity: 'flag',
    repeatable: false,
    class: 'rejected',
    why: `it runs hooks without their saved trust, ${NOT_YET}`,
    evidence: ['unprobed: where a typed --dangerously-bypass-hook-trust reaches the server is unknown'],
  },
  {
    names: ['-C', '--cd'],
    arity: 'value',
    repeatable: false,
    class: 'rejected',
    why: 'it moves the session to another directory, and a managed session works in the directory it was typed in',
    evidence: ['brief'],
  },
  {
    names: ['--worktree'],
    arity: 'flag',
    repeatable: false,
    class: 'rejected',
    why: 'it starts the session in a new git worktree, which a managed session cannot set up',
    evidence: ['brief'],
  },
  {
    names: ['--add-dir'],
    arity: 'value',
    repeatable: true,
    class: 'rejected',
    why: "codex does not take extra writable directories when its terminal joins a separate server, as a managed session's does",
    evidence: ['P3 S12', 'P3 S15', 'P4 S16'],
  },
  {
    names: ['-a', '--ask-for-approval'],
    arity: 'value',
    repeatable: false,
    values: ['on-request', 'never'],
    class: 'carried',
    landing: 'thread-approval',
    why: 'a start parameter the TUI adopts; the TUI refuses it on a remote resume',
    evidence: ['parse batch3', 'P2 S3', 'P2 S4', 'P2 S7'],
  },
  {
    names: ['--search'],
    arity: 'flag',
    repeatable: false,
    class: 'carried',
    landing: 'server-search',
    why: 'the TUI makes it web_search = live, which reaches the thread only from its server',
    evidence: ['P3 S14', 'P4 S18', 'P5 S19'],
  },
  {
    names: ['--no-alt-screen'],
    arity: 'flag',
    repeatable: false,
    class: 'carried',
    landing: 'tui',
    why: "the TUI's own presentation",
    evidence: ['P2 S3', 'P2 S4', 'P2 S6'],
  },
  {
    names: ['--no-daemon'],
    arity: 'flag',
    repeatable: false,
    class: 'rejected',
    why: "it runs the session's server inside this terminal, and a managed session's server runs apart from it",
    evidence: ['codex: "--no-daemon cannot be used with --remote"'],
  },
  {
    names: ['-h', '--help'],
    arity: 'flag',
    repeatable: false,
    class: 'help',
    why: 'codex prints its help',
    evidence: ['help'],
  },
  {
    names: ['-V', '--version'],
    arity: 'flag',
    repeatable: false,
    class: 'version',
    why: 'codex prints its version',
    evidence: ['help', 'parse batch3'],
  },
  {
    names: ['--last'],
    arity: 'flag',
    repeatable: false,
    resumeOnly: true,
    class: 'carried',
    landing: 'selector',
    why: "the TUI's own resume selection, against the private server's copy of the same sessions",
    evidence: ['native-invocation.test.ts (today)'],
  },
  {
    names: ['--all'],
    arity: 'flag',
    repeatable: false,
    resumeOnly: true,
    class: 'carried',
    landing: 'selector',
    why: "the TUI's own resume picker, against the private server's copy of the same sessions",
    evidence: ['native-invocation.test.ts (today)'],
  },
  {
    names: ['--include-non-interactive'],
    arity: 'flag',
    repeatable: false,
    resumeOnly: true,
    class: 'rejected',
    why: `it widens the resume picker, ${NOT_YET}`,
    evidence: [
      'unprobed: a home holding one exec session; resume --last with it must pick that session managed as typed',
    ],
  },
];

/** One row per subcommand in `codex --help`, and the hidden ones clap accepts. */
export const CODEX_SUBCOMMANDS: readonly CodexSubcommandRow[] = [
  { name: 'agents', aliases: [], class: 'elsewhere', why: "it browses the sessions of codex's shared server" },
  { name: 'exec', aliases: ['e'], class: 'one-shot', why: 'it runs codex non-interactively' },
  { name: 'review', aliases: [], class: 'one-shot', why: 'it runs a code review non-interactively' },
  { name: 'login', aliases: [], class: 'utility', why: 'it manages the login' },
  { name: 'logout', aliases: [], class: 'utility', why: 'it removes the stored login' },
  { name: 'mcp', aliases: [], class: 'utility', why: 'it manages MCP servers' },
  { name: 'plugin', aliases: [], class: 'utility', why: 'it manages plugins' },
  { name: 'app-server', aliases: [], class: 'elsewhere', why: 'it runs a server other clients drive' },
  { name: 'remote-control', aliases: [], class: 'elsewhere', why: "it manages codex's shared server" },
  { name: 'app', aliases: [], class: 'elsewhere', why: 'it opens the desktop app' },
  { name: 'completion', aliases: [], class: 'utility', why: 'it prints shell completions' },
  { name: 'update', aliases: [], class: 'utility', why: 'it updates codex' },
  { name: 'doctor', aliases: [], class: 'utility', why: 'it diagnoses the installation' },
  { name: 'sandbox', aliases: [], class: 'utility', why: 'it runs a command in a sandbox' },
  { name: 'debug', aliases: [], class: 'utility', why: 'it runs debugging tools' },
  { name: 'apply', aliases: ['a'], class: 'utility', why: 'it applies the latest diff' },
  { name: 'resume', aliases: [], class: 'session', why: 'it resumes an interactive session' },
  { name: 'queue', aliases: [], class: 'utility', why: 'it queues a message for an existing session' },
  { name: 'archive', aliases: [], class: 'utility', why: 'it archives a saved session' },
  { name: 'delete', aliases: [], class: 'utility', why: 'it deletes a saved session' },
  { name: 'migrate-rollouts', aliases: [], class: 'utility', why: 'it migrates saved sessions' },
  { name: 'unarchive', aliases: [], class: 'utility', why: 'it unarchives a saved session' },
  {
    name: 'fork',
    aliases: [],
    class: 'rejected',
    why: 'forking a session is not something a managed session can start yet',
  },
  {
    name: 'cloud',
    aliases: [],
    hiddenAliases: { 'cloud-tasks': 'parse batch3: `codex cloud-tasks --help` prints the cloud help' },
    class: 'elsewhere',
    why: 'it works with Codex Cloud tasks',
  },
  { name: 'exec-server', aliases: [], class: 'elsewhere', why: 'it runs an execution server for other sessions' },
  { name: 'features', aliases: [], class: 'utility', why: 'it inspects feature flags' },
  { name: 'help', aliases: [], class: 'utility', why: 'codex prints its help' },
  {
    name: 'execpolicy',
    aliases: [],
    hidden: 'parse batch3: `codex execpolicy --help` prints "Execpolicy tooling"',
    class: 'utility',
    why: 'it runs execution-policy tooling',
  },
  {
    name: 'responses-api-proxy',
    aliases: [],
    hidden: 'parse batch3: `codex responses-api-proxy --help` prints "Internal: run the responses API proxy"',
    class: 'utility',
    why: 'it runs an internal proxy',
  },
  {
    name: 'stdio-to-uds',
    aliases: [],
    hidden: 'parse batch3: `codex stdio-to-uds --help` prints "Internal: relay stdio to a Unix domain socket"',
    class: 'utility',
    why: 'it runs an internal relay',
  },
  {
    name: 'tcp-tunnel',
    aliases: [],
    hidden: 'parse batch3: `codex tcp-tunnel --help` prints "Internal: forward a local TCP socket …"',
    class: 'utility',
    why: 'it runs an internal tunnel',
  },
];

export interface CodexOptionUse {
  readonly row: CodexOptionRow;
  /** The option's own token as typed (`-mgpt-5`, `--model`, `--model=gpt-5`). */
  readonly token: string;
  /** Its position in argv. */
  readonly index: number;
  readonly values: readonly string[];
  /** Typed after `resume`. */
  readonly inResume: boolean;
}

export interface CodexPositional {
  readonly value: string;
  readonly index: number;
}

export interface CodexSessionReading {
  /** `codex resume …`: a session to resume rather than a new one. */
  readonly resume: boolean;
  /** The root's `[PROMPT]`, when typed before any `resume`. */
  readonly prompt?: CodexPositional;
  /** `resume`'s `[SESSION_ID] [PROMPT]`, in order. */
  readonly resumePositionals: readonly CodexPositional[];
  readonly options: readonly CodexOptionUse[];
}

export type CodexInvocationReading =
  | {
      readonly kind: 'passthrough';
      readonly passthrough: AgentNativeInvocationPassthroughKind;
      readonly reason: string;
    }
  | { readonly kind: 'rejected'; readonly reason: string; readonly argument: string }
  | { readonly kind: 'session'; readonly session: CodexSessionReading };

function optionNamed(name: string, inResume: boolean): CodexOptionRow | undefined {
  return CODEX_OPTIONS.find((row) => row.names.includes(name) && (inResume || !row.resumeOnly));
}

function subcommandNamed(name: string): CodexSubcommandRow | undefined {
  return CODEX_SUBCOMMANDS.find(
    (row) =>
      row.name === name ||
      row.aliases.includes(name) ||
      (row.hiddenAliases !== undefined && Object.hasOwn(row.hiddenAliases, name)),
  );
}

/** clap reads a token that starts with `-` and has more after it as an option, never as a value. */
function looksLikeOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

function longestName(row: CodexOptionRow): string {
  return row.names[row.names.length - 1]!;
}

function listed(values: readonly string[]): string {
  return values.length > 1 ? `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}` : values.join('');
}

/**
 * Read a typed `codex` argv as clap does. clap's errors inside a session are the
 * reading's rejection; before a passthrough they are not, because a passthrough
 * runs as typed and codex then reports its own error.
 */
export function readCodexInvocation(argv: readonly string[]): CodexInvocationReading {
  let inResume = false;
  let literal = false;
  let clapError: { reason: string; argument: string } | undefined;
  const fail = (reason: string, argument: string): void => {
    clapError ??= { reason, argument };
  };
  let prompt: CodexPositional | undefined;
  const resumePositionals: CodexPositional[] = [];
  const options: CodexOptionUse[] = [];

  const use = (row: CodexOptionRow, token: string, index: number, values: readonly string[]): void => {
    if (!row.repeatable && options.some((seen) => seen.row === row)) {
      fail(`${longestName(row)} can be given only once`, token);
    }
    for (const value of values) {
      if (row.values && !row.values.includes(value)) fail(`${longestName(row)} takes ${listed(row.values)}`, token);
    }
    options.push({ row, token, index, values, inResume });
  };

  /** The values that follow an option typed without one; `index` is the option's own position. */
  const following = (row: CodexOptionRow, index: number): string[] => {
    const values: string[] = [];
    for (let next = index + 1; next < argv.length; next += 1) {
      const candidate = argv[next]!;
      if (looksLikeOption(candidate)) break;
      values.push(candidate);
      if (row.arity === 'value') break;
    }
    return values;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && looksLikeOption(token)) {
      if (token.startsWith('--')) {
        const equals = token.indexOf('=');
        const name = equals < 0 ? token : token.slice(0, equals);
        const row = optionNamed(name, inResume);
        // An unknown option's arity is unknown, so nothing after it can be read.
        if (!row) return { kind: 'rejected', reason: 'it is not an option codex documents', argument: token };
        if (row.class === 'help' || row.class === 'version') {
          return { kind: 'passthrough', passthrough: 'utility', reason: row.why };
        }
        if (row.arity === 'flag') {
          if (equals >= 0) fail(`${name} takes no value`, token);
          use(row, token, index, []);
          continue;
        }
        if (equals >= 0) {
          // An attached value is the whole of it: a variadic takes nothing more after `--image=a.png`.
          use(row, token, index, [token.slice(equals + 1)]);
          continue;
        }
        const values = following(row, index);
        if (values.length === 0) fail(`${name} needs a value`, token);
        use(row, token, index, values);
        index += values.length;
        continue;
      }
      // A short cluster: flags in order, and the first option that takes a value takes the rest of the token.
      for (let at = 1; at < token.length; at += 1) {
        const name = `-${token[at]}`;
        const row = optionNamed(name, inResume);
        if (!row) return { kind: 'rejected', reason: 'it is not an option codex documents', argument: token };
        if (row.class === 'help' || row.class === 'version') {
          return { kind: 'passthrough', passthrough: 'utility', reason: row.why };
        }
        if (row.arity === 'flag') {
          use(row, token, index, []);
          continue;
        }
        const attached = token.slice(at + 1);
        if (attached !== '') {
          use(row, token, index, [attached.startsWith('=') ? attached.slice(1) : attached]);
        } else {
          const values = following(row, index);
          if (values.length === 0) fail(`${longestName(row)} needs a value`, token);
          use(row, token, index, values);
          index += values.length;
        }
        break;
      }
      continue;
    }
    if (!literal && !inResume) {
      // clap matches a subcommand even after a prompt, and never after `--`.
      const subcommand = subcommandNamed(token);
      if (subcommand?.class === 'session') {
        inResume = true;
        continue;
      }
      if (subcommand) {
        const own = argv.slice(index + 1);
        const end = own.indexOf('--');
        const flags = end < 0 ? own : own.slice(0, end);
        if (flags.some((flag) => flag === '-h' || flag === '--help' || flag === '-V' || flag === '--version')) {
          return {
            kind: 'passthrough',
            passthrough: 'utility',
            reason: `codex prints the help or version of ${token}`,
          };
        }
        if (subcommand.class === 'rejected') return { kind: 'rejected', reason: subcommand.why, argument: token };
        return { kind: 'passthrough', passthrough: subcommand.class, reason: subcommand.why };
      }
    }
    if (inResume) {
      if (resumePositionals.length === 2) fail('resume takes a session id and a prompt', token);
      else resumePositionals.push({ value: token, index });
    } else if (prompt) {
      fail('codex takes one prompt', token);
    } else {
      prompt = { value: token, index };
    }
  }

  if (clapError) return { kind: 'rejected', ...clapError };
  return {
    kind: 'session',
    session: { resume: inResume, ...(prompt ? { prompt } : {}), resumePositionals, options },
  };
}
