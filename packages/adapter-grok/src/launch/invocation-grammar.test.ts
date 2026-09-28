import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation, NativeInvocationOption } from '@vibecook/puppeteer-core';
import { INVOCATION_GRAMMAR, INVOCATION_GRAMMAR_VERSION } from './invocation-grammar.js';
import { normalizeGrokNativeInvocation as normalize } from './native-invocation.js';

const invoke = (argv: string[], implementation: AgentNativeInvocation['implementation'] = { kind: 'native' }) =>
  normalize({
    providerId: 'grok',
    cwd: '/project',
    argv,
    environment: {},
    implementation,
  });

const matrix: Record<'utility' | 'one-shot' | 'elsewhere' | 'reject', string[][]> & {
  mapped: [string[], Record<string, unknown>][];
} = {
  utility: [['--help'], ['version'], ['--model', 'help', 'models'], ['--debug', 'sessions', 'list']],
  'one-shot': [
    ['-p', 'hi'],
    ['--prompt-json', '[]'],
  ],
  elsewhere: [
    ['wrap', 'echo', 'hi'],
    ['agent', 'headless'],
    ['agent', 'stdio'],
  ],
  reject: [['--leader-socket', '/tmp/foreign'], ['--fork-session'], ['dashboard'], ['hello'], ['--model', '--help']],
  mapped: [
    [
      ['-mexample'],
      {
        model: 'example',
      },
    ],
    [
      ['--model=example'],
      {
        model: 'example',
      },
    ],
  ],
};

describe('grok strict invocation grammar', () => {
  it('accounts for every public root option in the captured native help, in both directions', () => {
    const help = readFileSync(
      new URL(`./__fixtures__/grok-help-${INVOCATION_GRAMMAR_VERSION}.txt`, import.meta.url),
      'utf8',
    );
    const publicNames = new Set<string>();
    for (const line of help.split('\n')) {
      if (!/^ (?: |     )-\S/u.test(line)) continue;
      const column = line.trimStart().split(/\s{2,}/u)[0]!;
      for (const name of column.match(/(?<![A-Za-z])--?[A-Za-z][A-Za-z0-9-]*/gu) ?? []) publicNames.add(name);
    }
    publicNames.add('--ref');
    const table = (INVOCATION_GRAMMAR.options as readonly NativeInvocationOption[])
      .filter((row) => !row.hidden)
      .flatMap((row) => row.names);
    expect([...new Set(table)].sort()).toEqual([...publicNames].sort());
    const allNames = INVOCATION_GRAMMAR.options.flatMap((row) => [...row.names]);
    expect(new Set(allNames).size).toBe(allNames.length);
  });

  it('accounts for every public command and alias in the captured native help', () => {
    const help = readFileSync(
      new URL(`./__fixtures__/grok-help-${INVOCATION_GRAMMAR_VERSION}.txt`, import.meta.url),
      'utf8',
    );
    const names = new Set<string>();
    const commands = help.split('Commands:')[1]!.split('\n\n')[0]!;
    for (const line of commands.split('\n')) {
      const match = /^  ([a-z][a-z|-]*)\b/u.exec(line);
      if (!match) continue;
      for (const name of match[1]!.split('|')) names.add(name);
      for (const alias of /\[aliases: ([^\]]+)\]/u.exec(line)?.[1]?.split(', ') ?? []) names.add(alias);
    }
    const declared = INVOCATION_GRAMMAR.commands.flatMap((row) => [...row.names]);
    expect([...new Set(declared)].sort()).toEqual([...names].sort());
  });

  for (const kind of ['utility', 'one-shot', 'elsewhere'] as const) {
    it.each(matrix[kind])(`passes through ${kind}: %j`, (...argv) => {
      expect(invoke(argv)).toMatchObject({ status: 'passthrough', kind });
      expect(invoke(argv, { kind: 'imposter', executable: '/imposter', stateRoot: '/scratch' })).toMatchObject({
        status: 'passthrough',
        kind,
      });
    });
  }
  it.each(matrix.reject)('refuses an unpreserved session clause: %j', (...argv) => {
    expect(invoke(argv)).toMatchObject({
      status: 'rejected',
      argument: expect.any(String),
      reason: expect.any(String),
    });
  });
  it('accepts a bare native session', () => expect(invoke([]).status).toBe('accepted'));
  it('does not mistake unknown arity or post-delimiter arguments for a mode', () => {
    for (const argv of [
      ['--unknown-future-option', '--help'],
      ['--', '--help'],
      ['--', '--version'],
    ]) {
      expect(invoke(argv)).toMatchObject({ status: 'rejected', argument: argv[0] === '--' ? argv[1] : argv[0] });
    }
  });
  it('maps supported aliases and inline values without losing their intent', () => {
    for (const [argv, options] of matrix.mapped) {
      expect(invoke(argv)).toMatchObject({ status: 'accepted', options });
    }
  });
});
