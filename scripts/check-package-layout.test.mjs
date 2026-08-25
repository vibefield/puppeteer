import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditPackageLayout, spaghettiAdapterPinIssues } from './check-package-layout.mjs';

test('the repository package layout satisfies its declared boundaries', () => {
  assert.deepEqual(auditPackageLayout(), []);
});

test('the checker rejects a direct orphan package directory', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'chopsticks-layout-'));
  mkdirSync(join(fixture, 'packages', 'orphan'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(
    join(fixture, 'release-please-config.json'),
    JSON.stringify({ packages: { '.': { 'extra-files': [] } } }),
  );
  assert.ok(auditPackageLayout(fixture).some((issue) => issue.includes('has no package.json')));
});

test('adapter Spaghetti contracts require one exact version pin', () => {
  assert.deepEqual(
    spaghettiAdapterPinIssues(
      new Map([
        ['packages/adapter-claude', { dependencies: { '@vibecook/spaghetti-sdk': '0.5.16' } }],
        ['packages/adapter-codex', { optionalDependencies: { '@vibecook/spaghetti-sdk': '0.5.16' } }],
      ]),
    ),
    [],
  );
  assert.ok(
    spaghettiAdapterPinIssues(
      new Map([['packages/adapter-claude', { dependencies: { '@vibecook/spaghetti-sdk': '^0.5.16' } }]]),
    ).some((issue) => issue.includes('must exactly pin')),
  );
  assert.ok(
    spaghettiAdapterPinIssues(
      new Map([
        [
          'packages/adapter-claude',
          {
            dependencies: { '@vibecook/spaghetti-sdk': '0.5.16' },
            devDependencies: { '@vibecook/spaghetti-sdk': '0.6.0' },
          },
        ],
      ]),
    ).some((issue) => issue.includes('declares conflicting')),
  );
  assert.ok(
    spaghettiAdapterPinIssues(
      new Map([
        ['packages/adapter-claude', { dependencies: { '@vibecook/spaghetti-sdk': '0.5.16' } }],
        ['packages/adapter-codex', { dependencies: { '@vibecook/spaghetti-sdk': '0.6.0' } }],
      ]),
    ).some((issue) => issue.includes('adapter pins differ')),
  );
});
