import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation, NativeInvocationOption } from '@vibefield/puppeteer-core';
import { INVOCATION_GRAMMAR, INVOCATION_GRAMMAR_VERSION } from './invocation-grammar.js';
import { normalizeCopilotNativeInvocation as normalize } from './native-invocation.js';

const invoke = (argv: string[], implementation: AgentNativeInvocation['implementation'] = { kind: 'native' }) =>
  normalize({
    providerId: 'copilot',
    cwd: '/project',
    argv,
    environment: {},
    implementation,
  });

const matrix: Record<'utility' | 'one-shot' | 'elsewhere' | 'reject', string[][]> & {
  mapped: [string[], Record<string, unknown>][];
} = {
  utility: [
    ['--help'],
    ['version'],
    ['--model', 'example', 'plugin', 'list'],
    ['config'],
    ['sandbox'],
    // `--sync-session[=<on|off>]` takes its value only with `=`, so the command after it still counts.
    ['--sync-session', 'version'],
    ['--sync-session', '--version'],
  ],
  'one-shot': [
    ['-p', 'hello'],
    ['--prompt=hello', '--allow-tool', 'read', 'write'],
    ['workflow', 'run', 'x'],
  ],
  elsewhere: [
    ['--acp'],
    ['--connect'],
    ['app'],
    ['--host-environment', 'x'],
    // A refused modifier before it does not hide the headless environment.
    ['--host-compute-id', 'y', '--host-environment', 'x'],
  ],
  reject: [
    ['--resume'],
    ['--continue'],
    ['-i', 'hello'],
    ['--session-id', '../bad'],
    ['--model', '--help'],
    ['--trust-folder'],
    ['--sync-session'],
    ['--sync-session=off'],
    ['--host-compute-id', 'x'],
    ['--remote'],
    ['--no-remote-export'],
  ],
  mapped: [
    [
      ['--model=example', '-nwork'],
      {
        model: 'example',
        name: 'work',
      },
    ],
  ],
};

describe('copilot strict invocation grammar', () => {
  it('accounts for every public root option in the captured native help, in both directions', () => {
    const help = readFileSync(
      new URL(`./__fixtures__/copilot-help-${INVOCATION_GRAMMAR_VERSION}.txt`, import.meta.url),
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

    // `--flag[=<value>]` is clap's require-equals notation: the row must never take the next argument as its value.
    const requireEquals = [...help.matchAll(/^ {6}(--[A-Za-z0-9-]+)\[=</gmu)].map((match) => match[1]!);
    expect(requireEquals).toEqual(['--sync-session']);
    for (const name of requireEquals) {
      const row = (INVOCATION_GRAMMAR.options as readonly NativeInvocationOption[]).find((option) =>
        option.names.includes(name),
      );
      expect(row, name).toMatchObject({ arity: 'optional', requireEquals: true });
    }
  });

  it('accounts for every public command and alias in the captured native help', () => {
    const help = readFileSync(
      new URL(`./__fixtures__/copilot-help-${INVOCATION_GRAMMAR_VERSION}.txt`, import.meta.url),
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
