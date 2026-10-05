import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { ProfileGlyph } from '@vibecook/puppeteer-view-sdk/react';
import type { MonitorSpawnDevice, MonitorSpawnProfile, MonitorSpawnTarget } from '../../monitor/types.js';
import {
  blooms,
  budSub,
  defaultProfile,
  glyphName,
  initials,
  profileWord,
  ready,
  type BloomOpenMenu,
} from '../swarm/bloom/menu.js';

// The list view's door to the spawn bloom's tree (SB-D11): not a bloom — the
// list is the view without a field — but the same two steps as a menu under
// `＋ TERMINAL`. Desktops first when there are two or more, then the chosen
// desktop's Agent Profiles in the feed's order — the bloom's and the tabs'
// order, so 1–9 and ↑↓ count the same rows (SB review M7) — the default marked
// and focused first (the prototype's list stage, draft/spawn-bloom/page.js
// "the list view's two-step menu"). A click or ↵
// commits (the rows are buttons): on a desktop its default, on a profile
// exactly it. ↑↓ move, → steps into a desktop's profiles, ← steps back, ⎋
// closes, Tab closes and moves on.

export interface ListSpawnMenuProps {
  /** The tree as the bloom reads it (`menuOf`), one that offers a choice. */
  readonly menu: BloomOpenMenu;
  readonly onChoose: (target: MonitorSpawnTarget) => void;
  /** ⎋ (the focus goes back to the button) or Tab, a click elsewhere (it stays where it went). */
  readonly onClose: (why: 'escape' | 'away') => void;
}

type Column = 'devices' | 'profiles';

/** A desktop's profiles as the menu lists them: in the feed's order, as the bloom and the tabs list them. */
export function menuProfiles(device: MonitorSpawnDevice): readonly MonitorSpawnProfile[] {
  return device.profiles ?? [];
}

/** Where the keyboard lands in a desktop's profiles: its default. */
export function menuDefaultIndex(device: MonitorSpawnDevice): number {
  const first = defaultProfile(device);
  return first ? menuProfiles(device).indexOf(first) : 0;
}

function signedLine(profile: MonitorSpawnProfile): string {
  return (profile.signedIn ?? []).map((name) => name.toUpperCase()).join(' · ');
}

export function ListSpawnMenu({ menu, onChoose, onClose }: ListSpawnMenuProps): ReactElement {
  const devices = menu.kind === 'devices' ? menu.items.map((item) => item.device) : [];
  const [shownId, setShownId] = useState(menu.self.id);
  const shown = devices.find((device) => device.id === shownId) ?? menu.self;
  const [column, setColumn] = useState<Column>(menu.kind === 'devices' ? 'devices' : 'profiles');
  const rootRef = useRef<HTMLDivElement>(null);
  const profiles = menuProfiles(shown);
  const faces = initials(devices);

  const rows = (which: Column): HTMLElement[] =>
    Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(`[data-list-spawn-column="${which}"] [role="menuitem"]`) ?? [],
    );
  const focusRow = (which: Column, index: number): void => {
    const list = rows(which);
    list[Math.max(0, Math.min(list.length - 1, index))]?.focus({ preventScroll: true });
  };

  // Open with the keyboard on the desktop you sit at, or (one desktop) on its default.
  useLayoutEffect(() => {
    focusRow(
      menu.kind === 'devices' ? 'devices' : 'profiles',
      menu.kind === 'devices' ? devices.indexOf(menu.self) : menuDefaultIndex(menu.self),
    );
    // once, on opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A press anywhere else puts the menu away (the button toggles it itself).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node) || root.contains(target)) return;
      if (target instanceof Element && target.closest('[data-list-spawn-button]')) return;
      onClose('away');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const chooseDevice = (device: MonitorSpawnDevice): void => {
    if (!ready(device)) return;
    onChoose({ deviceId: device.id, profileSet: defaultProfile(device)?.id });
  };
  const chooseProfile = (profile: MonitorSpawnProfile): void => {
    onChoose({ deviceId: shown.id, profileSet: profile.id });
  };
  const show = (device: MonitorSpawnDevice): void => {
    if (ready(device)) setShownId(device.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // the menu holds the keys while it is open
    event.stopPropagation();
    if (event.key === 'Tab') {
      onClose('away');
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const list = rows(column);
    const index = list.findIndex((row) => row === document.activeElement);
    const handled = (): void => event.preventDefault();
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        handled();
        const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % Math.max(1, list.length);
        focusRow(column, index < 0 ? 0 : next);
        if (column === 'devices') {
          const device = devices[index < 0 ? 0 : next];
          if (device) show(device);
        }
        return;
      }
      case 'ArrowRight': {
        if (column !== 'devices' || !blooms(shown)) return;
        handled();
        setColumn('profiles');
        focusRow('profiles', menuDefaultIndex(shown));
        return;
      }
      case 'ArrowLeft': {
        if (column !== 'profiles' || menu.kind !== 'devices') return;
        handled();
        setColumn('devices');
        focusRow('devices', devices.indexOf(shown));
        return;
      }
      case 'Escape':
        handled();
        onClose('escape');
        return;
      default:
    }
  };

  return (
    <div
      ref={rootRef}
      className="vf-monitor-list-spawn"
      role="menu"
      aria-label="New terminal"
      data-list-spawn-step={column}
      onKeyDown={onKeyDown}
    >
      {menu.kind === 'devices' ? (
        <div className="vf-monitor-list-spawn-col" role="group" aria-label="Desktop" data-list-spawn-column="devices">
          <div className="vf-monitor-list-spawn-h" aria-hidden="true">
            Desktop
          </div>
          {devices.map((device, index) => {
            const on = device === shown;
            return (
              <button
                key={device.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`vf-monitor-list-spawn-row${on ? ' is-on' : ''}`}
                aria-disabled={ready(device) ? undefined : true}
                aria-label={`${device.label}${device.self ? ', this desktop' : ''}${
                  ready(device) ? '' : `, ${(device.word || 'unavailable').toLowerCase()}`
                }`}
                data-bloom-bud-kind="device"
                data-bloom-bud-id={device.id}
                // pointing previews a desktop's profiles, unless the keyboard is in them
                onPointerEnter={() => {
                  if (column === 'devices') show(device);
                }}
                onFocus={() => {
                  setColumn('devices');
                  show(device);
                }}
                onClick={() => chooseDevice(device)}
              >
                <span className="vf-monitor-list-spawn-init" aria-hidden="true">
                  {faces[index]}
                </span>
                <span className="vf-monitor-list-spawn-name">{device.label}</span>
                <small>{budSub({ kind: 'device', device, profile: defaultProfile(device) })}</small>
                {blooms(device) ? (
                  <span className="vf-monitor-list-spawn-chev" aria-hidden="true">
                    ›
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className="vf-monitor-list-spawn-col"
        role="group"
        aria-label={`Profile on ${shown.label}`}
        data-list-spawn-column="profiles"
      >
        <div className="vf-monitor-list-spawn-h" aria-hidden="true">
          Profile on {shown.label}
        </div>
        {profiles.length === 0 ? (
          <div className="vf-monitor-list-spawn-note">Reading its profiles · ↵ on it takes its default</div>
        ) : null}
        {profiles.map((profile) => {
          const signed = signedLine(profile);
          const word = profileWord(profile, shown);
          return (
            <button
              key={profile.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="vf-monitor-list-spawn-row is-profile"
              aria-label={`${word}${profile.isDefault ? ', default' : ''}${profile.blocked ? ', waiting on you' : ''}${
                signed ? `, ${signed.toLowerCase().replaceAll(' · ', ', ')} signed in` : ''
              }`}
              data-bloom-bud-kind="profile"
              data-bloom-bud-id={profile.id}
              data-bloom-bud-device={shown.id}
              onFocus={() => setColumn('profiles')}
              onClick={() => chooseProfile(profile)}
            >
              <ProfileGlyph
                kind={glyphName(profile) === 'laptop' ? 'native' : 'managed'}
                glyph={profile.glyph}
                filled={!!profile.isDefault}
                size={12}
              />
              <span className="vf-monitor-list-spawn-name">{word}</span>
              {profile.blocked ? <i className="vf-monitor-list-spawn-dot" aria-hidden="true" /> : null}
              {/* a peer's native set is already called DEFAULT (SB-D10): not said twice */}
              <small>
                {profile.isDefault && word !== 'DEFAULT' ? (signed ? `DEFAULT · ${signed}` : 'DEFAULT') : signed}
              </small>
            </button>
          );
        })}
        {menu.kind === 'devices' ? (
          <div className="vf-monitor-list-spawn-foot" aria-hidden="true">
            ↵ on a desktop takes its default
          </div>
        ) : null}
      </div>
    </div>
  );
}
