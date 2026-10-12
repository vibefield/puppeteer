/** Shared audit for a Surface model generated from committed Rosetta evidence. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadModel, validateSanitizedPayload } from '@vibefield/puppeteer-surface';
import { checkCaptureDirectory } from '@vibefield/puppeteer-surface/sanitize';
import { resolveAgentModel } from '../../../scripts/agent-model-selection.mjs';
import { rosettaAgentConfig } from './rosetta-agents.mjs';
import { rosettaEventInventory } from './generate-rosetta-model.mjs';

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    })
    .sort();
}

export function auditRosettaSurface(vendor, rules) {
  const config = rosettaAgentConfig(vendor);
  const selected = resolveAgentModel({ vendor });
  const model = loadModel(selected.groundTruthPath);
  const referencePath = join(
    selected.vendorRoot,
    'references',
    `${vendor}@${config.version}`,
    'rosetta-groundtruth.json',
  );
  const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
  const expected = rosettaEventInventory(reference, config.primaryStream)
    .map((item) => item.event)
    .sort();
  const actual = model.events.map((event) => event.event).sort();
  const problems = [];
  const notes = [];
  if (selected.version !== config.version || model.manifest.vendorVersion !== config.version) {
    problems.push(`active identity is ${model.manifest.vendorVersion}; expected ${config.version}`);
  }
  if (
    reference.agent !== vendor ||
    reference.agent_version !== config.version ||
    reference.data_root !== config.dataRoot
  ) {
    problems.push('Rosetta reference identity or native data root drifted');
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    for (const event of expected.filter((value) => !actualSet.has(value)))
      problems.push(`missing modeled event ${event}`);
    for (const event of actual.filter((value) => !expectedSet.has(value)))
      problems.push(`unexpected modeled event ${event}`);
  }

  const primary = reference.streams.find((stream) => stream.id === config.primaryStream);
  const events = new Map(
    model.events.filter((event) => event.channel === config.primaryStream).map((event) => [event.event, event]),
  );
  let records = 0;
  for (const path of filesUnder(selected.capturesRoot).filter((candidate) => candidate.endsWith('.jsonl'))) {
    for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        problems.push(`${relative(selected.capturesRoot, path)}:${index + 1} is not valid JSON`);
        continue;
      }
      const type = record && typeof record === 'object' && !Array.isArray(record) ? record.type : undefined;
      if (typeof type !== 'string' || !primary?.record_types?.[type]) {
        problems.push(
          `${relative(selected.capturesRoot, path)}:${index + 1} has unknown ${config.primaryStream} type ${String(type)}`,
        );
        continue;
      }
      const event = events.get(type);
      if (!event?.recordSchema) problems.push(`${type} has no primary-stream record schema`);
      else {
        const violations = validateSanitizedPayload(event.recordSchema, record);
        if (violations.length)
          problems.push(`${relative(selected.capturesRoot, path)}:${index + 1} ${type}: ${violations.join('; ')}`);
      }
      records += 1;
    }
  }
  if (records === 0) problems.push(`no committed ${config.primaryStream} records`);
  for (const leak of checkCaptureDirectory(selected.capturesRoot, rules)) problems.push(`privacy: ${leak}`);
  if (!statSync(referencePath).isFile()) problems.push('Rosetta canonical reference is missing');
  notes.push(
    `${reference.streams.length} native streams, ${model.events.length} modeled events, ${records} primary journal records`,
  );
  notes.push('Only ordering observed in committed primary journals is promoted into behavior relations.');
  return { problems: problems.sort(), notes };
}
