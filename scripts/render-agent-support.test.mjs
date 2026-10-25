import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderSupportBlock, validateSupportLedger } from './render-agent-support.mjs';

test('promoted support entries agree with Surface models and Imposter personas', () => {
  assert.deepEqual(validateSupportLedger().issues, []);
});

// Expected badges come from the ledger itself, so a protected promotion (which moves a status and
// version) keeps this suite green instead of contradicting a pinned snapshot of today's ledger.
const COLORS = { verified: 'blue', 'legacy-verified': 'orange' };
const shield = (value) => value.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_');

test('support badges are derived from each entry’s status and version', () => {
  const block = renderSupportBlock();
  const { agents } = JSON.parse(readFileSync(new URL('../support/agents.json', import.meta.url), 'utf8'));
  for (const agent of agents) {
    const supported = agent.status in COLORS;
    const version = supported ? agent.currentVersion : agent.candidateVersion;
    const message = [agent.status.replace(/-/g, ' '), version].filter(Boolean).join(' ');
    const badge = `badge/${shield(agent.displayName)}-${shield(message)}-${COLORS[agent.status] ?? 'lightgrey'}`;
    assert.ok(block.includes(badge), `${agent.id}: missing ${badge}`);
    assert.ok(block.includes(`](${supported || agent.candidateVersion ? agent.groundTruth : 'support/agents.json'})`));
  }
});

test('a verified entry renders its promoted version in blue', () => {
  const { agents } = JSON.parse(readFileSync(new URL('../support/agents.json', import.meta.url), 'utf8'));
  const block = renderSupportBlock();
  // Today's ledger keeps Claude and Codex on their grandfathered baselines until a protected promotion.
  for (const agent of agents.filter((entry) => entry.status === 'legacy-verified')) {
    assert.match(block, new RegExp(`-legacy_verified_${agent.currentVersion.replace(/\./g, '\\.')}-orange`));
  }
  for (const agent of agents.filter((entry) => entry.status === 'verified')) {
    assert.match(block, new RegExp(`-verified_${agent.currentVersion.replace(/\./g, '\\.')}-blue`));
  }
});
