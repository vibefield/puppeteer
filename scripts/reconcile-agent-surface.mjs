#!/usr/bin/env node
/** Structural/behavioral candidate classification. This prepares evidence; it never promotes support. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGroundTruth, isClaimAddressableAsmVersion, loadModel } from '@vibefield/puppeteer-surface';
import { resolveCanonicalGroundTruth } from './agent-model-selection.mjs';
import { replayAgentSurface } from './replay-agent-surface.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safePath(repoRoot, path) {
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(`${resolve(repoRoot)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function comparableEvent(event) {
  return canonical({
    event: event.event,
    channel: event.channel,
    channels: [...event.channels].sort(),
    transport: event.transport ?? null,
    direction: event.direction ?? null,
    payloadSchema: event.payloadSchema ?? null,
    resultSchema: event.resultSchema ?? null,
    recordSchema: event.recordSchema ?? null,
    recordChannel: event.recordChannel ?? null,
    confidence: event.confidence,
    variants: (event.variants ?? [])
      .map(({ match, confidence }) => ({ match, confidence }))
      .sort((left, right) => JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right)))),
  });
}

function comparableBehavior(behavior) {
  return canonical({
    lanes: behavior.lanes.map(({ id, label }) => ({ id, label })),
    nodes: behavior.nodes.map(({ id, event, confidence, lane, order, match }) => ({
      id,
      event,
      confidence,
      lane,
      order,
      match: match ?? null,
    })),
    relations: behavior.relations.map(({ from, to, kind, confidence }) => ({ from, to, kind, confidence })),
  });
}

function comparableDetection(detection) {
  const stable = { ...(detection ?? {}) };
  // The probed version string is expected to change for every candidate. The
  // executable names, regex, and launch contract are the semantic detector.
  delete stable.versionOutput;
  return canonical(stable);
}

export function diffSurfaceModels(current, candidate) {
  if (!current) {
    return {
      added: candidate.events.map((event) => event.event).sort(),
      removed: [],
      changed: [],
      behaviorChanged: true,
      channelsChanged: true,
      detectionChanged: true,
      baselineMissing: true,
    };
  }
  const before = new Map(current.events.map((event) => [event.event, comparableEvent(event)]));
  const after = new Map(candidate.events.map((event) => [event.event, comparableEvent(event)]));
  const added = [...after.keys()].filter((event) => !before.has(event)).sort();
  const removed = [...before.keys()].filter((event) => !after.has(event)).sort();
  const changed = [...after.keys()]
    .filter((event) => before.has(event) && JSON.stringify(before.get(event)) !== JSON.stringify(after.get(event)))
    .sort();
  return {
    added,
    removed,
    changed,
    behaviorChanged:
      JSON.stringify(comparableBehavior(current.behavior)) !== JSON.stringify(comparableBehavior(candidate.behavior)),
    channelsChanged: JSON.stringify(canonical(current.channels)) !== JSON.stringify(canonical(candidate.channels)),
    detectionChanged:
      JSON.stringify(comparableDetection(current.detection)) !==
      JSON.stringify(comparableDetection(candidate.detection)),
    baselineMissing: false,
  };
}

export function classifyReconciliation({ artifactStatus, replayStatus, modelDiff, detectorStatus = 'candidate' }) {
  if (artifactStatus === 'republished-artifact') return 'republished-artifact';
  if (
    artifactStatus !== 'complete' ||
    replayStatus !== 'passed' ||
    ['detector-error', 'detector-disagreement', 'rollback-detected', 'release-signal-changed'].includes(detectorStatus)
  ) {
    return 'unsafe-or-unknown';
  }
  if (modelDiff.baselineMissing || modelDiff.removed.length > 0 || modelDiff.changed.length > 0) {
    return 'adaptation-required';
  }
  if (modelDiff.behaviorChanged || modelDiff.channelsChanged || modelDiff.detectionChanged) {
    return 'adaptation-required';
  }
  if (modelDiff.added.length > 0) return 'additive-unconsumed';
  return 'no-surface-drift';
}

function artifactStatusFromEvidence(repoRoot, vendor, model) {
  const upstream = json(join(repoRoot, 'packages', 'surface', 'vendors', vendor, 'upstream.json'));
  const evidence = model.evidenceIndex;
  if (!evidence) return { status: 'incomplete', missingPlatforms: upstream.platforms };
  const verified = new Set(
    (evidence.artifacts ?? [])
      .filter((artifact) =>
        /^sha256:[0-9a-f]{64}$/.test(
          artifact.integrity?.status === 'verified' ? (artifact.integrity.sha256 ?? '') : '',
        ),
      )
      .map((artifact) => artifact.platform),
  );
  const missingPlatforms = (upstream.platforms ?? []).filter((platform) => !verified.has(platform));
  return { status: missingPlatforms.length === 0 ? 'complete' : 'incomplete', missingPlatforms };
}

export function reconcileAgentSurface({
  repoRoot = root,
  vendor,
  groundTruthPath,
  artifactReport,
  detectionReport,
} = {}) {
  if (!vendor) throw new Error('vendor is required');
  const ledger = json(join(repoRoot, 'support', 'agents.json'));
  const agent = ledger.agents.find((entry) => entry.id === vendor);
  if (!agent) throw new Error(`support ledger has no ${vendor}`);
  const candidatePath = groundTruthPath ?? agent.groundTruth;
  if (!candidatePath) throw new Error(`${vendor} has no canonical ground truth`);
  const canonical = resolveCanonicalGroundTruth({ repoRoot, vendor, groundTruthPath: candidatePath });
  const candidate = loadModel(canonical.groundTruthPath);
  if (!isClaimAddressableAsmVersion(candidate.manifest.asmVersion)) {
    throw new Error('reconciliation candidates must use a fully traced, claim-addressable ASM');
  }
  const current =
    agent.currentVersion && agent.currentVersion !== candidate.manifest.vendorVersion
      ? buildGroundTruth(
          join(repoRoot, 'packages', 'surface', 'vendors', vendor, 'model', `${vendor}@${agent.currentVersion}`),
        )
      : agent.currentVersion
        ? candidate
        : undefined;
  const modelDiff = diffSurfaceModels(current, candidate);
  const replay = replayAgentSurface({ repoRoot, vendor, groundTruthPath: candidatePath });
  const artifacts = artifactReport
    ? json(safePath(repoRoot, artifactReport))
    : artifactStatusFromEvidence(repoRoot, vendor, candidate);
  if (artifacts.vendor && (artifacts.vendor !== vendor || artifacts.version !== candidate.manifest.vendorVersion)) {
    throw new Error('artifact report identity differs from candidate');
  }
  let detectorStatus = 'candidate';
  if (detectionReport) {
    const detection = json(safePath(repoRoot, detectionReport));
    detectorStatus = detection.agents?.find((entry) => entry.vendor === vendor)?.status ?? 'detector-error';
  }
  const classification = classifyReconciliation({
    artifactStatus: artifacts.status,
    replayStatus: replay.status,
    modelDiff,
    detectorStatus,
  });
  return {
    schemaVersion: 1,
    vendor,
    vendorVersion: candidate.manifest.vendorVersion,
    groundTruth: canonical.groundTruthRelative,
    currentVersion: agent.currentVersion ?? null,
    classification,
    detectorStatus,
    artifactStatus: artifacts.status,
    missingPlatforms: artifacts.missingPlatforms ?? artifacts.issues ?? [],
    replay: {
      status: replay.status,
      frames: replay.frames,
      results: replay.results,
      digest: replay.replayDigest,
      issues: replay.issues,
    },
    modelDiff,
    recommendation:
      classification === 'no-surface-drift'
        ? 'prepare a draft promotion PR; human review and every promotion gate remain required'
        : classification === 'additive-unconsumed'
          ? 'prepare a draft model/persona PR and review unknown-event retention'
          : classification === 'adaptation-required'
            ? 'prepare a draft report; update adapter/persona semantics under human review'
            : 'quarantine the candidate and do not change support metadata',
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const report = reconcileAgentSurface({
    vendor: flag('--vendor'),
    groundTruthPath: flag('--ground-truth'),
    artifactReport: flag('--artifacts'),
    detectionReport: flag('--detection'),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = flag('--output');
  if (output) {
    // The first candidate of a vendor has no candidates/<vendor>@<version>/ directory yet.
    const destination = safePath(root, output);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, serialized);
  } else process.stdout.write(serialized);
  if (['unsafe-or-unknown', 'republished-artifact'].includes(report.classification)) process.exitCode = 1;
}
