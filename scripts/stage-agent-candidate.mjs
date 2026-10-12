#!/usr/bin/env node
/** Stage the version in an agent's stable ground-truth file without promoting support. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaimAddressableAsmVersion, loadModel } from '@vibefield/puppeteer-surface';
import { resolveCanonicalGroundTruth } from './agent-model-selection.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function stageCandidateDocuments({ ledger, persona, vendor, groundTruthRelative, candidateVersion }) {
  const agent = ledger.agents?.find((entry) => entry.id === vendor);
  if (!agent) throw new Error(`support ledger has no ${vendor} entry`);
  if (agent.groundTruth && agent.groundTruth !== groundTruthRelative) {
    throw new Error(`${vendor} already declares a different canonical ground-truth path`);
  }
  if (agent.currentVersion === candidateVersion)
    throw new Error('current support cannot also be staged as a candidate');
  agent.groundTruth = groundTruthRelative;
  agent.candidateVersion = candidateVersion;
  persona.asm = { package: '@vibefield/puppeteer-surface', path: `vendors/${vendor}` };
  return { ledger, persona, agent };
}

export function stageAgentCandidate({ vendor, groundTruthPath }) {
  const canonical = resolveCanonicalGroundTruth({ repoRoot: root, vendor, groundTruthPath });
  const model = loadModel(canonical.groundTruthPath);
  if (!isClaimAddressableAsmVersion(model.manifest.asmVersion)) {
    throw new Error('only a fully traced, claim-addressable ASM model may be staged');
  }
  const { groundTruthRelative } = canonical;
  const ledgerPath = resolve(root, 'support', 'agents.json');
  const ledgerText = readFileSync(ledgerPath, 'utf8');
  const ledger = JSON.parse(ledgerText);
  const agent = ledger.agents?.find((entry) => entry.id === vendor);
  if (!agent?.persona) throw new Error(`${vendor} has no Imposter persona`);
  const personaPath = resolve(root, 'packages', 'imposter', 'personas', agent.persona, 'persona.json');
  if (!existsSync(personaPath)) throw new Error(`${vendor} persona does not exist`);
  const personaText = readFileSync(personaPath, 'utf8');
  const persona = JSON.parse(personaText);
  stageCandidateDocuments({
    ledger,
    persona,
    vendor,
    groundTruthRelative,
    candidateVersion: model.manifest.vendorVersion,
  });
  try {
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    writeFileSync(personaPath, `${JSON.stringify(persona, null, 2)}\n`);
  } catch (error) {
    writeFileSync(ledgerPath, ledgerText);
    writeFileSync(personaPath, personaText);
    throw error;
  }
  return { groundTruthRelative, personaPath: relative(root, personaPath).split(sep).join('/') };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = stageAgentCandidate({ vendor: flag('--vendor'), groundTruthPath: flag('--ground-truth') });
  console.log(`staged ${result.groundTruthRelative}; updated ${result.personaPath}; support remains unpromoted`);
}
