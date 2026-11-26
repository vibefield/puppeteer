import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderSupportBlock, validateSupportLedger } from './render-agent-support.mjs';

test('promoted support entries agree with Surface models and Imposter personas', () => {
  assert.deepEqual(validateSupportLedger().issues, []);
});

// Expected badges come from the ledger itself, so a protected promotion (which moves a status and
// version) keeps this suite green instead of contradicting a pinned snapshot of today's ledger.
// Each status has a message colour for a light page and one for a dark page.
const COLORS = { verified: ['0a0a0a', 'e6eafb'], 'legacy-verified': ['b45309', 'f59e0b'] };
const OTHER = ['8a8a84', '565b73'];
const shield = (value) => value.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_');

test('support badges are derived from each entry’s status and version', () => {
  const block = renderSupportBlock();
  const { agents } = JSON.parse(readFileSync(new URL('../support/agents.json', import.meta.url), 'utf8'));
  for (const agent of agents) {
    const supported = agent.status in COLORS;
    const version = supported ? agent.currentVersion : agent.candidateVersion;
    const word = agent.status.replace(/-/g, ' ');
    const [label, message] = version ? [word, version] : ['support', word];
    for (const color of COLORS[agent.status] ?? OTHER) {
      const badge = `badge/${shield(label)}-${shield(message)}-${color}?`;
      assert.ok(block.includes(badge), `${agent.id}: missing ${badge}`);
    }
    assert.ok(block.includes(`<b>${agent.displayName}</b>`), `${agent.id}: missing its name`);
    assert.ok(block.includes(`alt="${agent.displayName}: ${[word, version].filter(Boolean).join(' ')}"`));
    assert.ok(block.includes(`<a href="${version ? agent.groundTruth : 'support/agents.json'}">`));
  }
});

test('the support grid has three columns in every row', () => {
  const block = renderSupportBlock();
  const rows = block.split('<tr>').slice(1);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.split('<td').length - 1, 3);
});

test('a verified entry renders its promoted version in the page’s ink', () => {
  const { agents } = JSON.parse(readFileSync(new URL('../support/agents.json', import.meta.url), 'utf8'));
  const block = renderSupportBlock();
  // A grandfathered baseline stays amber until a protected promotion.
  for (const agent of agents.filter((entry) => entry.status === 'legacy-verified')) {
    assert.match(block, new RegExp(`badge/legacy_verified-${agent.currentVersion.replace(/\./g, '\\.')}-b45309\\?`));
  }
  for (const agent of agents.filter((entry) => entry.status === 'verified')) {
    assert.match(block, new RegExp(`badge/verified-${agent.currentVersion.replace(/\./g, '\\.')}-0a0a0a\\?`));
  }
});
