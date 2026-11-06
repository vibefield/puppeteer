import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeConfigRoot } from '../launch/config-root.js';
import {
  createClaudeSessionSelection,
  type ClaudeSessionRefusal,
  type ClaudeSessionSelection,
  type ClaudeSessionSelectionOptions,
} from './session-selection.js';

const X = '00000000-0000-4000-8000-00000000000a';
const Y = '00000000-0000-4000-8000-00000000000b';
const Z = '00000000-0000-4000-8000-00000000000c';
const ROOT = resolve('/claude-root');

/** One request as the bridge asks about it: a hook by its event name, or a status line. */
type Request = [sessionId: string, hook: string, fields?: Record<string, unknown>];

/** Each request's verdict and the id selected after it, in order. */
function verdicts(selection: ClaudeSessionSelection, requests: readonly Request[]) {
  return requests.map(([sessionId, hook, fields = {}]) => {
    const verdict =
      hook === 'statusline'
        ? selection.verdict(sessionId, 'statusline', { session_id: sessionId, ...fields })
        : selection.verdict(sessionId, 'hook', { session_id: sessionId, hook_event_name: hook, ...fields });
    return [verdict, selection.selected()];
  });
}

const launch = (options: Partial<ClaudeSessionSelectionOptions> = {}) =>
  createClaudeSessionSelection({ mode: 'launch', selected: X, root: ROOT, ...options });

describe('createClaudeSessionSelection: which session a launch follows', () => {
  it('follows /clear unconditionally, as captured: the end, then the start under the new id', () => {
    expect(
      verdicts(launch(), [
        [X, 'SessionStart', { source: 'startup' }],
        [X, 'SessionEnd', { reason: 'clear' }],
        [Y, 'SessionStart', { source: 'clear' }],
        [X, 'Stop'],
        [Y, 'Stop'],
      ]),
    ).toEqual([
      [true, X],
      [true, X],
      ['rotate', Y],
      [false, Y],
      [true, Y],
    ]);
  });

  it('follows /resume when the observed session ended for it and said nothing since', () => {
    expect(
      verdicts(launch(), [
        [X, 'UserPromptSubmit'],
        [X, 'SessionEnd', { reason: 'resume' }],
        [Y, 'SessionStart', { source: 'resume' }],
        [X, 'Stop'],
        [Y, 'UserPromptSubmit'],
      ]),
    ).toEqual([
      [true, X],
      [true, X],
      ['rotate', Y],
      [false, Y],
      [true, Y],
    ]);
  });

  it('refuses a resume start no end announced, another id’s end, and an end the session went on from', () => {
    expect(
      verdicts(launch(), [
        [Y, 'SessionStart', { source: 'resume' }],
        [Z, 'SessionEnd', { reason: 'resume' }],
        [Y, 'SessionStart', { source: 'resume' }],
        [X, 'SessionEnd', { reason: 'resume' }],
        [X, 'Stop'],
        [Y, 'SessionStart', { source: 'resume' }],
        [X, 'SessionEnd', { reason: 'prompt_input_exit' }],
        [Y, 'SessionStart', { source: 'resume' }],
      ]),
    ).toEqual([
      [false, X],
      [false, X],
      [false, X],
      [true, X],
      [true, X],
      [false, X],
      [true, X],
      [false, X],
    ]);
  });

  it('never follows a fork: the /fork background copy announces the same source while the pane stays', () => {
    expect(
      verdicts(launch(), [
        [Y, 'SessionStart', { source: 'fork' }],
        [X, 'SessionEnd', { reason: 'other' }],
        [Y, 'SessionStart', { source: 'fork' }],
        [X, 'SessionEnd', { reason: 'resume' }],
        [Y, 'SessionStart', { source: 'fork' }],
      ]),
    ).toEqual([
      [false, X],
      [true, X],
      [false, X],
      [true, X],
      [false, X],
    ]);
  });

  it('neither arms nor rotates on a status line', () => {
    expect(
      verdicts(launch(), [
        [X, 'statusline'],
        [Y, 'statusline'],
        [X, 'SessionEnd', { reason: 'resume' }],
        [X, 'statusline'],
        [Y, 'SessionStart', { source: 'resume' }],
      ]),
    ).toEqual([
      [true, X],
      [false, X],
      [true, X],
      [true, X],
      ['rotate', Y],
    ]);
  });

  it('tells its listeners each refused hook, and never a refused status line or an ignored boot session', () => {
    const refusals: ClaudeSessionRefusal[] = [];
    const selection = launch();
    selection.onRefused((refusal) => refusals.push(refusal));
    verdicts(selection, [
      [Y, 'SessionStart', { source: 'fork' }],
      [Y, 'UserPromptSubmit'],
      [Y, 'statusline'],
      [X, 'Stop'],
    ]);
    expect(refusals).toEqual([
      { sessionId: Y, hookEventName: 'SessionStart', source: 'fork' },
      { sessionId: Y, hookEventName: 'UserPromptSubmit', source: undefined },
    ]);
    const picker = launch({ selected: undefined, resumeInvocation: true });
    const pickerRefusals: ClaudeSessionRefusal[] = [];
    picker.onRefused((refusal) => pickerRefusals.push(refusal));
    expect(verdicts(picker, [[Z, 'SessionStart', { source: 'startup' }]])).toEqual([['ignore', undefined]]);
    expect(pickerRefusals).toEqual([]);
  });
});

describe('createClaudeSessionSelection: a native picker chooses after launch', () => {
  const B = '00000000-0000-4000-8000-0000000000b0';

  it('ignores the boot session, lets the choice move until the chosen session runs a hook, then holds it', () => {
    expect(
      verdicts(launch({ selected: undefined, resumeInvocation: true }), [
        [B, 'SessionStart', { source: 'startup' }],
        [B, 'InstructionsLoaded', { load_reason: 'session_start' }],
        [X, 'statusline'],
        [X, 'SessionStart'],
        [Y, 'SessionStart', { source: 'resume' }],
        [X, 'statusline'],
        [Y, 'InstructionsLoaded', { load_reason: 'session_start' }],
        [X, 'SessionStart', { source: 'resume' }],
        [B, 'SessionEnd', { reason: 'other' }],
        [Y, 'UserPromptSubmit'],
      ]),
    ).toEqual([
      ['ignore', undefined],
      ['ignore', undefined],
      [true, undefined],
      [true, X],
      [true, Y],
      [false, Y],
      [true, Y],
      [false, Y],
      ['ignore', Y],
      [true, Y],
    ]);
  });

  it('follows /clear and an armed /resume once the choice holds', () => {
    expect(
      verdicts(launch({ selected: undefined, resumeInvocation: true }), [
        [X, 'SessionStart', { source: 'resume' }],
        [X, 'UserPromptSubmit'],
        [X, 'SessionEnd', { reason: 'resume' }],
        [Y, 'SessionStart', { source: 'resume' }],
        [X, 'Stop'],
        [Y, 'SessionEnd', { reason: 'clear' }],
        [Z, 'SessionStart', { source: 'clear' }],
        [Y, 'Stop'],
      ]),
    ).toEqual([
      [true, X],
      [true, X],
      [true, X],
      ['rotate', Y],
      [false, Y],
      [true, Y],
      ['rotate', Z],
      [false, Z],
    ]);
  });
});

describe('createClaudeSessionSelection: an attach follows the running process', () => {
  /** A config root holding a conversation for each id. */
  function rootWith(...ids: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'session-selection-root-'));
    const project = join(root, 'projects', '-work');
    mkdirSync(project, { recursive: true });
    for (const id of ids) writeFileSync(join(project, `${id}.jsonl`), '');
    return root;
  }

  it('takes the first hook under a new id with a conversation on disk as a /clear typed while no host listened', () => {
    const root = rootWith(X, Y);
    try {
      const selection = createClaudeSessionSelection({ mode: 'attach', selected: X, root });
      const located: string[] = [];
      selection.onUnheardRotation((transcript) => located.push(transcript));
      expect(
        verdicts(selection, [
          [Z, 'UserPromptSubmit'],
          [Y, 'UserPromptSubmit'],
          [X, 'UserPromptSubmit'],
          [Y, 'Stop'],
        ]),
      ).toEqual([
        [false, X],
        [true, Y],
        [false, Y],
        [true, Y],
      ]);
      expect(located).toEqual([join(root, 'projects', '-work', `${Y}.jsonl`)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the attached id once it has spoken, and follows /clear and an armed /resume heard live', () => {
    const root = rootWith(X, Y);
    try {
      expect(
        verdicts(createClaudeSessionSelection({ mode: 'attach', selected: X, root }), [
          [X, 'Stop'],
          [Y, 'UserPromptSubmit'],
          [X, 'SessionEnd', { reason: 'resume' }],
          [Z, 'SessionStart', { source: 'resume' }],
          [X, 'Stop'],
          [Y, 'SessionStart', { source: 'clear' }],
          [Y, 'SessionStart', { source: 'fork' }],
        ]),
      ).toEqual([
        [true, X],
        [false, X],
        [true, X],
        ['rotate', Z],
        [false, Z],
        ['rotate', Y],
        [true, Y],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createClaudeSessionSelection: the transcript the rail may follow', () => {
  const projects = join(ROOT, 'projects');

  it('is the selected session’s own file, one folder under the root’s projects, and nothing else', () => {
    const selection = launch();
    const own = join(projects, '-work', `${X}.jsonl`);
    expect(selection.transcriptFor(own)).toBe(own);
    // `..` is read as resolved: a folder beside it is still one folder under projects
    expect(selection.transcriptFor([projects, '-work', '..', '-other', `${X}.jsonl`].join(sep))).toBe(
      join(projects, '-other', `${X}.jsonl`),
    );
    for (const refused of [
      // another session's file under the root
      join(projects, '-work', `${Y}.jsonl`),
      // the selected id's name anywhere else
      join(resolve('/tmp'), `${X}.jsonl`),
      join(ROOT, `${X}.jsonl`),
      join(projects, `${X}.jsonl`),
      join(projects, '-work', 'deeper', `${X}.jsonl`),
      join(projects, '-work', X, 'subagents', `${X}.jsonl`),
      [projects, '..', '..', 'elsewhere', 'projects', '-work', `${X}.jsonl`].join(sep),
      join(`${ROOT}-sibling`, 'projects', '-work', `${X}.jsonl`),
    ]) {
      expect(selection.transcriptFor(refused), refused).toBeUndefined();
    }
  });

  it('follows the selection: a rotation pins the new id’s file, a picker that chose nothing pins none', () => {
    const selection = launch();
    verdicts(selection, [[Y, 'SessionStart', { source: 'clear' }]]);
    expect(selection.transcriptFor(join(projects, '-work', `${Y}.jsonl`))).toBe(join(projects, '-work', `${Y}.jsonl`));
    expect(selection.transcriptFor(join(projects, '-work', `${X}.jsonl`))).toBeUndefined();
    const picker = launch({ selected: undefined, resumeInvocation: true });
    expect(picker.transcriptFor(join(projects, '-work', `${X}.jsonl`))).toBeUndefined();
  });

  it('pins the imposter’s files under its own state root', () => {
    const imposter = resolve('/imposter-home');
    const root = claudeConfigRoot({ cwd: resolve('/work'), env: { PUPPETEER_IMPOSTER_HOME: imposter } });
    const selection = createClaudeSessionSelection({ mode: 'launch', selected: X, root });
    const own = join(imposter, 'projects', '-work', `${X}.jsonl`);
    expect(selection.transcriptFor(own)).toBe(own);
  });

  it('matches a path through a link by where its folders really are, and names the file under the root', () => {
    const base = mkdtempSync(join(tmpdir(), 'session-selection-link-'));
    try {
      const real = join(base, 'real');
      const link = join(base, 'link');
      mkdirSync(join(real, 'projects', '-work'), { recursive: true });
      symlinkSync(real, link, 'junction');
      const realFile = join(real, 'projects', '-work', `${X}.jsonl`);
      const linkedFile = join(link, 'projects', '-work', `${X}.jsonl`);
      // the root named through the link, the hook's path through the real folders, and the other way round: the answer
      // is the root's own name for the file, never the hook's
      const throughLink = createClaudeSessionSelection({ mode: 'launch', selected: X, root: link });
      expect(throughLink.transcriptFor(realFile)).toBe(linkedFile);
      const throughReal = createClaudeSessionSelection({ mode: 'launch', selected: X, root: real });
      expect(throughReal.transcriptFor(linkedFile)).toBe(realFile);
      // a link outside the root to the root's own folder: the rail keeps the root's name, so pointing the link
      // elsewhere later moves nothing
      const outside = join(base, 'outside');
      symlinkSync(join(real, 'projects', '-work'), outside, 'junction');
      expect(throughReal.transcriptFor(join(outside, `${X}.jsonl`))).toBe(realFile);
      // a folder that is not there is read only as written
      expect(throughLink.transcriptFor(join(real, 'projects', '-gone', `${X}.jsonl`))).toBeUndefined();
      expect(throughLink.transcriptFor(join(real, 'projects', '-work', `${Y}.jsonl`))).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
