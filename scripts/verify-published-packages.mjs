import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnPackageManager } from './package-manager.mjs';
import { npmRegistry, readReleasePackages } from './release-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Local tarballs exercise this same consumer check before the first registry publication.
export function verifyPublishedPackages({ root = repositoryRoot, tarballs } = {}) {
  const packages = readReleasePackages(root);
  const version = packages[0].version;
  const dependencies = Object.fromEntries(
    packages.map(({ name }) => {
      if (!tarballs) return [name, version];
      const packed = tarballs.find((pkg) => pkg.name === name && pkg.version === version);
      if (!packed) throw new Error(`Missing consumer tarball for ${name}@${version}`);
      return [name, pathToFileURL(packed.tarballPath).href];
    }),
  );
  const npmVersion = spawnPackageManager('npm', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (npmVersion.status !== 0 || Number(/^(\d+)\./u.exec(npmVersion.stdout ?? '')?.[1] ?? 0) < 12) {
    throw new Error('Consumer verification requires npm 12 or newer; on Node 22, use Node 22.22.2 or newer');
  }
  const consumer = mkdtempSync(join(tmpdir(), 'puppeteer-registry-consumer-'));
  try {
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'puppeteer-release-consumer',
        private: true,
        type: 'module',
        dependencies,
        devDependencies: {
          vitest: readJson(join(root, 'package.json')).devDependencies.vitest,
          esbuild: readJson(join(root, 'packages/runtime/package.json')).devDependencies.esbuild,
        },
      }),
    );
    const installed = spawnPackageManager(
      'npm',
      ['install', '--ignore-scripts', '--no-fund', '--no-audit', `--registry=${npmRegistry}`],
      { cwd: consumer, stdio: 'inherit', timeout: 300_000 },
    );
    if (installed.status !== 0) throw new Error('The clean npm consumer installation failed');
    for (const { name } of packages) {
      const manifest = readJson(join(consumer, 'node_modules', name, 'package.json'));
      if (manifest.name !== name || manifest.version !== version)
        throw new Error(`Expected the installed consumer to contain ${name}@${version}`);
    }

    // Most roots must also import in ordinary Node, without Vitest's module loader or runtime context.
    writeFileSync(
      join(consumer, 'runtime.mjs'),
      `import assert from 'node:assert/strict';
const names = ${JSON.stringify(packages.map(({ name }) => name))};
for (const name of names) {
  if (name === '@vibefield/puppeteer-testing' || name === '@vibefield/puppeteer-views') continue;
  assert(Object.keys(await import(name)).length > 0, name + ' has no root exports');
}
console.log('Package roots imported in ordinary Node');
`,
    );
    const node = (args, options = {}) =>
      execFileSync(process.execPath, args, { cwd: consumer, stdio: 'inherit', timeout: 60_000, ...options });
    node(['runtime.mjs']);

    // Testing helpers need Vitest; Views contains CSS and must resolve in a browser bundle.
    writeFileSync(
      join(consumer, 'consumer.test.mjs'),
      `import { test, expect } from 'vitest';
import { build } from 'esbuild';
const names = ${JSON.stringify(packages.map(({ name }) => name))};
for (const name of [...names, '@vibefield/puppeteer-view-sdk/testing']) {
  test(name, async () => {
    if (name === '@vibefield/puppeteer-views') {
      const bundled = await build({
        stdin: { contents: "import * as views from '@vibefield/puppeteer-views'; console.log(views);", resolveDir: process.cwd() },
        bundle: true, platform: 'browser', format: 'esm', outdir: 'out', write: false,
      });
      expect(bundled.outputFiles.some(file => file.path.endsWith('.js'))).toBe(true);
      expect(bundled.outputFiles.some(file => file.path.endsWith('.css'))).toBe(true);
    } else {
      expect(Object.keys(await import(name)).length).toBeGreaterThan(0);
    }
  });
}
`,
    );
    node([join(consumer, 'node_modules/vitest/vitest.mjs'), 'run', 'consumer.test.mjs', '--maxWorkers=2']);
    const cliVersion = node(
      [join(consumer, 'node_modules/@vibefield/puppeteer-imposter/bin/ai.mjs'), '--claude', '--version'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (!/^\d+\.\d+\.\d+ \(Claude Code\)\s*$/u.test(cliVersion))
      throw new Error('The installed Imposter CLI did not report its Claude persona version');
    console.log(`Verified ${packages.length} package consumers and the Imposter CLI for v${version}`);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: node scripts/verify-published-packages.mjs');
    verifyPublishedPackages();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
