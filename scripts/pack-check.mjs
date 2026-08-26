import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicPackages } from './public-packages.mjs';
import { spawnPackageManager } from './package-manager.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = mkdtempSync(join(tmpdir(), 'puppeteer-packs-'));

try {
  for (const [directory, packageName] of publicPackages) {
    const before = new Set(readdirSync(destination));
    const result = spawnPackageManager('pnpm', ['--dir', directory, 'pack', '--pack-destination', destination], {
      cwd: root,
      stdio: 'inherit',
    });

    if (result.status !== 0) {
      throw new Error(`Failed to pack ${directory}`);
    }
    const tarball = readdirSync(destination).find((file) => file.endsWith('.tgz') && !before.has(file));
    if (!tarball) throw new Error(`Could not identify tarball for ${directory}`);
    const entries = execFileSync('tar', ['-tzf', join(destination, tarball)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    if (!entries.some((entry) => entry.startsWith('package/dist/'))) {
      throw new Error(`${packageName} tarball contains no dist output`);
    }
    if (directory === 'packages/surface') {
      const support = JSON.parse(readFileSync(join(root, 'support', 'agents.json'), 'utf8'));
      const groundTruthFiles = support.agents
        .filter((agent) => agent.groundTruth)
        .map((agent) => `package/${agent.groundTruth.replace(/^packages\/surface\//, '')}`);
      for (const groundTruth of groundTruthFiles) {
        if (!entries.includes(groundTruth)) throw new Error(`${packageName} tarball is missing ${groundTruth}`);
      }
      const forbidden = entries.find(
        (entry) =>
          /\/(captures|captures-raw|model|probes|references)\//.test(entry) ||
          /\/(findings\.md|groundtruth\.html|upstream\.json)$/.test(entry),
      );
      if (forbidden) throw new Error(`${packageName} tarball leaks repo-only evidence: ${forbidden}`);
    }
    if (directory.startsWith('packages/adapter-')) {
      const forbidden = entries.find(
        (entry) =>
          entry.startsWith('package/surface/') ||
          entry.startsWith('package/scripts/') ||
          entry.includes('/test-support/') ||
          /\.(?:live\.)?test\.(?:js|d\.ts|js\.map|d\.ts\.map)$/.test(entry),
      );
      if (forbidden) throw new Error(`${packageName} tarball leaks repository-only adapter content: ${forbidden}`);
    }
    if (directory === 'packages/testing' && entries.some((entry) => entry.startsWith('package/fixtures/'))) {
      throw new Error(`${packageName} tarball contains vendor fixtures`);
    }
  }

  const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz'));

  if (tarballs.length !== publicPackages.length) {
    throw new Error(`Expected ${publicPackages.length} tarballs, found ${tarballs.length}`);
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
