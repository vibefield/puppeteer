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
  Object.entries({
    claude: 'native-tui.live.test.ts',
    codex: 'native-tui.live.test.ts',
    grok: 'acp.live.test.ts',
    hermes: 'driver.live.test.ts',
    kimi: 'driver.live.test.ts',
    opencode: 'opencode.live.test.ts',
  }).map(([vendor, file]) => [
    vendor,
    readFileSync(resolve(root, 'packages', `adapter-${vendor}`, 'src', file), 'utf8'),
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

test('OpenCode is an explicit reviewed workflow choice with isolated native-TUI and resume lanes', () => {
  assert.match(adaptation, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(workflow, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'opencode' \}\}/);
  assert.match(workflow, /OPENCODE_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_OPENCODE_BIN:/);
  assert.match(workflow, /@vibecook\/puppeteer-adapter-opencode test/);
  assert.match(live, /opencode-live:/);
  assert.match(live, /if: \$\{\{ vars\.OPENCODE_LIVE_ENABLED == 'true' \}\}/);
  assert.match(live, /PUPPETEER_OPENCODE_BIN: \$\{\{ vars\.OPENCODE_BIN \}\}/);
  assert.match(protectedLiveTests.opencode, /testId: 'opencode:native-tui-wire'/);
  assert.match(
    protectedLiveTests.opencode,
    /host\.output\(session!\.runtimeSessionId\)\.includes\(OPENCODE_LIVE_RESPONSE_MARKER\)/,
  );
  assert.match(
    protectedLiveTests.opencode,
    /host\.output\(resumed!\.runtimeSessionId\)\.includes\(OPENCODE_LIVE_RESPONSE_MARKER\)/,
  );
});

test('Kimi uses the same exact artifact for its cross-platform native-TUI and resume lane', () => {
  assert.match(workflow, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'kimi' \}\}/);
  assert.match(workflow, /KIMI_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_KIMI_BIN:/);
  assert.match(workflow, /@vibecook\/puppeteer-adapter-kimi test/);
  assert.match(live, /kimi-live:/);
  assert.match(live, /KIMI_LIVE: '1'/);
  assert.match(live, /PUPPETEER_KIMI_BIN: \$\{\{ vars\.KIMI_BIN \}\}/);
  assert.match(protectedLiveTests.kimi, /testId: 'kimi:native-tui-wire'/);
  assert.match(
    protectedLiveTests.kimi,
    /host\.output\(session!\.runtimeSessionId\)\.includes\(KIMI_LIVE_RESPONSE_MARKER\)/,
  );
  assert.match(
    protectedLiveTests.kimi,
    /host\.output\(resumed!\.runtimeSessionId\)\.includes\(KIMI_LIVE_RESPONSE_MARKER\)/,
  );
});

test('Codex promotion proves the exact private app-server and native TUI without account credentials', () => {
  const pinnedReal = job('pinned-real', 'verify');
  assert.match(pinnedReal, /if: \$\{\{ inputs\.vendor == 'codex' \}\}/);
  assert.match(pinnedReal, /Codex pinned-real native-TUI\/resume lane/);
  assert.match(pinnedReal, /CODEX_NATIVE_TUI_LIVE: '1'/);
  assert.doesNotMatch(pinnedReal, /CODEX_LIVE: '1'/);
  assert.match(pinnedReal, /PUPPETEER_CODEX_BIN:/);
  assert.match(pinnedReal, /@vibecook\/puppeteer-adapter-codex test/);
  assert.match(live, /codex-live:/);
  assert.match(live, /CODEX_NATIVE_TUI_LIVE: '1'/);
  assert.match(live, /Run Codex native-TUI\/app-server\/resume proof/);
  assert.match(live, /PUPPETEER_CODEX_BIN: \$\{\{ vars\.CODEX_BIN \}\}/);
  assert.match(protectedLiveTests.codex, /testId: 'codex:native-tui-app-server'/);
  assert.match(
    protectedLiveTests.codex,
    /host\.output\(session!\.runtimeSessionId\)\.includes\(CODEX_LIVE_RESPONSE_MARKER\)/,
  );
  assert.match(
    protectedLiveTests.codex,
    /host\.output\(resumed!\.runtimeSessionId\)\.includes\(CODEX_LIVE_RESPONSE_MARKER\)/,
  );
});

test('Claude promotion proves the exact native TUI, hooks, transcript, and resume without account credentials', () => {
  const pinnedReal = job('pinned-real', 'verify');
  assert.match(pinnedReal, /if: \$\{\{ inputs\.vendor == 'claude' \}\}/);
  assert.match(pinnedReal, /Claude pinned-real native-TUI\/resume lane/);
  assert.match(pinnedReal, /CLAUDE_NATIVE_TUI_LIVE: '1'/);
  assert.doesNotMatch(pinnedReal, /PUPPETEER_REAL_CLAUDE: '1'/);
  assert.match(pinnedReal, /PUPPETEER_CLAUDE_BIN:/);
  assert.match(pinnedReal, /@vibecook\/puppeteer-adapter-claude test/);
  assert.match(live, /claude-live:/);
  assert.match(live, /CLAUDE_NATIVE_TUI_LIVE: '1'/);
  assert.match(live, /Run Claude native-TUI\/hooks\/transcript\/resume proof/);
  assert.match(live, /PUPPETEER_CLAUDE_BIN: \$\{\{ vars\.CLAUDE_BIN \}\}/);
  assert.match(protectedLiveTests.claude, /testId: 'claude:native-tui-hooks'/);
  assert.match(
    protectedLiveTests.claude,
    /host\.output\(session!\.runtimeSessionId\)\.includes\(CLAUDE_LIVE_RESPONSE_MARKER\)/,
  );
  assert.match(
    protectedLiveTests.claude,
    /host\.output\(resumed!\.runtimeSessionId\)\.includes\(CLAUDE_LIVE_RESPONSE_MARKER\)/,
  );
});

test('every protected provider writes its artifact-bound receipt from an executed live test', () => {
  for (const [vendor, source] of Object.entries(protectedLiveTests)) {
    assert.match(source, /attestLiveAdapter/);
    assert.match(source, new RegExp(`vendor: '${vendor}'`));
    assert.match(source, vendor === 'hermes' ? /artifact: promotionArtifact/ : /artifact: executable/);
  }
});

test('Grok uses the exact artifact in a hermetic cross-platform native-TUI adapter lane', () => {
  assert.match(adaptation, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(workflow, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'grok' \}\}/);
  assert.match(workflow, /Grok pinned-real native-TUI\/resume lane/);
  assert.match(workflow, /GROK_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_GROK_BIN:/);
  assert.match(workflow, /@vibecook\/puppeteer-adapter-grok test/);
  assert.match(live, /grok-live:/);
  assert.match(live, /if: \$\{\{ vars\.GROK_LIVE_ENABLED == 'true' \}\}/);
  assert.match(live, /GROK_LIVE: '1'/);
  assert.match(live, /Run Grok native-TUI\/leader\/ACP\/durable-store\/resume proof/);
  assert.match(live, /PUPPETEER_GROK_BIN: \$\{\{ vars\.GROK_BIN \}\}/);
  assert.doesNotMatch(live, /GROK_LIVE_HOME/);
  assert.match(protectedLiveTests.grok, /testId: 'grok:native-tui-leader'/);
  assert.match(
    protectedLiveTests.grok,
    /host\.output\(session!\.runtimeSessionId\)\.includes\(GROK_LIVE_RESPONSE_MARKER\)/,
  );
  assert.match(
    protectedLiveTests.grok,
    /host\.output\(resumed!\.runtimeSessionId\)\.includes\(GROK_LIVE_RESPONSE_MARKER\)/,
  );
});

test('source-built Hermes is reconstructed generically before its protected native-TUI/resume lane', () => {
  const acquire = job('acquire', 'assemble');
  const pinnedReal = job('pinned-real', 'verify');
  assert.match(adaptation, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(adaptation, /scripts\/resolve-agent-acquisition\.mjs/);
  assert.match(adaptation, /scripts\/materialize-installed-console\.mjs/);
  assert.match(adaptation, /steps\.policy\.outputs\.outputName/);
  assert.match(adaptation, /steps\.policy\.outputs\.artifactKind == 'installed-console'/);
  assert.match(adaptation, /astral-sh\/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9/);
  assert.match(adaptation, /steps\.policy\.outputs\.nodeVersion != ''/);
  assert.match(adaptation, /node-version: \$\{\{ steps\.policy\.outputs\.nodeVersion \}\}/);
  assert.match(adaptation, /--node node/);
  assert.match(adaptation, /--npm npm/);
  assert.doesNotMatch(adaptation, /inputs\.vendor == 'hermes'/);
  assert.match(workflow, /options: \[claude, codex, grok, hermes, kimi, opencode\]/);
  assert.match(workflow, /source_reference:/);
  assert.match(acquire, /scripts\/resolve-agent-acquisition\.mjs/);
  assert.match(acquire, /scripts\/materialize-installed-console\.mjs/);
  assert.match(acquire, /name: promotion-source-\$\{\{ matrix\.platform \}\}/);
  assert.doesNotMatch(acquire, /inputs\.vendor == 'hermes'/);
  assert.doesNotMatch(acquire, /\$AGENT_/);
  assert.match(pinnedReal, /name: promotion-source-\$\{\{ matrix\.platform \}\}/);
  assert.match(pinnedReal, /Reconstruct locked installed console on the protected runner/);
  assert.match(pinnedReal, /scripts\/verify-installed-console-reconstruction\.mjs/);
  assert.match(pinnedReal, /if: \$\{\{ inputs\.vendor == 'hermes' \}\}/);
  assert.match(pinnedReal, /HERMES_LIVE: '1'/);
  assert.match(pinnedReal, /PUPPETEER_HERMES_BIN:/);
  assert.match(pinnedReal, /HERMES_PYTHON:/);
  assert.match(pinnedReal, /HERMES_TUI_DIR:/);
  assert.match(pinnedReal, /Hermes pinned-real native-TUI\/resume lane/);
  assert.match(pinnedReal, /@vibecook\/puppeteer-adapter-hermes test/);
  assert.doesNotMatch(pinnedReal, /\$AGENT_/);
  assert.match(live, /hermes-surface:/);
  assert.match(live, /if: \$\{\{ vars\.HERMES_LIVE_ENABLED == 'true' \}\}/);
  assert.match(live, /packages\/surface\/vendors\/hermes\/census\/turn-census\.mjs/);
  assert.match(live, /HERMES_LIVE: '1'/);
  assert.match(live, /HERMES_TUI_DIR: \$\{\{ vars\.HERMES_TUI_DIR \}\}/);
  assert.match(live, /Recheck the adapter through pinned native-TUI resume/);
  assert.match(protectedLiveTests.hermes, /testId: 'hermes:native-tui-gateway'/);
  assert.match(
    protectedLiveTests.hermes,
    /host\.output\(session!\.runtimeSessionId\)\.includes\(HERMES_LIVE_RESPONSE_MARKER\)/,
  );
  assert.match(
    protectedLiveTests.hermes,
    /host\.output\(resumed!\.runtimeSessionId\)\.includes\(HERMES_LIVE_RESPONSE_MARKER\)/,
  );
});
