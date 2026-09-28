import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_BLINDING_TOKENS,
  CLAUDE_ENVIRONMENT_SWITCHES,
  CLAUDE_INVOCATION_GRAMMAR_VERSION,
  CLAUDE_OPTIONS,
  CLAUDE_SUBCOMMANDS,
  claudeSwitchIsOn,
  readClaudeEnvironment,
  readClaudeInvocation,
  type ClaudeOptionArity,
} from './invocation-grammar.js';

const FIXTURES = join(import.meta.dirname, '__fixtures__');

/** The newest `claude-help-<version>.txt`: a fresh capture is what the census reads. */
function newestCapture(): { version: string; text: string } {
  const captures = readdirSync(FIXTURES)
    .map((name) => /^claude-help-(\d+)\.(\d+)\.(\d+)\.txt$/u.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3]));
  const newest = captures.at(-1);
  if (!newest) throw new Error(`no claude-help-<version>.txt in ${FIXTURES}`);
  return { version: `${newest[1]}.${newest[2]}.${newest[3]}`, text: readFileSync(join(FIXTURES, newest[0]), 'utf8') };
}

/** Commander's help: an entry is a line indented exactly two spaces; its usage column ends at two spaces. */
function parseHelp(text: string): {
  options: Array<{ names: string[]; arity: ClaudeOptionArity; spec: string }>;
  subcommands: string[][];
} {
  const options: Array<{ names: string[]; arity: ClaudeOptionArity; spec: string }> = [];
  const subcommands: string[][] = [];
  let section: string | undefined;
  for (const line of text.split('\n')) {
    if (/^\S/u.test(line)) section = line.trim();
    const entry = /^ {2}(\S.*?)(?: {2,}|$)/u.exec(line);
    if (!entry) continue;
    const spec = entry[1]!;
    if (section === 'Options:') {
      const argument = /\s([<[][^\s]*[>\]])$/u.exec(spec);
      const names = (argument ? spec.slice(0, argument.index) : spec).split(', ');
      const value = argument?.[1];
      const arity: ClaudeOptionArity =
        value === undefined ? 'none' : value.includes('...') ? 'variadic' : value.startsWith('<') ? 'one' : 'optional';
      options.push({ names, arity, spec });
    } else if (section === 'Commands:') {
      subcommands.push(spec.split(' ')[0]!.split('|'));
    }
  }
  return { options, subcommands };
}

const key = (names: readonly string[]) => [...names].sort().join(' ');

const read = (...argv: string[]) => readClaudeInvocation(argv);
const kind = (...argv: string[]) => {
  const reading = readClaudeInvocation(argv);
  return reading.status === 'passthrough' ? reading.kind : reading.status;
};

describe('Claude invocation grammar: the census', () => {
  it('pins the table to the newest captured `claude --help`', () => {
    expect(newestCapture().version).toBe(CLAUDE_INVOCATION_GRAMMAR_VERSION);
  });

  it('gives every option in the help a row with the same names and arity, and lists every row the help lacks as hidden', () => {
    const help = parseHelp(newestCapture().text);
    expect(help.options.length).toBeGreaterThan(50);
    const rows = new Map(CLAUDE_OPTIONS.map((row) => [key(row.names), row]));
    const listed = new Set(help.options.map((option) => key(option.names)));
    const drift = {
      // New in the help, or renamed: no row reads it, so the adapter refuses it as unknown.
      withoutRow: help.options.filter((option) => !rows.has(key(option.names))).map((option) => option.spec),
      arityChanged: help.options
        .filter((option) => rows.has(key(option.names)) && rows.get(key(option.names))!.arity !== option.arity)
        .map((option) => `${option.spec} (table: ${rows.get(key(option.names))!.arity})`),
      // Gone from the help, or never in it: a row the CLI may no longer accept.
      notInHelp: CLAUDE_OPTIONS.filter((row) => row.hidden === undefined && !listed.has(key(row.names))).map((row) =>
        row.names.join(', '),
      ),
      hiddenButListed: CLAUDE_OPTIONS.filter((row) => row.hidden !== undefined && listed.has(key(row.names))).map(
        (row) => row.names.join(', '),
      ),
    };
    expect(drift).toEqual({ withoutRow: [], arityChanged: [], notInHelp: [], hiddenButListed: [] });
  });

  it('gives every subcommand in the help a row with the same aliases, and lists every row the help lacks as hidden', () => {
    const help = parseHelp(newestCapture().text);
    expect(help.subcommands.length).toBeGreaterThan(15);
    const rows = new Set(CLAUDE_SUBCOMMANDS.map((row) => key(row.names)));
    const listed = new Set(help.subcommands.map(key));
    const drift = {
      withoutRow: help.subcommands.filter((names) => !rows.has(key(names))).map((names) => names.join('|')),
      notInHelp: CLAUDE_SUBCOMMANDS.filter((row) => row.hidden === undefined && !listed.has(key(row.names))).map(
        (row) => row.names.join('|'),
      ),
      hiddenButListed: CLAUDE_SUBCOMMANDS.filter((row) => row.hidden !== undefined && listed.has(key(row.names))).map(
        (row) => row.names.join('|'),
      ),
    };
    expect(drift).toEqual({ withoutRow: [], notInHelp: [], hiddenButListed: [] });
  });

  it('keeps every name on one row, gives every hidden row its evidence, and every mapped row its target', () => {
    const names = [...CLAUDE_OPTIONS, ...CLAUDE_SUBCOMMANDS].flatMap((row) => row.names);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    for (const row of [...CLAUDE_OPTIONS, ...CLAUDE_SUBCOMMANDS]) {
      if (row.hidden !== undefined) expect(row.hidden.trim(), row.names.join(', ')).not.toBe('');
      expect(row.why.trim(), row.names.join(', ')).not.toBe('');
    }
    for (const row of CLAUDE_OPTIONS) expect(row.maps !== undefined, row.names.join(', ')).toBe(row.class === 'mapped');
  });
});

describe('Claude invocation grammar: the classes', () => {
  it('utility: help, version and every management subcommand, wherever commander reads them', () => {
    for (const argv of [
      ['--version'],
      ['-v'],
      ['-V'],
      ['--help'],
      ['fix the bug', '-v'],
      ['-ch'],
      ['mcp', 'list'],
      ['plugins', 'install', 'x'],
      ['update'],
      ['--update'],
      ['doctor'],
      ['logs', 'abc123'],
      ['stop', 'abc123'],
      ['kill', 'abc123'],
      ['--dangerously-skip-permissions', 'daemon', 'status'],
      ['edit-hook', '--json'],
    ]) {
      expect(kind(...argv), argv.join(' ')).toBe('utility');
    }
  });

  it('elsewhere: a session that does not live in this terminal', () => {
    for (const argv of [
      ['--bg', 'write the tests'],
      ['--background'],
      ['--cloud', 'write the tests'],
      ['--environment', 'ccpool_1'],
      ['--remote'],
      ['attach', 'abc123'],
      ['ultrareview'],
      ['rc'],
      ['remote-control'],
      ['-w', 'feature', '--tmux'],
      ['--worktree=feature', '--tmux=classic'],
    ]) {
      expect(kind(...argv), argv.join(' ')).toBe('elsewhere');
    }
  });

  it('one-shot: -p/--print, whatever else is given', () => {
    for (const argv of [
      ['-p', 'what is 2+2'],
      ['--print', 'what is 2+2'],
      ['--output-format', 'json', '-p', 'q'],
      ['-p', '--session-id', 'x', 'q'],
      ['-p', '--bare', 'q'],
      ['--max-turns', '3', '-p', 'q'],
    ]) {
      expect(kind(...argv), argv.join(' ')).toBe('one-shot');
    }
  });

  it('rejected: what the managed launch owns', () => {
    expect(read('--session-id', '64a61b19-f4d8-4f96-ba56-07024b470813')).toEqual({
      status: 'rejected',
      reason: 'the managed launch gives the session its id itself',
      argument: '--session-id',
    });
    expect(read('--settings', '{"theme":"dark"}')).toMatchObject({ status: 'rejected', argument: '--settings' });
    expect(read('--settings={"x":1}')).toMatchObject({ status: 'rejected', argument: '--settings' });
  });

  it('rejected: what would turn off the hooks the session is observed through, even as another option’s value', () => {
    const blind = { status: 'rejected', reason: 'it turns off the hooks a managed session is observed through' };
    expect(read('--bare')).toEqual({ ...blind, argument: '--bare' });
    expect(read('--safe-mode')).toEqual({ ...blind, argument: '--safe-mode' });
    // The CLI sets its bare mode from the raw argv before it parses, value or not.
    expect(read('--append-system-prompt', '--bare')).toEqual({ ...blind, argument: '--bare' });
    expect(read('--system-prompt', '--safe-mode')).toEqual({ ...blind, argument: '--safe-mode' });
    // After `--` it is a prompt.
    expect(read('--', '--bare')).toMatchObject({ status: 'accepted', prompt: ['--bare'] });
    // Where the raw scan does not reach — nothing is read past an unknown token — the rows refuse.
    expect(read('--bare', '--yolo')).toEqual({ ...blind, argument: '--bare' });
    expect(read('--safe-mode', '--yolo')).toEqual({ ...blind, argument: '--safe-mode' });
    // The raw scan and the table say the same thing.
    for (const token of CLAUDE_BLINDING_TOKENS) {
      expect(
        CLAUDE_OPTIONS.find((row) => row.names.includes(token)),
        token,
      ).toMatchObject({
        class: 'rejected',
        why: blind.reason,
      });
    }
  });

  it('rejected: identity and place', () => {
    expect(read('-c', '--fork-session')).toMatchObject({ status: 'rejected', argument: '--fork-session' });
    expect(read('--teleport')).toMatchObject({ status: 'rejected', argument: '--teleport' });
    expect(read('--teleport', 'session_1')).toMatchObject({ status: 'rejected', argument: '--teleport' });
    expect(read('-w')).toMatchObject({ status: 'rejected', argument: '-w' });
    expect(read('--worktree', 'feature')).toMatchObject({ status: 'rejected', argument: '--worktree' });
    expect(read('--worktree=feature')).toMatchObject({ status: 'rejected', argument: '--worktree' });
    expect(read('--tmux')).toEqual({
      status: 'rejected',
      reason: 'it only works together with --worktree',
      argument: '--tmux',
    });
  });

  it('rejected: a print-only option in an interactive session', () => {
    for (const row of CLAUDE_OPTIONS.filter((candidate) => candidate.class === 'print-only')) {
      const name = row.names.at(-1)!;
      const argv = row.arity === 'none' ? [name] : [name, row.choices?.[0] ?? 'x'];
      expect(readClaudeInvocation(argv), name).toEqual({
        status: 'rejected',
        reason: 'it only works with -p/--print; an interactive session does not take it',
        argument: name,
      });
      expect(readClaudeInvocation(['-p', ...argv, 'q']), name).toMatchObject({
        status: 'passthrough',
        kind: 'one-shot',
      });
    }
  });

  it('accepted: the forms mapped to managed options, as before', () => {
    const id = '64a61b19-f4d8-4f96-ba56-07024b470813';
    expect(read()).toEqual({ status: 'accepted', carriedArgs: [], prompt: [], readsNoSettingsFiles: false });
    expect(read('--resume', id)).toMatchObject({ status: 'accepted', resume: id });
    expect(read('-r', id)).toMatchObject({ status: 'accepted', resume: id });
    expect(read('--continue', '--model', 'sonnet')).toMatchObject({
      status: 'accepted',
      model: 'sonnet',
      resumeInvocation: ['--continue'],
    });
    expect(read('-r', 'search')).toMatchObject({ status: 'accepted', resumeInvocation: ['-r', 'search'] });
    expect(read('--from-pr', '42')).toMatchObject({ status: 'accepted', resumeInvocation: ['--from-pr', '42'] });
    expect(read('--effort', 'high', '--permission-mode', 'plan', '--setting-sources', 'project,local')).toMatchObject({
      status: 'accepted',
      effort: 'high',
      permissionMode: 'plan',
      settingSources: ['project', 'local'],
    });
    expect(read('-n', 'triage')).toMatchObject({ status: 'accepted', title: 'triage', carriedArgs: [] });
  });

  it('accepted: everything else is carried verbatim, in the person’s order, the prompt kept apart', () => {
    expect(
      read('--dangerously-skip-permissions', 'fix the bug', '--add-dir', '../lib', '../docs', '--verbose'),
    ).toMatchObject({
      status: 'accepted',
      carriedArgs: ['--dangerously-skip-permissions', '--add-dir', '../lib', '../docs', '--verbose'],
      prompt: ['fix the bug'],
    });
    expect(read('--mcp-config', 'a.json', 'b.json', '--append-system-prompt', 'Be brief.')).toMatchObject({
      status: 'accepted',
      carriedArgs: ['--mcp-config', 'a.json', 'b.json', '--append-system-prompt', 'Be brief.'],
      prompt: [],
    });
    expect(read('--restricted')).toMatchObject({ status: 'accepted', readsNoSettingsFiles: true });
    // The CLI takes the first operand as the prompt and drops the rest; they ride as typed.
    expect(read('fix', 'the', 'bug')).toMatchObject({ status: 'accepted', prompt: ['fix', 'the', 'bug'] });
  });
});

describe('Claude invocation grammar: commander’s reading', () => {
  it('precedence: help and version over a subcommand over the cloud over print over a refusal', () => {
    expect(kind('--model', 'opus', '-p', 'q')).toBe('one-shot');
    expect(kind('--model', 'opus', 'mcp', 'list')).toBe('utility');
    expect(kind('-p', '--help')).toBe('utility');
    expect(kind('-p', '-v')).toBe('utility');
    expect(kind('--cloud', 'task', '-p')).toBe('elsewhere');
    expect(kind('--session-id', 'x', '-p', 'q')).toBe('one-shot');
    expect(kind('--bare', '--version')).toBe('utility');
  });

  it('`claude "mcp"` is the mcp subcommand: the first operand selects it, quoted or after `--`', () => {
    expect(read('mcp')).toEqual({ status: 'passthrough', kind: 'utility', reason: 'it manages MCP servers' });
    expect(kind('--', 'mcp')).toBe('utility');
    // Only the first operand: after a prompt it is an operand the CLI drops.
    expect(read('fix', 'mcp')).toMatchObject({ status: 'accepted', prompt: ['fix', 'mcp'] });
  });

  it('print mode registers no subcommands: `-p mcp` is a one-shot whose prompt is "mcp"', () => {
    expect(kind('-p', 'mcp', 'list')).toBe('one-shot');
    expect(kind('mcp', 'list', '-p')).toBe('one-shot');
    // The CLI's pre-parse finds only an exact -p token; a cluster does not stop mcp from dispatching.
    expect(kind('-cp', 'mcp')).toBe('utility');
  });

  it('entry dispatch by position: the background commands only as the first argument', () => {
    expect(kind('attach', 'abc123')).toBe('elsewhere');
    expect(read('--verbose', 'attach', 'abc123')).toMatchObject({
      status: 'accepted',
      carriedArgs: ['--verbose'],
      prompt: ['attach', 'abc123'],
    });
    expect(read('--verbose', 'remote')).toMatchObject({ status: 'accepted', prompt: ['remote'] });
    // `--bg` is found anywhere, even after `--`.
    expect(kind('--', '--bg')).toBe('elsewhere');
  });

  it('`--flag=value`', () => {
    expect(read('--model=opus')).toMatchObject({ status: 'accepted', model: 'opus' });
    expect(read('--resume=search term')).toMatchObject({
      status: 'accepted',
      resumeInvocation: ['--resume=search term'],
    });
    // A variadic given with `=` takes that one value; the next token is an operand.
    expect(read('--add-dir=a', 'b')).toMatchObject({ status: 'accepted', carriedArgs: ['--add-dir=a'], prompt: ['b'] });
    // A flag given a value is not a flag commander knows.
    expect(read('--verbose=1')).toMatchObject({ status: 'rejected', argument: '--verbose=1' });
  });

  it('`--` ends the options: a prompt that looks like a flag stays a prompt', () => {
    expect(read('--', '--help')).toMatchObject({ status: 'accepted', prompt: ['--help'] });
    expect(read('--', '-p', 'x')).toMatchObject({ status: 'accepted', prompt: ['-p', 'x'] });
    expect(read('--add-dir', 'a', '--', 'b')).toMatchObject({ carriedArgs: ['--add-dir', 'a'], prompt: ['b'] });
    // A value it needs is the next token, whatever it is, `--` included.
    expect(read('--model', '--', 'x')).toMatchObject({ status: 'accepted', model: '--', prompt: ['x'] });
  });

  it('optional values: taken unless the next token looks like an option; a lone dash is a value', () => {
    // The CLI reads `-d "fix the bug"` as a debug filter, and so does the adapter.
    expect(read('-d', 'fix the bug')).toMatchObject({ carriedArgs: ['-d', 'fix the bug'], prompt: [] });
    expect(read('-d', '--verbose')).toMatchObject({ carriedArgs: ['-d', '--verbose'] });
    expect(read('-r', '-')).toMatchObject({ resumeInvocation: ['-r', '-'] });
    expect(read('-r', '--', 'x')).toMatchObject({ resumeInvocation: ['-r'], prompt: ['x'] });
    expect(read('--remote-control', 'fix the bug')).toMatchObject({
      carriedArgs: ['--remote-control', 'fix the bug'],
      prompt: [],
    });
  });

  it('variadic values: the first whatever it is, then every token until one looks like an option', () => {
    expect(read('--add-dir', 'a', 'b', 'fix it')).toMatchObject({
      carriedArgs: ['--add-dir', 'a', 'b', 'fix it'],
      prompt: [],
    });
    expect(read('fix it', '--add-dir', 'a', 'b')).toMatchObject({
      carriedArgs: ['--add-dir', 'a', 'b'],
      prompt: ['fix it'],
    });
    expect(read('--add-dir', '--verbose', 'a')).toMatchObject({ carriedArgs: ['--add-dir', '--verbose', 'a'] });
    expect(read('--add-dir', 'a', 'mcp')).toMatchObject({ status: 'accepted', carriedArgs: ['--add-dir', 'a', 'mcp'] });
  });

  it('short clusters, as commander splits them', () => {
    expect(read('-cd')).toMatchObject({ resumeInvocation: ['-c'], carriedArgs: ['-d'] });
    expect(read('-dc')).toMatchObject({ carriedArgs: ['-dc'] });
    expect(read('-nfoo')).toMatchObject({ title: 'foo' });
    expect(kind('-cv')).toBe('utility');
    expect(read('-cr')).toMatchObject({ status: 'rejected', argument: '-r' });
    // Commander keeps -h apart from the other options: it cannot lead a cluster.
    expect(read('-hc')).toMatchObject({ status: 'rejected', argument: '-hc' });
    // A multi-letter short name is matched whole.
    expect(read('-d2e')).toMatchObject({ carriedArgs: ['-d2e'] });
  });

  it('an unknown token is refused by name: its arity cannot be known, so nothing after it is read', () => {
    const unknown = (token: string) => ({
      status: 'rejected',
      reason: `this version of the Claude adapter (Claude Code ${CLAUDE_INVOCATION_GRAMMAR_VERSION}) does not know it`,
      argument: token,
    });
    expect(read('--yolo')).toEqual(unknown('--yolo'));
    expect(read('-x', 'fix the bug')).toEqual(unknown('-x'));
    expect(read('--yolo', '-v')).toEqual(unknown('--yolo'));
    expect(read('-V', 'x')).toEqual(unknown('-V'));
    // What was read before it stands.
    expect(kind('-v', '--yolo')).toBe('utility');
    expect(kind('-p', '--yolo')).toBe('one-shot');
    expect(read('--session-id', 'x', '--yolo')).toMatchObject({ status: 'rejected', argument: '--session-id' });
  });

  it('refuses what the CLI itself refuses while parsing, naming the option', () => {
    expect(read('--model')).toEqual({ status: 'rejected', reason: 'it needs a value', argument: '--model' });
    expect(read('--add-dir')).toMatchObject({ status: 'rejected', argument: '--add-dir' });
    expect(read('--permission-mode', 'yolo')).toMatchObject({ status: 'rejected', argument: '--permission-mode' });
    expect(read('--permission-mode', 'default')).toMatchObject({ status: 'accepted', permissionMode: 'default' });
    expect(read('--permission-mode', 'manual')).toMatchObject({ status: 'accepted', permissionMode: 'manual' });
    expect(read('--system-prompt-snapshot', 'maybe')).toMatchObject({ status: 'rejected' });
    expect(read('--setting-sources', 'managed')).toMatchObject({ status: 'rejected', argument: '--setting-sources' });
    expect(read('--model', 'a', '--model', 'b')).toMatchObject({ status: 'rejected', argument: '--model' });
    expect(read('-c', '--resume')).toMatchObject({ status: 'rejected', argument: '--resume' });
  });

  it('import: the CLI rewrites it into a session that runs /import before it parses', () => {
    const importing = {
      status: 'rejected',
      reason: 'it starts a session that runs /import, which the managed launch does not carry',
      argument: 'import',
    };
    expect(read('import')).toEqual(importing);
    expect(read('import', 'codex', '--dry-run')).toEqual(importing);
    expect(read('--verbose', 'import', 'cursor')).toEqual(importing);
    expect(kind('-p', 'import', 'codex')).toBe('one-shot');
    // Not the rewrite's shape: the import subcommand, which prints its usage.
    expect(kind('--verbose', 'import')).toBe('utility');
    expect(kind('import', '--help')).toBe('utility');
  });

  it('refuses arguments the managed launch could not pass on as the CLI read them', () => {
    // Typed, --add-dir takes both values. Rebuilt with the managed flags first and --model among
    // them, the CLI's entry would take `import codex` for its import rewrite.
    expect(read('--add-dir', 'import', 'codex', '--model', 'opus')).toEqual({
      status: 'rejected',
      reason: 'the managed launch could not pass these arguments on as typed',
      argument: '--add-dir',
    });
    expect(read('--add-dir', 'import', 'extra', '--model', 'opus')).toMatchObject({ status: 'accepted' });
    // Typed without --model, the CLI rewrites it itself.
    expect(read('--add-dir', 'import', 'codex')).toMatchObject({ status: 'rejected', argument: 'import' });
  });

  it('a deep link is refused', () => {
    expect(read('--handle-uri', 'claude-cli://open')).toMatchObject({ status: 'rejected', argument: '--handle-uri' });
  });
});

describe('Claude invocation grammar: the environment', () => {
  const blind = 'it turns off the hooks a managed session is observed through';

  it('reads a switch as the CLI does: 1, true, yes or on, in any case, trimmed', () => {
    for (const on of ['1', 'true', 'yes', 'on', 'TRUE', 'On', ' yes ']) expect(claudeSwitchIsOn(on), on).toBe(true);
    for (const off of [undefined, '', '0', 'false', 'no', 'off', '2', 'enabled', 'y']) {
      expect(claudeSwitchIsOn(off), String(off)).toBe(false);
    }
  });

  it('CLAUDE_CODE_SIMPLE stands for --bare: on, it is refused by name; off, nothing changes', () => {
    expect(readClaudeEnvironment({ CLAUDE_CODE_SIMPLE: '1' })).toEqual({
      refusal: { reason: blind, argument: 'CLAUDE_CODE_SIMPLE=1' },
      readsNoSettingsFiles: false,
    });
    expect(readClaudeEnvironment({ CLAUDE_CODE_SIMPLE: 'yes' }).refusal?.argument).toBe('CLAUDE_CODE_SIMPLE=yes');
    expect(readClaudeEnvironment({ CLAUDE_CODE_SIMPLE: '0' })).toEqual({ readsNoSettingsFiles: false });
    expect(readClaudeEnvironment({ CLAUDE_CODE_SIMPLE: '' })).toEqual({ readsNoSettingsFiles: false });
  });

  it('CLAUDE_CODE_SAFE_MODE stands for --safe-mode: on, it is refused by name; off, nothing changes', () => {
    expect(readClaudeEnvironment({ CLAUDE_CODE_SAFE_MODE: 'true' })).toEqual({
      refusal: { reason: blind, argument: 'CLAUDE_CODE_SAFE_MODE=true' },
      readsNoSettingsFiles: false,
    });
    expect(readClaudeEnvironment({ CLAUDE_CODE_SAFE_MODE: 'false' })).toEqual({ readsNoSettingsFiles: false });
  });

  it('CLAUDE_CODE_RESTRICTED stands for --restricted: on, the session reads no settings files; off, it does', () => {
    expect(readClaudeEnvironment({ CLAUDE_CODE_RESTRICTED: '1' })).toEqual({ readsNoSettingsFiles: true });
    expect(readClaudeEnvironment({ CLAUDE_CODE_RESTRICTED: '0' })).toEqual({ readsNoSettingsFiles: false });
    // A blinding switch is still refused beside it.
    expect(readClaudeEnvironment({ CLAUDE_CODE_RESTRICTED: '1', CLAUDE_CODE_SIMPLE: 'on' }).refusal?.argument).toBe(
      'CLAUDE_CODE_SIMPLE=on',
    );
  });

  it('each switch does what the flag it stands for does', () => {
    for (const row of CLAUDE_ENVIRONMENT_SWITCHES) {
      const flag = CLAUDE_OPTIONS.find((option) => option.names.includes(row.flag));
      expect(flag, row.name).toBeDefined();
      expect(row.class, row.name).toBe(flag!.class);
      expect(row.why, row.name).toBe(flag!.why);
      expect(row.readsNoSettingsFiles === true, row.name).toBe(flag!.readsNoSettingsFiles === true);
    }
  });
});
