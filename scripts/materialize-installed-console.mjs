#!/usr/bin/env node
/** Materialize and attest a locked Python console from a reviewed source archive. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../packages/surface/scripts/check-evidence.mjs';
import { createInstalledConsoleManifest, validatePythonUvLockPolicy } from './lib/installed-console-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pythonTool = resolve(root, 'scripts', 'lib', 'python-console-tool.py');

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safePath(repoRoot, path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('repository path is required');
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(`${resolve(repoRoot)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

function portablePath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

function sha256File(path) {
  const digest = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${digest.digest('hex')}`;
}

function snapshotTree(treeRoot, current = treeRoot) {
  const snapshot = new Map();
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [name, digest] of snapshotTree(treeRoot, path)) snapshot.set(name, digest);
    } else if (entry.isFile()) {
      snapshot.set(relative(treeRoot, path).split(sep).join('/'), sha256File(path));
    } else {
      throw new Error(`source tree contains a non-regular entry: ${portablePath(treeRoot, path)}`);
    }
  }
  return snapshot;
}

function attestSourceChanges(projectRoot, before, generatedRoots) {
  const after = snapshotTree(projectRoot);
  for (const [path, digest] of before) {
    if (after.get(path) !== digest) throw new Error(`source install changed archive file ${path}`);
  }
  const generated = [...after.keys()].filter((path) => !before.has(path));
  const belongsTo = (path, rootPath) => path === rootPath || path.startsWith(`${rootPath}/`);
  const unexpected = generated.filter((path) => !generatedRoots.some((rootPath) => belongsTo(path, rootPath)));
  if (unexpected.length > 0) throw new Error(`source install generated an unreviewed path ${unexpected[0]}`);
  for (const rootPath of generatedRoots) {
    if (!generated.some((path) => belongsTo(path, rootPath))) {
      throw new Error(`source install did not generate reviewed path ${rootPath}`);
    }
    if ([...before.keys()].some((path) => belongsTo(path, rootPath))) {
      throw new Error(`generated source path overlaps the downloaded archive: ${rootPath}`);
    }
  }
  const digest = createHash('sha256').update('sha256-generated-source-trees-v1\0');
  for (const rootPath of [...generatedRoots].sort()) {
    const absolute = join(projectRoot, ...rootPath.split('/'));
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`generated source root is not a directory: ${rootPath}`);
    }
    digest.update(rootPath);
    digest.update('\0');
    digest.update(digestTree(absolute));
    digest.update('\0');
  }
  return {
    roots: [...generatedRoots],
    fileCount: generated.length,
    digestAlgorithm: 'sha256-generated-source-trees-v1',
    sha256: `sha256:${digest.digest('hex')}`,
  };
}

function command(name) {
  if (typeof name !== 'string' || !name || /[\u0000\r\n]/.test(name)) throw new Error('command is required');
  return name;
}

function run(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit ${result.status}`;
    throw new Error(`${options.label ?? commandName} failed: ${detail}`);
  }
  return result.stdout;
}

function isolatedEnvironment(workRoot, names, environment = process.env) {
  const inherited = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const value = Object.fromEntries(inherited.filter((key) => environment[key]).map((key) => [key, environment[key]]));
  const home = join(workRoot, 'home');
  mkdirSync(home, { recursive: true });
  value.HOME = home;
  value.USERPROFILE = home;
  value.NO_COLOR = '1';
  value.PYTHONDONTWRITEBYTECODE = '1';
  value.UV_NO_ENV_FILE = '1';
  for (const name of names) value[name] = home;
  return value;
}

function validateDownloadMetadata(metadata, expected, archivePath, repoRoot) {
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.vendor !== expected.vendor ||
    metadata.version !== expected.version ||
    metadata.platform !== expected.platform
  ) {
    throw new Error('source download metadata identity differs from the requested console');
  }
  if (metadata.artifactKind !== 'source-archive') throw new Error('installed consoles require source-archive metadata');
  if (resolve(repoRoot, metadata.output) !== archivePath)
    throw new Error('source metadata output differs from the archive');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metadata.sourceReference ?? '')) {
    throw new Error('source download metadata has no normalized release reference');
  }
  if (typeof metadata.archiveRoot !== 'string' || !metadata.archiveRoot) {
    throw new Error('source download metadata has no reviewed archive root');
  }
}

export function materializeInstalledConsole({
  repoRoot = root,
  vendor,
  version,
  platform,
  sourceArchive,
  sourceMetadata,
  work,
  output,
  metadataOutput,
  versionOutput,
  python = 'python',
  uv = 'uv',
  environment = process.env,
}) {
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('invalid vendor');
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('invalid version');
  const upstream = json(resolve(repoRoot, 'packages', 'surface', 'vendors', vendor, 'upstream.json'));
  if (upstream.vendor !== vendor || upstream.acquisition?.strategy !== 'source-revision') {
    throw new Error(`${vendor} has no source-revision acquisition policy`);
  }
  if (!(upstream.platforms ?? []).includes(platform)) throw new Error(`unsupported platform ${platform}`);
  const sourcePolicy = upstream.acquisition.sourceArchive;
  const policy = upstream.acquisition.installedConsole;
  validatePythonUvLockPolicy(policy);
  const archivePath = safePath(repoRoot, sourceArchive);
  const sourceMetadataPath = safePath(repoRoot, sourceMetadata);
  const workRoot = safePath(repoRoot, work);
  const outputPath = safePath(repoRoot, output);
  const metadataPath = safePath(repoRoot, metadataOutput);
  const versionPath = safePath(repoRoot, versionOutput);
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) throw new Error('source archive is missing');
  if (existsSync(workRoot)) throw new Error('installed-console work directory already exists');
  for (const path of [outputPath, metadataPath, versionPath]) {
    if (existsSync(path)) throw new Error(`installed-console output already exists: ${portablePath(repoRoot, path)}`);
  }
  const downloadMetadata = json(sourceMetadataPath);
  validateDownloadMetadata(downloadMetadata, { vendor, version, platform }, archivePath, repoRoot);

  const pythonCommand = command(python);
  const uvCommand = command(uv);
  mkdirSync(workRoot, { recursive: true });
  const env = isolatedEnvironment(workRoot, policy.isolatedHomeEnvironment, environment);
  const pythonVersionText = run(pythonCommand, ['--version'], { env, label: 'Python identity probe' }).trim();
  if (pythonVersionText !== `Python ${policy.pythonVersion}`) {
    throw new Error(`Python identity is ${pythonVersionText || 'unknown'}, expected Python ${policy.pythonVersion}`);
  }
  const uvVersionText = run(uvCommand, ['--version'], { env, label: 'uv identity probe' }).trim();
  if (!new RegExp(`^uv ${policy.uvVersion.replaceAll('.', '\\.')}(?:\\s|$)`).test(uvVersionText)) {
    throw new Error(`uv identity is ${uvVersionText || 'unknown'}, expected uv ${policy.uvVersion}`);
  }

  const projectRoot = join(workRoot, 'project');
  run(
    pythonCommand,
    [
      pythonTool,
      'extract',
      '--archive',
      archivePath,
      '--format',
      sourcePolicy.format,
      '--archive-root',
      downloadMetadata.archiveRoot,
      '--destination',
      projectRoot,
      '--max-extracted-bytes',
      String(sourcePolicy.maxExtractedBytes),
    ],
    { env, label: 'source archive extraction' },
  );
  const projectFile = join(projectRoot, policy.projectFile);
  const lockFile = join(projectRoot, policy.lockFile);
  if (!existsSync(projectFile) || !existsSync(lockFile))
    throw new Error('source archive lacks the install identity files');
  const sourceTreeSha256 = `sha256:${digestTree(projectRoot)}`;
  const sourceSnapshot = snapshotTree(projectRoot);

  const environmentRoot = join(workRoot, 'python-environment');
  env.UV_PROJECT_ENVIRONMENT = environmentRoot;
  env.UV_NO_PYTHON_DOWNLOADS = '1';
  env.UV_NO_ENV_FILE = '1';
  const syncArguments = [
    'sync',
    '--frozen',
    '--no-default-groups',
    '--no-python-downloads',
    '--no-cache',
    '--python',
    pythonCommand,
  ];
  if (policy.installMode === 'non-editable') syncArguments.splice(2, 0, '--no-editable');
  run(uvCommand, syncArguments, {
    cwd: projectRoot,
    env,
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    label: 'locked uv sync',
  });

  const windows = platform === 'windows-x64';
  const installedPython = join(environmentRoot, windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
  const installedConsole = join(
    environmentRoot,
    windows ? 'Scripts' : 'bin',
    windows ? `${policy.consoleScript}.exe` : policy.consoleScript,
  );
  if (!existsSync(installedPython) || !existsSync(installedConsole)) {
    throw new Error('locked uv sync did not materialize the declared console');
  }
  const generatedSource = attestSourceChanges(projectRoot, sourceSnapshot, policy.generatedSourcePaths);
  const inventoryArguments = [
    pythonTool,
    'inventory',
    '--distribution',
    policy.distribution,
    '--console',
    policy.consoleScript,
    '--source-root',
    projectRoot,
  ];
  if (policy.installMode === 'editable') inventoryArguments.push('--editable');
  const inventory = JSON.parse(
    run(installedPython, inventoryArguments, {
      env,
      timeout: 5 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      label: 'installed Python inventory',
    }),
  );
  const observedVersion = run(installedConsole, ['--version'], {
    env,
    timeout: 20_000,
    maxBuffer: 4_096,
    label: 'installed console version probe',
  });
  const manifest = createInstalledConsoleManifest({
    vendor,
    version,
    platform,
    downloadMetadata,
    archiveSha256: sha256File(archivePath),
    sourceTreeSha256,
    generatedSource,
    projectFileSha256: sha256File(projectFile),
    lockFileSha256: sha256File(lockFile),
    policy,
    inventory,
    versionOutput: observedVersion,
  });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const path of [outputPath, metadataPath, versionPath]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(outputPath, serialized);
  writeFileSync(versionPath, `${manifest.console.versionOutput}\n`);
  const metadata = {
    schemaVersion: 1,
    vendor,
    version,
    platform,
    artifactKind: 'installed-console',
    output: portablePath(repoRoot, outputPath),
    bytes: Buffer.byteLength(serialized),
    sourceUrl: downloadMetadata.sourceUrl,
    sourceReference: downloadMetadata.sourceReference,
    sourceArchiveSha256: manifest.source.archiveSha256,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { manifest, metadata };
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = materializeInstalledConsole({
    vendor: flag('--vendor'),
    version: flag('--version'),
    platform: flag('--platform'),
    sourceArchive: flag('--source-archive'),
    sourceMetadata: flag('--source-metadata'),
    work: flag('--work'),
    output: flag('--output'),
    metadataOutput: flag('--metadata'),
    versionOutput: flag('--version-output'),
    python: flag('--python', 'python'),
    uv: flag('--uv', 'uv'),
  });
  console.log(JSON.stringify(result.metadata));
}
