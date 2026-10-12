import { readNativeInvocationArguments, type NativeInvocationGrammar } from '@vibefield/puppeteer-core';

/** Native help and parser evidence: __fixtures__/README.md. Unknown arity is a refusal. */
export const INVOCATION_GRAMMAR_VERSION = '1.0.88';
export const INVOCATION_GRAMMAR = {
  options: [
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
      names: ['--prompt', '-p'],
      arity: 'one',
      passthrough: 'one-shot',
    },
    {
      names: ['--acp'],
      arity: 'none',
      passthrough: 'elsewhere',
    },
    {
      names: ['--connect'],
      arity: 'optional',
      passthrough: 'elsewhere',
    },
    {
      names: ['--model'],
      arity: 'one',
      mapped: '--model',
    },
    {
      names: ['--reasoning-effort'],
      arity: 'one',
      mapped: '--reasoning-effort',
    },
    {
      names: ['--context'],
      arity: 'one',
      mapped: '--context',
    },
    {
      names: ['--agent'],
      arity: 'one',
      mapped: '--agent',
    },
    {
      names: ['--mode'],
      arity: 'one',
      mapped: '--mode',
    },
    {
      names: ['--name', '-n'],
      arity: 'one',
      mapped: '--name',
    },
    {
      names: ['--resume', '-r'],
      arity: 'optional',
      mapped: '--resume',
    },
    {
      names: ['--allow-all'],
      arity: 'none',
      mapped: '--allow-all',
    },
    {
      names: ['--yolo'],
      arity: 'none',
      mapped: '--yolo',
    },
    {
      names: ['--plan'],
      arity: 'none',
      mapped: '--plan',
    },
    {
      names: ['--interactive', '-i'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--auto-tier'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['-C'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--log-dir'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--extension-sdk-path'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--log-level'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--stream'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--output-format'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--add-dir'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--attachment'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--disable-mcp-server'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--add-github-mcp-toolset'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--add-github-mcp-tool'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--plugin-dir'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--additional-mcp-config'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--max-autopilot-continues'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--dynamic-retrieval'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--enable-mcp-server'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--max-ai-credits'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--usage-output-file'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--session-id'],
      arity: 'one',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--share'],
      arity: 'optional',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--bash-env'],
      arity: 'optional',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--mouse'],
      arity: 'optional',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--allow-tool'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--deny-tool'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--available-tools'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--excluded-tools'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--secret-env-vars'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--allow-url'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--deny-url'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--fleet'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--silent', '-s'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--enable-memory'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--continue'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--allow-all-tools'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--allow-all-paths'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--disallow-temp-dir'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--banner'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--screen-reader'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--plain-diff'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--share-gist'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--disable-builtin-mcps'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--enable-all-github-mcp-tools'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--allow-all-mcp-server-instructions'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--allow-all-urls'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--autopilot'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--experimental'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--remote'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--remote-export'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--assisted-approval'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-custom-instructions'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-auto-update'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-ask-user'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-color'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-experimental'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-bash-env'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-mouse'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-remote'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-remote-export'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-eager-powershell-resolution'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
  ],
  commands: [
    {
      names: ['login'],
      passthrough: 'utility',
    },
    {
      names: ['help'],
      passthrough: 'utility',
    },
    {
      names: ['init'],
      passthrough: 'utility',
    },
    {
      names: ['update'],
      passthrough: 'utility',
    },
    {
      names: ['version'],
      passthrough: 'utility',
    },
    {
      names: ['sessions'],
      passthrough: 'utility',
    },
    {
      names: ['memories'],
      passthrough: 'utility',
    },
    {
      names: ['plugin'],
      passthrough: 'utility',
    },
    {
      names: ['mcp'],
      passthrough: 'utility',
    },
    {
      names: ['skill'],
      passthrough: 'utility',
    },
    {
      names: ['instruction'],
      passthrough: 'utility',
    },
    {
      names: ['lsp'],
      passthrough: 'utility',
    },
    {
      names: ['completion'],
      passthrough: 'utility',
    },
    {
      names: ['app'],
      passthrough: 'elsewhere',
    },
  ],
} as const satisfies NativeInvocationGrammar;

export const readInvocation = (argv: readonly string[]) => readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
