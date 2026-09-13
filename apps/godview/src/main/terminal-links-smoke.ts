import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import type { GhostteaAutomationClient } from '@vibecook/ghosttea-electron/main';
import { buildAgentEnvironment } from '@vibecook/puppeteer-runtime';

interface LinkSmokeOptions {
  client: GhostteaAutomationClient;
  createWindow: () => Promise<BrowserWindow>;
  opened: string[];
  profile: string;
  cwd: string;
}

/** Exercise real PTY output, worker frames, React pointer handling, preload and main IPC. */
export async function runTerminalLinksSmoke(options: LinkSmokeOptions): Promise<void> {
  const { client, opened, profile } = options;
  if (!basename(profile).startsWith('godview-links-smoke-')) {
    throw new Error('link smoke requires its isolated temporary user-data profile');
  }
  const nativeLaunch = process.env.GODVIEW_LINK_SMOKE_NATIVE_LAUNCH;
  if (nativeLaunch) return runNativeFooterLinksSmoke(options, JSON.parse(nativeLaunch));
  const displayedCwd = options.cwd.startsWith(`${homedir()}/`)
    ? `~${options.cwd.slice(homedir().length)}`
    : options.cwd;
  const inputLog = join(profile, 'terminal-input.log');
  writeFileSync(inputLog, '');
  const sourcePath = join(profile, 'link source.ts');
  writeFileSync(sourcePath, '// Terminal file-link fixture.\n');
  const sourceUrl = `${pathToFileURL(sourcePath).href}#L1`;
  const fixture = [
    'import os, sys, tty',
    'tty.setraw(0)',
    `log = ${JSON.stringify(inputLog)}`,
    `source_url = ${JSON.stringify(sourceUrl)}`,
    `footer = ${JSON.stringify(`gpt-6 xhigh · ${displayedCwd} · Ready`)}`,
    'def paint():',
    String.raw`  sys.stdout.write('\x1b[2J\x1b[Hhttps://example.com/plain\r\n界e\u0301 https://example.com/wide\r\n\x1b]8;;https://example.com/actual\x1b\\Open documentation\x1b]8;;\x1b\\\r\n')`,
    String.raw`  sys.stdout.write('\x1b]8;;' + source_url + '\x1b\\link source.ts:1\x1b]8;;\x1b\\\r\nhttps://example.com/' + 'a' * 230 + '\r\n\x1b[?1000h\x1b[?1006h')`,
    String.raw`  sys.stdout.write(f'\x1b[{os.get_terminal_size().lines};1H' + footer)`,
    '  sys.stdout.flush()',
    'paint()',
    'while True:',
    '  data = os.read(0, 4096)',
    '  if not data: break',
    "  if data == b'r': paint()",
    String.raw`  elif data == b'c': sys.stdout.write('\x1b[2J\x1b[Hcleared'); sys.stdout.flush()`,
    '  else:',
    "    with open(log, 'ab') as f: f.write(data)",
  ].join('\n');
  const session = await client.createSession({
    executable: '/usr/bin/python3',
    args: ['-u', '-c', fixture],
    cwd: options.cwd,
    environment: { mode: 'inherit' },
    cols: 100,
    rows: 24,
    persistence: 'terminate-with-app',
    programKind: 'application',
  });
  const window = await options.createWindow();
  const contents = window.webContents;
  const wait = async <T>(label: string, read: () => Promise<T | undefined>): Promise<T> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    writeFileSync(join(profile, 'links-failure.png'), (await contents.capturePage()).toPNG());
    console.error(
      'Link smoke state:',
      await contents.executeJavaScript(`JSON.stringify({
      input: document.querySelector('.terminal-input')?.getBoundingClientRect(),
      hover: document.querySelector('.terminal-input')?.getAttribute('data-terminal-link'),
      events: window.__linkSmokeEvents,
    })`),
    );
    throw new Error(`Link smoke timed out: ${label}`);
  };
  const bounds = await wait('terminal input', async () =>
    contents.executeJavaScript(`(() => {
      const input = document.querySelector('.terminal-input');
      const r = input?.getBoundingClientRect();
      return r?.width > 100 && r.height > 150 ? { left: r.left, top: r.top } : undefined;
    })()`),
  );
  await contents.executeJavaScript(`(() => {
    window.__linkSmokeEvents = [];
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'keydown', 'keyup', 'blur']) {
      window.addEventListener(type, event => {
        window.__linkSmokeEvents.push({type, x: event.clientX, y: event.clientY,
          buttons: event.buttons, meta: event.metaKey, ctrl: event.ctrlKey,
          target: event.target?.className});
        if (window.__linkSmokeEvents.length > 20) window.__linkSmokeEvents.shift();
      }, true);
    }
  })()`);
  window.show();
  window.focus();
  await client.sendText(session.id, 'r');
  // Ghosttea's fixed desktop cell metrics; target cell centers, away from boundaries.
  const point = (column: number, row: number) => ({
    x: Math.round(bounds.left + 2 + (column + 0.5) * 7.83),
    y: Math.round(bounds.top + 2 + (row + 0.5) * 19),
  });
  const modifier = process.platform === 'darwin' ? 'meta' : 'control';
  const move = (column: number, row: number, modified = true) =>
    contents.sendInputEvent({ type: 'mouseMove', ...point(column, row), modifiers: modified ? [modifier] : [] });
  const hover = (): Promise<string | null> =>
    contents.executeJavaScript(`document.querySelector('.terminal-input')?.getAttribute('data-terminal-link') ?? null`);
  const expectHover = async (uri: string | null) =>
    wait(`hover ${uri}`, async () => ((await hover()) === uri ? true : undefined));
  const click = (column: number, row: number, modified = true) => {
    for (const type of ['mouseDown', 'mouseUp'] as const) {
      contents.sendInputEvent({
        type,
        ...point(column, row),
        button: 'left',
        clickCount: 1,
        modifiers: modified ? [modifier] : [],
      });
    }
  };

  move(8, 0);
  await expectHover('https://example.com/plain');
  const underline = await contents.executeJavaScript(`(() => {
    const span = document.querySelector('.terminal-link-overlay > span');
    const r = span?.getBoundingClientRect();
    return r && r.width > 100 && r.height === 1;
  })()`);
  if (!underline) throw new Error('Link hover did not render its underline');
  click(8, 0);
  await wait('URL opener', async () => (opened.length === 1 ? true : undefined));
  if (opened[0] !== 'https://example.com/plain') throw new Error('Wrong plain URL opened');

  move(8, 1);
  await expectHover('https://example.com/wide');
  move(5, 2);
  await expectHover('https://example.com/actual');
  click(5, 2);
  await wait('OSC 8 opener', async () => (opened.length === 2 ? true : undefined));
  if (opened[1] !== 'https://example.com/actual') throw new Error('OSC 8 label was opened instead of its destination');
  move(5, 3);
  await expectHover(sourceUrl);
  click(5, 3);
  await wait('OSC 8 file opener', async () => (opened.length === 3 ? true : undefined));
  if (opened[2] !== sourceUrl) throw new Error('Wrong source file URL opened');
  let document = await client.getConfigDocument();
  const originalConfig = document.contents;
  ({ document } = await client.replaceConfigDocument(document.revision, `${originalConfig}\nlink-url = false\n`));
  move(8, 0);
  await expectHover(null);
  move(5, 2);
  await expectHover('https://example.com/actual');
  move(5, 3);
  await expectHover(sourceUrl);
  await client.replaceConfigDocument(document.revision, `${originalConfig}\nlink-url = true\n`);
  move(3, 5);
  await expectHover(`https://example.com/${'a'.repeat(230)}`);
  const wrappedSpans: number = await contents.executeJavaScript(
    `document.querySelectorAll('.terminal-link-overlay > span').length`,
  );
  if (wrappedSpans < 2) throw new Error('Wrapped URL underline was not split across rows');
  writeFileSync(join(profile, 'links.png'), (await contents.capturePage()).toPNG());

  move(8, 0, false);
  await expectHover(null);
  contents.sendInputEvent({
    type: 'keyDown',
    keyCode: modifier === 'meta' ? 'Meta' : 'Control',
    modifiers: [modifier],
  });
  await expectHover('https://example.com/plain');
  contents.sendInputEvent({ type: 'keyUp', keyCode: modifier === 'meta' ? 'Meta' : 'Control', modifiers: [] });
  await expectHover(null);

  // Moving away and back while pressed must remain a drag, even on a long URL.
  move(8, 0);
  await expectHover('https://example.com/plain');
  contents.sendInputEvent({ type: 'mouseDown', ...point(8, 0), button: 'left', modifiers: [modifier] });
  move(12, 0);
  await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  move(8, 0);
  await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  contents.sendInputEvent({ type: 'mouseUp', ...point(8, 0), button: 'left', modifiers: [modifier] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (opened.length !== 3) throw new Error('Dragging a link opened it');
  if (readFileSync(inputLog).includes(Buffer.from('\x1b[<')))
    throw new Error('Command-click leaked a mouse report to the TUI');

  click(8, 0, false);
  await wait('unmodified TUI mouse report', async () =>
    readFileSync(inputLog).includes(Buffer.from('\x1b[<')) ? true : undefined,
  );
  move(8, 0);
  await expectHover('https://example.com/plain');
  await client.sendText(session.id, 'c');
  await expectHover(null);
  if (opened.length !== 3) throw new Error('An extra URL was opened');
  await client.sendText(session.id, 'r');
  const footerRow = (await client.getSession(session.id)).rows - 1;
  move(16, footerRow);
  await expectHover(pathToFileURL(options.cwd).href);
  writeFileSync(join(profile, 'folder-link.png'), (await contents.capturePage()).toPNG());
  click(16, footerRow);
  await wait('plain folder path opener', async () => (opened.length === 4 ? true : undefined));
  if (opened[3] !== pathToFileURL(options.cwd).href) throw new Error('Wrong folder path opened');
  console.log(
    'LINKS SMOKE OK: plain URL, folder paths, OSC 8 web/file links, Unicode, wrapping, live config, modifiers, drag, TUI capture, clearing',
  );
}

/** Opt-in native TUI fixture supplied by the smoke launcher; no prompt is submitted. */
async function runNativeFooterLinksSmoke(
  options: LinkSmokeOptions,
  launch: { executable: string; args: string[] },
): Promise<void> {
  const { client, cwd, opened, profile } = options;
  const session = await client.createSession({
    executable: launch.executable,
    args: launch.args,
    cwd,
    environment: { mode: 'clean', variables: buildAgentEnvironment() },
    cols: 120,
    rows: 30,
    persistence: 'terminate-with-app',
    programKind: 'application',
  });
  const window = await options.createWindow();
  window.show();
  window.focus();
  const contents = window.webContents;
  const modifier = process.platform === 'darwin' ? 'meta' : 'control';
  const destination = pathToFileURL(cwd).href;
  const observed = new Set<string>();
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const bounds = await contents.executeJavaScript(`(() => {
      const r = document.querySelector('.terminal-input')?.getBoundingClientRect();
      return r && {left:r.left, top:r.top, width:r.width, height:r.height};
    })()`);
    const current = await client.getSession(session.id);
    if (current.exited) throw new Error(`Native TUI exited before its footer could be tested: ${current.exitCode}`);
    if (
      bounds?.width > 100 &&
      bounds.height > 100 &&
      current.cols === Math.floor((bounds.width - 4) / 7.83) &&
      current.rows === Math.floor((bounds.height - 4) / 19)
    ) {
      // The native inline mode leaves blank rows below its footer. Search upward
      // so the status-bar directory wins over the duplicate in its header.
      for (let row = current.rows - 1; row >= Math.floor(current.rows / 2); row--) {
        for (let column = 0; column < current.cols; column += 5) {
          const point = {
            x: Math.round(bounds.left + 2 + (column + 0.5) * 7.83),
            y: Math.round(bounds.top + 2 + (row + 0.5) * 19),
          };
          contents.sendInputEvent({ type: 'mouseMove', ...point, modifiers: [modifier] });
          await new Promise((resolve) => setTimeout(resolve, 15));
          const hovered = await contents.executeJavaScript(
            `document.querySelector('.terminal-input')?.getAttribute('data-terminal-link')`,
          );
          if (hovered && !observed.has(hovered)) {
            observed.add(hovered);
            console.log('Native TUI footer candidate:', { row, column, rows: current.rows, hovered });
          }
          if (hovered !== destination) continue;
          const underline = await contents.executeJavaScript(
            `document.querySelectorAll('.terminal-link-overlay > span').length`,
          );
          if (underline === 0) throw new Error('Native TUI footer path has no underline');
          writeFileSync(join(profile, 'native-folder-link.png'), (await contents.capturePage()).toPNG());
          for (const type of ['mouseDown', 'mouseUp'] as const) {
            contents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1, modifiers: [modifier] });
          }
          const openDeadline = Date.now() + 3000;
          while (Date.now() < openDeadline && opened.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (opened[0] !== destination) throw new Error('Native TUI footer click did not open its working directory');
          console.log(
            'NATIVE LINKS SMOKE OK: Command-hover underline and Command-click on the real Native TUI footer directory',
          );
          return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  writeFileSync(join(profile, 'native-links-failure.png'), (await contents.capturePage()).toPNG());
  throw new Error('Native TUI footer directory did not become a hoverable link');
}
