import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CODEX_GRAMMAR_VERSION,
  CODEX_OPTIONS,
  CODEX_SUBCOMMANDS,
  readCodexInvocation,
  type CodexArity,
  type CodexOptionRow,
} from './invocation-grammar.js';

interface HelpOption {
  names: string[];
  arity: CodexArity;
  values?: string[];
  repeatable: boolean;
}

interface Help {
  usage: string[];
  options: HelpOption[];
  commands: Array<{ name: string; aliases: string[] }>;
}

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}-${CODEX_GRAMMAR_VERSION}.txt`, import.meta.url), 'utf8');
}

const OPTION_HEADER = /^ {2,6}(?:(-[A-Za-z0-9]), )?(--[A-Za-z0-9][\w-]*)(?: <([^>]+)>(\.\.\.)?)?\s*$/u;

/** clap's help: `Commands:` rows (continued on deeper-indented lines), `Options:` headers and their notes. */
function parseHelp(text: string): Help {
  const help: Help = { usage: [], options: [], commands: [] };
  let section: 'commands' | 'options' | undefined;
  let option: HelpOption | undefined;
  let command: { name: string; text: string } | undefined;
  let possibleValues = false;
  const endCommand = (): void => {
    if (!command) return;
    const aliases = /\[aliases: ([^\]]+)\]/u.exec(command.text)?.[1];
    help.commands.push({ name: command.name, aliases: aliases ? aliases.split(',').map((alias) => alias.trim()) : [] });
    command = undefined;
  };
  for (const line of text.split('\n')) {
    const usage = /^(?:Usage: | {7})(codex\b.*)$/u.exec(line);
    if (usage) help.usage.push(usage[1]!.trim());
    if (/^[A-Z][A-Za-z ]*:$/u.test(line)) {
      endCommand();
      section = line === 'Commands:' ? 'commands' : line === 'Options:' ? 'options' : undefined;
      continue;
    }
    if (section === 'commands') {
      const start = /^ {2}([a-z][\w-]*) {2,}(.*)$/u.exec(line);
      if (start) {
        endCommand();
        command = { name: start[1]!, text: start[2]! };
      } else if (command && /^ {3,}\S/u.test(line)) {
        command.text = `${command.text} ${line.trim()}`;
      } else if (line.trim() === '') {
        endCommand();
      }
      continue;
    }
    if (section !== 'options') continue;
    const header = OPTION_HEADER.exec(line);
    if (header) {
      option = {
        names: [header[1], header[2]].filter((name): name is string => name !== undefined),
        arity: header[3] === undefined ? 'flag' : header[4] ? 'values' : 'value',
        repeatable: false,
      };
      help.options.push(option);
      possibleValues = false;
      continue;
    }
    if (!option) continue;
    const inline = /\[possible values: ([^\]]+)\]/u.exec(line)?.[1];
    if (inline) option.values = inline.split(',').map((value) => value.trim());
    if (/^\s+Possible values:\s*$/u.test(line)) {
      possibleValues = true;
      option.values = [];
      continue;
    }
    const listed = possibleValues ? /^\s+- ([\w-]+):/u.exec(line)?.[1] : undefined;
    if (listed) option.values!.push(listed);
    if (line.includes('(repeatable)')) option.repeatable = true;
  }
  endCommand();
  return help;
}

function shape(option: { names: readonly string[]; arity: CodexArity }): string {
  const value = option.arity === 'flag' ? '' : option.arity === 'value' ? ' <VALUE>' : ' <VALUE>...';
  return `${option.names.join(', ')}${value}`;
}

/** Both directions: the help's rows against the table, and the table's rows against the help. */
function census(rootHelp: string, resumeHelp: string): string[] {
  const problems: string[] = [];
  const root = parseHelp(rootHelp);
  const resume = parseHelp(resumeHelp);
  const check = (options: HelpOption[], rows: readonly CodexOptionRow[], where: string): void => {
    for (const option of options) {
      const row = rows.find((candidate) => candidate.names.some((name) => option.names.includes(name)));
      if (!row) {
        problems.push(`new option in ${where}: ${shape(option)}`);
        continue;
      }
      if (row.names.join() !== option.names.join()) {
        problems.push(`changed names in ${where}: ${row.names.join(', ')} -> ${option.names.join(', ')}`);
      }
      if (row.arity !== option.arity) problems.push(`changed arity in ${where}: ${shape(row)} -> ${shape(option)}`);
      if ((row.values ?? []).join() !== (option.values ?? []).join()) {
        problems.push(
          `changed values in ${where}: ${option.names.join(', ')} [${(row.values ?? []).join(', ')}] -> [${(option.values ?? []).join(', ')}]`,
        );
      }
      if (option.repeatable && !row.repeatable) problems.push(`now repeatable in ${where}: ${option.names.join(', ')}`);
    }
    for (const row of rows) {
      if (!options.some((option) => option.names.some((name) => row.names.includes(name)))) {
        problems.push(`row not in ${where}: ${shape(row)}`);
      }
    }
  };
  check(
    root.options,
    CODEX_OPTIONS.filter((row) => !row.resumeOnly),
    'codex --help',
  );
  check(resume.options, CODEX_OPTIONS, 'codex resume --help');

  for (const command of root.commands) {
    const row = CODEX_SUBCOMMANDS.find((candidate) => candidate.name === command.name);
    if (!row) {
      problems.push(`new subcommand in codex --help: ${command.name} [${command.aliases.join(', ')}]`);
      continue;
    }
    if (row.hidden) problems.push(`hidden subcommand now in codex --help: ${row.name}`);
    if (row.aliases.join() !== command.aliases.join()) {
      problems.push(
        `changed aliases in codex --help: ${row.name} [${row.aliases.join(', ')}] -> [${command.aliases.join(', ')}]`,
      );
    }
    for (const alias of Object.keys(row.hiddenAliases ?? {})) {
      if (command.aliases.includes(alias)) problems.push(`hidden alias now in codex --help: ${alias}`);
    }
  }
  for (const row of CODEX_SUBCOMMANDS) {
    if (!row.hidden && !root.commands.some((command) => command.name === row.name)) {
      problems.push(`row not in codex --help: ${row.name}`);
    }
  }
  if (!root.usage.includes('codex [OPTIONS] [PROMPT]')) problems.push(`changed usage: ${root.usage.join(' | ')}`);
  if (!resume.usage.includes('codex resume [OPTIONS] [SESSION_ID] [PROMPT]')) {
    problems.push(`changed usage: ${resume.usage.join(' | ')}`);
  }
  return problems;
}

describe(`codex ${CODEX_GRAMMAR_VERSION} grammar census`, () => {
  it('holds every row to the captured help, and the help to the rows', () => {
    const root = parseHelp(fixture('codex-help'));
    const resume = parseHelp(fixture('codex-resume-help'));
    expect(root.options).toHaveLength(24);
    expect(resume.options).toHaveLength(27);
    expect(root.commands).toHaveLength(28);
    expect(census(fixture('codex-help'), fixture('codex-resume-help'))).toEqual([]);
  });

  it('names exactly the new and changed rows when a release changes the help', () => {
    const next = fixture('codex-help')
      .replace('  -m, --model <MODEL>\n', '  -m, --model <MODEL>...\n')
      .replace('      --oss\n          Use open-source provider\n\n', '')
      .replace('      --no-daemon\n', '      --telepathy\n          Read minds\n\n      --no-daemon\n')
      .replace(
        '  features          Inspect feature flags\n',
        '  features          Inspect feature flags\n  teleport          Go elsewhere\n',
      )
      .replace(
        '[possible values: read-only, workspace-write, danger-full-access]',
        '[possible values: read-only, workspace-write]',
      );
    expect(census(next, fixture('codex-resume-help'))).toEqual([
      'changed arity in codex --help: -m, --model <VALUE> -> -m, --model <VALUE>...',
      'changed values in codex --help: -s, --sandbox [read-only, workspace-write, danger-full-access] -> [read-only, workspace-write]',
      'new option in codex --help: --telepathy',
      'row not in codex --help: --oss',
      'new subcommand in codex --help: teleport []',
    ]);
  });

  it('gives every row a class, a landing when carried, and one plain clause when rejected', () => {
    for (const row of CODEX_OPTIONS) {
      expect(row.evidence.length, row.names.join()).toBeGreaterThan(0);
      if (row.class === 'carried') expect(row.landing, row.names.join()).toBeDefined();
      else expect(row.landing, row.names.join()).toBeUndefined();
      if (row.class === 'rejected') expect(row.why, row.names.join()).toMatch(/^[a-zA-Z][^.]*[^.]$/u);
    }
    for (const row of CODEX_SUBCOMMANDS) {
      if (row.hidden) expect(row.hidden).toMatch(/^parse batch3: /u);
      for (const evidence of Object.values(row.hiddenAliases ?? {})) expect(evidence).toMatch(/^parse batch3: /u);
    }
  });
});

describe('the walker reads argv as clap does (parse probes, codex 0.157.1, re-run on 0.164.0)', () => {
  const session = (argv: string[]) => {
    const reading = readCodexInvocation(argv);
    if (reading.kind !== 'session') throw new Error(`expected a session, got ${JSON.stringify(reading)}`);
    return reading.session;
  };
  const values = (argv: string[]) =>
    session(argv).options.map((use) => [use.row.names[use.row.names.length - 1], ...use.values]);

  it('reads a variadic until the next option: it takes a would-be prompt and a subcommand name', () => {
    expect(values(['-i', 'a.png', 'b.png'])).toEqual([['--image', 'a.png', 'b.png']]);
    expect(session(['-i', 'a.png', 'b.png']).prompt).toBeUndefined();
    expect(values(['-i', 'a.png', 'mcp'])).toEqual([['--image', 'a.png', 'mcp']]);
    expect(values(['-i', 'a.png', '--', 'fix it'])).toEqual([['--image', 'a.png']]);
    expect(session(['-i', 'a.png', '--', 'fix it']).prompt?.value).toBe('fix it');
    // An attached value is the whole of it (parse batch5: `--image=a.png mcp --help` prints mcp's help).
    expect(readCodexInvocation(['--image=a.png', 'mcp', 'list'])).toMatchObject({
      kind: 'passthrough',
      passthrough: 'utility',
    });
  });

  it('reads every value spelling clap takes, and none it does not', () => {
    expect(values(['--model=gpt-5'])).toEqual([['--model', 'gpt-5']]);
    expect(values(['-mgpt-5'])).toEqual([['--model', 'gpt-5']]);
    expect(values(['-m=gpt-5'])).toEqual([['--model', 'gpt-5']]);
    expect(values(['-sread-only'])).toEqual([['--sandbox', 'read-only']]);
    expect(values(['-c=k=v', '-ck=w'])).toEqual([
      ['--config', 'k=v'],
      ['--config', 'k=w'],
    ]);
    expect(values(['-i', '-'])).toEqual([['--image', '-']]);
    expect(readCodexInvocation(['-m', '-5'])).toEqual({
      kind: 'rejected',
      reason: 'it is not an option codex documents',
      argument: '-5',
    });
    expect(readCodexInvocation(['--mod', 'x'])).toMatchObject({ kind: 'rejected', argument: '--mod' });
    expect(readCodexInvocation(['--search=true'])).toEqual({
      kind: 'rejected',
      reason: '--search takes no value',
      argument: '--search=true',
    });
  });

  it("holds clap's value sets, its single uses and its one prompt", () => {
    expect(readCodexInvocation(['-s', 'bogus'])).toEqual({
      kind: 'rejected',
      reason: '--sandbox takes read-only, workspace-write or danger-full-access',
      argument: '-s',
    });
    expect(readCodexInvocation(['-a', 'untrusted'])).toMatchObject({
      reason: '--ask-for-approval takes on-request or never',
    });
    expect(readCodexInvocation(['-m', 'a', '-m', 'b'])).toEqual({
      kind: 'rejected',
      reason: '--model can be given only once',
      argument: '-m',
    });
    expect(readCodexInvocation(['-m'])).toMatchObject({ reason: '--model needs a value', argument: '-m' });
    expect(readCodexInvocation(['hello', 'world'])).toEqual({
      kind: 'rejected',
      reason: 'codex takes one prompt',
      argument: 'world',
    });
    expect(readCodexInvocation(['resume', 'a', 'b', 'c'])).toMatchObject({ argument: 'c' });
    expect(values(['-c', 'a=1', '-c', 'b=2', '--add-dir', 'x', '--add-dir', 'y'])).toHaveLength(4);
  });

  it('finds a subcommand after a prompt but never after --, and --help only as an option', () => {
    expect(readCodexInvocation(['hello', 'mcp'])).toMatchObject({ kind: 'passthrough', passthrough: 'utility' });
    expect(session(['--', 'mcp']).prompt?.value).toBe('mcp');
    expect(session(['--', '--help']).prompt?.value).toBe('--help');
    expect(readCodexInvocation(['-m', 'x', '--help'])).toMatchObject({ kind: 'passthrough', passthrough: 'utility' });
    expect(readCodexInvocation(['-hV'])).toMatchObject({ kind: 'passthrough', passthrough: 'utility' });
    expect(readCodexInvocation(['resume', '64a61b19-f4d8-4f96-ba56-07024b470813', '--version'])).toMatchObject({
      kind: 'passthrough',
      passthrough: 'utility',
    });
  });

  it('knows the hidden subcommands and alias, and reads a near miss as a prompt', () => {
    for (const name of ['execpolicy', 'responses-api-proxy', 'stdio-to-uds', 'tcp-tunnel']) {
      expect(readCodexInvocation([name])).toMatchObject({ kind: 'passthrough', passthrough: 'utility' });
    }
    expect(readCodexInvocation(['cloud-tasks'])).toMatchObject({ kind: 'passthrough', passthrough: 'elsewhere' });
    for (const prompt of ['r', 'f', 'mcp-server', 'proto', 'tui', 'constructor', 'toString']) {
      expect(session([prompt]).prompt?.value).toBe(prompt);
    }
  });

  it('lets a passthrough speak for itself: clap errors before it are codex to report', () => {
    expect(readCodexInvocation(['-s', 'bogus', 'mcp', 'list'])).toMatchObject({
      kind: 'passthrough',
      passthrough: 'utility',
    });
    // 0.164.0 parse batch7: `--sandbox bogus migrate-nfs-db --help` prints the subcommand's help.
    expect(readCodexInvocation(['--sandbox', 'bogus', 'migrate-nfs-db', '--help'])).toMatchObject({
      kind: 'passthrough',
      passthrough: 'utility',
    });
    expect(readCodexInvocation(['-m', 'a', '-m', 'b', 'exec', 'q'])).toMatchObject({ passthrough: 'one-shot' });
    // An unknown option's arity is unknown: nothing after it can be read, not even a subcommand.
    expect(readCodexInvocation(['--bogus', 'exec', 'q'])).toEqual({
      kind: 'rejected',
      reason: 'it is not an option codex documents',
      argument: '--bogus',
    });
  });
});
