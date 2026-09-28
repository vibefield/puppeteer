import { readNativeInvocationArguments, type NativeInvocationGrammar } from '@vibecook/puppeteer-core';

/** Native help and parser evidence: __fixtures__/README.md. Unknown arity is a refusal. */
export const INVOCATION_GRAMMAR_VERSION = '0.87.1';
export const INVOCATION_GRAMMAR = {
  shortClusters: false,
  commandFirst: true,
  optionLikeValues: true,
  equals: false,
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
      names: ['--print', '-p'],
      arity: 'none',
      passthrough: 'one-shot',
    },
    {
      names: ['--export'],
      arity: 'one',
      passthrough: 'utility',
    },
    {
      names: ['--list-models'],
      arity: 'optional',
      passthrough: 'utility',
    },
    {
      names: ['--mode'],
      arity: 'one',
      mapped: null,
      modes: {
        text: 'session',
        json: 'one-shot',
        rpc: 'elsewhere',
      },
      optionLikeValues: false,
    },
    {
      names: ['--provider'],
      arity: 'one',
      mapped: '--provider',
    },
    {
      names: ['--model'],
      arity: 'one',
      mapped: '--model',
    },
    {
      names: ['--thinking'],
      arity: 'one',
      mapped: '--thinking',
    },
    {
      names: ['--name', '-n'],
      arity: 'one',
      mapped: '--name',
    },
    {
      names: ['--session-dir'],
      arity: 'one',
      mapped: '--session-dir',
    },
    {
      names: ['--session'],
      arity: 'one',
      mapped: '--session',
    },
    {
      names: ['--continue', '-c'],
      arity: 'none',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--resume', '-r'],
      arity: 'none',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--no-session'],
      arity: 'none',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--session-id'],
      arity: 'one',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--fork'],
      arity: 'one',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--api-key'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--system-prompt'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--append-system-prompt'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--models'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--tools', '-t'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--exclude-tools', '-xt'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--extension', '-e'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--skill'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--prompt-template'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--theme'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--use-theme'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--tui-mode'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-tools', '-nt'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-builtin-tools', '-nbt'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-extensions', '-ne'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-skills', '-ns'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-prompt-templates', '-np'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-themes'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-context-files', '-nc'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--verbose'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--approve', '-a'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-approve', '-na'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--offline'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
  ],
  commands: [
    {
      names: ['install'],
      passthrough: 'utility',
    },
    {
      names: ['remove'],
      passthrough: 'utility',
    },
    {
      names: ['uninstall'],
      passthrough: 'utility',
    },
    {
      names: ['update'],
      passthrough: 'utility',
    },
    {
      names: ['list'],
      passthrough: 'utility',
    },
    {
      names: ['config'],
      passthrough: 'utility',
    },
    {
      names: ['auth'],
      passthrough: 'utility',
    },
  ],
} as const satisfies NativeInvocationGrammar;

export const readInvocation = (argv: readonly string[]) => readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
