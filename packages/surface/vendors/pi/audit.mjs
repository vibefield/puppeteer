#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRosettaSurface } from '../../scripts/audit-rosetta-model.mjs';
import { piRules } from './privacy.mjs';

export function auditPi() {
  return auditRosettaSurface('pi', piRules);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = auditPi();
  for (const note of result.notes) console.log(`  ${note}`);
  if (result.problems.length) {
    for (const problem of result.problems) console.error(problem);
    process.exit(1);
  }
  console.log('pi Surface audit: clean');
}
