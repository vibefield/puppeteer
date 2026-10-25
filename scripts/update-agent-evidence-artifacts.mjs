#!/usr/bin/env node
/** Merge a complete immutable acquisition report into an already traced candidate evidence index. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGroundTruthArtifacts } from '../packages/surface/scripts/groundtruth.mjs';
import { carriesUrlSecrets } from './acquire-agent-artifacts.mjs';
import { resolveCanonicalGroundTruth } from './agent-model-selection.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safePath(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

function plainHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !carriesUrlSecrets(parsed);
  } catch {
    return false;
  }
}

/**
 * The reviewed byte identity a platform already has, if any: an executable whose SHA-256 was verified when the
 * evidence was authored. A fixture corpus (it carries a `kind`) or a legacy entry without a digest is not one,
 * and acquisition replaces it.
 */
function reviewedArtifact(existing) {
  return existing &&
    existing.kind === undefined &&
    existing.integrity?.status === 'verified' &&
    /^sha256:[0-9a-f]{64}$/.test(existing.integrity.sha256 ?? '')
    ? existing
    : undefined;
}

export function mergeArtifactReport({ evidence, report, requiredPlatforms }) {
  if (
    evidence.evidenceVersion !== 2 ||
    !Array.isArray(evidence.claims) ||
    evidence.claims.length === 0 ||
    evidence.vendor !== report.vendor ||
    evidence.vendorVersion !== report.version
  ) {
    throw new Error('artifact merge requires an identity-matching, claim-addressable evidence v2 index');
  }
  if (report.status !== 'complete') throw new Error(`artifact report is ${report.status}, not complete`);
  const acquired = new Map(report.artifacts.map((artifact) => [artifact.platform, artifact]));
  const missing = requiredPlatforms.filter((platform) => !acquired.has(platform));
  if (missing.length > 0) throw new Error(`artifact report is missing: ${missing.join(', ')}`);
  const existingByPlatform = new Map((evidence.artifacts ?? []).map((artifact) => [artifact.platform, artifact]));
  const idByPlatform = new Map();
  evidence.artifacts = requiredPlatforms.map((platform) => {
    const artifact = acquired.get(platform);
    if (!/^sha256:[0-9a-f]{64}$/.test(artifact.sha256 ?? '')) throw new Error(`${platform} has no SHA-256`);
    // Acquisition refuses these, but a report written before it did may still carry a
    // signed redirect target, and evidence is tracked: re-check rather than trust.
    if (artifact.sourceUrl !== undefined && !plainHttpsUrl(artifact.sourceUrl)) {
      throw new Error(`${platform} artifact source URL is not a plain https URL`);
    }
    const existing = existingByPlatform.get(platform);
    const reviewed = reviewedArtifact(existing);
    // The claims on a reviewed artifact were captured on its bytes. Different bytes under the same version are
    // a republished artifact: an incident to quarantine, never an update that silently rebinds those claims.
    if (reviewed && reviewed.integrity.sha256 !== artifact.sha256) {
      throw new Error(
        `same-version artifact change for ${platform}: evidence reviewed ${reviewed.integrity.sha256}, but the ` +
          `acquisition holds ${artifact.sha256}; a republished artifact is an incident, not an update`,
      );
    }
    const id = existing?.id ?? `${evidence.vendor}-${evidence.vendorVersion}-${platform}`;
    idByPlatform.set(platform, id);
    if (reviewed) {
      // The same bytes again: keep the reviewed provenance (package, companions, and the first acquisition the
      // captures followed) and add only what this acquisition attests.
      return {
        ...reviewed,
        id,
        channel: reviewed.channel ?? 'stable',
        ...(artifact.artifactKind ? { artifactKind: artifact.artifactKind } : {}),
        acquiredAt: reviewed.acquiredAt ?? artifact.acquiredAt,
        versionOutput: reviewed.versionOutput ?? artifact.versionOutput,
        ...(artifact.sourceUrl ? { sourceUrl: artifact.sourceUrl } : {}),
        acquisitionKey: artifact.key,
        ...(artifact.identity ? { identity: artifact.identity } : {}),
        integrity: { status: 'verified', sha256: artifact.sha256 },
      };
    }
    return {
      id,
      platform,
      channel: 'stable',
      ...(artifact.artifactKind ? { artifactKind: artifact.artifactKind } : {}),
      acquiredAt: artifact.acquiredAt,
      versionOutput: artifact.versionOutput,
      ...(artifact.sourceUrl ? { sourceUrl: artifact.sourceUrl } : {}),
      acquisitionKey: artifact.key,
      ...(artifact.identity ? { identity: artifact.identity } : {}),
      integrity: { status: 'verified', sha256: artifact.sha256 },
    };
  });
  const oldArtifacts = new Map(
    (existingByPlatform.size ? [...existingByPlatform.values()] : []).map((item) => [item.id, item]),
  );
  for (const claim of evidence.claims) {
    if (!claim.artifact) continue;
    const old = oldArtifacts.get(claim.artifact);
    const platform = claim.platform ?? old?.platform;
    if (!platform || !idByPlatform.has(platform)) {
      throw new Error(`claim ${claim.id} artifact cannot be assigned to a required platform`);
    }
    claim.artifact = idByPlatform.get(platform);
  }
  return evidence;
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const groundTruthPath = safePath(flag('--ground-truth'));
  if (!existsSync(groundTruthPath)) throw new Error('candidate ground truth does not exist');
  const document = json(groundTruthPath);
  const manifest = document.manifest ?? {};
  if (document.format !== 'puppeteer-groundtruth/1') throw new Error('candidate is not canonical ground truth');
  resolveCanonicalGroundTruth({ repoRoot: root, vendor: manifest.vendor, groundTruthPath });
  const modelRoot = resolve(dirname(groundTruthPath), 'model', `${manifest.vendor}@${manifest.vendorVersion}`);
  const evidencePath = resolve(modelRoot, manifest.evidence ?? '');
  if (manifest.evidence !== 'evidence.json' || !existsSync(evidencePath))
    throw new Error('candidate has no evidence.json');
  const upstream = json(resolve(root, 'packages', 'surface', 'vendors', manifest.vendor, 'upstream.json'));
  const evidence = mergeArtifactReport({
    evidence: json(evidencePath),
    report: json(safePath(flag('--artifacts'))),
    requiredPlatforms: upstream.platforms,
  });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeGroundTruthArtifacts(modelRoot);
  console.log(`updated ${evidencePath} with ${evidence.artifacts.length} immutable artifact identities`);
}
