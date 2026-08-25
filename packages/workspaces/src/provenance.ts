/**
 * Workspace-owned provenance facts. Local records deliberately retain canonical
 * paths and file names for authorized host APIs. The own-action recorder has a
 * separate allowlist and persists only summaries plus installation-keyed HMACs.
 */

import { realpath } from 'node:fs/promises';
import { commonGitDirectory, git, headRef, isGitRepo, parseShortstat, porcelainStatusNull } from './git.js';

export const WORKSPACE_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const MAX_REACHABLE_COMMITS = 1_024;

export type WorkspaceAllocationMode = 'direct' | 'exclusive' | 'worktree' | 'copy';
export type WorkspaceIsolation = 'managed-isolated' | 'cooperative-exclusive' | 'shared' | 'unknown';
export type WorkspaceProvenanceQuality = 'exact' | 'strong' | 'derived' | 'estimated' | 'inferred' | 'unknown';
export type WorkspaceProvenanceCompleteness = 'complete' | 'partial' | 'unavailable';
export type WorkspaceFinalizationOutcome = 'complete' | 'partial' | 'failed' | 'unavailable';

export interface WorkspaceKeyedFingerprint {
  algorithm: 'hmac-sha256';
  value: string;
}

export type WorkspaceKeyedDigest = (
  domain: 'repository' | 'index-state' | 'worktree-state' | 'files-touched',
  canonicalValue: string,
) => string | Promise<string>;

export interface WorkspaceProvenanceOptions {
  /** Installation-keyed digest boundary supplied by the durable recorder. */
  keyedDigest?: WorkspaceKeyedDigest;
  /** Other cooperative runtime claims already known at allocation. */
  knownConcurrentClaims?: number;
  /** Injectable wall clock for deterministic evidence. */
  now?: () => Date;
}

export interface WorkspaceRepositoryIdentity {
  kind: 'git' | 'directory';
  /** Authorized local API only; never part of the durable action schema. */
  canonicalSourcePath: string;
  /** Authorized local API only; never part of the durable action schema. */
  canonicalWorktreePath: string;
  /** Authorized local API only; never part of the durable action schema. */
  canonicalCommonGitDirPath?: string;
  /** Stable on one installation and opaque across installations. */
  digest?: WorkspaceKeyedFingerprint;
}

export interface WorkspaceChangeSummary {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
  unmerged: number;
  untracked: number;
  other: number;
}

export interface WorkspaceGitObservation {
  state: 'attached' | 'detached' | 'unborn' | 'non-git' | 'unavailable';
  headCommit?: string;
  headRef?: string;
  index: WorkspaceChangeSummary;
  worktree: WorkspaceChangeSummary;
  conflicts: number;
  indexFingerprint?: WorkspaceKeyedFingerprint;
  worktreeFingerprint?: WorkspaceKeyedFingerprint;
}

export interface WorkspaceBaselineRecord {
  schemaVersion: typeof WORKSPACE_PROVENANCE_SCHEMA_VERSION;
  capturedAt: string;
  allocationMode: WorkspaceAllocationMode;
  isolation: WorkspaceIsolation;
  knownConcurrentClaims: number;
  repository: WorkspaceRepositoryIdentity;
  git: WorkspaceGitObservation;
  /** Authorized local API only; durable records persist counts/fingerprints. */
  initialDirtyFiles: string[];
  quality: WorkspaceProvenanceQuality;
  completeness: WorkspaceProvenanceCompleteness;
  limitations: string[];
}

export interface WorkspaceReachableCommitRange {
  relation: 'unchanged' | 'fast-forward' | 'rewritten' | 'created' | 'removed' | 'unavailable';
  initialCommit?: string;
  finalCommit?: string;
  commits: string[];
  totalCount: number;
  truncated: boolean;
}

export type WorkspaceInterferenceKind =
  'known-concurrent-claim' | 'baseline-dirty-overlap' | 'repository-identity-changed' | 'observation-gap';

export interface WorkspaceInterferenceObservation {
  kind: WorkspaceInterferenceKind;
  observedAt: string;
  count?: number;
}

export interface WorkspaceChangeRecord {
  /** Authorized local API only; durable records persist count/fingerprint. */
  filesTouched: string[];
  filesTouchedCount: number;
  filesFingerprint?: WorkspaceKeyedFingerprint;
  insertions: number;
  deletions: number;
}

export interface WorkspaceFinalizationRecord {
  schemaVersion: typeof WORKSPACE_PROVENANCE_SCHEMA_VERSION;
  finalizedAt: string;
  outcome: WorkspaceFinalizationOutcome;
  repository: WorkspaceRepositoryIdentity;
  git: WorkspaceGitObservation;
  reachableCommits: WorkspaceReachableCommitRange;
  changes: WorkspaceChangeRecord;
  interference: WorkspaceInterferenceObservation[];
  knownConcurrentClaims: number;
  quality: WorkspaceProvenanceQuality;
  completeness: WorkspaceProvenanceCompleteness;
  limitations: string[];
}

interface StatusEntry {
  indexStatus?: string;
  worktreeStatus?: string;
  path: string;
  originalPath?: string;
}

interface ObservedGitState {
  observation: WorkspaceGitObservation;
  dirtyFiles: string[];
  entries: StatusEntry[];
  limitations: string[];
}

interface CaptureBaselineInput {
  root: string;
  sourcePath: string;
  mode: WorkspaceAllocationMode;
  options?: WorkspaceProvenanceOptions;
}

interface CaptureFinalizationInput {
  root: string;
  sourcePath: string;
  baseline: WorkspaceBaselineRecord;
  options?: WorkspaceProvenanceOptions;
  knownConcurrentClaims?: number;
}

function emptySummary(): WorkspaceChangeSummary {
  return {
    total: 0,
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    unmerged: 0,
    untracked: 0,
    other: 0,
  };
}

function isUnmerged(indexStatus: string, worktreeStatus: string): boolean {
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(`${indexStatus}${worktreeStatus}`);
}

function parseStatusEntries(value: string): StatusEntry[] {
  const fields = value.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 3) continue;
    const indexStatus = field[0]!;
    const worktreeStatus = field[1]!;
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    const entry: StatusEntry = {
      ...(indexStatus === ' ' || indexStatus === '!' || untracked ? {} : { indexStatus }),
      ...(worktreeStatus === ' ' || worktreeStatus === '!' ? {} : { worktreeStatus }),
      path: field.slice(3),
    };
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      const originalPath = fields[index + 1];
      if (originalPath) {
        entry.originalPath = originalPath;
        index += 1;
      }
    }
    entries.push(entry);
  }
  return entries;
}

function increment(summary: WorkspaceChangeSummary, status: string, unmerged: boolean): void {
  summary.total += 1;
  if (unmerged || status === 'U') summary.unmerged += 1;
  else if (status === 'A') summary.added += 1;
  else if (status === 'M' || status === 'T') summary.modified += 1;
  else if (status === 'D') summary.deleted += 1;
  else if (status === 'R') summary.renamed += 1;
  else if (status === 'C') summary.copied += 1;
  else if (status === '?') summary.untracked += 1;
  else summary.other += 1;
}

function summarize(entries: readonly StatusEntry[]): {
  index: WorkspaceChangeSummary;
  worktree: WorkspaceChangeSummary;
  conflicts: number;
} {
  const index = emptySummary();
  const worktree = emptySummary();
  let conflicts = 0;
  for (const entry of entries) {
    const indexStatus = entry.indexStatus ?? ' ';
    const worktreeStatus = entry.worktreeStatus ?? ' ';
    const unmerged = isUnmerged(indexStatus, worktreeStatus);
    if (unmerged) conflicts += 1;
    if (entry.indexStatus && entry.indexStatus !== '?') increment(index, entry.indexStatus, unmerged);
    if (entry.worktreeStatus) increment(worktree, entry.worktreeStatus, unmerged);
  }
  return { index, worktree, conflicts };
}

function canonicalEntries(entries: readonly StatusEntry[], side: 'index' | 'worktree'): string {
  return JSON.stringify(
    entries
      .flatMap((entry) => {
        const status = side === 'index' ? entry.indexStatus : entry.worktreeStatus;
        return status === undefined ? [] : [{ status, path: entry.path, originalPath: entry.originalPath }];
      })
      .sort((left, right) =>
        `${left.path}\0${left.status}\0${left.originalPath ?? ''}`.localeCompare(
          `${right.path}\0${right.status}\0${right.originalPath ?? ''}`,
        ),
      ),
  );
}

async function keyedFingerprint(
  options: WorkspaceProvenanceOptions | undefined,
  domain: Parameters<WorkspaceKeyedDigest>[0],
  value: string,
  limitations: string[],
): Promise<WorkspaceKeyedFingerprint | undefined> {
  if (!options?.keyedDigest) return undefined;
  try {
    const digest = await options.keyedDigest(domain, value);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('digest is not a lowercase HMAC-SHA256 value');
    return { algorithm: 'hmac-sha256', value: digest };
  } catch {
    limitations.push(`keyed-${domain}-fingerprint-unavailable`);
    return undefined;
  }
}

function isolationForMode(mode: WorkspaceAllocationMode): WorkspaceIsolation {
  if (mode === 'worktree' || mode === 'copy') return 'managed-isolated';
  if (mode === 'exclusive') return 'cooperative-exclusive';
  if (mode === 'direct') return 'shared';
  return 'unknown';
}

function qualityFor(
  isolation: WorkspaceIsolation,
  initialDirtyCount: number,
  interferenceCount = 0,
): WorkspaceProvenanceQuality {
  if (isolation === 'unknown') return 'unknown';
  if (isolation === 'shared') return 'estimated';
  if (interferenceCount > 0 || initialDirtyCount > 0) return 'derived';
  return 'strong';
}

async function repositoryIdentity(
  root: string,
  sourcePath: string,
  options: WorkspaceProvenanceOptions | undefined,
  limitations: string[],
): Promise<WorkspaceRepositoryIdentity> {
  const canonicalWorktreePath = await realpath(root);
  const canonicalSourcePath = await realpath(sourcePath);
  const gitRepository = await isGitRepo(canonicalWorktreePath);
  let canonicalCommonGitDirPath: string | undefined;
  if (gitRepository) {
    try {
      canonicalCommonGitDirPath = await commonGitDirectory(canonicalWorktreePath);
    } catch {
      limitations.push('common-git-directory-unavailable');
    }
  }
  const canonicalIdentity = canonicalCommonGitDirPath ?? canonicalSourcePath;
  const digest = await keyedFingerprint(
    options,
    'repository',
    JSON.stringify([gitRepository ? 'git' : 'directory', canonicalIdentity]),
    limitations,
  );
  return {
    kind: gitRepository ? 'git' : 'directory',
    canonicalSourcePath,
    canonicalWorktreePath,
    ...(canonicalCommonGitDirPath === undefined ? {} : { canonicalCommonGitDirPath }),
    ...(digest === undefined ? {} : { digest }),
  };
}

async function observeGit(
  root: string,
  repository: WorkspaceRepositoryIdentity,
  options: WorkspaceProvenanceOptions | undefined,
): Promise<ObservedGitState> {
  if (repository.kind !== 'git') {
    return {
      observation: {
        state: 'non-git',
        index: emptySummary(),
        worktree: emptySummary(),
        conflicts: 0,
      },
      dirtyFiles: [],
      entries: [],
      limitations: [],
    };
  }

  const limitations: string[] = [];
  let headCommit: string | undefined;
  let ref: string | undefined;
  let entries: StatusEntry[] = [];
  let statusAvailable = true;
  try {
    headCommit = await git(root, 'rev-parse', '--verify', 'HEAD');
  } catch {
    // An unborn branch legitimately has no HEAD commit.
  }
  ref = await headRef(root);
  try {
    entries = parseStatusEntries(await porcelainStatusNull(root));
  } catch {
    statusAvailable = false;
    limitations.push('git-status-unavailable');
  }

  const summary = summarize(entries);
  const indexFingerprint = statusAvailable
    ? await keyedFingerprint(options, 'index-state', canonicalEntries(entries, 'index'), limitations)
    : undefined;
  const worktreeFingerprint = statusAvailable
    ? await keyedFingerprint(options, 'worktree-state', canonicalEntries(entries, 'worktree'), limitations)
    : undefined;
  const state = headCommit ? (ref ? 'attached' : 'detached') : ref ? 'unborn' : 'unavailable';
  if (state === 'unavailable') limitations.push('git-head-state-unavailable');
  return {
    observation: {
      state,
      ...(headCommit === undefined ? {} : { headCommit }),
      ...(ref === undefined ? {} : { headRef: ref }),
      ...summary,
      ...(indexFingerprint === undefined ? {} : { indexFingerprint }),
      ...(worktreeFingerprint === undefined ? {} : { worktreeFingerprint }),
    },
    dirtyFiles: [...new Set(entries.map((entry) => entry.path))].sort(),
    entries,
    limitations,
  };
}

function completenessFor(
  repository: WorkspaceRepositoryIdentity,
  limitations: readonly string[],
): WorkspaceProvenanceCompleteness {
  if (repository.kind !== 'git') return 'partial';
  if (limitations.includes('git-status-unavailable') && limitations.includes('git-head-state-unavailable')) {
    return 'unavailable';
  }
  return limitations.length === 0 ? 'complete' : 'partial';
}

function now(options: WorkspaceProvenanceOptions | undefined): string {
  return (options?.now?.() ?? new Date()).toISOString();
}

export async function captureWorkspaceBaseline(input: CaptureBaselineInput): Promise<WorkspaceBaselineRecord> {
  const limitations: string[] = [];
  const repository = await repositoryIdentity(input.root, input.sourcePath, input.options, limitations);
  const gitState = await observeGit(input.root, repository, input.options);
  limitations.push(...gitState.limitations);
  const isolation = isolationForMode(input.mode);
  const knownConcurrentClaims = Math.max(0, Math.trunc(input.options?.knownConcurrentClaims ?? 0));
  return {
    schemaVersion: WORKSPACE_PROVENANCE_SCHEMA_VERSION,
    capturedAt: now(input.options),
    allocationMode: input.mode,
    isolation,
    knownConcurrentClaims,
    repository,
    git: gitState.observation,
    initialDirtyFiles: gitState.dirtyFiles,
    quality: qualityFor(isolation, gitState.dirtyFiles.length, knownConcurrentClaims > 0 ? 1 : 0),
    completeness: completenessFor(repository, limitations),
    limitations: [...new Set(limitations)].sort(),
  };
}

async function reachableCommitRange(
  root: string,
  initialCommit: string | undefined,
  finalCommit: string | undefined,
  limitations: string[],
): Promise<WorkspaceReachableCommitRange> {
  if (!initialCommit && !finalCommit) {
    return { relation: 'unchanged', commits: [], totalCount: 0, truncated: false };
  }
  if (initialCommit && !finalCommit) {
    return { relation: 'removed', initialCommit, commits: [], totalCount: 0, truncated: false };
  }
  if (initialCommit === finalCommit) {
    return {
      relation: 'unchanged',
      ...(initialCommit === undefined ? {} : { initialCommit }),
      ...(finalCommit === undefined ? {} : { finalCommit }),
      commits: [],
      totalCount: 0,
      truncated: false,
    };
  }

  let relation: WorkspaceReachableCommitRange['relation'] = initialCommit ? 'rewritten' : 'created';
  if (initialCommit && finalCommit) {
    try {
      if ((await git(root, 'merge-base', initialCommit, finalCommit)) === initialCommit) relation = 'fast-forward';
    } catch {
      // Unrelated histories are representable as rewritten rather than an observation failure.
    }
  }

  try {
    const revisionArgs = finalCommit ? [finalCommit, ...(initialCommit ? [`^${initialCommit}`] : [])] : [];
    const totalCount = Number(await git(root, 'rev-list', '--count', ...revisionArgs));
    const commits = (
      await git(root, 'rev-list', '--reverse', `--max-count=${MAX_REACHABLE_COMMITS + 1}`, ...revisionArgs)
    )
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_REACHABLE_COMMITS);
    const truncated = totalCount > commits.length;
    if (truncated) limitations.push('reachable-commit-list-truncated');
    return {
      relation,
      ...(initialCommit === undefined ? {} : { initialCommit }),
      ...(finalCommit === undefined ? {} : { finalCommit }),
      commits,
      totalCount,
      truncated,
    };
  } catch {
    limitations.push('reachable-commits-unavailable');
    return {
      relation: 'unavailable',
      ...(initialCommit === undefined ? {} : { initialCommit }),
      ...(finalCommit === undefined ? {} : { finalCommit }),
      commits: [],
      totalCount: 0,
      truncated: false,
    };
  }
}

function nullSeparatedPaths(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

async function committedFiles(
  root: string,
  initialCommit: string | undefined,
  finalCommit: string | undefined,
  limitations: string[],
): Promise<string[]> {
  if (!finalCommit || initialCommit === finalCommit) return [];
  try {
    if (initialCommit) {
      return nullSeparatedPaths(await git(root, 'diff', '--name-only', '-z', initialCommit, finalCommit));
    }
    return nullSeparatedPaths(await git(root, 'log', '--format=', '--name-only', '-z', '--reverse', finalCommit));
  } catch {
    limitations.push('committed-file-summary-unavailable');
    return [];
  }
}

function addStats(...values: Array<{ insertions: number; deletions: number }>): {
  insertions: number;
  deletions: number;
} {
  return values.reduce(
    (sum, value) => ({ insertions: sum.insertions + value.insertions, deletions: sum.deletions + value.deletions }),
    { insertions: 0, deletions: 0 },
  );
}

function parseAllShortstats(value: string): { insertions: number; deletions: number } {
  const lines = value.split('\n').filter((line) => /files? changed|insertions?|deletions?/.test(line));
  return addStats(...lines.map(parseShortstat));
}

async function changeStats(
  root: string,
  initialCommit: string | undefined,
  finalCommit: string | undefined,
  limitations: string[],
): Promise<{ insertions: number; deletions: number }> {
  try {
    if (initialCommit) return parseShortstat(await git(root, 'diff', '--shortstat', initialCommit));
    if (finalCommit) {
      return addStats(
        parseAllShortstats(await git(root, 'log', '--format=', '--shortstat', '--reverse', finalCommit)),
        parseShortstat(await git(root, 'diff', '--shortstat', finalCommit)),
      );
    }
    return addStats(
      parseShortstat(await git(root, 'diff', '--shortstat')),
      parseShortstat(await git(root, 'diff', '--cached', '--shortstat')),
    );
  } catch {
    limitations.push('change-stat-summary-unavailable');
    return { insertions: 0, deletions: 0 };
  }
}

export async function captureWorkspaceFinalization(
  input: CaptureFinalizationInput,
): Promise<WorkspaceFinalizationRecord> {
  const finalizedAt = now(input.options);
  const limitations: string[] = [];
  const repository = await repositoryIdentity(input.root, input.sourcePath, input.options, limitations);
  const finalGit = await observeGit(input.root, repository, input.options);
  limitations.push(...finalGit.limitations);
  const initialCommit = input.baseline.git.headCommit;
  const finalCommit = finalGit.observation.headCommit;
  const reachableCommits = await reachableCommitRange(input.root, initialCommit, finalCommit, limitations);
  const committed = await committedFiles(input.root, initialCommit, finalCommit, limitations);
  const initialDirty = new Set(input.baseline.initialDirtyFiles);
  const overlap = new Set([...committed, ...finalGit.dirtyFiles].filter((file) => initialDirty.has(file)));
  const filesTouched = [
    ...new Set([...committed, ...finalGit.dirtyFiles].filter((file) => !initialDirty.has(file))),
  ].sort();
  const stats = await changeStats(input.root, initialCommit, finalCommit, limitations);
  const filesFingerprint = await keyedFingerprint(
    input.options,
    'files-touched',
    JSON.stringify(filesTouched),
    limitations,
  );
  const knownConcurrentClaims = Math.max(
    input.baseline.knownConcurrentClaims,
    Math.max(0, Math.trunc(input.knownConcurrentClaims ?? 0)),
  );
  const interference: WorkspaceInterferenceObservation[] = [];
  if (knownConcurrentClaims > 0) {
    interference.push({ kind: 'known-concurrent-claim', observedAt: finalizedAt, count: knownConcurrentClaims });
  }
  if (overlap.size > 0) {
    interference.push({ kind: 'baseline-dirty-overlap', observedAt: finalizedAt, count: overlap.size });
  }
  const initialRepositoryPath =
    input.baseline.repository.canonicalCommonGitDirPath ?? input.baseline.repository.canonicalSourcePath;
  const finalRepositoryPath = repository.canonicalCommonGitDirPath ?? repository.canonicalSourcePath;
  if (initialRepositoryPath !== finalRepositoryPath || input.baseline.repository.kind !== repository.kind) {
    interference.push({ kind: 'repository-identity-changed', observedAt: finalizedAt });
  }
  if (limitations.length > 0) {
    interference.push({ kind: 'observation-gap', observedAt: finalizedAt, count: new Set(limitations).size });
  }

  const completeness = completenessFor(repository, limitations);
  return {
    schemaVersion: WORKSPACE_PROVENANCE_SCHEMA_VERSION,
    finalizedAt,
    outcome: completeness === 'complete' ? 'complete' : completeness === 'partial' ? 'partial' : 'unavailable',
    repository,
    git: finalGit.observation,
    reachableCommits,
    changes: {
      filesTouched,
      filesTouchedCount: filesTouched.length,
      ...(filesFingerprint === undefined ? {} : { filesFingerprint }),
      ...stats,
    },
    interference,
    knownConcurrentClaims,
    quality: qualityFor(input.baseline.isolation, input.baseline.initialDirtyFiles.length, interference.length),
    completeness,
    limitations: [...new Set(limitations)].sort(),
  };
}
