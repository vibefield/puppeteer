#!/usr/bin/env node
/** Execute only the bounded `--version` probe in an isolated home. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function safePath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('path is required');
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

export function validateVersionOutput(output, version) {
  const value = String(output ?? '').trim();
  if (!value || value.length > 256 || /[\r\n]/.test(value)) throw new Error('version output must be one bounded line');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(?:^|[^0-9])${escaped}(?:[^0-9]|$)`).test(value)) {
    throw new Error(`version output does not identify ${version}`);
  }
  return value;
}

export function probeAgentArtifact({ artifact, version, output, home, environment = process.env }) {
  const artifactPath = safePath(artifact);
  const outputPath = safePath(output);
  const homePath = safePath(home);
  mkdirSync(homePath, { recursive: true });
  if (process.platform !== 'win32') chmodSync(artifactPath, 0o755);
  const inherited = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(inherited.filter((key) => environment[key]).map((key) => [key, environment[key]]));
  env.HOME = homePath;
  env.USERPROFILE = homePath;
  env.NO_COLOR = '1';
  const result = spawnSync(artifactPath, ['--version'], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 4_096,
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`artifact version probe failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  const value = validateVersionOutput(result.stdout || result.stderr, version);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${value}\n`);
  return value;
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  console.log(
    probeAgentArtifact({
      artifact: flag('--artifact'),
      version: flag('--version'),
      output: flag('--output'),
      home: flag('--home'),
    }),
  );
}
