import { readNativeInvocationArguments, type NativeInvocationGrammar } from '@vibefield/puppeteer-core';

/** Native help and parser evidence: __fixtures__/README.md. Unknown arity is a refusal. */
export const INVOCATION_GRAMMAR_VERSION = '1.2.12';
export const INVOCATION_GRAMMAR = {
  optionLikeValues: true,
  shortClusters: false,
  booleanEquals: true,
  options: [
    {
      names: ['--add-dir'],
      arity: 'one',
      mapped: '--add-dir',
    },
    {
      names: ['--agent'],
      arity: 'one',
      mapped: '--agent',
    },
    {
      names: ['--conversation'],
      arity: 'one',
      mapped: '--conversation',
    },
    {
      names: ['--effort'],
      arity: 'one',
      mapped: '--effort',
    },
    {
      names: ['--mode'],
      arity: 'one',
      mapped: '--mode',
    },
    {
      names: ['--model'],
      arity: 'one',
      mapped: '--model',
    },
    {
      names: ['--project'],
      arity: 'one',
      mapped: '--project',
    },
    {
      names: ['--dangerously-skip-permissions'],
      arity: 'none',
      mapped: '--dangerously-skip-permissions',
    },
    {
      names: ['--sandbox'],
      arity: 'none',
      mapped: '--sandbox',
    },
    {
      names: ['--continue', '-c'],
      arity: 'none',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--print', '-p', '--prompt'],
      arity: 'one',
      passthrough: 'one-shot',
    },
    {
      names: ['--disable-slash-commands'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--remote-control'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--input-format'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--json-schema'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--log-file'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--new-project'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--output-format'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--print-timeout'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--prompt-interactive', '-i'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
  ],
  commands: [
    {
      names: ['agent'],
      passthrough: 'utility',
    },
    {
      names: ['agents'],
      passthrough: 'utility',
    },
    {
      names: ['changelog'],
      passthrough: 'utility',
    },
    {
      names: ['help'],
      passthrough: 'utility',
    },
    {
      names: ['install'],
      passthrough: 'utility',
    },
    {
      names: ['mcp'],
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
      names: ['plugins'],
      passthrough: 'utility',
    },
    {
      names: ['update'],
      passthrough: 'utility',
    },
    {
      names: ['mic-serve'],
      passthrough: 'elsewhere',
    },
    {
      names: ['remote-control'],
      passthrough: 'elsewhere',
    },
  ],
} as const satisfies NativeInvocationGrammar;

// The native entry checks whole help/version tokens before parsing, even as a value or after `--`.
// These are entry shortcuts, not parser boolean options: --version=true can start the TUI.
// See __fixtures__/parse-probes.json. In particular -v is NOT a version alias.
export const readInvocation = (argv: readonly string[]) => {
  if (argv.some((argument) => argument === '--help' || argument === '-h' || argument === '--version')) {
    return {
      status: 'passthrough' as const,
      kind: 'utility' as const,
      reason: 'the native entry prints help or version before parsing arguments',
    };
  }
  return readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
};
