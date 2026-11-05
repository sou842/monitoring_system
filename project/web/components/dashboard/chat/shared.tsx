'use client';

import Link from 'next/link';
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
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
export function IssueCard({ issue, onRemove }: { issue: ChatIssueView; onRemove?: () => void }) {
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
  const frame = 'flex w-full max-w-md items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2 text-fg no-underline';
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
