import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import type { MonitorSpawnDevice, MonitorSpawnProfile, MonitorSpawnTarget } from '@vibecook/puppeteer-view-sdk';
import { ProfileGlyph } from '@vibecook/puppeteer-view-sdk/react';
import {
  blooms,
  budSub,
  defaultProfile,
  deviceWord,
  glyphName,
  initials,
  profileWord,
  ready,
  spawnTargetFor,
  type BloomOpenMenu,
} from '@vibecook/puppeteer-view-sdk/toolkit';

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
//
// It touches nothing outside the view (MV-W2): a press elsewhere in the view
// puts it away through the view's own element (`scope`), and a press anywhere
// outside the view does through the focus leaving the menu (`onBlur`).

export interface ListSpawnMenuProps {
  /** The tree as the bloom reads it (`menuOf`), one that offers a choice. */
  readonly menu: BloomOpenMenu;
  readonly onChoose: (target: MonitorSpawnTarget | undefined) => void;
  /** ⎋ (the focus goes back to the button) or Tab, a click elsewhere (it stays where it went). */
  readonly onClose: (why: 'escape' | 'away') => void;
  /** The button that opened it: pressing it again is its own toggle, never a dismissal. */
  readonly trigger?: RefObject<HTMLElement | null> | undefined;
  /** The view's own element: a press anywhere in it outside the menu puts the menu away. */
  readonly scope?: RefObject<HTMLElement | null> | undefined;
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

export function ListSpawnMenu({ menu, onChoose, onClose, trigger, scope }: ListSpawnMenuProps): ReactElement {
  const devices = menu.kind === 'devices' ? menu.items.map((item) => item.device) : [];
  const [shownId, setShownId] = useState(menu.self.id);
  const shown = devices.find((device) => device.id === shownId) ?? menu.self;
  const [column, setColumn] = useState<Column>(menu.kind === 'devices' ? 'devices' : 'profiles');
  const rootRef = useRef<HTMLDivElement>(null);
  const profiles = menuProfiles(shown);
  // A desktop's face is the initial of what the menu calls it (the one you sit at is "This desktop", M34).
  const faces = initials(devices, deviceWord);

  const rows = (which: Column): HTMLElement[] =>
    Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(`[data-list-spawn-column="${which}"] [role="menuitem"]`) ?? [],
    );
  const focusRow = (which: Column, index: number): void => {
    const list = rows(which);
    list[Math.max(0, Math.min(list.length - 1, index))]?.focus({ preventScroll: true });
  };
  /** Whether a node is the menu's or its button's; undefined for a target that is no node at all. */
  const ours = (target: EventTarget | null): boolean | undefined => {
    if (!(target instanceof Node)) return undefined;
    return Boolean(rootRef.current?.contains(target) || trigger?.current?.contains(target));
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

  // A press anywhere else in the view puts the menu away (the button toggles it itself), heard in the capture phase
  // on the view's own element, before anything under the pointer acts on it.
  useEffect(() => {
    const element = scope?.current;
    if (!element) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (ours(event.target) === false) onClose('away');
    };
    element.addEventListener('pointerdown', onPointerDown, true);
    return () => element.removeEventListener('pointerdown', onPointerDown, true);
    // `ours` reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, scope, trigger]);

  // A press outside the view moves the focus out of the menu (a press on nothing focusable blurs it): that is the
  // view's only word of it. Focus moving between the menu's rows, or to its button, is not leaving.
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (ours(event.relatedTarget) === true) return;
    onClose('away');
  };

  const chooseDevice = (device: MonitorSpawnDevice): void => {
    if (!ready(device)) return;
    onChoose(spawnTargetFor(device, defaultProfile(device)));
  };
  const chooseProfile = (profile: MonitorSpawnProfile): void => {
    onChoose(spawnTargetFor(shown, profile));
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
    // A key goes to the focused element, so the row it came from is the one with the focus.
    const index = list.findIndex((row) => row === event.target);
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
      onBlur={onBlur}
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
                aria-label={`${deviceWord(device)}${device.self ? ', this desktop' : ''}${
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
                <span className="vf-monitor-list-spawn-name">{deviceWord(device)}</span>
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
        aria-label={`Profile on ${deviceWord(shown)}`}
        data-list-spawn-column="profiles"
      >
        <div className="vf-monitor-list-spawn-h" aria-hidden="true">
          Profile on {deviceWord(shown)}
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
