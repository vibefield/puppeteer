import assert from 'node:assert/strict';
import test from 'node:test';
import { stageCandidateDocuments } from './stage-agent-candidate.mjs';

test('staging changes only candidate version state and the stable persona projection', () => {
  const ledger = {
    agents: [
      {
        id: 'fake',
        status: 'legacy-verified',
        groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
        currentVersion: '1.0.0',
        persona: 'fake',
      },
    ],
  };
  const persona = { id: 'fake', asm: { package: '@vibefield/puppeteer-surface', path: 'old' }, boot: [] };
  stageCandidateDocuments({
    ledger,
    persona,
    vendor: 'fake',
    groundTruthRelative: 'packages/surface/vendors/fake/groundtruth.json',
    candidateVersion: '2.0.0',
  });
  assert.deepEqual(ledger.agents[0], {
    id: 'fake',
    status: 'legacy-verified',
    groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
    currentVersion: '1.0.0',
    candidateVersion: '2.0.0',
    persona: 'fake',
  });
  assert.deepEqual(persona.asm, {
    package: '@vibefield/puppeteer-surface',
    path: 'vendors/fake',
  });
});
