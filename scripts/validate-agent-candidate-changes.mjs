#!/usr/bin/env node
/** Keep the write-enabled PR publisher confined to candidate-owned paths. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function validateCandidatePaths({ vendor, version, persona, paths }) {
  const prefixes = [
    `packages/surface/vendors/${vendor}/model/${vendor}@${version}/`,
    `packages/surface/vendors/${vendor}/captures/${vendor}@${version}/`,
    `packages/surface/vendors/${vendor}/candidates/${vendor}@${version}/`,
    `packages/imposter/personas/${persona}/`,
    `packages/adapter-${vendor}/src/generated/`,
  ];
  const exact = new Set([
    `packages/surface/vendors/${vendor}/findings.md`,
    `packages/adapter-${vendor}/docs/event-map.html`,
    'support/agents.json',
  ]);
  return paths
    .filter(
      (path) =>
        path.includes('/captures-raw/') || (!exact.has(path) && !prefixes.some((prefix) => path.startsWith(prefix))),
    )
    .map((path) => `candidate publisher may not modify ${path}`)
    .sort();
}

export function validateCandidateLedger({ before, after, vendor, manifest }) {
  const issues = [];
  const beforeById = new Map(before.agents.map((agent) => [agent.id, agent]));
  const afterById = new Map(after.agents.map((agent) => [agent.id, agent]));
  if (beforeById.size !== afterById.size) issues.push('candidate staging may not add or remove support entries');
  for (const [id, afterAgent] of afterById) {
    const beforeAgent = beforeById.get(id);
    if (!beforeAgent) continue;
    if (id !== vendor) {
      if (JSON.stringify(beforeAgent) !== JSON.stringify(afterAgent)) issues.push(`candidate staging changed ${id}`);
      continue;
    }
    const beforeComparable = { ...beforeAgent };
    const afterComparable = { ...afterAgent };
    delete beforeComparable.candidateManifest;
    delete afterComparable.candidateManifest;
    if (JSON.stringify(beforeComparable) !== JSON.stringify(afterComparable)) {
      issues.push(`${vendor} candidate staging changed promoted support fields`);
    }
    if (afterAgent.candidateManifest !== manifest) issues.push(`${vendor} candidate pointer is not ${manifest}`);
  }
  return issues.sort();
}

export function changedPaths(base = 'HEAD', repoRoot = root) {
  const committed =
    base === 'HEAD'
      ? ''
      : execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
          cwd: repoRoot,
          encoding: 'utf8',
        });
  const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return [...new Set(`${committed}\n${tracked}\n${untracked}`.split('\n').filter(Boolean))].sort();
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendor = flag('--vendor');
  const version = flag('--version');
  const manifest = flag('--manifest');
  const base = flag('--base') ?? 'HEAD';
  const current = JSON.parse(readFileSync(resolve(root, 'support', 'agents.json'), 'utf8'));
  const persona = current.agents.find((agent) => agent.id === vendor)?.persona;
  const before = JSON.parse(
    execFileSync('git', ['show', `${base}:support/agents.json`], { cwd: root, encoding: 'utf8' }),
  );
  const issues = [
    ...validateCandidatePaths({ vendor, version, persona, paths: changedPaths(base) }),
    ...validateCandidateLedger({ before, after: current, vendor, manifest }),
  ].sort();
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exit(1);
  }
  console.log('candidate changes are confined to reviewed Surface/Imposter/generated paths');
}
