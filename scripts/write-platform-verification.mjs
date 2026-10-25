#!/usr/bin/env node
/** Emit one platform's immutable real-artifact result after its workflow steps pass. */
import { spawnSync } from 'node:child_process';
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
  if (typeof path !== 'string' || !path) throw new Error('repository path is required');
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

/** An x64 process on Apple silicon runs under Rosetta: it is not on a darwin-x64 machine. */
function runningTranslated() {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === '1';
}

/**
 * The promotion platform this process actually runs on, or undefined when it is none of them. A lane's
 * report names its platform from the workflow matrix; this is what keeps a mislabeled runner from attesting
 * a platform it is not.
 */
export function hostPlatform({ platform = process.platform, arch = process.arch, translated } = {}) {
  const system = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  if (!system || !['arm64', 'x64'].includes(arch)) return undefined;
  if (translated ?? (platform === process.platform && runningTranslated())) return undefined;
  return `${system}-${arch}`;
}

export function platformVerification({
  artifactReport,
  platform,
  artifactSha256,
  actualVersionOutput,
  adapterReceipt,
  checks,
  host = hostPlatform(),
  environment = process.env,
}) {
  const artifact = artifactReport.artifacts?.find((entry) => entry.platform === platform);
  if (!artifact) throw new Error(`artifact report has no ${platform}`);
  const required = ['binaryVersion', 'hostPlatform', 'surfaceAudit', 'adapterReal'];
  const boundedVersion = typeof actualVersionOutput === 'string' ? actualVersionOutput.trim() : '';
  const binaryPassed =
    artifactSha256 === artifact.sha256 &&
    boundedVersion.length > 0 &&
    boundedVersion.length <= 256 &&
    !/[\r\n]/.test(boundedVersion) &&
    boundedVersion === artifact.versionOutput;
  const adapterPassed =
    adapterReceipt?.schemaVersion === 1 &&
    adapterReceipt.check === 'adapter-real' &&
    adapterReceipt.vendor === artifactReport.vendor &&
    adapterReceipt.platform === platform &&
    adapterReceipt.artifactSha256 === artifactSha256 &&
    typeof adapterReceipt.testId === 'string' &&
    /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/.test(adapterReceipt.testId) &&
    adapterReceipt.testId.startsWith(`${artifactReport.vendor}:`);
  const resolvedChecks = {
    ...checks,
    binaryVersion: binaryPassed ? 'passed' : 'failed',
    hostPlatform: host === platform ? 'passed' : 'failed',
    adapterReal: adapterPassed ? 'passed' : 'failed',
  };
  const missing = required.filter((gate) => resolvedChecks?.[gate] !== 'passed');
  return {
    schemaVersion: 1,
    vendor: artifactReport.vendor,
    vendorVersion: artifactReport.version,
    platform,
    host: host ?? null,
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
  const adapterReceipt = JSON.parse(readFileSync(safePath(flag('--adapter-receipt')), 'utf8'));
  const report = platformVerification({
    artifactReport,
    platform: flag('--platform'),
    artifactSha256,
    actualVersionOutput,
    adapterReceipt,
    checks: {
      surfaceAudit: flag('--surface-audit') === 'passed' ? 'passed' : 'failed',
    },
  });
  writeFileSync(safePath(flag('--output')), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}
