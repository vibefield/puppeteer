import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { GhostteaAutomationClient } from '@vibecook/ghosttea-electron/main';

/** Exercise real PTY output, worker frames, React pointer handling, preload and main IPC. */
export async function runTerminalLinksSmoke(options: {
  client: GhostteaAutomationClient;
  createWindow: () => Promise<BrowserWindow>;
  opened: string[];
  profile: string;
}): Promise<void> {
  const { client, opened, profile } = options;
  if (!basename(profile).startsWith('godview-links-smoke-')) {
    throw new Error('link smoke requires its isolated temporary user-data profile');
  }
  const inputLog = join(profile, 'terminal-input.log');
  writeFileSync(inputLog, '');
  const fixture = [
    'import os, sys, tty',
    'tty.setraw(0)',
    `log = ${JSON.stringify(inputLog)}`,
    'def paint():',
    String.raw`  sys.stdout.write('\x1b[2J\x1b[Hhttps://example.com/plain\r\n界e\u0301 https://example.com/wide\r\n\x1b]8;;https://example.com/actual\x1b\\Open documentation\x1b]8;;\x1b\\\r\nhttps://example.com/' + 'a' * 230 + '\r\n\x1b[?1000h\x1b[?1006h')`,
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
    throw new Error(`Link smoke timed out: ${label}`);
  };
  const bounds = await wait('terminal input', async () =>
    contents.executeJavaScript(`(() => {
      const input = document.querySelector('.terminal-input');
      const r = input?.getBoundingClientRect();
      return r?.width > 100 && r.height > 150 ? { left: r.left, top: r.top } : undefined;
    })()`),
  );
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
  let document = await client.getConfigDocument();
  const originalConfig = document.contents;
  ({ document } = await client.replaceConfigDocument(document.revision, `${originalConfig}\nlink-url = false\n`));
  move(8, 0);
  await expectHover(null);
  move(5, 2);
  await expectHover('https://example.com/actual');
  await client.replaceConfigDocument(document.revision, `${originalConfig}\nlink-url = true\n`);
  move(3, 4);
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
  if (opened.length !== 2) throw new Error('Dragging a link opened it');
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
  if (opened.length !== 2) throw new Error('An extra URL was opened');
  console.log(
    'LINKS SMOKE OK: plain URL, OSC 8, Unicode, wrapping, live config, modifiers, drag, TUI capture, clearing',
  );
}
