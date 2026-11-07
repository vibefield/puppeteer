/** Semantic consistency gate for GV-AUDIT3 row envelopes. Not a regex-only PENDING scan. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const filled = JSON.parse(readFileSync(join(root, 'audit/godview/plan/gv-audit3-join.json'), 'utf8'));
const stateIds = [...new Set(filled.stateReachability.map((state) => state.stateId))].sort((a, b) => b.length - a.length);
const stale = /PENDING DOWNSTREAM|uiReachable stay unknown|mapping is pending|stay unknown/iu;
const failures = [];

function negated(text) {
  const found = new Set();
  const listed = text.match(/Not claimed, and not listed as applicable: ([^.]+)\./u);
  if (listed) {
    for (const part of listed[1].split(',')) {
      const id = part.trim();
      if (id.startsWith('state.')) found.add(id);
    }
  }
  for (const id of stateIds) {
    if (new RegExp(String.raw`(?<![\w.])not ${id}(?![\w.])`, 'u').test(text)) found.add(id);
  }
  return found;
}

if (filled.rowJoins.length !== 370) failures.push(`row joins ${filled.rowJoins.length}`);
if (filled.stateReachability.length !== 410) failures.push(`states ${filled.stateReachability.length}`);
const rowIds = new Set(filled.rowJoins.map((row) => row.fieldId));
if (rowIds.size !== 74 || [...rowIds].some((id) => id.startsWith('field.contract.'))) {
  failures.push('row id set is not the 74 canonical fields');
}

for (const row of filled.rowJoins) {
  const adapter = row.adapterId.slice('adapter.'.length);
  const record = JSON.parse(
    readFileSync(join(root, 'audit/godview/evidence', adapter, `${row.fieldId.slice('field.'.length)}.json`), 'utf8'),
  );
  const notes = record.verification.notes;
  if (notes !== record.applicability.notes) failures.push(`${record.recordId} notes diverge`);
  if (record.classification.uiReachable === 'yes' && stale.test(notes)) {
    failures.push(`${record.recordId} uiReachable yes contradicts stale unknown or pending text`);
  }
  if (
    record.classification.adapterEmittable === 'yes' &&
    notes.includes('Current producers do not produce this row field')
  ) {
    failures.push(`${record.recordId} emittable yes but notes deny production`);
  }
  if (
    record.classification.adapterEmittable === 'no' &&
    notes.includes('The traced source path can produce this row field')
  ) {
    failures.push(`${record.recordId} emittable no but notes claim production`);
  }
  const claimed = Array.isArray(record.applicability.states) ? new Set(record.applicability.states) : new Set();
  for (const id of negated(notes)) {
    if (claimed.has(id)) failures.push(`${record.recordId} lists negated ${id}`);
  }
  const applicable = new Set((row.stateReachability ?? []).filter((item) => item.applicable).map((item) => item.stateId));
  if (Array.isArray(record.applicability.states) && [...claimed].sort().join() !== [...applicable].sort().join()) {
    failures.push(`${record.recordId} applicability does not match stateReachability`);
  }
  if (record.pins.puppeteer !== '748d015a7e393112e0a91dad80111fdf5abe6583') {
    failures.push(`${record.recordId} pin`);
  }
  if (record.classification.uiReachable === 'yes' && row.rendererRead !== 'direct') {
    failures.push(`${record.recordId} uiReachable yes without a direct reader`);
  }
  if (
    record.classification.uiReachable === 'yes' &&
    record.classification.adapterEmittable === 'no' &&
    !row.alternateProducer
  ) {
    failures.push(`${record.recordId} uiReachable yes from a reader with no alternate producer`);
  }
  if (record.classification.uiReachable === 'yes' && row.adapterPathProvidesValue === 'no' && !row.alternateProducer) {
    failures.push(`${record.recordId} uiReachable yes although the adapter path provides no value`);
  }
  const graph = readFileSync(
    join(root, 'audit/godview/evidence', adapter, `${row.fieldId.slice('field.'.length)}.mmd`),
    'utf8',
  );
  if (row.fieldId === 'field.status' && /priceUsageUpdates|usage-pricing/.test(graph)) {
    failures.push(`${record.recordId} status graph includes a cost pricing step`);
  }
  if (
    ['acp', 'antigravity', 'copilot'].includes(adapter) &&
    row.fieldId.startsWith('field.cost') &&
    record.transforms.some((item) => item.name === 'price-before-reduce' || item.source.path.endsWith('usage-pricing.ts'))
  ) {
    failures.push(`${record.recordId} invents a pricing hop through an omitted usage signal`);
  }
  for (const item of record.transforms) {
    if (/monitor-capabilities\.ts$/.test(item.source.path) && /handler|reads used and size|does not emit/.test(item.effect)) {
      failures.push(`${record.recordId} transform effect is paired with a capability declaration`);
    }
  }
  if (record.transport.name === 'not-applicable' && !(row.notApplicableReason && row.notApplicableReason.length > 12)) {
    failures.push(`${record.recordId} not-applicable transport lacks notApplicableReason`);
  }
}

console.log(JSON.stringify({ contradictions: failures.length, failures: failures.slice(0, 20) }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
