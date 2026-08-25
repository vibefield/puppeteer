/**
 * Session workspaces behind one handle.
 *
 * - direct:    use the caller's directory as-is; any number of agents may use it.
 * - exclusive: use the caller's directory as-is; the runtime owns the cooperative
 *              lease that prevents another direct/exclusive session there.
 * - worktree:  materialize a Git worktree outside the repository. Clean
 *              worktrees are removed on exit while their branch is retained;
 *              dirty worktrees are retained and can be adopted on resume.
 * - copy:      an internal/advanced provider for non-Git directory copies.
 */

import { randomUUID } from 'node:crypto';
import { cp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { filesFromPorcelain, git, gitPath, headCommit, isGitRepo, parseShortstat, porcelainStatus } from './git.js';
import {
  captureWorkspaceBaseline,
  captureWorkspaceFinalization,
  type WorkspaceAllocationMode,
  type WorkspaceBaselineRecord,
  type WorkspaceFinalizationRecord,
  type WorkspaceProvenanceOptions,
} from './provenance.js';

export type WorkspaceMode = WorkspaceAllocationMode;

export interface WorkspaceRequest {
  /** Working directory (direct/exclusive), repository (worktree), or source (copy). */
  path: string;
  mode: WorkspaceMode;
  /** New worktree: ref to branch from; default HEAD. */
  baseRef?: string;
  /** New worktree: branch name; default chopsticks/<id>. */
  branchName?: string;
  /** Resume a previously created worktree branch. */
  resumeBranch?: string;
  /** Adopt a retained worktree instead of materializing it again. */
  resumeRoot?: string;
  /** Where worktrees/copies materialize; default ~/.chopsticks/workspaces. */
  workspacesRoot?: string;
  /** Stable identity supplied only when reconstructing an already allocated workspace. */
  workspaceInstanceId?: string;
  /** Evidence policy supplied by the runtime; never serialized into provider options. */
  provenance?: WorkspaceProvenanceOptions;
}

export interface WorkspaceDiff {
  filesTouched: string[];
  insertions: number;
  deletions: number;
  /** Raw `status --porcelain` for display. Empty for non-git roots. */
  porcelain: string;
}

export interface WorkspaceSessionMetadata {
  workspaceInstanceId: string;
  /** @deprecated Use workspaceInstanceId. */
  id: string;
  root: string;
  sourcePath: string;
  mode: WorkspaceMode;
  branch?: string;
  initialCommit?: string;
  /** Files already dirty at creation, excluded from best-effort attribution. */
  initialDirtyFiles: string[];
  finalCommit?: string;
  finalDiff: WorkspaceDiff;
  filesTouched: string[];
  provenance: WorkspaceFinalizationRecord;
}

export interface WorkspaceFinalizationOptions {
  /** Other cooperative runtime claims still live at the final observation boundary. */
  knownConcurrentClaims?: number;
}

export interface Workspace {
  readonly workspaceInstanceId: string;
  /** @deprecated Use workspaceInstanceId. */
  readonly id: string;
  /** The session's cwd. */
  readonly root: string;
  /** Canonical identity used by the runtime's cooperative lease policy. */
  readonly identity: string;
  readonly mode: WorkspaceMode;
  readonly sourcePath: string;
  readonly branch?: string;
  readonly initialCommit?: string;
  readonly initialDirtyFiles: readonly string[];
  readonly baseline: WorkspaceBaselineRecord;
  diff(): Promise<WorkspaceDiff>;
  /** Idempotent: every caller receives the same first finalization attempt. */
  finalize(options?: WorkspaceFinalizationOptions): Promise<WorkspaceSessionMetadata>;
  destroy(options?: { force?: boolean; deleteBranch?: boolean }): Promise<void>;
}

export type WorkspaceErrorCode = 'WORKSPACE_CREATE_FAILED' | 'WORKSPACE_CONFLICT' | 'WORKSPACE_DIRTY';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

const DEFAULT_WORKSPACES_ROOT = path.join(homedir(), '.chopsticks', 'workspaces');

/**
 * Canonical cooperative-lock identity. Paths inside the same checkout (and
 * symlinks to it) collapse to that checkout's real Git top-level directory.
 */
export async function workspaceIdentity(source: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(source);
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `workspace source does not exist: ${source}`, {
      cause: err,
    });
  }

  if (!(await isGitRepo(resolved))) return resolved;
  try {
    return await realpath(await git(resolved, 'rev-parse', '--show-toplevel'));
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `could not resolve Git workspace root: ${source}`, {
      cause: err,
    });
  }
}

async function gitDiff(root: string): Promise<WorkspaceDiff> {
  if (!(await isGitRepo(root))) {
    return { filesTouched: [], insertions: 0, deletions: 0, porcelain: '' };
  }
  const porcelain = await porcelainStatus(root);
  const head = await headCommit(root);
  const shortstat = head ? await git(root, 'diff', 'HEAD', '--shortstat') : '';
  return {
    filesTouched: filesFromPorcelain(porcelain),
    ...parseShortstat(shortstat),
    porcelain,
  };
}

export async function createWorkspace(request: WorkspaceRequest): Promise<Workspace> {
  try {
    await stat(request.path);
  } catch {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `workspace source does not exist: ${request.path}`);
  }

  const workspaceInstanceId = request.workspaceInstanceId ?? randomUUID();
  if (
    workspaceInstanceId.length === 0 ||
    Buffer.byteLength(workspaceInstanceId, 'utf8') > 256 ||
    /[\0\r\n]/.test(workspaceInstanceId)
  ) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', 'workspaceInstanceId must be a bounded single-line value');
  }
  const workspacesRoot = request.workspacesRoot ?? DEFAULT_WORKSPACES_ROOT;

  switch (request.mode) {
    case 'direct':
    case 'exclusive':
      return createInPlace(workspaceInstanceId, request.path, request.mode, request.provenance);
    case 'worktree':
      return createWorktree(workspaceInstanceId, request, workspacesRoot);
    case 'copy':
      return createCopy(workspaceInstanceId, request.path, workspacesRoot, request.provenance);
  }
}

function makeFinalize(
  workspace: Omit<Workspace, 'finalize' | 'destroy'>,
  provenanceOptions?: WorkspaceProvenanceOptions,
): (options?: WorkspaceFinalizationOptions) => Promise<WorkspaceSessionMetadata> {
  let finalization: Promise<WorkspaceSessionMetadata> | undefined;
  return (options) => {
    finalization ??= (async () => {
      const finalDiff = await workspace.diff();
      const provenance = await captureWorkspaceFinalization({
        root: workspace.root,
        sourcePath: workspace.sourcePath,
        baseline: workspace.baseline,
        options: provenanceOptions,
        knownConcurrentClaims: options?.knownConcurrentClaims,
      });

      return {
        workspaceInstanceId: workspace.workspaceInstanceId,
        id: workspace.id,
        root: workspace.root,
        sourcePath: workspace.sourcePath,
        mode: workspace.mode,
        branch: workspace.branch,
        initialCommit: workspace.initialCommit,
        initialDirtyFiles: [...workspace.initialDirtyFiles],
        finalCommit: provenance.git.headCommit,
        finalDiff,
        filesTouched: [...provenance.changes.filesTouched],
        provenance,
      };
    })();
    return finalization;
  };
}

async function createInPlace(
  workspaceInstanceId: string,
  requestedRoot: string,
  mode: 'direct' | 'exclusive',
  provenanceOptions?: WorkspaceProvenanceOptions,
): Promise<Workspace> {
  const root = await realpath(requestedRoot);
  const identity = await workspaceIdentity(root);
  const baseline = await captureWorkspaceBaseline({ root, sourcePath: root, mode, options: provenanceOptions });
  const initialCommit = baseline.git.headCommit;
  const initialDirtyFiles = baseline.initialDirtyFiles;

  const base = {
    workspaceInstanceId,
    id: workspaceInstanceId,
    root,
    identity,
    mode,
    sourcePath: root,
    branch: undefined,
    initialCommit,
    initialDirtyFiles,
    baseline,
    diff: () => gitDiff(root),
  };
  return {
    ...base,
    finalize: makeFinalize(base, provenanceOptions),
    // In-place roots belong to the user and are never removed by this module.
    destroy: async () => undefined,
  };
}

async function assertRetainedWorktree(source: string, root: string, branch: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const entries = (await git(source, 'worktree', 'list', '--porcelain')).split('\n\n');
  const expectedBranch = `refs/heads/${branch}`;
  const match = entries.find((entry) => {
    const lines = entry.split('\n');
    // The registered path comes back in git's separator style, so it has to be
    // normalized before it can equal a realpath() result.
    const registered = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    return (
      registered !== undefined && gitPath(registered) === canonicalRoot && lines.includes(`branch ${expectedBranch}`)
    );
  });
  if (!match) {
    throw new WorkspaceError(
      'WORKSPACE_CREATE_FAILED',
      `retained worktree is not registered for branch ${branch}: ${canonicalRoot}`,
    );
  }
}

async function createWorktree(
  workspaceInstanceId: string,
  request: WorkspaceRequest,
  workspacesRoot: string,
): Promise<Workspace> {
  if (!(await isGitRepo(request.path))) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `worktree mode requires a git repository: ${request.path}`);
  }
  if (request.resumeRoot && !request.resumeBranch) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', 'resumeRoot requires resumeBranch');
  }

  const sourcePath = await workspaceIdentity(request.path);
  const branch = request.resumeBranch ?? request.branchName ?? `chopsticks/${workspaceInstanceId}`;
  let root = path.join(workspacesRoot, workspaceInstanceId);
  if (request.resumeRoot) {
    try {
      root = await realpath(request.resumeRoot);
    } catch (err) {
      throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `retained worktree does not exist: ${request.resumeRoot}`, {
        cause: err,
      });
    }
  }

  if (request.resumeRoot) {
    await assertRetainedWorktree(sourcePath, root, branch);
  } else {
    await mkdir(workspacesRoot, { recursive: true });
    try {
      if (request.resumeBranch) await git(sourcePath, 'worktree', 'add', root, branch);
      else await git(sourcePath, 'worktree', 'add', '-b', branch, root, request.baseRef ?? 'HEAD');
    } catch (err) {
      throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `git worktree add failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
    root = await realpath(root);
  }

  const baseline = await captureWorkspaceBaseline({
    root,
    sourcePath,
    mode: 'worktree',
    options: request.provenance,
  });
  const initialDirtyFiles = baseline.initialDirtyFiles;
  const workspaceBase = {
    workspaceInstanceId,
    id: workspaceInstanceId,
    root,
    identity: await workspaceIdentity(root),
    mode: 'worktree' as const,
    sourcePath,
    branch,
    initialCommit: baseline.git.headCommit,
    initialDirtyFiles,
    baseline,
    diff: () => gitDiff(root),
  };
  return {
    ...workspaceBase,
    finalize: makeFinalize(workspaceBase, request.provenance),
    async destroy(options) {
      if (!options?.force) {
        const dirty = filesFromPorcelain(await porcelainStatus(root));
        if (dirty.length > 0) {
          throw new WorkspaceError(
            'WORKSPACE_DIRTY',
            `worktree has ${dirty.length} uncommitted change(s); destroy with { force: true } to discard`,
          );
        }
      }
      const args = ['worktree', 'remove', root];
      if (options?.force) args.push('--force');
      await git(sourcePath, ...args);
      // The branch is the work product; deletion is an explicit choice.
      if (options?.deleteBranch) await git(sourcePath, 'branch', '-D', branch);
    },
  };
}

async function createCopy(
  workspaceInstanceId: string,
  source: string,
  workspacesRoot: string,
  provenanceOptions?: WorkspaceProvenanceOptions,
): Promise<Workspace> {
  const sourcePath = await realpath(source);
  const root = path.join(workspacesRoot, workspaceInstanceId);
  await mkdir(workspacesRoot, { recursive: true });
  try {
    await cp(sourcePath, root, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `copy failed: ${(err as Error).message}`, { cause: err });
  }

  const baseline = await captureWorkspaceBaseline({
    root,
    sourcePath,
    mode: 'copy',
    options: provenanceOptions,
  });
  const base = {
    workspaceInstanceId,
    id: workspaceInstanceId,
    root,
    identity: await realpath(root),
    mode: 'copy' as const,
    sourcePath,
    branch: undefined,
    initialCommit: baseline.git.headCommit,
    initialDirtyFiles: baseline.initialDirtyFiles,
    baseline,
    diff: () => gitDiff(root),
  };
  return {
    ...base,
    finalize: makeFinalize(base, provenanceOptions),
    async destroy() {
      // Only ever remove what this module materialized.
      if (!root.startsWith(workspacesRoot + path.sep)) {
        throw new WorkspaceError('WORKSPACE_CREATE_FAILED', `refusing to remove path outside workspacesRoot: ${root}`);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
