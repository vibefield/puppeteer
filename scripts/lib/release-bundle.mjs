/** Preserve and attest an upstream release whose executable depends on adjacent files. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extractor = fileURLToPath(new URL('./python-console-tool.py', import.meta.url));
const safePath = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
  value.split('/').every((part) => part !== '.' && part !== '..');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function validateReleaseBundlePolicy(policy, format) {
  if (!['tar.gz', 'zip'].includes(format)) throw new Error('release bundle requires an archive');
  if (!safePath(policy?.entry)) throw new Error('release bundle entry is unsafe');
  if (
    !Array.isArray(policy.rootFiles) ||
    policy.rootFiles.length < 2 ||
    policy.rootFiles.some((path) => !safePath(path)) ||
    !policy.rootFiles.includes(policy.entry) ||
    new Set(policy.rootFiles).size !== policy.rootFiles.length
  )
    throw new Error('release bundle requires distinct reviewed root files including its entry');
  if (
    !Number.isSafeInteger(policy.maxExtractedBytes) ||
    policy.maxExtractedBytes < 1 ||
    policy.maxExtractedBytes > 1_073_741_824
  ) {
    throw new Error('release bundle extracted-byte limit is invalid');
  }
  return policy;
}

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error('release bundle file is not regular');
  return readFileSync(path);
}

export function inventoryReleaseBundle(directory, policy) {
  const files = [];
  let total = 0;
  function visit(path, prefix = '') {
    if (!lstatSync(path).isDirectory()) throw new Error('release bundle directory is not regular');
    for (const name of readdirSync(path).sort()) {
      if (/[\\:\u0000-\u001f\u007f]/.test(name)) throw new Error('release bundle contains an unsafe filename');
      const relative = prefix + name;
      const child = join(path, name);
      const info = lstatSync(child);
      if (info.isDirectory()) visit(child, `${relative}/`);
      else {
        if (!info.isFile()) throw new Error('release bundle contains a non-regular entry');
        total += info.size;
        if (total > policy.maxExtractedBytes || files.length >= 100_000)
          throw new Error('release bundle exceeds its limits');
        files.push({ path: relative, bytes: info.size, sha256: hash(readFileSync(child)) });
      }
    }
  }
  visit(directory);
  for (const path of policy.rootFiles) {
    if (!files.some((file) => file.path === path)) throw new Error(`release bundle is missing ${path}`);
  }
  return {
    digestAlgorithm: 'sha256-file-inventory-v1',
    fileCount: files.length,
    bytes: total,
    sha256: hash(JSON.stringify(files)),
    entrySha256: files.find((file) => file.path === policy.entry).sha256,
  };
}

export function materializeReleaseBundle({ bytes, output, archiveRoot, format, policy, vendor, version, platform }) {
  validateReleaseBundlePolicy(policy, format);
  const directory = dirname(output);
  const archive = `release.${format}`;
  const tree = join(directory, 'release');
  if (existsSync(tree) || existsSync(join(directory, archive)) || existsSync(output))
    throw new Error('release bundle output already exists');
  writeFileSync(join(directory, archive), bytes);
  try {
    execFileSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [
        extractor,
        'extract',
        '--archive',
        join(directory, archive),
        '--format',
        format,
        '--archive-root',
        archiveRoot,
        '--destination',
        tree,
        '--max-extracted-bytes',
        String(policy.maxExtractedBytes),
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const manifest = {
      schemaVersion: 1,
      artifactKind: 'release-bundle',
      vendor,
      version,
      platform,
      archive: { path: archive, format, root: archiveRoot, sha256: hash(bytes) },
      tree: { root: 'release', entry: policy.entry, ...inventoryReleaseBundle(tree, policy) },
    };
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    rmSync(tree, { recursive: true, force: true });
    rmSync(join(directory, archive), { force: true });
    throw error;
  }
}

export function verifyReleaseBundle(output, { vendor, version, platform, policy, format }) {
  validateReleaseBundlePolicy(policy, format);
  const manifest = JSON.parse(regularFile(output));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactKind !== 'release-bundle' ||
    manifest.vendor !== vendor ||
    manifest.version !== version ||
    manifest.platform !== platform ||
    manifest.archive?.path !== `release.${format}` ||
    manifest.archive?.format !== format ||
    manifest.tree?.root !== 'release' ||
    manifest.tree?.entry !== policy.entry
  )
    throw new Error('release bundle identity differs from policy');
  const directory = dirname(output);
  if (hash(regularFile(join(directory, manifest.archive.path))) !== manifest.archive.sha256)
    throw new Error('release bundle archive digest differs');
  const inventory = inventoryReleaseBundle(join(directory, 'release'), policy);
  for (const [key, value] of Object.entries(inventory)) {
    if (manifest.tree[key] !== value) throw new Error(`release bundle ${key} differs`);
  }
  return { manifest, executable: join(directory, 'release', policy.entry) };
}
