import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkViewWall,
  VIEW_RUNTIME_IMPORTS,
  cssPreludes,
  importBreach,
  readMonitorSkin,
  summarizeViewWall,
  viewStylesheetBreaches,
} from './check-view-wall.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-view-wall.mjs');
const fixtures = [];

after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'puppeteer-view-wall-'));
  fixtures.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function wall(files, options = {}) {
  return checkViewWall({ root: fixture(files), views: 'views', hostStylesheets: ['host'], ...options });
}

function found(report, name) {
  const view = report.views.find((candidate) => candidate.name === name);
  assert.ok(view, `no view ${name}`);
  return view.breaches.map((breach) => `${breach.rule} ${breach.message}`).sort();
}

const CLEAN_VIEW = {
  'views/clean/index.tsx': `
import { defineMonitorView, type MonitorView } from '@vibecook/puppeteer-view-sdk';
import { reactMonitorView } from '@vibecook/puppeteer-view-sdk/react';
import { createMotionLoop, sizeCanvas } from '@vibecook/puppeteer-view-sdk/toolkit';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Row } from './row.js';
import './clean.css';
// window.localStorage and document.body in a comment are not code.
const words = "document.querySelector('x') in a string is not code";
export function mount(root: HTMLElement): number {
  const dpr = window.devicePixelRatio || 1;
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timer = window.setTimeout(() => {}, 10);
  const frame = requestAnimationFrame(() => {});
  root.querySelector('.clean-row')?.addEventListener('click', () => {});
  const probe = root.ownerDocument.createElement('canvas');
  const worker = new Worker(new URL('./clean.worker.js', import.meta.url), { type: 'module' });
  const self = { profiles: [] as number[] };
  return self.profiles.length + dpr + Number(reduced) + timer + frame + (probe ? 1 : 0) + (worker ? 1 : 0) + words.length;
}
export const view = <div className={\`clean-root \${'is-active'}\`}><p>Don't reach the window.</p></div>;
export const used = [defineMonitorView, reactMonitorView, createMotionLoop, sizeCanvas, useEffect, createRoot, Row];
export type Used = MonitorView;
`,
  'views/clean/row.tsx': `export const Row = () => <span className="clean-row" />;\n`,
  'views/clean/clean.worker.ts': `postMessage({ type: 'ready' });\n`,
  'views/clean/clean.css': `.mv-clean .clean-root { color: var(--text-main); background: url(./ground.png); }
.mv-clean > .clean-row:is(.a, .b) { width: var(--mv-clean-width, 1px); }
@keyframes clean-fade { from { opacity: 0; } 50% { opacity: 0.5; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .mv-clean .clean-root { transition: none; } }
`,
  'views/clean/clean.test.tsx': `
import { describe } from 'vitest';
import { fixtureReplica } from '@vibecook/puppeteer-view-sdk/testing';
document.body.append(document.createElement('div'));
describe('clean', () => fixtureReplica);
`,
  'host/host.css': `.host-chrome .is-active { color: red; }\n`,
};

test('a view that keeps to its side passes every rule', () => {
  const report = wall(CLEAN_VIEW);
  assert.deepEqual(found(report, 'clean'), []);
  assert.equal(report.views[0].files, 5);
});

test('MV-W1 reports every import that leaves the SDK or the folder, types and re-exports included', () => {
  const report = wall({
    'views/leaky/index.ts': `
import { agents } from '../../monitor/agents.js';
import type { Core } from '@vibecook/puppeteer-core';
import { mountView } from '@vibecook/puppeteer-view-sdk/host';
import { fixtureReplica } from '@vibecook/puppeteer-view-sdk/testing';
import type { MonitorAgentRow } from '@vibecook/puppeteer-view-sdk/model';
export * from '../shared.js';
export type Other = import('../other/types.js').Other;
export const worker = new URL('../other/x.worker.js', import.meta.url);
export const used: unknown[] = [agents, mountView, fixtureReplica];
export type Used = Core | MonitorAgentRow;
`,
    'views/leaky/leaky.css': `@import '../../styles/base.css';\n.mv-leaky .leaky { color: red; }\n`,
    'views/leaky/leaky.test.ts': `import { vi } from 'vitest';\nimport { y } from '../../monitor/y.js';\nvi.fn(y);\n`,
  });
  assert.deepEqual(
    found(report, 'leaky'),
    [
      "MV-W1 imports ../../monitor/agents.js, outside the view's folder",
      "MV-W1 imports ../../monitor/y.js, outside the view's folder",
      "MV-W1 imports ../other/types.js, outside the view's folder",
      "MV-W1 imports ../shared.js, outside the view's folder",
      'MV-W1 imports @vibecook/puppeteer-core, which is not the SDK',
      'MV-W1 imports @vibecook/puppeteer-view-sdk/host, which only hosts may (L16)',
      "MV-W1 imports @vibecook/puppeteer-view-sdk/model, not a view's subpath (L16)",
      'MV-W1 imports @vibecook/puppeteer-view-sdk/testing outside a test (L16)',
      "MV-W1 refers to ../../styles/base.css, outside the view's folder",
      "MV-W1 refers to ../other/x.worker.js, outside the view's folder",
    ].sort(),
  );
});

test('the import rule lets a test import the testing kit and its runner, and nothing else extra', () => {
  const view = '/repo/views/a';
  assert.equal(importBreach('@vibecook/puppeteer-view-sdk/testing', `${view}/a.test.ts`, view, true), undefined);
  assert.equal(importBreach('vitest', `${view}/a.test.ts`, view, true), undefined);
  assert.equal(importBreach('vitest', `${view}/a.ts`, view, false), 'imports vitest, which is not the SDK');
  assert.equal(importBreach('react-dom/server', `${view}/a.ts`, view, false), undefined);
  assert.equal(importBreach('./deep/b.js', `${view}/a.ts`, view, false), undefined);
  assert.equal(importBreach('../a/b.js', `${view}/a.ts`, view, false), undefined);
  assert.equal(importBreach('../b/c.js', `${view}/a.ts`, view, false), "imports ../b/c.js, outside the view's folder");
});

test("MV-W2 reports every reach past the view's root", () => {
  const report = wall({
    'views/reach/index.ts': `
export function mount(root: HTMLElement): void {
  document.querySelector('.vf-godview');
  window.addEventListener('keydown', () => {});
  window.removeEventListener('keydown', () => {});
  addEventListener('keyup', () => {});
  root.closest('.vf-godview');
  root.getRootNode();
  root.ownerDocument.body;
  globalThis.innerWidth;
  window['name'];
  hand(document);
}
declare function hand(value: unknown): void;
`,
  });
  assert.deepEqual(
    found(report, 'reach'),
    [
      "MV-W2 reads the host's document (document.querySelector)",
      'MV-W2 listens globally (window.addEventListener)',
      'MV-W2 listens globally (addEventListener)',
      'MV-W2 climbs the tree with closest()',
      'MV-W2 reaches the root node with getRootNode()',
      "MV-W2 reaches the root's document (ownerDocument.body) beyond making nodes",
      'MV-W2 reaches globalThis.innerWidth, beyond the allow-list',
      'MV-W2 reaches window[…]',
      "MV-W2 hands the host's document around",
    ].sort(),
  );
});

test('MV-W3 reports network, storage and dynamic import, never a member or a type that shares the name', () => {
  const report = wall({
    'views/net/index.ts': `
export async function load(client: { fetch(): void }): Promise<unknown[]> {
  await fetch('/x');
  new WebSocket('ws://x');
  localStorage.getItem('k');
  sessionStorage.clear();
  indexedDB.open('db');
  window.fetch('/y');
  await import('./lazy.js');
  client.fetch();
  const url = import.meta.url;
  let socket: WebSocket | undefined;
  return [url, socket];
}
`,
  });
  assert.deepEqual(
    found(report, 'net'),
    [
      'MV-W3 reaches out through fetch',
      'MV-W3 reaches out through WebSocket',
      'MV-W3 reaches out through localStorage',
      'MV-W3 reaches out through sessionStorage',
      'MV-W3 reaches out through indexedDB',
      'MV-W3 reaches out through window.fetch',
      'MV-W3 loads code with a dynamic import()',
    ].sort(),
  );
});

test('MV-W5 reports a host stylesheet naming a class the view draws, and nothing the view only names', () => {
  const report = wall({
    'views/styled/index.tsx': `
declare const active: boolean;
export const V = () => (
  <section className="styled-root">
    <i className={active ? 'styled-dot is-on' : 'styled-dot'} />
  </section>
);
`,
    'views/styled/styled.css': `.mv-styled .styled-root { color: red; }\n`,
    'host/godview.css': `/* .styled-root in a comment */
.styled-root { padding: 0; }
@media (min-width: 10px) { .chrome > .styled-dot.is-on { color: blue; } }
.vf-godview { color: black; }
.is-on { color: green; }
`,
  });
  const breaches = report.views[0].breaches;
  assert.deepEqual(
    breaches.map((breach) => [breach.rule, breach.line, breach.message]),
    [
      ['MV-W5', 2, 'the host styles .styled-root (.styled-root)'],
      ['MV-W5', 3, 'the host styles .styled-dot (.chrome > .styled-dot.is-on)'],
    ],
  );
});

test('L18: every rule of a view’s own stylesheet sits under its root class, MV-W2 otherwise', () => {
  const css = `button { font: inherit; }
:root { --x: 1; }
body .mv-scoped .a { color: red; }
.vf-godview .mv-scoped .a { color: red; }
.mv-scopedish .a { color: red; }
.mv-other .a { color: red; }
.mv-scoped .a, .b { color: red; }
.mv-scoped .a:is(.b, .c), .mv-scoped { color: red; }
@media (min-width: 10px) { .loose { color: red; } }
@keyframes spin { from { rotate: 0; } to { rotate: 1turn; } }
`;
  assert.deepEqual(
    viewStylesheetBreaches(css, 'scoped.css', 'scoped', []).map((breach) => [breach.line, breach.message]),
    [
      [1, 'styles outside its root class .mv-scoped (button)'],
      [2, 'styles outside its root class .mv-scoped (:root)'],
      [3, 'styles outside its root class .mv-scoped (body .mv-scoped .a)'],
      [4, 'styles outside its root class .mv-scoped (.vf-godview .mv-scoped .a)'],
      [5, 'styles outside its root class .mv-scoped (.mv-scopedish .a)'],
      [6, 'styles outside its root class .mv-scoped (.mv-other .a)'],
      [7, 'styles outside its root class .mv-scoped (.b)'],
      [9, 'styles outside its root class .mv-scoped (.loose)'],
    ],
  );
});

test('L18: a view’s stylesheet reads only the skin and its own --mv-<view>- properties, MV-W2 otherwise', () => {
  const css = `/* var(--vf-orange) in a comment is not read */
.mv-read .a { color: var(--text-main); }
.mv-read .b { width: var(--mv-read-width, 10px); padding: var(--mv-read-inset); }
.mv-read .c { color: var(--vf-orange, #ff9f0a); }
.mv-read .d { left: var(--vf-monitor-chrome-right, 0px); top: var( --mv-other-top ); }
.mv-read .e { color: var(--panel-bg); background: var(--mv-reading-x); }
`;
  assert.deepEqual(
    viewStylesheetBreaches(css, 'read.css', 'read', ['--text-main']).map((breach) => [breach.line, breach.message]),
    [
      [4, 'reads --vf-orange, neither the skin (MONITOR_SKIN) nor its own --mv-read-*'],
      [5, 'reads --vf-monitor-chrome-right, neither the skin (MONITOR_SKIN) nor its own --mv-read-*'],
      [5, 'reads --mv-other-top, neither the skin (MONITOR_SKIN) nor its own --mv-read-*'],
      [6, 'reads --panel-bg, neither the skin (MONITOR_SKIN) nor its own --mv-read-*'],
      [6, 'reads --mv-reading-x, neither the skin (MONITOR_SKIN) nor its own --mv-read-*'],
    ],
  );
});

test('L18 runs on every view folder’s CSS, and a host naming a view’s root class names the view (W5)', () => {
  const report = wall(
    {
      'views/plain/index.tsx': `import './plain.css';\nexport const V = () => <p className="plain-text" />;\n`,
      'views/plain/plain.css': `.plain-text { color: var(--vf-orange); }\n`,
      'host/host.css': `.mv-plain { padding: 0; }\n`,
    },
    { skin: ['--text-main'] },
  );
  assert.deepEqual(found(report, 'plain'), [
    'MV-W2 reads --vf-orange, neither the skin (MONITOR_SKIN) nor its own --mv-plain-*',
    'MV-W2 styles outside its root class .mv-plain (.plain-text)',
    'MV-W5 the host styles .mv-plain (.mv-plain)',
  ]);
});

test('the skin is the SDK’s own list, read from its source', () => {
  assert.deepEqual(readMonitorSkin(), [
    '--text-main',
    '--text-muted',
    '--text-faint',
    '--panel-bg',
    '--panel-border',
    '--control-hover-bg',
    '--control-hover-border',
    '--idle-bg',
    // M59.4 (with M57): the monitor's ground and the named easings
    '--monitor-bg',
    '--vf-ease-pop',
    '--vf-ease-lift',
    '--vf-ease-island',
  ]);
  assert.deepEqual(readMonitorSkin(fixture({})), []);
});

test('a lab builds its own page, so the wall reads it only when asked', () => {
  const files = { 'views/labbed/lab/main.ts': `document.getElementById('lab');\n`, 'views/labbed/index.ts': '' };
  assert.deepEqual(found(wall(files), 'labbed'), []);
  assert.deepEqual(found(wall(files, { includeLabs: true }), 'labbed'), [
    "MV-W2 reads the host's document (document.getElementById)",
  ]);
});

test('report mode exits 0 whatever it finds; --fail exits 1 only for a listed view that breaches', () => {
  const root = fixture({
    ...CLEAN_VIEW,
    'views/leaky/index.ts': `import '../../outside.js';\n`,
  });
  const run = (...extra) =>
    spawnSync(process.execPath, [script, '--root', root, '--views', 'views', '--host-css', 'host', ...extra], {
      encoding: 'utf8',
    });

  const report = run();
  assert.equal(report.status, 0, report.stderr);
  const summary = JSON.parse(report.stdout.split('view-wall summary: ')[1]);
  assert.equal(summary.mode, 'report');
  assert.deepEqual(summary.views.leaky, { files: 1, 'MV-W1': 1, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 0, total: 1 });
  assert.equal(summary.views.clean.total, 0);

  assert.equal(run('--fail', 'clean').status, 0);
  const failed = run('--fail', 'clean', 'leaky');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FAIL leaky \(1\)/);
  const unknown = run('--fail', 'nosuch');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no view named nosuch/);
});

test('the summary counts each rule per view and in total', () => {
  const report = {
    root: '/r',
    hostStylesheets: [],
    views: [
      { name: 'a', files: 2, breaches: [{ rule: 'MV-W1' }, { rule: 'MV-W5' }] },
      { name: 'b', files: 1, breaches: [{ rule: 'MV-W1' }] },
    ],
  };
  assert.deepEqual(summarizeViewWall(report, ['a']), {
    mode: 'fail',
    views: {
      a: { files: 2, 'MV-W1': 1, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 1, total: 2 },
      b: { files: 1, 'MV-W1': 1, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 0, total: 1 },
    },
    total: { files: 3, total: 3, 'MV-W1': 2, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 1 },
    failing: ['a'],
  });
});

test('stylesheet preludes skip comments and at-rules and keep their lines', () => {
  assert.deepEqual(cssPreludes('/* a { } */\n.a,\n.b { x: 1; }\n@media (x) {\n  .c { }\n}\n'), [
    { selector: '.a, .b', line: 3 },
    { selector: '.c', line: 5 },
  ]);
});

test("it reads the repository's own views", () => {
  const report = checkViewWall();
  const summary = summarizeViewWall(report);
  assert.equal(summary.mode, 'report');
  assert.equal(Object.keys(summary.views).length, report.views.length);
});

test('a dependency a view bundles into itself is allowed only for the view that names it (MV-5)', () => {
  const files = {
    'views/swarm/world.ts': "import Matter from 'matter-js';\nexport const engine = Matter;\n",
    'views/other/world.ts': "import Matter from 'matter-js';\nexport const engine = Matter;\n",
  };
  const report = wall(files);
  assert.deepEqual(VIEW_RUNTIME_IMPORTS.swarm, ['matter-js']);
  assert.deepEqual(found(report, 'swarm'), []);
  assert.deepEqual(found(report, 'other'), ['MV-W1 imports matter-js, which is not the SDK']);
  // W3 is unmoved: the swarm may bundle matter, not reach out
  assert.deepEqual(found(wall({ 'views/swarm/reach.ts': "export const data = fetch('https://x');\n" }), 'swarm'), [
    'MV-W3 reaches out through fetch',
  ]);
});
