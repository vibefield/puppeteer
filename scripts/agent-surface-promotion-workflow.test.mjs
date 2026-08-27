import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(resolve(root, '.github/workflows/agent-surface-promotion.yml'), 'utf8');
const adaptation = readFileSync(resolve(root, '.github/workflows/agent-adaptation.yml'), 'utf8');
const live = readFileSync(resolve(root, '.github/workflows/agent-live.yml'), 'utf8');
const protectedLiveTests = Object.fromEntries(
  ['claude', 'codex', 'opencode'].map((vendor) => [
    vendor,
    readFileSync(
      resolve(
        root,
        'packages',
        `adapter-${vendor}`,
        'src',
        vendor === 'claude'
          ? 'pinned-real.live.test.ts'
          : vendor === 'codex'
            ? 'driver.live.test.ts'
            : 'opencode.live.test.ts',
      ),
      'utf8',
    ),
  ]),
);

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
  assert.match(pinnedReal, /PUPPETEER_LIVE_ARTIFACT:/);
  assert.match(pinnedReal, /PUPPETEER_LIVE_RECEIPT:/);
  assert.match(pinnedReal, /--adapter-receipt/);
  assert.doesNotMatch(pinnedReal, /--adapter-real passed/);
  assert.ok(verify.indexOf('pnpm surface:evidence:artifacts') < verify.indexOf('pnpm surface:verify'));
  assert.ok(promote.indexOf('pnpm surface:evidence:artifacts') < promote.indexOf('pnpm surface:promote'));
  assert.ok(
    promote.includes(
      'git add -- support/agents.json README.md "$AGENT_GROUND_TRUTH" "${AGENT_GROUND_TRUTH%.json}.html" "${AGENT_GROUND_TRUTH%/*}/model/${AGENT_VENDOR}@${AGENT_VERSION}/evidence.json"',
    ),
  );
});

test('opencode is an explicit reviewed workflow choice with isolated real-artifact lanes', () => {
  assert.match(adaptation, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(workflow, /options: \[claude, codex, opencode\]/);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'opencode' \}\}/);
  assert.match(workflow, /OPENCODE_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_OPENCODE_BIN:/);
  assert.match(workflow, /@vibecook\/puppeteer-adapter-opencode test/);
  assert.match(live, /opencode-live:/);
  assert.match(live, /if: \$\{\{ vars\.OPENCODE_LIVE_ENABLED == 'true' \}\}/);
  assert.match(live, /PUPPETEER_OPENCODE_BIN: \$\{\{ vars\.OPENCODE_BIN \}\}/);
});

test('every protected provider writes its artifact-bound receipt from an executed live test', () => {
  for (const [vendor, source] of Object.entries(protectedLiveTests)) {
    assert.match(source, /attestLiveAdapter/);
    assert.match(source, new RegExp(`vendor: '${vendor}'`));
    assert.match(source, /artifact: executable/);
  }
});

test('Grok adaptation remains available without claiming a skipped cross-platform promotion lane', () => {
  assert.match(adaptation, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.doesNotMatch(workflow, /options: \[[^\]]*grok/);
  assert.doesNotMatch(workflow, /Grok pinned-real lane|inputs\.vendor == 'grok'/);
  assert.match(live, /grok-live:/);
  assert.match(live, /GROK_LIVE: '1'/);
});

test('source-only Hermes has a generic adaptation lane without an unearned promotion lane', () => {
  assert.match(adaptation, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(adaptation, /scripts\/resolve-agent-acquisition\.mjs/);
  assert.match(adaptation, /scripts\/materialize-installed-console\.mjs/);
  assert.match(adaptation, /steps\.policy\.outputs\.outputName/);
  assert.match(adaptation, /steps\.policy\.outputs\.artifactKind == 'installed-console'/);
  assert.match(adaptation, /astral-sh\/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9/);
  assert.doesNotMatch(adaptation, /inputs\.vendor == 'hermes'/);
  assert.doesNotMatch(workflow, /options: \[[^\]]*kimi/);
  assert.doesNotMatch(workflow, /options: \[[^\]]*hermes/);
  assert.match(live, /hermes-surface:/);
  assert.match(live, /if: \$\{\{ vars\.HERMES_LIVE_ENABLED == 'true' \}\}/);
  assert.match(live, /packages\/surface\/vendors\/hermes\/census\/turn-census\.mjs/);
  assert.match(live, /kimi-live:/);
  assert.match(live, /controlled Kimi Surface census/);
});
