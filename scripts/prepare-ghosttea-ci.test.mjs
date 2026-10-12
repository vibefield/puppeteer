import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ghostteaSource, prepareGhosttea } from './prepare-ghosttea-ci.mjs';

test('CI refuses to overwrite a developer Ghosttea checkout', (t) => {
  const destination = mkdtempSync(join(tmpdir(), 'puppeteer-ghosttea-existing-'));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const work = join(destination, 'unpublished.txt');
  writeFileSync(work, 'keep this work');
  assert.throws(() => prepareGhosttea(destination), /Refusing to overwrite/);
  assert.equal(readFileSync(work, 'utf8'), 'keep this work');
});

test('CI verifies the pinned SDK patch before fetching or building source', (t) => {
  assert.match(ghostteaSource().revision, /^[0-9a-f]{40}$/);
  const directory = mkdtempSync(join(tmpdir(), 'puppeteer-ghosttea-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyFileSync(
    fileURLToPath(new URL('../.github/ci/ghosttea.json', import.meta.url)),
    join(directory, 'ghosttea.json'),
  );
  writeFileSync(join(directory, 'ghosttea-sdk.patch'), 'changed patch');
  assert.throws(() => ghostteaSource(directory), /does not match its pinned digest/);
});
