import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commonGitDirectory, git } from './git.js';
import type { WorkspaceKeyedDigest } from './provenance.js';
import { createWorkspace } from './workspace.js';

function digester(key: string): WorkspaceKeyedDigest {
  return (domain, value) => createHmac('sha256', key).update(domain).update('\0').update(value).digest('hex');
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ws-provenance-repo-'));
  await git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return repo;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, 'add', '.');
  await git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

describe('workspace provenance baseline', () => {
  it('uses a durable instance id and a repository digest shared by worktrees', async () => {
    const repo = await makeRepo();
    const workspacesRoot = await mkdtemp(join(tmpdir(), 'ws-provenance-root-'));
    const keyedDigest = digester('installation-one');
    const direct = await createWorkspace({ path: repo, mode: 'direct', provenance: { keyedDigest } });
    const worktree = await createWorkspace({
      path: repo,
      mode: 'worktree',
      workspacesRoot,
      provenance: { keyedDigest },
    });

    expect(direct.workspaceInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(direct.id).toBe(direct.workspaceInstanceId);
    expect(worktree.baseline.repository.canonicalCommonGitDirPath).toBe(await commonGitDirectory(repo));
    expect(worktree.baseline.repository.digest).toEqual(direct.baseline.repository.digest);
    expect(worktree.baseline.isolation).toBe('managed-isolated');
    expect(direct.baseline.isolation).toBe('shared');

    const otherInstallation = await createWorkspace({
      path: repo,
      mode: 'direct',
      provenance: { keyedDigest: digester('installation-two') },
    });
    expect(otherInstallation.baseline.repository.digest).not.toEqual(direct.baseline.repository.digest);
    await worktree.destroy();
  });

  it('separates index, worktree, conflict-safe untracked summaries and fingerprints', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'staged.ts'), 'staged\n');
    await git(repo, 'add', 'staged.ts');
    await writeFile(join(repo, 'README.md'), 'modified\n');
    await writeFile(join(repo, 'untracked name.ts'), 'untracked\n');

    const workspace = await createWorkspace({
      path: repo,
      mode: 'exclusive',
      provenance: { keyedDigest: digester('installation') },
    });
    expect(workspace.baseline.git).toMatchObject({
      state: 'attached',
      headRef: 'refs/heads/main',
      index: { total: 1, added: 1, untracked: 0 },
      worktree: { total: 2, modified: 1, untracked: 1 },
      conflicts: 0,
      indexFingerprint: { algorithm: 'hmac-sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
      worktreeFingerprint: { algorithm: 'hmac-sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(workspace.initialDirtyFiles).toEqual(['README.md', 'staged.ts', 'untracked name.ts']);
    expect(workspace.baseline.isolation).toBe('cooperative-exclusive');
  });

  it('represents detached and non-Git baselines without inventing a branch or commit', async () => {
    const repo = await makeRepo();
    await git(repo, 'checkout', '--detach');
    const detached = await createWorkspace({ path: repo, mode: 'direct' });
    expect(detached.baseline.git).toMatchObject({ state: 'detached', headCommit: expect.any(String) });
    expect(detached.baseline.git.headRef).toBeUndefined();

    const directory = await mkdtemp(join(tmpdir(), 'ws-provenance-directory-'));
    const plain = await createWorkspace({ path: directory, mode: 'direct' });
    expect(plain.baseline).toMatchObject({
      completeness: 'partial',
      repository: { kind: 'directory' },
      git: { state: 'non-git' },
    });
  });
});

describe('workspace provenance finalization', () => {
  it('captures reachable commits while excluding initially dirty files from newly touched files', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'preexisting.txt'), 'already here\n');
    const workspace = await createWorkspace({
      path: repo,
      mode: 'direct',
      provenance: { keyedDigest: digester('installation'), knownConcurrentClaims: 2 },
    });
    await writeFile(join(repo, 'new.ts'), 'new\n');
    const finalCommit = await commit(repo, 'session changes');

    const metadata = await workspace.finalize({ knownConcurrentClaims: 3 });
    expect(metadata.finalCommit).toBe(finalCommit);
    expect(metadata.filesTouched).toEqual(['new.ts']);
    expect(metadata.provenance).toMatchObject({
      outcome: 'complete',
      reachableCommits: {
        relation: 'fast-forward',
        commits: [finalCommit],
        totalCount: 1,
        truncated: false,
      },
      changes: {
        filesTouched: ['new.ts'],
        filesTouchedCount: 1,
        filesFingerprint: { algorithm: 'hmac-sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
      knownConcurrentClaims: 3,
      interference: expect.arrayContaining([
        expect.objectContaining({ kind: 'known-concurrent-claim', count: 3 }),
        expect.objectContaining({ kind: 'baseline-dirty-overlap', count: 1 }),
      ]),
    });
  });

  it('finalizes exactly once and keeps the first Git boundary after later changes', async () => {
    const repo = await makeRepo();
    const workspace = await createWorkspace({ path: repo, mode: 'direct' });
    await writeFile(join(repo, 'first.ts'), 'first\n');
    const firstCommit = await commit(repo, 'first');
    const firstFinalization = await workspace.finalize();

    await writeFile(join(repo, 'second.ts'), 'second\n');
    await commit(repo, 'second');
    const repeated = await workspace.finalize();
    expect(repeated).toBe(firstFinalization);
    expect(repeated.finalCommit).toBe(firstCommit);
    expect(repeated.provenance.reachableCommits.commits).toEqual([firstCommit]);
  });

  it('represents a repository created from an unborn branch and a deleted branch at detached HEAD', async () => {
    const unchangedUnbornRepo = await mkdtemp(join(tmpdir(), 'ws-provenance-empty-unborn-'));
    await git(unchangedUnbornRepo, 'init', '-b', 'main');
    const unchangedUnborn = await createWorkspace({ path: unchangedUnbornRepo, mode: 'direct' });
    const noCommitFinal = await unchangedUnborn.finalize();
    expect(noCommitFinal.initialCommit).toBeUndefined();
    expect(noCommitFinal.finalCommit).toBeUndefined();
    expect(noCommitFinal.provenance.reachableCommits).toMatchObject({
      relation: 'unchanged',
      commits: [],
      totalCount: 0,
    });

    const unbornRepo = await mkdtemp(join(tmpdir(), 'ws-provenance-unborn-'));
    await git(unbornRepo, 'init', '-b', 'main');
    const unborn = await createWorkspace({ path: unbornRepo, mode: 'direct' });
    expect(unborn.baseline.git).toMatchObject({ state: 'unborn', headRef: 'refs/heads/main' });
    await writeFile(join(unbornRepo, 'root.txt'), 'root\n');
    const createdCommit = await commit(unbornRepo, 'root');
    const created = await unborn.finalize();
    expect(created.filesTouched).toEqual(['root.txt']);
    expect(created.provenance.reachableCommits).toMatchObject({
      relation: 'created',
      commits: [createdCommit],
    });

    const repo = await makeRepo();
    const workspace = await createWorkspace({ path: repo, mode: 'direct' });
    await git(repo, 'checkout', '--detach');
    await git(repo, 'branch', '-D', 'main');
    const finalized = await workspace.finalize();
    expect(finalized.provenance.git).toMatchObject({ state: 'detached' });
    expect(finalized.provenance.git.headRef).toBeUndefined();
  });

  it('represents clean, squashed, and rewritten history without assuming commit authorship', async () => {
    const cleanRepo = await makeRepo();
    const clean = await createWorkspace({ path: cleanRepo, mode: 'direct' });
    expect((await clean.finalize()).provenance.reachableCommits).toEqual({
      relation: 'unchanged',
      initialCommit: clean.initialCommit,
      finalCommit: clean.initialCommit,
      commits: [],
      totalCount: 0,
      truncated: false,
    });

    const squashRepo = await makeRepo();
    const squash = await createWorkspace({ path: squashRepo, mode: 'direct' });
    await writeFile(join(squashRepo, 'one.ts'), 'one\n');
    await commit(squashRepo, 'one');
    await writeFile(join(squashRepo, 'two.ts'), 'two\n');
    await commit(squashRepo, 'two');
    await git(squashRepo, 'reset', '--soft', squash.initialCommit!);
    const squashedCommit = await commit(squashRepo, 'squashed');
    const squashed = await squash.finalize();
    expect(squashed.filesTouched).toEqual(['one.ts', 'two.ts']);
    expect(squashed.provenance.reachableCommits).toMatchObject({
      relation: 'fast-forward',
      commits: [squashedCommit],
      totalCount: 1,
    });

    const rewrittenRepo = await makeRepo();
    const rewritten = await createWorkspace({ path: rewrittenRepo, mode: 'direct' });
    await git(rewrittenRepo, 'checkout', '--orphan', 'rewritten-history');
    await git(rewrittenRepo, 'rm', '-r', '--force', '.');
    await writeFile(join(rewrittenRepo, 'replacement.ts'), 'replacement\n');
    const rewrittenCommit = await commit(rewrittenRepo, 'replacement root');
    expect((await rewritten.finalize()).provenance.reachableCommits).toMatchObject({
      relation: 'rewritten',
      commits: [rewrittenCommit],
      totalCount: 1,
    });
  });
});
