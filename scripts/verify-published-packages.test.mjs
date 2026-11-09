import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyProvidersBundle } from './verify-published-packages.mjs';

const runtimeManifest = fileURLToPath(new URL('../packages/runtime/package.json', import.meta.url));
const esbuildRoot = dirname(createRequire(runtimeManifest).resolve('esbuild/package.json'));

// A consumer whose providers package is `index`, with every other package hoisted beside it as npm would.
function withConsumer(index, type, run) {
  const consumer = mkdtempSync(join(tmpdir(), 'puppeteer-bundle-guard-'));
  try {
    const modules = join(consumer, 'node_modules');
    const providers = join(modules, '@vibefield/puppeteer-builtin-providers');
    const hoisted = join(modules, 'hoisted-dep');
    mkdirSync(providers, { recursive: true });
    mkdirSync(hoisted);
    symlinkSync(esbuildRoot, join(modules, 'esbuild'), 'junction');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(providers, 'package.json'), JSON.stringify({ main: 'index.js', type }));
    writeFileSync(join(providers, 'index.js'), index);
    writeFileSync(join(hoisted, 'index.js'), 'module.exports = () => undefined;\n');
    run(consumer);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

// jsonc-parser's UMD shape: `require` is a parameter, so a bundler leaves the inner call in the bundle.
const HIDDEN_BARE_REQUIRE = `(function (factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') factory(require, exports);
})(function (require, exports) {
  exports.createBuiltinProviders = require('hoisted-dep');
});
`;

const ERASED_MODULE_URL = `import { fileURLToPath } from 'node:url';
export function createBuiltinProviders() {
  return fileURLToPath(import.meta.url);
}
`;

test('a providers graph that bundles whole passes', () => {
  withConsumer('exports.createBuiltinProviders = () => undefined;\n', 'commonjs', verifyProvidersBundle);
});

test('a bare require the bundler could not see is not answered by the consumer install', () => {
  withConsumer(HIDDEN_BARE_REQUIRE, 'commonjs', (consumer) => {
    assert.throws(() => verifyProvidersBundle(consumer), /providers\.cjs/u);
  });
});

test("a module URL that fieldd's flags erase is refused, though only a launch would reach it", () => {
  withConsumer(ERASED_MODULE_URL, 'module', (consumer) => {
    assert.throws(() => verifyProvidersBundle(consumer), /fileURLToPath/u);
  });
});
