import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditPackageLayout } from './check-package-layout.mjs';

test('the repository package layout satisfies its declared boundaries', () => {
  assert.deepEqual(auditPackageLayout(), []);
});

test('the checker rejects a direct orphan package directory', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'puppeteer-layout-'));
  mkdirSync(join(fixture, 'packages', 'orphan'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(
    join(fixture, 'release-please-config.json'),
    JSON.stringify({ packages: { '.': { 'extra-files': [] } } }),
  );
  assert.ok(auditPackageLayout(fixture).some((issue) => issue.includes('has no package.json')));
});
