import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { ProfileGlyph } from '@vibefield/puppeteer-view-sdk/react';
import { Tip } from './InstrumentBar.js';

// THE PROFILE TABS (the VibeField agents-settings record's T3, locked
// 2026-09-22): a sliding segment centred in the instrument bar, between two
// spacers. All first, then each Agent Profile as its glyph and its name — the
// bar's one place for words (§04's "no words", amended for the tabs). The host
// says what a choice does (VibeField recedes the other profiles' bodies; a new
// terminal takes its profile from the spawn bloom, never from the tab — the tab
// stopped starting sessions when SPAWN left the bar); this draws the strip,
// slides the thumb, fits the window, and reports the choice.

export interface ProfileTab {
  /** The profile's id: the host's token, never shown. */
  id: string;
  label: string;
  /** The glyph token (`ProfileGlyph`); a native profile always draws the laptop. */
  glyph?: string | undefined;
  kind?: 'native' | 'managed' | undefined;
  /** The profile new sessions use while All is chosen: its glyph is drawn filled. */
  isDefault?: boolean | undefined;
  /** A session under it is blocked: one orange dot, never a count. */
  blocked?: boolean | undefined;
}

export interface ProfileTabsProps {
  /** The profiles, in the host's order; All comes first on its own. */
  tabs: readonly ProfileTab[];
  /** The chosen profile's id; null is All. */
  selected: string | null;
  onSelect(id: string | null): void;
  /** The host binds ⌥0 (All) … ⌥n, and the tips say so. */
  shortcuts?: boolean;
}

/** Every name; glyphs alone; the chosen tab alone (a click steps to the next). */
type StripFit = 'full' | 'glyphs' | 'chosen';

interface Entry extends Omit<ProfileTab, 'id'> {
  id: string | null;
}

const ALL: Entry = { id: null, label: 'All' };

/** The room the bar leaves the strip: its width less every other item, the gaps, and the spacers at their least. */
function roomFor(strip: HTMLElement): number | undefined {
  const bar = strip.parentElement;
  if (!bar) return undefined;
  const style = getComputedStyle(bar);
  let used = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  let items = 0;
  for (const child of Array.from(bar.children)) {
    if (!(child instanceof HTMLElement) || child.getClientRects().length === 0) continue;
    items += 1;
    if (child === strip) continue;
    used += child.classList.contains('vf-godview-bar-spacer')
      ? parseFloat(getComputedStyle(child).minWidth) || 0
      : child.offsetWidth;
  }
  used += (parseFloat(style.columnGap) || 0) * Math.max(0, items - 1);
  return bar.clientWidth - used;
}

export function ProfileTabs({ tabs, selected, onSelect, shortcuts = false }: ProfileTabsProps): ReactElement {
  const entries: readonly Entry[] = [ALL, ...tabs];
  const chosen = Math.max(
    0,
    entries.findIndex((entry) => entry.id === selected),
  );
  const [fit, setFit] = useState<StripFit>('full');
  const stripRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLElement>(null);
  const slotsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  /** Each fit's measured width, for the words on the tabs as they are now. */
  const key = entries
    .map((entry) => `${entry.label}\u0001${entry.id === null ? '' : 'g'}${entry.blocked ? 'b' : ''}`)
    .join('\u0002');
  const widthsRef = useRef<{ key: string } & Partial<Record<StripFit, number>>>({ key });
  const placedRef = useRef(false);
  const focusChosenRef = useRef(false);

  const place = useCallback((): void => {
    const slot = slotsRef.current[chosenRef.current];
    const thumb = thumbRef.current;
    if (!slot || !thumb) return;
    const first = !placedRef.current;
    // The first placement lands where it belongs; only a choice slides.
    if (first) thumb.style.transition = 'none';
    thumb.style.width = `${slot.offsetWidth}px`;
    thumb.style.transform = `translateX(${slot.offsetLeft}px)`;
    if (first) {
      void thumb.offsetWidth;
      thumb.style.transition = '';
      placedRef.current = true;
    }
  }, []);

  /** Step down when the names no longer fit; back up once a measured wider fit would. */
  const refit = useCallback((): void => {
    const strip = stripRef.current;
    if (!strip) return;
    const current = fitRef.current;
    const widths = widthsRef.current;
    widths[current] = strip.offsetWidth;
    const room = roomFor(strip);
    if (room === undefined) return;
    let next = current;
    if (strip.offsetWidth > room + 0.5) next = current === 'full' ? 'glyphs' : 'chosen';
    else if (current !== 'full' && widths.full !== undefined && widths.full <= room) next = 'full';
    else if (current === 'chosen' && widths.glyphs !== undefined && widths.glyphs <= room) next = 'glyphs';
    if (next !== current) setFit(next);
  }, []);

  useLayoutEffect(() => {
    // New words are new widths: measure from the widest fit again.
    if (widthsRef.current.key !== key) {
      widthsRef.current = { key };
      if (fitRef.current !== 'full') {
        setFit('full');
        return;
      }
    }
    refit();
    place();
    if (focusChosenRef.current) {
      focusChosenRef.current = false;
      slotsRef.current[chosen]?.querySelector('button')?.focus();
    }
  });

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      refit();
      place();
    });
    observer.observe(strip);
    if (strip.parentElement) observer.observe(strip.parentElement);
    return () => observer.disconnect();
  }, [place, refit]);

  const choose = (index: number, fromKeyboard: boolean): void => {
    const entry = entries[(index + entries.length) % entries.length];
    if (!entry) return;
    focusChosenRef.current = fromKeyboard;
    onSelect(entry.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step !== undefined) choose(chosen + step, true);
    else if (event.key === 'Home') choose(0, true);
    else if (event.key === 'End') choose(entries.length - 1, true);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={stripRef}
      className={`vf-godview-profile-tabs is-${fit}`}
      role="tablist"
      aria-label="Agent profiles"
      onKeyDown={onKeyDown}
    >
      <i ref={thumbRef} className="vf-godview-profile-thumb" aria-hidden="true" />
      {entries.map((entry, index) => {
        const on = index === chosen;
        const shortcut = shortcuts ? `⌥${index}` : undefined;
        return (
          <span
            key={entry.id ?? ''}
            ref={(element) => {
              slotsRef.current[index] = element;
            }}
            className="vf-godview-profile-slot"
            hidden={fit === 'chosen' && !on}
          >
            <Tip label={entry.label} {...(shortcut ? { shortcut } : {})}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                className={`vf-godview-profile-tab${on ? ' is-on' : ''}`}
                data-profile-tab={entry.id ?? 'all'}
                aria-label={entry.blocked ? `${entry.label}, a session is blocked` : entry.label}
                // Alone in a narrow bar, the chosen tab is how to reach the others.
                onClick={() => choose(fit === 'chosen' && on ? index + 1 : index, false)}
              >
                {entry.id === null ? null : (
                  <ProfileGlyph
                    glyph={entry.glyph}
                    kind={entry.kind ?? 'managed'}
                    filled={entry.isDefault === true}
                    size={12}
                    className="vf-godview-profile-glyph"
                  />
                )}
                <span className="vf-godview-profile-name">{entry.label}</span>
                {entry.blocked ? <i className="vf-godview-bar-dot is-blocked" aria-hidden="true" /> : null}
              </button>
            </Tip>
          </span>
        );
      })}
    </div>
  );
}
