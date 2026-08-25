import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSupportBlock, validateSupportLedger } from './render-agent-support.mjs';

test('promoted support entries agree with Surface models and Imposter personas', () => {
  assert.deepEqual(validateSupportLedger().issues, []);
});

test('support badges are derived from promoted manifest versions', () => {
  const block = renderSupportBlock();
  assert.match(block, /Claude_Code-legacy_verified_2\.1\.207-orange/);
  assert.match(block, /Codex-legacy_verified_0\.147\.0-orange/);
  assert.match(block, /Grok_Build-baseline_pending_1\.0\.0-lightgrey/);
});
