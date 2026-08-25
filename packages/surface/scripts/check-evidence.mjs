#!/usr/bin/env node
/** Validate and optionally refresh immutable tree digests in Surface evidence indexes. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [{ path, name: relative(root, path).split(sep).join('/') }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function digestTree(path, exclude = []) {
  const excluded = new Set(exclude);
  const hash = createHash('sha256');
  for (const file of filesUnder(path).filter((entry) => !excluded.has(entry.name))) {
    hash.update(file.name);
    hash.update('\0');
    hash.update(readFileSync(file.path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function evidencePaths(root = packageRoot) {
  const vendors = join(root, 'vendors');
  return readdirSync(vendors, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const models = join(vendors, entry.name, 'model');
      if (!existsSync(models)) return [];
      return readdirSync(models, { withFileTypes: true })
        .filter((model) => model.isDirectory() && existsSync(join(models, model.name, 'evidence.json')))
        .map((model) => join(models, model.name, 'evidence.json'));
    })
    .sort();
}

const SOURCE_RELATIONS = new Set([
  'release-tag',
  'exact-release',
  'binary-reported-revision-not-present-in-public-mirror',
  'public-mirror-commit',
]);
const CLAIM_KINDS = new Set([
  'runtime-capture',
  'binary-probe',
  'generated-schema',
  'exact-source',
  'official-doc',
  'inference',
]);
const CLAIM_CONFIDENCES = new Set(['verified-headless', 'verified-interactive', 'unverified']);

export function validateSourceReference(reference, label = 'source reference') {
  const issues = [];
  if (
    typeof reference?.repository !== 'string' ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(reference.repository)
  ) {
    issues.push(`${label}: repository must be an HTTPS GitHub repository`);
  }
  if (typeof reference?.revision !== 'string' || reference.revision.length === 0) {
    issues.push(`${label}: revision must be non-empty`);
  }
  if (!SOURCE_RELATIONS.has(reference?.relation)) {
    issues.push(`${label}: unsupported source relation ${String(reference?.relation)}`);
  } else if (reference.relation === 'public-mirror-commit') {
    if (!/^[0-9a-f]{40}$/.test(reference.revision ?? '')) {
      issues.push(`${label}: public mirror revision must be a full 40-character commit`);
    }
    if (!/^[0-9a-f]{40}$/.test(reference.sourceRevision ?? '')) {
      issues.push(`${label}: public mirror sourceRevision must be the full upstream SOURCE_REV`);
    }
  } else if (
    reference.relation === 'binary-reported-revision-not-present-in-public-mirror' &&
    !/^[0-9a-f]{7,40}$/.test(reference.revision ?? '')
  ) {
    issues.push(`${label}: binary-reported revision must be hexadecimal`);
  }
  return issues;
}

export function auditEvidence({ write = false, root = repoRoot } = {}) {
  const issues = [];
  for (const path of evidencePaths(join(root, 'packages', 'surface'))) {
    const index = JSON.parse(readFileSync(path, 'utf8'));
    const label = relative(root, path);
    if (![1, 2].includes(index.evidenceVersion)) issues.push(`${label}: evidenceVersion must be 1 or 2`);
    if (!index.vendor || !index.vendorVersion) issues.push(`${label}: missing vendor identity`);
    if (!Array.isArray(index.artifacts) || index.artifacts.length === 0) issues.push(`${label}: no artifact identity`);
    for (const artifact of index.artifacts ?? []) {
      if (artifact.integrity?.status === 'verified' && !/^sha256:[0-9a-f]{64}$/.test(artifact.integrity.sha256 ?? '')) {
        issues.push(`${label}: ${artifact.id} verified integrity has no SHA-256`);
      }
      if (!['verified', 'legacy-missing-digest'].includes(artifact.integrity?.status)) {
        issues.push(`${label}: ${artifact.id} has invalid integrity status`);
      }
    }
    if (!Array.isArray(index.sourceReferences) || index.sourceReferences.length === 0) {
      issues.push(`${label}: no immutable source reference`);
    }
    for (const [referenceIndex, reference] of (index.sourceReferences ?? []).entries()) {
      issues.push(...validateSourceReference(reference, `${label}: sourceReferences[${referenceIndex}]`));
    }
    const artifactIds = new Set((index.artifacts ?? []).map((artifact) => artifact.id));
    const recordIds = new Set((index.records ?? []).map((record) => record.id));
    if (index.evidenceVersion === 2) {
      if (!Array.isArray(index.claims) || index.claims.length === 0) issues.push(`${label}: v2 index has no claims`);
      const claimIds = new Set();
      for (const claim of index.claims ?? []) {
        const claimLabel = `${label}: claim ${String(claim.id)}`;
        if (typeof claim.id !== 'string' || claim.id.length === 0) issues.push(`${claimLabel}: id must be non-empty`);
        else if (claimIds.has(claim.id)) issues.push(`${claimLabel}: duplicate id`);
        else claimIds.add(claim.id);
        if (!CLAIM_KINDS.has(claim.kind)) issues.push(`${claimLabel}: unsupported kind ${String(claim.kind)}`);
        if (!CLAIM_CONFIDENCES.has(claim.confidence)) {
          issues.push(`${claimLabel}: unsupported confidence ${String(claim.confidence)}`);
        }
        if (claim.record !== undefined && !recordIds.has(claim.record)) {
          issues.push(`${claimLabel}: unknown record ${String(claim.record)}`);
        }
        if (claim.artifact !== undefined && !artifactIds.has(claim.artifact)) {
          issues.push(`${claimLabel}: unknown artifact ${String(claim.artifact)}`);
        }
        if (
          claim.sourceReference !== undefined &&
          (!Number.isInteger(claim.sourceReference) ||
            claim.sourceReference < 0 ||
            claim.sourceReference >= (index.sourceReferences?.length ?? 0))
        ) {
          issues.push(`${claimLabel}: invalid sourceReference`);
        }
        if (['runtime-capture', 'binary-probe'].includes(claim.kind)) {
          for (const field of ['record', 'artifact', 'platform', 'harness', 'capturedAt']) {
            if (!claim[field]) issues.push(`${claimLabel}: missing ${field}`);
          }
        }
      }
    }
    for (const record of index.records ?? []) {
      const absolute = resolve(root, record.path ?? '');
      if (
        !absolute.startsWith(`${resolve(root)}${sep}`) ||
        !existsSync(absolute) ||
        !statSync(absolute).isDirectory()
      ) {
        issues.push(`${label}: ${record.id} path is missing or outside the repository`);
        continue;
      }
      if (record.digestAlgorithm !== 'sha256-path-content-v1') {
        issues.push(`${label}: ${record.id} uses an unsupported digest algorithm`);
        continue;
      }
      const actual = digestTree(absolute, record.exclude ?? []);
      if (write) record.sha256 = actual;
      else if (record.sha256 !== actual)
        issues.push(`${label}: ${record.id} digest mismatch (run surface:evidence:write)`);
    }
    const manifest = JSON.parse(readFileSync(join(dirname(path), 'manifest.json'), 'utf8'));
    if (
      manifest.vendor !== index.vendor ||
      manifest.vendorVersion !== index.vendorVersion ||
      manifest.evidence !== 'evidence.json'
    ) {
      issues.push(`${label}: identity does not match its manifest`);
    }
    if (manifest.asmVersion === 2 && index.evidenceVersion !== 2) {
      issues.push(`${label}: ASM v2 requires evidenceVersion 2`);
    }
    if (write) writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
  }
  return issues.sort();
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const write = process.argv.includes('--write');
  const issues = auditEvidence({ write });
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }
  console.log(`surface evidence: ${write ? 'digests refreshed' : 'clean'} (${evidencePaths().length} indexes)`);
}
