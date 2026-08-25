/**
 * Every persona's boot table, checked against the portable scenario phase it
 * is supposed to produce (scenario-driver.ts, docs/archive/IMPOSTER.md §11).
 *
 * This exists because `ai --codex` shipped with `"boot": []` and therefore sat
 * in `starting` forever — no op reached the driver, so its graph never moved
 * and the TUI's status line never changed (found by running it, 2026-08-09).
 * Nothing caught it: the codex suites drive the SERVE fork, where the lifecycle
 * legitimately begins at the client's `thread/start`, so the interactive fork
 * was the one path no test entered.
 *
 * Written over `availablePersonas()` rather than a list, so the guard extends
 * to whatever persona is added next without anyone remembering to extend it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { availablePersonas, loadPersona } from '../persona/load.ts';
import { createImposterSession } from './session.ts';

const temporaries = new Set<string>();

afterEach(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
  temporaries.clear();
});

function booted(vendor: string) {
  const home = mkdtempSync(join(tmpdir(), `chopsticks-boot-${vendor}-`));
  temporaries.add(home);
  return createImposterSession({
    persona: loadPersona(vendor),
    argv: [],
    // No `jsonrpc` sink, which IS the interactive fork: a persona that binds
    // its boot ops to an app-server has no client to send them to.
    env: { CHOPSTICKS_IMPOSTER_HOME: home },
    cwd: home,
    behavior: {},
  });
}

describe('persona boot', () => {
  for (const vendor of availablePersonas()) {
    it(`${vendor} reaches a settled lifecycle state, rather than sitting in starting`, async () => {
      const session = booted(vendor);
      expect(session.scenarioDriver.state).toBe('starting');

      await session.boot();

      // `ready` specifically, not merely "moved": `booting` is the state a
      // vendor is in while it loads, and a screen that never leaves it is the
      // same bug wearing a different label.
      expect(session.scenarioDriver.state).toBe('ready');
      expect(session.scenarioDriver.offModel).toBe(0);
    });
  }

  /**
   * The ASM cannot catch this one: a schema that wants a string is perfectly
   * happy with the string "$threadId". So the check has to be on the shape of
   * the value, and it belongs here rather than at runtime because a literal `$`
   * is legitimate in payload TEXT — only a whole value that is still a template
   * is evidence that a binding was never minted.
   */
  const unresolved = (value: unknown, path = ''): string[] => {
    if (typeof value === 'string') return /^\$[A-Za-z]/.test(value) ? [`${path} = ${value}`] : [];
    if (Array.isArray(value)) return value.flatMap((entry, index) => unresolved(entry, `${path}[${index}]`));
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, entry]) => unresolved(entry, path ? `${path}.${key}` : key));
    }
    return [];
  };

  for (const vendor of availablePersonas()) {
    it(`${vendor} boots without leaving a template unsubstituted on the wire`, async () => {
      const session = booted(vendor);
      await session.boot();
      expect(session.emitted.flatMap((entry) => unresolved(entry.payload, entry.event))).toEqual([]);
    });
  }

  it('gives codex a thread identity of its own, since interactively no client mints one', async () => {
    const session = booted('codex');
    await session.boot();

    // `session.ready` has no codex event at all, so the ONE record here is
    // `thread/started` — proof the driver advanced twice while the wire heard
    // about it once (timeline.ts `observe`).
    expect(session.scenarioDriver.state).toBe('ready');
    expect(session.emitted.map((entry) => entry.event)).toEqual(['thread/started']);
    const thread = (session.emitted[0]!.payload as { thread: { id: string; cwd: string } }).thread;
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(thread.cwd).toBe(session.transcriptRoot);
  });

  it('honours a persona native-root environment variable without requiring the shared override', () => {
    const home = mkdtempSync(join(tmpdir(), 'chopsticks-grok-native-root-'));
    temporaries.add(home);
    const session = createImposterSession({
      persona: loadPersona('grok'),
      argv: ['--session-id', 'native-root-session'],
      env: { GROK_HOME: home },
      cwd: '/work/repo',
      behavior: {},
    });
    expect(session.transcriptRoot).toBe(home);
  });

  it('refuses a raw trigger that names an undeclared native rail', async () => {
    const session = booted('synthetic');
    await expect(session.emit('agent.prompt', { utterance: 'hello' }, 'missing-rail')).rejects.toThrow(
      /unknown channel missing-rail/,
    );
  });

  it('replays Grok durable history on resume without appending it again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chopsticks-grok-restore-'));
    temporaries.add(home);
    const persona = loadPersona('grok');
    const behavior = {
      reply: 'restored reply',
      ops: [
        { op: 'turn.start', with: { text: '$stimulus.text' } },
        { op: 'assistant.delta', with: { text: '$reply' } },
        { op: 'turn.end' },
        {
          op: 'usage.refresh',
          with: { addedTokens: 16 },
        },
      ],
    };
    const first = createImposterSession({
      persona,
      argv: ['--session-id', 'restore-session'],
      env: { GROK_HOME: home },
      cwd: '/work/repo',
      behavior,
      jsonrpc: { notify: () => {}, request: async () => ({ outcome: { outcome: 'cancelled' } }) },
    });
    await first.boot();
    await first.turn('remember this');
    await first.emit(
      '_x.ai/session/update',
      {
        sessionId: 'restore-session',
        update: { sessionUpdate: 'compaction_checkpoint', checkpoint_id: 'checkpoint-one' },
      },
      'session-log',
    );

    const sessionStore = join(home, 'sessions', encodeURIComponent('/work/repo'), 'restore-session');
    const updatesPath = join(sessionStore, 'updates.jsonl');
    const summary = JSON.parse(readFileSync(join(sessionStore, 'summary.json'), 'utf8')) as Record<string, unknown>;
    expect(JSON.parse(readFileSync(join(sessionStore, 'signals.json'), 'utf8'))).toMatchObject({
      compactionCount: 1,
      turnCount: 1,
      contextTokensUsed: 16,
    });
    const before = readFileSync(updatesPath, 'utf8');
    const replayed: Array<{ method: string; params: Record<string, unknown> }> = [];
    const resumed = createImposterSession({
      persona,
      argv: ['--resume', 'restore-session'],
      env: { GROK_HOME: home },
      cwd: '/controller/process-cwd',
      behavior,
    });
    // `session/load` binds the requested workspace after process startup. The
    // native store path must follow that binding rather than the controller's
    // own cwd, or resume quietly reads a different session tree.
    resumed.bindings.$threadCwd = '/work/repo';
    await resumed.restore((method, params) => replayed.push({ method, params }));

    expect(
      replayed.some(
        ({ method, params }) =>
          method === 'session/update' &&
          (params.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'agent_message_chunk',
      ),
    ).toBe(true);
    expect(
      replayed.some(
        ({ params }) =>
          (params.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'compaction_checkpoint',
      ),
    ).toBe(false);
    expect(
      replayed.some(
        ({ method, params }) =>
          method === '_x.ai/session_notification' &&
          (params.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'turn_completed',
      ),
    ).toBe(true);
    expect((resumed.statusPayload().context_window as { total_input_tokens: number }).total_input_tokens).toBe(16);
    expect(resumed.bindings).toMatchObject({
      $compactionCount: 1,
      $turnCount: 1,
      $messageCount: 2,
      $sessionCreatedAt: summary.created_at,
    });
    expect(readFileSync(updatesPath, 'utf8')).toBe(before);
  });
});
