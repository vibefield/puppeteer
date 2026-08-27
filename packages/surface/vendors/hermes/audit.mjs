#!/usr/bin/env node
/** Audit the Hermes Agent Surface (identity, Gate 0, turn captures, ASM). */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import {
  RELEASE_TAG,
  REQUIRED_FLAGS,
  REQUIRED_SUBCOMMANDS,
  SOURCE_REVISION,
  VERSION,
  validateSourceContract,
} from './census/harness.mjs';
import { hermesRules } from './privacy.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));
const probesRoot = join(vendorRoot, 'probes', `hermes@${VERSION}`);
const upstream = JSON.parse(readFileSync(join(vendorRoot, 'upstream.json'), 'utf8'));
const unsafeProbeText = [
  /\/Users\//,
  /\/(?:private\/)?tmp\/puppeteer-hermes-/,
  /\/(?:private\/)?var\/folders\//,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{12,}\b/i,
];

function walkFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

export function auditHermes() {
  const problems = [];
  const notes = [`pinned source ${RELEASE_TAG} @ ${SOURCE_REVISION}`];
  if (upstream.vendor !== 'hermes') problems.push('upstream vendor is not hermes');
  if (upstream.acquisition?.strategy !== 'source-revision') {
    problems.push('upstream acquisition must remain source-revision');
  }
  if (upstream.acquisition?.artifacts) {
    problems.push('source-revision policy must not invent per-platform binaries');
  }
  const sourceArchive = upstream.acquisition?.sourceArchive;
  const installedConsole = upstream.acquisition?.installedConsole;
  if (
    JSON.stringify(sourceArchive?.rootFiles) !== JSON.stringify(['pyproject.toml', 'uv.lock']) ||
    !Number.isInteger(sourceArchive?.maxExtractedBytes)
  ) {
    problems.push('source archive must review the bounded project and lockfile root');
  }
  if (
    installedConsole?.strategy !== 'python-uv-lock' ||
    installedConsole.projectFile !== 'pyproject.toml' ||
    installedConsole.lockFile !== 'uv.lock' ||
    installedConsole.distribution !== 'hermes-agent' ||
    installedConsole.consoleScript !== 'hermes' ||
    installedConsole.installMode !== 'editable' ||
    JSON.stringify(installedConsole.generatedSourcePaths) !== JSON.stringify(['hermes_agent.egg-info']) ||
    installedConsole.versionOutput !== 'first-line' ||
    !/^3\.11\.\d+$/.test(installedConsole.pythonVersion ?? '') ||
    !/^\d+\.\d+\.\d+$/.test(installedConsole.uvVersion ?? '')
  ) {
    problems.push('installed-console materialization policy is incomplete');
  }

  const sourcePath = join(probesRoot, 'source.json');
  if (!existsSync(sourcePath)) {
    problems.push(`source identity is missing: ${sourcePath}`);
    return { problems, notes };
  }
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  problems.push(
    ...validateSourceContract({
      sourceRevision: source.sourceRevision,
      releaseTag: source.releaseTag,
      vendorVersion: source.vendorVersion,
    }),
  );

  const platformDirs = readdirSync(probesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!platformDirs.includes('darwin-arm64') && !platformDirs.includes('linux-x64')) {
    problems.push('no execution-host identity probe is committed');
  }
  if (platformDirs.includes('gate0')) {
    notes.push('gate0 process-tree evidence is present');
  }

  const capturesRoot = join(vendorRoot, 'captures', `hermes@${VERSION}`);
  const requiredScenarios = ['basic-turn', 'tool-success', 'permission-deny', 'interrupt', 'resume-turn'];
  for (const scenario of requiredScenarios) {
    if (!existsSync(join(capturesRoot, scenario, 'rpc.jsonl'))) {
      problems.push(`missing sanitized turn capture: captures/hermes@${VERSION}/${scenario}/rpc.jsonl`);
    }
  }
  if (existsSync(capturesRoot)) notes.push('sanitized turn captures are present');

  const groundTruthPath = join(vendorRoot, 'groundtruth.json');
  if (existsSync(groundTruthPath)) {
    const model = loadModel(vendorRoot);
    const events = new Map(model.events.map((event) => [event.event, event]));
    notes.push(`ASM ${model.events.length} events`);
    for (const leak of checkCaptureDirectory(capturesRoot, hermesRules)) {
      problems.push(`privacy: ${leak}`);
    }
    for (const scenario of requiredScenarios) {
      const rpcPath = join(capturesRoot, scenario, 'rpc.jsonl');
      if (!existsSync(rpcPath)) continue;
      for (const [index, line] of readFileSync(rpcPath, 'utf8').split('\n').entries()) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.direction === 'client') {
          const descriptor = events.get(frame.method);
          if (!descriptor) {
            problems.push(`${scenario}/rpc.jsonl:${index + 1} unmodelled ${frame.method}`);
            continue;
          }
          if (descriptor.payloadSchema) {
            for (const failure of validatePayload(descriptor.payloadSchema, frame.params ?? {})) {
              problems.push(`${scenario} ${frame.method}: ${failure}`);
            }
          }
          if (descriptor.recordSchema) {
            for (const failure of validatePayload(descriptor.recordSchema, frame)) {
              problems.push(`${scenario} ${frame.method} carrier: ${failure}`);
            }
          }
        } else if (frame.method === 'event') {
          const type = frame.params?.type;
          const descriptor = events.get(type);
          if (!descriptor) {
            problems.push(`${scenario}/rpc.jsonl:${index + 1} unmodelled event ${type}`);
            continue;
          }
          if (descriptor.payloadSchema) {
            for (const failure of validatePayload(descriptor.payloadSchema, frame.params?.payload ?? {})) {
              problems.push(`${scenario} ${type}: ${failure}`);
            }
          }
          if (descriptor.recordSchema) {
            for (const failure of validatePayload(descriptor.recordSchema, frame)) {
              problems.push(`${scenario} ${type} carrier: ${failure}`);
            }
          }
        } else if (frame.result && frame.id != null) {
          // result frames are validated against the matching request method below if needed
        }
      }
      const hookPath = join(capturesRoot, scenario, 'plugin-hooks.jsonl');
      if (existsSync(hookPath)) {
        for (const [index, line] of readFileSync(hookPath, 'utf8').split('\n').entries()) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          const descriptor = events.get(record.hook_event_name);
          if (!descriptor) {
            problems.push(`${scenario}/plugin-hooks.jsonl:${index + 1} unmodelled ${record.hook_event_name}`);
            continue;
          }
          if (descriptor.payloadSchema) {
            for (const failure of validatePayload(descriptor.payloadSchema, record)) {
              problems.push(`${scenario} ${record.hook_event_name}: ${failure}`);
            }
          }
        }
      }
      const webhookPath = join(capturesRoot, scenario, 'webhooks.jsonl');
      if (existsSync(webhookPath)) {
        for (const [index, line] of readFileSync(webhookPath, 'utf8').split('\n').entries()) {
          if (!line.trim()) continue;
          const delivery = JSON.parse(line);
          const name = delivery.headers?.['x-hermes-event'] ?? delivery.body?.hook_event_name;
          if (name && !events.has(name)) {
            problems.push(`${scenario}/webhooks.jsonl:${index + 1} unmodelled ${name}`);
          }
        }
      }
    }
  } else {
    problems.push(`canonical ground truth is missing: ${groundTruthPath}`);
  }

  for (const platform of platformDirs.filter((name) => name !== 'gate0')) {
    const root = join(probesRoot, platform);
    for (const name of ['version.txt', 'help.txt', 'flags.json', 'artifact.json', 'acp-version.txt', 'acp-check.txt']) {
      if (!existsSync(join(root, name))) problems.push(`${platform}: missing ${name}`);
    }
    if (!existsSync(join(root, 'version.txt'))) continue;
    const versionText = readFileSync(join(root, 'version.txt'), 'utf8');
    if (!versionText.includes(VERSION) || !versionText.includes('2026.8.3')) {
      problems.push(`${platform}: version output does not identify ${VERSION}`);
    }
    const help = readFileSync(join(root, 'help.txt'), 'utf8');
    for (const name of REQUIRED_FLAGS) {
      if (!help.includes(name)) problems.push(`${platform}: help is missing ${name}`);
    }
    for (const name of REQUIRED_SUBCOMMANDS) {
      if (!help.includes(name)) problems.push(`${platform}: help is missing subcommand ${name}`);
    }
    const flags = JSON.parse(readFileSync(join(root, 'flags.json'), 'utf8'));
    if (flags.rejectedOptionProbe?.status === 0) {
      problems.push(`${platform}: rejected option did not fail closed`);
    }
    const artifact = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
    if (artifact.identity !== 'source-revision-and-lockfile') {
      problems.push(`${platform}: must not treat the console-script wrapper as product bytes`);
    }
  }

  for (const file of walkFiles(probesRoot)) {
    if (!/\.(txt|json)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of unsafeProbeText) {
      if (pattern.test(text)) problems.push(`${file.slice(vendorRoot.length + 1)}: leaked ${pattern}`);
    }
  }

  return { problems, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = auditHermes();
  for (const note of result.notes) console.log(`note: ${note}`);
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(problem);
    process.exit(1);
  }
  console.log('hermes surface audit ok');
}
