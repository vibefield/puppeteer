import { readNativeInvocationArguments, type NativeInvocationGrammar } from '@vibefield/puppeteer-core';

/** Native help and parser evidence: __fixtures__/README.md. Unknown arity is a refusal. */
export const INVOCATION_GRAMMAR_VERSION = '1.0.41';
export const INVOCATION_GRAMMAR = {
  options: [
    { names: ['--reasoning-effort'], arity: 'one', reason: 'the managed launch cannot preserve reasoning effort yet' },
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
      names: ['--agent'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--agents'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--allow'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--cwd'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--debug-file'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--deny'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--disallowed-tools'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--json-schema'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--leader-socket'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--max-turns'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--output-format'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--rules'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--system-prompt-override'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--tools'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--worktree-ref', '--ref'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--always-approve'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--debug'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--disable-web-search'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--fork-session'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--fullscreen'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--include-partial-messages'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--minimal'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-alt-screen'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-plan'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-subagents'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--oauth'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--restore-code'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--verbatim'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--worktree', '-w'],
      arity: 'optional',
      reason: 'the managed launch cannot preserve this option',
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
      hidden: 'adapter launch/tui.ts uses this native flag',
    },
    {
      names: ['--allowedTools'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
      hidden: 'compat alias documented in the native help description',
    },
    {
      names: ['--disallowedTools'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
      hidden: 'compat alias documented in the native help description',
    },
    {
      names: ['--system-prompt'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
      hidden: 'compat alias documented in the native help description',
    },
  ],
  commands: [
    {
      names: ['completions'],
      passthrough: 'utility',
    },
    {
      names: ['doctor'],
      passthrough: 'utility',
    },
    {
      names: ['du', 'disk-usage'],
      passthrough: 'utility',
    },
    {
      names: ['export'],
      passthrough: 'utility',
    },
    {
      names: ['help'],
      passthrough: 'utility',
    },
    {
      names: ['inspect'],
      passthrough: 'utility',
    },
    {
      names: ['leader'],
      passthrough: 'utility',
    },
    {
      names: ['login'],
      passthrough: 'utility',
    },
    {
      names: ['logout'],
      passthrough: 'utility',
    },
    {
      names: ['mcp'],
      passthrough: 'utility',
    },
    {
      names: ['memory'],
      passthrough: 'utility',
    },
    {
      names: ['models'],
      passthrough: 'utility',
    },
    {
      names: ['plugin'],
      passthrough: 'utility',
    },
    {
      names: ['sessions'],
      passthrough: 'utility',
    },
    {
      names: ['setup'],
      passthrough: 'utility',
    },
    {
      names: ['trace'],
      passthrough: 'utility',
    },
    {
      names: ['update'],
      passthrough: 'utility',
    },
    {
      names: ['usage'],
      passthrough: 'utility',
    },
    {
      names: ['version', 'v'],
      passthrough: 'utility',
    },
    {
      names: ['worktree'],
      passthrough: 'utility',
    },
    {
      names: ['clone'],
      passthrough: 'elsewhere',
    },
    {
      names: ['cursor-worker'],
      passthrough: 'elsewhere',
    },
    {
      names: ['wrap'],
      passthrough: 'elsewhere',
    },
    {
      names: ['agent'],
      passthrough: 'elsewhere',
    },
    {
      names: ['dashboard'],
      reason: 'this native command starts an interactive session the managed launch cannot preserve',
    },
  ],
} as const satisfies NativeInvocationGrammar;

export const readInvocation = (argv: readonly string[]) => readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
