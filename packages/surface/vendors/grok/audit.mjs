#!/usr/bin/env node
/** Repo-local audit for the selected Grok candidate surface. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { grokRules } from './privacy.mjs';

const selected = resolveAgentModel({ vendor: 'grok' });
const modelDir = selected.modelRoot;
const capturesDir = selected.capturesRoot;
const model = loadModel(modelDir);
const schemas = new Map(model.events.map((event) => [event.event, event.payloadSchema]));
const problems = [];
let checked = 0;

for (const file of readdirSync(capturesDir).filter((name) => name.endsWith('.jsonl'))) {
  for (const [index, line] of readFileSync(join(capturesDir, file), 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      problems.push(`${file}:${index + 1} is not valid JSON`);
      continue;
    }
    if (typeof message.method !== 'string') continue;
    if (!schemas.has(message.method)) {
      problems.push(`${file}:${index + 1} method "${message.method}" has no event document`);
      continue;
    }
    const schema = schemas.get(message.method);
    if (!schema || message.params === undefined) continue;
    const violations = validatePayload(schema, message.params);
    if (violations.length > 0) problems.push(`${file}:${index + 1} ${message.method}: ${violations.join('; ')}`);
    checked += 1;
  }
}

for (const leak of checkCaptureDirectory(capturesDir, grokRules)) problems.push(`privacy: ${leak}`);

const evidence = model.evidenceIndex;
if (!evidence) throw new Error('canonical ground truth has no evidence index');
for (const artifact of evidence.artifacts ?? []) {
  const label = artifact.id ?? artifact.platform ?? 'unnamed artifact';
  if (typeof artifact.versionOutput !== 'string' || !artifact.versionOutput.includes(selected.version)) {
    problems.push(`${label} version/revision identity drifted`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(artifact.integrity?.sha256 ?? '')) {
    problems.push(`${label} digest drifted`);
  }
}
if ((evidence.artifacts ?? []).length === 0) problems.push('artifact evidence is missing');
const unpublishedRevision = evidence.sourceReferences?.some(
  (entry) => entry.relation === 'binary-reported-revision-not-present-in-public-mirror',
);
const unpublishedLimitation = evidence.limitations?.some((entry) => entry.includes('absent from the public source mirror'));
if (unpublishedRevision && !unpublishedLimitation) {
  problems.push('unpublished source-revision limitation is missing');
}
if (!unpublishedRevision && unpublishedLimitation) problems.push('unpublished source-revision limitation is stale');

if (problems.length > 0) {
  console.error(`${problems.length} Grok surface problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`grok@${selected.version} surface audit: clean (${model.events.length} events, ${checked} payloads)`);
