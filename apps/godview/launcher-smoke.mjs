// The empty pane launcher's live witness (QL-1): a fresh Godview window in a
// throwaway profile, with its own terminal daemon, opens on no saved
// workspace, so its first pane is a shell born there and must show the
// launcher. Read over the DevTools protocol only — nothing is typed or
// clicked, and no input reaches the operating system.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const profile = mkdtempSync(join(tmpdir(), 'godview-launcher-smoke-'));
const environment = { ...process.env, GHOSTTEA_TRUFFLE_ENABLED: 'false' };
for (const key of [
  'GHOSTTEA_EXTERNAL_CONTROL_SOCKET',
  'GHOSTTEA_EXTERNAL_FRAME_SOCKET',
  'GHOSTTEA_EXTERNAL_AUTH_TOKEN',
]) {
  delete environment[key];
}
const DEADLINE_MS = Number(process.env.GODVIEW_LAUNCHER_SMOKE_TIMEOUT_MS ?? 90_000);

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, probe) {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

/** One DevTools page connection with a single `Runtime.evaluate` verb. */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  return {
    async evaluate(expression) {
      id += 1;
      const answer = new Promise((resolve) => pending.set(id, resolve));
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      const message = await answer;
      if (message.error || message.result?.exceptionDetails) {
        throw new Error(JSON.stringify(message.error ?? message.result.exceptionDetails));
      }
      return message.result.result.value;
    },
    close: () => socket.close(),
  };
}

const child = spawn(electron, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '.'], {
  cwd: appDirectory,
  env: environment,
  stdio: ['ignore', 'inherit', 'inherit'],
});
let page;
try {
  const port = await until('the DevTools port', async () =>
    readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]?.trim(),
  );
  const target = await until('the Godview page', async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find((candidate) => candidate.type === 'page' && candidate.url.endsWith('/index.html'));
  });
  page = await connect(target.webSocketDebuggerUrl);
  const witness = await until('a launcher in the fresh first pane', () =>
    page.evaluate(`(() => {
      const launcher = document.querySelector('.vf-pane-launcher');
      if (!launcher) return undefined;
      const pane = launcher.closest('[data-pane-id]');
      return {
        inPane: pane !== null,
        session: launcher.closest('[data-vf-pane-launcher]')?.getAttribute('data-vf-pane-launcher') ?? null,
        className: launcher.className,
        agents: document.querySelectorAll('.vf-pane-launcher-agent').length,
      };
    })()`),
  );
  if (!witness.inPane) throw new Error('the launcher is not inside a Ghosttea pane');
  // The rows come from main's `launcher:agents`: seeing them witnesses the channel end to end.
  const agents = await until('the agent rows from main', () =>
    page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.vf-pane-launcher-agent')];
      return rows.length > 0 ? rows.map((row) => row.textContent.replace(/\\s+/g, ' ').trim()) : undefined;
    })()`),
  );
  console.log(`LAUNCHER SMOKE OK ${JSON.stringify({ ...witness, agents })}`);
} catch (error) {
  console.error(`LAUNCHER SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  page?.close();
  child.kill('SIGTERM');
  await Promise.race([new Promise((done) => child.once('exit', done)), delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  // Electron can leave a helper behind its killed parent; only this run's profile path names it.
  const orphans = spawnSync('pgrep', ['-f', profile], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const pid of orphans) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  if (process.env.GODVIEW_KEEP_LAUNCHER_SMOKE === '1') console.log(`Launcher smoke profile: ${profile}`);
  else rmSync(profile, { recursive: true, force: true });
}
