// The empty pane launcher's live witness (QL-1): a fresh Godview window in a
// throwaway profile, with its own terminal daemon, opens on no saved
// workspace, so its first pane is a shell born there and must show the
// launcher. Everything goes over the DevTools protocol: `Runtime.evaluate`
// reads the page, and with `--drive` `Input.dispatchKeyEvent` delivers keys
// to the page itself — no input reaches the operating system.
//
// `--drive` walks the launcher end to end: (a) ⌥↵ opens the field on this
// folder's past sessions; (b) typing filters them and ⇥ flips the scope;
// (c) ⎋ closes the field back to the terminal and a second ⎋ dismisses the
// launcher; (d) ⌥digit in a new pane launches a real agent there and the deck's
// reaper terminates the shell it replaced; (e) a plain key in a third pane
// dismisses the launcher and reaches the shell. The agent is the first
// installed of GODVIEW_LAUNCHER_DRIVE_AGENTS (default: codex, opencode, pi,
// grok, kimi); nothing is ever sent to it, and it is killed with the window.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const drive = process.argv.includes('--drive');
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
const DRIVE_AGENTS = (process.env.GODVIEW_LAUNCHER_DRIVE_AGENTS ?? 'codex,opencode,pi,grok,kimi').split(',');

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, probe, deadlineMs = DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

/** One DevTools page connection: `evaluate` (awaiting promises) and raw `send`. */
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
  async function send(method, params = {}) {
    id += 1;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method, params }));
    const message = await answer;
    if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
    return message.result;
  }
  return {
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

const ALT = 1;
/** One key, down and up, to whatever the page has focused. */
async function press(page, { key, code, keyCode, modifiers = 0, text }) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await page.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(text ? { text } : {}),
  });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function typeText(page, text) {
  for (const char of text) {
    const upper = char.toUpperCase();
    const letter = /[a-z]/i.test(char);
    await press(page, {
      key: char,
      code: letter ? `Key${upper}` : /[0-9]/.test(char) ? `Digit${char}` : 'Space',
      keyCode: letter ? upper.charCodeAt(0) : char.charCodeAt(0),
      text: char,
    });
  }
}

/**
 * Page-side reach into the running app for what the DOM does not say: the
 * Ghosttea runtime and workspace, found through React's own fiber tree from
 * the root (test-only; the app exposes no globals).
 */
const PAGE_HELPERS = `(() => {
  if (window.__launcherDrive) return true;
  const root = document.getElementById('root');
  const containerKey = Object.keys(root).find((key) => key.startsWith('__reactContainer$'));
  const find = (match) => {
    const stack = [root[containerKey].stateNode.current];
    while (stack.length) {
      const fiber = stack.pop();
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object' && match(props)) return props;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return undefined;
  };
  const runtime = () => find((props) => props.runtime && typeof props.runtime.listSessions === 'function')?.runtime;
  const workspace = () => find((props) => props.workspace && Array.isArray(props.workspace.panes))?.workspace;
  const paneOf = (sessionId) => workspace()?.panes.find((pane) => pane.session.id === sessionId);
  const paneElement = (paneId) => document.querySelector('[data-pane-id="' + paneId + '"]');
  window.__launcherDrive = {
    runtime,
    workspace,
    paneOf,
    paneElement,
    launcherIn: (paneId) => paneElement(paneId)?.querySelector('.vf-pane-launcher') ?? null,
    focusTerminal: (paneId) => {
      const input = paneElement(paneId)?.querySelector('.terminal-input');
      input?.focus();
      return input !== null && input !== undefined && document.activeElement === input;
    },
  };
  return true;
})()`;

const child = spawn(electron, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '.'], {
  cwd: appDirectory,
  env: environment,
  stdio: ['ignore', 'inherit', 'inherit'],
});
let page;
let agent;
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
        paneId: pane?.getAttribute('data-pane-id') ?? null,
        session: launcher.closest('[data-vf-pane-launcher]')?.getAttribute('data-vf-pane-launcher') ?? null,
        className: launcher.className,
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

  if (drive) {
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.evaluate(PAGE_HELPERS);
    const first = witness.paneId;
    await until('the first pane’s terminal to take focus', () =>
      page.evaluate(`window.__launcherDrive.focusTerminal(${JSON.stringify(first)})`),
    );

    // (a) ⌥↵ opens the field, the keyboard moves into it, and the history answers.
    await press(page, { key: 'Enter', code: 'Enter', keyCode: 13, modifiers: ALT });
    const opened = await until('the field to open with an answer', () =>
      page.evaluate(`(() => {
        const launcher = window.__launcherDrive.launcherIn(${JSON.stringify(first)});
        if (!launcher?.classList.contains('is-open')) return undefined;
        const input = launcher.querySelector('input');
        if (document.activeElement !== input) return undefined;
        const rows = launcher.querySelectorAll('[role="option"]').length;
        const said = launcher.querySelector('.vf-pane-launcher-empty, [role="status"]');
        const text = said?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
        if (rows === 0 && (text === '' || text.startsWith('Reading past sessions'))) return undefined;
        const firstTitle = launcher.querySelector('[role="option"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null;
        return { focused: true, rows, said: rows === 0 ? text : null, firstTitle };
      })()`),
    );
    console.log(`DRIVE (a) OK ${JSON.stringify(opened)}`);

    // (b) ⇥ flips the scope (to every folder, where there is most to filter);
    // typing a word from a listed title narrows the list; ⇥ flips it back.
    const launcherOf = `window.__launcherDrive.launcherIn(${JSON.stringify(first)})`;
    const scopeNow = () => page.evaluate(`${launcherOf}?.querySelector('.vf-pane-launcher-scope .is-on')?.textContent`);
    const listing = (query) =>
      page.evaluate(`(() => {
        const launcher = ${launcherOf};
        const input = launcher?.querySelector('input');
        if (input?.value !== ${JSON.stringify(query)}) return undefined;
        const rows = [...launcher.querySelectorAll('[role="option"]')].map((row) => row.textContent.replace(/\\s+/g, ' ').trim());
        const said = launcher.querySelector('.vf-pane-launcher-empty')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
        if (rows.length === 0 && (said === '' || said.startsWith('Reading past sessions'))) return undefined;
        const title = launcher.querySelector('[role="option"] .vf-pane-launcher-rt b')?.textContent.trim() ?? null;
        return { rows: rows.length, first: title, said: rows.length ? null : said };
      })()`);
    const flip = async (from) => {
      await press(page, { key: 'Tab', code: 'Tab', keyCode: 9 });
      return until('the scope to flip', async () => {
        const on = await scopeNow();
        return on && on !== from ? on : undefined;
      });
    };
    const scopeStart = await scopeNow();
    const scopeFlipped = await flip(scopeStart);
    const everything = await until('the wider list', () => listing(''));
    const token =
      (everything.first ?? '')
        .split(/[^A-Za-z]+/)
        .find((word) => word.length >= 4)
        ?.toLowerCase() ?? 'zzqx';
    await typeText(page, token);
    const narrowed = await until('the list to follow the query', () => listing(token));
    if (narrowed.rows > everything.rows) throw new Error('typing widened the list');
    if (everything.rows > 0 && narrowed.rows === 0)
      throw new Error(`a word from a listed title matched nothing: ${token}`);
    const scopeBack = await flip(scopeFlipped);
    console.log(
      `DRIVE (b) OK ${JSON.stringify({ scope: [scopeStart, scopeFlipped, scopeBack], rowsBefore: everything.rows, query: token, rowsAfter: narrowed.rows, said: narrowed.said })}`,
    );

    // (c) ⎋ closes the field back to the terminal; a second ⎋ dismisses the launcher.
    await press(page, { key: 'Escape', code: 'Escape', keyCode: 27 });
    const closed = await until('the field to close with the terminal focused', () =>
      page.evaluate(`(() => {
        const pane = window.__launcherDrive.paneElement(${JSON.stringify(first)});
        const launcher = window.__launcherDrive.launcherIn(${JSON.stringify(first)});
        if (!launcher || launcher.classList.contains('is-open')) return undefined;
        return document.activeElement === pane.querySelector('.terminal-input') ? { terminalFocused: true } : undefined;
      })()`),
    );
    await press(page, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await until('the launcher to be dismissed', () =>
      page.evaluate(`window.__launcherDrive.launcherIn(${JSON.stringify(first)}) === null`),
    );
    console.log(`DRIVE (c) OK ${JSON.stringify({ ...closed, dismissed: true })}`);

    // (d) ⌥digit in a new fresh pane launches an agent there; the reaper ends the shell.
    const split = async () => {
      const shell = await page.evaluate(
        `window.__launcherDrive.workspace().splitActive('horizontal').then((s) => s?.id)`,
      );
      if (!shell) throw new Error('the deck did not split');
      const paneId = await until('the new pane', () =>
        page.evaluate(`window.__launcherDrive.paneOf(${JSON.stringify(shell)})?.id`),
      );
      await until('a launcher in the new pane', () =>
        page.evaluate(
          `window.__launcherDrive.launcherIn(${JSON.stringify(paneId)})?.querySelectorAll('.vf-pane-launcher-agent').length > 0`,
        ),
      );
      await until('the new pane’s terminal to take focus', () =>
        page.evaluate(`window.__launcherDrive.focusTerminal(${JSON.stringify(paneId)})`),
      );
      return { shell, paneId };
    };
    const second = await split();
    const choice = await page.evaluate(`(() => {
      const rows = [...window.__launcherDrive.launcherIn(${JSON.stringify(second.paneId)}).querySelectorAll('.vf-pane-launcher-agent')];
      const offered = rows.map((row) => ({
        label: row.querySelector('.vf-pane-launcher-nm')?.textContent ?? '',
        keys: row.getAttribute('aria-keyshortcuts') ?? '',
        off: row.classList.contains('is-off'),
      }));
      for (const wanted of ${JSON.stringify(DRIVE_AGENTS)}) {
        const row = offered.find((candidate) => !candidate.off && candidate.label.toLowerCase().replace(/\\s+/g, '').includes(wanted));
        if (row) return row;
      }
      return { offered };
    })()`);
    const digit = /(\d)$/.exec(choice.keys ?? '')?.[1];
    if (!digit) throw new Error(`no installed agent among ${DRIVE_AGENTS.join(', ')}: ${JSON.stringify(choice)}`);
    const inputBefore = await page.evaluate(
      `window.__launcherDrive.runtime().sessionHasInput(${JSON.stringify(second.shell)})`,
    );
    await press(page, { key: digit, code: `Digit${digit}`, keyCode: 48 + Number(digit), modifiers: ALT });
    const launched = await until(
      'the agent to be mounted in the pane',
      () =>
        page.evaluate(`(async () => {
          const pane = window.__launcherDrive.workspace().panes.find((candidate) => candidate.id === ${JSON.stringify(second.paneId)});
          const failure = window.__launcherDrive.launcherIn(${JSON.stringify(second.paneId)})?.querySelector('.vf-pane-launcher-failure')?.textContent;
          if (failure) return { refused: failure };
          if (!pane || pane.session.id === ${JSON.stringify(second.shell)}) return undefined;
          const agents = await window.puppeteer.listAgentSessions();
          const agent = agents.find((candidate) => candidate.info.session.id === pane.session.id);
          if (!agent) return undefined;
          return {
            session: pane.session.id,
            provider: agent.info.provider.id,
            pid: agent.info.session.pid,
            launcherGone: window.__launcherDrive.launcherIn(${JSON.stringify(second.paneId)}) === null,
          };
        })()`),
      120_000,
    );
    if (launched.refused) throw new Error(`the launch was refused: ${launched.refused}`);
    if (launched.pid) agent = { pid: launched.pid, provider: launched.provider };
    if (!launched.launcherGone) throw new Error('the launcher stayed after the launch');
    const reaped = await until('the replaced shell to be terminated', () =>
      page.evaluate(`(async () => {
        const sessions = await window.__launcherDrive.runtime().listSessions();
        const shell = sessions.find((session) => session.id === ${JSON.stringify(second.shell)});
        if (shell && !shell.exited) return undefined;
        return { shell: shell ? 'exited' : 'gone', requestedTermination: shell?.requestedTermination ?? null };
      })()`),
    );
    console.log(
      `DRIVE (d) OK ${JSON.stringify({ agent: choice.label, key: choice.keys, shellHadInput: inputBefore, ...launched, replacedShell: reaped })}`,
    );

    // (e) A plain key in a third fresh pane is the shell's: the launcher leaves and the key arrives.
    const third = await split();
    await press(page, { key: 'e', code: 'KeyE', keyCode: 69, text: 'e' });
    const typed = await until('the key to reach the shell', () =>
      page.evaluate(`(() => {
        const gone = window.__launcherDrive.launcherIn(${JSON.stringify(third.paneId)}) === null;
        const input = window.__launcherDrive.runtime().sessionHasInput(${JSON.stringify(third.shell)});
        return gone && input ? { launcherGone: gone, shellHasInput: input } : undefined;
      })()`),
    );
    console.log(`DRIVE (e) OK ${JSON.stringify(typed)}`);
    console.log('LAUNCHER DRIVE OK');
  }
} catch (error) {
  console.error(`LAUNCHER SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  // What the page looked like when it failed: every launcher and where the keyboard was.
  const state = await page
    ?.evaluate(
      `(() => ({
        hasFocus: document.hasFocus(),
        active: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : null,
        activeInPane: document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
        launchers: [...document.querySelectorAll('.vf-pane-launcher')].map((launcher) => ({
          pane: launcher.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
          className: launcher.className,
          text: launcher.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300),
        })),
      }))()`,
    )
    .catch(() => undefined);
  if (state) console.error(`LAUNCHER SMOKE STATE ${JSON.stringify(state)}`);
} finally {
  page?.close();
  child.kill('SIGTERM');
  await Promise.race([new Promise((done) => child.once('exit', done)), delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  // Electron can leave a helper behind its killed parent; only this run's profile path names it.
  const orphans = spawnSync('pgrep', ['-f', profile], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  // The launched agent, if its daemon did not take it down with the window —
  // only while that pid still runs a command naming the agent.
  const command = agent
    ? spawnSync('ps', ['-p', String(agent.pid), '-o', 'command='], { encoding: 'utf8' }).stdout
    : '';
  const straggler = agent && command.toLowerCase().includes(agent.provider) ? [agent.pid] : [];
  if (straggler.length) console.log(`killing the launched ${agent.provider} (${agent.pid}) left behind`);
  for (const pid of [...orphans.map(Number), ...straggler]) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  if (process.env.GODVIEW_KEEP_LAUNCHER_SMOKE === '1') console.log(`Launcher smoke profile: ${profile}`);
  else rmSync(profile, { recursive: true, force: true });
}
