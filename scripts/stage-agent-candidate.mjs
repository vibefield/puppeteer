#!/usr/bin/env node
/** Stage a candidate pointer and its Imposter projection without promoting support. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel } from '@vibecook/chopsticks-surface';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function insideRepo(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

export function stageCandidateDocuments({ ledger, persona, vendor, manifestRelative, surfaceModelPath }) {
  const agent = ledger.agents?.find((entry) => entry.id === vendor);
  if (!agent) throw new Error(`support ledger has no ${vendor} entry`);
  if (agent.currentManifest === manifestRelative) throw new Error('current support cannot also be staged as a candidate');
  agent.candidateManifest = manifestRelative;
  persona.asm = { package: '@vibecook/chopsticks-surface', path: surfaceModelPath };
  return { ledger, persona, agent };
}

export function stageAgentCandidate({ vendor, manifestPath }) {
  const manifestAbsolute = insideRepo(manifestPath);
  if (!existsSync(manifestAbsolute)) throw new Error(`candidate manifest does not exist: ${manifestPath}`);
  const model = loadModel(dirname(manifestAbsolute));
  if (model.manifest.vendor !== vendor) throw new Error('candidate vendor differs from --vendor');
  if (model.manifest.asmVersion !== 2) throw new Error('only a fully traced ASM v2 model may be staged');
  const manifestRelative = relative(root, manifestAbsolute).split(sep).join('/');
  if (
    !manifestRelative.startsWith(`packages/surface/vendors/${vendor}/model/${vendor}@`) ||
    !manifestRelative.endsWith('/manifest.json')
  ) {
    throw new Error('candidate manifest must be in the matching versioned Surface model directory');
  }
  const ledgerPath = resolve(root, 'support', 'agents.json');
  const ledgerText = readFileSync(ledgerPath, 'utf8');
  const ledger = JSON.parse(ledgerText);
  const agent = ledger.agents?.find((entry) => entry.id === vendor);
  if (!agent?.persona) throw new Error(`${vendor} has no Imposter persona`);
  const personaPath = resolve(root, 'packages', 'imposter', 'personas', agent.persona, 'persona.json');
  if (!existsSync(personaPath)) throw new Error(`${vendor} persona does not exist`);
  const personaText = readFileSync(personaPath, 'utf8');
  const persona = JSON.parse(personaText);
  const surfaceModelPath = relative(resolve(root, 'packages', 'surface'), dirname(manifestAbsolute))
    .split(sep)
    .join('/');
  stageCandidateDocuments({ ledger, persona, vendor, manifestRelative, surfaceModelPath });
  try {
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    writeFileSync(personaPath, `${JSON.stringify(persona, null, 2)}\n`);
  } catch (error) {
    writeFileSync(ledgerPath, ledgerText);
    writeFileSync(personaPath, personaText);
    throw error;
  }
  return { manifestRelative, personaPath: relative(root, personaPath).split(sep).join('/') };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = stageAgentCandidate({ vendor: flag('--vendor'), manifestPath: flag('--manifest') });
  console.log(`staged ${result.manifestRelative}; updated ${result.personaPath}; support remains unpromoted`);
}
