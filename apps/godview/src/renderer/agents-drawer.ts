import type {
  AgentInstallation,
  AgentInstallationsSnapshot,
  AgentProfile,
  DistributionProvider,
  ProfileDefaults,
  ProfileProvider,
  ReleaseCheckResult,
  UpdateReceipt,
} from '../protocol.js';

/**
 * The drawer's display model.
 *
 * Every value here is capability data the runtime already normalized: an
 * install method, a channel name, an account label, an identity a provider
 * read from its own status surface. Nothing branches on which provider it is,
 * and state is carried as words rather than as colour.
 */

export type InstallRowState = 'active' | 'inactive' | 'missing';

export interface InstallRowView {
  key: string;
  providerId: string;
  label: string;
  state: InstallRowState;
  version: string;
  method: string;
  origin: string;
  location?: string;
  autoUpdate: string;
  channel?: string;
  /** True when the provider exposes its own update oracle, so a check needs no network. */
  nativeUpdateCheck: boolean;
  warnings: readonly string[];
}

export interface ReleaseChannelView {
  channel: string;
  version: string;
  behind: boolean;
  source: string;
}

export interface ReleaseView {
  checkedAt: string;
  installedVersion?: string;
  channels: readonly ReleaseChannelView[];
  failures: readonly string[];
}

export interface UpdateReceiptView {
  status: string;
  detail: string;
}

export interface ProfileRowView {
  id: string;
  label: string;
  kind: AgentProfile['kind'];
  kindLabel: string;
  isDefault: boolean;
  /** What the provider's own status surface last reported, in words. */
  identityText: string;
  identityDetail?: string;
  canRemove: boolean;
  canVerify: boolean;
}

export interface ProfileGroupView {
  providerId: string;
  label: string;
  supported: boolean;
  supportText: string;
  sharedSurfaces: readonly string[];
  nativeDefaultRoot?: string;
  profiles: readonly ProfileRowView[];
}

const INSTALL_METHODS: Record<string, string> = {
  'native-installer': 'native installer',
  'vendor-downloader': 'vendor downloader',
  'npm-global': 'npm global',
  brew: 'homebrew',
  'standalone-binary': 'standalone binary',
  'source-checkout': 'source checkout',
  unknown: 'unknown',
};

const INSTALL_ORIGINS: Record<string, string> = {
  configured: 'configured',
  path: 'on PATH',
  'npm-global': 'npm root',
  brew: 'homebrew',
};

const AUTO_UPDATE: Record<string, string> = {
  enabled: 'self-updating',
  disabled: 'manual updates',
  unknown: 'update policy unknown',
};

const IDENTITY_SOURCES: Record<string, string> = {
  'native-status': 'identity from the native status command',
  'native-protocol': 'identity from the native protocol',
  none: 'no identity surface',
};

export function installMethodLabel(method: string): string {
  return INSTALL_METHODS[method] ?? method;
}

function installRow(provider: DistributionProvider, install: AgentInstallation): InstallRowView {
  return {
    key: `${provider.id}:${install.realPath}`,
    providerId: provider.id,
    label: provider.label,
    state: install.active ? 'active' : 'inactive',
    version: install.version ?? '—',
    method: installMethodLabel(install.method),
    origin: INSTALL_ORIGINS[install.origin] ?? install.origin,
    ...(install.location ? { location: install.location } : {}),
    autoUpdate: AUTO_UPDATE[install.autoUpdate] ?? AUTO_UPDATE.unknown!,
    ...(install.channel ? { channel: install.channel } : {}),
    nativeUpdateCheck: provider.nativeUpdateCheck,
    warnings: install.warnings,
  };
}

/**
 * One row per install, the launched one first, and one placeholder row for a
 * provider with nothing installed. Two installs of one agent are normal and
 * are shown rather than hidden.
 */
export function installRowViews(snapshot: AgentInstallationsSnapshot | undefined): InstallRowView[] {
  if (!snapshot) return [];
  const rows: InstallRowView[] = [];
  for (const provider of snapshot.providers) {
    const owned = snapshot.installations.filter((install) => install.provider === provider.id);
    if (owned.length === 0) {
      rows.push({
        key: `${provider.id}:missing`,
        providerId: provider.id,
        label: provider.label,
        state: 'missing',
        version: '—',
        method: 'not installed',
        origin: '—',
        autoUpdate: '—',
        nativeUpdateCheck: provider.nativeUpdateCheck,
        warnings: [],
      });
      continue;
    }
    const ordered = [...owned].sort((left, right) => Number(right.active) - Number(left.active));
    for (const install of ordered) rows.push(installRow(provider, install));
  }
  return rows;
}

/** Newest release per channel, with the runtime's own "behind" verdict kept intact. */
export function releaseView(result: ReleaseCheckResult): ReleaseView {
  const behindByChannel = new Map(result.behind.map((entry) => [entry.channel, entry.version] as const));
  const channels = new Map<string, ReleaseChannelView>();
  for (const release of result.releases) {
    if (channels.has(release.channel)) continue;
    const behindVersion = behindByChannel.get(release.channel);
    channels.set(release.channel, {
      channel: release.channel,
      version: behindVersion ?? release.version,
      behind: behindVersion !== undefined,
      source: release.source.kind,
    });
  }
  for (const [channel, version] of behindByChannel) {
    if (channels.has(channel)) continue;
    channels.set(channel, { channel, version, behind: true, source: 'native-oracle' });
  }
  return {
    checkedAt: result.checkedAt,
    ...(result.installed?.version ? { installedVersion: result.installed.version } : {}),
    channels: [...channels.values()],
    failures: result.failures.map((failure) => failure.message),
  };
}

export function updateReceiptView(receipt: UpdateReceipt): UpdateReceiptView {
  const before = receipt.before?.version ?? '—';
  const after = receipt.after?.version ?? '—';
  if (receipt.status === 'updated') return { status: 'UPDATED', detail: `${before} → ${after}` };
  // The updater exited 0 and nothing moved: current, or it declined — its output says which.
  if (receipt.status === 'unchanged') return { status: 'UNCHANGED', detail: after };
  if (receipt.status === 'already-current') return { status: 'ALREADY CURRENT', detail: after };
  if (receipt.status === 'unsupported') {
    return { status: 'NOT SUPPORTED', detail: receipt.message ?? 'this install updates outside Puppeteer' };
  }
  return { status: 'FAILED', detail: receipt.message ?? 'the update command did not finish' };
}

export function formatAge(timestamp: string | undefined, nowMs: number): string | undefined {
  if (!timestamp) return undefined;
  const atMs = Date.parse(timestamp);
  if (!Number.isFinite(atMs)) return undefined;
  const elapsedMs = Math.max(0, nowMs - atMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(atMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function identityText(
  profile: AgentProfile,
  supported: boolean,
  nowMs: number,
): Pick<ProfileRowView, 'identityText' | 'identityDetail'> {
  const identity = profile.identity;
  if (!identity) return { identityText: supported ? 'NOT VERIFIED' : 'NO IDENTITY SURFACE' };
  const age = formatAge(identity.verifiedAt, nowMs);
  const detail = [identity.email, identity.organization, identity.plan ?? identity.method]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  return {
    identityText: identity.loggedIn ? 'SIGNED IN' : 'SIGNED OUT',
    ...(detail || age ? { identityDetail: [detail, age].filter(Boolean).join(' · ') } : {}),
  };
}

/** Accounts grouped under the provider that owns them, native default first. */
export function profileGroupViews(
  providers: readonly ProfileProvider[],
  profiles: readonly AgentProfile[],
  defaults: ProfileDefaults,
  nowMs: number,
): ProfileGroupView[] {
  return providers.map((provider) => {
    const owned = profiles.filter((profile) => profile.provider === provider.id);
    const ordered = [...owned].sort(
      (left, right) => Number(right.kind === 'native-default') - Number(left.kind === 'native-default'),
    );
    return {
      providerId: provider.id,
      label: provider.label,
      supported: provider.support.supported,
      supportText: IDENTITY_SOURCES[provider.support.identity] ?? IDENTITY_SOURCES.none!,
      sharedSurfaces: provider.support.sharedSurfaces,
      ...(provider.support.nativeDefaultRoot ? { nativeDefaultRoot: provider.support.nativeDefaultRoot } : {}),
      profiles: ordered.map((profile): ProfileRowView => {
        const canVerify = provider.support.identity !== 'none';
        return {
          id: profile.id,
          label: profile.label,
          kind: profile.kind,
          kindLabel: profile.kind === 'native-default' ? 'native root' : 'managed root',
          isDefault: defaults[provider.id] === profile.id,
          canRemove: profile.kind === 'managed',
          canVerify,
          ...identityText(profile, canVerify, nowMs),
        };
      }),
    };
  });
}

/** Labels for every registered account, for surfaces that only carry an id. */
export function profileLabelIndex(profiles: readonly AgentProfile[]): Map<string, string> {
  return new Map(profiles.map((profile) => [profile.id, profile.label] as const));
}
