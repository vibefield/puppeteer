#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRosettaSurface } from '../../scripts/audit-rosetta-model.mjs';
import { copilotRules } from './privacy.mjs';

export function auditCopilot() {
  return auditRosettaSurface('copilot', copilotRules);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = auditCopilot();
  for (const note of result.notes) console.log(`  ${note}`);
  if (result.problems.length) {
    for (const problem of result.problems) console.error(problem);
    process.exit(1);
  }
  console.log('copilot Surface audit: clean');
}
