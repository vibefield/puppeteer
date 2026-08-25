import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost, TerminalSpec } from '@vibecook/chopsticks-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/chopsticks-core/monitor-spi';
import { encodeKimiWorkDirKey, kimiMainWirePath } from './session-store.js';
import { buildKimiTuiArgs, createKimiTuiSession, prepareKimiTuiSession } from './tui-session.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'chopsticks-kimi-tui-'));
  roots.push(value);
  return value;
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
    const monitor: AdapterMonitorObservationBatch[] = [];
    session.onMonitorBatch?.((batch) => monitor.push(batch));
    expect(launched).toEqual([
      { command: '/opt/kimi', args: ['--model', 'kimi-k2'], cwd, env: { KIMI_CODE_HOME: home } },
    ]);
    expect(session.sessionId).toMatch(/^kimi-pending-/);
    await expect(session.submitPrompt({ text: 'ping', confirmationTimeoutMs: 2_000 })).resolves.toEqual({
      status: 'confirmed',
    });
    expect(wroteTurn).toBe(true);
    expect(session.sessionId).toBe('session-native-1');
    expect(session.state()).toMatchObject({ lifecycle: 'ready', lastAssistantMessage: 'pong', activeTurn: undefined });
    expect(session.observationLevel()).toBe('native-log');
    expect(monitor.flatMap((batch) => batch.capabilities ?? [])).toHaveLength(11);
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
              family: 'usage',
              value: expect.objectContaining({ canonical: true, inputTokens: 20, outputTokens: 4 }),
            }),
          ]),
        }),
      ]),
    );
    await session.dispose();
    await session.dispose();
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.state()).toMatchObject({ lifecycle: 'ready', lastAssistantMessage: 'old reply' });
    await expect(session.submitPrompt({ text: 'staged', mode: 'paste-only' })).resolves.toEqual({
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
    expect(session.state()).toMatchObject({ lifecycle: 'ready', lastAssistantMessage: 'final reply' });
  });
});
