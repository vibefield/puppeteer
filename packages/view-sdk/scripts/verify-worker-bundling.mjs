#!/usr/bin/env node

// DOES A VIEW'S WORKER SURVIVE EVERY HOST'S BUNDLER? (MV-D7, design §5's worker row)
//
// Builds `test/worker-bundling/fixture` — a stand-in view that names its worker
// as `new Worker(new URL('./echo.worker.js', import.meta.url), { type: 'module' })`
// beside an `echo.worker.ts` entry — the ways the hosts bundle views, then runs
// each build in a hidden Electron window as its host loads it, and reports where
// the fixture's echo ran:
//
//   vite-build         Vite production build (VibeField's renderer), served from a
//                      standard secure scheme under VibeField's production CSP
//   vite-dev           the Vite dev server (VibeField's `pnpm dev`)
//   esbuild-esm        apps/godview/build.mjs's renderer options, loadFile, Godview's CSP
//   esbuild-esm+entry  the same, with the host also building the worker entry beside its chunks
//   esbuild-iife       the labs' single-file IIFE page
//   esbuild-iife+blob  the same, with the page handing the view a blob URL it built
//
// Every row has an expected outcome; the exit code is 0 only when all match.
// Not part of `pnpm test`: it starts Electron. esbuild and Electron are the ones
// apps/godview builds and runs with; Vite is the one this workspace resolves
// (vitest's), or any other via `--vite <path to a vite package directory>` —
// pass VibeField's to verify its major.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(here, '..');
const repo = resolve(sdk, '../..');
const fixture = join(sdk, 'test/worker-bundling/fixture');

const godview = createRequire(join(repo, 'apps/godview/package.json'));
const { build: esbuild } = godview('esbuild');
const electron = godview('electron');

const viteFlag = process.argv.indexOf('--vite');
const viteDir =
  viteFlag > 0
    ? resolve(process.argv[viteFlag + 1])
    : dirname(
        createRequire(createRequire(join(sdk, 'package.json')).resolve('vitest/package.json')).resolve(
          'vite/package.json',
        ),
      );
const viteManifest = JSON.parse(await readFile(join(viteDir, 'package.json'), 'utf8'));
const viteEntry = viteManifest.exports['.'];
const vite = await import(
  pathToFileURL(
    join(viteDir, typeof viteEntry === 'string' ? viteEntry : (viteEntry.import.default ?? viteEntry.import)),
  ).href
);
const viteVersion = viteManifest.version;
const esbuildVersion = JSON.parse(await readFile(godview.resolve('esbuild/package.json'), 'utf8')).version;
const electronVersion = JSON.parse(await readFile(godview.resolve('electron/package.json'), 'utf8')).version;

/** VibeField's production renderer policy, the parts a worker meets (security-policy.ts). */
const VIBEFIELD_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'";
/** Godview's renderer policy, verbatim from apps/godview/src/renderer/index.html. */
const GODVIEW_CSP = await readFile(join(repo, 'apps/godview/src/renderer/index.html'), 'utf8').then((html) => {
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!match) throw new Error("apps/godview's index.html no longer carries a CSP meta tag");
  return match[1];
});

const EXPECTED = {
  'vite-build': 'worker',
  'vite-dev': 'worker',
  'esbuild-esm': 'inline',
  'esbuild-esm+entry': 'worker',
  'esbuild-iife': 'inline',
  'esbuild-iife+blob': 'worker',
};

/** A port nothing listens on, so the dev server never lands on a running `pnpm dev`. */
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const work = await mkdtemp(join(tmpdir(), 'view-sdk-worker-bundling-'));
const pages = [];
let server;
try {
  // Vite, as VibeField's renderer build runs it: relative base, the default worker format.
  const viteOut = join(work, 'vite-build');
  await vite.build({
    root: fixture,
    configFile: false,
    logLevel: 'silent',
    base: './',
    cacheDir: join(work, 'vite-cache'),
    build: { outDir: viteOut, emptyOutDir: true, target: 'es2022', minify: false },
  });
  pages.push({ id: 'vite-build', scheme: true });

  server = await vite.createServer({
    root: fixture,
    configFile: false,
    logLevel: 'silent',
    cacheDir: join(work, 'vite-dev-cache'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true, hmr: false },
  });
  await server.listen();
  pages.push({ id: 'vite-dev', url: server.resolvedUrls.local[0] });

  // esbuild ESM, with apps/godview/build.mjs's renderer options.
  const godviewRenderer = {
    bundle: true,
    sourcemap: true,
    logLevel: 'silent',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    splitting: true,
  };
  const godviewHtml = `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="${GODVIEW_CSP}" />\n<title>esbuild esm</title></head>\n<body><script type="module" src="./renderer.js"></script></body></html>\n`;
  for (const [id, withEntry] of [
    ['esbuild-esm', false],
    ['esbuild-esm+entry', true],
  ]) {
    const outdir = join(work, id);
    await esbuild({ ...godviewRenderer, entryPoints: [join(fixture, 'main.ts')], outdir, entryNames: 'renderer' });
    if (withEntry) {
      await esbuild({
        ...godviewRenderer,
        splitting: false,
        entryPoints: { 'echo.worker': join(fixture, 'echo.worker.ts') },
        outdir,
      });
    }
    await writeFile(join(outdir, 'index.html'), godviewHtml);
    pages.push({ id, file: join(outdir, 'index.html') });
  }

  // esbuild IIFE, as apps/godview/swarm-lab.mjs inlines a lab into one page.
  const iife = async (entry) =>
    (
      await esbuild({
        entryPoints: [entry],
        bundle: true,
        write: false,
        logLevel: 'silent',
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
      })
    ).outputFiles[0].text.replaceAll('</script', '<\\/script');
  const page = await iife(join(fixture, 'main.ts'));
  const worker = await iife(join(fixture, 'echo.worker.ts'));
  const blob = `globalThis.__workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' }));`;
  for (const [id, prelude] of [
    ['esbuild-iife', ''],
    ['esbuild-iife+blob', `<script>${blob.replaceAll('</script', '<\\/script')}</script>\n`],
  ]) {
    const file = join(work, `${id}.html`);
    await writeFile(
      file,
      `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><title>${id}</title></head>\n<body>\n${prelude}<script>\n${page}</script>\n</body></html>\n`,
    );
    pages.push({ id, file });
  }

  // Electron as itself: any value of ELECTRON_RUN_AS_NODE, even empty, would make it a bare Node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // One Electron per page. In one session, Electron 43's main process died (SIGTRAP) when the
  // next window opened after a window whose page ran a dedicated worker was destroyed; each
  // page on its own was reliable.
  const runPage = async (page) => {
    const configPath = join(work, `electron-${page.id}.json`);
    await writeFile(
      configPath,
      JSON.stringify({ pages: [page], schemeRoot: viteOut, schemeCsp: VIBEFIELD_CSP, timeoutMs: 6000 }),
    );
    return new Promise((done) => {
      const child = spawn(electron, [join(here, 'worker-bundling-electron.mjs'), configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (error) => done({ id: page.id, result: null, console: [], error: error.message }));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find((entry) => entry.startsWith('RESULTS '));
        if (line) done(JSON.parse(line.slice('RESULTS '.length))[0]);
        else {
          const tail = stderr.trim().split('\n').slice(-3);
          done({ id: page.id, result: null, console: tail, error: `electron exited ${code ?? signal}` });
        }
      });
    });
  };
  const output = [];
  for (const page of pages) output.push(await runPage(page));

  console.log(`vite ${viteVersion} · esbuild ${esbuildVersion} · electron ${electronVersion}`);
  console.log('variant            expected  mode      ran in   demoted because');
  let failures = 0;
  for (const { id, result, console: lines, error } of output) {
    const ok = result?.mode === EXPECTED[id] && result?.where === (EXPECTED[id] === 'worker' ? 'worker' : 'window');
    if (!ok) failures += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${id.padEnd(18)} ${EXPECTED[id].padEnd(9)} ${String(result?.mode ?? '—').padEnd(9)} ${String(result?.where ?? '—').padEnd(8)} ${result?.demoted || ''}${error ? ` error: ${error}` : ''}`,
    );
    if (!ok) for (const line of lines) console.log(`       console ${line}`);
  }
  console.log(
    failures === 0 ? 'worker bundling: every variant as expected' : `worker bundling: ${failures} unexpected`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await server?.close();
  if (process.argv.includes('--keep')) console.log(`kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
