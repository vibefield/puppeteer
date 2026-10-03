import { describe, expect, it } from 'vitest';
import {
  agentAlive,
  agentDetail,
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
  it('deals colour by the host key, else the observed directory, else nothing', () => {
    expect(
      projectKey(hostRun({ projectKey: '/repo' }), monitorState({ environment: { cwd: '/x', worktrees: [] } })),
    ).toBe('/repo');
    expect(projectKey(hostRun(), monitorState({ environment: { cwd: '/x', worktrees: [] } }))).toBe('/x');
    expect(projectKey(hostRun({ projectKey: '' }), monitorState())).toBeUndefined();
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
        effort: { value: 'high' },
        context: { usedPercent: 42, percentageSource: 'provider', asOf: iso(T0) },
      }),
    );
    expect(row.provider).toEqual({ id: 'claude', label: 'Claude Code' });
    expect(row.account).toBe('work@example.com');
    expect(row.model).toBe('Opus 5.5');
    expect(row.effort).toBe('high');
    expect(row.context).toEqual({ usedPercent: 42 });
  });
  it('falls back to the model id and leaves absent what the runtime did not say', () => {
    const row = derive(hostRun(), monitorState({ model: { id: 'gpt-5' } }));
    expect(row.model).toBe('gpt-5');
    expect(row.effort).toBeUndefined();
    expect(row.account).toBeUndefined();
    expect(row.context).toBeUndefined();
    expect(derive(hostRun(), undefined).model).toBeUndefined();
  });
});

describe('wait and reply', () => {
  it('carries the first blocker with its tool or its question, bounded', () => {
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
    expect(permission).toEqual({ kind: 'permission', since: T0 + 1, tool: 'Bash' });
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
    expect(agentWait(monitorState(), T0, 280)).toBeUndefined();
    expect(agentWait(undefined, T0, 280)).toBeUndefined();
  });
  it('prefers a question header to its prompt', () => {
    const wait = agentWait(
      monitorState({
        blockers: [{ id: 'q', kind: 'question', since: iso(T0), questions: [{ header: 'Branch', prompt: 'Which?' }] }],
      }),
      T0,
      280,
    );
    expect(wait?.question).toBe('Branch');
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
      detail: 'Edit · src/app.ts',
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
      detail: '/Users/me/notes',
      activity: 'foreground-job',
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
