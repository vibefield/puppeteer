import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReconciliation, diffSurfaceModels } from './reconcile-agent-surface.mjs';

const clean = {
  added: [],
  removed: [],
  changed: [],
  behaviorChanged: false,
  channelsChanged: false,
  detectionChanged: false,
  baselineMissing: false,
};

test('classification is conservative and gives artifact incidents precedence', () => {
  assert.equal(
    classifyReconciliation({ artifactStatus: 'republished-artifact', replayStatus: 'failed', modelDiff: clean }),
    'republished-artifact',
  );
  assert.equal(
    classifyReconciliation({ artifactStatus: 'incomplete', replayStatus: 'passed', modelDiff: clean }),
    'unsafe-or-unknown',
  );
  assert.equal(
    classifyReconciliation({ artifactStatus: 'complete', replayStatus: 'failed', modelDiff: clean }),
    'unsafe-or-unknown',
  );
});

test('model diff treats confidence and transport contracts as semantic drift', () => {
  const event = {
    event: 'session/prompt',
    channel: 'acp',
    channels: ['acp'],
    transport: 'jsonrpc-request',
    direction: 'client-to-agent',
    payloadSchema: { type: 'object' },
    confidence: 'verified-headless',
    variants: [{ match: { mode: 'fast' }, confidence: 'verified-headless' }],
  };
  const behavior = {
    lanes: [{ id: 'agent', label: 'Agent' }],
    nodes: [{ id: 'prompt', event: 'session/prompt', confidence: 'verified-headless', lane: 'agent', order: 1 }],
    relations: [],
  };
  const current = {
    events: [event],
    behavior,
    channels: { channels: { acp: { kind: 'jsonrpc-stdio' } } },
    detection: { versionOutput: 'fake 1.0.0', versionPattern: '^fake', launchFlags: { serve: 'serve' } },
  };
  const candidate = structuredClone(current);
  candidate.events[0].confidence = 'unverified';
  candidate.events[0].variants[0].confidence = 'unverified';
  candidate.behavior.nodes[0].confidence = 'unverified';
  candidate.channels.channels.acp.kind = 'jsonrpc-socket';
  candidate.detection.versionOutput = 'fake 2.0.0';
  candidate.detection.launchFlags.serve = 'server';

  assert.deepEqual(diffSurfaceModels(current, candidate), {
    added: [],
    removed: [],
    changed: ['session/prompt'],
    behaviorChanged: true,
    channelsChanged: true,
    detectionChanged: true,
    baselineMissing: false,
  });
});

test('classification separates no drift, additive native surface, and semantic adaptation', () => {
  assert.equal(
    classifyReconciliation({ artifactStatus: 'complete', replayStatus: 'passed', modelDiff: clean }),
    'no-surface-drift',
  );
  assert.equal(
    classifyReconciliation({
      artifactStatus: 'complete',
      replayStatus: 'passed',
      modelDiff: { ...clean, added: ['new/event'] },
    }),
    'additive-unconsumed',
  );
  assert.equal(
    classifyReconciliation({
      artifactStatus: 'complete',
      replayStatus: 'passed',
      modelDiff: { ...clean, changed: ['turn/start'] },
    }),
    'adaptation-required',
  );
});
