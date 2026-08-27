/** Deterministic schema and validation for source-materialized console artifacts. */
import { createHash } from 'node:crypto';
import { validateVersionOutput } from '../probe-agent-artifact.mjs';

const sha256Pattern = /^sha256:[0-9a-f]{64}$/;

function validateInventory(inventory, policy, version) {
  if (inventory?.schemaVersion !== 1) throw new Error('Python inventory has an unsupported schema');
  if (inventory.runtime?.implementation !== 'cpython') throw new Error('installed console must use CPython');
  if (inventory.runtime?.pythonVersion !== policy.pythonVersion) {
    throw new Error(
      `installed Python is ${inventory.runtime?.pythonVersion ?? 'unknown'}, expected ${policy.pythonVersion}`,
    );
  }
  const [pythonMajor, pythonMinor] = policy.pythonVersion.split('.');
  if (
    inventory.runtime?.cacheTag !== `cpython-${pythonMajor}${pythonMinor}` ||
    !Number.isInteger(inventory.runtime?.stdlibFileCount) ||
    inventory.runtime.stdlibFileCount < 1
  ) {
    throw new Error('installed console has incomplete CPython runtime metadata');
  }
  const normalizedDistribution = policy.distribution.toLowerCase().replace(/[-_.]+/g, '-');
  for (const [label, digest] of [
    ['Python executable', inventory.runtime?.executableSha256],
    ['Python standard library', inventory.runtime?.stdlibSha256],
    ['Python environment', inventory.environment?.sha256],
    ['console binding', inventory.console?.bindingSha256],
  ]) {
    if (!sha256Pattern.test(digest ?? '')) throw new Error(`${label} has no SHA-256 identity`);
  }
  if (
    inventory.console?.distribution !== normalizedDistribution ||
    inventory.console?.distributionVersion !== version ||
    inventory.console?.script !== policy.consoleScript ||
    inventory.console?.installMode !== policy.installMode ||
    inventory.console?.sourceBinding !== 'direct-url'
  ) {
    throw new Error('installed console identity differs from the reviewed policy');
  }
  if (
    typeof inventory.console?.entryPoint !== 'string' ||
    !inventory.console.entryPoint ||
    inventory.console.entryPoint.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(inventory.console.entryPoint) ||
    inventory.console?.bindingDigestAlgorithm !== 'sha256-console-binding-v1' ||
    typeof inventory.console?.launcher !== 'string' ||
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(inventory.console.launcher)
  ) {
    throw new Error('installed console has no safe launcher and entry point');
  }
  const distributions = inventory.environment?.distributions;
  if (
    inventory.environment?.digestAlgorithm !== 'sha256-python-installed-files-v1' ||
    JSON.stringify(inventory.environment?.pathNormalization) !==
      JSON.stringify(['python-environment', 'source-root']) ||
    JSON.stringify(inventory.environment?.excludedInstallMetadata) !==
      JSON.stringify(['RECORD', 'direct_url.json', 'uv_cache.json']) ||
    inventory.environment?.excludedGeneratedLaunchers !== true ||
    !Array.isArray(distributions) ||
    distributions.length === 0 ||
    inventory.environment.distributionCount !== distributions.length ||
    distributions.some(
      (distribution) =>
        !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(distribution.name ?? '') ||
        typeof distribution.version !== 'string' ||
        !distribution.version ||
        !Number.isInteger(distribution.fileCount) ||
        distribution.fileCount < 1 ||
        !sha256Pattern.test(distribution.filesSha256 ?? ''),
    )
  ) {
    throw new Error('Python environment has an invalid distribution inventory');
  }
  const ordered = [...distributions].sort((left, right) => {
    const leftKey = [left.name, left.version, left.filesSha256].join('\0');
    const rightKey = [right.name, right.version, right.filesSha256].join('\0');
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (JSON.stringify(distributions) !== JSON.stringify(ordered)) {
    throw new Error('Python environment distributions are not canonically ordered');
  }
  const environmentBytes = JSON.stringify(
    distributions.map(({ fileCount, filesSha256, name, version: distributionVersion }) => ({
      fileCount,
      filesSha256,
      name,
      version: distributionVersion,
    })),
  );
  if (`sha256:${createHash('sha256').update(environmentBytes).digest('hex')}` !== inventory.environment.sha256) {
    throw new Error('Python environment digest does not match its distribution inventory');
  }
  const bindingBytes = JSON.stringify({
    distribution: inventory.console.distribution,
    distributionVersion: inventory.console.distributionVersion,
    entryPoint: inventory.console.entryPoint,
    launcher: inventory.console.launcher,
    script: inventory.console.script,
  });
  const bindingSha256 = `sha256:${createHash('sha256')
    .update('sha256-console-binding-v1\0')
    .update(bindingBytes)
    .digest('hex')}`;
  if (bindingSha256 !== inventory.console.bindingSha256) {
    throw new Error('console binding digest does not match its declared entry point');
  }
}

export function normalizeInstalledVersionOutput(output, version, policy) {
  const value = String(output ?? '');
  if (!value || value.length > 4_096 || value.includes('\u0000')) {
    throw new Error('installed console version output is empty or unbounded');
  }
  if (policy === 'single-line') return validateVersionOutput(value, version);
  if (policy !== 'first-line') throw new Error(`unsupported version output policy ${policy}`);
  const firstLine = value
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  return validateVersionOutput(firstLine, version);
}

export function validateInstalledConsoleManifest(
  manifest,
  { vendor, version, platform, versionOutput = manifest?.console?.versionOutput, policy },
) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.artifactKind !== 'installed-console' ||
    manifest.identityAlgorithm !== 'sha256-installed-console-manifest-v1' ||
    manifest.vendor !== vendor ||
    manifest.version !== version ||
    manifest.platform !== platform
  ) {
    throw new Error('installed-console manifest identity differs');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.source?.reference ?? '') ||
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(manifest.source?.archiveRoot ?? '') ||
    manifest.source?.tree?.digestAlgorithm !== 'sha256-path-content-v1' ||
    manifest.source?.generated?.digestAlgorithm !== 'sha256-generated-source-trees-v1' ||
    !Number.isInteger(manifest.source?.generated?.fileCount) ||
    manifest.source.generated.fileCount < 0 ||
    JSON.stringify(manifest.source.generated.roots) !== JSON.stringify(policy?.generatedSourcePaths) ||
    manifest.source?.projectFile?.path !== policy?.projectFile ||
    manifest.source?.lockFile?.path !== policy?.lockFile
  ) {
    throw new Error('installed-console source identity differs from its reviewed policy');
  }
  for (const [label, digest] of [
    ['source archive', manifest.source.archiveSha256],
    ['source tree', manifest.source.tree.sha256],
    ['generated source metadata', manifest.source.generated.sha256],
    [policy.projectFile, manifest.source.projectFile.sha256],
    [policy.lockFile, manifest.source.lockFile.sha256],
  ]) {
    if (!sha256Pattern.test(digest ?? '')) throw new Error(`${label} has no SHA-256 identity`);
  }
  if (
    manifest.materialization?.strategy !== policy?.strategy ||
    manifest.materialization?.uvVersion !== policy?.uvVersion ||
    manifest.materialization?.pythonVersion !== policy?.pythonVersion ||
    manifest.materialization?.frozen !== true ||
    manifest.materialization?.exact !== true ||
    manifest.materialization?.editable !== (policy?.installMode === 'editable') ||
    manifest.materialization?.defaultGroups !== false
  ) {
    throw new Error('installed-console materialization differs from its reviewed policy');
  }
  validateInventory(manifest, policy, version);
  const normalizedVersionOutput = normalizeInstalledVersionOutput(versionOutput, version, policy.versionOutput);
  if (manifest.console.versionOutput !== normalizedVersionOutput) {
    throw new Error('installed-console version output differs from its manifest');
  }
  return manifest;
}

export function createInstalledConsoleManifest({
  vendor,
  version,
  platform,
  downloadMetadata,
  archiveSha256,
  sourceTreeSha256,
  generatedSource,
  projectFileSha256,
  lockFileSha256,
  policy,
  inventory,
  versionOutput,
}) {
  const normalizedVersionOutput = normalizeInstalledVersionOutput(versionOutput, version, policy.versionOutput);
  const manifest = {
    schemaVersion: 1,
    artifactKind: 'installed-console',
    identityAlgorithm: 'sha256-installed-console-manifest-v1',
    vendor,
    version,
    platform,
    source: {
      archiveSha256,
      tree: { digestAlgorithm: 'sha256-path-content-v1', sha256: sourceTreeSha256 },
      generated: generatedSource,
      reference: downloadMetadata?.sourceReference,
      archiveRoot: downloadMetadata?.archiveRoot,
      projectFile: { path: policy.projectFile, sha256: projectFileSha256 },
      lockFile: { path: policy.lockFile, sha256: lockFileSha256 },
    },
    materialization: {
      strategy: policy.strategy,
      uvVersion: policy.uvVersion,
      pythonVersion: policy.pythonVersion,
      frozen: true,
      exact: true,
      editable: policy.installMode === 'editable',
      defaultGroups: false,
    },
    runtime: inventory.runtime,
    environment: inventory.environment,
    console: { ...inventory.console, versionOutput: normalizedVersionOutput },
  };
  return validateInstalledConsoleManifest(manifest, { vendor, version, platform, policy });
}
