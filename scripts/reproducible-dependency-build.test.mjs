import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dependencyBuildEnvironment, validateDependencyBuilds } from './lib/reproducible-dependency-build.mjs';

const recipe = {
  strategy: 'rust-cyclonedx-v1',
  sourceDateEpoch: 0,
  distribution: 'cryptography',
  version: '50.0.0',
  sbom: 'sboms/cryptography-rust.cyclonedx.json',
  normalizedRoot: '/hermes-build',
};
const prefix = (id) =>
  `path+file:///private/var/folders/ab/random/T/.tmp${id}/sdists-v9/pypi/cryptography/50.0.0/${id}/src/`;
const document = (id) => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.4',
  metadata: {
    timestamp: '1970-01-01T00:00:00.000000000Z',
    component: { name: 'cryptography-rust', 'bom-ref': prefix(id) + 'src/rust#cryptography-rust@0.50.0' },
  },
  components: [{ name: 'openssl', version: '0.10.76', hashes: [{ alg: 'SHA-256', content: 'a'.repeat(64) }] }],
  dependencies: [
    {
      ref: prefix(id) + 'src/rust#cryptography-rust@0.50.0',
      dependsOn: ['registry+https://github.com/rust-lang/crates.io-index#openssl@0.10.76'],
    },
  ],
});
function normalize(doc, selected = recipe) {
  return execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      'import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("sbom",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nsys.stdout.buffer.write(m.canonicalize_sbom(sys.argv[2].encode(),json.loads(sys.argv[3])))',
      fileURLToPath(new URL('./lib/normalize-dependency-sbom.py', import.meta.url)),
      JSON.stringify(doc),
      JSON.stringify(selected),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

test('the reviewed build recipe is confined to its declared platform and safe Rust argument', () => {
  assert.doesNotThrow(() => validateDependencyBuilds({ 'darwin-x64': recipe }));
  for (const overrides of [
    { strategy: 'shell' },
    { sbom: '../credentials' },
    { normalizedRoot: '/tmp/../x' },
    { sourceDateEpoch: -1 },
    { version: '*' },
    { extra: true },
  ]) {
    assert.throws(() => validateDependencyBuilds({ 'darwin-x64': { ...recipe, ...overrides } }), /invalid/);
  }
  assert.throws(() => validateDependencyBuilds({ 'windows-x64': recipe }), /invalid/);
  assert.deepEqual(dependencyBuildEnvironment(recipe, '/build with spaces'), {
    CARGO_ENCODED_RUSTFLAGS: '--remap-path-prefix=/build with spaces=/hermes-build',
    SOURCE_DATE_EPOCH: '0',
  });
  assert.throws(() => dependencyBuildEnvironment(recipe, '/build\x1finjected'), /invalid/);
});

test('SBOM normalization removes only ephemeral build-root spellings and preserves dependency identity', () => {
  assert.equal(normalize(document('first')), normalize(document('second')));
  const output = JSON.parse(normalize(document('first')));
  assert.deepEqual(output.components, document('first').components);
  assert.match(
    output.metadata.component['bom-ref'],
    /^path\+file:\/\/\/hermes-build\/cryptography-50\.0\.0\/src\/rust#/,
  );
  const changed = document('second');
  changed.components[0].hashes[0].content = 'b'.repeat(64);
  assert.notEqual(normalize(document('first')), normalize(changed));
  const wrongEpoch = document('first');
  wrongEpoch.metadata.timestamp = '2026-11-04T00:00:00Z';
  assert.throws(() => normalize(wrongEpoch), /epoch/);
  const extraRoot = document('first');
  extraRoot.dependencies[0].ref = prefix('second') + 'src/rust#cryptography-rust@0.50.0';
  assert.throws(() => normalize(extraRoot), /exactly one/);
  assert.throws(() => normalize(document('first'), { ...recipe, version: '50.0.1' }), /unreviewed local/);
});

test('the production normalizer reproduces both retained diagnostic SBOMs when available', (context) => {
  const directory = new URL('../.agent-adaptation/hermes-canonical-comparison/', import.meta.url);
  let originals;
  try {
    originals = ['first', 'second'].map((side) =>
      JSON.parse(readFileSync(new URL(`${side}/sbom-original.json`, directory), 'utf8')),
    );
  } catch {
    context.skip('local diagnostic artifacts are not installed');
    return;
  }
  assert.equal(normalize(originals[0]), normalize(originals[1]));
  assert.equal(
    normalize(originals[0]),
    readFileSync(
      new URL('first/cryptography-50.0.0.dist-info/sboms/cryptography-rust.cyclonedx.json', directory),
      'utf8',
    ),
  );
});
