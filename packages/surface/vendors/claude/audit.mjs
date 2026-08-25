#!/usr/bin/env node
/**
 * surface audit (draft/EMULATOR.md §7): diff the ASM model against the
 * captured surface. Clean exit means the model exactly covers the captures.
 *
 * Usage: node surface/audit.mjs [--write-report]
 * Requires node >= 22.18 (type stripping; on older 22.x use
 * `node --experimental-strip-types surface/audit.mjs`).
 *
 * The protected live workflow performs the upstream census. This local audit
 * intentionally checks only sanitized fixtures already in the repository.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, diffModelVsReport, loadModel } from '@vibecook/chopsticks-surface';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { checkCaptureDirectory } from './sanitize-captures.mjs';

const selected = resolveAgentModel({ vendor: 'claude' });
const model = loadModel(selected.modelRoot);
const captures = selected.capturesRoot;
const report = buildReport(captures, model);
const privacyIssues = checkCaptureDirectory(captures);

if (process.argv.includes('--write-report')) {
  const path = join(selected.surfaceRoot, 'vendors', 'claude', 'surface-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${path}`);
}

console.log(
  `model: ${model.events.length} events | captures: ${report.events.length} observed events, ` +
    `${report.events.reduce((sum, event) => sum + event.count, 0)} lines, ${report.unparsedLines} unparsed`,
);

const drift = diffModelVsReport(model, report);
if (drift.length === 0 && privacyIssues.length === 0) {
  console.log('audit clean: every capture parses and satisfies the model');
  process.exit(0);
}
for (const issue of privacyIssues) console.log(`[privacy] ${issue}`);
for (const entry of drift) {
  console.log(`[${entry.kind}] ${entry.event}: ${entry.message}`);
}
console.log(
  `${drift.length} drift entr${drift.length === 1 ? 'y' : 'ies'}, ${privacyIssues.length} privacy issue${privacyIssues.length === 1 ? '' : 's'}`,
);
process.exit(1);
