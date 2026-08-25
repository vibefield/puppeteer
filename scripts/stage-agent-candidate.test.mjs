import assert from 'node:assert/strict';
import test from 'node:test';
import { stageCandidateDocuments } from './stage-agent-candidate.mjs';

test('staging changes only the candidate pointer and persona ASM projection', () => {
  const ledger = {
    agents: [
      {
        id: 'fake',
        status: 'legacy-verified',
        currentManifest: 'old/manifest.json',
        persona: 'fake',
      },
    ],
  };
  const persona = { id: 'fake', asm: { package: '@vibecook/chopsticks-surface', path: 'old' }, boot: [] };
  stageCandidateDocuments({
    ledger,
    persona,
    vendor: 'fake',
    manifestRelative: 'new/manifest.json',
    surfaceModelPath: 'vendors/fake/model/fake@2.0.0',
  });
  assert.deepEqual(ledger.agents[0], {
    id: 'fake',
    status: 'legacy-verified',
    currentManifest: 'old/manifest.json',
    candidateManifest: 'new/manifest.json',
    persona: 'fake',
  });
  assert.deepEqual(persona.asm, {
    package: '@vibecook/chopsticks-surface',
    path: 'vendors/fake/model/fake@2.0.0',
  });
});
