/**
 * The codex imposter on a unix socket — the transport every REAL codex session
 * uses (docs/archive/IMPOSTER.md §9.3, CODEX-SURFACE-FINDINGS §8).
 *
 * `conformance.codex.test.ts` drives the same persona over stdio NDJSON, which
 * is the path almost nothing takes: `adapter-codex` runs
 * `codex app-server --listen unix://<sock>` and speaks WebSocket to it for
 * every session it owns. Until this file existed, the imposter's coverage was
 * inverted — thorough on the rare transport, absent on the load-bearing one —
 * and that hole is why godview refused to let `ai --codex` into a pane at all.
 *
 * Nothing here is reimplemented. The suite calls the ADAPTER's own
 * `spawnAppServer` and `wsOverUnixTransport`, so what is under test is the pair
 * as the adapter actually uses it, down to the argv and the readiness probe.
 * Persona selection comes from argv0 through a symlink named `codex`, because
 * `spawnAppServer` passes no environment to the child it spawns — which is the
 * same reason an app has to reach the imposter this way (§11.2).
 */
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/puppeteer-core';
import {
  createCodexSession,
  spawnAppServer,
  wsOverUnixTransport,
  type CodexSession,
} from '@vibecook/puppeteer-adapter-codex';

const AI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai.mjs');

const temporaries = new Set<string>();
const disposers = new Set<() => void>();
let session: CodexSession | undefined;

afterEach(async () => {
  await session?.dispose().catch(() => undefined);
  session = undefined;
  for (const dispose of disposers) dispose();
  disposers.clear();
  for (const path of temporaries) rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  temporaries.clear();
});

// Kept under the suite's 20 s testTimeout so this deadline fires first and
// names the milestone that was missed, rather than leaving vitest to report a
// bare timeout.
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A `codex`-named symlink to `ai`, which is all an app has to do to reach it. */
function codexShim(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-codex-shim-')));
  temporaries.add(directory);
  chmodSync(AI, 0o755);
  const shim = join(directory, 'codex');
  symlinkSync(AI, shim);
  return shim;
}

// Symlinks need privileges on Windows, and the socket transport is POSIX-only
// on this side too (§11.4). The stdio conformance suite covers both platforms.
describe.skipIf(process.platform === 'win32')('the codex imposter, served over a unix socket', () => {
  it('answers the adapter’s own transport, spawned exactly as it spawns the vendor', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-codex-socket-')));
    temporaries.add(cwd);

    // The adapter's spawn helper, unmodified: it appends
    // `app-server --listen unix://<sock>` and waits for the socket file.
    const server = spawnAppServer({ executable: codexShim() });
    disposers.add(() => server.dispose());
    await server.ready();
    expect(existsSync(server.socketPath)).toBe(true);

    const events: AgentEventEnvelope[] = [];
    session = await createCodexSession({ cwd, transport: wsOverUnixTransport(server.socketPath) });
    session.onEvent((envelope) => events.push(envelope));

    // A thread exists, which means the handshake completed, `initialize` was
    // answered through the gate, and `thread/start` minted an id — the whole
    // chain the pane path needs, over the wire the pane path uses.
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    await session.submitPrompt({ text: 'summarise the repo' });
    await waitFor(() => events.some((envelope) => envelope.event.type === 'turn.completed'), 'a completed turn');

    const assistant = events.find((envelope) => envelope.event.type === 'assistant.message');
    expect(assistant).toBeDefined();
    // Frames are not lines: an assistant reply that arrived intact proves the
    // WS framing round-tripped, not merely that something connected.
    if (assistant?.event.type === 'assistant.message') expect(assistant.event.text.length).toBeGreaterThan(0);
  });

  it('serves several clients at once, because the TUI joins beside the controller', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-codex-socket-')));
    temporaries.add(cwd);
    const server = spawnAppServer({ executable: codexShim() });
    disposers.add(() => server.dispose());
    await server.ready();

    session = await createCodexSession({ cwd, transport: wsOverUnixTransport(server.socketPath) });
    const owned = session.sessionId;

    // A second connection to the same server, exactly as `codex resume <id>
    // --remote` makes. It must not disturb the first: a server that could only
    // hold one client would drop the controller the moment the pane attached.
    const second = wsOverUnixTransport(server.socketPath);
    const replies: unknown[] = [];
    second.onMessage((message) => replies.push(message));
    second.send({ id: 1, method: 'initialize', params: {} });
    await waitFor(() => replies.length > 0, 'the second client’s initialize reply');
    second.close();

    expect(session.sessionId).toBe(owned);
  });

  it('removes its socket on the way out, so a stale file cannot report ready', async () => {
    const server = spawnAppServer({ executable: codexShim() });
    await server.ready();
    const path = server.socketPath;
    server.dispose();
    // `ready()` is `existsSync(socketPath)` in the adapter, so a file left
    // behind by a dead imposter would pass the probe and then refuse every
    // connection — a hang instead of a failure.
    await waitFor(() => !existsSync(path), 'the socket file to be removed');
  });
});
