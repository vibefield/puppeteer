import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publicPackages } from '../public-packages.mjs';
import { repositoryUrl } from '../release-packages.mjs';

export const ok = (data) => ({ status: 0, stdout: JSON.stringify(data) });
export const npmError = (code) => ({ status: 1, stdout: JSON.stringify({ error: { code } }) });

export function releaseFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'puppeteer-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, version: '1.2.3' }));
  for (const [directory, name] of publicPackages) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(
      join(root, directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.2.3',
        type: 'module',
        repository: { type: 'git', url: repositoryUrl, directory },
        publishConfig: { access: 'public' },
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      }),
    );
  }
  mkdirSync(join(root, 'support'));
  writeFileSync(join(root, 'support/agents.json'), '{"agents":[]}');
  return root;
}

export function updateManifest(root, directory, edit) {
  const path = join(root, directory, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  return manifest;
}

export function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tagFixture(root) {
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'release fixture',
  );
  git(root, '-c', 'tag.gpgsign=false', 'tag', 'v1.2.3');
}

export function fakePack(root, args) {
  const directory = args[1];
  const destination = args[4];
  const manifest = readFileSync(join(root, directory, 'package.json'));
  const staging = mkdtempSync(join(tmpdir(), 'puppeteer-test-pack-'));
  try {
    mkdirSync(join(staging, 'package/dist'), { recursive: true });
    writeFileSync(join(staging, 'package/package.json'), manifest);
    writeFileSync(join(staging, 'package/dist/index.js'), 'export {};');
    writeFileSync(join(staging, 'package/dist/index.d.ts'), 'export {};');
    execFileSync('tar', [
      '-czf',
      join(destination, `${directory.slice('packages/'.length)}.tgz`),
      '-C',
      staging,
      'package',
    ]);
    return { status: 0 };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
