import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(resolve(root, '.github/workflows/agent-surface-promotion.yml'), 'utf8');
const adaptation = readFileSync(resolve(root, '.github/workflows/agent-adaptation.yml'), 'utf8');
const live = readFileSync(resolve(root, '.github/workflows/agent-live.yml'), 'utf8');
const adaptationVendorChoices = /options: \[antigravity, claude, codex, copilot, grok, hermes, kimi, opencode, pi\]/;
const promotionVendorChoices = /options: \[claude, codex, grok, hermes, kimi, opencode\]/;
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

/** One `- name:` step of a job, up to the next step. */
function step(source, name) {
  const start = source.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `missing step ${name}`);
  const end = source.indexOf('\n      - ', start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

/** The script text of every `run:` in a job, block scalars included. */
function runScripts(source) {
  const lines = source.split('\n');
  const scripts = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
    if (!match) return;
    const indent = match[1].length + (line.trimStart().startsWith('- ') ? 2 : 0);
    const body = [match[2]];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    scripts.push(body.join('\n'));
  });
  return scripts;
}

const JOBS = ['guard', 'acquire', 'assemble', 'pinned-real', 'verify', 'transaction', 'promote'];
const jobs = Object.fromEntries(JOBS.map((name, index) => [name, job(name, JOBS[index + 1])]));

test('promotion binds one complete acquisition through test, verification, and the transaction', () => {
  const { 'pinned-real': pinnedReal, verify, transaction } = jobs;
  assert.equal(workflow.match(/pnpm surface:evidence:artifacts/g)?.length, 3);
  assert.match(pinnedReal, /name: Bind the complete acquisition to candidate evidence/);
  assert.match(verify, /name: Bind the tested artifacts to candidate evidence/);
  assert.match(transaction, /name: Restore the attested artifact evidence/);
  assert.ok(
    pinnedReal.indexOf('pnpm surface:evidence:artifacts') < pinnedReal.indexOf('Audit the exact candidate model'),
  );
  assert.match(pinnedReal, /PUPPETEER_LIVE_ARTIFACT:/);
  assert.match(pinnedReal, /PUPPETEER_LIVE_RECEIPT:/);
  assert.match(pinnedReal, /--adapter-receipt/);
  assert.doesNotMatch(pinnedReal, /--adapter-real passed/);
  assert.ok(verify.indexOf('pnpm surface:evidence:artifacts') < verify.indexOf('pnpm surface:verify'));
  // The restored evidence moves the canonical ground truth, so the adapter lock follows it; the commit is staged
  // and boundary-checked, then the repository gates run on that exact tree before the transaction is uploaded.
  const order = [
    'pnpm surface:evidence:artifacts',
    'pnpm surface:promote',
    'pnpm groundtruth:mapping:write',
    'node scripts/promotion-transaction.mjs write',
    'Refuse a promotion commit that would leave the repository gates red',
    'name: promotion-transaction',
  ].map((marker) => transaction.indexOf(marker));
  assert.ok(
    order.every((index, position) => index >= 0 && (position === 0 || order[position - 1] < index)),
    `${order}`,
  );
  const gates = step(transaction, 'Refuse a promotion commit that would leave the repository gates red');
  for (const gate of [
    'pnpm packages:check',
    'pnpm support:check',
    'pnpm groundtruth:mapping:check',
    'pnpm surface:groundtruth:check',
    'surface:evidence:check',
    'node --test scripts/*.test.mjs',
    // CI's package job: a workflow-token push starts no CI, so the promotion commit gets it here.
    "pnpm -r --no-bail --workspace-concurrency=1 --filter './packages/**' test --testTimeout=15000",
    // No gate may rewrite the staged promotion.
    'git diff --exit-code',
  ]) {
    assert.ok(gates.includes(gate), `the transaction must run ${gate}`);
  }
  const stage = step(transaction, "Stage exactly the promotion's files as the transaction");
  assert.match(stage, /git add --all\n\s+node scripts\/promotion-transaction\.mjs write/);
  assert.match(stage, /--base "\$GITHUB_SHA"/);
});

test('the only writing job installs nothing, re-checks the transaction, and gives the token to the push alone', () => {
  const { promote } = jobs;
  assert.match(promote, /needs: transaction\n\s+if: \$\{\{ inputs\.confirm == 'promote' \}\}/);
  assert.match(promote, /environment: agent-surface-promotion\n\s+permissions:\n\s+contents: write/);
  assert.doesNotMatch(promote, /pnpm|node --test|setup-node|action-setup/);
  assert.match(promote, /persist-credentials: false/);
  assert.match(promote, /name: promotion-transaction\n/);
  const apply = step(promote, 'Apply the transaction this run attempt prepared and gated');
  const verifyAt = apply.indexOf('promotion-transaction.mjs verify');
  const applyAt = apply.indexOf('apply --index .agent-adaptation/transaction/promotion.patch');
  const stagedAt = apply.indexOf('--staged');
  assert.ok(verifyAt >= 0 && verifyAt < applyAt && applyAt < stagedAt);
  const commit = step(promote, "Commit exactly the promotion's files");
  assert.match(commit, /git -c core\.hooksPath=\/dev\/null/);
  assert.match(commit, /commit --no-verify -m "chore\(surface\): promote \$\{AGENT_VENDOR\} \$\{AGENT_VERSION\}"/);
  assert.ok(commit.indexOf('commit --no-verify') < commit.indexOf('--commit HEAD'));
  assert.doesNotMatch(commit, /token/i);
  const push = step(promote, 'Push the promotion commit to the dispatched branch');
  assert.match(push, /PUSH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(push, /GIT_CONFIG_KEY_0=core\.hooksPath GIT_CONFIG_VALUE_0=\/dev\/null/);
  assert.match(push, /git push --no-verify origin "HEAD:refs\/heads\/\$\{GITHUB_REF_NAME\}"/);
  assert.match(push, /gh workflow run ci\.yml --ref/);
  assert.equal(promote.match(/github\.token/g)?.length, 1);
  assert.doesNotMatch(promote, /git config|git add/);
});

test('the live lanes run on fresh GitHub-hosted runners that nothing later trusts', () => {
  const { assemble, 'pinned-real': pinnedReal, verify } = jobs;
  assert.doesNotMatch(workflow, /self-hosted|puppeteer-agent-live/);
  assert.doesNotMatch(workflow, /\$\{\{\s*(secrets|vars)\./);
  for (const [platform, runner] of [
    ['darwin-arm64', 'macos-14'],
    ['darwin-x64', 'macos-15-intel'],
    ['linux-x64', 'ubuntu-24.04'],
    ['windows-x64', 'windows-2025'],
  ]) {
    assert.match(pinnedReal, new RegExp(`- platform: ${platform}\\n\\s+runner: ${runner}\\n`));
  }
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  // Only the protected promote job may write, and only it enters the reviewed environment.
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
  assert.equal(workflow.match(/environment: agent-surface-promotion/g)?.length, 1);
  // Every checkout persists no credentials, every action is pinned to a commit, and no job saves or restores a
  // cache a vendor binary could have written.
  assert.equal(
    workflow.match(/uses: actions\/checkout@/g)?.length,
    workflow.match(/persist-credentials: false/g)?.length,
  );
  for (const [, action, ref] of workflow.matchAll(/uses: ([^@\s]+)@(\S+)/g)) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${action} must be pinned to a commit`);
  }
  assert.doesNotMatch(workflow, /cache: pnpm|merge-multiple/);
  assert.equal(
    workflow.match(/uses: actions\/setup-node@/g)?.length,
    workflow.match(/package-manager-cache: false/g)?.length,
  );
  // Each platform's bytes come from its own lane's artifact, and each report from its own lane.
  assert.match(assemble, /pattern: promotion-artifact-\*\n\s+path: \.agent-adaptation\/downloads\n/);
  assert.match(assemble, /--downloads \.agent-adaptation\/downloads/);
  assert.match(
    pinnedReal,
    /name: promotion-artifact-\$\{\{ matrix\.platform \}\}\n\s+path: \.agent-adaptation\/artifacts\n/,
  );
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'windows-x64']) {
    assert.ok(
      verify.includes(
        `name: promotion-platform-${platform}\n          path: .agent-adaptation/platforms/${platform}\n`,
      ),
    );
    assert.ok(verify.includes(`--platform-report .agent-adaptation/platforms/${platform}/${platform}.json`));
  }
  // Workflow artifacts drop file modes; the lane restores the bit on the exact (re-hashed) bytes.
  assert.match(pinnedReal, /name: Restore the executable bit lost in artifact transfer/);
  assert.match(
    pinnedReal,
    /runner\.os != 'Windows' && steps\.policy\.outputs\.artifactKind == 'standalone-executable'/,
  );
  assert.ok(
    pinnedReal.indexOf('Restore the executable bit') > pinnedReal.indexOf('name: promotion-acquisition') &&
      pinnedReal.indexOf('Restore the executable bit') < pinnedReal.indexOf('Audit the exact candidate model'),
  );
  // The report binds the version these bytes print on the live runner, not the acquisition's own record.
  assert.match(
    step(pinnedReal, 'Probe the exact version again on the live runner'),
    /--output "\.agent-adaptation\/live-artifacts\/\$\{\{ matrix\.platform \}\}\/version\.txt"/,
  );
  assert.match(
    pinnedReal,
    /--version-output-file "\.agent-adaptation\/live-artifacts\/\$\{\{ matrix\.platform \}\}\/version\.txt"/,
  );
  for (const vendor of ['claude', 'codex', 'grok', 'hermes', 'opencode', 'kimi']) {
    assert.ok(pinnedReal.includes(`@vibefield/puppeteer-adapter-${vendor} test --testTimeout=15000`), vendor);
  }
  // The acquisition is read again after a human approval, so it is kept as long as the verification.
  assert.match(job('assemble', 'pinned-real'), /name: promotion-acquisition\n(?:.*\n){2}\s+retention-days: 7\n/);
});

test('every input is validated before any lane runs, and a promotion only targets a candidate branch', () => {
  const { guard, acquire } = jobs;
  assert.match(workflow, /confirm:\n(?:.*\n)+?\s+type: choice\n\s+options: \[rehearse, promote\]/);
  assert.match(guard, /if: \$\{\{ inputs\.confirm == 'promote' \|\| inputs\.confirm == 'rehearse' \}\}/);
  assert.match(guard, /run: node scripts\/validate-promotion-dispatch\.mjs/);
  assert.match(guard, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(
    step(guard, 'Refuse a promotion whose branch has already moved past this commit'),
    /"\$head" != "\$GITHUB_SHA"/,
  );
  assert.match(acquire, /\n    needs: guard\n/);
  // Every other job runs after the guard, and none but the guard reads inputs into a script before it.
  for (const name of JOBS.slice(2)) assert.match(jobs[name], /\n    needs: /, name);
  assert.doesNotMatch(guard, /\$\{\{ inputs\.(version|source_reference|ground_truth) \}\}/);
  // Linux-only jobs read the inputs from the environment; only the cross-platform lanes substitute them.
  for (const name of ['guard', 'assemble', 'verify', 'transaction', 'promote']) {
    for (const script of runScripts(jobs[name])) assert.doesNotMatch(script, /\$\{\{ inputs\./, name);
  }
  assert.ok(runScripts(jobs.acquire).some((script) => script.includes('${{ inputs.version }}')));
  assert.match(workflow, /AGENT_SOURCE_REFERENCE: \$\{\{ inputs\.source_reference \}\}/);
  // Rehearsals and promotions never share a concurrency group; promotions serialize per ref.
  assert.match(workflow, /format\('agent-surface-promotion-\{0\}', github\.ref\)/);
  assert.match(workflow, /format\('agent-surface-rehearsal-\{0\}-\{1\}', inputs\.vendor, github\.ref\)/);
});

test('a rehearsal runs every acquisition, live, verification, and transaction lane but never the promote job', () => {
  assert.match(jobs.promote, /needs: transaction\n\s+if: \$\{\{ inputs\.confirm == 'promote' \}\}/);
  for (const name of ['acquire', 'assemble', 'pinned-real', 'verify', 'transaction']) {
    assert.doesNotMatch(jobs[name], /inputs\.confirm/, `${name} follows the guard rather than re-reading confirm`);
  }
  // A staged candidate's rehearsal proves the transaction too; a supported version has nothing to promote.
  const select = step(jobs.transaction, 'Select the transaction');
  assert.match(select, /agent\?\.candidateVersion === process\.env\.AGENT_VERSION/);
  assert.match(select, /"\$AGENT_CONFIRM" = promote/);
  assert.equal(
    jobs.transaction.match(/if: \$\{\{ steps\.select\.outputs\.run == 'true' \}\}/g)?.length,
    jobs.transaction.match(/\n      - /g).length - 4,
  );
});

test('nightly reconciliation rehearses the protected lanes for every promotion vendor', () => {
  assert.doesNotMatch(live, /self-hosted|puppeteer-agent-live/);
  assert.doesNotMatch(live, /vars\.[A-Z_]+_BIN\b/);
  assert.match(live, /^permissions:\n {2}contents: read\n/m);
  assert.match(live, /permissions:\n\s+contents: read\n\s+actions: write/);
  const vendors = /options: \[([^\]]+)\]/.exec(workflow.slice(workflow.indexOf('vendor:')))[1].split(', ');
  for (const vendor of vendors) {
    assert.match(
      live,
      new RegExp(`- vendor: ${vendor}\\n\\s+enabled: \\$\\{\\{ vars\\.${vendor.toUpperCase()}_LIVE_ENABLED \\}\\}`),
    );
  }
  assert.match(live, /gh workflow run agent-surface-promotion\.yml/);
  assert.match(live, /-f confirm=rehearse/);
  assert.doesNotMatch(live, /confirm=promote/);
  assert.match(live, /scripts\/agent-model-selection\.mjs --vendor "\$VENDOR" --field version/);
  assert.match(live, /source_reference: \$\{\{ vars\.HERMES_SOURCE_REFERENCE \}\}/);
  // Repository code runs without the token; only the dispatch step receives it.
  assert.equal(live.match(/GH_TOKEN/g)?.length, 1);
  const dispatchAt = live.indexOf('name: Rehearse the protected promotion lanes');
  assert.ok(live.indexOf('GH_TOKEN') > dispatchAt);
  assert.ok(live.indexOf('agent-model-selection.mjs') < dispatchAt);
  assert.doesNotMatch(live.slice(dispatchAt), /node /);
  for (const [, action, ref] of live.matchAll(/uses: ([^@\s]+)@(\S+)/g)) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${action} must be pinned to a commit`);
  }
});

test('OpenCode is an explicit reviewed workflow choice with isolated native-TUI and resume lanes', () => {
  assert.match(adaptation, adaptationVendorChoices);
  assert.match(workflow, promotionVendorChoices);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'opencode' \}\}/);
  assert.match(workflow, /OPENCODE_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_OPENCODE_BIN:/);
  assert.match(workflow, /@vibefield\/puppeteer-adapter-opencode test/);
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
  assert.match(workflow, promotionVendorChoices);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'kimi' \}\}/);
  assert.match(workflow, /KIMI_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_KIMI_BIN:/);
  assert.match(workflow, /@vibefield\/puppeteer-adapter-kimi test/);
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
  assert.match(pinnedReal, /@vibefield\/puppeteer-adapter-codex test/);
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
  assert.match(pinnedReal, /@vibefield\/puppeteer-adapter-claude test/);
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
  assert.match(adaptation, adaptationVendorChoices);
  assert.match(workflow, promotionVendorChoices);
  assert.match(workflow, /if: \$\{\{ inputs\.vendor == 'grok' \}\}/);
  assert.match(workflow, /Grok pinned-real native-TUI\/resume lane/);
  assert.match(workflow, /GROK_LIVE: '1'/);
  assert.match(workflow, /PUPPETEER_GROK_BIN:/);
  assert.match(workflow, /@vibefield\/puppeteer-adapter-grok test/);
  assert.doesNotMatch(workflow, /GROK_LIVE_HOME/);
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
  assert.match(adaptation, adaptationVendorChoices);
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
  assert.match(workflow, promotionVendorChoices);
  assert.match(workflow, /source_reference:/);
  assert.match(acquire, /scripts\/resolve-agent-acquisition\.mjs/);
  assert.match(acquire, /scripts\/materialize-installed-console\.mjs/);
  assert.match(acquire, /name: promotion-source-\$\{\{ matrix\.platform \}\}/);
  assert.doesNotMatch(acquire, /inputs\.vendor == 'hermes'/);
  assert.doesNotMatch(acquire, /\$AGENT_/);
  assert.match(pinnedReal, /name: promotion-source-\$\{\{ matrix\.platform \}\}/);
  assert.match(pinnedReal, /Reconstruct locked installed console on the live runner/);
  assert.match(pinnedReal, /scripts\/verify-installed-console-reconstruction\.mjs/);
  assert.match(pinnedReal, /if: \$\{\{ inputs\.vendor == 'hermes' \}\}/);
  assert.match(pinnedReal, /HERMES_LIVE: '1'/);
  assert.match(pinnedReal, /PUPPETEER_HERMES_BIN:/);
  assert.match(pinnedReal, /HERMES_PYTHON:/);
  assert.match(pinnedReal, /HERMES_TUI_DIR:/);
  assert.match(pinnedReal, /Hermes pinned-real native-TUI\/resume lane/);
  assert.match(pinnedReal, /@vibefield\/puppeteer-adapter-hermes test/);
  assert.doesNotMatch(pinnedReal, /\$AGENT_/);
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
