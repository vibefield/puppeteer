import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVersionOutput } from './probe-agent-artifact.mjs';

test('version probes require the exact requested version in one bounded line', () => {
  assert.equal(validateVersionOutput('codex-cli 0.147.0\n', '0.147.0'), 'codex-cli 0.147.0');
  assert.throws(() => validateVersionOutput('codex-cli 0.147.1', '0.147.0'), /does not identify/);
  assert.throws(() => validateVersionOutput('first\nsecond', '0.147.0'), /one bounded line/);
});
