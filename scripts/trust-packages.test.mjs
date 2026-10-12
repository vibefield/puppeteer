import assert from 'node:assert/strict';
import test from 'node:test';

import { configureTrust, matchesReleaseTrust, parseTrustRecords } from './trust-packages.mjs';
import { npmError, ok, releaseFixture } from './test-support/release-fixture.mjs';

const trusted = {
  id: 'test',
  type: 'github',
  repository: 'vibefield/puppeteer',
  file: 'release.yml',
  permissions: ['createPackage'],
};

test('npm trust output supports multiple JSON records without confusing braces in strings', () => {
  const other = { ...trusted, id: 'brace } { and escaped " quote' };
  assert.deepEqual(parseTrustRecords(`\n${JSON.stringify(trusted)}\n\n${JSON.stringify(other)}\n`), [trusted, other]);
  assert.deepEqual(parseTrustRecords(JSON.stringify([trusted, other])), [trusted, other]);
  assert.deepEqual(parseTrustRecords(' \n'), []);
  assert.deepEqual(parseTrustRecords('[]'), []);
  for (const value of ['null', '{}', '{', '{"type":"github"} trailing', '{"error":{"code":"E401"}}']) {
    assert.throws(() => parseTrustRecords(value));
  }
});

test('trust must grant direct publishing to this exact repo and workflow without an environment', () => {
  assert.equal(matchesReleaseTrust(trusted), true);
  for (const change of [
    { repository: 'vibecook-dev/puppeteer' },
    { file: 'ci.yml' },
    { environment: 'production' },
    { permissions: ['createStagedPackage'] },
    { type: 'gitlab' },
  ]) {
    assert.equal(matchesReleaseTrust({ ...trusted, ...change }), false);
  }
});

function fakeNpm(trustFor, calls, { missing = false, login = true } = {}) {
  return (_manager, args) => {
    calls.push(args);
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
    if (args[0] === '--version') return { status: 0, stdout: '12.0.1\n' };
    if (args[0] === 'whoami') return login ? ok('maintainer') : npmError('E401');
    if (args[0] === 'view') return missing ? npmError('E404') : ok(args[1]);
    if (args[1] === 'list') return ok(trustFor(args[2]));
    if (args[1] === 'github') return { status: 0 };
    throw new Error(`Unexpected npm invocation ${args.join(' ')}`);
  };
}

test('bootstrap and authentication failures are reported before any trust mutation', async (t) => {
  const root = releaseFixture(t);
  for (const options of [{ missing: true }, { login: false }]) {
    const calls = [];
    await assert.rejects(
      configureTrust({ root, run: fakeNpm(() => [], calls, options) }),
      /Initial authenticated publication|npm authentication failed/,
    );
    assert.ok(calls.every((args) => args[0] !== 'trust'));
  }
});

test('check mode verifies all packages and never creates missing trust', async (t) => {
  const root = releaseFixture(t);
  const calls = [];
  await assert.rejects(
    configureTrust({
      root,
      checkOnly: true,
      log: () => {},
      run: fakeNpm((name) => (name.endsWith('-core') ? [] : [trusted]), calls),
    }),
    /Missing trust/,
  );
  assert.equal(calls.filter((args) => args[0] === 'trust' && args[1] === 'list').length, 23);
  assert.equal(calls.filter((args) => args[1] === 'github').length, 0);
});

test('setup is idempotent, creates only missing trust and checks the result', async (t) => {
  const root = releaseFixture(t);
  const calls = [];
  const run = fakeNpm(
    (name) => (name.endsWith('-core') && !calls.some((args) => args[1] === 'github') ? [] : [trusted]),
    calls,
  );
  await configureTrust({ root, run, wait: async () => {}, log: () => {} });
  await configureTrust({ root, run, wait: async () => {}, log: () => {} });
  const creates = calls.filter((args) => args[1] === 'github');
  assert.equal(creates.length, 1);
  assert.ok(creates[0].includes('--allow-publish'));
  assert.ok(creates[0].includes('release.yml'));
});

test('existing mismatched trust is never overwritten automatically', async (t) => {
  const root = releaseFixture(t);
  const calls = [];
  await assert.rejects(
    configureTrust({ root, run: fakeNpm(() => [{ ...trusted, repository: 'someone/else' }], calls) }),
    /different trust configuration/,
  );
  assert.ok(calls.every((args) => args[1] !== 'github'));
});

test('interactive inspection opens npm 2FA on a terminal before recapturing JSON', async (t) => {
  const root = releaseFixture(t);
  const calls = [];
  let approved = false;
  let prompts = 0;
  const base = fakeNpm(() => [trusted], calls);
  await configureTrust({
    root,
    checkOnly: true,
    interactive: true,
    log: () => {},
    run: (manager, args, options) => {
      if (args[0] === 'trust' && args[1] === 'list' && !approved) {
        if (args.includes('--json')) return npmError('EOTP');
        assert.equal(options.stdio, 'inherit');
        approved = true;
        prompts += 1;
        return { status: 0 };
      }
      return base(manager, args, options);
    },
  });
  assert.equal(prompts, 1);
  assert.ok(calls.every((args) => args[1] !== 'github'));
});

test('noninteractive 2FA failures stop without trying to create trust', async (t) => {
  const root = releaseFixture(t);
  const calls = [];
  const base = fakeNpm(() => [], calls);
  await assert.rejects(
    configureTrust({
      root,
      interactive: false,
      run: (manager, args, options) => (args[0] === 'trust' ? npmError('EOTP') : base(manager, args, options)),
    }),
    /five-minute window/,
  );
});
