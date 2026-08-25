/**
 * The codex recipe with `ai` as the vendor binary — what a Godview pane does
 * when someone types `ai --codex` (docs/archive/IMPOSTER.md §11.2).
 *
 * `conformance.codex-socket.test.ts` proves the transport. This proves the
 * RECIPE on top of it: `prepareCodexTuiSession` spawns a private app-server,
 * owns a thread on it, and hands back the argv for the TUI the pane will run.
 * All three have to work against the imposter for a session to be adopted, and
 * the failure that motivated this file was invisible from either end alone —
 * the app-server came up, and the pane still showed nothing.
 *
 * The environment is the load-bearing part. That app-server is spawned by the
 * ADAPTER, not launched from the returned spec, so the persona can only reach
 * it through `appServerEnv`; without it the child is an `ai` told to be nobody
 * and exits 2 before the socket ever appears.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHost, TerminalSpec } from '@vibecook/puppeteer-core';
import { prepareCodexTuiSession } from '@vibecook/puppeteer-adapter-codex';

const AI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai.mjs');

const temporaries = new Set<string>();
const disposers = new Set<() => Promise<void>>();

afterEach(async () => {
  for (const dispose of disposers) await dispose().catch(() => undefined);
  disposers.clear();
  for (const path of temporaries) rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  temporaries.clear();
});

function workspace(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-codex-pane-')));
  temporaries.add(cwd);
  return cwd;
}

/** Records the TUI spec instead of spawning it, which is the pane's job. */
function recordingHost(): { host: AgentHost; launched: TerminalSpec[] } {
  const launched: TerminalSpec[] = [];
  return {
    launched,
    host: {
      spawnTerminal: async (spec: TerminalSpec) => {
        launched.push(spec);
        return { runtimeSessionId: 'rt-pane' };
      },
      automateTerminal: async () => ({ accepted: true }),
    },
  };
}

// Unix sockets, and `ai` spawned as a script by absolute path. The Windows gap
// is the same one §11.4 records for the control channel.
describe.skipIf(process.platform === 'win32')('the codex recipe against `ai`', () => {
  it('brings up an app-server, owns a thread, and hands back the TUI argv', async () => {
    const cwd = workspace();
    const { host } = recordingHost();

    const prepared = await prepareCodexTuiSession({
      cwd,
      host,
      // Exactly what spawn-through passes: the imposter as the binary, and the
      // persona in the environment of the process it cannot otherwise reach.
      executable: AI,
      appServerEnv: { AI_PERSONA: 'codex' },
    });
    disposers.add(() => prepared.dispose());

    // A thread id means `initialize` and `thread/start` both landed, over a
    // socket the adapter opened itself.
    expect(prepared.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // The pane will run this verbatim. `resume <id> --remote unix://…` is the
    // form that joins the OWNED thread; a bare `--remote` would create a second
    // one on the first keystroke and observe nothing (tui-session.ts).
    expect(prepared.launch.args.slice(-2)[0]).toBe('--remote');
    expect(prepared.launch.args).toContain('resume');
    expect(prepared.launch.args).toContain(prepared.sessionId);
    expect(prepared.launch.args.at(-1)).toMatch(/^unix:\/\//);
  });

  it('fails rather than hangs when the persona cannot reach the app-server', async () => {
    const cwd = workspace();
    const { host } = recordingHost();

    // No appServerEnv: the child is `ai` with no persona, which exits 2. The
    // adapter must report that, not sit on `existsSync(socketPath)` until its
    // own timeout — a hang here would surface in a pane as a session stuck on
    // `preparing` with nothing to explain it.
    await expect(prepareCodexTuiSession({ cwd, host, executable: AI })).rejects.toThrow(/exited before ready/);
  });
});
