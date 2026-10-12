import { readNativeInvocationArguments, type NativeInvocationGrammar } from '@vibefield/puppeteer-core';

/** Native help and parser evidence: __fixtures__/README.md. Unknown arity is a refusal. */
export const INVOCATION_GRAMMAR_VERSION = '1.18.32';
export const INVOCATION_GRAMMAR = {
  booleanEquals: true,
  booleanValues: true,
  deferUtilityOptions: true,
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
      names: ['--session', '-s'],
      arity: 'one',
      mapped: '--session',
    },
    {
      names: ['--pure'],
      arity: 'none',
      mapped: null,
    },
    {
      names: ['--print-logs'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--mdns'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--continue', '-c'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--fork'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--auto'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--mini'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--no-replay'],
      arity: 'none',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--log-level'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--port'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--hostname'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--mdns-domain'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--model', '-m'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--prompt'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--agent'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--replay-limit'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--cors'],
      arity: 'many',
      reason: 'the managed launch cannot preserve this option',
    },
  ],
  commands: [
    {
      names: ['completion'],
      passthrough: 'utility',
    },
    {
      names: ['mcp'],
      passthrough: 'utility',
    },
    {
      names: ['debug'],
      passthrough: 'utility',
    },
    {
      names: ['providers', 'auth'],
      passthrough: 'utility',
    },
    {
      names: ['agent'],
      passthrough: 'utility',
    },
    {
      names: ['upgrade'],
      passthrough: 'utility',
    },
    {
      names: ['uninstall'],
      passthrough: 'utility',
    },
    {
      names: ['models'],
      passthrough: 'utility',
    },
    {
      names: ['stats'],
      passthrough: 'utility',
    },
    {
      names: ['export'],
      passthrough: 'utility',
    },
    {
      names: ['import'],
      passthrough: 'utility',
    },
    {
      names: ['session'],
      passthrough: 'utility',
    },
    {
      names: ['plugin', 'plug'],
      passthrough: 'utility',
    },
    {
      names: ['db'],
      passthrough: 'utility',
    },
    {
      names: ['acp'],
      passthrough: 'elsewhere',
    },
    {
      names: ['attach'],
      passthrough: 'elsewhere',
    },
    {
      names: ['serve'],
      passthrough: 'elsewhere',
    },
    {
      names: ['web'],
      passthrough: 'elsewhere',
    },
    {
      names: ['run'],
      passthrough: 'one-shot',
    },
    {
      names: ['github'],
      reason: 'this native command starts an interactive session the managed launch cannot preserve',
    },
    {
      names: ['pr'],
      reason: 'this native command starts an interactive session the managed launch cannot preserve',
    },
  ],
} as const satisfies NativeInvocationGrammar;

export const readInvocation = (argv: readonly string[]) => readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
