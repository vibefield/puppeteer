/** Materialize one reviewed Node workspace bundle without running dependency lifecycle scripts. */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  createNodeRuntimeBundleManifest,
  inventoryRuntimeBundle,
  validateNodeRuntimeBundlePolicy,
} from './runtime-bundle-contract.mjs';

function at(root, path) {
  return join(root, ...path.split('/'));
}

function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function sourceSnapshot(root, excluded, current = root) {
  const snapshot = new Map();
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(current, entry.name);
    const name = relative(root, path).split(sep).join('/');
    if (excluded.some((excludedPath) => name === excludedPath || name.startsWith(`${excludedPath}/`))) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error(`runtime bundle build contains a symbolic link outside dependencies: ${name}`);
    if (info.isDirectory()) {
      for (const [nested, digest] of sourceSnapshot(root, excluded, path)) snapshot.set(nested, digest);
    } else if (info.isFile()) snapshot.set(name, sha256File(path));
    else throw new Error(`runtime bundle build contains a non-regular source entry: ${name}`);
  }
  return snapshot;
}

function assertSameSnapshot(before, after) {
  if (before.size !== after.size) throw new Error('runtime bundle build changed files outside its confined outputs');
  for (const [path, digest] of before) {
    if (after.get(path) !== digest) throw new Error(`runtime bundle build changed reviewed source file ${path}`);
  }
}

function copyRegularTree(sourceRoot, destinationRoot, current = sourceRoot) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const source = join(current, entry.name);
    const destination = join(destinationRoot, relative(sourceRoot, source));
    const info = lstatSync(source);
    if (info.isSymbolicLink()) throw new Error('runtime bundle output contains a symbolic link');
    if (info.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      copyRegularTree(sourceRoot, destinationRoot, source);
    } else if (info.isFile()) {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    } else throw new Error('runtime bundle output contains a non-regular entry');
  }
}

function exactVersion(run, command, args, expected, label, options = {}) {
  const actual = run(command, args, { ...options, label }).trim();
  if (actual !== expected) throw new Error(`${label} is ${actual || 'unknown'}, expected ${expected}`);
  return actual;
}

export function materializeNodeRuntimeBundle({ projectRoot, artifactRoot, policy, node, npm, environment, run }) {
  validateNodeRuntimeBundlePolicy(policy);
  exactVersion(run, node, ['--version'], `v${policy.nodeVersion}`, 'Node identity probe', { env: environment });
  exactVersion(run, npm, ['--version'], policy.npmVersion, 'npm identity probe', { env: environment });

  const nodeExecutableOutput = run(node, ['-p', 'process.execPath'], {
    env: environment,
    label: 'Node executable probe',
  }).trim();
  const nodeExecutable = resolve(nodeExecutableOutput);
  if (!nodeExecutableOutput || !existsSync(nodeExecutable) || !statSync(nodeExecutable).isFile()) {
    throw new Error('Node executable probe did not resolve a regular file');
  }

  const identity = Object.fromEntries(
    ['packageFile', 'lockFile', 'workspacePackageFile', 'buildFile'].map((field) => {
      const path = at(projectRoot, policy[field]);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`runtime bundle source lacks ${policy[field]}`);
      }
      return [field, { path: policy[field], sha256: sha256File(path) }];
    }),
  );
  const outputFile = at(projectRoot, policy.outputFile);
  const outputDirectory = dirname(outputFile);
  if (existsSync(outputDirectory)) throw new Error(`runtime bundle output already exists: ${policy.outputFile}`);

  const dependencyRoots = ['node_modules', `${policy.workspace}/node_modules`];
  const before = sourceSnapshot(projectRoot, [
    ...dependencyRoots,
    relative(projectRoot, outputDirectory).split(sep).join('/'),
  ]);
  const workRoot = dirname(projectRoot);
  const userConfig = join(workRoot, 'npmrc');
  writeFileSync(userConfig, '');
  const env = {
    ...environment,
    CI: '1',
    NPM_CONFIG_CACHE: join(workRoot, 'npm-cache'),
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  run(
    npm,
    [
      'ci',
      '--workspace',
      policy.workspace,
      '--include=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--progress=false',
    ],
    {
      cwd: projectRoot,
      env,
      timeout: 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      label: 'locked npm workspace install',
    },
  );
  run(node, [at(projectRoot, policy.buildFile)], {
    cwd: projectRoot,
    env,
    timeout: 5 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    label: 'reviewed runtime bundle build',
  });
  if (!existsSync(outputFile) || !statSync(outputFile).isFile()) {
    throw new Error(`runtime bundle build did not produce ${policy.outputFile}`);
  }
  assertSameSnapshot(
    before,
    sourceSnapshot(projectRoot, [...dependencyRoots, relative(projectRoot, outputDirectory).split(sep).join('/')]),
  );

  const resolvedArtifactRoot = resolve(artifactRoot);
  const runtimeRoot = join(resolvedArtifactRoot, 'runtime');
  if (existsSync(runtimeRoot)) throw new Error('runtime bundle artifact root already exists');
  const artifactOutputDirectory = join(
    runtimeRoot,
    ...relative(at(projectRoot, policy.workspace), outputDirectory).split(sep),
  );
  mkdirSync(artifactOutputDirectory, { recursive: true });
  copyRegularTree(outputDirectory, artifactOutputDirectory);
  const entry = policy.outputFile.slice(policy.workspace.length + 1);
  const artifact = inventoryRuntimeBundle(runtimeRoot, entry);
  if (artifact.bytes > policy.maxBytes) {
    throw new Error(`runtime bundle is ${artifact.bytes} bytes, exceeding ${policy.maxBytes}`);
  }
  return createNodeRuntimeBundleManifest({
    policy,
    nodeExecutableSha256: sha256File(nodeExecutable),
    source: identity,
    artifact,
  });
}
