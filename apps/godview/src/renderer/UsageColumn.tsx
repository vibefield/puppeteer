import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AccountUsageBatch } from '../protocol.js';
import { AgentIcon } from './AgentIcon.js';
import { MONITOR_STAGE_CLASS } from './monitor/chrome.js';
import { usageTiles, type UsageTile, type UsageWindowView } from './account-usage.js';

// The usage column (record §05): each account is its mark inside its rings,
// one ring per usage window, the tightest figure beneath. The tiles stack in a
// 46px column down the stage's left edge, sorted by pressure, and scroll when
// more than fit. Hover or focus a tile and its popup opens to the right; it is
// a tooltip, not a menu, and takes no clicks.

const RING_RADIUS: Record<UsageWindowView['slot'], number> = { 0: 8.6, 1: 11.8, 2: 15 };
const UNMEASURED_RADIUS = 11.8;
const POPUP_WIDTH = 192;
const POPUP_GAP = 10;
const POPUP_INSET = 6;
/** Where the connector may sit: inside the popup's rounded corners. */
const ARROW_MIN = 6;
const ARROW_FROM_BOTTOM = 16;

function isUnmeasured(tile: UsageTile): boolean {
  return tile.rings.length === 0;
}

function Rings({ tile }: { tile: UsageTile }) {
  if (isUnmeasured(tile)) {
    return (
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="vf-usage-track" cx="18" cy="18" r={UNMEASURED_RADIUS} pathLength="100" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true">
      {tile.rings.map((ring) => (
        <g key={ring.key}>
          <circle className="vf-usage-track" cx="18" cy="18" r={RING_RADIUS[ring.slot]} pathLength="100" />
          <circle
            className={`vf-usage-fill${ring.hot ? ' is-hot' : ''}`}
            cx="18"
            cy="18"
            r={RING_RADIUS[ring.slot]}
            pathLength="100"
            style={{ strokeDasharray: `${ring.usedPercent} 100` }}
          />
        </g>
      ))}
    </svg>
  );
}

interface PopupProps {
  tile: UsageTile;
  anchor: HTMLElement;
  id: string;
}

/** Placed inside the stage, 10px right of the tile with the top edges aligned,
 * clamped 6px inside; it flips left only when the stage has no room. */
function UsagePopup({ tile, anchor, id }: PopupProps) {
  const stage = anchor.closest<HTMLElement>(`.${MONITOR_STAGE_CLASS}`);
  const popupRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!popup || !stage) return;
    const place = (): void => {
      const stageRect = stage.getBoundingClientRect();
      const tileRect = anchor.getBoundingClientRect();
      const height = popup.offsetHeight;
      let left = tileRect.right - stageRect.left + POPUP_GAP;
      let side = 'is-right';
      if (left + POPUP_WIDTH > stageRect.width - POPUP_INSET) {
        left = tileRect.left - stageRect.left - POPUP_WIDTH - POPUP_GAP;
        side = 'is-left';
      }
      const top = Math.min(
        Math.max(POPUP_INSET, tileRect.top - stageRect.top),
        Math.max(POPUP_INSET, stageRect.height - height - POPUP_INSET),
      );
      const arrow = Math.max(
        ARROW_MIN,
        Math.min(height - ARROW_FROM_BOTTOM, tileRect.top - stageRect.top - top + tileRect.height / 2 - 5),
      );
      popup.classList.remove('is-right', 'is-left');
      popup.classList.add(side);
      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
      popup.style.setProperty('--arrow-y', `${Math.round(arrow)}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(stage);
    observer.observe(popup);
    anchor.parentElement?.addEventListener('scroll', place, { passive: true });
    return () => {
      observer.disconnect();
      anchor.parentElement?.removeEventListener('scroll', place);
    };
  }, [anchor, stage, tile]);

  if (!stage) return null;
  return createPortal(
    <div className="vf-usage-popup" role="tooltip" id={id} ref={popupRef}>
      <div className="vf-usage-popup-head">
        <i className="vf-usage-mark">
          <AgentIcon providerId={tile.providerId} />
        </i>
        <b>
          {tile.label}
          {tile.accountLabel ? <small> {tile.accountLabel}</small> : null}
        </b>
        <span className={tile.state === 'rate-limited' ? 'is-hot' : undefined}>{tile.stateText}</span>
      </div>
      {tile.windows.length > 0 ? (
        tile.windows.map((window) => (
          <div className={`vf-usage-popup-row${window.hot ? ' is-hot' : ''}`} key={window.key} title={window.title}>
            <small>
              <i className={`vf-usage-popup-slot is-${window.slot}`} />
              {window.label}
            </small>
            <i style={{ '--u': `${window.usedPercent}%` } as CSSProperties} />
            <strong>{window.value}</strong>
            <span>{window.resetLabel ? `↻ ${window.resetLabel}` : ''}</span>
          </div>
        ))
      ) : (
        <div className="vf-usage-popup-row is-note">
          <small>{tile.note}</small>
        </div>
      )}
      <div className="vf-usage-popup-foot">
        <span>
          {tile.foot.lead}
          {tile.foot.strong ? <b> {tile.foot.strong}</b> : null}
        </span>
        {tile.foot.count ? <span>{tile.foot.count}</span> : null}
      </div>
    </div>,
    stage,
  );
}

export function UsageColumn() {
  const [batch, setBatch] = useState<AccountUsageBatch>();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [open, setOpen] = useState<{ key: string; anchor: HTMLElement }>();
  const [hidden, setHidden] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const unsubscribe = window.puppeteer.onAccountUsage((next) => {
      if (alive) setBatch(next);
    });
    void window.puppeteer.accountUsage().then(
      (next) => {
        if (alive) setBatch(next);
      },
      () => undefined,
    );
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const tiles = useMemo(() => usageTiles(batch, nowMs), [batch, nowMs]);
  const openTile = open ? tiles.find((tile) => tile.key === open.key) : undefined;

  // The count beneath says how many tiles sit below the scroll area's bottom
  // edge; it goes as the list is scrolled to them and is absent when all fit.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = (): void => {
      const bottom = scroller.scrollTop + scroller.clientHeight;
      let below = 0;
      for (const child of scroller.children) {
        const tile = child as HTMLElement;
        if (tile.offsetTop + tile.offsetHeight > bottom + 1) below += 1;
      }
      setHidden(below);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    scroller.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', measure);
    };
  }, [tiles.length]);

  const show = (key: string, anchor: HTMLElement): void => setOpen({ key, anchor });
  const hide = (key: string): void => setOpen((current) => (current?.key === key ? undefined : current));
  const onFocus = (tile: UsageTile, event: FocusEvent<HTMLButtonElement>): void => show(tile.key, event.currentTarget);

  return (
    <div className="vf-usage-column" aria-label="Agent account usage limits">
      <div className="vf-usage-tiles" ref={scrollRef} aria-live="polite">
        {tiles.map((tile) => {
          const unmeasured = isUnmeasured(tile);
          const isOpen = open?.key === tile.key;
          return (
            <button
              type="button"
              key={tile.key}
              className={`vf-usage-tile is-${tile.state}${unmeasured ? ' is-unmeasured' : ''}${tile.hot ? ' is-hot' : ''}${isOpen ? ' is-open' : ''}`}
              aria-label={tile.aria}
              {...(isOpen ? { 'aria-describedby': 'vf-usage-popup' } : {})}
              onPointerEnter={(event) => show(tile.key, event.currentTarget)}
              onPointerLeave={() => hide(tile.key)}
              onFocus={(event) => onFocus(tile, event)}
              onBlur={() => hide(tile.key)}
            >
              <span className="vf-usage-rings">
                <Rings tile={tile} />
                <i className="vf-usage-mark">
                  <AgentIcon providerId={tile.providerId} />
                </i>
              </span>
              <b className={`${tile.figureFaint ? 'is-faint' : ''}${tile.hot ? ' is-hot' : ''}`.trim() || undefined}>
                {tile.figure}
              </b>
            </button>
          );
        })}
      </div>
      {hidden > 0 ? (
        <span className="vf-usage-more" aria-hidden="true">
          {hidden} ▾
        </span>
      ) : null}
      {open && openTile ? <UsagePopup tile={openTile} anchor={open.anchor} id="vf-usage-popup" /> : null}
    </div>
  );
}
