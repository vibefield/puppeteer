// Validate the captured native responses and write the bounded investigation report.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { command, clean, evidenceDir } from './probe.mjs';

const repo = resolve(evidenceDir, '../../..');
const load = async name => JSON.parse(await readFile(join(evidenceDir, 'results', name + '.json'), 'utf8'));
const specs = [
  ['claude', 'claude', 'stream-json initialize', 'structured', 'per-model supportedEffortLevels'],
  ['codex', 'codex', 'app-server model/list', 'structured', 'per-model supportedReasoningEfforts and defaultReasoningEffort'],
  ['copilot', 'copilot', 'SDK models.list over Content-Length JSON-RPC', 'structured', 'per-model supportedReasoningEfforts where present'],
  ['grok', 'grok', 'grok models', 'text', 'not enumerated by this command'],
  ['kimi', 'kimi', 'kimi provider list --json', 'structured', 'thinking capability; no per-model effort enum in this response'],
  ['opencode', 'opencode', 'serve --pure, GET /provider, filter connected', 'structured', 'per-model native variant IDs'],
  ['hermes', 'hermes', 'native inventory helper; model.options RPC also verified', 'structured', 'capability hints only; helper deliberately omits supported_efforts'],
  ['antigravity', 'agy', 'agy models', 'tab-separated text', 'named variants; separate per-model effort enum not exposed'],
  ['pi', 'pi', 'RPC get_available_models', 'structured', 'thinkingLevelMap; per-model get_available_thinking_levels verified'],
];

const notes = {
  claude: [
    'Five picker choices include both default and opus resolving to the same model: count choices, not distinct underlying models.',
    'Native default alias is not an instruction to inherit a saved profile setting. Inherit by omitting the override.',
    'Catalog reflects native settings/policy. Returned choices do not prove inference entitlement.',
  ],
  codex: ['All pages consumed; no thread/start or turn/start sent. The Puppeteer typed launch options currently lack effort.'],
  copilot: ['Used the existing native login. A sandboxed run incorrectly appeared unauthenticated; normal native access returned 17 choices.', 'auto and models with no effort metadata must not acquire fabricated effort choices.'],
  grok: ['A sandboxed run returned a stale two-model fallback with a settings-fetch warning; normal access returned four models and no warning.', 'Explicit models command output is parsed; no interactive terminal screen scraping.', 'ACP initialize succeeded but returned no top-level model catalog. No Grok ACP session was created.'],
  kimi: ['This is the configured-model catalog, not an exhaustive account entitlement list.', 'Installed 2.0.2 is much newer than the repository support candidate 0.34.0; this does not validate the older release.'],
  opencode: ['Only connected providers belong in an immediately selectable picker.', 'The probe disables external plugins with --pure; plugin-provided models were not exercised.', 'Provider options/authentication documents were not persisted.'],
  hermes: ['The real profile helper returned 19 choices across moa, copilot, and copilot-acp. Native stdio model.options returned 19 in a temporary HERMES_HOME.', 'Native inventory uses cache/fallback data and credential-presence hints; its authenticated flag is not proof of a successful inference request.', 'The helper defaults reasoning capability to true when metadata is missing; this is not an authoritative effort enum.', 'The Puppeteer typed launch options currently expose neither model nor effort.'],
  antigravity: ['Treat native model IDs as opaque; do not derive independent effort compatibility by splitting the ID.', 'agy --print /model --output-format json returned the CURRENT selection, not the model list. It reported num_turns=0 and total_tokens=0.'],
  pi: ['Used --offline, disabled extensions/skills/tools/context loading, and queried native configured availability.', 'Per-model thinking queries used a temporary profile containing the captured metadata including thinkingLevelMap and dummy auth; no inference.', 'The real saved default model was not changed.'],
};

const ledger = JSON.parse(await readFile(join(repo, 'support/agents.json'), 'utf8'));
const rows = [];
for (const [id, executable, route, format, effort] of specs) {
  const result = await load(id);
  assert.equal(result.error, undefined, `${id}: ${result.error}`);
  if ('code' in result) assert.equal(result.code, 0, `${id}: nonzero exit`);
  let models = result.models;
  if (id === 'grok') {
    models = result.output.split('\n').flatMap(line => {
      const match = line.match(/^\s*[*-]\s+(\S+)(?:\s+\(default\))?\s*$/);
      return match ? [{ id: match[1] }] : [];
    });
  }
  if (id === 'antigravity') {
    models = result.output.trim().split('\n').map(line => {
      const match = line.match(/^([^\t]+)\t(.+)$/);
      assert.ok(match, 'Antigravity list must remain two columns');
      return { id: match[1], name: match[2] };
    });
  }
  assert.ok(Array.isArray(models) && models.length > 0, id + ': empty catalog');
  const identities = models.map(m => [m.provider ?? m.providerID ?? '', m.id ?? m.value ?? m.modelId ?? m.model]);
  assert.ok(identities.every(([, model]) => typeof model === 'string' && model.length > 0), id + ': missing model identity');
  assert.equal(new Set(identities.map(v => JSON.stringify(v))).size, identities.length, id + ': duplicate native choice');
  if (id === 'codex') assert.equal(result.complete, true, 'Codex pagination incomplete');
  if (id === 'opencode') assert.ok(models.every(m => result.connected.includes(m.providerID)), 'Disconnected OpenCode choices leaked');
  const version = await command(executable, ['--version'], repo);
  assert.equal(version.code, 0, id + ': version query failed');
  const support = ledger.agents.find(agent => agent.id === id);
  rows.push({
    id, versionOutput: clean(version.stdout).trim(), verdict: 'native-discovery-verified', route, format,
    choiceCount: models.length, effort, observedAt: result.observedAt, evidence: `results/${id}.json`,
    repositorySupport: { status: support.status, currentVersion: support.currentVersion, candidateVersion: support.candidateVersion },
    notes: notes[id],
  });
}

const pi = await load('pi');
const piEfforts = await load('pi_efforts');
assert.equal(piEfforts.error, undefined);
assert.equal(piEfforts.models.length, pi.models.length);
for (const model of pi.models) {
  const probed = piEfforts.models.find(m => m.provider === model.provider && m.id === model.id);
  assert.ok(probed?.supportedThinkingLevels?.length, 'Pi missing per-model thinking levels');
  const advertised = Object.entries(model.thinkingLevelMap).filter(([, native]) => native !== null).map(([level]) => level);
  assert.deepEqual(probed.supportedThinkingLevels, advertised, 'Pi native query disagrees with metadata map');
}
const hermesRpc = await load('hermes_rpc');
assert.equal(hermesRpc.error, undefined);
assert.ok(hermesRpc.models.length > 0, 'Hermes RPC returned no models');
const antigravity = await load('antigravity_json');
assert.equal(antigravity.response.status, 'SUCCESS');
assert.equal(antigravity.response.num_turns, 0);
assert.equal(antigravity.response.usage.total_tokens, 0);

const acp = await load('acp');
assert.equal(acp.error, undefined);
assert.equal(acp.protocolVersion, 1);
assert.ok(!acp.initializeKeys.includes('configOptions'));
const acpModel = acp.configOptions.find(option => option.category === 'model');
const acpThinking = acp.configOptions.find(option => option.category === 'thought_level');
assert.equal(acpModel.options.length, 1);
assert.deepEqual(acpThinking.options.map(option => option.value), ['off', 'on']);
const opencode = await load('opencode');
const commit = await command('git', ['rev-parse', 'HEAD'], repo);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(), platform: process.platform + '-' + process.arch,
  repositoryCommit: commit.stdout.trim(),
  scope: 'Native model/effort metadata discovery for nine builtin executables and one ACP implementation. No inference prompts were sent.',
  verdict: 'All nine installed native agents have a working model discovery route. Generic ACP discovery is session-dependent and optional.',
  limitation: 'This proves discovery on the installed versions and tested profiles, not successful inference for every model, end-to-end Puppeteer integration, or promotion of repository support baselines.',
  agents: rows,
  acp: {
    verdict: 'conditional', server: acp.server,
    route: 'initialize then session/new; no session/prompt',
    evidence: 'results/acp.json',
    observedModelChoices: acpModel.options.length,
    thinkingChoices: acpThinking.options.map(option => option.value),
    notes: ['The observed server returns configOptions only after creating a session.', 'The configured probe model was synthetic and isolated, so this tests protocol behavior, not account access.', 'ACP permits servers to omit configOptions; do not promise universal prelaunch discovery.'],
  },
  importantBoundaries: {
    opencode: { catalogProviderCount: opencode.providers.length, allCatalogModelCount: opencode.allCatalogModelCount, connectedProviders: opencode.connected, selectableCatalogCount: opencode.models.length },
    piThinkingByModel: piEfforts.models,
    antigravityCurrentSelection: antigravity.response.command.data,
  },
  recommendedQ1Solution: [
    'Add an asynchronous, adapter-owned discovery service scoped to executable/version, profile, cwd, and effective configuration.',
    'Use native structured catalogs first. For Grok and Antigravity, use their explicit model-list utility with version-tested parsers.',
    'Return choices with opaque native IDs, display labels, source/freshness, availability status, completeness, and optional per-model controls.',
    'Preserve per-model effort/variant domains. Missing metadata must not become a fabricated universal effort list.',
    'Distinguish connected/configured choices from an unconfigured catalog and from cached suggestions.',
    'Represent inherit-agent-settings by omission, separately from a native model ID named default.',
    'For ACP, advertise requiresSession/unsupported explicitly; obtain configOptions during a prepared session where the backend supports it.',
    'Translate and validate public launch selections inside the adapter/runtime, retaining private provider-native options.',
    'Expose stale/auth-required/error outcomes without turning failures into successful empty catalogs. Allow custom IDs only when supported by that adapter.',
    'Wire the missing launch controls (notably Codex effort and Hermes model/effort) and verify launch application separately before claiming PJ-6 end-to-end support.',
  ],
  validation: { nativeCatalogs: 9, acpImplementations: 1, nonemptyUniqueIdentities: true, codexPaginationComplete: true, opencodeConnectedFilter: true, piThinkingMapMatchesNativeQueries: true, hermesNativeRpc: true, antigravityCurrentModelCommandZeroTurns: true },
  sources: [
    'https://learn.chatgpt.com/docs/app-server#list-models-modellist',
    'https://code.claude.com/docs/en/model-config',
    'https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/src/client.ts',
    'https://opencode.ai/docs/server/',
    'https://agentclientprotocol.com/protocol/v1/session-config-options',
    'https://antigravity.google/docs/cli/headless/',
    'Installed native CLI help and the installed Hermes/Pi implementation source',
  ],
  reproduce: [
    'node draft/artifacts/model-discovery-2026-10-12/probe.mjs',
    'node draft/artifacts/model-discovery-2026-10-12/probe-extra.mjs',
    'node draft/artifacts/model-discovery-2026-10-12/summarize.mjs',
  ],
};
await writeFile(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ verdict: report.verdict, agents: rows.map(r => ({ id: r.id, version: r.versionOutput.split('\n')[0], count: r.choiceCount })), validation: report.validation }, null, 2));
