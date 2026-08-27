import assert from 'node:assert/strict';
import test from 'node:test';
import {
  debounceAgent,
  detectRelease,
  detectUpstreamAgents,
  detectVersion,
  loadUpstreamConfigs,
  validateUpstreamConfigs,
} from './detect-upstream-agents.mjs';

function response(body, contentType = 'text/plain') {
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': contentType } }));
}

test('all upstream definitions are structurally safe and discoverable', () => {
  assert.deepEqual(validateUpstreamConfigs(), []);
  const discovered = loadUpstreamConfigs().map(({ config }) => config.vendor);
  for (const vendor of ['antigravity', 'claude', 'codex', 'grok', 'hermes', 'kimi', 'opencode']) {
    assert.ok(discovered.includes(vendor), `missing upstream definition for ${vendor}`);
  }
});

test('GitHub title patterns extract the product version while retaining the tag', async () => {
  const release = await detectRelease(
    {
      id: 'github-stable',
      kind: 'github-release',
      url: 'https://api.github.com/repos/nousresearch/hermes-agent/releases',
      tagPattern: '^v(\\d{4}\\.\\d{1,2}\\.\\d{1,2})$',
      titlePattern: 'v(\\d+\\.\\d+\\.\\d+)',
      prerelease: false,
    },
    () =>
      response(
        JSON.stringify([
          {
            tag_name: 'v2026.8.3',
            name: 'Hermes Agent v0.20.0 (2026.8.3)',
            prerelease: false,
            draft: false,
            id: 9,
          },
        ]),
        'application/json',
      ),
  );
  assert.equal(release.version, '0.20.0');
  assert.equal(release.releaseIdentity.tagName, 'v2026.8.3');
});

test('text detectors extract the captured version only', async () => {
  const version = await detectVersion(
    { id: 'stable', kind: 'text', url: 'https://example.invalid/stable', versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
    () => response('release=2.1.226\n'),
  );
  assert.equal(version, '2.1.226');
});

test('detectors fingerprint release signals even when the version string is unchanged', async () => {
  const detector = {
    id: 'stable',
    kind: 'text',
    url: 'https://example.invalid/stable',
    versionPattern: '(\\d+\\.\\d+\\.\\d+)',
  };
  const first = await detectRelease(detector, () => response('release=2.1.226 build=a\n'));
  const republished = await detectRelease(detector, () => response('release=2.1.226 build=b\n'));
  assert.equal(first.version, republished.version);
  assert.notEqual(first.signalDigest, republished.signalDigest);
});

test('GitHub detectors honor prerelease and exact tag patterns', async () => {
  const releases = [
    { tag_name: 'rust-v0.148.0-alpha.5', prerelease: true, draft: false },
    { tag_name: 'rust-v0.147.0', prerelease: false, draft: false },
  ];
  const version = await detectVersion(
    {
      id: 'github-stable',
      kind: 'github-release',
      url: 'https://api.github.com/repos/openai/codex/releases',
      tagPattern: '^rust-v(\\d+\\.\\d+\\.\\d+)$',
      prerelease: false,
    },
    () => response(JSON.stringify(releases), 'application/json'),
  );
  assert.equal(version, '0.147.0');
});

test('the GitHub token is never sent to vendor detector origins', async () => {
  const original = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-workflow-token';
  const requests = [];
  const fetchImpl = (url, init) => {
    requests.push({ url, headers: init.headers });
    return url.includes('api.github.com')
      ? response(JSON.stringify([{ tag_name: 'v1.2.3', prerelease: false, draft: false }]), 'application/json')
      : response('1.2.3');
  };
  try {
    await detectVersion(
      {
        id: 'vendor',
        kind: 'text',
        url: 'https://downloads.example.invalid/stable',
        versionPattern: '(\\d+\\.\\d+\\.\\d+)',
      },
      fetchImpl,
    );
    await detectVersion(
      {
        id: 'github',
        kind: 'github-release',
        url: 'https://api.github.com/repos/example/agent/releases',
        tagPattern: '^v(\\d+\\.\\d+\\.\\d+)$',
        prerelease: false,
      },
      fetchImpl,
    );
  } finally {
    if (original === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = original;
  }
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].headers.authorization, 'Bearer test-workflow-token');
});

test('a new stable candidate matures only after the configured debounce', () => {
  const state = { schemaVersion: 1, candidates: {} };
  const agent = { vendor: 'claude', detectedStableVersion: '2.1.220', status: 'candidate' };
  const first = debounceAgent(agent, { polls: 2, minutes: 30 }, state, new Date('2026-08-08T00:00:00Z'));
  assert.equal(first.status, 'candidate-pending');
  const second = debounceAgent(agent, { polls: 2, minutes: 30 }, state, new Date('2026-08-08T00:06:00Z'));
  assert.equal(second.status, 'candidate');
  assert.equal(second.debounceObservation.polls, 2);
});

test('debounce history is append-only across versions and migrates schema 1 state', () => {
  const state = {
    schemaVersion: 1,
    candidates: {
      'claude@2.1.219': {
        firstSeen: '2026-08-07T00:00:00.000Z',
        lastSeen: '2026-08-07T01:00:00.000Z',
        polls: 3,
      },
    },
  };
  debounceAgent(
    { vendor: 'claude', detectedStableVersion: '2.1.220', signalDigest: 'a', status: 'candidate' },
    { polls: 2, minutes: 30 },
    state,
    new Date('2026-08-08T00:00:00Z'),
  );
  debounceAgent(
    { vendor: 'claude', detectedStableVersion: '2.1.221', signalDigest: 'b', status: 'candidate' },
    { polls: 2, minutes: 30 },
    state,
    new Date('2026-08-08T01:00:00Z'),
  );
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(Object.keys(state.releases).sort(), ['claude@2.1.219', 'claude@2.1.220', 'claude@2.1.221']);
  assert.ok(state.candidates['claude@2.1.219'], 'legacy history is retained');
});

test('release history adds newly required platforms without replacing prior work', () => {
  const state = { schemaVersion: 2, releases: {}, heads: {} };
  const base = {
    vendor: 'codex',
    detectedStableVersion: '0.148.0',
    signalDigest: 'signal',
    status: 'candidate',
  };
  debounceAgent(
    { ...base, platforms: ['darwin-arm64'] },
    { polls: 2, minutes: 30 },
    state,
    new Date('2026-08-08T00:00:00Z'),
  );
  debounceAgent(
    { ...base, platforms: ['darwin-arm64', 'linux-x64'] },
    { polls: 2, minutes: 30 },
    state,
    new Date('2026-08-08T00:06:00Z'),
  );
  assert.deepEqual(Object.keys(state.releases['codex@0.148.0'].platforms).sort(), ['darwin-arm64', 'linux-x64']);
});

test('reports same-version republishes and rollbacks while retaining platform work history', async () => {
  const state = { schemaVersion: 2, releases: {}, heads: {} };
  let grokStable = '1.0.0 build=a';
  const fetchImpl = (url) => {
    if (url.includes('api.github.com/repos/openai/codex')) {
      return response(
        JSON.stringify([
          { tag_name: 'rust-v0.148.0-alpha.1', prerelease: true, draft: false, id: 2 },
          { tag_name: 'rust-v0.147.0', prerelease: false, draft: false, id: 1 },
        ]),
        'application/json',
      );
    }
    if (url.includes('api.github.com/repos/anthropics')) {
      return response(JSON.stringify([{ tag_name: 'v2.1.207', prerelease: false, draft: false, id: 3 }]));
    }
    if (url.includes('api.github.com/repos/NousResearch/hermes-agent')) {
      return response(
        JSON.stringify([
          {
            tag_name: 'v2026.8.3',
            name: 'Hermes Agent v0.20.0 (2026.8.3)',
            prerelease: false,
            draft: false,
            id: 4,
          },
        ]),
        'application/json',
      );
    }
    if (url.includes('downloads.claude.ai')) return response('2.1.207');
    if (url.endsWith('/stable')) return response(grokStable);
    if (url.endsWith('/alpha')) return response('1.1.0-alpha.1');
    throw new Error(`unexpected URL ${url}`);
  };

  await detectUpstreamAgents({ fetchImpl, state, now: () => new Date('2026-08-08T00:00:00Z') });
  grokStable = '1.0.0 build=b';
  const republished = await detectUpstreamAgents({
    fetchImpl,
    state,
    now: () => new Date('2026-08-08T01:00:00Z'),
  });
  const grokRepublished = republished.agents.find((agent) => agent.vendor === 'grok');
  assert.equal(grokRepublished.status, 'release-signal-changed');
  assert.equal(grokRepublished.workItems.length, 4);
  assert.ok(grokRepublished.workItems.every((item) => item.artifactDigest === null));
  assert.ok(grokRepublished.workItems.every((item) => item.key.endsWith(grokRepublished.signalDigest)));
  assert.ok(grokRepublished.workItems.every((item) => item.acquisition.urls.every((url) => url.includes('1.0.0'))));
  assert.equal(Object.keys(state.releases['grok@1.0.0'].observations).length, 2);
  const hermes = republished.agents.find((agent) => agent.vendor === 'hermes');
  assert.equal(hermes.sourceRelation.expectedReference, 'v2026.8.3');
  assert.ok(hermes.workItems.every((item) => item.acquisition.kind === 'source-archive'));
  assert.ok(hermes.workItems.every((item) => item.acquisition.urls[0].includes('v2026.8.3')));
  assert.ok(hermes.workItems.every((item) => item.acquisition.nextArtifact.kind === 'installed-console'));
  assert.ok(hermes.workItems.every((item) => item.acquisition.nextArtifact.strategy === 'python-uv-lock'));

  grokStable = '0.9.0 rollback';
  const rollback = await detectUpstreamAgents({
    fetchImpl,
    state,
    now: () => new Date('2026-08-08T02:00:00Z'),
  });
  assert.equal(rollback.agents.find((agent) => agent.vendor === 'grok').status, 'rollback-detected');
  assert.ok(rollback.alerts.some((alert) => alert.vendor === 'grok' && alert.kind === 'rollback-detected'));
  assert.ok(state.releases['grok@1.0.0']);
  assert.ok(state.releases['grok@0.9.0']);
});
