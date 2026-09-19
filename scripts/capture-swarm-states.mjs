// Every lab stage in both themes, captured by driving headless Chrome over CDP.
// Node's built-in WebSocket speaks the protocol, so this needs no dependency.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [pageFile, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--enable-unsafe-webgpu', '--use-angle=metal',
  '--user-data-dir=' + join(outDir, '..', 'chrome-profile'), '--no-first-run', '--no-default-browser-check',
  '--window-size=1800,1000', '--hide-scrollbars', '--disable-extensions',
  'file://' + pageFile,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
  } catch {}
}
if (!target) { chrome.kill(); throw new Error('Chrome did not expose a page target'); }

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.value;
};

await sleep(4000);
const stages = await evaluate(`[...document.querySelectorAll('[data-stage]')].map((f) => ({
  id: f.dataset.stage,
  title: (f.querySelector('figcaption b')?.textContent || '').replace(/^[0-9]+ · /, ''),
}))`);
const titles = Object.fromEntries(stages.map((s) => [s.id, s.title]));
let written = 0;
for (const theme of ['light', 'dark']) {
  // The lab's theme control is a BUTTON that toggles and then re-resolves the
  // swarm palette. Setting the class alone changes the page's ground while the
  // bodies keep the other theme's fills, which is exactly the wrong picture.
  const state = await evaluate(`(() => {
    const button = document.querySelector('.lab-theme');
    const lab = document.getElementById('lab');
    const wantDark = '${theme}' === 'dark';
    if (lab.classList.contains('theme-dark') !== wantDark) button.click();
    return { dark: lab.classList.contains('theme-dark'), label: button.textContent };
  })()`);
  if (state.dark !== (theme === 'dark')) throw new Error('theme did not switch to ' + theme);
  await sleep(2200);
  for (const stage of stages) {
    const rect = await evaluate(`(() => {
      const fig = document.querySelector('[data-stage="${stage.id}"]');
      const cell = fig.querySelector('.lab-cell') || fig;
      const r = cell.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 2 },
    });
    writeFileSync(join(outDir, `${stage.id}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    written += 1;
  }
}
writeFileSync(join(outDir, 'titles.json'), JSON.stringify(titles, null, 1));
console.log(JSON.stringify({ stages: stages.length, written }));
socket.close();
chrome.kill();
process.exit(0);
