import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertReleaseCheckout,
  main,
  publicationProvenance,
  publishReleasePackages,
  registryHasVersion,
} from './publish-packages.mjs';
import {
  fakePack,
  git,
  npmError,
  ok,
  releaseFixture,
  tagFixture,
  updateManifest,
} from './test-support/release-fixture.mjs';

const packed = ['one', 'two'].map((name) => ({
  name: `@vibefield/${name}`,
  version: '1.2.3',
  tarballPath: `/tmp/${name}.tgz`,
}));

test('only an explicit npm 404 means a version is unpublished', () => {
  assert.equal(registryHasVersion('pkg', '1.2.3', { run: () => ok('1.2.3') }), true);
  assert.equal(registryHasVersion('pkg', '1.2.3', { run: () => ok(['1.2.3']) }), true);
  assert.equal(registryHasVersion('pkg', '1.2.3', { run: () => npmError('E404') }), false);
  for (const result of [
    npmError('E401'),
    npmError('E403'),
    npmError('E500'),
    ok('1.2.2'),
    ok([]),
    ok(['1.2.3', '1.2.4']),
    { status: null, error: { code: 'ETIMEDOUT' } },
    { status: 1, stdout: 'unavailable' },
  ]) {
    assert.throws(() => registryHasVersion('pkg', '1.2.3', { run: () => result }), /publication stopped/);
  }
});

test('registry failures during preflight prevent all publication', async () => {
  const calls = [];
  await assert.rejects(
    publishReleasePackages(packed, {
      provenance: false,
      run: (_manager, args) => {
        calls.push(args[0]);
        return args[1].includes('one') ? npmError('E404') : npmError('E401');
      },
    }),
    /E401/,
  );
  assert.deepEqual(calls, ['view', 'view']);
});

test('retry skips existing versions and recovers a lost publish response without uploading twice', async () => {
  const calls = [];
  let uploaded = false;
  await publishReleasePackages(packed, {
    provenance: false,
    wait: async () => {},
    log: () => {},
    run: (_manager, args) => {
      calls.push(args);
      if (args[0] === 'publish') {
        uploaded = true;
        return { status: 1 };
      }
      return args[1].includes('one') || uploaded ? ok('1.2.3') : npmError('E404');
    },
  });
  const uploads = calls.filter((args) => args[0] === 'publish');
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].includes('/tmp/two.tgz'));
  assert.ok(uploads[0].includes('--registry=https://registry.npmjs.org/'));
  assert.ok(uploads[0].includes('--provenance=false'));
  assert.ok(uploads[0].includes('--ignore-scripts'));
});

test('accepted uploads are submitted together and tolerate asynchronous npm processing', async () => {
  const uploads = [];
  let time = 0;
  await publishReleasePackages(packed, {
    provenance: false,
    verificationTimeoutMs: 90_000,
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    log: () => {},
    run: (_manager, args) => {
      if (args[0] === 'publish') {
        uploads.push(args[1]);
        return { status: 0 };
      }
      if (uploads.length) assert.equal(uploads.length, packed.length);
      return uploads.length && time >= 65_000 ? ok('1.2.3') : npmError('E404');
    },
  });
  assert.equal(time, 65_000);
  assert.deepEqual(
    uploads,
    packed.map((pkg) => pkg.tarballPath),
  );
});

test('accepted uploads must all become visible before the release succeeds', async () => {
  let uploads = 0;
  let time = 0;
  await assert.rejects(
    publishReleasePackages(packed, {
      provenance: false,
      verificationTimeoutMs: 10_000,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
      log: () => {},
      run: (_manager, args) => {
        if (args[0] === 'publish') {
          uploads += 1;
          return { status: 0 };
        }
        return npmError('E404');
      },
    }),
    /not visible on npm/,
  );
  assert.equal(uploads, 2);
  assert.equal(time, 10_000);
});

test('an ambiguous publish without registry visibility stops further uploads', async () => {
  let uploads = 0;
  let time = 0;
  await assert.rejects(
    publishReleasePackages(packed, {
      provenance: false,
      verificationTimeoutMs: 10_000,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
      log: () => {},
      run: (_manager, args) => {
        if (args[0] === 'publish') {
          uploads += 1;
          return { status: 1 };
        }
        return npmError('E404');
      },
    }),
    /not visible on npm/,
  );
  assert.equal(uploads, 1);
});

test('retrying an older incomplete release cannot move latest backwards', async () => {
  const calls = [];
  await assert.rejects(
    publishReleasePackages(packed, {
      provenance: false,
      run: (_manager, args) => {
        calls.push(args[0]);
        return args[2] === 'dist-tags.latest' ? ok(['2.0.0']) : npmError('E404');
      },
    }),
    /refusing to replace it with older/,
  );
  assert.ok(calls.every((command) => command === 'view'));
});

test('publishing requires an exact release tag and includes dirty and untracked files in its guard', (t) => {
  const root = releaseFixture(t);
  tagFixture(root);
  assert.doesNotThrow(() => assertReleaseCheckout(root, '1.2.3'));
  assert.throws(() => assertReleaseCheckout(root, '1.2.4'), /Missing v1.2.4/);
  writeFileSync(join(root, 'untracked.js'), 'unreviewed');
  assert.throws(() => assertReleaseCheckout(root, '1.2.3'), /clean checkout/);
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
    'later change',
  );
  assert.throws(() => assertReleaseCheckout(root, '1.2.3'), /exactly v1.2.3/);
});

test('a later invalid tarball aborts the release before any npm request', async (t) => {
  const root = releaseFixture(t);
  updateManifest(root, 'packages/view-sdk', (pkg) => {
    pkg.exports['./missing'] = './dist/missing.js';
  });
  tagFixture(root);
  const managers = [];
  await assert.rejects(
    main([], {
      root,
      environment: {},
      run: (manager, args) => {
        managers.push(manager);
        return fakePack(root, args);
      },
    }),
    /missing entry point/,
  );
  assert.deepEqual(managers, ['pnpm', 'pnpm']);
});

test('provenance must attest the actual release tag and commit before any build or upload', async (t) => {
  const root = releaseFixture(t);
  tagFixture(root);
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/tags/v1.2.3',
    GITHUB_SHA: git(root, 'rev-parse', 'HEAD'),
    NPM_CONFIG_PROVENANCE: 'true',
  };
  assert.doesNotThrow(() => assertReleaseCheckout(root, '1.2.3', { provenance: true, environment }));
  for (const mismatch of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: '0'.repeat(40) }]) {
    let commands = 0;
    await assert.rejects(
      main([], {
        root,
        environment: { ...environment, ...mismatch },
        run: () => {
          commands += 1;
          throw new Error('No package-manager command should run');
        },
      }),
      /Provenance requires a GitHub workflow run from the matching release tag and commit/,
    );
    assert.equal(commands, 0);
  }
});

test('dry run validates untagged source and performs no npm operations', async (t) => {
  const root = releaseFixture(t);
  let packs = 0;
  await main(['--dry-run'], {
    root,
    environment: { GITHUB_ACTIONS: 'true' },
    run: (manager, args) => {
      assert.equal(manager, 'pnpm');
      packs += 1;
      return fakePack(root, args);
    },
  });
  assert.equal(packs, 23);
});

test('CI must choose provenance explicitly; local bootstrapping defaults to false', () => {
  assert.equal(publicationProvenance({}), false);
  assert.equal(publicationProvenance({ GITHUB_ACTIONS: 'true', NPM_CONFIG_PROVENANCE: 'true' }), true);
  assert.equal(publicationProvenance({ GITHUB_ACTIONS: 'true', NPM_CONFIG_PROVENANCE: 'false' }), false);
  assert.throws(() => publicationProvenance({ GITHUB_ACTIONS: 'true' }), /must set/);
  assert.throws(() => publicationProvenance({ NPM_CONFIG_PROVENANCE: 'yes' }), /must set/);
});
