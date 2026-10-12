#!/usr/bin/env node
/** Run repository-owned promotion gates and bind them to platform reports plus the active GHA attempt. */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaimAddressableAsmVersion, loadModel } from '@vibefield/puppeteer-surface';
import { auditEvidence } from '../packages/surface/scripts/check-evidence.mjs';
import { resolveCanonicalGroundTruth } from './agent-model-selection.mjs';
import { replayAgentSurface } from './replay-agent-surface.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const REQUIRED_VERIFICATION_GATES = [
  'identity',
  'privacy',
  'model',
  'adapterFixtures',
  'imposter',
  'replayDiff',
  'hermetic',
  'pinnedArtifact',
  'platforms',
  'packaging',
  'documentation',
];

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safePath(repoRoot, path) {
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(`${resolve(repoRoot)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

export function validatePlatformReports({
  evidence,
  requiredPlatforms,
  reports,
  vendor,
  vendorVersion,
  expectedWorkflow,
}) {
  const issues = [];
  const artifacts = new Map((evidence.artifacts ?? []).map((artifact) => [artifact.platform, artifact]));
  const byPlatform = new Map();
  for (const report of reports) {
    if (byPlatform.has(report.platform)) issues.push(`duplicate platform report for ${report.platform}`);
    byPlatform.set(report.platform, report);
    if (!requiredPlatforms.includes(report.platform)) issues.push(`unexpected platform report for ${report.platform}`);
  }
  for (const platform of requiredPlatforms) {
    const report = byPlatform.get(platform);
    const artifact = artifacts.get(platform);
    if (!report) {
      issues.push(`missing platform report for ${platform}`);
      continue;
    }
    if (
      report.vendor !== vendor ||
      report.vendorVersion !== vendorVersion ||
      report.status !== 'passed' ||
      ['binaryVersion', 'surfaceAudit', 'adapterReal'].some((gate) => report.checks?.[gate] !== 'passed') ||
      artifact?.integrity?.status !== 'verified' ||
      report.artifactSha256 !== artifact?.integrity?.sha256
    ) {
      issues.push(`${platform} platform report does not match verified candidate evidence`);
    }
    if (
      expectedWorkflow &&
      (report.workflow?.repository !== expectedWorkflow.repository ||
        report.workflow?.runId !== expectedWorkflow.runId ||
        report.workflow?.runAttempt !== expectedWorkflow.runAttempt ||
        report.workflow?.sha !== expectedWorkflow.sha ||
        typeof report.workflow?.job !== 'string' ||
        !report.workflow.job)
    ) {
      issues.push(`${platform} platform report is not from this workflow attempt and commit`);
    }
  }
  return issues.sort();
}

function runGate(command, args, repoRoot) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  return {
    status: result.status === 0 ? 'passed' : 'failed',
    command: [command, ...args].join(' '),
    exitCode: result.status,
    detail:
      result.status === 0
        ? undefined
        : `${result.stderr || result.stdout || result.error?.message || 'command failed'}`.trim().slice(0, 4_000),
  };
}

export function verifyAgentSurface({
  repoRoot = root,
  vendor,
  groundTruthPath,
  platformReports = [],
  environment = process.env,
  runCommands = true,
} = {}) {
  const canonical = resolveCanonicalGroundTruth({ repoRoot, vendor, groundTruthPath });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const model = loadModel(canonical.groundTruthPath);
  const evidence = model.evidenceIndex;
  if (!evidence) throw new Error('verification candidate has no canonical evidence index');
  const upstream = json(join(repoRoot, 'packages', 'surface', 'vendors', vendor, 'upstream.json'));
  const reports = platformReports.map((path) => json(safePath(repoRoot, path)));
  const platformIssues = validatePlatformReports({
    evidence,
    requiredPlatforms: upstream.platforms,
    reports,
    vendor,
    vendorVersion: model.manifest.vendorVersion,
    expectedWorkflow:
      environment.GITHUB_ACTIONS === 'true'
        ? {
            repository: environment.GITHUB_REPOSITORY,
            runId: environment.GITHUB_RUN_ID,
            runAttempt: environment.GITHUB_RUN_ATTEMPT,
            sha: commit,
          }
        : undefined,
  });
  const evidenceIssues = auditEvidence({ root: repoRoot });
  const replay = replayAgentSurface({ repoRoot, vendor, groundTruthPath });
  const commandGates = runCommands
    ? {
        surface: runGate(
          'pnpm',
          ['--filter', '@vibefield/puppeteer-surface', 'run', `surface:audit:${vendor}`],
          repoRoot,
        ),
        adapter: runGate('pnpm', ['--filter', `@vibefield/puppeteer-adapter-${vendor}`, 'test'], repoRoot),
        imposter: runGate('pnpm', ['--filter', '@vibefield/puppeteer-imposter', 'test'], repoRoot),
        packages: runGate('pnpm', ['packages:check'], repoRoot),
        pack: runGate('pnpm', ['pack:check'], repoRoot),
        docs: runGate('pnpm', ['support:check'], repoRoot),
      }
    : {};
  const passed = (entry) => entry?.status === 'passed';
  const gates = {
    identity:
      isClaimAddressableAsmVersion(model.manifest.asmVersion) &&
      evidence.evidenceVersion === 2 &&
      evidenceIssues.length === 0
        ? 'passed'
        : 'failed',
    privacy: !runCommands || passed(commandGates.surface) ? 'passed' : 'failed',
    model: !runCommands || passed(commandGates.surface) ? 'passed' : 'failed',
    adapterFixtures: !runCommands || passed(commandGates.adapter) ? 'passed' : 'failed',
    imposter: !runCommands || passed(commandGates.imposter) ? 'passed' : 'failed',
    replayDiff: replay.status === 'passed' ? 'passed' : 'failed',
    hermetic: !runCommands || (passed(commandGates.adapter) && passed(commandGates.imposter)) ? 'passed' : 'failed',
    pinnedArtifact: platformIssues.length === 0 ? 'passed' : 'failed',
    platforms: platformIssues.length === 0 ? 'passed' : 'failed',
    packaging: !runCommands || (passed(commandGates.packages) && passed(commandGates.pack)) ? 'passed' : 'failed',
    documentation: !runCommands || passed(commandGates.docs) ? 'passed' : 'failed',
  };
  const modelDigest = evidence.records?.find((record) => record.kind === 'model-tree')?.sha256;
  const issues = [
    ...evidenceIssues.map((issue) => `evidence: ${issue}`),
    ...platformIssues,
    ...replay.issues.map((issue) => `replay: ${issue.location} ${issue.message}`),
    ...Object.entries(commandGates)
      .filter(([, result]) => result.status !== 'passed')
      .map(([name, result]) => `${name}: ${result.detail}`),
  ];
  return {
    schemaVersion: 1,
    vendor,
    vendorVersion: model.manifest.vendorVersion,
    groundTruth: canonical.groundTruthRelative,
    commit,
    status: REQUIRED_VERIFICATION_GATES.every((gate) => gates[gate] === 'passed') ? 'passed' : 'failed',
    gates,
    platformReports: reports.map((report) => ({ platform: report.platform, artifactSha256: report.artifactSha256 })),
    replayDigest: replay.replayDigest,
    commands: commandGates,
    issues,
    attestation: {
      provider: environment.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
      repository: environment.GITHUB_REPOSITORY ?? null,
      workflow: environment.GITHUB_WORKFLOW ?? null,
      workflowRef: environment.GITHUB_WORKFLOW_REF ?? null,
      runId: environment.GITHUB_RUN_ID ?? null,
      runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
      evidenceDigest: modelDigest ?? null,
    },
  };
}

function values(name) {
  const found = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) found.push(process.argv[index + 1]);
  }
  return found;
}

function flag(name) {
  return values(name).at(-1);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const report = verifyAgentSurface({
    vendor: flag('--vendor'),
    groundTruthPath: flag('--ground-truth'),
    platformReports: values('--platform-report'),
    runCommands: !process.argv.includes('--no-run'),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = flag('--output');
  if (output) writeFileSync(safePath(root, output), serialized);
  else process.stdout.write(serialized);
  if (report.status !== 'passed') process.exitCode = 1;
}
