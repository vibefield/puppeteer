import { describe, expect, it } from 'vitest';
import type {
  AgentInstallationsSnapshot,
  AgentProfile,
  DistributionProvider,
  ProfileIdentity,
  ProfileProvider,
  ReleaseCheckResult,
  UpdateReceipt,
} from '../protocol.js';
import {
  formatAge,
  installRowViews,
  profileGroupViews,
  profileLabelIndex,
  releaseView,
  updateReceiptView,
} from './agents-drawer.js';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');

const EXAMPLE: DistributionProvider = {
  id: 'example-agent',
  label: 'Example Agent',
  commands: ['example'],
  npmPackages: ['@example/agent'],
  brewNames: [],
  detectors: [],
  nativeUpdateCheck: true,
};

const OTHER: DistributionProvider = {
  id: 'other-agent',
  label: 'Other Agent',
  commands: ['other'],
  npmPackages: [],
  brewNames: [],
  detectors: [],
  nativeUpdateCheck: false,
};

const snapshot: AgentInstallationsSnapshot = {
  inspectedAt: '2026-09-06T11:59:00.000Z',
  providers: [EXAMPLE, OTHER],
  installations: [
    {
      provider: 'example-agent',
      executable: '/usr/local/bin/example',
      realPath: '/usr/local/lib/node_modules/@example/agent/bin/example.js',
      version: '1.2.3',
      method: 'npm-global',
      packageName: '@example/agent',
      location: '/usr/local/lib/node_modules/@example/agent',
      autoUpdate: 'disabled',
      detectedAt: '2026-09-06T11:59:00.000Z',
      warnings: [],
      origin: 'npm-global',
      active: false,
    },
    {
      provider: 'example-agent',
      executable: '/home/user/.local/bin/example',
      realPath: '/home/user/.local/share/example/versions/1.4.0',
      version: '1.4.0',
      method: 'native-installer',
      location: '/home/user/.local/share/example/versions',
      autoUpdate: 'enabled',
      channel: 'stable',
      detectedAt: '2026-09-06T11:59:00.000Z',
      warnings: ['version probe timed out once'],
      origin: 'path',
      active: true,
    },
  ],
};

describe('install rows', () => {
  it('puts the launched install first and keeps the second one visible', () => {
    const rows = installRowViews(snapshot);
    expect(rows.map((row) => [row.providerId, row.version, row.state])).toEqual([
      ['example-agent', '1.4.0', 'active'],
      ['example-agent', '1.2.3', 'inactive'],
      ['other-agent', '—', 'missing'],
    ]);
  });

  it('says how an install got there and whether it updates itself, in words', () => {
    const [active, second] = installRowViews(snapshot);
    expect(active).toMatchObject({
      method: 'native installer',
      origin: 'on PATH',
      autoUpdate: 'self-updating',
      channel: 'stable',
      nativeUpdateCheck: true,
      warnings: ['version probe timed out once'],
    });
    expect(second).toMatchObject({ method: 'npm global', origin: 'npm root', autoUpdate: 'manual updates' });
  });

  it('returns nothing before an inventory exists', () => {
    expect(installRowViews(undefined)).toEqual([]);
  });
});

describe('release checks', () => {
  const result: ReleaseCheckResult = {
    provider: 'example-agent',
    checkedAt: '2026-09-06T12:00:00.000Z',
    releases: [
      {
        provider: 'example-agent',
        channel: 'stable',
        version: '1.5.0',
        fetchedAt: '2026-09-06T12:00:00.000Z',
        source: { kind: 'npm-registry', id: 'npm-latest' },
      },
      {
        provider: 'example-agent',
        channel: 'preview',
        version: '1.6.0-rc1',
        fetchedAt: '2026-09-06T12:00:00.000Z',
        source: { kind: 'github-release', id: 'github' },
      },
    ],
    behind: [{ channel: 'stable', version: '1.5.0' }],
    failures: [
      { status: 'unavailable', provider: 'example-agent', message: 'the preview endpoint timed out', retryable: true },
    ],
  };

  it('marks only the channels the runtime says the install is behind', () => {
    const view = releaseView(result);
    expect(view.channels).toEqual([
      { channel: 'stable', version: '1.5.0', behind: true, source: 'npm-registry' },
      { channel: 'preview', version: '1.6.0-rc1', behind: false, source: 'github-release' },
    ]);
    expect(view.failures).toEqual(['the preview endpoint timed out']);
  });

  it('shows a channel that only the native oracle reported', () => {
    const view = releaseView({ ...result, releases: [], behind: [{ channel: 'stable', version: '2.0.0' }] });
    expect(view.channels).toEqual([{ channel: 'stable', version: '2.0.0', behind: true, source: 'native-oracle' }]);
  });
});

describe('update receipts', () => {
  const base: UpdateReceipt = {
    provider: 'example-agent',
    status: 'updated',
    startedAt: '2026-09-06T12:00:00.000Z',
    finishedAt: '2026-09-06T12:00:30.000Z',
  };

  it('reads the outcome from the inspections, not from the command output', () => {
    expect(
      updateReceiptView({
        ...base,
        before: { ...snapshot.installations[1]!, version: '1.4.0' },
        after: { ...snapshot.installations[1]!, version: '1.5.0' },
      }),
    ).toEqual({ status: 'UPDATED', detail: '1.4.0 → 1.5.0' });
    expect(updateReceiptView({ ...base, status: 'unchanged' }).status).toBe('UNCHANGED');
    expect(updateReceiptView({ ...base, status: 'already-current' }).status).toBe('ALREADY CURRENT');
    expect(updateReceiptView({ ...base, status: 'failed', message: 'exit code 1' })).toEqual({
      status: 'FAILED',
      detail: 'exit code 1',
    });
    expect(updateReceiptView({ ...base, status: 'unsupported', message: 'installed by hand' }).status).toBe(
      'NOT SUPPORTED',
    );
  });
});

describe('account groups', () => {
  const providers: readonly ProfileProvider[] = [
    {
      id: 'example-agent',
      label: 'Example Agent',
      support: {
        supported: true,
        identity: 'native-status',
        sharedSurfaces: ['~/.example/skills'],
        nativeDefaultRoot: '/home/user/.example',
      },
    },
    {
      id: 'other-agent',
      label: 'Other Agent',
      support: { supported: false, identity: 'none', sharedSurfaces: [] },
    },
  ];

  const profiles: readonly AgentProfile[] = [
    {
      id: '9a7f',
      provider: 'example-agent',
      label: 'Work',
      kind: 'managed',
      dataRoot: '/home/user/.puppeteer/profiles/example-agent/9a7f',
      createdAt: '2026-09-01T09:00:00.000Z',
      identity: {
        loggedIn: true,
        email: 'person@example.com',
        plan: 'Team',
        verifiedAt: '2026-09-06T10:00:00.000Z',
        source: { kind: 'native-status', stability: 'documented' },
      },
    },
    {
      id: 'example-agent:native-default',
      provider: 'example-agent',
      label: 'Default',
      kind: 'native-default',
      dataRoot: '/home/user/.example',
      createdAt: '2026-09-01T09:00:00.000Z',
    },
    {
      id: 'other-agent:native-default',
      provider: 'other-agent',
      label: 'Default',
      kind: 'native-default',
      dataRoot: '/home/user/.other',
      createdAt: '2026-09-01T09:00:00.000Z',
    },
  ];

  it('groups accounts under their provider, native root first, and marks the default', () => {
    const [example, other] = profileGroupViews(providers, profiles, { 'example-agent': '9a7f' }, NOW);
    expect(example?.profiles.map((profile) => [profile.label, profile.kindLabel, profile.isDefault])).toEqual([
      ['Default', 'native root', false],
      ['Work', 'managed root', true],
    ]);
    expect(example?.supportText).toBe('identity from the native status command');
    expect(other?.supported).toBe(false);
    expect(other?.profiles[0]?.canVerify).toBe(false);
  });

  it('says what the native status surface reported, without repeating a token', () => {
    const [example] = profileGroupViews(providers, profiles, {}, NOW);
    const work = example?.profiles.find((profile) => profile.label === 'Work');
    expect(work?.identityText).toBe('SIGNED IN');
    expect(work?.identityDetail).toBe('person@example.com · Team · 2h ago');
    expect(example?.profiles[0]?.identityText).toBe('NOT VERIFIED');
  });

  it('allows removal only for a runtime-allocated root', () => {
    const [example] = profileGroupViews(providers, profiles, {}, NOW);
    expect(example?.profiles.map((profile) => profile.canRemove)).toEqual([false, true]);
  });

  describe('sign-ins', () => {
    const verified = {
      verifiedAt: '2026-09-06T10:00:00.000Z',
      source: { kind: 'native-protocol', stability: 'experimental' },
    } as const;
    const portal = {
      service: { id: 'example-service', label: 'Example Service' },
      method: 'oauth',
      subscription: true,
      inUse: true,
      email: 'person@example.com',
      plan: 'Pro',
    };
    const key = { service: { id: 'other-service', label: 'Other Service' }, method: 'api-key' };
    const handle = { service: { id: 'third-service', label: 'Third Service' }, method: 'oauth', account: 'person' };

    function accountRow(identity: ProfileIdentity) {
      const [example] = profileGroupViews(providers, [{ ...profiles[0]!, identity }], {}, NOW);
      return example?.profiles[0];
    }

    it('names an account handle before the email beside it', () => {
      expect(
        accountRow({ loggedIn: true, account: 'person', email: 'person@example.com', plan: 'Team', ...verified }),
      ).toMatchObject({ identityText: 'SIGNED IN', identityDetail: 'person · person@example.com · Team · 2h ago' });
    });

    it('shows the sign-in in use, who it is and on which plan, and how many others the root holds', () => {
      const row = accountRow({
        loggedIn: true,
        method: 'oauth',
        email: 'person@example.com',
        plan: 'Pro',
        signIns: [key, portal, handle],
        ...verified,
      });
      expect(row?.identityText).toBe('SIGNED IN');
      expect(row?.identityDetail).toBe('Example Service · person@example.com · Pro · +2 more · 2h ago');
      expect(row?.identityTitle).toBe(
        [
          'Other Service · api-key',
          'Example Service · person@example.com · Pro (in use)',
          'Third Service · person',
        ].join('\n'),
      );
      // Nobody to name and no plan: how it signs in says the rest.
      expect(
        accountRow({ loggedIn: true, method: 'api-key', signIns: [{ ...key, inUse: true }], ...verified })
          ?.identityDetail,
      ).toBe('Other Service · api-key · 2h ago');
    });

    it('counts sign-ins when none is in use, and reads an empty list as signed out', () => {
      expect(accountRow({ loggedIn: true, signIns: [key, handle], ...verified })).toMatchObject({
        identityText: 'SIGNED IN',
        identityDetail: '2 sign-ins · 2h ago',
      });
      expect(accountRow({ loggedIn: true, signIns: [handle], ...verified })?.identityDetail).toBe('1 sign-in · 2h ago');
      const signedOut = accountRow({ loggedIn: false, signIns: [], ...verified });
      expect(signedOut).toMatchObject({ identityText: 'SIGNED OUT', identityDetail: '2h ago' });
      expect(signedOut?.identityTitle).toBeUndefined();
    });
  });

  it('indexes labels by account id for surfaces that only carry the id', () => {
    expect(profileLabelIndex(profiles).get('9a7f')).toBe('Work');
  });
});

describe('formatAge', () => {
  it('reads recent times in words and falls back to a date', () => {
    expect(formatAge('2026-09-06T11:59:30.000Z', NOW)).toBe('just now');
    expect(formatAge('2026-09-06T11:30:00.000Z', NOW)).toBe('30m ago');
    expect(formatAge('2026-09-06T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(formatAge('2026-09-04T12:00:00.000Z', NOW)).toBe('2d ago');
    expect(formatAge('2026-08-01T12:00:00.000Z', NOW)).toMatch(/AUG/i);
    expect(formatAge(undefined, NOW)).toBeUndefined();
    expect(formatAge('not a time', NOW)).toBeUndefined();
  });
});
