import { readNativeInvocationArguments, type NativeInvocationGrammar } from '@vibecook/puppeteer-core';

/** Native help and parser evidence: __fixtures__/README.md. Unknown arity is a refusal. */
export const INVOCATION_GRAMMAR_VERSION = '0.21.4';
export const INVOCATION_GRAMMAR = {
  options: [
    {
      names: ['--help', '-h'],
      arity: 'none',
      passthrough: 'utility',
    },
    {
      names: ['--version', '-V'],
      arity: 'none',
      passthrough: 'utility',
    },
    {
      names: ['--oneshot', '-z'],
      arity: 'one',
      passthrough: 'one-shot',
    },
    {
      names: ['--resume', '-r'],
      arity: 'one',
      mapped: '--resume',
    },
    {
      names: ['--yolo'],
      arity: 'none',
      mapped: '--yolo',
    },
    {
      names: ['--tui'],
      arity: 'none',
      mapped: null,
    },
    {
      names: ['--usage-file'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--model', '-m'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--provider'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--reasoning'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--toolsets', '-t'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--in'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--skills', '-s'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--continue', '-c'],
      arity: 'optional',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--no-restore-cwd'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--worktree', '-w'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--accept-hooks'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--pass-session-id'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--ignore-user-config'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--ignore-rules'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--safe-mode'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--cli'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--dev'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--profile', '-p'],
      arity: 'one',
      reason: 'a named native profile changes the home before observation; use a profile-bound pane',
      hidden: 'hermes_cli/main.py _scan_profile_flag, documented in --help examples',
    },
  ],
  commands: [
    {
      names: ['chat'],
      grammar: {
        options: [
          {
            names: ['--help', '-h'],
            arity: 'none',
            passthrough: 'utility',
          },
          {
            names: ['--oneshot'],
            arity: 'none',
            passthrough: 'one-shot',
          },
          {
            names: ['--quiet', '-Q'],
            arity: 'none',
            passthrough: 'one-shot',
          },
          {
            names: ['--format'],
            arity: 'one',
            modes: {
              'stream-json': 'one-shot',
              text: 'session',
            },
          },
          {
            names: ['--resume', '-r'],
            arity: 'one',
            mapped: '--resume',
          },
          {
            names: ['--yolo'],
            arity: 'none',
            mapped: '--yolo',
          },
          {
            names: ['--tui'],
            arity: 'none',
            mapped: null,
          },
          {
            names: ['--query', '-q'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--query-file'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--image'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--model', '-m'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--toolsets', '-t'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--reasoning'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--skills', '-s'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--provider'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--in'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--max-turns'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--run-budget'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--source'],
            arity: 'one',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--continue', '-c'],
            arity: 'optional',
            reason: 'the managed launch owns session identity and cannot carry this selector',
          },
          {
            names: ['--verbose', '-v'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--no-restore-cwd'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--create-if-missing'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--worktree', '-w'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--accept-hooks'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--checkpoints'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--pass-session-id'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--ignore-user-config'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--ignore-rules'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--safe-mode'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--cli'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--dev'],
            arity: 'none',
            reason: 'the managed launch cannot preserve this option',
          },
          {
            names: ['--profile', '-p'],
            arity: 'one',
            reason: 'the managed launch cannot bind a named native profile',
            hidden: 'hermes_cli/main.py _scan_profile_flag',
          },
        ],
      },
    },
    {
      names: ['model'],
      passthrough: 'utility',
    },
    {
      names: ['moa'],
      passthrough: 'utility',
    },
    {
      names: ['fallback'],
      passthrough: 'utility',
    },
    {
      names: ['worktree'],
      passthrough: 'utility',
    },
    {
      names: ['browser'],
      passthrough: 'utility',
    },
    {
      names: ['secrets'],
      passthrough: 'utility',
    },
    {
      names: ['egress'],
      passthrough: 'utility',
    },
    {
      names: ['migrate'],
      passthrough: 'utility',
    },
    {
      names: ['codex-runtime'],
      passthrough: 'utility',
    },
    {
      names: ['lsp'],
      passthrough: 'utility',
    },
    {
      names: ['setup'],
      passthrough: 'utility',
    },
    {
      names: ['whatsapp'],
      passthrough: 'utility',
    },
    {
      names: ['whatsapp-cloud'],
      passthrough: 'utility',
    },
    {
      names: ['slack'],
      passthrough: 'utility',
    },
    {
      names: ['send'],
      passthrough: 'utility',
    },
    {
      names: ['logout'],
      passthrough: 'utility',
    },
    {
      names: ['auth'],
      passthrough: 'utility',
    },
    {
      names: ['status'],
      passthrough: 'utility',
    },
    {
      names: ['pause'],
      passthrough: 'utility',
    },
    {
      names: ['resume'],
      passthrough: 'utility',
    },
    {
      names: ['cron'],
      passthrough: 'utility',
    },
    {
      names: ['sync'],
      passthrough: 'utility',
    },
    {
      names: ['webhook'],
      passthrough: 'utility',
    },
    {
      names: ['peer'],
      passthrough: 'utility',
    },
    {
      names: ['portal'],
      passthrough: 'utility',
    },
    {
      names: ['kanban'],
      passthrough: 'utility',
    },
    {
      names: ['project'],
      passthrough: 'utility',
    },
    {
      names: ['hooks'],
      passthrough: 'utility',
    },
    {
      names: ['doctor'],
      passthrough: 'utility',
    },
    {
      names: ['verify'],
      passthrough: 'utility',
    },
    {
      names: ['security'],
      passthrough: 'utility',
    },
    {
      names: ['approvals'],
      passthrough: 'utility',
    },
    {
      names: ['dump'],
      passthrough: 'utility',
    },
    {
      names: ['debug'],
      passthrough: 'utility',
    },
    {
      names: ['backup'],
      passthrough: 'utility',
    },
    {
      names: ['checkpoints'],
      passthrough: 'utility',
    },
    {
      names: ['import'],
      passthrough: 'utility',
    },
    {
      names: ['import-agent'],
      passthrough: 'utility',
    },
    {
      names: ['config'],
      passthrough: 'utility',
    },
    {
      names: ['skin'],
      passthrough: 'utility',
    },
    {
      names: ['console'],
      passthrough: 'utility',
    },
    {
      names: ['pairing'],
      passthrough: 'utility',
    },
    {
      names: ['skills'],
      passthrough: 'utility',
    },
    {
      names: ['bundles'],
      passthrough: 'utility',
    },
    {
      names: ['plugins'],
      passthrough: 'utility',
    },
    {
      names: ['curator'],
      passthrough: 'utility',
    },
    {
      names: ['pets'],
      passthrough: 'utility',
    },
    {
      names: ['journey', 'learning', 'memory-graph'],
      passthrough: 'utility',
    },
    {
      names: ['memory'],
      passthrough: 'utility',
    },
    {
      names: ['tools'],
      passthrough: 'utility',
    },
    {
      names: ['computer-use'],
      passthrough: 'utility',
    },
    {
      names: ['mcp'],
      passthrough: 'utility',
    },
    {
      names: ['sessions'],
      grammar: {
        defaultPassthrough: 'utility',
        options: [
          {
            names: ['--help', '-h'],
            arity: 'none',
            passthrough: 'utility',
          },
        ],
        commands: [
          {
            names: ['list'],
            passthrough: 'utility',
          },
          {
            names: ['export'],
            passthrough: 'utility',
          },
          {
            names: ['delete'],
            passthrough: 'utility',
          },
          {
            names: ['prune'],
            passthrough: 'utility',
          },
          {
            names: ['archive'],
            passthrough: 'utility',
          },
          {
            names: ['optimize'],
            passthrough: 'utility',
          },
          {
            names: ['clean-markers'],
            passthrough: 'utility',
          },
          {
            names: ['optimize-storage'],
            passthrough: 'utility',
          },
          {
            names: ['repair'],
            passthrough: 'utility',
          },
          {
            names: ['set-journal-mode'],
            passthrough: 'utility',
          },
          {
            names: ['repair-routing'],
            passthrough: 'utility',
          },
          {
            names: ['repair-profiles'],
            passthrough: 'utility',
          },
          {
            names: ['recover'],
            passthrough: 'utility',
          },
          {
            names: ['stats'],
            passthrough: 'utility',
          },
          {
            names: ['rename'],
            passthrough: 'utility',
          },
          {
            names: ['pin'],
            passthrough: 'utility',
          },
          {
            names: ['unpin'],
            passthrough: 'utility',
          },
          {
            names: ['pinned'],
            passthrough: 'utility',
          },
          {
            names: ['retitle-skills'],
            passthrough: 'utility',
          },
          {
            names: ['import'],
            passthrough: 'utility',
          },
          {
            names: ['browse'],
            reason:
              'the native session picker relaunches into an interactive session; resume an exact session id instead',
          },
        ],
      },
    },
    {
      names: ['insights'],
      passthrough: 'utility',
    },
    {
      names: ['usage'],
      passthrough: 'utility',
    },
    {
      names: ['monitoring'],
      passthrough: 'utility',
    },
    {
      names: ['claw'],
      passthrough: 'utility',
    },
    {
      names: ['vault'],
      passthrough: 'utility',
    },
    {
      names: ['update'],
      passthrough: 'utility',
    },
    {
      names: ['uninstall'],
      passthrough: 'utility',
    },
    {
      names: ['profile'],
      passthrough: 'utility',
    },
    {
      names: ['completion'],
      passthrough: 'utility',
    },
    {
      names: ['logs'],
      passthrough: 'utility',
    },
    {
      names: ['prompt-size'],
      passthrough: 'utility',
    },
    {
      names: ['gateway'],
      passthrough: 'elsewhere',
    },
    {
      names: ['proxy'],
      passthrough: 'elsewhere',
    },
    {
      names: ['acp'],
      passthrough: 'elsewhere',
    },
    {
      names: ['dashboard'],
      passthrough: 'elsewhere',
    },
    {
      names: ['serve'],
      passthrough: 'elsewhere',
    },
    {
      names: ['desktop', 'gui'],
      passthrough: 'elsewhere',
    },
  ],
} as const satisfies NativeInvocationGrammar;

export const readInvocation = (argv: readonly string[]) => readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
