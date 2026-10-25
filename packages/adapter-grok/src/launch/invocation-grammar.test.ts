import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation, NativeInvocationGrammar, NativeInvocationOption } from '@vibefield/puppeteer-core';
import { GROK_COMMANDS, INVOCATION_GRAMMAR, INVOCATION_GRAMMAR_VERSION, LEADER_GRAMMAR } from './invocation-grammar.js';
import { normalizeGrokNativeInvocation as normalize } from './native-invocation.js';

const invoke = (argv: string[], implementation: AgentNativeInvocation['implementation'] = { kind: 'native' }) =>
  normalize({
    providerId: 'grok',
    cwd: '/project',
    argv,
    environment: {},
    implementation,
  });

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/grok-${name}-${INVOCATION_GRAMMAR_VERSION}.txt`, import.meta.url), 'utf8');

interface HelpOption {
  names: string[];
  arity: NativeInvocationOption['arity'];
}

/** clap help: an option line, then its description, which may carry `[aliases: …]`. */
function helpOptions(help: string): HelpOption[] {
  const options: HelpOption[] = [];
  const section = help.split(/^Options:$/mu)[1]!.split(/^\S/mu)[0]!;
  for (const line of section.split('\n')) {
    if (/^ (?: |     )-\S/u.test(line)) {
      const column = line.trimStart().split(/\s{2,}/u)[0]!;
      const names = column.match(/(?<![A-Za-z<])--?[A-Za-z][A-Za-z0-9-]*/gu) ?? [];
      const arity = /\[<[^>]+>\]/u.test(column) ? 'optional' : /<[^>]+>/u.test(column) ? 'one' : 'none';
      options.push({ names: [...names], arity });
      continue;
    }
    const aliases = /^\s+\[aliases: ([^\]]+)\]/u.exec(line)?.[1];
    if (aliases && options.length > 0) options.at(-1)!.names.push(...aliases.split(', '));
  }
  return options;
}

function helpCommands(help: string): string[] {
  const names: string[] = [];
  const commands = help.split(/^Commands:$/mu)[1]!.split('\n\n')[0]!;
  for (const line of commands.split('\n')) {
    const match = /^  ([a-z][a-z|-]*)\b/u.exec(line);
    if (!match) continue;
    names.push(...match[1]!.split('|'));
    names.push(...(/\[aliases: ([^\]]+)\]/u.exec(line)?.[1]?.split(', ') ?? []));
  }
  return names;
}

/** clap names the canonical option in each parse error the probe provoked. */
function probedCanonical(): Map<string, string> {
  const canonical = new Map<string, string>();
  for (const block of fixture('parse-probes').split('\n\n')) {
    const argv = /^\$ grok (\S+)/mu.exec(block)?.[1]?.split('=')[0];
    const target = /^error: .* for '(--[A-Za-z][A-Za-z0-9-]*)/mu.exec(block)?.[1];
    if (argv && target) canonical.set(argv, target);
  }
  return canonical;
}

/** `__fish_grok_global_optspecs`: every root option clap accepts, `=` when it takes a value. */
function fishOptspecs(): Map<string, boolean> {
  const source = readFileSync(
    new URL(`./__fixtures__/grok-global-optspecs-${INVOCATION_GRAMMAR_VERSION}.fish`, import.meta.url),
    'utf8',
  );
  const specs = /string join \\n (.+)$/mu.exec(source)![1]!.trim().split(/\s+/u);
  return new Map(
    specs.map((spec) => {
      const takesValue = spec.endsWith('=');
      const long = spec.replace(/=$/u, '').split('/').at(-1)!;
      return [`--${long}`, takesValue] as const;
    }),
  );
}

function classification(row: NativeInvocationOption) {
  return { arity: row.arity, mapped: row.mapped, passthrough: row.passthrough, reason: row.reason };
}

const options = INVOCATION_GRAMMAR.options as readonly NativeInvocationOption[];
const rowFor = (name: string) => options.find((row) => row.names.includes(name));

const matrix: Record<'utility' | 'one-shot' | 'elsewhere' | 'reject', string[][]> & {
  mapped: [string[], Record<string, unknown>][];
} = {
  utility: [
    ['--help'],
    ['version'],
    ['--model', 'help', 'models'],
    ['--debug', 'sessions', 'list'],
    ['leader'],
    ['leader', 'list'],
    ['leader', '--help'],
    ['leader', '--leader-socket', '/tmp/leader.sock', 'kill'],
    ['memory', 'serve'],
    ['worktree', 'create'],
  ],
  'one-shot': [
    ['-p', 'hi'],
    ['--prompt-json', '[]'],
    ['--print', 'hi'],
    ['--effort', 'high', '-p', 'x'],
    ['--yolo', '-p', 'x'],
    ['--header', 'X-Trace: 1', '-p', 'hi'],
    ['--mode', 'ask', '--single', 'why?'],
  ],
  elsewhere: [
    ['wrap', 'echo', 'hi'],
    ['agent', 'headless'],
    ['agent', 'stdio'],
    ['worker', 'start'],
    ['worker', 'status'],
    ['cursor-worker', 'start'],
    ['leader', 'worker', 'start'],
    ['leader', '--debug', 'worker', 'status'],
    ['--model', 'example', 'leader', 'worker', 'start'],
  ],
  reject: [
    ['--leader-socket', '/tmp/foreign'],
    ['--fork-session'],
    ['dashboard'],
    ['hello'],
    ['--model', '--help'],
    ['--add-dir', '../sibling'],
    ['--effort', 'high'],
    ['--yolo'],
    ['--dangerously-skip-permissions'],
    ['--append-system-prompt', 'be terse'],
    ['--allowed-tools', 'Bash'],
    ['--mode', 'ask'],
  ],
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

describe(`grok ${INVOCATION_GRAMMAR_VERSION} strict invocation grammar`, () => {
  it('accounts for every public root option, alias, and arity in the captured native help, in both directions', () => {
    const help = helpOptions(fixture('help'));
    expect(help).toHaveLength(42);
    const problems: string[] = [];
    for (const option of help) {
      const row = rowFor(option.names[0]!);
      if (!row) problems.push(`new option in grok help: ${option.names.join(', ')}`);
      else if (row.hidden) problems.push(`hidden row now in grok help: ${option.names.join(', ')}`);
      else {
        if ([...row.names].sort().join() !== [...option.names].sort().join()) {
          problems.push(`changed names: ${row.names.join(', ')} -> ${option.names.join(', ')}`);
        }
        if (row.arity !== option.arity)
          problems.push(`changed arity: ${option.names[0]} ${row.arity} -> ${option.arity}`);
      }
    }
    for (const row of options.filter((candidate) => !candidate.hidden)) {
      if (!help.some((option) => option.names.includes(row.names[0]!))) {
        problems.push(`row not in grok help: ${row.names.join(', ')}`);
      }
    }
    expect(problems).toEqual([]);
    const allNames = options.flatMap((row) => [...row.names]);
    expect(new Set(allNames).size).toBe(allNames.length);
  });

  it('holds every hidden option row to a recorded probe: an alias to its canonical option, a native option to its arity', () => {
    const helpNames = new Set(helpOptions(fixture('help')).flatMap((option) => option.names));
    const canonical = probedCanonical();
    const optspecs = fishOptspecs();
    const problems: string[] = [];
    for (const row of options.filter((candidate) => candidate.hidden)) {
      for (const name of row.names) {
        if (helpNames.has(name)) problems.push(`hidden name in grok help: ${name}`);
        const target = canonical.get(name);
        if (target && target !== name) {
          const canonicalRow = rowFor(target);
          if (!canonicalRow || canonicalRow.hidden) problems.push(`${name} resolves to unlisted ${target}`);
          else if (JSON.stringify(classification(row)) !== JSON.stringify(classification(canonicalRow))) {
            problems.push(`${name} does not classify as ${target}`);
          }
        } else if (!optspecs.has(name)) {
          problems.push(`no probe records hidden ${name}`);
        } else if (optspecs.get(name) !== (row.arity !== 'none')) {
          problems.push(`hidden ${name} arity ${row.arity} disagrees with completions.fish`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('accounts for every public command and alias in the captured native help, and records hidden ones', () => {
    const names = helpCommands(fixture('help'));
    const declared = GROK_COMMANDS.filter((row) => !row.hidden).flatMap((row) => [...row.names]);
    expect([...new Set(declared)].sort()).toEqual([...new Set(names)].sort());
    const hidden = GROK_COMMANDS.filter((row) => row.hidden);
    expect(hidden.map((row) => row.names)).toEqual([['cursor-worker']]);
    for (const row of hidden) {
      expect(names).not.toContain(row.names[0]);
      const firstLine = fixture(`${row.names[0]}-help`).split('\n')[0]!;
      expect(row.hidden).toContain(firstLine);
    }
  });

  it('holds the nested leader grammar to `grok leader --help`, in both directions', () => {
    const help = fixture('leader-help');
    const grammar = LEADER_GRAMMAR as NativeInvocationGrammar;
    expect(grammar.commands!.flatMap((row) => [...row.names]).sort()).toEqual(helpCommands(help).sort());
    const leaderOptions = helpOptions(help);
    expect(
      grammar.options
        .map((row) => ({ names: [...row.names].sort(), arity: row.arity }))
        .sort((a, b) => a.names[0]!.localeCompare(b.names[0]!)),
    ).toEqual(
      leaderOptions
        .map((option) => ({ names: [...option.names].sort(), arity: option.arity }))
        .sort((a, b) => a.names[0]!.localeCompare(b.names[0]!)),
    );
    expect(fixture('leader-worker-help').split('\n')[0]).toBe('Run the same commands as `grok worker`');
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
  it('names the extra working directory as the reason --add-dir is refused', () => {
    expect(invoke(['--add-dir', '../sibling'])).toEqual({
      status: 'rejected',
      argument: '--add-dir',
      reason: 'the managed launch cannot preserve extra working directories',
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
