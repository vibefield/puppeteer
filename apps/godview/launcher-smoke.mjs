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
// launcher; (d) a click (`Input.dispatchMouseEvent`) in the field of a fresh
// pane that is NOT the active one selects that pane and opens its field, and
// ↓ and ⎋ then work there; (e) ⌥digit in a new pane launches a real agent
// there and the deck's reaper terminates the shell it replaced; (f) a plain
// key in another pane dismisses the launcher and reaches the shell; (g) a shell
// that reported its folder as an OSC 7 `file://` URL still lists that folder's
// sessions (skipped, and said so, when no OSC 7 arrives). The agent
// With --agent-exit it also sends /exit once ready and verifies the same pane
// returns to an input-ready shell with the empty launcher (no resume chrome).
// The agent is the first installed of GODVIEW_LAUNCHER_DRIVE_AGENTS (default: codex,
// opencode, pi, grok, kimi); nothing is ever sent to it, and it is killed with
// the window.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const checkAgentExit = process.argv.includes('--agent-exit');
const drive = process.argv.includes('--drive') || checkAgentExit;
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

/** A probe that has not answered in this long counts as no answer (a page that stopped answering must not hang the smoke). */
const PROBE_MS = 10_000;

async function until(what, probe, deadlineMs = DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    let timer;
    const answer = await Promise.race([
      probe().then(
        (value) => ({ value }),
        (error) => ({ error: error instanceof Error ? error.message : String(error) }),
      ),
      new Promise((done) => {
        timer = setTimeout(() => done({ silent: true }), PROBE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (answer.value) return answer.value;
    last = answer.silent
      ? `no answer in ${PROBE_MS} ms`
      : answer.error
        ? `threw ${answer.error}`
        : JSON.stringify(answer.value);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last probe: ${last ?? 'undefined'})`);
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

/** One left click at a point of the page, down and up. */
async function click(page, x, y) {
  const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...base });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base });
}

async function typeText(page, text) {
  for (const char of text) {
    const upper = char.toUpperCase();
    const letter = /[a-z]/i.test(char);
    await press(page, {
      key: char,
      code: letter ? `Key${upper}` : /[0-9]/.test(char) ? `Digit${char}` : char === '/' ? 'Slash' : 'Space',
      keyCode: letter ? upper.charCodeAt(0) : char === '/' ? 191 : char.charCodeAt(0),
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
  const find = (match) => {
    const root = document.getElementById('root');
    if (!root) return undefined;
    const containerKey = Object.keys(root).find((key) => key.startsWith('__reactContainer$'));
    if (!containerKey) return undefined;
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
    // Ghosttea answers a terminal's focus by selecting its pane and focusing
    // it once more a frame later; a key sent before that frame could open a
    // field that the late focus then closes. So this settles two frames.
    focusTerminal: (paneId) => {
      const input = paneElement(paneId)?.querySelector('.terminal-input');
      input?.focus();
      return new Promise((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => done(input !== null && input !== undefined && document.activeElement === input)),
        ),
      );
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
  if (checkAgentExit) {
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.evaluate(PAGE_HELPERS);
    await until('the workspace before the exit witness', () =>
      page.evaluate('Boolean(window.__launcherDrive.workspace())'),
    );
    // Main may seed the initial shell, intentionally without a renderer birth
    // receipt. Exercise an explicit fresh split instead of depending on that boot choice.
    await page.evaluate('window.__launcherDrive.workspace().splitActive()');
  }
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
        const titles = [...launcher.querySelectorAll('[role="option"] .vf-pane-launcher-rt b')].map((b) => b.textContent.trim());
        return { rows: rows.length, titles, said: rows.length ? null : said };
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
    // A word from a listed title (not the placeholder's "untitled session"). The
    // typed list may hold MORE rows than the latest-five one it came from (a
    // search keeps twelve per group), so the check is that the word finds a
    // row whose title says it — never that the list only shrinks.
    const token =
      everything.titles
        .flatMap((title) => title.split(/[^A-Za-z]+/))
        .map((word) => word.toLowerCase())
        .find((word) => word.length >= 4 && word !== 'untitled' && word !== 'session') ?? 'zzqx';
    await typeText(page, token);
    const narrowed = await until('the list to follow the query', () => listing(token));
    if (token !== 'zzqx' && !narrowed.titles.some((title) => title.toLowerCase().includes(token)))
      throw new Error(`a word from a listed title found no row titled with it: ${token}`);
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

    // (d) Two fresh panes, A selected; a click in B's field selects B and opens
    // its field, and B's keys are B's launcher's: ↓ moves, ⎋ closes, ⎋ dismisses.
    const paneA = await split();
    const paneB = await split();
    await page.evaluate(`window.__launcherDrive.workspace().activateSession(${JSON.stringify(paneA.shell)})`);
    await until('pane A to be the selected one, its terminal focused', () =>
      page.evaluate(`(() => {
        if (window.__launcherDrive.workspace().activePaneId !== ${JSON.stringify(paneA.paneId)}) return undefined;
        return window.__launcherDrive.focusTerminal(${JSON.stringify(paneA.paneId)});
      })()`),
    );
    const target = await until('B’s field to be on screen and hit', () =>
      page.evaluate(`(() => {
        const input = window.__launcherDrive.launcherIn(${JSON.stringify(paneB.paneId)})?.querySelector('input');
        if (!input) return undefined;
        const box = input.getBoundingClientRect();
        if (box.width < 4 || box.height < 4) return undefined;
        const x = box.left + Math.min(24, box.width / 2);
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        const field = hit?.closest('.vf-pane-launcher-field');
        const inB = hit?.closest('[data-pane-id]')?.getAttribute('data-pane-id') === ${JSON.stringify(paneB.paneId)};
        return field && inB ? { x, y } : undefined;
      })()`),
    );
    await click(page, target.x, target.y);
    const clicked = await until('B to be selected with its field open and focused', () =>
      page.evaluate(`(() => {
        const launcher = window.__launcherDrive.launcherIn(${JSON.stringify(paneB.paneId)});
        const input = launcher?.querySelector('input');
        const selected = window.__launcherDrive.workspace().activePaneId;
        if (selected !== ${JSON.stringify(paneB.paneId)} || !launcher?.classList.contains('is-open')) return undefined;
        if (document.activeElement !== input) return undefined;
        const rows = launcher.querySelectorAll('[role="option"]').length;
        const said = launcher.querySelector('.vf-pane-launcher-empty, [role="status"]')?.textContent.trim() ?? '';
        if (rows === 0 && (said === '' || said.startsWith('Reading past sessions'))) return undefined;
        return { selected, open: true, focused: true, rows };
      })()`),
    );
    const highlighted = () =>
      page.evaluate(`(() => {
        const launcher = window.__launcherDrive.launcherIn(${JSON.stringify(paneB.paneId)});
        const options = [...(launcher?.querySelectorAll('[role="option"]') ?? [])];
        return {
          index: options.findIndex((option) => option.getAttribute('aria-selected') === 'true'),
          open: launcher?.classList.contains('is-open') ?? false,
          query: launcher?.querySelector('input')?.value ?? null,
          focused: document.activeElement === launcher?.querySelector('input'),
        };
      })()`);
    const before = await highlighted();
    await press(page, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
    const moved = await until('↓ to act in B', async () => {
      const now = await highlighted();
      if (!now.open || !now.focused || now.query !== '') return undefined;
      // With two rows or more ↓ moves the highlight; with fewer it is held, and the field stays as it was.
      if (clicked.rows >= 2) return now.index === before.index + 1 ? now : undefined;
      return now;
    });
    await press(page, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await until('⎋ to close B’s field with B’s terminal focused', () =>
      page.evaluate(`(() => {
        const pane = window.__launcherDrive.paneElement(${JSON.stringify(paneB.paneId)});
        const launcher = window.__launcherDrive.launcherIn(${JSON.stringify(paneB.paneId)});
        if (!launcher || launcher.classList.contains('is-open')) return undefined;
        return document.activeElement === pane.querySelector('.terminal-input');
      })()`),
    );
    await press(page, { key: 'Escape', code: 'Escape', keyCode: 27 });
    await until('the second ⎋ to dismiss B’s launcher', () =>
      page.evaluate(`window.__launcherDrive.launcherIn(${JSON.stringify(paneB.paneId)}) === null`),
    );
    const aStill = await page.evaluate(`window.__launcherDrive.launcherIn(${JSON.stringify(paneA.paneId)}) !== null`);
    if (!aStill) throw new Error('keys aimed at B reached A’s launcher');
    console.log(
      `DRIVE (d) OK ${JSON.stringify({ clicked, highlight: [before.index, moved.index], closed: true, dismissed: true, aUntouched: aStill })}`,
    );

    // (e) ⌥digit in a new fresh pane launches an agent there; the reaper ends the shell.
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
    const bubble = await until('the agent to inherit the shell bubble', () =>
      page.evaluate(`(() => {
      const matches = [...document.querySelectorAll('[data-agent-bubble-id]')].filter((node) => node.dataset.agentBubbleId === ${JSON.stringify(second.shell)});
      return matches.length === 1 && matches[0].dataset.agentBubbleSource === 'agent'
        ? { id: matches[0].dataset.agentBubbleId, count: matches.length, source: matches[0].dataset.agentBubbleSource } : undefined;
    })()`),
    );
    const reaped = await until('the replaced shell to be terminated', () =>
      page.evaluate(`(async () => {
        const sessions = await window.__launcherDrive.runtime().listSessions();
        const shell = sessions.find((session) => session.id === ${JSON.stringify(second.shell)});
        if (shell && !shell.exited) return undefined;
        return { shell: shell ? 'exited' : 'gone', requestedTermination: shell?.requestedTermination ?? null };
      })()`),
    );
    console.log(
      `DRIVE (e) OK ${JSON.stringify({ agent: choice.label, key: choice.keys, shellHadInput: inputBefore, ...launched, bubble, replacedShell: reaped })}`,
    );

    if (checkAgentExit) {
      await until('the launched agent to be ready for /exit', () =>
        page.evaluate(`(async () => {
          const agents = await window.puppeteer.listAgentMonitors();
          return agents.some((agent) => agent.terminalSessionId === ${JSON.stringify(launched.session)} && agent.state.alive && agent.state.status === 'idle');
        })()`),
      );
      await page.evaluate(`window.__launcherDrive.focusTerminal(${JSON.stringify(second.paneId)})`);
      await until('agent terminal keyboard focus', () =>
        page.evaluate(
          `document.activeElement === window.__launcherDrive.paneElement(${JSON.stringify(second.paneId)})?.querySelector('.terminal-input')`,
        ),
      );
      // A real native command, through the same key path as the user. No prompt or model request.
      await typeText(page, '/exit');
      const exitAt = Date.now();
      await press(page, { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
      const returned = await until('clean agent exit to return its pane to a fresh launcher and usable shell', () =>
        page.evaluate(`(async () => {
          const workspace = window.__launcherDrive.workspace();
          const pane = workspace.panes.find((candidate) => candidate.id === ${JSON.stringify(second.paneId)});
          if (!pane || pane.session.id === ${JSON.stringify(launched.session)}) return undefined;
          const element = window.__launcherDrive.paneElement(pane.id);
          const input = element?.querySelector('.terminal-input');
          if (!input || input.readOnly || !window.__launcherDrive.launcherIn(pane.id)) return undefined;
          if (element.querySelector('.vf-pane-verb.is-resume')) throw new Error('ended-agent chrome survived');
          if (workspace.activePaneId !== pane.id) throw new Error('exit changed the active pane');
          return { paneId: pane.id, session: pane.session.id, cwd: pane.session.cwd, active: workspace.activePaneId, focused: document.activeElement === input, panes: workspace.panes.length };
        })()`),
      );
      console.log(`AGENT EXIT OK ${JSON.stringify({ ...returned, exitToFreshShellMs: Date.now() - exitAt })}`);
    }

    // (f) A plain key in a third fresh pane is the shell's: the launcher leaves and the key arrives.
    const third = await split();
    await press(page, { key: 'e', code: 'KeyE', keyCode: 69, text: 'e' });
    const typed = await until('the key to reach the shell', () =>
      page.evaluate(`(() => {
        const gone = window.__launcherDrive.launcherIn(${JSON.stringify(third.paneId)}) === null;
        const input = window.__launcherDrive.runtime().sessionHasInput(${JSON.stringify(third.shell)});
        return gone && input ? { launcherGone: gone, shellHasInput: input } : undefined;
      })()`),
    );
    console.log(`DRIVE (f) OK ${JSON.stringify(typed)}`);

    // (g) Once a shell has reported its folder by OSC 7 (a `file://host/…`
    // cwd), its launcher still asks main about a PATH: the field lists this
    // folder's sessions as (a) did. Pane A kept its launcher through (d)–(f).
    const reported = await until(
      'pane A’s shell to report its folder by OSC 7',
      () =>
        page.evaluate(`(() => {
          const cwd = window.__launcherDrive.paneOf(${JSON.stringify(paneA.shell)})?.session.cwd ?? '';
          return /^file:/i.test(cwd) ? cwd : undefined;
        })()`),
      30_000,
    ).catch(() => undefined);
    if (!reported || !/^file:/i.test(reported) || opened.rows === 0) {
      console.log(`DRIVE (g) SKIPPED ${JSON.stringify({ cwd: reported ?? null, rowsInA: opened.rows })}`);
    } else {
      await until('pane A’s terminal to take focus', () =>
        page.evaluate(`(() => {
          window.__launcherDrive.workspace().activateSession(${JSON.stringify(paneA.shell)});
          return window.__launcherDrive.focusTerminal(${JSON.stringify(paneA.paneId)});
        })()`),
      );
      await press(page, { key: 'Enter', code: 'Enter', keyCode: 13, modifiers: ALT });
      const listed = await until('A’s field to list this folder’s sessions', () =>
        page.evaluate(`(() => {
          const launcher = window.__launcherDrive.launcherIn(${JSON.stringify(paneA.paneId)});
          if (!launcher?.classList.contains('is-open')) return undefined;
          const rows = launcher.querySelectorAll('[role="option"]').length;
          const said = launcher.querySelector('.vf-pane-launcher-empty')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
          if (rows === 0 && (said === '' || said.startsWith('Reading past sessions'))) return undefined;
          return { rows, said: rows ? null : said };
        })()`),
      );
      if (listed.rows === 0) throw new Error(`an OSC 7 folder listed nothing here: ${listed.said}`);
      await press(page, { key: 'Escape', code: 'Escape', keyCode: 27 });
      console.log(`DRIVE (g) OK ${JSON.stringify({ cwd: reported, ...listed })}`);
    }
    console.log('LAUNCHER DRIVE OK');
  }
} catch (error) {
  console.error(`LAUNCHER SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  // What the page looked like when it failed: the panes, every launcher, where
  // the keyboard was, and what main's history channel answers now. Bounded, so
  // a page that stopped answering still ends the run with a line that says so.
  const state = await Promise.race([
    page
      ?.evaluate(
        `(async () => {
          const workspace = window.__launcherDrive?.workspace?.();
          const cwd = workspace?.panes.find((pane) => pane.id === workspace.activePaneId)?.session.cwd ?? undefined;
          const recent = await Promise.race([
            window.puppeteer
              .launcherRecent({ scope: 'here', limit: 5, ...(cwd ? { cwd } : {}) })
              .then((answer) => ({ status: answer.status, sessions: answer.sessions.length }))
              .catch((error) => ({ threw: String(error) })),
            new Promise((done) => setTimeout(() => done('no answer in 5 s'), 5000)),
          ]);
          // Whether the page is painting: an occluded window runs no animation frames.
          const frames = await Promise.race([
            new Promise((done) => requestAnimationFrame(() => done('painting'))),
            new Promise((done) => setTimeout(() => done('no frame in 1 s'), 1000)),
          ]);
          return {
            hasFocus: document.hasFocus(),
            visibility: document.visibilityState,
            frames,
            active: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : null,
            activeInPane: document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
            activePaneId: workspace?.activePaneId ?? null,
            panes: workspace?.panes.map((pane) => ({ id: pane.id, session: pane.session.id, cwd: pane.session.cwd ?? null })) ?? null,
            launchers: [...document.querySelectorAll('.vf-pane-launcher')].map((launcher) => ({
              pane: launcher.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
              className: launcher.className,
              query: launcher.querySelector('input')?.value ?? null,
              text: launcher.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300),
            })),
            recent,
          };
        })()`,
      )
      .catch((error) => ({ unreadable: String(error) })),
    delay(15_000).then(() => ({ unreadable: 'the page did not answer in 15 s' })),
  ]);
  console.error(`LAUNCHER SMOKE STATE ${JSON.stringify(state ?? { unreadable: 'no page connection' })}`);
  const screenshotPath = process.env.GODVIEW_LAUNCHER_SMOKE_SCREENSHOT;
  if (page && screenshotPath) {
    const shot = await Promise.race([page.send('Page.captureScreenshot', { format: 'png' }), delay(5000)]).catch(
      () => undefined,
    );
    if (shot?.data) writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
  }
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
