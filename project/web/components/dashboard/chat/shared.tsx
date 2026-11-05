'use client';

import Link from 'next/link';
import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { ChatIssueView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from '../../ui/Icon';
import { Badge, type Tone } from '../../ui/kit';

/** "Today", "Yesterday", or a weekday and date. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
/** Hours and minutes in the reader's locale (12 h or 24 h as their system prefers). */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
/** Full date and time, for tooltips. */
export const fullDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

/** How many sender colours chat.css defines (`--peer-0` … `--peer-6`). */
const PEER_COLORS = 7;

/** A person's (or project's) colour: always the same for the same id, readable in both themes. */
export function peerColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `var(--peer-${Math.abs(hash) % PEER_COLORS})`;
}

/** Round avatar with a soft gradient in the person's colour and their initials. */
export function ChatAvatar({ id, name, size = 40, className }: { id: string; name: string; size?: number; className?: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1][0] ?? '') : '')).toUpperCase();
  return (
    <span className={cn('tg-avatar', className)} aria-hidden="true"
      style={{ '--peer': peerColor(id), width: size, height: size, fontSize: Math.round(size * 0.4) } as CSSProperties}>
      {initials}
    </span>
  );
}

/**
 * Emoji drawn with Google Noto Emoji (Apache 2.0) / Noto Animated Emoji (CC BY 4.0), served from
 * public/chat/emoji/<codepoints>.svg (still) and .webp (animated, reactions only), so every system shows the same art.
 */
const NOTO_STILL = new Set(['1f44d', '1f44e', '1f44f', '1f64f', '1f64c', '1f4aa', '1f440', '1f91d', '1f600', '1f602', '1f642', '1f609', '1f914', '1f605', '1f62c', '1f622', '2705', '274c', '26a0_fe0f', '2757', '2753', '1f525', '1f680', '1f389', '1f41b', '1f6e0_fe0f', '1f50d', '1f4cc', '1f4c8', '1f4c9', '23f3', '1f4a1', '2764_fe0f']);
const NOTO_ANIMATED = new Set(['1f44d', '2764_fe0f', '1f602', '1f389', '1f440', '2705']);

function notoCode(emoji: string): string | null {
  const full = [...emoji].map((c) => (c.codePointAt(0) ?? 0).toString(16)).join('_');
  if (NOTO_STILL.has(full)) return full;
  const bare = full.replace(/_fe0f/g, '');
  return NOTO_STILL.has(bare) ? bare : null;
}

const prefersStill = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** One emoji as Noto art (falls back to the system glyph). `play` shows the animated version where one exists. */
export function Emoji({ emoji, size = 20, play = false, className }: { emoji: string; size?: number; play?: boolean; className?: string }) {
  const code = notoCode(emoji);
  if (!code) return <span className={className} style={{ fontSize: size * 0.9, lineHeight: 1 }} aria-hidden="true">{emoji}</span>;
  const animated = play && NOTO_ANIMATED.has(code) && !prefersStill();
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny local files, no optimisation needed
    <img src={`/chat/emoji/${code}.${animated ? 'webp' : 'svg'}`} alt="" aria-hidden="true" width={size} height={size} draggable={false}
      decoding="async" className={cn('inline-block shrink-0 select-none', className)} style={{ width: size, height: size }} />
  );
}

/** "smooth", unless the person asked their system for less motion. */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Closes a popup on a pointer press outside `ref` or on Escape (focus then goes back to `returnTo`). */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void, returnTo?: RefObject<HTMLElement | null>) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
      returnTo?.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true); };
  }, [open, ref, returnTo]);
}

/** Arrow keys / Home / End move focus between the `[role=menuitem]` (or `[role=option]`) buttons of a popup. */
export function onMenuKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled]),[role=menuitemradio]:not([disabled])')];
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next].focus();
}

/** Focuses the first menu item of `ref` once it is on screen. */
export function useFocusFirst(open: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (open) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role=menuitem],[role=menuitemradio]')?.focus());
  }, [open, ref]);
}

/** Round, flat icon button used across the chat (toolbar, composer, header). 32 px: a comfortable pointer and touch target. */
export const ICON_BUTTON =
  'grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent p-0 text-muted shadow-none transition-colors hover:bg-(--hover) hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--mention) disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-(--chip) aria-pressed:text-fg aria-expanded:bg-(--chip) aria-expanded:text-fg';

/** A floating panel (menu, picker). */
export const POPOVER = 'rounded-xl border border-line bg-panel shadow-(--menu-shadow)';

/** A row inside a menu popup. */
export const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-fg shadow-none hover:bg-(--hover) focus-visible:bg-(--hover) focus-visible:outline-none';

const ISSUE_ICON_BY_TYPE: Record<string, IconName> = {
  HttpError: 'serverCrash', NetworkError: 'wifiOff', InvalidJsonResponse: 'fileJson', ResourceError: 'imageOff', CspViolation: 'shieldAlert',
  WorkerError: 'cpu', ConsoleError: 'terminal', CrossOriginScriptError: 'globe', PageNotFound: 'fileSearch', BlankPage: 'blankPage',
  SlowPageLoad: 'hourglass', SlowApiCall: 'timer', MemoryLeakSuspected: 'memory', MainThreadBlocked: 'octagonPause', LowFrameRate: 'gauge',
};
const ISSUE_ICON_BY_EVENT: Record<string, IconName> = { crash: 'bomb', error: 'bug', performance: 'gauge', message: 'messageSquare' };
const ISSUE_TILE: Record<string, string> = {
  crash: 'bg-fg/10 text-fg', error: 'bg-red-500/10 text-red-600 dark:text-red-400', performance: 'bg-amber-500/12 text-amber-700 dark:text-amber-400', message: 'bg-(--chip) text-fg-2',
};
const STATUS_TONE: Record<string, Tone> = { open: 'neutral', resolved: 'green', ignored: 'muted' };

/** The icon of an issue kind. */
export const issueIcon = (issue: Pick<ChatIssueView, 'errorType' | 'eventType'>): IconName => ISSUE_ICON_BY_TYPE[issue.errorType] ?? ISSUE_ICON_BY_EVENT[issue.eventType] ?? 'bug';
export const issueTile = (eventType: string) => ISSUE_TILE[eventType] ?? ISSUE_TILE.error;

/** An attached issue: a one-row card that opens the issue, or (in the composer) can be removed. */
export function IssueCard({ issue, onRemove, inBubble }: { issue: ChatIssueView; onRemove?: () => void; inBubble?: boolean }) {
  const body = (
    <>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', issueTile(issue.eventType))} aria-hidden="true"><Icon name={issueIcon(issue)} className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] leading-5 font-semibold">
          <span className="truncate">{issue.errorType}</span>
          {issue.status !== 'open' ? <Badge tone={STATUS_TONE[issue.status] ?? 'muted'}>{issue.status}</Badge> : null}
        </span>
        <span className="block truncate text-xs leading-4 text-muted">{issue.message || '(no message)'}</span>
      </span>
      <span className="shrink-0 rounded-full bg-(--chip) px-2 py-0.5 text-[11px] font-medium text-fg-2 tabular-nums" title={`${issue.count.toLocaleString()} ${issue.count === 1 ? 'event' : 'events'}`}>
        <span className="sr-only">Events: </span>{issue.count > 999 ? '999+' : issue.count.toLocaleString()}
      </span>
    </>
  );
  const frame = inBubble
    ? 'flex w-full max-w-md items-center gap-2.5 rounded-[10px] border-0 bg-black/[0.045] px-2.5 py-1.5 text-inherit no-underline dark:bg-white/[0.07]'
    : 'flex w-full max-w-md items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2 text-fg no-underline';
  return onRemove ? (
    <span className={cn(frame, 'pr-2')}>
      {body}
      <button type="button" onClick={onRemove} aria-label={`Remove ${issue.errorType}`} title="Remove" className={cn(ICON_BUTTON, 'size-7 rounded-full')}>
        <Icon name="close" className="size-3.5" />
      </button>
    </span>
  ) : (
    <Link href={`/issues/${issue.id}`} className={cn(frame, 'transition-colors hover:border-line-strong hover:bg-(--hover) hover:no-underline focus-visible:outline-2 focus-visible:outline-(--mention)')}>
      <span className="sr-only">Issue: </span>{body}
    </Link>
  );
}
