import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation, NativeInvocationOption } from '@vibefield/puppeteer-core';
import { INVOCATION_GRAMMAR, INVOCATION_GRAMMAR_VERSION } from './invocation-grammar.js';
import { normalizeOpenCodeNativeInvocation as normalize } from './native-invocation.js';

const invoke = (argv: string[], implementation: AgentNativeInvocation['implementation'] = { kind: 'native' }) =>
  normalize({
    providerId: 'opencode',
    cwd: '/project',
    argv,
    environment: {},
    implementation,
  });

const matrix: Record<'utility' | 'one-shot' | 'elsewhere' | 'reject', string[][]> & {
  mapped: [string[], Record<string, unknown>][];
} = {
  utility: [['--help'], ['models'], ['--log-level', 'DEBUG', 'providers', 'list']],
  'one-shot': [['run', 'hello']],
  elsewhere: [['attach', 'http://localhost:1234'], ['serve'], ['web'], ['acp']],
  reject: [['--continue'], ['--model', 'p/model'], ['--prompt', 'hello'], ['pr', '42'], ['project']],
  mapped: [],
};

describe('opencode strict invocation grammar', () => {
  it('accounts for every public root option in the captured native help, in both directions', () => {
    const help = readFileSync(
      new URL(`./__fixtures__/opencode-help-${INVOCATION_GRAMMAR_VERSION}.txt`, import.meta.url),
      'utf8',
    );
    const publicNames = new Set<string>();
    for (const line of help.split('\n')) {
      if (!/^ (?: |     )-\S/u.test(line)) continue;
      const column = line.trimStart().split(/\s{2,}/u)[0]!;
      for (const name of column.match(/(?<![A-Za-z])--?[A-Za-z][A-Za-z0-9-]*/gu) ?? []) publicNames.add(name);
    }

    const table = (INVOCATION_GRAMMAR.options as readonly NativeInvocationOption[])
      .filter((row) => !row.hidden)
      .flatMap((row) => row.names);
    expect([...new Set(table)].sort()).toEqual([...publicNames].sort());
    const allNames = INVOCATION_GRAMMAR.options.flatMap((row) => [...row.names]);
    expect(new Set(allNames).size).toBe(allNames.length);
  });

  it('accounts for every public command and alias in the captured native help', () => {
    const help = readFileSync(
      new URL(`./__fixtures__/opencode-help-${INVOCATION_GRAMMAR_VERSION}.txt`, import.meta.url),
      'utf8',
    );
    const names = new Set<string>();
    for (const line of help.split('\n')) {
      const match = /^  opencode ([a-z][a-z-]*)\b/u.exec(line);
      if (!match) continue;
      names.add(match[1]!);
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
  it('uses the final native help/version value before deciding passthrough', () => {
    for (const argv of [
      ['--help', '--help=false'],
      ['--version', '--version=false'],
      ['-h', '--help', 'false'],
      ['-v', '--version', 'false'],
      ['--help', '-h=false'],
      ['--version', '-v=false'],
      ['--help', 'false'],
      ['--help', '--no-help'],
      ['--version', '--no-version'],
    ]) {
      expect(invoke(argv), argv.join(' ')).toMatchObject({ status: 'rejected' });
    }
    for (const argv of [
      ['--help=false', '--help'],
      ['--version', 'false', '-v'],
      ['--help', '--', '--help=false'],
      ['--help', '--prompt=--help=false'],
    ]) {
      expect(invoke(argv), argv.join(' ')).toMatchObject({ status: 'passthrough', kind: 'utility' });
    }
  });
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
