/**
 * Claude Code's command line as the installed CLI reads it: one declarative table and the one
 * reader that walks argv with it. The reader states what a typed `claude …` IS — a passthrough
 * (help, a management command, a one-shot, a session that lives elsewhere), a session the managed
 * launch cannot carry (a clause a person reads), or a session it runs with the person's own
 * arguments carried. What a host does with that is the host's policy.
 *
 * The CLI reads argv in two stages and so does this reader, in the CLI's own order. First its
 * entry looks at the raw argv before any parser runs: literal tokens, some only as the first
 * argument, some anywhere, some only before `--` ({@link CLAUDE_ENTRY_RULES},
 * {@link CLAUDE_SUBCOMMANDS}' `dispatch`). Then commander parses the rest (12.x semantics in this
 * build: options anywhere until `--`; unknown options refused; excess operands dropped; positional
 * options, so a subcommand selected as the first operand owns everything after it; subcommands
 * registered only when the argv does not ask for `-p`/`--print`).
 *
 * Every row is evidence-bound to one CLI version: the census test holds the table to the
 * captured `claude --help` in both directions. Evidence per row, and the probes behind the
 * classes: packages/surface/vendors/claude/findings.md §7 (2.1.283) with its 2.1.308 changes, and
 * probes/claude@2.1.308/invocation-grammar.json.
 */

/** The Claude Code version whose grammar this table is. */
export const CLAUDE_INVOCATION_GRAMMAR_VERSION = '2.1.308';

/**
 * Commander's arity, read from the help's usage column: `none` (a flag), `one` (`<value>`: always
 * the next token, even one that starts with `-`), `optional` (`[value]`: the next token unless it
 * looks like an option), `variadic` (`<values...>`: the next token, then every following token
 * until one looks like an option or is `--`).
 */
export type ClaudeOptionArity = 'none' | 'one' | 'optional' | 'variadic';

/**
 * What an option makes of a typed launch. `utility`, `elsewhere` and `one-shot` are passthrough
 * kinds; `print-only` is refused unless `-p` makes the invocation a one-shot; `rejected` is a
 * session option the managed launch cannot carry; `mapped` becomes a managed option; `carried`
 * rides the managed launch verbatim.
 */
export type ClaudeOptionClass = 'utility' | 'elsewhere' | 'one-shot' | 'print-only' | 'rejected' | 'mapped' | 'carried';

/** The managed option a mapped row becomes. `resume` covers every resume form. */
export type ClaudeMappedOption = 'model' | 'effort' | 'permissionMode' | 'settingSources' | 'resume' | 'title';

export interface ClaudeOptionRow {
  /** Every spelling commander matches, as the help lists them. */
  readonly names: readonly string[];
  readonly arity: ClaudeOptionArity;
  readonly class: ClaudeOptionClass;
  /**
   * The clause this row answers with when it decides the invocation (a person reads a rejected
   * one in their terminal), or, for a mapped or carried row, what the option is.
   */
  readonly why: string;
  readonly maps?: ClaudeMappedOption;
  /** The values commander accepts when it validates them while parsing. */
  readonly choices?: readonly string[];
  /** Present only when the help does not list the option: the evidence that the CLI accepts it. */
  readonly hidden?: string;
  /** Commander keeps its help option apart from the others: a whole token only, never a cluster's head. */
  readonly wholeTokenOnly?: true;
  /** A session given this option reads no settings files, so no status line in them may be delegated to. */
  readonly readsNoSettingsFiles?: true;
}

/**
 * How the CLI reaches a subcommand: `command` — commander's first operand, when the argv does not
 * ask for print mode; `first-argument` — the entry's own dispatch, only as argv[0];
 * `after-skip-permission-flags` — the entry's own dispatch, as the first argument after any
 * `--dangerously-skip-permissions` / `--allow-dangerously-skip-permissions`; `background-verb` —
 * the entry's background-verb index: the first operand, always as argv[0], and behind other tokens
 * only after safe root options and before a job id (`backgroundVerbIndex`).
 */
export type ClaudeSubcommandDispatch = 'command' | 'first-argument' | 'after-skip-permission-flags' | 'background-verb';

export interface ClaudeSubcommandRow {
  /** The name, then its aliases. */
  readonly names: readonly string[];
  readonly class: 'utility' | 'elsewhere';
  readonly why: string;
  readonly dispatch: readonly ClaudeSubcommandDispatch[];
  /** Present only when the help does not list the subcommand: the evidence that the CLI accepts it. */
  readonly hidden?: string;
}

const SESSION_ID_OWNED = 'the managed launch gives the session its id itself';
const HOOKS_OFF = 'it turns off the hooks a managed session is observed through';
const PRINT_ONLY = 'it only works with -p/--print; an interactive session does not take it';

/** Every option the root command accepts at {@link CLAUDE_INVOCATION_GRAMMAR_VERSION}, in the help's order. */
export const CLAUDE_OPTIONS: readonly ClaudeOptionRow[] = [
  { names: ['--add-dir'], arity: 'variadic', class: 'carried', why: 'more directories the tools may reach' },
  { names: ['--agent'], arity: 'one', class: 'carried', why: 'the agent the session runs as' },
  { names: ['--agents'], arity: 'one', class: 'carried', why: 'custom agents for the session' },
  {
    names: ['--allow-dangerously-skip-permissions'],
    arity: 'none',
    class: 'carried',
    why: 'makes the bypass mode available without starting in it',
  },
  { names: ['--allowedTools', '--allowed-tools'], arity: 'variadic', class: 'carried', why: 'tools allowed' },
  { names: ['--append-system-prompt'], arity: 'one', class: 'carried', why: 'appended to the system prompt' },
  { names: ['--autocompact'], arity: 'one', class: 'carried', why: 'the auto-compact window' },
  { names: ['--ax-screen-reader'], arity: 'none', class: 'carried', why: 'screen-reader friendly rendering' },
  {
    names: ['--bg', '--background'],
    arity: 'none',
    class: 'elsewhere',
    why: 'the session starts in the background, not in this terminal',
  },
  { names: ['--bare'], arity: 'none', class: 'rejected', why: HOOKS_OFF },
  { names: ['--betas'], arity: 'variadic', class: 'carried', why: 'API beta headers' },
  { names: ['--brief'], arity: 'none', class: 'carried', why: 'enables the SendUserMessage tool' },
  { names: ['--chrome'], arity: 'none', class: 'carried', why: 'the Claude in Chrome integration' },
  { names: ['--cloud'], arity: 'optional', class: 'elsewhere', why: 'the session runs in the cloud' },
  {
    names: ['-c', '--continue'],
    arity: 'none',
    class: 'mapped',
    maps: 'resume',
    why: 'continues the latest conversation',
  },
  {
    names: ['--dangerously-skip-permissions'],
    arity: 'none',
    class: 'carried',
    why: 'the bypass mode; Claude puts it before any --permission-mode',
  },
  { names: ['-d', '--debug'], arity: 'optional', class: 'carried', why: 'debug mode and its filter' },
  { names: ['--debug-file'], arity: 'one', class: 'carried', why: 'where debug logs go' },
  {
    names: ['--desktop'],
    arity: 'none',
    class: 'elsewhere',
    why: 'the session opens in the Claude Desktop app, not in this terminal',
  },
  { names: ['--disable-slash-commands'], arity: 'none', class: 'carried', why: 'disables skills' },
  { names: ['--disallowedTools', '--disallowed-tools'], arity: 'variadic', class: 'carried', why: 'tools denied' },
  { names: ['--effort'], arity: 'one', class: 'mapped', maps: 'effort', why: 'the effort level' },
  {
    names: ['--environment'],
    arity: 'one',
    class: 'elsewhere',
    why: 'the session runs in a cloud environment',
  },
  {
    names: ['--exclude-dynamic-system-prompt-sections'],
    arity: 'none',
    class: 'carried',
    why: 'moves per-machine sections out of the system prompt',
  },
  { names: ['--fallback-model'], arity: 'one', class: 'carried', why: 'models to fall back to' },
  { names: ['--file'], arity: 'variadic', class: 'carried', why: 'files downloaded at startup' },
  {
    names: ['--fork-session'],
    arity: 'none',
    class: 'rejected',
    why: 'it gives the resumed conversation a new session id, and the managed launch owns the session id',
  },
  { names: ['--forward-subagent-text'], arity: 'none', class: 'print-only', why: PRINT_ONLY },
  { names: ['--from-pr'], arity: 'optional', class: 'mapped', maps: 'resume', why: 'resumes the session of a PR' },
  { names: ['-h', '--help'], arity: 'none', class: 'utility', why: 'it prints help', wholeTokenOnly: true },
  { names: ['--ide'], arity: 'none', class: 'carried', why: 'connects to an IDE' },
  { names: ['--include-hook-events'], arity: 'none', class: 'print-only', why: PRINT_ONLY },
  { names: ['--include-partial-messages'], arity: 'none', class: 'print-only', why: PRINT_ONLY },
  {
    names: ['--input-format'],
    arity: 'one',
    class: 'print-only',
    why: PRINT_ONLY,
    choices: ['text', 'stream-json'],
  },
  { names: ['--json-schema'], arity: 'one', class: 'print-only', why: PRINT_ONLY },
  { names: ['--max-budget-usd'], arity: 'one', class: 'print-only', why: PRINT_ONLY },
  { names: ['--mcp-config'], arity: 'variadic', class: 'carried', why: 'MCP servers for the session' },
  { names: ['--model'], arity: 'one', class: 'mapped', maps: 'model', why: 'the model' },
  {
    names: ['-n', '--name'],
    arity: 'one',
    class: 'mapped',
    maps: 'title',
    why: "the session's name; it wins over the host's title",
  },
  { names: ['--no-chrome'], arity: 'none', class: 'carried', why: 'disables the Claude in Chrome integration' },
  { names: ['--no-session-persistence'], arity: 'none', class: 'print-only', why: PRINT_ONLY },
  {
    names: ['--output-format'],
    arity: 'one',
    class: 'print-only',
    why: PRINT_ONLY,
    choices: ['text', 'json', 'stream-json'],
  },
  {
    names: ['--permission-mode'],
    arity: 'one',
    class: 'mapped',
    maps: 'permissionMode',
    why: 'the permission mode',
    // The help lists `manual` where the parser also takes `default`, its former name.
    choices: ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'manual', 'plan'],
  },
  {
    names: ['--permission-prompts'],
    arity: 'one',
    class: 'print-only',
    why: PRINT_ONLY,
    choices: ['host', 'none'],
  },
  { names: ['--plugin-dir'], arity: 'one', class: 'carried', why: 'a plugin for this session' },
  { names: ['--plugin-url'], arity: 'one', class: 'carried', why: 'a plugin fetched for this session' },
  { names: ['-p', '--print'], arity: 'none', class: 'one-shot', why: 'it prints one response and exits' },
  {
    names: ['--prompt-suggestions'],
    arity: 'optional',
    class: 'print-only',
    why: PRINT_ONLY,
    choices: ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'],
  },
  { names: ['--remote-control'], arity: 'optional', class: 'carried', why: 'Remote Control for this session' },
  {
    names: ['--remote-control-session-name-prefix'],
    arity: 'one',
    class: 'carried',
    why: 'the Remote Control session name prefix',
  },
  { names: ['--replay-user-messages'], arity: 'none', class: 'print-only', why: PRINT_ONLY },
  {
    names: ['--restricted'],
    arity: 'none',
    class: 'carried',
    why: 'restricted mode; it keeps --settings, so the managed hooks still fire',
    readsNoSettingsFiles: true,
  },
  { names: ['-r', '--resume'], arity: 'optional', class: 'mapped', maps: 'resume', why: 'resumes a conversation' },
  { names: ['--safe-mode'], arity: 'none', class: 'rejected', why: HOOKS_OFF },
  { names: ['--session-id'], arity: 'one', class: 'rejected', why: SESSION_ID_OWNED },
  { names: ['--setting-sources'], arity: 'one', class: 'mapped', maps: 'settingSources', why: 'the settings layers' },
  {
    names: ['--settings'],
    arity: 'one',
    class: 'rejected',
    why: 'the managed launch passes its own --settings, and a second one would replace it',
  },
  { names: ['--strict-mcp-config'], arity: 'none', class: 'carried', why: 'only the --mcp-config servers' },
  { names: ['--system-prompt'], arity: 'one', class: 'carried', why: 'the system prompt' },
  {
    names: ['--system-prompt-snapshot'],
    arity: 'one',
    class: 'carried',
    why: 'whether the system prompt is recorded',
    choices: ['on', 'off'],
  },
  {
    names: ['--teleport'],
    arity: 'optional',
    class: 'rejected',
    why: "it brings a cloud session into this terminal under that session's own id, which the managed launch cannot own",
  },
  { names: ['--tmux'], arity: 'none', class: 'rejected', why: 'it only works together with --worktree' },
  { names: ['--tools'], arity: 'variadic', class: 'carried', why: 'the built-in tools available' },
  { names: ['--verbose'], arity: 'none', class: 'carried', why: 'verbose output' },
  { names: ['-v', '--version'], arity: 'none', class: 'utility', why: 'it prints the version' },
  {
    names: ['-w', '--worktree'],
    arity: 'optional',
    class: 'rejected',
    why: 'it moves the session into a new worktree, away from the directory this terminal is managed in',
  },
  // Accepted by the CLI but not listed by its help.
  {
    names: ['-d2e', '--debug-to-stderr'],
    arity: 'none',
    class: 'carried',
    why: 'debug mode, to stderr',
    hidden: 'a hidden root option, "(deprecated) Enable debug mode (to stderr)"; parse probe',
  },
  {
    names: ['--system-prompt-file'],
    arity: 'one',
    class: 'carried',
    why: 'the system prompt, from a file',
    hidden: "named by the help's own --bare text; a hidden root option; parse probe",
  },
  {
    names: ['--append-system-prompt-file'],
    arity: 'one',
    class: 'carried',
    why: 'appended to the system prompt, from a file',
    hidden: "named by the help's own --bare text; a hidden root option; parse probe",
  },
  {
    names: ['--max-turns'],
    arity: 'one',
    class: 'print-only',
    why: PRINT_ONLY,
    hidden: 'a hidden root option, "(only works with --print)"; parse probe',
  },
  {
    names: ['--permission-prompt-tool'],
    arity: 'one',
    class: 'print-only',
    why: PRINT_ONLY,
    hidden:
      'named by the help\'s own --permission-prompts text; a hidden root option, "(only works with --print)"; parse probe',
  },
  {
    names: ['--remote'],
    arity: 'optional',
    class: 'elsewhere',
    why: 'the session runs in the cloud',
    hidden: 'a hidden root option, "Deprecated alias for --cloud"; parse probe',
  },
  {
    names: ['--pool'],
    arity: 'one',
    class: 'elsewhere',
    why: 'the session runs in a cloud environment',
    hidden: 'a hidden root option, "Deprecated alias for --environment"; parse probe',
  },
  {
    names: ['--rc'],
    arity: 'optional',
    class: 'carried',
    why: 'Remote Control for this session',
    hidden: 'a hidden root option, "Alias for --remote-control"; parse probe',
  },
  {
    names: ['--client-data-url'],
    arity: 'one',
    class: 'carried',
    why: 'a signed configuration document',
    hidden: 'listed until 2.1.283; still a root option taking one value (static client-data-url-option; parse probe)',
  },
];

const BACKGROUND_HOUSEKEEPING = 'it manages background sessions and starts none here';

/** Every subcommand the CLI dispatches at {@link CLAUDE_INVOCATION_GRAMMAR_VERSION}, in the help's order. */
export const CLAUDE_SUBCOMMANDS: readonly ClaudeSubcommandRow[] = [
  { names: ['agents'], class: 'utility', why: BACKGROUND_HOUSEKEEPING, dispatch: ['command'] },
  {
    names: ['attach'],
    class: 'elsewhere',
    why: 'it opens a background session that runs outside this terminal',
    dispatch: ['background-verb'],
  },
  { names: ['auth'], class: 'utility', why: 'it manages authentication', dispatch: ['command'] },
  { names: ['auto-mode'], class: 'utility', why: 'it manages the auto mode configuration', dispatch: ['command'] },
  { names: ['doctor'], class: 'utility', why: 'it checks the installation', dispatch: ['command'] },
  { names: ['gateway'], class: 'utility', why: 'it runs the enterprise gateway', dispatch: ['command'] },
  // Bare, or with only its own choices, `import` is rewritten into a session that runs /import
  // before the parser sees it (CLAUDE_IMPORT_REWRITE); any other form reaches this subcommand.
  { names: ['import'], class: 'utility', why: 'it prints how to import configuration', dispatch: ['command'] },
  { names: ['install'], class: 'utility', why: 'it installs Claude Code', dispatch: ['command'] },
  { names: ['logs'], class: 'utility', why: BACKGROUND_HOUSEKEEPING, dispatch: ['background-verb'] },
  { names: ['mcp'], class: 'utility', why: 'it manages MCP servers', dispatch: ['command'] },
  { names: ['plugin', 'plugins'], class: 'utility', why: 'it manages plugins', dispatch: ['command'] },
  // It asks before it deletes (unless -y), and every token after `--` is its [path]: as a prompt
  // after the managed launch's `--`, `purge` would run the deletion instead of a session.
  {
    names: ['purge'],
    class: 'utility',
    why: "it deletes a project's Claude Code state and starts no session",
    dispatch: ['command'],
  },
  { names: ['respawn'], class: 'utility', why: BACKGROUND_HOUSEKEEPING, dispatch: ['background-verb'] },
  { names: ['rm'], class: 'utility', why: BACKGROUND_HOUSEKEEPING, dispatch: ['background-verb'] },
  { names: ['setup-token'], class: 'utility', why: 'it sets up a token', dispatch: ['command'] },
  { names: ['stop', 'kill'], class: 'utility', why: BACKGROUND_HOUSEKEEPING, dispatch: ['background-verb'] },
  { names: ['ultrareview'], class: 'elsewhere', why: 'the review runs in the cloud', dispatch: ['command'] },
  { names: ['update', 'upgrade'], class: 'utility', why: 'it updates Claude Code', dispatch: ['command'] },
  // Accepted by the CLI but not listed by its help.
  {
    names: ['remote-control', 'rc'],
    class: 'elsewhere',
    why: 'Remote Control runs its sessions outside this terminal',
    dispatch: ['first-argument', 'command'],
    hidden:
      'a hidden subcommand and an entry dispatch; the CLI says root options are "not carried over to the sessions Remote Control starts"',
  },
  {
    names: ['remote'],
    class: 'elsewhere',
    why: 'Remote Control runs its sessions outside this terminal',
    dispatch: ['first-argument'],
    hidden: 'an entry dispatch to Remote Control, as the first argument only',
  },
  {
    names: ['sync'],
    class: 'elsewhere',
    why: 'Remote Control runs its sessions outside this terminal',
    dispatch: ['first-argument'],
    hidden: 'an entry dispatch to Remote Control, as the first argument only',
  },
  {
    names: ['bridge'],
    class: 'elsewhere',
    why: 'Remote Control runs its sessions outside this terminal',
    dispatch: ['first-argument'],
    hidden: 'an entry dispatch to Remote Control, as the first argument only',
  },
  {
    names: ['self-hosted-runner'],
    class: 'elsewhere',
    why: 'the runner runs cloud sessions outside this terminal',
    dispatch: ['first-argument'],
    hidden:
      'an entry dispatch, as the first argument only; the runner starts its sessions as --print --sdk-url children',
  },
  {
    names: ['daemon'],
    class: 'utility',
    why: 'it manages the background-session daemon',
    dispatch: ['after-skip-permission-flags'],
    hidden: 'an entry dispatch (run, stop, status, install, uninstall)',
  },
  {
    names: ['sandbox'],
    class: 'utility',
    why: 'it manages the sandbox',
    dispatch: ['command'],
    hidden: 'a hidden subcommand (install, status)',
  },
  {
    names: ['import-conversations'],
    class: 'utility',
    why: 'it imports conversations into the archive',
    dispatch: ['command'],
    hidden: 'a hidden subcommand',
  },
  {
    names: ['project'],
    class: 'utility',
    why: 'it manages project state',
    dispatch: ['command'],
    hidden:
      'listed until 2.1.283; registered hidden, "`claude project purge` is now `claude purge`" (static project-purge-alias; parse probe)',
  },
  ...[
    'edit-hook',
    'edit-permission-rules',
    'edit-memory-settings',
    'edit-skill-overrides',
    'edit-sandbox-settings',
    'edit-chrome-settings',
    'design-login',
    // 2.1.308: requires --json and reads its request on stdin (static drop-worktree-registrations; R07).
    'drop-worktree-registrations',
  ].map((name): ClaudeSubcommandRow => ({
    names: [name],
    class: 'utility',
    why: 'the VS Code extension runs it; it starts no session',
    dispatch: ['command'],
    hidden: 'a hidden subcommand "used by the VS Code extension"',
  })),
];

/**
 * The entry's checks on the raw argv, before its parser runs. `argvIs`: the whole argv is one of
 * these; `firstTwo`: argv[0] and argv[1]; `subcommand`: a {@link CLAUDE_SUBCOMMANDS} row with that
 * dispatch, at its position (the row's class and why answer); `anywhere`: some token equals one of
 * these, `--` or not (`also`: and some token equals or starts with one of those too); `withNext`: the
 * token appears with a token after it.
 */
export type ClaudeEntryMatch =
  | { readonly argvIs: readonly (readonly string[])[] }
  | { readonly firstTwo: readonly [string, string] }
  | { readonly subcommand: Exclude<ClaudeSubcommandDispatch, 'command'> }
  | {
      readonly anywhere: readonly string[];
      readonly also?: { readonly tokens: readonly string[]; readonly prefixes: readonly string[] };
    }
  | { readonly withNext: string };

export interface ClaudeEntryRule {
  readonly id: string;
  readonly match: ClaudeEntryMatch;
  /** Absent for a subcommand match: the subcommand's row answers. */
  readonly class?: 'utility' | 'elsewhere' | 'rejected';
  readonly why?: string;
}

/** In the CLI's own order: the first that matches decides. */
export const CLAUDE_ENTRY_RULES: readonly ClaudeEntryRule[] = [
  {
    id: 'version-alone',
    match: {
      argvIs: ['--version', '-v', '-V'].flatMap((flag) => [[flag], [flag, '--verbose']]),
    },
    class: 'utility',
    why: 'it prints the version',
  },
  { id: 'plugin-test', match: { firstTwo: ['plugin', 'test'] }, class: 'utility', why: 'it tests a plugin' },
  { id: 'first-argument', match: { subcommand: 'first-argument' } },
  { id: 'after-skip-permission-flags', match: { subcommand: 'after-skip-permission-flags' } },
  // A background verb and --bg both take the background path; a verb wins (2.1.285+).
  { id: 'background-verb', match: { subcommand: 'background-verb' } },
  {
    id: 'background',
    // Anywhere, `--` or not. 2.1.299+ counts it only as an option token before `--` (static
    // background-flag-value-aware: `-- --bg` is a prompt there), but 2.1.283 matched it anywhere,
    // and the reader does not know which release a typed argv will run: reading `-- --bg` as a
    // session would hand an older CLI a managed launch that leaves the terminal. A passthrough is
    // safe on every release; on 2.1.308 it only means the CLI runs the typed argv unmanaged.
    match: { anywhere: ['--bg', '--background'] },
    class: 'elsewhere',
    why: 'the session starts in the background, not in this terminal',
  },
  {
    id: 'tmux-worktree',
    match: {
      anywhere: ['--tmux', '--tmux=classic'],
      also: { tokens: ['-w', '--worktree'], prefixes: ['--worktree='] },
    },
    class: 'elsewhere',
    why: 'the session runs in a tmux session the CLI creates for the worktree',
  },
  {
    id: 'update-alone',
    match: { argvIs: [['--update'], ['--upgrade']] },
    class: 'utility',
    why: 'it updates Claude Code',
  },
  {
    id: 'deep-link',
    match: { withNext: '--handle-uri' },
    class: 'rejected',
    why: 'it opens a deep link, which this version of the Claude adapter does not know',
  },
];

/**
 * Checked on the raw argv before the first `--`, whatever the parser makes of the token (even the
 * value of another option): the CLI turns hooks off from them before it parses.
 */
export const CLAUDE_BLINDING_TOKENS: readonly string[] = ['--bare', '--safe-mode'];

/**
 * An environment variable that changes what a session IS, as the flag it stands for does. A
 * typed `claude` inherits the whole shell environment at exec, so these are read too: the
 * provider forwards exactly them to the normalizer (with the config root).
 */
export interface ClaudeEnvironmentSwitch {
  readonly name: string;
  /** The flag the variable does the work of. */
  readonly flag: string;
  readonly class: 'rejected' | 'carried';
  /** For a rejected switch, the clause a person reads; for a carried one, what it does. */
  readonly why: string;
  readonly readsNoSettingsFiles?: true;
}

/**
 * Each is read through one parser, whatever reads it (findings.md §7.5; re-run live on 2.1.308,
 * probes/claude@2.1.308/hook-switches.json): CLAUDE_CODE_SIMPLE does what --bare does (no hook
 * fires: F01), CLAUDE_CODE_SAFE_MODE what --safe-mode does (none fires: F03), and
 * CLAUDE_CODE_RESTRICTED what --restricted does (the managed hooks fire, the person's settings
 * files are not read: F04). 2.1.308's CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG blinds nothing: the
 * managed `--settings` hooks fire and a managed HTTP 500 stays non-blocking (F12–F14).
 */
export const CLAUDE_ENVIRONMENT_SWITCHES: readonly ClaudeEnvironmentSwitch[] = [
  { name: 'CLAUDE_CODE_SIMPLE', flag: '--bare', class: 'rejected', why: HOOKS_OFF },
  { name: 'CLAUDE_CODE_SAFE_MODE', flag: '--safe-mode', class: 'rejected', why: HOOKS_OFF },
  {
    name: 'CLAUDE_CODE_RESTRICTED',
    flag: '--restricted',
    class: 'carried',
    why: 'restricted mode; it keeps --settings, so the managed hooks still fire',
    readsNoSettingsFiles: true,
  },
];

/** The CLI's own reading of a switch: on for 1, true, yes or on, in any case, trimmed; off for anything else. */
export function claudeSwitchIsOn(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim());
}

/** What the switches in a launch's environment make of an interactive session. */
export interface ClaudeEnvironmentReading {
  /** The first switch that is on and blinds, named as the person set it (`CLAUDE_CODE_SIMPLE=1`). */
  readonly refusal?: { readonly reason: string; readonly argument: string };
  readonly readsNoSettingsFiles: boolean;
}

export function readClaudeEnvironment(environment: Readonly<Record<string, string>>): ClaudeEnvironmentReading {
  let readsNoSettingsFiles = false;
  for (const row of CLAUDE_ENVIRONMENT_SWITCHES) {
    const value = environment[row.name];
    if (!claudeSwitchIsOn(value)) continue;
    if (row.class === 'rejected') {
      return { refusal: { reason: row.why, argument: `${row.name}=${value}` }, readsNoSettingsFiles };
    }
    if (row.readsNoSettingsFiles === true) readsNoSettingsFiles = true;
  }
  return { readsNoSettingsFiles };
}

/**
 * `claude [options] import [codex|gemini|cursor] [--dry-run] [--yes[=<digest>]]` is rewritten to
 * `claude [options] -- "/import …"` before the parser runs: an interactive session that runs
 * /import (when the CLI has the feature on; otherwise it exits with an error).
 */
export const CLAUDE_IMPORT_REWRITE = {
  token: 'import',
  /** None of these may come before it. */
  prefixExcludes: ['--', '-h', '--help', '-v', '-V', '--version'],
  /** Everything after it must be one of these. */
  rest: ['codex', 'gemini', 'cursor', '--dry-run', '--yes'],
  restPrefixes: ['--yes='],
} as const;

/** What the reader makes of a typed argv. */
export type ClaudeInvocationReading =
  | { readonly status: 'passthrough'; readonly kind: 'utility' | 'elsewhere' | 'one-shot'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string; readonly argument?: string }
  | ({ readonly status: 'accepted' } & ClaudeSessionReading);

/** An interactive session here: what is mapped to managed options, and what rides verbatim. */
export interface ClaudeSessionReading {
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly settingSources?: readonly string[];
  /** The person's resume form, as typed (`-c`, `-r [value]`, `--from-pr [value]`, `--resume=…`). */
  readonly resumeInvocation?: readonly string[];
  /** Set when `resumeInvocation` names a conversation id: the managed launch resumes it by id. */
  readonly resume?: string;
  readonly title?: string;
  /** Every carried option and its values, verbatim and in the person's order. */
  readonly carriedArgs: readonly string[];
  /** The operands as typed: the prompt, then any the CLI drops. */
  readonly prompt: readonly string[];
  /** The first carried option that is not the managed launch's own mapping (for implementations that take none). */
  readonly firstCarried?: string;
  readonly readsNoSettingsFiles: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SETTING_SOURCES = new Set(['user', 'project', 'local']);
const SKIP_PERMISSION_FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);

const OPTIONS_BY_NAME = new Map(CLAUDE_OPTIONS.flatMap((row) => row.names.map((name) => [name, row] as const)));
const SUBCOMMANDS_BY_NAME = new Map(CLAUDE_SUBCOMMANDS.flatMap((row) => row.names.map((name) => [name, row] as const)));

/** Commander's test for a token that is an option: a lone `-` is an operand. */
function looksLikeOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

function quoted(token: string): string {
  return `\`${token}\``;
}

/**
 * The index of the last token the option at `index` takes (itself when it takes none), by the
 * table's arity for a whole token; a token with no row takes nothing.
 */
function lastValueIndex(argv: readonly string[], index: number): number {
  const row = OPTIONS_BY_NAME.get(argv[index]!);
  if (row === undefined || row.arity === 'none') return index;
  const next = argv[index + 1];
  if (row.arity === 'optional') return next !== undefined && !looksLikeOption(next) ? index + 1 : index;
  let last = index + 1;
  if (row.arity === 'variadic') {
    while (argv[last + 1] !== undefined && !looksLikeOption(argv[last + 1]!)) last += 1;
  }
  return last;
}

/** The CLI's first operand: the first token that is neither an option nor an option's value, or the one after `--`. */
function firstOperandIndex(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index = lastValueIndex(argv, index) + 1) {
    const token = argv[index]!;
    if (token === '--') return index + 1 < argv.length ? index + 1 : -1;
    if (!looksLikeOption(token)) return index;
  }
  return -1;
}

/** A job id the CLI takes as naming a background session behind root options. */
const BACKGROUND_JOB_ID = /^[a-f0-9]{8}$/u;
/** Before a background verb, these make it a prompt: print, background, help and version. */
const BACKGROUND_VERB_BREAKERS = new Set([
  '-p',
  '--print',
  '--bg',
  '--background',
  '--routine',
  '-h',
  '--help',
  '-v',
  '-V',
  '--version',
]);

/**
 * A root option a background verb may follow: any row's whole token, or `--name=value` for a row
 * that takes a value — except the breakers, `--routine=…`, and short clusters (`-cd`, `-nfoo`).
 */
function backgroundSafeRootOption(token: string): boolean {
  if (BACKGROUND_VERB_BREAKERS.has(token) || token.startsWith('--routine=') || /^-[A-Za-z]{2,}$/u.test(token)) {
    return false;
  }
  if (OPTIONS_BY_NAME.has(token)) return true;
  const equals = token.indexOf('=');
  const row = equals === -1 ? undefined : OPTIONS_BY_NAME.get(token.slice(0, equals));
  return row !== undefined && row.arity !== 'none';
}

/**
 * The entry's background-verb index (2.1.285+, probes R01–R03): a `background-verb` row as the
 * first operand. As argv[0] it always dispatches; behind other tokens only when the verb does not
 * directly follow `--`, the token after it is an 8-hex job id (or `respawn --all`), and every token
 * before it is a safe root option. Otherwise it is a prompt. Inside a background session
 * (`CLAUDE_CODE_SESSION_KIND=bg`) the CLI dispatches only argv[0]; the reader does not see that
 * variable and reads the verb as dispatched — a passthrough, the safe direction.
 */
function backgroundVerbIndex(argv: readonly string[]): number {
  const index = firstOperandIndex(argv);
  const row = index === -1 ? undefined : SUBCOMMANDS_BY_NAME.get(argv[index]!);
  if (!row?.dispatch.includes('background-verb')) return -1;
  if (index === 0) return 0;
  if (argv[index - 1] === '--') return -1;
  const next = argv[index + 1];
  if (next === undefined || !(BACKGROUND_JOB_ID.test(next) || (argv[index] === 'respawn' && next === '--all'))) {
    return -1;
  }
  for (let position = 0; position < index; position = lastValueIndex(argv, position) + 1) {
    if (!backgroundSafeRootOption(argv[position]!)) return -1;
  }
  return index;
}

/** The reading one entry rule gives the raw argv, or `undefined` when it does not match. */
function entryReading(rule: ClaudeEntryRule, argv: readonly string[]): ClaudeInvocationReading | undefined {
  const match = rule.match;
  if ('subcommand' in match) {
    const position =
      match.subcommand === 'first-argument'
        ? argv[0]
        : match.subcommand === 'background-verb'
          ? argv[backgroundVerbIndex(argv)]
          : argv.find((token) => !SKIP_PERMISSION_FLAGS.has(token));
    const row = position === undefined ? undefined : SUBCOMMANDS_BY_NAME.get(position);
    return row?.dispatch.includes(match.subcommand) ? passthrough(row.class, row.why) : undefined;
  }
  let matched: boolean;
  if ('argvIs' in match) {
    matched = match.argvIs.some(
      (shape) => shape.length === argv.length && shape.every((token, index) => argv[index] === token),
    );
  } else if ('firstTwo' in match) {
    matched = argv[0] === match.firstTwo[0] && argv[1] === match.firstTwo[1];
  } else if ('withNext' in match) {
    const index = argv.indexOf(match.withNext);
    matched = index !== -1 && argv[index + 1] !== undefined;
  } else {
    const also = match.also;
    matched =
      argv.some((token) => match.anywhere.includes(token)) &&
      (also === undefined ||
        argv.some((token) => also.tokens.includes(token) || also.prefixes.some((prefix) => token.startsWith(prefix))));
  }
  if (!matched) return undefined;
  if (rule.class === undefined || rule.why === undefined) {
    throw new Error(`Claude entry rule ${rule.id} answers with no class of its own`);
  }
  if (rule.class !== 'rejected') return passthrough(rule.class, rule.why);
  return { status: 'rejected', reason: rule.why, ...('withNext' in match ? { argument: match.withNext } : {}) };
}

/** The entry's dispatch before its parser: the first rule that matches. */
function entryDispatch(argv: readonly string[]): ClaudeInvocationReading | undefined {
  for (const rule of CLAUDE_ENTRY_RULES) {
    const reading = entryReading(rule, argv);
    if (reading !== undefined) return reading;
  }
  return undefined;
}

function passthrough(kind: 'utility' | 'elsewhere' | 'one-shot', reason: string): ClaudeInvocationReading {
  return { status: 'passthrough', kind, reason };
}

/** The CLI's own import rewrite, applied to the raw argv; `undefined` when it does not apply. */
function importRewrite(argv: readonly string[]): readonly string[] | undefined {
  const index = argv.indexOf(CLAUDE_IMPORT_REWRITE.token);
  if (index === -1) return undefined;
  const prefix = argv.slice(0, index);
  const rest = argv.slice(index + 1);
  if (prefix.some((token) => (CLAUDE_IMPORT_REWRITE.prefixExcludes as readonly string[]).includes(token))) {
    return undefined;
  }
  if (prefix.length > 0 && rest.length === 0) return undefined;
  if (!prefix.every((token, position) => token.startsWith('-') || prefix[position - 1]?.startsWith('-')))
    return undefined;
  const allowed = (token: string) =>
    (CLAUDE_IMPORT_REWRITE.rest as readonly string[]).includes(token) ||
    CLAUDE_IMPORT_REWRITE.restPrefixes.some((restPrefix) => token.startsWith(restPrefix));
  if (!rest.every(allowed)) return undefined;
  return [...prefix, '--', ['/import', ...rest].join(' ')];
}

/**
 * Whether the argv asks for print mode the way the CLI decides it before registering subcommands:
 * an exact `-p`/`--print` token, before `--`, that is not an option's value (a value is skipped by
 * the same arities the parser uses; clusters and `--flag=value` tokens are not split). The same
 * scan finds a `cc://` address, which registers subcommands even in print mode.
 */
function scanBeforeParse(argv: readonly string[]): { print: boolean; connect: boolean } {
  let print = false;
  let connect = false;
  for (let index = 0; index < argv.length; index = lastValueIndex(argv, index) + 1) {
    const token = argv[index]!;
    if (token === '--') break;
    if (token === '-p' || token === '--print') print = true;
    if (token.startsWith('cc://') || token.startsWith('cc+unix://')) connect = true;
  }
  return { print, connect };
}

interface Refusal {
  readonly reason: string;
  readonly argument: string;
}

/** What one option token took: the tokens as typed, the spelling used, and the value when it has one. */
interface Taken {
  readonly tokens: readonly string[];
  readonly spelling: string;
  readonly value?: string | undefined;
}

/** Commander's parse of the root command, with the table's rows as its options. */
class ClaudeCommandLineReader {
  private readonly pending: string[];
  private readonly subcommandsRegistered: boolean;
  private readonly operands: string[] = [];
  private readonly carriedArgs: string[] = [];
  /** In argv order; print-only rows among them refuse only when no `-p` makes the invocation a one-shot. */
  private readonly refusals: Refusal[] = [];
  private readonly mapped: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    settingSources?: string[];
    resumeInvocation?: string[];
    title?: string;
  } = {};
  private firstCarried: string | undefined;
  private readsNoSettingsFiles = false;
  private print = false;
  private elsewhere: ClaudeOptionRow | undefined;

  constructor(argv: readonly string[]) {
    this.pending = [...argv];
    const scanned = scanBeforeParse(argv);
    this.subcommandsRegistered = !scanned.print || scanned.connect;
  }

  read(): ClaudeInvocationReading {
    let endOfOptions = false;
    let variadic: ClaudeOptionRow | undefined;
    while (this.pending.length > 0) {
      const token = this.pending.shift()!;
      if (endOfOptions) {
        const decided = this.operand(token);
        if (decided !== undefined) return decided;
        continue;
      }
      if (token === '--') {
        endOfOptions = true;
        variadic = undefined;
        continue;
      }
      if (variadic !== undefined && !looksLikeOption(token)) {
        if (variadic.class === 'carried') this.carriedArgs.push(token);
        continue;
      }
      variadic = undefined;
      if (!looksLikeOption(token)) {
        const decided = this.operand(token);
        if (decided !== undefined) return decided;
        continue;
      }
      const exact = OPTIONS_BY_NAME.get(token);
      if (exact !== undefined) {
        const decided = this.option(exact, this.take(exact, token));
        if (decided !== undefined) return decided;
        if (exact.arity === 'variadic') variadic = exact;
        continue;
      }
      // A cluster: a flag at its head leaves `-<rest>` to parse next; a head that takes a value
      // takes the rest of the token as its value.
      if (token[1] !== '-' && token.length > 2) {
        const spelling = `-${token[1]}`;
        const head = OPTIONS_BY_NAME.get(spelling);
        if (head !== undefined && head.wholeTokenOnly !== true) {
          const flag = head.arity === 'none';
          const decided = this.option(
            head,
            flag ? { tokens: [spelling], spelling } : { tokens: [token], spelling, value: token.slice(2) },
          );
          if (decided !== undefined) return decided;
          if (flag) this.pending.unshift(`-${token.slice(2)}`);
          continue;
        }
      }
      if (/^--[^=]+=/u.test(token)) {
        const spelling = token.slice(0, token.indexOf('='));
        const named = OPTIONS_BY_NAME.get(spelling);
        if (named !== undefined && named.arity !== 'none') {
          const decided = this.option(named, { tokens: [token], spelling, value: token.slice(spelling.length + 1) });
          if (decided !== undefined) return decided;
          continue;
        }
      }
      return this.unknown(token);
    }
    return this.settle();
  }

  /** The first operand selects a registered subcommand, even after `--`; positional options give it the rest. */
  private operand(token: string): ClaudeInvocationReading | undefined {
    if (this.operands.length === 0 && this.subcommandsRegistered) {
      const subcommand = SUBCOMMANDS_BY_NAME.get(token);
      if (subcommand?.dispatch.includes('command')) return passthrough(subcommand.class, subcommand.why);
    }
    this.operands.push(token);
    return undefined;
  }

  /** The value an option given as a whole token takes from the tokens after it. */
  private take(row: ClaudeOptionRow, token: string): Taken | undefined {
    if (row.arity === 'none') return { tokens: [token], spelling: token };
    const next = this.pending[0];
    if (row.arity === 'optional') {
      if (next === undefined || looksLikeOption(next)) return { tokens: [token], spelling: token };
    } else if (next === undefined) {
      return undefined;
    }
    this.pending.shift();
    return { tokens: [token, next], spelling: token, value: next };
  }

  /**
   * One option and what it took (`undefined`: a value it needs is missing). Returns a reading only
   * when the option decides the invocation there and then: help and version exit while commander parses.
   */
  private option(row: ClaudeOptionRow, taken: Taken | undefined): ClaudeInvocationReading | undefined {
    const spelling = taken?.spelling ?? row.names.at(-1)!;
    if (taken === undefined) {
      this.refusals.push({ reason: 'it needs a value', argument: spelling });
      return undefined;
    }
    if (taken.value !== undefined && row.choices !== undefined && !row.choices.includes(taken.value)) {
      const choices = `${row.choices.slice(0, -1).join(', ')} or ${row.choices.at(-1)}`;
      this.refusals.push({ reason: `it takes ${choices}, not ${JSON.stringify(taken.value)}`, argument: spelling });
      return undefined;
    }
    switch (row.class) {
      case 'utility':
        return passthrough('utility', row.why);
      case 'elsewhere':
        this.elsewhere ??= row;
        return undefined;
      case 'one-shot':
        this.print = true;
        return undefined;
      case 'print-only':
      case 'rejected':
        this.refusals.push({ reason: row.why, argument: spelling });
        return undefined;
      case 'carried':
        this.carriedArgs.push(...taken.tokens);
        this.firstCarried ??= spelling;
        if (row.readsNoSettingsFiles === true) this.readsNoSettingsFiles = true;
        return undefined;
      case 'mapped':
        this.map(row, taken);
        return undefined;
    }
  }

  private map(row: ClaudeOptionRow, taken: Taken): void {
    const refuse = (reason: string) => this.refusals.push({ reason, argument: taken.spelling });
    switch (row.maps) {
      case 'resume':
        if (this.mapped.resumeInvocation !== undefined) refuse('it resumes a conversation a second way');
        else this.mapped.resumeInvocation = [...taken.tokens];
        return;
      case 'settingSources': {
        const sources = taken.value!.split(',');
        if (this.mapped.settingSources !== undefined) refuse('it is given more than once');
        else if (sources.some((source) => !SETTING_SOURCES.has(source))) {
          refuse('it takes user, project and local, comma-separated');
        } else this.mapped.settingSources = sources;
        return;
      }
      case 'model':
      case 'effort':
      case 'permissionMode':
      case 'title':
        if (this.mapped[row.maps] !== undefined) refuse('it is given more than once');
        else this.mapped[row.maps] = taken.value!;
        return;
      default:
        throw new Error(`mapped Claude option ${taken.spelling} names no managed option`);
    }
  }

  /** A token that starts with `-` and has no row: its arity cannot be known, so nothing after it can be read. */
  private unknown(token: string): ClaudeInvocationReading {
    const established = this.passthroughSoFar();
    if (established !== undefined) return established;
    const first = this.refusals[0];
    if (first !== undefined) return { status: 'rejected', reason: first.reason, argument: first.argument };
    return {
      status: 'rejected',
      reason: `this version of the Claude adapter (Claude Code ${CLAUDE_INVOCATION_GRAMMAR_VERSION}) does not know it`,
      argument: token,
    };
  }

  private passthroughSoFar(): ClaudeInvocationReading | undefined {
    if (this.elsewhere !== undefined) return passthrough('elsewhere', this.elsewhere.why);
    if (this.print) return passthrough('one-shot', 'it prints one response and exits');
    return undefined;
  }

  private settle(): ClaudeInvocationReading {
    const established = this.passthroughSoFar();
    if (established !== undefined) return established;
    const refusal = this.refusals[0];
    if (refusal !== undefined) return { status: 'rejected', reason: refusal.reason, argument: refusal.argument };
    const resumeInvocation = this.mapped.resumeInvocation;
    const resumeValue = resumeInvocation === undefined ? undefined : resumeTarget(resumeInvocation);
    return {
      status: 'accepted',
      ...(this.mapped.model === undefined ? {} : { model: this.mapped.model }),
      ...(this.mapped.effort === undefined ? {} : { effort: this.mapped.effort }),
      ...(this.mapped.permissionMode === undefined ? {} : { permissionMode: this.mapped.permissionMode }),
      ...(this.mapped.settingSources === undefined ? {} : { settingSources: this.mapped.settingSources }),
      ...(this.mapped.title === undefined ? {} : { title: this.mapped.title }),
      ...(resumeValue !== undefined && UUID.test(resumeValue)
        ? { resume: resumeValue }
        : resumeInvocation === undefined
          ? {}
          : { resumeInvocation }),
      carriedArgs: this.carriedArgs,
      prompt: this.operands,
      ...(this.firstCarried === undefined ? {} : { firstCarried: this.firstCarried }),
      readsNoSettingsFiles: this.readsNoSettingsFiles,
    };
  }
}

/** The value a `-r`/`--resume` form names, when it names one (a picker search term or an id). */
function resumeTarget(tokens: readonly string[]): string | undefined {
  const [first, second] = tokens;
  if (first === '-r' || first === '--resume') return second;
  if (first?.startsWith('--resume=')) return first.slice('--resume='.length);
  if (first?.startsWith('-r') && first.length > 2 && !first.startsWith('--')) return first.slice(2);
  return undefined;
}

/** The argv the managed launch would build, with placeholder values where the recipe puts its own. */
function managedShape(session: ClaudeSessionReading): string[] {
  return [
    ...(session.resumeInvocation ??
      (session.resume === undefined ? ['--session-id', 'id'] : ['--resume', session.resume])),
    ...(session.title === undefined ? [] : ['--name', session.title]),
    ...(session.model === undefined ? [] : ['--model', session.model]),
    ...(session.effort === undefined ? [] : ['--effort', session.effort]),
    ...(session.settingSources === undefined ? [] : ['--setting-sources', session.settingSources.join(',')]),
    '--settings',
    'settings.json',
    ...(session.permissionMode === undefined ? [] : ['--permission-mode', session.permissionMode]),
    ...session.carriedArgs,
    ...(session.prompt.length === 0 ? [] : ['--', ...session.prompt]),
  ];
}

/**
 * Read a typed `claude …` (the argv after the command name) the way Claude Code
 * {@link CLAUDE_INVOCATION_GRAMMAR_VERSION} reads it.
 */
export function readClaudeInvocation(argv: readonly string[]): ClaudeInvocationReading {
  const dispatched = entryDispatch(argv);
  if (dispatched !== undefined) return dispatched;
  const rewritten = importRewrite(argv);
  const reading = new ClaudeCommandLineReader(rewritten ?? argv).read();
  if (reading.status !== 'accepted') return reading;
  const end = argv.indexOf('--');
  const blinding = (end === -1 ? argv : argv.slice(0, end)).find((token) => CLAUDE_BLINDING_TOKENS.includes(token));
  if (blinding !== undefined) return { status: 'rejected', reason: HOOKS_OFF, argument: blinding };
  if (rewritten !== undefined) {
    return {
      status: 'rejected',
      reason: 'it starts a session that runs /import, which the managed launch does not carry',
      argument: CLAUDE_IMPORT_REWRITE.token,
    };
  }
  // The managed launch puts its own flags first and the prompt after `--`: the entry must read
  // that argv as the same plain session, or the arguments cannot be passed on as typed. Its first
  // operand must not select a subcommand either: commander dispatches one even after `--` (2.1.308
  // probe R05: `claude -- purge` runs purge, its [path] then every later token).
  const shape = managedShape(reading);
  const firstOperand = shape[firstOperandIndex(shape)];
  if (
    entryDispatch(shape) !== undefined ||
    importRewrite(shape) !== undefined ||
    (firstOperand !== undefined && SUBCOMMANDS_BY_NAME.get(firstOperand)?.dispatch.includes('command') === true)
  ) {
    return {
      status: 'rejected',
      reason: 'the managed launch could not pass these arguments on as typed',
      ...(reading.firstCarried === undefined ? {} : { argument: reading.firstCarried }),
    };
  }
  return reading;
}
