import { readNativeInvocationArguments, type NativeInvocationGrammar } from '@vibecook/puppeteer-core';

/** Native help and parser evidence: __fixtures__/README.md. Unknown arity is a refusal. */
export const INVOCATION_GRAMMAR_VERSION = '2.0.2';
export const INVOCATION_GRAMMAR = {
  optionLikeValues: true,
  options: [
    {
      names: ['--version', '-V'],
      arity: 'none',
      passthrough: 'utility',
    },
    {
      names: ['--help', '-h'],
      arity: 'none',
      passthrough: 'utility',
    },
    {
      names: ['--session', '-S'],
      arity: 'optional',
      mapped: '--session',
    },
    {
      names: ['--resume', '-r'],
      arity: 'optional',
      mapped: '--session',
      hidden: 'official kimi Command reference: hidden aliases for --session',
    },
    {
      names: ['--yes', '--auto-approve'],
      arity: 'none',
      mapped: '--yolo',
      hidden: 'official kimi Command reference: hidden aliases for --yolo',
    },
    {
      names: ['--continue', '-c'],
      arity: 'none',
      reason: 'the managed launch owns session identity and cannot carry this selector',
    },
    {
      names: ['--yolo', '-y'],
      arity: 'none',
      mapped: '--yolo',
    },
    {
      names: ['--auto'],
      arity: 'none',
      mapped: '--auto',
    },
    {
      names: ['--plan'],
      arity: 'none',
      mapped: '--plan',
    },
    {
      names: ['--model', '-m'],
      arity: 'one',
      mapped: '--model',
    },
    {
      names: ['--agent'],
      arity: 'one',
      mapped: '--agent',
    },
    {
      names: ['--agent-file'],
      arity: 'one',
      mapped: '--agent-file',
    },
    {
      names: ['--prompt', '-p'],
      arity: 'one',
      passthrough: 'one-shot',
    },
    {
      names: ['--output-format'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--skills-dir'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
    {
      names: ['--add-dir'],
      arity: 'one',
      reason: 'the managed launch cannot preserve this option',
    },
  ],
  commands: [
    {
      names: ['export'],
      passthrough: 'utility',
    },
    {
      names: ['fork'],
      passthrough: 'utility',
    },
    {
      names: ['provider'],
      passthrough: 'utility',
    },
    {
      names: ['session'],
      passthrough: 'utility',
    },
    {
      names: ['login'],
      passthrough: 'utility',
    },
    {
      names: ['doctor'],
      passthrough: 'utility',
    },
    {
      names: ['install-desktop'],
      passthrough: 'utility',
    },
    {
      names: ['migrate'],
      passthrough: 'utility',
    },
    {
      names: ['upgrade', 'update'],
      passthrough: 'utility',
    },
    {
      names: ['acp'],
      passthrough: 'elsewhere',
    },
    {
      names: ['web'],
      passthrough: 'elsewhere',
    },
    {
      names: ['server'],
      passthrough: 'elsewhere',
    },
    {
      names: ['rc', 'remote'],
      passthrough: 'elsewhere',
    },
    {
      names: ['vis'],
      passthrough: 'elsewhere',
    },
  ],
} as const satisfies NativeInvocationGrammar;

export const readInvocation = (argv: readonly string[]) => readNativeInvocationArguments(argv, INVOCATION_GRAMMAR);
