/** Contract and byte verification for source-built runtime bundles. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const reservedEnvironment = new Set([
  'COMSPEC',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
]);

function safeRelativePath(path) {
  return (
    typeof path === 'string' &&
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path) &&
    path.split('/').every((part) => part !== '.' && part !== '..')
  );
}

function under(path, root) {
  return path.startsWith(`${root}/`);
}

function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function regularFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(current, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('runtime bundle contains a symbolic link');
    if (info.isDirectory()) files.push(...regularFiles(root, path));
    else if (info.isFile()) files.push({ path, name: relative(root, path).split(sep).join('/'), bytes: info.size });
    else throw new Error('runtime bundle contains a non-regular entry');
  }
  return files;
}

export function validateNodeRuntimeBundlePolicy(policy) {
  if (policy?.strategy !== 'node-npm-lock-bundle') throw new Error('unsupported runtimeBundle strategy');
  if (!/^\d+\.\d+\.\d+$/.test(policy.nodeVersion ?? '')) {
    throw new Error('runtimeBundle requires an exact Node version');
  }
  if (!/^\d+\.\d+\.\d+$/.test(policy.npmVersion ?? '')) {
    throw new Error('runtimeBundle requires an exact npm version');
  }
  for (const field of ['packageFile', 'lockFile', 'workspace', 'workspacePackageFile', 'buildFile', 'outputFile']) {
    if (!safeRelativePath(policy[field])) throw new Error(`runtimeBundle ${field} must be a safe relative path`);
  }
  if (
    policy.packageFile === policy.lockFile ||
    policy.workspacePackageFile !== `${policy.workspace}/package.json` ||
    !under(policy.buildFile, policy.workspace) ||
    !under(policy.outputFile, policy.workspace) ||
    new Set([policy.packageFile, policy.lockFile, policy.workspacePackageFile, policy.buildFile, policy.outputFile])
      .size !== 5
  ) {
    throw new Error('runtimeBundle source, build, and output paths are inconsistent');
  }
  if (
    !/^[A-Z][A-Z0-9_]*$/.test(policy.environmentVariable ?? '') ||
    reservedEnvironment.has(policy.environmentVariable)
  ) {
    throw new Error('runtimeBundle environmentVariable is unsafe or reserved');
  }
  if (!Number.isInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > 134_217_728) {
    throw new Error('runtimeBundle maxBytes must be between 1 and 134217728');
  }
  return policy;
}

export function runtimeBundleEntry(policy) {
  validateNodeRuntimeBundlePolicy(policy);
  return `runtime/${policy.outputFile.slice(policy.workspace.length + 1)}`;
}

export function inventoryRuntimeBundle(root, entry) {
  if (!existsSync(root) || !statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error('runtime bundle root is not a regular directory');
  }
  if (!safeRelativePath(entry)) throw new Error('runtime bundle entry is unsafe');
  const files = regularFiles(root);
  const entryFile = files.find((file) => file.name === entry);
  if (!entryFile) throw new Error(`runtime bundle entry is missing: ${entry}`);
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.name);
    digest.update('\0');
    digest.update(readFileSync(file.path));
    digest.update('\0');
  }
  return {
    root: 'runtime',
    entry: `runtime/${entry}`,
    digestAlgorithm: 'sha256-path-content-v1',
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: `sha256:${digest.digest('hex')}`,
    entrySha256: sha256File(entryFile.path),
  };
}

export function createNodeRuntimeBundleManifest({ policy, nodeExecutableSha256, source, artifact }) {
  validateNodeRuntimeBundlePolicy(policy);
  const value = {
    strategy: policy.strategy,
    nodeVersion: policy.nodeVersion,
    npmVersion: policy.npmVersion,
    nodeExecutableSha256,
    source,
    materialization: {
      cleanInstall: true,
      locked: true,
      workspace: policy.workspace,
      includeDev: true,
      lifecycleScripts: false,
      buildEntrypoint: policy.buildFile,
      outputFile: policy.outputFile,
    },
    artifact,
    environment: { variable: policy.environmentVariable, root: 'runtime' },
  };
  return validateNodeRuntimeBundleManifest(value, policy);
}

export function validateNodeRuntimeBundleManifest(bundle, policy) {
  validateNodeRuntimeBundlePolicy(policy);
  if (
    bundle?.strategy !== policy.strategy ||
    bundle.nodeVersion !== policy.nodeVersion ||
    bundle.npmVersion !== policy.npmVersion ||
    !sha256Pattern.test(bundle.nodeExecutableSha256 ?? '')
  ) {
    throw new Error('runtime bundle toolchain differs from its reviewed policy');
  }
  for (const field of ['packageFile', 'lockFile', 'workspacePackageFile', 'buildFile']) {
    if (bundle.source?.[field]?.path !== policy[field] || !sha256Pattern.test(bundle.source?.[field]?.sha256 ?? '')) {
      throw new Error(`runtime bundle ${field} identity differs from its reviewed policy`);
    }
  }
  if (
    bundle.materialization?.cleanInstall !== true ||
    bundle.materialization?.locked !== true ||
    bundle.materialization?.workspace !== policy.workspace ||
    bundle.materialization?.includeDev !== true ||
    bundle.materialization?.lifecycleScripts !== false ||
    bundle.materialization?.buildEntrypoint !== policy.buildFile ||
    bundle.materialization?.outputFile !== policy.outputFile
  ) {
    throw new Error('runtime bundle materialization differs from its reviewed policy');
  }
  if (
    bundle.artifact?.root !== 'runtime' ||
    bundle.artifact?.entry !== runtimeBundleEntry(policy) ||
    bundle.artifact?.digestAlgorithm !== 'sha256-path-content-v1' ||
    !Number.isInteger(bundle.artifact?.fileCount) ||
    bundle.artifact.fileCount < 1 ||
    !Number.isInteger(bundle.artifact?.bytes) ||
    bundle.artifact.bytes < 1 ||
    bundle.artifact.bytes > policy.maxBytes ||
    !sha256Pattern.test(bundle.artifact?.sha256 ?? '') ||
    !sha256Pattern.test(bundle.artifact?.entrySha256 ?? '') ||
    bundle.environment?.variable !== policy.environmentVariable ||
    bundle.environment?.root !== 'runtime'
  ) {
    throw new Error('runtime bundle artifact identity differs from its reviewed policy');
  }
  return bundle;
}

export function verifyRuntimeBundleFiles(bundle, artifactRoot, policy) {
  validateNodeRuntimeBundleManifest(bundle, policy);
  const resolvedArtifactRoot = resolve(artifactRoot);
  const runtimeRoot = resolve(resolvedArtifactRoot, bundle.artifact.root);
  if (!runtimeRoot.startsWith(`${resolvedArtifactRoot}${sep}`))
    throw new Error('runtime bundle escapes its artifact root');
  const actual = inventoryRuntimeBundle(runtimeRoot, bundle.artifact.entry.slice('runtime/'.length));
  if (Object.keys(actual).some((field) => actual[field] !== bundle.artifact[field])) {
    throw new Error('runtime bundle bytes differ from the installed-console manifest');
  }
  return actual;
}
