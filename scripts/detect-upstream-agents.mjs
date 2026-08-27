#!/usr/bin/env node
/** Detect upstream releases. This script is read-only with respect to support promotion. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadUpstreamConfigs(repoRoot = root) {
  const vendorsRoot = join(repoRoot, 'packages', 'surface', 'vendors');
  return readdirSync(vendorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(vendorsRoot, entry.name, 'upstream.json')))
    .map((entry) => ({
      path: join(vendorsRoot, entry.name, 'upstream.json'),
      config: json(join(vendorsRoot, entry.name, 'upstream.json')),
    }))
    .sort((a, b) => a.config.vendor.localeCompare(b.config.vendor));
}

function expandTemplate(template, version, tag = 'v1.2.3') {
  return String(template ?? '')
    .replaceAll('${version}', version)
    .replaceAll('${tag}', tag);
}

function validateUrlTemplates(label, templates, hosts, issues, { requireVersion = true } = {}) {
  if (!Array.isArray(templates) || templates.length === 0) {
    issues.push(`${label} has no artifact URL`);
    return;
  }
  for (const template of templates) {
    try {
      const hasVersion = template.includes('${version}');
      const hasTag = template.includes('${tag}');
      if ((requireVersion && !hasVersion) || (!hasVersion && !hasTag)) {
        issues.push(`${label} URL has unsupported template fields`);
        continue;
      }
      if (expandTemplate(template, '1.2.3').includes('${')) {
        issues.push(`${label} URL has unsupported template fields`);
        continue;
      }
      const url = new URL(expandTemplate(template, '1.2.3'));
      if (url.protocol !== 'https:' || !hosts.has(url.hostname)) {
        issues.push(`${label} URL origin is not allowlisted`);
      }
    } catch {
      issues.push(`${label} has an invalid artifact URL`);
    }
  }
}

function validateExecutableArchiveSpec(label, archive, hosts, issues, { formats, requireVersion = true }) {
  if (!formats.includes(archive?.format)) {
    issues.push(`${label} has an unsupported artifact format`);
  }
  if (
    !Array.isArray(archive?.executableBasenames) ||
    archive.executableBasenames.length === 0 ||
    archive.executableBasenames.some((name) => !/^[A-Za-z0-9._-]+$/.test(name))
  ) {
    issues.push(`${label} has unsafe executable basenames`);
  }
  validateUrlTemplates(label, archive?.urls, hosts, issues, { requireVersion });
}

function safeRelativePath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path);
}

function validateSourceArchiveSpec(label, archive, hosts, issues) {
  if (!['tar.gz', 'zip'].includes(archive?.format)) {
    issues.push(`${label} has an unsupported artifact format`);
  }
  if (
    !Array.isArray(archive?.rootFiles) ||
    archive.rootFiles.length === 0 ||
    new Set(archive.rootFiles).size !== archive.rootFiles.length ||
    archive.rootFiles.some((path) => !safeRelativePath(path))
  ) {
    issues.push(`${label} has unsafe or duplicate project-root files`);
  }
  validateUrlTemplates(label, archive?.urls, hosts, issues, { requireVersion: false });
}

function validateInstalledConsole(label, installedConsole, sourceArchive, issues) {
  if (installedConsole?.strategy !== 'python-uv-lock') {
    issues.push(`${label}: installedConsole must use python-uv-lock`);
    return;
  }
  if (!/^3\.\d+(?:\.\d+)?$/.test(installedConsole.pythonVersion ?? '')) {
    issues.push(`${label}: installedConsole needs a normalized Python 3 version`);
  }
  for (const field of ['projectFile', 'lockFile']) {
    if (!safeRelativePath(installedConsole[field])) {
      issues.push(`${label}: installedConsole ${field} must be a safe relative path`);
    } else if (!(sourceArchive?.rootFiles ?? []).includes(installedConsole[field])) {
      issues.push(`${label}: installedConsole ${field} must be a reviewed sourceArchive root file`);
    }
  }
  for (const field of ['distribution', 'consoleScript']) {
    if (!/^[A-Za-z0-9._-]+$/.test(installedConsole[field] ?? '')) {
      issues.push(`${label}: installedConsole ${field} must be normalized`);
    }
  }
}

function validateAcquisitionHosts(label, acquisition, issues) {
  const hosts = new Set(acquisition.allowedHosts ?? []);
  if (hosts.size === 0 || [...hosts].some((host) => !/^[a-z0-9.-]+$/.test(host))) {
    issues.push(`${label}: acquisition allowedHosts must be normalized DNS names`);
  }
  if (!Number.isInteger(acquisition.maxBytes) || acquisition.maxBytes < 1 || acquisition.maxBytes > 1_073_741_824) {
    issues.push(`${label}: acquisition maxBytes must be between 1 and 1073741824`);
  }
  return hosts;
}

function validateAcquisition(label, config, issues) {
  const acquisition = config.acquisition;
  if (acquisition?.strategy === 'https-template') {
    const hosts = validateAcquisitionHosts(label, acquisition, issues);
    const artifactPlatforms = Object.keys(acquisition.artifacts ?? {});
    for (const platform of config.platforms ?? []) {
      const artifact = acquisition.artifacts?.[platform];
      if (!artifact) {
        issues.push(`${label}: acquisition has no artifact for ${platform}`);
        continue;
      }
      validateExecutableArchiveSpec(`${label}: ${platform}`, artifact, hosts, issues, {
        formats: ['binary', 'tar.gz', 'zip'],
      });
    }
    for (const platform of artifactPlatforms) {
      if (!(config.platforms ?? []).includes(platform)) {
        issues.push(`${label}: acquisition declares unexpected platform ${platform}`);
      }
    }
    return;
  }
  if (acquisition?.strategy === 'source-revision') {
    const hosts = validateAcquisitionHosts(label, acquisition, issues);
    if (acquisition.artifacts) {
      issues.push(`${label}: source-revision acquisition must not declare per-platform artifacts`);
    }
    if (!acquisition.sourceArchive) {
      issues.push(`${label}: source-revision acquisition needs sourceArchive`);
      return;
    }
    validateSourceArchiveSpec(`${label}: sourceArchive`, acquisition.sourceArchive, hosts, issues);
    validateInstalledConsole(label, acquisition.installedConsole, acquisition.sourceArchive, issues);
    return;
  }
  issues.push(`${label}: acquisition must use https-template or source-revision`);
}

export function validateUpstreamConfigs(repoRoot = root) {
  const issues = [];
  const vendors = new Set();
  for (const { path, config } of loadUpstreamConfigs(repoRoot)) {
    const label = path.slice(repoRoot.length + 1);
    if (config.schemaVersion !== 1) issues.push(`${label}: schemaVersion must be 1`);
    if (!/^[a-z][a-z0-9-]*$/.test(config.vendor ?? '')) issues.push(`${label}: invalid vendor`);
    if (vendors.has(config.vendor)) issues.push(`${label}: duplicate vendor ${config.vendor}`);
    vendors.add(config.vendor);
    try {
      const repository = new URL(config.repository);
      if (
        repository.protocol !== 'https:' ||
        repository.hostname !== 'github.com' ||
        repository.pathname.split('/').filter(Boolean).length !== 2
      ) {
        issues.push(`${label}: repository must be an HTTPS GitHub repository`);
      }
    } catch {
      issues.push(`${label}: invalid repository`);
    }
    const sourceRelation = config.sourceRelation;
    if (sourceRelation?.strategy === 'release-tag') {
      if (typeof sourceRelation.template !== 'string') {
        issues.push(`${label}: release-tag sourceRelation needs a template`);
      } else if (
        !(sourceRelation.template.includes('${version}') || sourceRelation.template.includes('${tag}')) ||
        sourceRelation.template.replaceAll('${version}', '').replaceAll('${tag}', '').includes('${')
      ) {
        issues.push(label + ': release-tag sourceRelation template may only use ${version} and ${tag}');
      }
    } else if (sourceRelation?.strategy === 'source-revision-file') {
      if (!/^[A-Za-z0-9._-]+$/.test(sourceRelation.path ?? '')) {
        issues.push(`${label}: source-revision-file sourceRelation needs a safe repository-root path`);
      }
    } else {
      issues.push(`${label}: invalid sourceRelation strategy`);
    }
    if (!Array.isArray(config.detectors) || config.detectors.length === 0) issues.push(`${label}: no detectors`);
    const detectorIds = new Set();
    for (const detector of config.detectors ?? []) {
      if (detectorIds.has(detector.id)) issues.push(`${label}: duplicate detector ${detector.id}`);
      detectorIds.add(detector.id);
      if (!['stable', 'preview'].includes(detector.channel))
        issues.push(`${label}: ${detector.id} has invalid channel`);
      if (!['text', 'github-release'].includes(detector.kind)) issues.push(`${label}: ${detector.id} has invalid kind`);
      try {
        if (new URL(detector.url).protocol !== 'https:') issues.push(`${label}: ${detector.id} URL must use HTTPS`);
      } catch {
        issues.push(`${label}: ${detector.id} has invalid URL`);
      }
      const pattern = detector.kind === 'text' ? detector.versionPattern : detector.tagPattern;
      if (!pattern) {
        issues.push(`${label}: ${detector.id} has no version pattern`);
      } else
        try {
          new RegExp(pattern);
        } catch {
          issues.push(`${label}: ${detector.id} has invalid version pattern`);
        }
      if (detector.kind === 'github-release' && detector.titlePattern) {
        try {
          new RegExp(detector.titlePattern);
        } catch {
          issues.push(`${label}: ${detector.id} has invalid title pattern`);
        }
      }
    }
    const stable = (config.detectors ?? []).filter((detector) => detector.channel === 'stable');
    if (!stable.some((detector) => detector.authoritative === true))
      issues.push(`${label}: no authoritative stable detector`);
    if (!Array.isArray(config.platforms) || config.platforms.length === 0)
      issues.push(`${label}: no required platforms`);
    else if (
      new Set(config.platforms).size !== config.platforms.length ||
      config.platforms.some((platform) => !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(platform))
    )
      issues.push(`${label}: required platforms must be unique normalized identifiers`);
    validateAcquisition(label, config, issues);
    if (
      !Array.isArray(config.analysis) ||
      config.analysis.length === 0 ||
      new Set(config.analysis).size !== config.analysis.length ||
      config.analysis.some((step) => typeof step !== 'string' || !step)
    )
      issues.push(`${label}: analysis must contain unique non-empty steps`);
    if (!config.debounce || config.debounce.polls < 1 || config.debounce.minutes < 0)
      issues.push(`${label}: invalid debounce`);
  }
  return issues.sort();
}

async function fetchOnce(url, fetchImpl, cache) {
  if (!cache.has(url)) {
    const githubToken = new URL(url).hostname === 'api.github.com' ? process.env.GITHUB_TOKEN : undefined;
    cache.set(
      url,
      fetchImpl(url, {
        headers: {
          accept: 'application/vnd.github+json, text/plain;q=0.9, */*;q=0.8',
          'user-agent': 'vibecook-puppeteer-upstream-detector',
          ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
        },
      }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
        return { text: await response.text(), contentType: response.headers.get('content-type') ?? '' };
      }),
    );
  }
  return cache.get(url);
}

export async function detectVersion(detector, fetchImpl = fetch, cache = new Map()) {
  return (await detectRelease(detector, fetchImpl, cache)).version;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Detect a version plus a content identity, so same-version republishes are visible. */
export async function detectRelease(detector, fetchImpl = fetch, cache = new Map()) {
  const response = await fetchOnce(detector.url, fetchImpl, cache);
  if (detector.kind === 'text') {
    const match = response.text.match(new RegExp(detector.versionPattern));
    if (!match?.[1]) throw new Error(`${detector.id}: response did not contain a matching version`);
    return {
      version: match[1],
      signalDigest: sha256(response.text.trim()),
      releaseIdentity: { kind: 'text', contentType: response.contentType },
    };
  }
  const releases = JSON.parse(response.text);
  if (!Array.isArray(releases)) throw new Error(`${detector.id}: GitHub response is not a release array`);
  const pattern = new RegExp(detector.tagPattern);
  const titlePattern = detector.titlePattern ? new RegExp(detector.titlePattern) : null;
  for (const release of releases) {
    if (release.draft || Boolean(release.prerelease) !== Boolean(detector.prerelease)) continue;
    const match = String(release.tag_name ?? '').match(pattern);
    if (!match) continue;
    let version = match[1];
    if (titlePattern) {
      const titleMatch = String(release.name ?? '').match(titlePattern);
      if (!titleMatch?.[1]) continue;
      version = titleMatch[1];
    }
    if (version) {
      const identity = {
        tagName: release.tag_name ?? null,
        releaseId: release.id ?? null,
        targetCommitish: release.target_commitish ?? null,
        publishedAt: release.published_at ?? null,
        assets: Array.isArray(release.assets)
          ? release.assets
              .map((asset) => ({
                name: asset.name ?? null,
                size: asset.size ?? null,
                digest: asset.digest ?? null,
                updatedAt: asset.updated_at ?? null,
              }))
              .sort((left, right) => String(left.name).localeCompare(String(right.name)))
          : [],
      };
      return { version, signalDigest: sha256(JSON.stringify(identity)), releaseIdentity: identity };
    }
  }
  throw new Error(`${detector.id}: no matching GitHub release`);
}

function promotedVersions(repoRoot) {
  const ledger = json(join(repoRoot, 'support', 'agents.json'));
  return new Map(
    ledger.agents.map((agent) => {
      return [agent.id, agent.currentVersion];
    }),
  );
}

function ensureState(state) {
  state.releases ??= {};
  state.heads ??= {};
  if (state.schemaVersion === 1) {
    // Preserve the old debounce map as migration evidence; copy each entry into
    // the append-only release history rather than deleting the superseded key.
    for (const [key, observation] of Object.entries(state.candidates ?? {})) {
      const separator = key.indexOf('@');
      if (separator <= 0) continue;
      const vendor = key.slice(0, separator);
      const version = key.slice(separator + 1);
      state.releases[key] ??= {
        vendor,
        version,
        firstSeen: observation.firstSeen,
        lastSeen: observation.lastSeen,
        observations: { 'legacy-version-only': observation },
        platforms: {},
        migratedFromSchema1: true,
      };
    }
  }
  state.schemaVersion = 2;
  return state;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const parts = String(value ?? '').split(/[.-]/);
    const numbers = [];
    while (parts.length > 0 && /^\d+$/.test(parts[0])) numbers.push(Number(parts.shift()));
    return { numbers, suffix: parts.join('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const delta = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  if (!a.suffix && b.suffix) return 1;
  if (a.suffix && !b.suffix) return -1;
  return a.suffix.localeCompare(b.suffix, 'en', { numeric: true, sensitivity: 'base' });
}

function sourceReference(config, version, tag) {
  return config.sourceRelation.strategy === 'release-tag'
    ? {
        strategy: 'release-tag',
        expectedReference: expandTemplate(config.sourceRelation.template, version, tag),
      }
    : {
        strategy: 'source-revision-file',
        path: config.sourceRelation.path,
        status: 'awaiting-artifact-acquisition',
      };
}

function acquisitionWorkItems(config, version, signalDigest, tag) {
  const expand = (template) => expandTemplate(template, version, tag);
  if (config.acquisition.strategy === 'source-revision') {
    const archive = config.acquisition.sourceArchive;
    return config.platforms.map((platform) => ({
      key: `${config.vendor}@${version}@${platform}@pending-${signalDigest}`,
      platform,
      artifactDigest: null,
      status: 'awaiting-artifact-acquisition',
      acquisition: {
        kind: 'source-archive',
        format: archive.format,
        urls: archive.urls.map(expand),
        nextArtifact: {
          kind: 'installed-console',
          status: 'awaiting-source-install',
          ...config.acquisition.installedConsole,
        },
      },
    }));
  }
  return config.platforms.map((platform) => ({
    key: `${config.vendor}@${version}@${platform}@pending-${signalDigest}`,
    platform,
    artifactDigest: null,
    status: 'awaiting-artifact-acquisition',
    acquisition: {
      format: config.acquisition.artifacts[platform].format,
      urls: config.acquisition.artifacts[platform].urls.map(expand),
    },
  }));
}

export function debounceAgent(agent, debounce, state, observedAt) {
  ensureState(state);
  if (!agent.detectedStableVersion) return agent;
  const key = `${agent.vendor}@${agent.detectedStableVersion}`;
  const release = (state.releases[key] ??= {
    vendor: agent.vendor,
    version: agent.detectedStableVersion,
    firstSeen: observedAt.toISOString(),
    lastSeen: observedAt.toISOString(),
    sourceRelation: agent.sourceRelation,
    observations: {},
    platforms: Object.fromEntries(
      (agent.platforms ?? []).map((platform) => [
        platform,
        { artifactDigest: null, status: 'awaiting-artifact-acquisition' },
      ]),
    ),
  });
  release.sourceRelation ??= agent.sourceRelation;
  release.platforms ??= {};
  for (const platform of agent.platforms ?? []) {
    release.platforms[platform] ??= { artifactDigest: null, status: 'awaiting-artifact-acquisition' };
  }
  const signalDigest = agent.signalDigest ?? 'version-only';
  const prior = release.observations[signalDigest];
  const observation = {
    firstSeen: prior?.firstSeen ?? observedAt.toISOString(),
    lastSeen: observedAt.toISOString(),
    polls: (prior?.polls ?? 0) + 1,
  };
  release.observations[signalDigest] = observation;
  release.lastSeen = observation.lastSeen;
  release.lastStatus = agent.status;
  const ageMinutes = (observedAt.valueOf() - new Date(observation.firstSeen).valueOf()) / 60_000;
  const mature = observation.polls >= debounce.polls || ageMinutes >= debounce.minutes;
  if (agent.status !== 'candidate') return { ...agent, releaseKey: key, debounceObservation: observation };
  return {
    ...agent,
    status: mature ? 'candidate' : 'candidate-pending',
    releaseKey: key,
    debounceObservation: observation,
  };
}

export async function detectUpstreamAgents({
  repoRoot = root,
  fetchImpl = fetch,
  now = () => new Date(),
  state = { schemaVersion: 2, releases: {}, heads: {} },
} = {}) {
  const configIssues = validateUpstreamConfigs(repoRoot);
  if (configIssues.length > 0) throw new Error(configIssues.join('\n'));
  const promoted = promotedVersions(repoRoot);
  const cache = new Map();
  const agents = [];
  const alerts = [];
  const observedAt = now();
  ensureState(state);
  for (const { config } of loadUpstreamConfigs(repoRoot)) {
    const detections = [];
    for (const detector of config.detectors) {
      try {
        detections.push({
          id: detector.id,
          channel: detector.channel,
          authoritative: detector.authoritative === true,
          ...(await detectRelease(detector, fetchImpl, cache)),
          url: detector.url,
        });
      } catch (error) {
        detections.push({ id: detector.id, channel: detector.channel, error: error.message, url: detector.url });
      }
    }
    const stable = detections.filter((entry) => entry.channel === 'stable' && entry.version);
    const authoritative = stable.find((entry) => entry.authoritative);
    const stableVersions = [...new Set(stable.map((entry) => entry.version))];
    const detectorErrors = detections.filter((entry) => entry.error);
    const priorHead = state.heads[config.vendor];
    const priorRelease = authoritative?.version
      ? state.releases[`${config.vendor}@${authoritative.version}`]
      : undefined;
    const signalChanged = Boolean(
      authoritative?.signalDigest &&
      priorRelease &&
      Object.keys(priorRelease.observations ?? {}).some((digest) => digest !== authoritative.signalDigest),
    );
    let status = 'current';
    if (
      !authoritative ||
      detectorErrors.some((entry) => config.detectors.find((item) => item.id === entry.id)?.authoritative)
    ) {
      status = 'detector-error';
    } else if (stableVersions.length > 1) {
      status = 'detector-disagreement';
    } else if (priorHead?.highestVersion && compareVersions(authoritative.version, priorHead.highestVersion) < 0) {
      status = 'rollback-detected';
    } else if (signalChanged) {
      status = 'release-signal-changed';
    } else if (authoritative.version !== promoted.get(config.vendor)) {
      status = 'candidate';
    }
    const releaseTag = authoritative?.releaseIdentity?.tagName ?? null;
    const relation = authoritative?.version
      ? sourceReference(config, authoritative.version, releaseTag)
      : config.sourceRelation;
    const workItems = authoritative?.version
      ? acquisitionWorkItems(config, authoritative.version, authoritative.signalDigest, releaseTag)
      : [];
    const agent = {
      vendor: config.vendor,
      promotedVersion: promoted.get(config.vendor) ?? null,
      detectedStableVersion: authoritative?.version ?? null,
      status,
      debounce: config.debounce,
      repository: config.repository,
      sourceRelation: relation,
      signalDigest: authoritative?.signalDigest ?? null,
      platforms: config.platforms,
      analysis: config.analysis,
      workItems,
      detections,
    };
    const debounced = debounceAgent(agent, config.debounce, state, observedAt);
    agents.push(debounced);
    if (!['current', 'candidate', 'candidate-pending'].includes(debounced.status)) {
      alerts.push({
        vendor: config.vendor,
        kind: debounced.status,
        detectedVersion: debounced.detectedStableVersion,
        previousHighestVersion: priorHead?.highestVersion ?? null,
      });
    }
    if (authoritative?.version) {
      const highestVersion =
        !priorHead?.highestVersion || compareVersions(authoritative.version, priorHead.highestVersion) >= 0
          ? authoritative.version
          : priorHead.highestVersion;
      state.heads[config.vendor] = {
        highestVersion,
        highestSignalDigest:
          highestVersion === authoritative.version ? authoritative.signalDigest : priorHead.highestSignalDigest,
        lastObservedVersion: authoritative.version,
        lastObservedSignalDigest: authoritative.signalDigest,
        lastObservedAt: observedAt.toISOString(),
      };
    }
  }
  return {
    schemaVersion: 2,
    detectedAt: observedAt.toISOString(),
    hasActionableChange: agents.some((agent) => !['current', 'candidate-pending'].includes(agent.status)),
    alerts,
    agents,
    releaseHistory: Object.values(state.releases)
      .map((release) => ({
        vendor: release.vendor,
        version: release.version,
        firstSeen: release.firstSeen,
        lastSeen: release.lastSeen,
        lastStatus: release.lastStatus ?? null,
        signalDigests: Object.keys(release.observations ?? {}),
        platforms: release.platforms ?? {},
      }))
      .sort((left, right) => `${left.vendor}@${left.version}`.localeCompare(`${right.vendor}@${right.version}`)),
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  if (process.argv.includes('--check-config')) {
    const issues = validateUpstreamConfigs();
    if (issues.length > 0) {
      for (const issue of issues) console.error(issue);
      process.exit(1);
    }
    console.log(`upstream detector configs: clean (${loadUpstreamConfigs().length} vendors)`);
  } else {
    const stateIndex = process.argv.indexOf('--state');
    const statePath =
      stateIndex >= 0 && process.argv[stateIndex + 1] ? resolve(process.argv[stateIndex + 1]) : undefined;
    const state = statePath && existsSync(statePath) ? json(statePath) : { schemaVersion: 2, releases: {}, heads: {} };
    const report = await detectUpstreamAgents({ state });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex >= 0) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new Error('--output needs a path');
      writeFileSync(resolve(output), serialized);
      console.log(`wrote ${output}`);
    } else {
      process.stdout.write(serialized);
    }
    if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `actionable=${report.hasActionableChange}\n`);
    }
    if (statePath) writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
