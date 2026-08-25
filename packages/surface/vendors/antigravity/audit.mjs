#!/usr/bin/env node
/** Audit the authentication-independent Antigravity Surface bootstrap. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_FLAGS,
  REQUIRED_PLATFORMS,
  REQUIRED_SUBCOMMANDS,
  VERSION,
  validateReleaseContract,
} from './census/harness.mjs';
import { checkCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { AUTHORIZED_SCENARIOS } from './census/authorized-census.mjs';
import {
  REQUIRED_SUBCOMMAND_HELP,
  STATIC_STRING_CANDIDATES,
  validateDocumentationReference,
} from './census/documentation.mjs';
import { antigravityRules } from './privacy.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const probesRoot = join(vendorRoot, 'probes', `antigravity@${VERSION}`);
const reference = JSON.parse(
  readFileSync(join(vendorRoot, 'references', `antigravity@${VERSION}`, 'release.json'), 'utf8'),
);
const documentation = JSON.parse(
  readFileSync(join(vendorRoot, 'references', `antigravity@${VERSION}`, 'docs.json'), 'utf8'),
);
const upstream = JSON.parse(readFileSync(join(vendorRoot, 'upstream.json'), 'utf8'));
const unsafeProbeText = [
  /\/Users\//,
  /\/(?:private\/)?var\/folders\//,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{12,}\b/i,
];

function auditParserExtras(root, platform, artifact, problems) {
  const staticPath = join(root, 'static-strings.json');
  const helpPath = join(root, 'subcommand-help.json');
  if (!existsSync(staticPath) || !existsSync(helpPath)) {
    problems.push(`${platform}: missing static-strings or subcommand-help extras`);
    return;
  }
  const strings = JSON.parse(readFileSync(staticPath, 'utf8'));
  const help = JSON.parse(readFileSync(helpPath, 'utf8'));
  if (strings.probeKind !== 'static-strings' || strings.status !== 'unverified-contract') {
    problems.push(`${platform}: static-string extras overstate their status`);
  }
  if (strings.artifactSha256 !== artifact.sha256) {
    problems.push(`${platform}: static-string extras are not joined to the reviewed executable`);
  }
  for (const candidate of STATIC_STRING_CANDIDATES) {
    const observed = strings.candidates?.[candidate.id];
    if (
      observed?.value !== candidate.value ||
      observed?.kind !== candidate.kind ||
      observed?.present !== true ||
      observed?.status !== 'unverified-contract'
    ) {
      problems.push(`${platform}: static string ${candidate.id} drifted or is missing`);
    }
  }
  if (help.isolatedHomeFiles?.length !== 0) problems.push(`${platform}: subcommand help mutated isolated home`);
  const byId = new Map((help.commands ?? []).map((command) => [command.id, command]));
  for (const expected of REQUIRED_SUBCOMMAND_HELP) {
    const command = byId.get(expected.id);
    if (!command || JSON.stringify(command.args) !== JSON.stringify(expected.args)) {
      problems.push(`${platform}: subcommand help ${expected.id} is missing`);
      continue;
    }
    const text = `${command.stdout ?? ''}\n${command.stderr ?? ''}`;
    if (expected.id === 'help-update' || expected.id === 'update-help') {
      if (command.status === 0 || !text.includes('Usage of update:')) {
        problems.push(`${platform}: update help did not fail closed`);
      }
      continue;
    }
    if (command.status !== 0) problems.push(`${platform}: ${expected.id} exited ${command.status}`);
    if (expected.id.includes('models') && text.includes('--output-format')) {
      problems.push(`${platform}: models help unexpectedly lists --output-format`);
    }
    if (expected.id.includes('agents') && !/Usage: antigravity agent\b/.test(text)) {
      problems.push(`${platform}: agents help no longer names the agent subcommand`);
    }
    if (expected.id === 'help-plugin' && !text.includes('install <target>')) {
      problems.push(`${platform}: plugin help lost install syntax`);
    }
  }
}

export function auditAntigravity() {
  const problems = [...validateReleaseContract(reference, upstream), ...validateDocumentationReference(documentation)];
  const notes = [`release policy: ${reference.assets.length} exact public assets`];
  if (!existsSync(probesRoot)) {
    problems.push(`offline probes are missing: ${probesRoot}`);
    return { problems, notes };
  }

  const platforms = readdirSync(probesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (platforms.length === 0) problems.push('offline probe set is empty');
  if (JSON.stringify(platforms) !== JSON.stringify([...REQUIRED_PLATFORMS].sort())) {
    const missing = REQUIRED_PLATFORMS.filter((platform) => !platforms.includes(platform));
    const extra = platforms.filter((platform) => !REQUIRED_PLATFORMS.includes(platform));
    problems.push(
      `offline archive probe matrix drifted (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }
  for (const platform of platforms) {
    if (!REQUIRED_PLATFORMS.includes(platform)) {
      problems.push(`${platform}: probe platform is not in the required matrix`);
      continue;
    }
    const root = join(probesRoot, platform);
    const baseRequired = ['archive.json', 'artifact.json'];
    for (const name of baseRequired) {
      if (!existsSync(join(root, name))) problems.push(`${platform}: missing ${name}`);
    }
    if (baseRequired.some((name) => !existsSync(join(root, name)))) continue;

    const asset = reference.assets.find((candidate) => candidate.platform === platform);
    const archive = JSON.parse(readFileSync(join(root, 'archive.json'), 'utf8'));
    const artifact = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
    const parserExecution = artifact.probeKind === 'parser-execution';
    if (!parserExecution && artifact.probeKind !== 'archive-only') {
      problems.push(`${platform}: unsupported probe kind ${String(artifact.probeKind)}`);
    }
    if (archive.probeKind !== artifact.probeKind) problems.push(`${platform}: archive/artifact probe kinds differ`);
    if (archive.sha256 !== asset?.sha256 || archive.bytes !== asset?.size || archive.sourceUrl !== asset?.url) {
      problems.push(`${platform}: archive probe differs from the official release reference`);
    }
    if (archive.memberMatchesArtifact !== true || archive.memberSha256 !== artifact.sha256) {
      problems.push(`${platform}: executable is not joined to the reviewed archive member`);
    }
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '') || artifact.bytes < 1) {
      problems.push(`${platform}: executable identity is malformed`);
    }
    if (artifact.vendor !== 'antigravity' || artifact.vendorVersion !== VERSION || artifact.platform !== platform) {
      problems.push(`${platform}: executable identity does not match antigravity@${VERSION}`);
    }
    if (
      !['darwin', 'linux', 'win32'].includes(artifact.probeHost?.platform) ||
      !['arm64', 'x64'].includes(artifact.probeHost?.arch) ||
      typeof artifact.probeHost?.osRelease !== 'string'
    ) {
      problems.push(`${platform}: probe host identity is missing or malformed`);
    }
    const updateCandidate = artifact.staticStringCandidates?.disableAutoUpdateEnvironment;
    if (
      updateCandidate?.value !== 'AGY_CLI_DISABLE_AUTO_UPDATE' ||
      updateCandidate?.present !== true ||
      updateCandidate?.status !== 'unverified-contract'
    ) {
      problems.push(`${platform}: static auto-update candidate evidence drifted or overstates its status`);
    }
    const expectedArtifactLabel = parserExecution ? '$PUPPETEER_ANTIGRAVITY_BIN' : '$RELEASE_ARCHIVE_MEMBER';
    if (artifact.artifact !== expectedArtifactLabel) problems.push(`${platform}: private artifact path leaked`);
    if (platform.startsWith('darwin-') && artifact.signature?.teamIdentifier !== 'EQHXZ8M8AV') {
      problems.push(`${platform}: macOS signing team drifted`);
    }
    if (platform.startsWith('darwin-') && typeof artifact.signature?.verified !== 'boolean') {
      problems.push(`${platform}: macOS signature integrity result is missing`);
    }
    if (
      platform.startsWith('darwin-') &&
      artifact.signature?.verified === false &&
      !['invalid-signature', 'verification-failed', 'tool-error'].includes(artifact.signature?.verificationResult)
    ) {
      problems.push(`${platform}: failed macOS signature result is not classified`);
    }
    const required = [...baseRequired];
    if (parserExecution) {
      required.push('flags.json', 'help.txt', 'version.txt');
      for (const name of required.slice(baseRequired.length)) {
        if (!existsSync(join(root, name))) problems.push(`${platform}: missing ${name}`);
      }
      if (required.some((name) => !existsSync(join(root, name)))) continue;
      const flags = JSON.parse(readFileSync(join(root, 'flags.json'), 'utf8'));
      const help = readFileSync(join(root, 'help.txt'), 'utf8');
      const version = readFileSync(join(root, 'version.txt'), 'utf8').trim();
      if (artifact.versionOutput !== VERSION || version !== VERSION)
        problems.push(`${platform}: version probe drifted`);
      if (artifact.isolatedHomeFiles?.length !== 0) problems.push(`${platform}: offline probes mutated isolated home`);
      for (const option of REQUIRED_FLAGS) {
        if (!help.includes(option) || !flags.requiredFlags?.includes(option))
          problems.push(`${platform}: missing ${option}`);
      }
      for (const command of REQUIRED_SUBCOMMANDS) {
        if (!new RegExp(`^  ${command}\\s`, 'm').test(help) || !flags.requiredSubcommands?.includes(command)) {
          problems.push(`${platform}: missing ${command} subcommand`);
        }
      }
      if (flags.rejectedOption?.status === 0 || flags.rejectedOption?.mentionsRejectedFlag !== true) {
        problems.push(`${platform}: rejected-option probe did not fail closed`);
      }
      auditParserExtras(root, platform, artifact, problems);
    } else if (artifact.execution?.status !== 'not-run') {
      problems.push(`${platform}: archive-only probe overstates executable coverage`);
    }
    const privacyFiles = parserExecution ? [...required, 'static-strings.json', 'subcommand-help.json'] : required;
    const combined = privacyFiles
      .filter((name) => existsSync(join(root, name)))
      .map((name) => readFileSync(join(root, name), 'utf8'))
      .join('\n');
    for (const pattern of unsafeProbeText) {
      if (pattern.test(combined))
        problems.push(`${platform}: offline probes contain private or credential-shaped text`);
    }
  }
  const parserPlatforms = platforms.filter((platform) => {
    const artifactPath = join(probesRoot, platform, 'artifact.json');
    return existsSync(artifactPath) && JSON.parse(readFileSync(artifactPath, 'utf8')).probeKind === 'parser-execution';
  });
  if (!parserPlatforms.includes('darwin-arm64')) problems.push('darwin-arm64 parser-execution probe is missing');
  notes.push(
    `offline archive/executable identities: ${platforms.length}/${REQUIRED_PLATFORMS.length} required platforms`,
  );
  notes.push(`offline parser execution: ${parserPlatforms.length}/${REQUIRED_PLATFORMS.length} required platforms`);
  const invalidSignatures = platforms.filter((platform) => {
    if (!platform.startsWith('darwin-')) return false;
    const artifactPath = join(probesRoot, platform, 'artifact.json');
    return existsSync(artifactPath) && JSON.parse(readFileSync(artifactPath, 'utf8')).signature?.verified === false;
  });
  if (invalidSignatures.length > 0) {
    notes.push(`macOS signature integrity: INVALID for ${invalidSignatures.join(', ')} (promotion gate)`);
  }
  notes.push('documentation leads: official CLI docs + 1.1.12 changelog, not runtime evidence');
  const capturesRoot = join(vendorRoot, 'captures', `antigravity@${VERSION}`);
  const requiredScenarios = ['readonly-print', 'hook-discovery', 'add-dir-turn', 'resume-turn', 'tool-success'];
  for (const scenario of requiredScenarios) {
    if (!AUTHORIZED_SCENARIOS.includes(scenario))
      problems.push(`required scenario ${scenario} is not in the authorized set`);
    if (!existsSync(join(capturesRoot, scenario, 'capture.json'))) {
      problems.push(`missing sanitized capture: captures/antigravity@${VERSION}/${scenario}`);
    }
  }
  if (existsSync(join(capturesRoot, 'add-dir-turn', 'hooks.jsonl'))) {
    notes.push('authorized print-mode and hook captures are present');
  }
  if (existsSync(capturesRoot)) {
    for (const leak of checkCaptureDirectory(capturesRoot, antigravityRules)) {
      problems.push(`sanitized capture leak: ${leak}`);
    }
  }
  notes.push('native-TUI PTY census is still outstanding; print-mode is a survey oracle only');
  return { problems: problems.sort(), notes };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = auditAntigravity();
  for (const note of result.notes) console.log(`  ${note}`);
  if (result.problems.length > 0) {
    console.error(`\n${result.problems.length} Antigravity Surface problem(s):`);
    for (const problem of result.problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`\nantigravity@${VERSION} offline Surface bootstrap: clean`);
}
