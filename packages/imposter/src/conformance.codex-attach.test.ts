/**
 * A prompt typed in the PANE, observed by the adapter (docs/archive/IMPOSTER.md §11.5).
 *
 * This is the claim the other two codex suites do not make. `codex-socket`
 * proves the transport and `codex-pane` proves the recipe, but both drive the
 * imposter from the controller side. What a person actually does is type into
 * the terminal — and that process is not the session, it is a `--remote` client
 * of it. Three processes have to agree for a single keystroke to become a
 * conversation item: the viewer sends `turn/start`, the server runs the
 * behavior pack, and the adapter — on its own connection — reduces what comes
 * back.
 *
 * Godview reported this as "the agent circle never appears": the pane looked
 * alive and the panel stayed empty, because the viewer was starting a session
 * of its own instead of joining the one the adapter was watching.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCodexSession,
  spawnAppServer,
  wsOverUnixTransport,
  type CodexSession,
} from '@vibecook/puppeteer-adapter-codex';
import { projectAgentSession } from '@vibecook/puppeteer-testing';

const AI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai.mjs');

const temporaries = new Set<string>();
const children = new Set<ChildProcess>();
const disposers = new Set<() => void>();
let session: CodexSession | undefined;

afterEach(async () => {
  await session?.dispose().catch(() => undefined);
  session = undefined;
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const dispose of disposers) dispose();
  disposers.clear();
  for (const path of temporaries) rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  temporaries.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(process.platform === 'win32')('a prompt typed in an attached pane', () => {
  it('reaches the adapter as a turn on the thread it is already observing', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-codex-attach-')));
    temporaries.add(cwd);

    const server = spawnAppServer({ executable: AI, env: { AI_PERSONA: 'codex' } });
    disposers.add(() => server.dispose());
    await server.ready();

    session = await createCodexSession({ cwd, transport: wsOverUnixTransport(server.socketPath) });
    const projection = projectAgentSession(session);
    const events = projection.envelopes;
    const threadId = session.sessionId;

    // The pane, launched with the argv `prepareCodexTuiSession` hands back, and
    // the persona in the environment exactly as spawn-through merges it.
    const pane = spawn(process.execPath, [AI, 'resume', threadId, '--remote', `unix://${server.socketPath}`], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_TUI: 'off' },
    });
    children.add(pane);
    let paneOut = '';
    pane.stdout.setEncoding('utf8');
    pane.stdout.on('data', (chunk: string) => void (paneOut += chunk));

    // The viewer draws the notification its `thread/resume` produced, which is
    // how it says "I am looking at a thread" without owning one.
    await waitFor(() => paneOut.includes('thread/started'), 'the viewer to join the thread');

    // One bracketed paste, as a terminal delivers it.
    pane.stdin.write('\x1b[200~who are you really\x1b[201~\r');

    await waitFor(
      () => events.some((envelope) => envelope.event.type === 'turn:completed'),
      'the adapter to observe a completed turn',
    );

    const assistant = events.filter((envelope) => envelope.event.type === 'conversation:assistant-message');
    expect(assistant.length).toBeGreaterThan(0);
    // The reply came from the SERVER's behavior pack, not from the viewer: the
    // viewer has no behavior and never writes to any channel.
    const text = assistant
      .map((e) => (e.event.type === 'conversation:assistant-message' ? e.event.text : ''))
      .join(' ');
    expect(text).toContain('imposter: ok');

    // And the prompt itself survived the trip, which is what proves the pane
    // and the adapter are on one thread rather than two.
    expect(projection.state.lastAssistantMessage).toBe('imposter: ok');
  });
});
