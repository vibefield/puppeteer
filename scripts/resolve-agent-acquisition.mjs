#!/usr/bin/env node
/** Resolve declarative artifact policy for one platform without vendor-specific workflow branches. */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePythonUvLockPolicy } from './lib/installed-console-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function resolveAgentAcquisition(config, { vendor, platform, sourceReference }) {
  if (config.vendor !== vendor) throw new Error('upstream configuration vendor mismatch');
  if (!(config.platforms ?? []).includes(platform)) throw new Error(`unsupported platform ${platform}`);
  if (config.acquisition?.strategy === 'https-template') {
    return {
      artifactKind: 'standalone-executable',
      outputName: platform === 'windows-x64' ? 'agent.exe' : 'agent',
    };
  }
  if (config.acquisition?.strategy !== 'source-revision') throw new Error('unsupported acquisition strategy');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceReference ?? '')) {
    throw new Error('source-revision acquisition requires --source-reference');
  }
  const installed = config.acquisition.installedConsole;
  validatePythonUvLockPolicy(installed);
  if (!['tar.gz', 'zip'].includes(config.acquisition.sourceArchive?.format)) {
    throw new Error('unsupported source archive format');
  }
  const scriptsDirectory = platform === 'windows-x64' ? 'Scripts' : 'bin';
  return {
    artifactKind: 'installed-console',
    outputName: 'installed-console.json',
    sourceFile: config.acquisition.sourceArchive.format === 'zip' ? 'source.zip' : 'source.tar.gz',
    sourceReference,
    pythonVersion: installed.pythonVersion,
    uvVersion: installed.uvVersion,
    consolePath: `${scriptsDirectory}/${installed.consoleScript}${platform === 'windows-x64' ? '.exe' : ''}`,
    pythonPath: `${scriptsDirectory}/python${platform === 'windows-x64' ? '.exe' : ''}`,
    ...(installed.runtimeBundle
      ? {
          nodeVersion: installed.runtimeBundle.nodeVersion,
          npmVersion: installed.runtimeBundle.npmVersion,
          runtimeRoot: 'runtime',
        }
      : {}),
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendor = flag('--vendor');
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('invalid vendor');
  const config = JSON.parse(
    readFileSync(resolve(root, 'packages', 'surface', 'vendors', vendor, 'upstream.json'), 'utf8'),
  );
  const policy = resolveAgentAcquisition(config, {
    vendor,
    platform: flag('--platform'),
    sourceReference: flag('--source-reference'),
  });
  if (process.argv.includes('--github-output')) {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    for (const [name, value] of Object.entries(policy)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    }
  } else {
    console.log(JSON.stringify(policy));
  }
}
