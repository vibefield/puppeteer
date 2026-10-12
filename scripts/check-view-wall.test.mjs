import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkViewWall,
  checkViews,
  VIEW_RUNTIME_IMPORTS,
  cssPreludes,
  importBreach,
  readMonitorSkin,
  readRegisteredViews,
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

/** The rules on the fixture's view folders, each `views/<name>/` read as the view `<name>` (no registry). */
function wall(files, options = {}) {
  const root = fixture(files);
  const names = [...new Set(Object.keys(files).flatMap((path) => /^views\/([^/]+)\//.exec(path)?.[1] ?? []))].sort();
  return checkViews({
    root,
    views: names.map((name) => ({ name, directory: join('views', name) })),
    hostStylesheets: ['host'],
    ...options,
  });
}

/** A registry the hosts would mount: `monitorViewEntry(<view>)` per view module, as packages/views writes it. */
function registry(entries) {
  const imports = entries.map(({ binding, from }) => `import { ${binding} } from '${from}';`).join('\n');
  const list = entries.map(({ binding }) => `  monitorViewEntry(${binding}),`).join('\n');
  return `${imports}\nimport { monitorViewEntry } from './entry.js';\nexport const MONITOR_VIEWS = [\n${list}\n];\n`;
}

/** A view module with a manifest, the way the views write one. */
function viewModule(id, extra = '') {
  const name = `${id.replace(/-/g, '_').toUpperCase()}_MANIFEST`;
  return `import { reactMonitorView } from '@vibefield/puppeteer-view-sdk/react';
import './${id}.css';
export const ${name} = { sdk: 1, id: '${id}', label: '${id.toUpperCase()}', mark: { viewBox: '0 0 24 24', paths: [] }, parameters: [] };
export const ${id.replace(/-/g, '_')}MonitorView = reactMonitorView(${name}, () => null, { rootClass: 'mv-${id}' });
${extra}`;
}

function found(report, name) {
  const view = report.views.find((candidate) => candidate.name === name);
  assert.ok(view, `no view ${name}`);
  return view.breaches.map((breach) => `${breach.rule} ${breach.message}`).sort();
}

const CLEAN_VIEW = {
  'views/clean/index.tsx': `
import { defineMonitorView, type MonitorView } from '@vibefield/puppeteer-view-sdk';
import { reactMonitorView } from '@vibefield/puppeteer-view-sdk/react';
import { createMotionLoop, sizeCanvas } from '@vibefield/puppeteer-view-sdk/toolkit';
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
import { fixtureReplica } from '@vibefield/puppeteer-view-sdk/testing';
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
import type { Core } from '@vibefield/puppeteer-core';
import { mountView } from '@vibefield/puppeteer-view-sdk/host';
import { fixtureReplica } from '@vibefield/puppeteer-view-sdk/testing';
import type { MonitorAgentRow } from '@vibefield/puppeteer-view-sdk/model';
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
      'MV-W1 imports @vibefield/puppeteer-core, which is not the SDK',
      'MV-W1 imports @vibefield/puppeteer-view-sdk/host, which only hosts may (L16)',
      "MV-W1 imports @vibefield/puppeteer-view-sdk/model, not a view's subpath (L16)",
      'MV-W1 imports @vibefield/puppeteer-view-sdk/testing outside a test (L16)',
      "MV-W1 refers to ../../styles/base.css, outside the view's folder",
      "MV-W1 refers to ../other/x.worker.js, outside the view's folder",
    ].sort(),
  );
});

test('the import rule lets a test import the testing kit and its runner, and nothing else extra', () => {
  const view = '/repo/views/a';
  assert.equal(importBreach('@vibefield/puppeteer-view-sdk/testing', `${view}/a.test.ts`, view, true), undefined);
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
    // M178: the sans the spend view sets its words in
    '--vf-font-sans',
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

const run = (root, ...extra) =>
  spawnSync(
    process.execPath,
    [script, '--root', root, '--registry', 'registry.ts', '--views', 'views', '--host-css', 'host', ...extra],
    { encoding: 'utf8' },
  );
const summaryOf = (result) => JSON.parse(result.stdout.split('view-wall summary: ')[1]);
/** The clean view, registered: its folder holds a view module with a manifest beside CLEAN_VIEW's files. */
const REGISTERED_CLEAN = {
  ...CLEAN_VIEW,
  'views/clean/view.ts': viewModule('clean'),
  'registry.ts': registry([{ binding: 'cleanMonitorView', from: './views/clean/view.js' }]),
};

test('every registered view fails on a breach, a new one included, with no list beside the registry; --report exits 0', () => {
  // A wall of clean registered views passes.
  const clean = run(fixture(REGISTERED_CLEAN));
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(summaryOf(clean).mode, 'fail');
  assert.deepEqual(summaryOf(clean).failing, []);
  assert.deepEqual(summaryOf(clean).registration, []);

  // A view newly registered enters failing: the registry is the only list.
  const root = fixture({
    ...REGISTERED_CLEAN,
    'views/leaky/view.ts': viewModule('leaky', "import '../../outside.js';\n"),
    'registry.ts': registry([
      { binding: 'cleanMonitorView', from: './views/clean/view.js' },
      { binding: 'leakyMonitorView', from: './views/leaky/view.js' },
    ]),
  });
  const failed = run(root);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FAIL leaky \(1\)/);
  assert.doesNotMatch(failed.stderr, /clean/);
  const summary = summaryOf(failed);
  assert.equal(summary.mode, 'fail');
  assert.deepEqual(summary.failing, ['leaky']);
  assert.deepEqual(summary.views.leaky, { files: 1, 'MV-W1': 1, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 0, total: 1 });
  assert.equal(summary.views.clean.total, 0);

  // The opt-in: the same table, exit 0.
  const report = run(root, '--report');
  assert.equal(report.status, 0, report.stderr);
  assert.equal(summaryOf(report).mode, 'report');
  assert.deepEqual(summaryOf(report).views.leaky, summary.views.leaky);

  // The old per-view list is gone, not quietly ignored.
  const old = run(root, '--fail', 'clean');
  assert.equal(old.status, 1);
  assert.match(old.stderr, /unknown argument --fail/);
});

test('registration, not folders: a registered view outside views/ is read, and an unregistered folder is never counted (MV-8b)', () => {
  // A view the hosts mount from another folder is read there, under its manifest's id.
  const far = run(
    fixture({
      ...REGISTERED_CLEAN,
      'elsewhere/far/view.ts': viewModule('far-view'),
      'elsewhere/far/reach.ts': "export const data = fetch('https://x');\n",
      'registry.ts': registry([
        { binding: 'cleanMonitorView', from: './views/clean/view.js' },
        { binding: 'far_viewMonitorView', from: './elsewhere/far/view.js' },
      ]),
    }),
  );
  assert.equal(far.status, 1);
  assert.deepEqual(summaryOf(far).failing, ['far-view']);
  assert.deepEqual(summaryOf(far).views['far-view'], {
    files: 2,
    'MV-W1': 0,
    'MV-W2': 0,
    'MV-W3': 1,
    'MV-W5': 0,
    total: 1,
  });

  // A folder under views/ that no entry registers fails as such, and is not a view that holds.
  const orphan = run(fixture({ ...REGISTERED_CLEAN, 'views/orphan/index.ts': 'export const nothing = 0;\n' }));
  assert.equal(orphan.status, 1);
  assert.match(orphan.stderr, /FAIL registration \(1\)/);
  assert.ok(!('orphan' in summaryOf(orphan).views));
  assert.deepEqual(summaryOf(orphan).registration, [
    'views/orphan: a view folder no host registers (registry.ts MONITOR_VIEWS)',
  ]);

  // What the wall cannot follow is a failure too, never a view left out in silence.
  const unreadable = fixture({
    ...REGISTERED_CLEAN,
    'views/odd/view.ts': 'export const oddMonitorView = makeView();\ndeclare function makeView(): unknown;\n',
    'registry.ts': registry([
      { binding: 'cleanMonitorView', from: './views/clean/view.js' },
      { binding: 'oddMonitorView', from: './views/odd/view.js' },
      { binding: 'ghostMonitorView', from: './views/ghost/view.js' },
    ]),
  });
  const odd = run(unreadable);
  assert.equal(odd.status, 1);
  assert.deepEqual(summaryOf(odd).registration, [
    "oddMonitorView: the wall cannot read its manifest's id (views/odd/view.ts)",
    'ghostMonitorView: not imported from a view module the wall can find (registry.ts)',
  ]);
  const { views } = readRegisteredViews(join(unreadable, 'registry.ts'), { root: unreadable });
  assert.deepEqual(
    views.map((view) => [view.binding, view.name]),
    [
      ['cleanMonitorView', 'clean'],
      ['oddMonitorView', 'odd'],
    ],
  );
});

test('the summary counts each rule per view and in total, and names the views that fail', () => {
  const report = {
    root: '/r',
    hostStylesheets: [],
    views: [
      { name: 'a', files: 2, breaches: [{ rule: 'MV-W1' }, { rule: 'MV-W5' }] },
      { name: 'b', files: 1, breaches: [{ rule: 'MV-W1' }] },
      { name: 'c', files: 4, breaches: [] },
    ],
  };
  const views = {
    a: { files: 2, 'MV-W1': 1, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 1, total: 2 },
    b: { files: 1, 'MV-W1': 1, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 0, total: 1 },
    c: { files: 4, 'MV-W1': 0, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 0, total: 0 },
  };
  const total = { files: 7, total: 3, 'MV-W1': 2, 'MV-W2': 0, 'MV-W3': 0, 'MV-W5': 1 };
  assert.deepEqual(summarizeViewWall(report), { mode: 'fail', views, total, failing: ['a', 'b'], registration: [] });
  assert.deepEqual(summarizeViewWall(report, 'report'), {
    mode: 'report',
    views,
    total,
    failing: [],
    registration: [],
  });
  const unregistered = { ...report, registration: ['views/d: a view folder no host registers'] };
  assert.deepEqual(summarizeViewWall(unregistered).registration, ['views/d: a view folder no host registers']);
});

test('stylesheet preludes skip comments and at-rules and keep their lines', () => {
  assert.deepEqual(cssPreludes('/* a { } */\n.a,\n.b { x: 1; }\n@media (x) {\n  .c { }\n}\n'), [
    { selector: '.a, .b', line: 3 },
    { selector: '.c', line: 5 },
  ]);
});

test("it reads the repository's registered views, and every one of them holds the wall (MV-8, MV-8b)", () => {
  const report = checkViewWall();
  const summary = summarizeViewWall(report);
  assert.equal(summary.mode, 'fail');
  // The views the hosts mount, by manifest id, each in its own folder: the four ported ones among them, and no list
  // here to keep beside the registry (a newly registered view joins without an edit to this test).
  for (const name of ['swarm', 'list', 'rain', 'timeline']) {
    const view = report.views.find((candidate) => candidate.name === name);
    assert.ok(view, name);
    assert.equal(view.directory, join(report.root, 'packages', 'views', 'src', 'views', name));
  }
  assert.deepEqual(summary.failing, []);
  assert.deepEqual(summary.registration, []);
  assert.equal(summary.total.total, 0);
});

test('a dependency a view bundles into itself is allowed only for the view that names it (MV-5)', () => {
  const files = {
    'views/swarm/world.ts': "import Matter from 'matter-js';\nexport const engine = Matter;\n",
    'views/other/world.ts': "import Matter from 'matter-js';\nexport const engine = Matter;\n",
  };
  const report = wall(files);
  assert.deepEqual(VIEW_RUNTIME_IMPORTS.swarm, ['matter-js', 'navigator.gpu']);
  assert.deepEqual(found(report, 'swarm'), []);
  assert.deepEqual(found(report, 'other'), ['MV-W1 imports matter-js, which is not the SDK']);
  // W3 is unmoved: the swarm may bundle matter, not reach out
  assert.deepEqual(found(wall({ 'views/swarm/reach.ts': "export const data = fetch('https://x');\n" }), 'swarm'), [
    'MV-W3 reaches out through fetch',
  ]);
});

// MV-8b: THE LOOPHOLES M176 ITEM 4 FOUND, each closed. Every probe below is a breach the wall read as clean at
// c43268e; the last test drops each one into a registered view and watches the wall turn red in fail mode.

test('MV-W2: a global object handed around is an alias that reaches anything, however it is wrapped', () => {
  const report = wall({
    'views/alias/index.ts': `
export function mount(): unknown[] {
  const g = globalThis;
  const w = window as unknown as { document: Document };
  const s = self;
  const { localStorage: kept } = window;
  const host = typeof globalThis !== 'undefined' ? globalThis : window;
  (globalThis as unknown as { document: Document }).document.body;
  (window as unknown as { open(url: string): void }).open('https://x');
  return [g, w, s, kept, host];
}
`,
  });
  assert.deepEqual(
    found(report, 'alias'),
    [
      "MV-W2 hands the host's globalThis around",
      "MV-W2 hands the host's window around",
      "MV-W2 hands the host's self around",
      "MV-W2 hands the host's window around",
      "MV-W2 hands the host's globalThis around",
      "MV-W2 hands the host's window around",
      'MV-W2 reaches globalThis.document, beyond the allow-list',
      'MV-W3 reaches out through window.open',
    ].sort(),
  );
});

test('MV-W2/W3: bare location, navigator, caches, open and importScripts reach the host; typeof only asks', () => {
  const report = wall({
    'views/bare/index.ts': `
export function mount(): unknown[] {
  const here = location.href;
  const agent = navigator.userAgent;
  const browser = navigator;
  navigator.sendBeacon('/x', '');
  void caches.open('v');
  open('https://x');
  importScripts('https://x/lib.js');
  const known = typeof navigator !== 'undefined' && typeof location !== 'undefined';
  return [here, agent, browser, known];
}
`,
    // Names a view declares itself are its own, not the host's.
    'views/bare/local.ts': `export function pick(open: boolean, location: string): string | false {
  const navigator = { open };
  return navigator.open && location;
}
`,
  });
  assert.deepEqual(
    found(report, 'bare'),
    [
      'MV-W2 reaches location.href, beyond the allow-list',
      'MV-W2 reaches navigator.userAgent, beyond the allow-list',
      'MV-W2 reaches navigator, beyond the allow-list',
      'MV-W3 reaches out through navigator.sendBeacon',
      'MV-W3 reaches out through caches',
      'MV-W3 reaches out through open',
      'MV-W3 loads code with importScripts()',
    ].sort(),
  );
});

test("the swarm's navigator.gpu is named in VIEW_RUNTIME_IMPORTS: that member, for that view, and nothing more", () => {
  const report = wall({
    'views/swarm/gpu.ts': `export const gpu = typeof navigator === 'undefined' ? undefined : navigator.gpu;
export const agent = navigator.userAgent;
`,
    'views/other/gpu.ts': 'export const gpu = navigator.gpu;\n',
  });
  assert.deepEqual(found(report, 'swarm'), ['MV-W2 reaches navigator.userAgent, beyond the allow-list']);
  assert.deepEqual(found(report, 'other'), ['MV-W2 reaches navigator.gpu, beyond the allow-list']);
});

test('MV-W2: climbing above the root by parentElement, parentNode or offsetParent', () => {
  const report = wall({
    'views/climb/index.ts': `
export function mount(root: HTMLElement): unknown[] {
  return [root.parentElement, root.parentNode, (root as HTMLElement).offsetParent, root['parentNode']];
}
`,
  });
  assert.deepEqual(
    found(report, 'climb'),
    [
      'MV-W2 climbs above its root (parentElement)',
      'MV-W2 climbs above its root (parentNode)',
      'MV-W2 climbs above its root (offsetParent)',
      'MV-W2 climbs above its root (parentNode)',
    ].sort(),
  );
});

test('L18: a sibling combinator on the root class leaves it (MV-W2); one inside the root stays', () => {
  const css = `.mv-sib ~ .host { color: red; }
.mv-sib + .host { color: red; }
.mv-sib.is-on+.host { color: red; }
.mv-sib:hover ~ a { color: red; }
.mv-sib .a ~ .b { color: red; }
.mv-sib > .a + .b { color: red; }
.mv-sib .a:nth-child(2n+1) { color: red; }
.mv-sib[data-x="a~b"] .c { color: red; }
`;
  assert.deepEqual(
    viewStylesheetBreaches(css, 'sib.css', 'sib', []).map((breach) => [breach.rule, breach.line, breach.message]),
    [
      ['MV-W2', 1, 'leaves its root class .mv-sib for its siblings (.mv-sib ~ .host)'],
      ['MV-W2', 2, 'leaves its root class .mv-sib for its siblings (.mv-sib + .host)'],
      ['MV-W2', 3, 'leaves its root class .mv-sib for its siblings (.mv-sib.is-on+.host)'],
      ['MV-W2', 4, 'leaves its root class .mv-sib for its siblings (.mv-sib:hover ~ a)'],
    ],
  );
});

test('MV-W3: an absolute url in a view’s stylesheet, a scheme or a root-absolute path, reaches out', () => {
  const report = wall({
    'views/urls/urls.css': `@import url('https://fonts.example/a.css');
.mv-urls .a { background: url(https://cdn.example/x.png); }
.mv-urls .b { background: url('/assets/x.png'); }
.mv-urls .c { background: url("data:image/png;base64,AAAA"); }
.mv-urls .d { background: url(//cdn.example/y.png); }
.mv-urls .e { background: url(./ground.png); }
.mv-urls .f { background: url(ground.png); }
`,
  });
  assert.deepEqual(
    found(report, 'urls'),
    [
      'MV-W3 reaches out through https://fonts.example/a.css, an absolute url',
      'MV-W3 reaches out through https://cdn.example/x.png, an absolute url',
      'MV-W3 reaches out through /assets/x.png, an absolute url',
      'MV-W3 reaches out through data:image/png;base64,AAAA, an absolute url',
      'MV-W3 reaches out through //cdn.example/y.png, an absolute url',
    ].sort(),
  );
});

test('MV-W1: shipping code never imports a lab or fixtures; a lab, a fixture and a test may', () => {
  const report = wall(
    {
      'views/labbed/index.ts': `import { stages } from './lab/fixtures.js';
import { world } from './world-fixtures.js';
export const all = [stages, world];
export const page = new URL('./lab/page.js', import.meta.url);
`,
      'views/labbed/world-fixtures.ts': "import { shared } from './shared.js';\nexport const world = shared;\n",
      'views/labbed/shared.ts': 'export const shared = 1;\n',
      'views/labbed/lab/fixtures.ts': "import { world } from '../world-fixtures.js';\nexport const stages = world;\n",
      'views/labbed/lab/page.ts': "import { stages } from './fixtures.js';\nexport const shown = stages;\n",
      'views/labbed/labbed.test.ts': "import { stages } from './lab/fixtures.js';\nexport const used = stages;\n",
    },
    { includeLabs: true },
  );
  assert.deepEqual(
    found(report, 'labbed'),
    [
      'MV-W1 imports ./lab/fixtures.js, a lab or fixtures (shipping code never imports them)',
      'MV-W1 imports ./world-fixtures.js, a lab or fixtures (shipping code never imports them)',
      'MV-W1 refers to ./lab/page.js, a lab or fixtures',
    ].sort(),
  );
});

test('each loophole, dropped into a registered view, turns the wall red in fail mode (the mutation probes)', () => {
  const probes = {
    'globalThis aliased': 'const g = globalThis;\nexport const body = (g as unknown as Window).document.body;\n',
    'window aliased': 'const w = window;\nexport const width = w.innerWidth;\n',
    'self aliased': 'const s = self;\nexport const name = s.name;\n',
    'bare location': 'export const here = location.href;\n',
    'bare navigator': 'export const agent = navigator.userAgent;\n',
    'bare caches': "export const cache = caches.open('v');\n",
    'bare open': "export const opened = open('https://x');\n",
    'bare importScripts': "importScripts('https://x/lib.js');\n",
    parentElement: 'export const up = (root: HTMLElement) => root.parentElement;\n',
    parentNode: 'export const up = (root: HTMLElement) => root.parentNode;\n',
    offsetParent: 'export const up = (root: HTMLElement) => root.offsetParent;\n',
    'lab import': "import { stage } from './lab/stage.js';\nexport const shown = stage;\n",
    'fixtures import': "import { rows } from './rows-fixtures.js';\nexport const shown = rows;\n",
  };
  const stylesheetProbes = {
    'sibling ~': '.mv-clean ~ .host { color: red; }\n',
    'sibling +': '.mv-clean + .host { color: red; }\n',
    'url with a scheme': '.mv-clean .x { background: url(https://cdn.example/x.png); }\n',
    'root-absolute url': '.mv-clean .x { background: url(/assets/x.png); }\n',
  };
  const helpers = { 'views/clean/lab/stage.ts': 'export const stage = 1;\n', 'views/clean/rows-fixtures.ts': '' };
  for (const [probe, text] of Object.entries(probes)) {
    const result = run(fixture({ ...REGISTERED_CLEAN, ...helpers, 'views/clean/probe.ts': text }));
    assert.equal(result.status, 1, `${probe}: ${result.stdout}`);
    assert.match(result.stderr, /FAIL clean \(\d+\)/, probe);
  }
  for (const [probe, text] of Object.entries(stylesheetProbes)) {
    const result = run(fixture({ ...REGISTERED_CLEAN, 'views/clean/probe.css': text }));
    assert.equal(result.status, 1, `${probe}: ${result.stdout}`);
    assert.match(result.stderr, /FAIL clean \(1\)/, probe);
  }
  // The same registered view without a probe holds.
  assert.equal(run(fixture({ ...REGISTERED_CLEAN, ...helpers })).status, 0);
});
