#!/usr/bin/env node
/** Merge a complete immutable acquisition report into an already traced candidate evidence index. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safePath(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
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
    const id = existingByPlatform.get(platform)?.id ?? `${evidence.vendor}-${evidence.vendorVersion}-${platform}`;
    idByPlatform.set(platform, id);
    return {
      id,
      platform,
      channel: 'stable',
      acquiredAt: artifact.acquiredAt,
      versionOutput: artifact.versionOutput,
      ...(artifact.sourceUrl ? { sourceUrl: artifact.sourceUrl } : {}),
      acquisitionKey: artifact.key,
      integrity: { status: 'verified', sha256: artifact.sha256 },
    };
  });
  const oldArtifacts = new Map((existingByPlatform.size ? [...existingByPlatform.values()] : []).map((item) => [item.id, item]));
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
  const manifestPath = safePath(flag('--manifest'));
  if (!existsSync(manifestPath)) throw new Error('candidate manifest does not exist');
  const manifest = json(manifestPath);
  const evidencePath = resolve(dirname(manifestPath), manifest.evidence ?? '');
  if (manifest.evidence !== 'evidence.json' || !existsSync(evidencePath)) throw new Error('candidate has no evidence.json');
  const upstream = json(resolve(root, 'packages', 'surface', 'vendors', manifest.vendor, 'upstream.json'));
  const evidence = mergeArtifactReport({
    evidence: json(evidencePath),
    report: json(safePath(flag('--artifacts'))),
    requiredPlatforms: upstream.platforms,
  });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`updated ${evidencePath} with ${evidence.artifacts.length} immutable artifact identities`);
}
