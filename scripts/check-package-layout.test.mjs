import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { architectureDependencyIssues, auditPackageLayout } from './check-package-layout.mjs';

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

test('the layered dependency checker rejects upward and concrete-provider edges', () => {
  assert.deepEqual(
    architectureDependencyIssues(
      new Map([
        ['packages/core', ['@vibecook/puppeteer-runtime']],
        ['packages/runtime', ['@vibecook/puppeteer-adapter-claude']],
        ['packages/imposter', ['@vibecook/puppeteer-core']],
        ['packages/react', ['@vibecook/puppeteer-runtime']],
      ]),
    ),
    [
      'packages/core production dependency @vibecook/puppeteer-runtime violates the layered architecture',
      'packages/runtime production dependency @vibecook/puppeteer-adapter-claude violates the layered architecture',
      'packages/imposter production dependency @vibecook/puppeteer-core violates the layered architecture',
      'packages/react production dependency @vibecook/puppeteer-runtime violates the layered architecture',
    ],
  );
});
