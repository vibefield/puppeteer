import { describe, expect, it } from 'vitest';
import {
  agentActivity,
  agentAlive,
  agentDetail,
  agentEffort,
  agentObserved,
  agentReply,
  agentStatus,
  agentStatusSince,
  agentTokens,
  agentWait,
  boundText,
  classifyTerminalStatus,
  deriveAgentRow,
  deriveTerminalRow,
  folderName,
  isStale,
  personaSets,
  projectBranch,
  projectKey,
  projectName,
  resolveProfileSet,
} from './derive.js';
import { DEVICE, T0, hostRun, hostTerminal, iso, monitorState } from './testing/fixtures.js';

const derive = (host = hostRun(), state = monitorState(), seq?: number) =>
  deriveAgentRow({
    id: 'row',
    host,
    state,
    device: DEVICE,
    seq,
    profileSet: 'native',
    stale: false,
    cost: undefined,
    unread: false,
    replyMaxLength: 280,
  });

/** The row of a run nobody has heard from: no state at all (a default parameter would swallow an explicit undefined). */
const deriveUnheard = (host = hostRun()) =>
  deriveAgentRow({
    id: 'row',
    host,
    state: undefined,
    device: DEVICE,
    seq: undefined,
    profileSet: 'native',
    stale: false,
    cost: undefined,
    unread: false,
    replyMaxLength: 280,
  });

describe('status, since, alive, pending', () => {
  it('takes the runtime word, calls a pending run idle, and a run nobody heard from working', () => {
    expect(agentStatus(hostRun(), monitorState({ status: 'blocked' }))).toBe('blocked');
    expect(agentStatus(hostRun({ pending: 'resume-when-idle' }), monitorState({ status: 'blocked' }))).toBe('idle');
    expect(agentStatus(hostRun(), undefined)).toBe('working');
  });
  it('dates the status from the runtime, else from the birth', () => {
    expect(agentStatusSince(hostRun(), monitorState({ statusSince: iso(T0 + 5_000) }))).toBe(T0 + 5_000);
    expect(agentStatusSince(hostRun({ createdAt: 7 }), undefined)).toBe(7);
    expect(agentStatusSince(hostRun({ createdAt: 7 }), monitorState({ statusSince: 'not a date' }))).toBe(7);
  });
  it("lets the host's witnessed exit outrank a lagging mirror, else keeps the runtime's word", () => {
    expect(agentAlive(hostRun({ alive: false }), monitorState({ alive: true }))).toBe(false);
    expect(agentAlive(hostRun(), monitorState({ alive: false }))).toBe(false);
    expect(agentAlive(hostRun({ alive: true }), monitorState({ alive: false }))).toBe(false);
    expect(agentAlive(hostRun(), undefined)).toBe(true);
  });
  it('marks pending on the row only when the host says so', () => {
    expect(derive().pending).toBeUndefined();
    expect(derive(hostRun({ pending: 'resume-when-idle' })).pending).toBe(true);
  });
});

describe('detail', () => {
  it('is the headline: the activity line while working, the blocker while blocked, idle when idle', () => {
    expect(agentDetail(hostRun(), monitorState())).toBe('Edit · src/app.ts');
    expect(
      agentDetail(
        hostRun(),
        monitorState({
          status: 'blocked',
          blockers: [{ id: 'b', kind: 'permission', since: iso(T0), permission: { requestId: 'r', tool: 'Bash' } }],
        }),
      ),
    ).toBe('permission · Bash');
    expect(agentDetail(hostRun(), monitorState({ status: 'idle', activity: undefined }))).toBe('idle');
  });
  it('words the two host-known states', () => {
    expect(agentDetail(hostRun({ pending: 'resume-when-idle' }), monitorState())).toBe(
      'unobserved · resumes when idle',
    );
    expect(agentDetail(hostRun({ pending: 'later' }), monitorState())).toBe('unobserved');
    expect(agentDetail(hostRun(), undefined)).toBe('starting');
  });
});

describe('project', () => {
  it('names the observed directory first, then the workspace, then the terminal, then the provider', () => {
    const host = hostRun({ workspace: { sourcePath: '/w/src-path', root: '/w/root' }, cwd: '/w/pty' });
    expect(projectName(host, monitorState({ environment: { cwd: '/w/observed/', worktrees: [] } }))).toBe('observed');
    expect(projectName(host, monitorState())).toBe('src-path');
    expect(projectName(hostRun({ workspace: { root: '/w/root' }, cwd: '/w/pty' }), undefined)).toBe('root');
    expect(projectName(hostRun({ cwd: '/w/pty' }), undefined)).toBe('pty');
    expect(projectName(hostRun(), undefined)).toBe('Claude Code');
    expect(projectName(hostRun({ provider: { id: 'codex', label: '  ' } }), undefined)).toBe('codex');
  });
  it('lets the git observation answer, null included, and falls through only when nothing looked', () => {
    const host = hostRun({ workspace: { branch: 'main' } });
    expect(projectBranch(host, monitorState({ environment: { git: null, worktrees: [] } }))).toBeNull();
    expect(
      projectBranch(host, monitorState({ environment: { git: { branch: 'feat' } as never, worktrees: [] } })),
    ).toBe('feat');
    expect(projectBranch(host, monitorState())).toBe('main');
    expect(projectBranch(hostRun(), undefined)).toBeUndefined();
  });
  it('falls back to the branch the host supplies whenever the observation names none (M26), and only then', () => {
    // VibeField supplies none: the rule above, unchanged (looked and none is null; nothing looked is the workspace's).
    const vibefield = hostRun({ workspace: { branch: 'main' } });
    const detached = monitorState({ environment: { git: { branch: undefined } as never, worktrees: [] } });
    expect(projectBranch(vibefield, detached)).toBeNull();
    // Puppeteer's Godview supplies its workspace's, as its seam read `git?.branch ?? workspace.branch`.
    const godview = hostRun({ workspace: { branch: 'wip' }, fallbackBranch: 'wip' });
    expect(projectBranch(godview, monitorState({ environment: { git: null, worktrees: [] } }))).toBe('wip');
    expect(projectBranch(godview, detached)).toBe('wip');
    expect(projectBranch(godview, monitorState())).toBe('wip');
    expect(projectBranch(godview, undefined)).toBe('wip');
    expect(
      projectBranch(godview, monitorState({ environment: { git: { branch: 'feat' } as never, worktrees: [] } })),
    ).toBe('feat');
  });
  it('deals colour by the host key, else the observed directory, else nothing', () => {
    expect(
      projectKey(hostRun({ projectKey: '/repo' }), monitorState({ environment: { cwd: '/x', worktrees: [] } })),
    ).toBe('/repo');
    expect(projectKey(hostRun(), monitorState({ environment: { cwd: '/x', worktrees: [] } }))).toBe('/x');
    expect(projectKey(hostRun({ projectKey: '' }), monitorState())).toBeUndefined();
    // Null: the host is still folding it, so the observed directory is not dealt either.
    expect(
      projectKey(hostRun({ projectKey: null }), monitorState({ environment: { cwd: '/x', worktrees: [] } })),
    ).toBeUndefined();
    expect(derive(hostRun(), monitorState(), 3).project.seq).toBe(3);
    expect(derive().project.seq).toBeUndefined();
  });
  it('folds a path to its last component and takes the fallback for an empty one', () => {
    expect(folderName('/a/b/c/', 'x')).toBe('c');
    expect(folderName('C:\\work\\repo\\', 'x')).toBe('repo');
    expect(folderName(undefined, 'x')).toBe('x');
    expect(folderName('  ', 'x')).toBe('x');
  });
});

describe('provider, model, effort, account, context', () => {
  it('copies the provider and account from the host, the model and effort from the runtime', () => {
    const row = derive(
      hostRun({ account: 'work@example.com' }),
      monitorState({
        model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
        effort: { value: 'high', intent: 'configured' },
        context: { usedPercent: 42, percentageSource: 'provider', asOf: iso(T0) },
      }),
    );
    expect(row.provider).toEqual({ id: 'claude', label: 'Claude Code' });
    expect(row.account).toBe('work@example.com');
    expect(row.model).toBe('Opus 5.5');
    expect(row.effort).toEqual({ value: 'high', intent: 'configured' });
    expect(agentEffort(monitorState({ effort: { value: 'low' } }))).toEqual({ value: 'low' });
    expect(agentEffort(monitorState())).toBeUndefined();
    expect(row.context).toEqual({ usedPercent: 42 });
  });
  it('falls back to the model id and leaves absent what the runtime did not say', () => {
    const row = derive(hostRun(), monitorState({ model: { id: 'gpt-5' } }));
    expect(row.model).toBe('gpt-5');
    expect(row.effort).toBeUndefined();
    expect(row.account).toBeUndefined();
    expect(row.context).toBeUndefined();
    expect(deriveUnheard().model).toBeUndefined();
  });
});

describe('wait and reply', () => {
  it('carries the first blocker with its tool, its code or its prompt, bounded, and how many wait', () => {
    const permission = agentWait(
      monitorState({
        blockers: [
          { id: 'b1', kind: 'permission', since: iso(T0 + 1), permission: { requestId: 'r', tool: 'Bash' } },
          { id: 'b2', kind: 'failure', since: iso(T0 + 2) },
        ],
      }),
      T0,
      280,
    );
    expect(permission).toEqual({ kind: 'permission', since: T0 + 1, count: 2, tool: 'Bash' });
    const question = agentWait(
      monitorState({
        blockers: [
          { id: 'q', kind: 'question', since: 'bad', questions: [{ prompt: 'Which branch should I use for this?' }] },
        ],
      }),
      T0,
      12,
    );
    expect(question).toEqual({ kind: 'question', since: T0, question: 'Which branch' });
    const failure = agentWait(
      monitorState({
        blockers: [
          {
            id: 'f',
            kind: 'failure',
            since: iso(T0),
            detail: ' exit 1 · the process crashed ',
            failure: { code: 'crash' },
          },
        ],
      }),
      T0,
      280,
    );
    expect(failure).toEqual({ kind: 'failure', since: T0, code: 'crash', detail: 'exit 1 · the process crashed' });
    expect(agentWait(monitorState(), T0, 280)).toBeUndefined();
    expect(agentWait(undefined, T0, 280)).toBeUndefined();
  });
  it('keeps a question’s header and prompt apart, each bounded, and counts the blockers core left out', () => {
    const wait = agentWait(
      monitorState({
        blockers: [
          {
            id: 'q',
            kind: 'question',
            since: iso(T0),
            questions: [{ header: 'Branch choice', prompt: 'Which branch?' }],
          },
        ],
        omitted: { blockers: 3 },
      }),
      T0,
      5,
    );
    expect(wait).toEqual({ kind: 'question', since: T0, count: 4, header: 'Branc', question: 'Which' });
  });
  it('bounds the reply by code points and drops a blank one', () => {
    const reply = agentReply(
      monitorState({ lastAssistantMessage: { text: '  Done 🎉 all green  ', at: iso(T0), final: true } }),
      6,
    );
    expect(reply).toEqual({ text: 'Done 🎉', at: T0, final: true });
    expect(
      agentReply(monitorState({ lastAssistantMessage: { text: '   ', at: iso(T0), final: false } }), 280),
    ).toBeUndefined();
    expect(agentReply(monitorState(), 280)).toBeUndefined();
    expect(boundText('abc', 2)).toBe('ab');
  });
  it('leaves a streaming reply unfinal and a bad time absent', () => {
    expect(
      agentReply(monitorState({ lastAssistantMessage: { text: 'still', at: 'nope', final: false } }), 280),
    ).toEqual({
      text: 'still',
      final: false,
    });
  });
});

describe('activity and observed', () => {
  it('carries the runtime’s activity with its line bounded and its start, or nothing', () => {
    expect(agentActivity(monitorState(), 280)).toEqual({ kind: 'tool', line: 'Edit · src/app.ts', since: T0 });
    expect(agentActivity(monitorState({ activity: { kind: 'reasoning', line: '  ', since: 'bad' } }), 280)).toEqual({
      kind: 'reasoning',
    });
    expect(agentActivity(monitorState(), 4)?.line).toBe('Edit');
    expect(agentActivity(monitorState({ activity: undefined }), 280)).toBeUndefined();
    expect(agentActivity(undefined, 280)).toBeUndefined();
  });
  it('is observed once the runtime has spoken and something drives the run', () => {
    expect(agentObserved(hostRun(), monitorState())).toBe(true);
    expect(agentObserved(hostRun(), undefined)).toBe(false);
    expect(agentObserved(hostRun({ pending: 'resume-when-idle' }), monitorState())).toBe(false);
    expect(deriveUnheard()).toMatchObject({ observed: false, detail: 'starting' });
    expect(derive().observed).toBe(true);
  });
});

describe('tokens and recency', () => {
  it('carries the total and the burn when the runtime has them', () => {
    expect(agentTokens(monitorState({ usage: { samples: [], cumulativeTokens: 1200, burnRatePerMin: 30 } }))).toEqual({
      total: 1200,
      perMinute: 30,
    });
    expect(agentTokens(monitorState({ usage: { samples: [], cumulativeTokens: 5 } }))).toEqual({ total: 5 });
    expect(agentTokens(monitorState())).toBeUndefined();
    expect(agentTokens(undefined)).toBeUndefined();
  });
  it('is stale past the policy and never without an evidence clock', () => {
    const state = monitorState({ freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: iso(T0) } });
    expect(isStale(state, T0 + 30_000, 30_000)).toBe(false);
    expect(isStale(state, T0 + 30_001, 30_000)).toBe(true);
    expect(isStale(monitorState({ freshness: { level: 'native-hooks', families: {} } }), T0 + 1e9, 30_000)).toBe(false);
    expect(isStale(undefined, T0, 30_000)).toBe(false);
  });
});

describe('profile set, tier, device, attachable', () => {
  it("takes the host's set, then the persona's, then native", () => {
    const personas = personaSets([
      { id: 'work', label: 'Work', kind: 'managed', personas: [{ profileId: 'p-1', providerLabel: 'Claude Code' }] },
    ]);
    expect(resolveProfileSet(hostRun({ profileSet: 'play', profileId: 'p-1' }), personas)).toBe('play');
    expect(resolveProfileSet(hostRun({ profileId: 'p-1' }), personas)).toBe('work');
    expect(resolveProfileSet(hostRun({ profileId: 'gone' }), personas)).toBe('native');
    expect(resolveProfileSet(hostRun(), personas)).toBe('native');
    expect(personaSets(null).size).toBe(0);
  });
  it('carries the tier and device, and is attachable only with a PTY here', () => {
    const row = derive(hostRun({ tier: 'ingested' }));
    expect(row.tier).toBe('ingested');
    expect(row.device).toBe(DEVICE);
    expect(row.attachable).toBe(true);
    expect(derive(hostRun({ terminalSessionId: undefined })).attachable).toBe(false);
    expect(derive().tier).toBeUndefined();
  });
  it('builds the whole agent row in the contract shape', () => {
    const row = derive(hostRun({ createdAt: 10 }), monitorState());
    expect(row).toMatchObject({
      id: 'row',
      kind: 'agent',
      createdAt: 10,
      status: 'working',
      statusSince: T0,
      stale: false,
      alive: true,
      observed: true,
      detail: 'Edit · src/app.ts',
      activity: { kind: 'tool', line: 'Edit · src/app.ts', since: T0 },
      project: { name: 'Claude Code' },
      unread: false,
      profileSet: 'native',
      attachable: true,
    });
  });
});

describe('terminal rows', () => {
  it('is working under a foreground job and idle otherwise', () => {
    expect(classifyTerminalStatus({ kind: 'foreground-job' })).toBe('working');
    expect(classifyTerminalStatus({ kind: 'shell' })).toBe('idle');
    expect(classifyTerminalStatus(undefined)).toBe('idle');
  });
  it('names its folder, says its directory, carries its shell profile and activity, and is never unread', () => {
    const row = deriveTerminalRow({
      id: 'pty-9',
      host: hostTerminal({ activity: { kind: 'foreground-job' }, profileSet: 'work' }),
      device: DEVICE,
      statusSince: 5,
    });
    expect(row).toEqual({
      id: 'pty-9',
      kind: 'terminal',
      createdAt: T0 - 30_000,
      status: 'working',
      statusSince: 5,
      stale: false,
      alive: true,
      observed: true,
      detail: '/Users/me/notes',
      activity: { kind: 'foreground-job' },
      project: { name: 'notes' },
      unread: false,
      device: DEVICE,
      profileSet: 'work',
      attachable: true,
    });
  });
  it('falls back to its title, then to "terminal", with no directory', () => {
    expect(
      deriveTerminalRow({
        id: 't',
        host: hostTerminal({ cwd: undefined, title: 'zsh' }),
        device: DEVICE,
        statusSince: 0,
      }),
    ).toMatchObject({ detail: 'Unassigned terminal', project: { name: 'zsh' } });
    expect(
      deriveTerminalRow({ id: 't', host: hostTerminal({ cwd: '' }), device: DEVICE, statusSince: 0 }).project.name,
    ).toBe('terminal');
  });
});
