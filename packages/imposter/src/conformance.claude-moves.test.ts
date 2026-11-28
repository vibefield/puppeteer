/**
 * The Claude imposter moves its session, and the whole chain follows it: the adapter's generated settings, the
 * imposter's real hooks (HTTP, and commands through the adapter's staged forwarder), the bridge, the normalizer and
 * the reducer, with no claude binary.
 *
 * (a) `/clear` moves the run: `session:started` with `rebind`, and what follows is the new session's.
 * (b) `/fork` starts a copy: `session:forked` names it, and the run stays where it was.
 * (c) a `/clear` made while no bridge listened (the host had released it) is replayed, in order, once an attach that
 *     is handed the launch's attach record binds the bridge again.
 *
 * A scenario is run in the imposter through its control channel, joined to a control center of this file's own on a
 * socket it owns, never the default one under the home folder.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterEventCandidate,
  AgentAttachRecord,
  AgentEventEnvelope,
  TerminalAutomationOperation,
  TerminalAutomationResult,
} from '@vibefield/puppeteer-core';
import { attachClaudeTuiSession, createClaudeSession, type ClaudeSession } from '@vibefield/puppeteer-adapter-claude';
import { projectAgentEvents, type TestAgentProjection } from '@vibefield/puppeteer-testing';
import { createPeer, type Peer } from './control/peer.ts';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const AI = join(packageRoot, 'bin', 'ai.mjs');
const BEHAVIOR = JSON.parse(
  readFileSync(join(packageRoot, 'personas', 'claude', 'behavior', 'happy-turn.json'), 'utf8'),
) as { reply: string };

const children = new Set<ChildProcess>();
const temporaries = new Set<string>();
const servers = new Set<Server>();
const sessions = new Set<ClaudeSession>();

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    child.once('exit', done);
    setTimeout(done, 2000).unref?.();
  });
}

afterEach(async () => {
  for (const session of sessions) await session.dispose().catch(() => undefined);
  sessions.clear();
  await Promise.all([...children].map(reap));
  children.clear();
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.clear();
  for (const path of temporaries) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error;
    }
  }
  temporaries.clear();
});

function temporaryDirectory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaries.add(path);
  return path;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface ControlCenter {
  env: Record<string, string>;
  /** Run one named scenario in the joined imposter; resolves once it has played through. */
  run(name: string): Promise<void>;
}

/**
 * A control center of this test's own. `sun_path` is ~103 bytes and the macOS temp folder eats half of it, so the
 * socket lives under a short root (as the control client's own tests keep theirs).
 */
async function controlCenter(): Promise<ControlCenter> {
  const root = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'cm-') : '/tmp/cm-');
  temporaries.add(root);
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\puppeteer-moves-${randomUUID()}` : join(root, 'p.sock');
  const tokenPath = join(root, 'p.token');
  const token = randomUUID();
  writeFileSync(tokenPath, token, { mode: 0o600 });
  let peer: Peer | undefined;
  let joined: () => void = () => undefined;
  const hello = new Promise<void>((resolve) => (joined = resolve));
  const server = createServer((socket: Socket) => {
    const connected = createPeer(socket, {
      handle: (method, params) => {
        if (method === 'session.hello') {
          if (params.token !== token) throw new Error('wrong token');
          peer = connected;
          joined();
        }
        return { ok: true };
      },
    });
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    env: { PUPPETEER_IMPOSTER_SOCKET: socketPath, PUPPETEER_IMPOSTER_TOKEN_FILE: tokenPath },
    async run(name) {
      await hello;
      await peer!.request('scenario.run', { name, speed: 10 }, { timeoutMs: 10_000 });
    },
  };
}

interface Launch {
  session: ClaudeSession;
  projection: TestAgentProjection;
  center: ControlCenter;
  child(): ChildProcess;
  imposterHome: string;
  cwd: string;
  bound(): { port: number; token: string } | undefined;
  record(): AgentAttachRecord | undefined;
}

/** A Claude session over `ai` as a real subprocess, joined to a control center of its own. */
async function launch(options: { keepAttachRecord?: boolean } = {}): Promise<Launch> {
  const cwd = temporaryDirectory('puppeteer-imposter-moves-cwd-');
  const imposterHome = temporaryDirectory('puppeteer-imposter-moves-home-');
  const center = await controlCenter();
  let child: ChildProcess | undefined;
  let bound: { port: number; token: string } | undefined;
  let record: AgentAttachRecord | undefined;
  const session = await createClaudeSession({
    cwd,
    title: 'imposter-moves',
    executable: AI,
    // the imposter writes Claude's layout under its home: the adapter's config root is the same folder
    configDir: imposterHome,
    env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: imposterHome, ...center.env },
    transcriptPollIntervalMs: 50,
    ingress: {
      onBound: (value) => void (bound = value),
      ...(options.keepAttachRecord ? { onAttachRecord: (value: AgentAttachRecord) => void (record = value) } : {}),
    },
    ports: {
      spawn: async (prepared) => {
        child = spawn(prepared.command, prepared.args, {
          cwd: prepared.cwd,
          env: { ...process.env, ...prepared.env },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        children.add(child);
        return { runtimeSessionId: 'rt-imposter-moves' };
      },
      automate: async (_runtimeSessionId, operation) => automate(child, operation),
    },
  });
  sessions.add(session);
  const projection = projectAgentEvents(session);
  await waitFor(() => projection.state.lifecycle === 'ready', 'imposter boot');
  return {
    session,
    projection,
    center,
    child: () => child!,
    imposterHome,
    cwd,
    bound: () => bound,
    record: () => record,
  };
}

/** The terminal's semantic input, written to the imposter's stdin as a terminal would deliver it. */
async function automate(
  child: ChildProcess | undefined,
  operation: TerminalAutomationOperation,
): Promise<TerminalAutomationResult> {
  if (!child) return { accepted: false, reason: 'no imposter process' };
  if (operation.kind === 'paste')
    child.stdin!.write(`\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`);
  else if (operation.kind === 'text') child.stdin!.write(operation.text);
  else child.stdin!.write('\x03');
  return { accepted: true };
}

/** One confirmed turn, complete. */
async function turn(session: ClaudeSession, prompt: string): Promise<void> {
  const completed = new Set<string | undefined>();
  const off = session.events.onCandidate((candidate: AdapterEventCandidate) => {
    if (!candidate.replay && candidate.event.type === 'turn:completed') completed.add(candidate.event.turnId);
  });
  try {
    const receipt = await session.services.prompt.submit({ text: prompt });
    if (receipt.status !== 'confirmed') throw new Error(`expected a confirmed prompt, got ${receipt.status}`);
    await waitFor(() => completed.has(receipt.turnId), `turn:completed for ${receipt.turnId ?? 'the turn'}`, 8_000);
  } finally {
    off();
  }
}

const transcriptsIn = (imposterHome: string, cwd: string): string[] => {
  const folder = join(imposterHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.jsonl')) : [];
};
const lines = (path: string): number => readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
const startsOf = (envelopes: readonly AgentEventEnvelope[]) =>
  envelopes.filter(({ event }) => event.type === 'session:started');

describe('the Claude imposter moves its session, and the adapter follows', () => {
  it('(a) /clear: the run moves to the new session, said once with rebind, and goes on there', async () => {
    const { session, projection, center, imposterHome, cwd } = await launch();
    await turn(session, 'before the clear');
    const before = session.sessionId;
    const startsBefore = startsOf(projection.envelopes).length;

    await center.run('clear-rotate');

    await waitFor(() => session.sessionId !== before, 'the adapter following the clear');
    const after = session.sessionId;
    const moved = startsOf(projection.envelopes).slice(startsBefore);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      nativeSessionId: after,
      event: { type: 'session:started', nativeSessionId: after, rebind: true, startSource: 'clear' },
    });
    expect(projection.envelopes.some(({ type }) => type === 'session:forked')).toBe(false);
    // the imposter writes the new session's own transcript, and the adapter reads that one now
    expect(transcriptsIn(imposterHome, cwd).sort()).toEqual([`${before}.jsonl`, `${after}.jsonl`].sort());
    await waitFor(() => basename(session.transcriptPath() ?? '') === `${after}.jsonl`, 'the new transcript armed');

    const from = projection.envelopes.length;
    await turn(session, 'after the clear');
    await waitFor(
      () =>
        projection.envelopes
          .slice(from)
          .some(
            ({ event, source }) => event.type === 'conversation:assistant-message' && source === 'native-transcript',
          ),
      'the reply read from the new transcript',
    );
    const later = projection.envelopes.slice(from);
    expect(later.length).toBeGreaterThan(0);
    expect(later.filter(({ nativeSessionId }) => nativeSessionId !== after)).toEqual([]);
    expect(projection.state.lastAssistantMessage).toBe(BEHAVIOR.reply);
    expect(projection.state.lifecycle).toBe('ready');
  });

  it('(b) /fork: the copy is told once by its own id, and the run stays in its session', async () => {
    const { session, projection, center, imposterHome, cwd } = await launch();
    await turn(session, 'before the fork');
    const own = session.sessionId;
    const ownTranscript = join(imposterHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${own}.jsonl`);
    const recordsAtFork = lines(ownTranscript);

    await center.run('fork-branch');

    await waitFor(() => projection.envelopes.some(({ type }) => type === 'session:forked'), 'the fork reported');
    const forks = projection.envelopes.filter(({ type }) => type === 'session:forked');
    expect(forks).toHaveLength(1);
    const forked = (forks[0]!.event as { nativeSessionId: string }).nativeSessionId;
    expect(forked).not.toBe(own);
    expect(forks[0]).toMatchObject({ nativeSessionId: own, event: { startSource: 'fork' } });
    expect(session.sessionId).toBe(own);
    expect(
      startsOf(projection.envelopes).filter(({ event }) => event.type === 'session:started' && event.rebind),
    ).toEqual([]);
    // the copy's transcript holds the conversation as it was at the fork
    const copy = join(dirname(ownTranscript), `${forked}.jsonl`);
    expect(lines(copy)).toBe(recordsAtFork);

    const from = projection.envelopes.length;
    await turn(session, 'after the fork');
    expect(projection.envelopes.slice(from).filter(({ nativeSessionId }) => nativeSessionId !== own)).toEqual([]);
    expect(lines(ownTranscript)).toBeGreaterThan(recordsAtFork);
    expect(lines(copy)).toBe(recordsAtFork);
  });

  it('(c) a /clear while no bridge listened is replayed, in order, at the attach the record names', async () => {
    const { session, center, imposterHome, cwd, bound, record, child } = await launch({ keepAttachRecord: true });
    await turn(session, 'before the host went away');
    const pinned = session.sessionId;
    expect(record()).toMatchObject({ version: 1 });
    // The host goes away and releases the bridge; the process lives on in its terminal.
    await session.dispose({ release: true });
    sessions.delete(session);

    // The person types /clear: the imposter's SessionStart runs as a command through the staged forwarder, which
    // reaches no bridge and keeps the start.
    await center.run('clear-rotate');
    const cleared = transcriptsIn(imposterHome, cwd)
      .map((name) => name.replace(/\.jsonl$/, ''))
      .filter((id) => id !== pinned);
    expect(cleared).toHaveLength(1);

    const attached = await attachClaudeTuiSession({
      sessionId: pinned,
      runtimeSessionId: 'rt-imposter-moves',
      cwd,
      configDir: imposterHome,
      transcriptPollIntervalMs: 50,
      ingress: bound()!,
      attachRecord: record(),
      automate: async (_runtimeSessionId, operation) => automate(child(), operation),
    });
    sessions.add(attached);
    expect(attached.sessionId).toBe(pinned);
    const projection = projectAgentEvents(attached);
    await waitFor(() => attached.sessionId === cleared[0], 'the replayed clear');
    const started = startsOf(projection.envelopes);
    expect(started).toEqual([
      expect.objectContaining({
        nativeSessionId: cleared[0],
        replay: true,
        event: expect.objectContaining({ nativeSessionId: cleared[0], rebind: true, startSource: 'clear' }),
      }),
    ]);
    await waitFor(() => basename(attached.transcriptPath() ?? '') === `${cleared[0]}.jsonl`, 'the cleared transcript');

    // the run goes on in the session the pane is in, through the bridge bound again
    const from = projection.envelopes.length;
    await turn(attached, 'after the attach');
    expect(projection.envelopes.slice(from).filter(({ nativeSessionId }) => nativeSessionId !== cleared[0])).toEqual(
      [],
    );
    expect(projection.state.lifecycle).toBe('ready');
  });
});
