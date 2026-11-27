import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  safeParseAgentEvent,
  type AdapterEventCandidate,
  type AgentHost,
  type TerminalSpec,
} from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { encodeKimiWorkDirKey, kimiMainWirePath } from './observation/session-store.js';
import { buildKimiTuiArgs, createKimiTuiSession, prepareKimiTuiSession } from './driver.js';
import { createKimiModelService } from './services/models.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-tui-'));
  roots.push(value);
  return value;
}

/** A new session in the folder holding a typed prompt, as a Kimi process writes it. */
async function typedSession(home: string, cwd: string, sessionId: string, text: string): Promise<void> {
  const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ id: sessionId, cwd, createdAt: 1 }));
  await writeFile(
    kimiMainWirePath(sessionDir),
    `${[
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      { type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time: 2 },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  );
}

describe('Kimi native TUI session', () => {
  it('builds only valid native CLI combinations', () => {
    expect(
      buildKimiTuiArgs({
        model: 'kimi-k2',
        permissionMode: 'yolo',
        plan: true,
        agent: 'Explore',
      }),
    ).toEqual(['--model', 'kimi-k2', '--yolo', '--plan', '--agent', 'Explore']);
    expect(buildKimiTuiArgs({ resume: 'session-1', permissionMode: 'auto' })).toEqual([
      '--auto',
      '--session',
      'session-1',
    ]);
    expect(() => buildKimiTuiArgs({ resume: 'session-1', agent: 'Explore' })).toThrow(/cannot combine/);
    expect(() => buildKimiTuiArgs({ agent: 'Explore', agentFile: 'agent.md' })).toThrow(/not both/);
  });

  it('resumes a session at a model selection: --model rides beside --session', () => {
    // `kimi --help` 2.0.2: -m is "for this invocation"; only --agent/--agent-file refuse --session.
    expect(createKimiModelService().provider.resumeSelection).toBe(true);
    expect(buildKimiTuiArgs({ resume: 'session-1', model: 'alias' })).toEqual([
      '--model',
      'alias',
      '--session',
      'session-1',
    ]);
  });

  it('binds a lazy native session and confirms injection from the durable echo', async () => {
    const home = await root();
    const cwd = join(home, 'repo');
    const launched: TerminalSpec[] = [];
    let wroteTurn = false;
    const host: AgentHost = {
      async spawnTerminal(spec) {
        launched.push(spec);
        return { runtimeSessionId: 'runtime-1' };
      },
      async automateTerminal(_runtimeSessionId, operation) {
        if (operation.kind !== 'paste' || !operation.submit) return { accepted: true };
        const sessionId = 'session-native-1';
        const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
        const wirePath = kimiMainWirePath(sessionDir);
        await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
        await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ id: sessionId, cwd, createdAt: 1 }));
        await writeFile(
          wirePath,
          `${[
            { type: 'metadata', protocol_version: '1.5', created_at: 1 },
            {
              type: 'profile.bind',
              modelAlias: 'kimi-k2',
              profileName: 'agent',
              thinkingEffort: 'on',
              environmentDisclosure: { cwd },
              time: 1,
            },
            { type: 'permission.set_mode', mode: 'manual', time: 1 },
            { type: 'turn.prompt', input: [{ type: 'text', text: operation.text }], origin: { kind: 'user' }, time: 2 },
            { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 }, time: 3 },
            {
              type: 'llm.request',
              kind: 'loop',
              provider: 'openai',
              model: 'kimi-k2-applied',
              modelAlias: 'kimi-k2',
              thinkingEffort: 'high',
              time: 3,
            },
            {
              type: 'usage.record',
              model: 'kimi-k2',
              usageScope: 'turn',
              usage: { inputOther: 20, output: 4, inputCacheRead: 2, inputCacheCreation: 1 },
              time: 4,
            },
            {
              type: 'context.append_loop_event',
              event: { type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text: 'pong' } },
              time: 4,
            },
            { type: 'turn.ended', turnId: 0, reason: 'completed', time: 5 },
          ]
            .map((record) => JSON.stringify(record))
            .join('\n')}\n`,
        );
        wroteTurn = true;
        return { accepted: true };
      },
    };

    const session = await createKimiTuiSession({
      cwd,
      host,
      executable: '/opt/kimi',
      kimiHome: home,
      model: 'kimi-k2',
      permissionMode: 'manual',
      pollIntervalMs: 60_000,
    });
    const projection = projectAgentEvents(session);
    const candidates: AdapterEventCandidate[] = [];
    expect(session.events.onCandidate).toBeTypeOf('function');
    // what the predicate says as each candidate is published
    const provisionalAt: Array<[string, boolean | undefined]> = [];
    const offCandidate = session.events.onCandidate!((candidate) => {
      candidates.push(candidate);
      provisionalAt.push([candidate.type, session.nativeSessionProvisional?.()]);
    });
    const monitor = projection.monitorBatches;
    expect(launched).toEqual([
      { command: '/opt/kimi', args: ['--model', 'kimi-k2'], cwd, env: { KIMI_CODE_HOME: home } },
    ]);
    expect(session.sessionId).toMatch(/^kimi-pending-/);
    // RA-D7: a provisional id names no journal, so nothing may be ended to resume it
    expect(session.durableRecordSeen()).toBe(false);
    expect(session.nativeSessionProvisional?.()).toBe(true);
    await expect(session.services.prompt.submit({ text: 'ping', confirmationTimeoutMs: 2_000 })).resolves.toEqual({
      status: 'confirmed',
    });
    expect(wroteTurn).toBe(true);
    expect(session.sessionId).toBe('session-native-1');
    expect(session.durableRecordSeen()).toBe(true);
    // the bind's own start is said with the predicate already false, and so is everything after it
    expect(session.nativeSessionProvisional?.()).toBe(false);
    const bindAt = provisionalAt.findIndex(([type]) => type === 'session:started');
    expect(bindAt).toBeGreaterThanOrEqual(0);
    expect(provisionalAt.slice(bindAt).every(([, provisional]) => provisional === false)).toBe(true);
    expect(projection.state).toMatchObject({ lifecycle: 'ready', lastAssistantMessage: 'pong', activeTurn: undefined });
    const assistant = candidates.find(({ type }) => type === 'conversation:assistant-message');
    expect(assistant).not.toHaveProperty('sequence');
    expect(assistant && safeParseAgentEvent(assistant.type, assistant.event).success).toBe(true);
    expect(candidates.every(({ type }) => type.includes(':'))).toBe(true);
    expect(candidates.every(({ type, event }) => safeParseAgentEvent(type, event).success)).toBe(true);
    expect(session.observationLevel()).toBe('native-log');
    expect(monitor.flatMap((batch) => batch.capabilities ?? [])).toHaveLength(9);
    expect(monitor).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'bootstrap',
          scope: { nativeSessionId: 'session-native-1' },
          updates: expect.arrayContaining([
            expect.objectContaining({
              family: 'model',
              value: expect.objectContaining({ providerModelId: 'kimi-k2', intent: 'configured' }),
            }),
          ]),
        }),
        expect.objectContaining({
          phase: 'live',
          updates: expect.arrayContaining([
            expect.objectContaining({
              family: 'context',
              value: expect.objectContaining({ usedTokens: 23, percentageSource: 'unavailable' }),
            }),
          ]),
        }),
      ]),
    );
    expect(monitor.flatMap((batch) => batch.updates).some(({ family }) => family === 'usage')).toBe(false);
    offCandidate();
    projection.dispose();
    await session.dispose();
    await session.dispose();
  });

  it('binds a fresh run that holds no host prompt only in a home it owns', async () => {
    // a person's own home: after the launch, someone starts Kimi in another terminal in the same folder
    const home = await root();
    const cwd = join(home, 'repo');
    const host: AgentHost = {
      spawnTerminal: vi.fn(),
      async automateTerminal(_runtimeSessionId, operation) {
        // the run's own Kimi writes its session when the host's prompt is submitted
        if (operation.kind === 'paste' && operation.submit) {
          await typedSession(home, cwd, 'session-own', operation.text);
        }
        return { accepted: true };
      },
    };
    const prepared = await prepareKimiTuiSession({ cwd, host, kimiHome: home, pollIntervalMs: 60_000 });
    await typedSession(home, cwd, 'session-outside', 'typed in another terminal');
    // adoption reads the folder once: the session from outside is the one new candidate
    const session = await prepared.adopt('runtime-native');
    expect(session.sessionId).toMatch(/^kimi-pending-/);
    expect(session.nativeSessionProvisional?.()).toBe(true);
    expect(session.durableRecordSeen()).toBe(false);
    // the run's own prompt names its own session
    await expect(session.services.prompt.submit({ text: 'mine', confirmationTimeoutMs: 2_000 })).resolves.toEqual({
      status: 'confirmed',
    });
    expect(session.sessionId).toBe('session-own');
    expect(session.nativeSessionProvisional?.()).toBe(false);
    await prepared.dispose();

    // a managed profile's home, which only its runs write: the person typed the run's first prompt in its pane
    const ownedHome = await root();
    const ownedCwd = join(ownedHome, 'repo');
    const ownedHost: AgentHost = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() };
    const ownedPrepared = await prepareKimiTuiSession({
      cwd: ownedCwd,
      host: ownedHost,
      kimiHome: ownedHome,
      ownedRoot: true,
      pollIntervalMs: 60_000,
    });
    await typedSession(ownedHome, ownedCwd, 'session-typed', 'typed in the pane');
    const owned = await ownedPrepared.adopt('runtime-owned');
    expect(owned.sessionId).toBe('session-typed');
    expect(owned.nativeSessionProvisional?.()).toBe(false);
    expect(owned.durableRecordSeen()).toBe(true);
    expect(ownedHost.automateTerminal).not.toHaveBeenCalled();
    await ownedPrepared.dispose();
  });

  it('in a home it does not own, binds the session typed into its pane once its host says input reached the terminal it was adopted into', async () => {
    const home = await root();
    const cwd = join(home, 'repo');
    let typed = false;
    const terminalInputSeen = vi.fn((_runtimeSessionId: string) => typed);
    const host: AgentHost = { spawnTerminal: vi.fn(), automateTerminal: vi.fn(), terminalInputSeen };
    const prepared = await prepareKimiTuiSession({ cwd, host, kimiHome: home, pollIntervalMs: 20 });
    await typedSession(home, cwd, 'session-typed', 'typed in the pane');
    const session = await prepared.adopt('runtime-typed');
    // the host has seen no input in this terminal: the new session may be another terminal's, so nothing binds
    expect(session.sessionId).toMatch(/^kimi-pending-/);
    expect(session.nativeSessionProvisional?.()).toBe(true);
    expect(session.durableRecordSeen()).toBe(false);
    expect(terminalInputSeen).toHaveBeenCalled();
    // the person types in the pane: the host's next answer binds the one new session
    typed = true;
    await vi.waitFor(() => expect(session.sessionId).toBe('session-typed'));
    expect(session.nativeSessionProvisional?.()).toBe(false);
    expect(session.durableRecordSeen()).toBe(true);
    // asked of the terminal the run was adopted into, and of no other
    expect(new Set(terminalInputSeen.mock.calls.map(([runtimeSessionId]) => runtimeSessionId))).toEqual(
      new Set(['runtime-typed']),
    );
    expect(host.automateTerminal).not.toHaveBeenCalled();
    await prepared.dispose();
  });

  it('snapshots resume history before adoption and reports paste-only honestly', async () => {
    const home = await root();
    const cwd = join(home, 'repo');
    const sessionId = 'session-resume';
    const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ id: sessionId, cwd, createdAt: 1 }));
    await writeFile(
      kimiMainWirePath(sessionDir),
      `${[
        { type: 'turn.prompt', input: [{ type: 'text', text: 'history' }], origin: { kind: 'user' }, time: 2 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 }, time: 3 },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text: 'old reply' } },
          time: 4,
        },
        { type: 'turn.ended', turnId: 0, reason: 'completed', time: 5 },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
    );
    const automate = vi.fn(async () => ({ accepted: true as const }));
    const host: AgentHost = { spawnTerminal: vi.fn(), automateTerminal: automate };
    const prepared = await prepareKimiTuiSession({ cwd, host, kimiHome: home, resume: sessionId });
    expect(prepared.sessionId).toBe(sessionId);
    expect(prepared.launch.args).toEqual(['--session', sessionId]);
    const session = await prepared.adopt('runtime-resume');
    // the journal was found at prepare, and the id is the session's own
    expect(session.durableRecordSeen()).toBe(true);
    expect(session.nativeSessionProvisional?.()).toBe(false);
    const projection = projectAgentEvents(session);
    expect(projection.state).toMatchObject({ lifecycle: 'ready', lastAssistantMessage: 'old reply' });
    await expect(session.services.prompt.submit({ text: 'staged', mode: 'paste-only' })).resolves.toEqual({
      status: 'uncertain',
      reason: 'prompt text was staged but not submitted',
    });
    expect(automate).toHaveBeenCalledWith('runtime-resume', { kind: 'paste', text: 'staged', submit: false });
    await appendFile(
      kimiMainWirePath(sessionDir),
      `${[
        { type: 'turn.prompt', input: [{ type: 'text', text: 'final' }], origin: { kind: 'user' }, time: 6 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '1', step: 1 }, time: 7 },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', turnId: '1', step: 1, part: { type: 'text', text: 'final reply' } },
          time: 8,
        },
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 9 },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
    );
    await prepared.dispose();
    expect(projection.state).toMatchObject({ lifecycle: 'ready', lastAssistantMessage: 'final reply' });
    projection.dispose();
  });
});
