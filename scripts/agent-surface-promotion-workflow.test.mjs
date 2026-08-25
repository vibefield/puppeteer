import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(resolve(root, '.github/workflows/agent-surface-promotion.yml'), 'utf8');
const adaptation = readFileSync(resolve(root, '.github/workflows/agent-adaptation.yml'), 'utf8');
const live = readFileSync(resolve(root, '.github/workflows/agent-live.yml'), 'utf8');

function job(name, next) {
  const start = workflow.indexOf(`\n  ${name}:`);
  const end = next ? workflow.indexOf(`\n  ${next}:`, start + 1) : workflow.length;
  assert.notEqual(start, -1, `missing ${name} job`);
  assert.notEqual(end, -1, `missing ${next} job`);
  return workflow.slice(start, end);
}

test('promotion binds one complete acquisition through test, verification, and the atomic commit', () => {
  const pinnedReal = job('pinned-real', 'verify');
  const verify = job('verify', 'promote');
  const promote = job('promote');
  assert.equal(workflow.match(/pnpm surface:evidence:artifacts/g)?.length, 3);
  assert.match(workflow, /name: Bind the complete acquisition to candidate evidence/);
  assert.match(workflow, /name: Bind the tested artifacts to candidate evidence/);
  assert.match(workflow, /name: Restore the attested artifact evidence/);
  assert.ok(
    pinnedReal.indexOf('pnpm surface:evidence:artifacts') < pinnedReal.indexOf('Audit the exact candidate model'),
  );
  assert.ok(verify.indexOf('pnpm surface:evidence:artifacts') < verify.indexOf('pnpm surface:verify'));
  assert.ok(promote.indexOf('pnpm surface:evidence:artifacts') < promote.indexOf('pnpm surface:promote'));
  assert.match(promote, /git add -- support\/agents\.json README\.md "\$\{AGENT_MANIFEST%\/\*\}\/evidence\.json"/);
});

test('opencode is an explicit reviewed workflow choice with isolated real-artifact lanes', () => {
  assert.match(adaptation, /options: \[claude, codex, grok, kimi, opencode\]/);
  assert.match(workflow, /options: \[claude, codex, grok, opencode\]/);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'opencode' \}\}/);
  assert.match(workflow, /OPENCODE_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_OPENCODE_BIN:/);
  assert.match(workflow, /@vibecook\/puppeteer-adapter-opencode test/);
  assert.match(live, /opencode-live:/);
  assert.match(live, /if: \$\{\{ vars\.OPENCODE_LIVE_ENABLED == 'true' \}\}/);
  assert.match(live, /PUPPETEER_OPENCODE_BIN: \$\{\{ vars\.OPENCODE_BIN \}\}/);
});
