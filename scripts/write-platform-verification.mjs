#!/usr/bin/env node
/** Emit one platform's immutable real-artifact result after its workflow steps pass. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safePath(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

export function platformVerification({
  artifactReport,
  platform,
  artifactSha256,
  actualVersionOutput,
  checks,
  environment = process.env,
}) {
  const artifact = artifactReport.artifacts?.find((entry) => entry.platform === platform);
  if (!artifact) throw new Error(`artifact report has no ${platform}`);
  const required = ['binaryVersion', 'surfaceAudit', 'adapterReal'];
  const boundedVersion = typeof actualVersionOutput === 'string' ? actualVersionOutput.trim() : '';
  const binaryPassed =
    artifactSha256 === artifact.sha256 &&
    boundedVersion.length > 0 &&
    boundedVersion.length <= 256 &&
    !/[\r\n]/.test(boundedVersion) &&
    boundedVersion === artifact.versionOutput;
  const resolvedChecks = { ...checks, binaryVersion: binaryPassed ? 'passed' : 'failed' };
  const missing = required.filter((gate) => resolvedChecks?.[gate] !== 'passed');
  return {
    schemaVersion: 1,
    vendor: artifactReport.vendor,
    vendorVersion: artifactReport.version,
    platform,
    artifactSha256: artifactSha256 ?? null,
    versionOutput: boundedVersion,
    status: missing.length === 0 ? 'passed' : 'failed',
    checks: Object.fromEntries(required.map((gate) => [gate, resolvedChecks?.[gate] ?? 'failed'])),
    workflow: {
      repository: environment.GITHUB_REPOSITORY ?? null,
      runId: environment.GITHUB_RUN_ID ?? null,
      runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
      job: environment.GITHUB_JOB ?? null,
      sha: environment.GITHUB_SHA ?? null,
    },
    issues: missing.map((gate) => `${gate} did not pass`),
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const artifactReport = JSON.parse(readFileSync(safePath(flag('--artifacts')), 'utf8'));
  const artifactBytes = readFileSync(safePath(flag('--artifact')));
  const artifactSha256 = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;
  const actualVersionOutput = readFileSync(safePath(flag('--version-output-file')), 'utf8').trim();
  const report = platformVerification({
    artifactReport,
    platform: flag('--platform'),
    artifactSha256,
    actualVersionOutput,
    checks: {
      surfaceAudit: flag('--surface-audit') === 'passed' ? 'passed' : 'failed',
      adapterReal: flag('--adapter-real') === 'passed' ? 'passed' : 'failed',
    },
  });
  writeFileSync(safePath(flag('--output')), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}
