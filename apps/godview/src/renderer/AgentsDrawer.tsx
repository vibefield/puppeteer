import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentInstallationsSnapshot, ProfileProvider, ReleaseCheckResult, UpdateReceipt } from '../protocol.js';
import { AgentIcon } from './AgentIcon.js';
import type { AgentProfilesState } from './agent-profiles.js';
import {
  installRowViews,
  profileGroupViews,
  releaseView,
  updateReceiptView,
  type InstallRowView,
  type ReleaseView,
  type UpdateReceiptView,
} from './agents-drawer.js';

/**
 * The shell's Agents drawer: what is installed, and which accounts exist.
 *
 * It is chrome, so the design system binds it — the instrument's type scale,
 * the panel material, and state shown as words and marks rather than as tinted
 * rows. Every action is a named runtime service; the drawer knows no provider.
 */

type DrawerTab = 'installs' | 'accounts';

interface Busy {
  [key: string]: boolean;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="vf-agents-drawer-fact">
      <small>{label}</small>
      <span title={value}>{value}</span>
    </span>
  );
}

function InstallRow({
  row,
  release,
  receipt,
  busy,
  onCheck,
  onUpdate,
}: {
  row: InstallRowView;
  release?: ReleaseView;
  receipt?: UpdateReceiptView;
  busy: boolean;
  onCheck(): void;
  onUpdate(): void;
}) {
  const behind = release?.channels.some((channel) => channel.behind) ?? false;
  return (
    <li className={`vf-agents-drawer-install is-${row.state}`}>
      <div className="vf-agents-drawer-install-head">
        <span className="vf-agents-drawer-mark" aria-hidden="true">
          <AgentIcon providerId={row.providerId} />
        </span>
        <span className="vf-agents-drawer-name">
          <strong>{row.label}</strong>
          <small>
            {row.state === 'active'
              ? 'launched by Puppeteer'
              : row.state === 'missing'
                ? 'not installed'
                : 'also installed'}
          </small>
        </span>
        <span className="vf-agents-drawer-version">{row.version}</span>
        {behind ? <span className="vf-agents-drawer-mark-behind">BEHIND</span> : null}
      </div>

      {row.state === 'missing' ? null : (
        <div className="vf-agents-drawer-facts">
          <Row label="method" value={row.method} />
          <Row label="found" value={row.origin} />
          <Row label="updates" value={row.autoUpdate} />
          {row.channel ? <Row label="channel" value={row.channel} /> : null}
          {row.location ? <Row label="location" value={row.location} /> : null}
        </div>
      )}

      {release ? (
        <div className="vf-agents-drawer-releases">
          {release.channels.length === 0 ? <small>no release information</small> : null}
          {release.channels.map((channel) => (
            <span className={`vf-agents-drawer-release${channel.behind ? ' is-behind' : ''}`} key={channel.channel}>
              <small>{channel.channel}</small>
              <span>{channel.version}</span>
            </span>
          ))}
          {release.failures.map((failure) => (
            <small className="vf-agents-drawer-note" key={failure}>
              {failure}
            </small>
          ))}
        </div>
      ) : null}

      {receipt ? (
        <p className="vf-agents-drawer-receipt">
          <strong>{receipt.status}</strong>
          <span>{receipt.detail}</span>
        </p>
      ) : null}

      {row.warnings.map((warning) => (
        <small className="vf-agents-drawer-note" key={warning}>
          {warning}
        </small>
      ))}

      {row.state === 'missing' ? null : (
        <div className="vf-agents-drawer-actions">
          <button type="button" disabled={busy} onClick={onCheck}>
            CHECK
          </button>
          <button type="button" disabled={busy || row.state !== 'active'} onClick={onUpdate}>
            UPDATE
          </button>
        </div>
      )}
    </li>
  );
}

function InstallsTab() {
  const [snapshot, setSnapshot] = useState<AgentInstallationsSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [releases, setReleases] = useState<Record<string, ReleaseView>>({});
  const [receipts, setReceipts] = useState<Record<string, UpdateReceiptView>>({});
  const [busy, setBusy] = useState<Busy>({});

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    setLoading(true);
    try {
      setSnapshot(await window.puppeteer.installations(refresh ? { refresh: true } : undefined));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'the inventory could not be read');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const rows = useMemo(() => installRowViews(snapshot), [snapshot]);

  const check = useCallback(async (providerId: string): Promise<void> => {
    setBusy((current) => ({ ...current, [providerId]: true }));
    try {
      const result: ReleaseCheckResult = await window.puppeteer.checkReleases({ providerId });
      setReleases((current) => ({ ...current, [providerId]: releaseView(result) }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'the release check did not finish');
    } finally {
      setBusy((current) => ({ ...current, [providerId]: false }));
    }
  }, []);

  const update = useCallback(
    async (providerId: string): Promise<void> => {
      setBusy((current) => ({ ...current, [providerId]: true }));
      try {
        const receipt: UpdateReceipt = await window.puppeteer.updateInstallation({ providerId });
        setReceipts((current) => ({ ...current, [providerId]: updateReceiptView(receipt) }));
        await load(true);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'the update command did not finish');
      } finally {
        setBusy((current) => ({ ...current, [providerId]: false }));
      }
    },
    [load],
  );

  return (
    <div className="vf-agents-drawer-body">
      <div className="vf-agents-drawer-toolbar">
        <span>{rows.length} EXECUTABLES</span>
        <button type="button" disabled={loading} onClick={() => void load(true)}>
          REFRESH
        </button>
      </div>
      {error ? <p className="vf-agents-drawer-error">{error}</p> : null}
      {loading && rows.length === 0 ? <p className="vf-agents-drawer-empty">INSPECTING…</p> : null}
      <ul className="vf-agents-drawer-list">
        {rows.map((row) => (
          <InstallRow
            key={row.key}
            row={row}
            {...(releases[row.providerId] ? { release: releases[row.providerId] } : {})}
            {...(receipts[row.providerId] ? { receipt: receipts[row.providerId] } : {})}
            busy={busy[row.providerId] === true}
            onCheck={() => void check(row.providerId)}
            onUpdate={() => void update(row.providerId)}
          />
        ))}
      </ul>
    </div>
  );
}

function AccountsTab({ profiles }: { profiles: AgentProfilesState }) {
  const [providers, setProviders] = useState<readonly ProfileProvider[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<Busy>({});
  const [adding, setAdding] = useState<string>();
  const [label, setLabel] = useState('');
  // Verification ages are read as words; a slow tick keeps them honest without
  // re-rendering the drawer on every frame.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.puppeteer.profileProviders().then(
      (next) => {
        if (alive) setProviders(next);
      },
      (failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : 'no account providers are available');
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(
    () => profileGroupViews(providers, profiles.profiles, profiles.defaults, nowMs),
    [nowMs, profiles.defaults, profiles.profiles, providers],
  );

  const run = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy((current) => ({ ...current, [key]: true }));
    try {
      await action();
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'that action did not finish');
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }, []);

  const addAccount = useCallback(
    (providerId: string): Promise<void> =>
      run(`add:${providerId}`, async () => {
        const created = await window.puppeteer.createProfile({ providerId, label: label.trim() || 'New account' });
        if (!('id' in created)) {
          setError(created.message);
          return;
        }
        setAdding(undefined);
        setLabel('');
        // The account exists but holds nothing until the native login has run.
        const started = await window.puppeteer.startProfileLogin({ profileId: created.id });
        if (!('runtimeSessionId' in started)) setError(started.message);
      }),
    [label, run],
  );

  return (
    <div className="vf-agents-drawer-body">
      {error ? <p className="vf-agents-drawer-error">{error}</p> : null}
      {groups.length === 0 ? <p className="vf-agents-drawer-empty">NO ACCOUNT PROVIDERS</p> : null}
      {groups.map((group) => (
        <section className="vf-agents-drawer-group" key={group.providerId}>
          <header>
            <span className="vf-agents-drawer-mark" aria-hidden="true">
              <AgentIcon providerId={group.providerId} />
            </span>
            <strong>{group.label}</strong>
            <small>{group.supportText}</small>
          </header>

          {group.supported ? null : <p className="vf-agents-drawer-note">accounts are not separable for this agent</p>}

          <ul className="vf-agents-drawer-list">
            {group.profiles.map((profile) => {
              const key = `profile:${profile.id}`;
              return (
                <li className="vf-agents-drawer-account" key={profile.id}>
                  <div className="vf-agents-drawer-account-head">
                    <span className="vf-agents-drawer-name">
                      <strong>
                        {profile.isDefault ? <i aria-label="Default for new terminals">◆</i> : null}
                        {profile.label}
                      </strong>
                      <small>{profile.kindLabel}</small>
                    </span>
                    <span className="vf-agents-drawer-identity">
                      <span>{profile.identityText}</span>
                      {profile.identityDetail ? <small>{profile.identityDetail}</small> : null}
                    </span>
                  </div>
                  <div className="vf-agents-drawer-actions">
                    <button
                      type="button"
                      disabled={busy[key] === true}
                      onClick={() =>
                        void run(key, async () => {
                          await window.puppeteer.newTerminalTab({ profileIds: [profile.id] });
                        })
                      }
                    >
                      TERMINAL
                    </button>
                    <button
                      type="button"
                      disabled={busy[key] === true || !profile.canVerify}
                      onClick={() =>
                        void run(key, async () => {
                          const identity = await window.puppeteer.verifyProfile(profile.id);
                          if ('status' in identity) setError(identity.message);
                        })
                      }
                    >
                      VERIFY
                    </button>
                    <button
                      type="button"
                      disabled={busy[key] === true}
                      onClick={() =>
                        void run(key, () =>
                          profiles.setDefault(group.providerId, profile.isDefault ? null : profile.id),
                        )
                      }
                    >
                      {profile.isDefault ? 'UNSET DEFAULT' : 'SET DEFAULT'}
                    </button>
                    <button
                      type="button"
                      disabled={busy[key] === true || !profile.canRemove}
                      onClick={() =>
                        void run(key, async () => {
                          await window.puppeteer.removeProfile(profile.id);
                        })
                      }
                    >
                      REMOVE
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {group.supported ? (
            adding === group.providerId ? (
              <form
                className="vf-agents-drawer-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addAccount(group.providerId);
                }}
              >
                <input
                  aria-label={`Name for the new ${group.label} account`}
                  autoFocus
                  maxLength={64}
                  placeholder="Account name"
                  value={label}
                  onChange={(event) => setLabel(event.currentTarget.value)}
                />
                <button type="submit" disabled={busy[`add:${group.providerId}`] === true}>
                  CREATE AND SIGN IN
                </button>
                <button type="button" onClick={() => setAdding(undefined)}>
                  CANCEL
                </button>
              </form>
            ) : (
              <button
                className="vf-agents-drawer-add-toggle"
                type="button"
                onClick={() => {
                  setAdding(group.providerId);
                  setLabel('');
                }}
              >
                ＋ ADD ACCOUNT
              </button>
            )
          ) : null}

          {group.sharedSurfaces.length > 0 ? (
            <p className="vf-agents-drawer-note">shared by every account: {group.sharedSurfaces.join(', ')}</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function AgentsDrawer({
  open,
  profiles,
  onClose,
}: {
  open: boolean;
  profiles: AgentProfilesState;
  onClose(): void;
}) {
  const [tab, setTab] = useState<DrawerTab>('installs');

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <aside className="vf-agents-drawer" id="vf-agents-drawer" aria-label="Installed agents and accounts">
      <header className="vf-agents-drawer-header">
        <span>AGENTS</span>
        <nav className="vf-agents-drawer-tabs" aria-label="Agents drawer sections">
          <button
            type="button"
            className={tab === 'installs' ? 'is-current' : undefined}
            aria-pressed={tab === 'installs'}
            onClick={() => setTab('installs')}
          >
            INSTALLS
          </button>
          <button
            type="button"
            className={tab === 'accounts' ? 'is-current' : undefined}
            aria-pressed={tab === 'accounts'}
            onClick={() => setTab('accounts')}
          >
            ACCOUNTS
          </button>
        </nav>
        <button type="button" aria-label="Close the agents drawer" onClick={onClose}>
          ×
        </button>
      </header>
      {tab === 'installs' ? <InstallsTab /> : <AccountsTab profiles={profiles} />}
    </aside>
  );
}
