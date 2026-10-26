import {
  readNativeInvocationArguments,
  type NativeInvocationCommand,
  type NativeInvocationGrammar,
  type NativeInvocationOption,
} from '@vibefield/puppeteer-core';

/**
 * Native help and parser evidence: __fixtures__/README.md, and the probes the
 * hidden rows cite under packages/surface/vendors/grok/probes/grok@1.0.70/
 * (`parse-probes.txt` names each alias's canonical option in clap's own parse
 * error; `completions.fish` lists every root option and its arity). Unknown
 * arity is a refusal.
 */
export const INVOCATION_GRAMMAR_VERSION = '1.0.70';

const NOT_PRESERVED = 'the managed launch cannot preserve this option';
const COMPAT_ALIAS = 'compat alias documented in the native help description; parse-probes.txt names its option';
const HEADLESS_ONLY = 'completions.fish lists it as a headless/daemon-only option the root help omits';
const CURSOR_WORKER = 'it runs this machine as a Cursor private worker whose agents do not live in this process';
const COMPUTER_HUB = 'it exposes this workspace to Computer Hub agents that do not live in this process';

/** A command row plus the probe that found it when the native help omits it. */
export interface GrokCommandRow extends NativeInvocationCommand {
  /** Present when the help does not list the command at all: the probe that found it. */
  readonly hidden?: string;
}

const OPTIONS = [
  {
    names: ['--reasoning-effort', '--effort'],
    arity: 'one',
    reason: 'the managed launch cannot preserve reasoning effort yet',
  },
  {
    names: ['--help', '-h'],
    arity: 'none',
    passthrough: 'utility',
  },
  {
    names: ['--version', '-v'],
    arity: 'none',
    passthrough: 'utility',
  },
  {
    names: ['--model', '-m'],
    arity: 'one',
    mapped: '--model',
  },
  {
    names: ['--permission-mode'],
    arity: 'one',
    mapped: '--permission-mode',
  },
  {
    names: ['--sandbox'],
    arity: 'one',
    mapped: '--sandbox',
  },
  {
    names: ['--continue', '-c'],
    arity: 'none',
    mapped: '--continue',
  },
  {
    names: ['--resume', '-r'],
    arity: 'optional',
    mapped: '--resume',
  },
  {
    names: ['--single', '-p'],
    arity: 'one',
    passthrough: 'one-shot',
  },
  {
    names: ['--prompt-file'],
    arity: 'one',
    passthrough: 'one-shot',
  },
  {
    names: ['--prompt-json'],
    arity: 'one',
    passthrough: 'one-shot',
  },
  {
    // A resumed session keeps the folders it was created with, and Grok's ACP
    // initialize advertises no additionalDirectories capability to carry them.
    names: ['--add-dir'],
    arity: 'one',
    reason: 'the managed launch cannot preserve extra working directories',
  },
  {
    names: ['--agent'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--agents'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--allow'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--cwd'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--debug-file'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--deny'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--disallowed-tools'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--json-schema'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--leader-socket'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--max-turns'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--output-format'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--rules'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--system-prompt-override'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--tools'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--worktree-ref', '--ref'],
    arity: 'one',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--always-approve'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--debug'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--disable-web-search'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--fork-session'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--fullscreen'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--include-partial-messages'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--minimal'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--no-alt-screen'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--no-plan'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--no-subagents'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--oauth'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--restore-code'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--verbatim'],
    arity: 'none',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--worktree', '-w'],
    arity: 'optional',
    reason: NOT_PRESERVED,
  },
  {
    names: ['--session-id', '-s'],
    arity: 'one',
    reason: 'the managed launch owns session identity and cannot carry this selector',
  },
  {
    names: ['--leader'],
    arity: 'none',
    reason: 'the managed launch owns the leader connection',
    hidden: 'adapter launch/tui.ts uses this native flag; completions.fish lists it',
  },
  // Aliases clap resolves to a public option. Each row classifies exactly as
  // the option parse-probes.txt names, and the census holds it to that row.
  {
    names: ['--print'],
    arity: 'one',
    passthrough: 'one-shot',
    hidden: 'docs.x.ai alias of -p; parse-probes.txt: `grok --print` requires a value for --single',
  },
  {
    names: ['--yolo', '--dangerously-skip-permissions'],
    arity: 'none',
    reason: NOT_PRESERVED,
    hidden: 'docs.x.ai aliases; parse-probes.txt: --always-approve refuses a value given to either',
  },
  {
    names: ['--append-system-prompt'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: 'docs.x.ai alias; parse-probes.txt: `grok --append-system-prompt` requires a value for --rules',
  },
  {
    names: ['--allowedTools'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: COMPAT_ALIAS,
  },
  {
    names: ['--allowed-tools'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: COMPAT_ALIAS,
  },
  {
    names: ['--disallowedTools'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: COMPAT_ALIAS,
  },
  {
    names: ['--system-prompt'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: COMPAT_ALIAS,
  },
  // Options 1.0.70 accepts for headless and daemon sessions only. An
  // interactive session cannot carry them; beside a one-shot they pass through.
  {
    // parse-probes.txt: its only value is `ask` (read-only questions and answers).
    names: ['--mode'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
  {
    names: ['--header'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
  {
    names: ['--harness'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
  {
    names: ['--conversation-history-file'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
  {
    names: ['--background-shell-timeout'],
    arity: 'one',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
  {
    names: ['--exclude-workspace-context'],
    arity: 'none',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
  {
    names: ['--endless-retries'],
    arity: 'none',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
  {
    names: ['--retry-all-inference-errors'],
    arity: 'none',
    reason: NOT_PRESERVED,
    hidden: HEADLESS_ONLY,
  },
] as const satisfies readonly NativeInvocationOption[];

/**
 * `grok leader` manages leader processes, except `leader worker`, which runs
 * the same Cursor private-worker commands as `grok worker`. The group's own
 * options change nothing a managed launch carries, so `mapped: null` consumes
 * them (and their values) and the subcommand decides.
 */
export const LEADER_GRAMMAR = {
  options: [
    { names: ['--help', '-h'], arity: 'none', passthrough: 'utility' },
    { names: ['--debug'], arity: 'none', mapped: null },
    { names: ['--debug-file'], arity: 'one', mapped: null },
    { names: ['--leader-socket'], arity: 'one', mapped: null },
  ],
  commands: [
    { names: ['list'], passthrough: 'utility' },
    { names: ['info'], passthrough: 'utility' },
    { names: ['kill'], passthrough: 'utility' },
    { names: ['help'], passthrough: 'utility' },
    { names: ['worker'], passthrough: 'elsewhere', reason: CURSOR_WORKER },
  ],
  defaultPassthrough: 'utility',
} as const satisfies NativeInvocationGrammar;

/**
 * Hidden `grok workspace` (completions.fish lists it; `grok workspace --help`
 * prints "Expose this workspace to the Computer Hub (via the leader)").
 * Starting, resuming, or restarting the exposure lets remote hub agents work
 * here through the leader, outside this process; the other subcommands pause,
 * stop, or report it. The group's own options consume their values as in
 * `leader`, and the subcommand decides.
 */
export const WORKSPACE_GRAMMAR = {
  options: [
    { names: ['--help', '-h'], arity: 'none', passthrough: 'utility' },
    { names: ['--debug'], arity: 'none', mapped: null },
    { names: ['--debug-file'], arity: 'one', mapped: null },
    { names: ['--leader-socket'], arity: 'one', mapped: null },
  ],
  commands: [
    { names: ['start'], passthrough: 'elsewhere', reason: COMPUTER_HUB },
    { names: ['resume'], passthrough: 'elsewhere', reason: COMPUTER_HUB },
    { names: ['restart'], passthrough: 'elsewhere', reason: COMPUTER_HUB },
    { names: ['pause'], passthrough: 'utility' },
    { names: ['stop'], passthrough: 'utility' },
    { names: ['status', 'list'], passthrough: 'utility' },
    { names: ['help'], passthrough: 'utility' },
  ],
  defaultPassthrough: 'utility',
} as const satisfies NativeInvocationGrammar;

/** One row per command in the native help, and the hidden ones clap still parses. */
export const GROK_COMMANDS: readonly GrokCommandRow[] = [
  { names: ['completions'], passthrough: 'utility' },
  { names: ['doctor'], passthrough: 'utility' },
  { names: ['du', 'disk-usage'], passthrough: 'utility' },
  { names: ['export'], passthrough: 'utility' },
  { names: ['help'], passthrough: 'utility' },
  { names: ['inspect'], passthrough: 'utility' },
  { names: ['leader'], grammar: LEADER_GRAMMAR },
  { names: ['login'], passthrough: 'utility' },
  { names: ['logout'], passthrough: 'utility' },
  { names: ['mcp'], passthrough: 'utility' },
  { names: ['memory'], passthrough: 'utility' },
  { names: ['models'], passthrough: 'utility' },
  { names: ['plugin'], passthrough: 'utility' },
  { names: ['sessions'], passthrough: 'utility' },
  { names: ['setup'], passthrough: 'utility' },
  { names: ['trace'], passthrough: 'utility' },
  { names: ['update'], passthrough: 'utility' },
  { names: ['usage'], passthrough: 'utility' },
  { names: ['version', 'v'], passthrough: 'utility' },
  { names: ['worktree'], passthrough: 'utility' },
  { names: ['clone'], passthrough: 'elsewhere' },
  { names: ['worker'], passthrough: 'elsewhere', reason: CURSOR_WORKER },
  {
    names: ['cursor-worker'],
    passthrough: 'elsewhere',
    reason: 'it registers this machine as a Cursor private worker through the leader',
    hidden:
      'probe: `grok cursor-worker --help` prints "Register this machine as a Cursor private worker (via the leader)"',
  },
  {
    names: ['workspace'],
    grammar: WORKSPACE_GRAMMAR,
    hidden: 'probe: `grok workspace --help` prints "Expose this workspace to the Computer Hub (via the leader)"',
  },
  { names: ['wrap'], passthrough: 'elsewhere' },
  { names: ['agent'], passthrough: 'elsewhere' },
  {
    names: ['dashboard'],
    reason: 'this native command starts an interactive session the managed launch cannot preserve',
  },
];

export const INVOCATION_GRAMMAR = {
  options: OPTIONS,
  commands: GROK_COMMANDS,
} as const satisfies NativeInvocationGrammar;

export const readInvocation = (argv: readonly string[]) => readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
