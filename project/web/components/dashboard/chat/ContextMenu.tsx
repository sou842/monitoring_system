'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from '../../ui/Icon';
import { Emoji, onMenuKeyDown, useDismiss } from './shared';

/** One line of the menu. */
export interface MenuEntry { label: string; icon: IconName; onSelect: () => void; danger?: boolean }

/** Gap between the menu and the screen edge. */
const EDGE_PX = 8;
/** Gap between the reaction bar and the menu. */
const BAR_GAP_PX = 8;

/**
 * The message menu: a strip of reactions above a list of actions, opened at the pointer (right-click,
 * long-press) or next to the message (keyboard). Rendered into <body> inside its own `.tg` wrapper so
 * the chat colours apply and no ancestor's transform or filter can shift it. Closes on Escape, a press
 * outside, scrolling or resizing; focus then goes back to `returnFocus`.
 */
export function ContextMenu({ x, y, items, reactions, onClose, returnFocus }: {
  x: number;
  y: number;
  items: MenuEntry[];
  /** Emoji strip; omitted when the person can't react. */
  reactions?: { emoji: string; label: string; mine: boolean; onSelect: () => void }[];
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ menu: CSSProperties; bar: CSSProperties } | null>(null);
  const focusBack = useRef<HTMLElement | null>(returnFocus ?? null);
  focusBack.current = returnFocus ?? null;

  useDismiss(true, wrap, onClose, focusBack);

  // Fit on screen: open down and right from the point, flip when there is no room.
  useLayoutEffect(() => {
    const m = menu.current;
    if (!m) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    const bw = bar.current?.offsetWidth ?? 0;
    const bh = bar.current ? bar.current.offsetHeight + BAR_GAP_PX : 0;
    const left = Math.max(EDGE_PX, Math.min(x, vw - mw - EDGE_PX));
    const down = y + mh + EDGE_PX <= vh || y - mh < EDGE_PX;
    let top = down ? y : y - mh;
    // The bar goes above the menu; if that leaves the screen, below it.
    let barTop = top - bh;
    if (bh && barTop < EDGE_PX) {
      if (down) { top = Math.min(Math.max(top, EDGE_PX + bh), vh - mh - EDGE_PX); barTop = top - bh; }
      if (barTop < EDGE_PX) barTop = top + mh + BAR_GAP_PX;
    }
    top = Math.max(EDGE_PX, Math.min(top, vh - mh - EDGE_PX));
    const barLeft = Math.max(EDGE_PX, Math.min(left, vw - bw - EDGE_PX));
    const originX = x - left < mw / 2 ? 'left' : 'right';
    setPlace({
      menu: { left, top, transformOrigin: `${originX} ${down ? 'top' : 'bottom'}` },
      bar: { left: barLeft, top: barTop, transformOrigin: `${originX} bottom` },
    });
  }, [x, y]);

  // Focus the first action once placed; close when the page scrolls or resizes under it.
  useEffect(() => {
    if (!place) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus());
  }, [place]);
  useEffect(() => {
    const close = (e: Event) => { if (!(e.target instanceof Node && wrap.current?.contains(e.target))) onClose(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', onClose); };
  }, [onClose]);

  const choose = (fn: () => void) => () => { onClose(); focusBack.current?.focus({ preventScroll: true }); fn(); };
  const hidden: CSSProperties = { left: -9999, top: -9999, visibility: 'hidden' };

  return createPortal(
    <div className="tg" ref={wrap} role="presentation" onKeyDown={onMenuKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {reactions && reactions.length > 0 ? (
        <div ref={bar} className="tg-menu-reactions" style={place?.bar ?? hidden} role="menu" aria-label="React">
          {reactions.map((r) => (
            <button key={r.emoji} type="button" role="menuitemradio" aria-checked={r.mine} aria-label={r.label} title={r.label} onClick={choose(r.onSelect)}><Emoji emoji={r.emoji} size={30} play /></button>
          ))}
        </div>
      ) : null}
      <div ref={menu} className="tg-menu" style={place?.menu ?? hidden} role="menu" aria-label="Message actions">
        {items.map((item) => (
          <button key={item.label} type="button" role="menuitem" className={cn('tg-menu-item', item.danger && 'is-danger')} onClick={choose(item.onSelect)}>
            <Icon name={item.icon} className="size-[18px] shrink-0 opacity-80" />{item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
