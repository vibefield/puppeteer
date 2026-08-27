import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  accountUsageConsumerBoundaryIssues,
  architectureDependencyIssues,
  auditPackageLayout,
  godviewConsumerBoundaryIssues,
  launchConsumerBoundaryIssues,
  launchHostBoundaryIssues,
} from './check-package-layout.mjs';

test('the repository package layout satisfies its declared boundaries', () => {
  assert.deepEqual(auditPackageLayout(), []);
});

test('the checker rejects direct orphan package and application directories', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'puppeteer-layout-'));
  mkdirSync(join(fixture, 'packages', 'orphan'), { recursive: true });
  mkdirSync(join(fixture, 'apps', 'orphan'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(
    join(fixture, 'release-please-config.json'),
    JSON.stringify({ packages: { '.': { 'extra-files': [] } } }),
  );
  const issues = auditPackageLayout(fixture);
  assert.ok(
    issues.some((issue) => issue === 'packages/orphan has no package.json (orphan/category directories are forbidden)'),
  );
  assert.ok(
    issues.some((issue) => issue === 'apps/orphan has no package.json (orphan application directories are forbidden)'),
  );
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

test('the account-usage consumer boundary rejects provider quirks', () => {
  assert.deepEqual(
    accountUsageConsumerBoundaryIssues(
      new Map([
        ['generic.ts', "import type { AccountUsageMetric } from '@vibecook/puppeteer-core';"],
        ['adapter.ts', "import { value } from '@vibecook/puppeteer-adapter-claude';"],
        ['bucket.ts', "if (window.id === 'five_hour') return '5H';"],
      ]),
    ),
    [
      'adapter.ts must not import an agent adapter',
      'adapter.ts contains provider-specific account-usage token claude',
      'bucket.ts contains provider-specific account-usage token five_hour',
    ],
  );
});

test('the launch consumer boundary rejects provider grammar and transport quirks', () => {
  assert.deepEqual(
    launchConsumerBoundaryIssues(
      new Map([
        [
          'host.ts',
          "runtime.prepareInvocation({ providerId, argv, environment, implementation: { kind: 'native' } });",
        ],
        ['parser.ts', "if (provider === 'codex') options.resumeInvocation = argv;"],
        ['transport.ts', 'const appServerEnv = { AI_PERSONA: provider };'],
        ['options.ts', 'runtime.prepareSession({ agent, agentOptions });'],
      ]),
    ),
    [
      'parser.ts contains provider-specific launch token codex',
      'parser.ts contains provider-specific launch token resumeInvocation',
      'transport.ts contains provider-specific launch token appServerEnv',
      'transport.ts contains provider-specific launch token AI_PERSONA',
      'options.ts contains provider-specific launch token agentOptions',
    ],
  );
});

test('the launch host may brand providers but rejects private adapter recipes', () => {
  assert.deepEqual(
    launchHostBoundaryIssues(
      new Map([
        ['main.ts', "if (agent === 'codex') renderBrand();"],
        ['adapter.ts', "import { prepare } from '@vibecook/puppeteer-adapter-codex';"],
        ['transport.ts', 'const appServerEnv = {};'],
        ['options.ts', 'const agentOptions = restore.launch;'],
      ]),
    ),
    [
      'adapter.ts must not import an agent adapter',
      'transport.ts contains private launch token appServerEnv',
      'options.ts contains private launch token agentOptions',
    ],
  );
});

test('the full Godview boundary isolates branding and rejects provider-native behavior', () => {
  assert.deepEqual(
    godviewConsumerBoundaryIssues(
      new Map([
        ['apps/godview/src/main/main.ts', "import { create } from '@vibecook/puppeteer-builtin-providers';"],
        ['apps/godview/src/renderer/AgentIcon.tsx', "if (providerId === 'codex') return <svg />;"],
        ['apps/godview/src/renderer/view.tsx', "if (agent === 'claude') send('/compact');"],
        ['apps/godview/src/main/transport.ts', 'const hook_event_name = nativeEvent;'],
        ['apps/godview/src/main/adapter.ts', "import { driver } from '@vibecook/puppeteer-adapter-codex';"],
        ['apps/godview/src/renderer/catalog.ts', "import { all } from '@vibecook/puppeteer-builtin-providers';"],
      ]),
    ),
    [
      'apps/godview/src/renderer/view.tsx contains provider-specific Godview token claude',
      'apps/godview/src/renderer/view.tsx contains provider-native terminal command /compact',
      'apps/godview/src/main/transport.ts contains provider-native wire token hook_event_name',
      'apps/godview/src/main/transport.ts contains provider-native wire token nativeEvent',
      'apps/godview/src/main/adapter.ts must not import an agent adapter',
      'apps/godview/src/main/adapter.ts contains provider-specific Godview token codex',
      "apps/godview/src/renderer/catalog.ts may not compose built-in providers outside Godview's main composition root",
    ],
  );
});
