'use client';

import Link from 'next/link';
import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from 'react';
import { plainText } from '@/lib/chatText';
import type { ChatMessageView, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar } from '../../ui/bits';
import { Icon } from '../../ui/Icon';
import { Badge } from '../../ui/kit';
import { ChatAvatar, clock, dayLabel, ICON_BUTTON, POPOVER, useDismiss } from './shared';

/** Header icon buttons are round, like the rest of the chat. */
const ROUND = cn(ICON_BUTTON, 'size-10 rounded-full text-(--tg-in-meta) hover:text-(--tg-text) [&_svg]:size-[20px]');

/** Most results the in-conversation search lists. */
const SEARCH_RESULTS = 50;
/** Avatars shown stacked on the members button. */
const STACKED_AVATARS = 3;

/** `text` with every case-insensitive occurrence of `query` marked. */
function highlight(text: string, query: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1 && q; i = lower.indexOf(q, at)) {
    out.push(text.slice(at, i), <mark key={i} className="rounded-sm bg-(--mention-me-line)/30 text-fg">{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  out.push(text.slice(at));
  return out;
}

/** The channel bar: name, members, and "find in this conversation". */
export function ChannelHeader({ projectId, projectName, people, ownerId, meId, manageHref, onOpenDrawer, messages, hasMore, onLoadOlder, onJump }: {
  projectId: string;
  projectName: string;
  people: PersonView[];
  ownerId: string | null;
  meId: string;
  manageHref: string;
  onOpenDrawer: () => void;
  messages: ChatMessageView[];
  hasMore: boolean;
  onLoadOlder: () => Promise<void>;
  onJump: (id: string) => void;
}) {
  const [membersOpen, setMembersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const deferred = useDeferredValue(query.trim());
  const membersWrap = useRef<HTMLDivElement>(null);
  const membersButton = useRef<HTMLButtonElement>(null);
  const searchWrap = useRef<HTMLDivElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  useDismiss(membersOpen, membersWrap, () => setMembersOpen(false), membersButton);
  useDismiss(searchOpen, searchWrap, () => setSearchOpen(false), searchButton);

  const results = useMemo(() => {
    if (deferred.length < 2) return [];
    const q = deferred.toLowerCase();
    const found: Array<{ m: ChatMessageView; text: string }> = [];
    for (let i = messages.length - 1; i >= 0 && found.length < SEARCH_RESULTS; i--) {
      const m = messages[i];
      if (m.deleted) continue;
      const text = plainText(m.text);
      if (text.toLowerCase().includes(q) || (m.userName ?? '').toLowerCase().includes(q) || m.issues.some((x) => `${x.errorType} ${x.message}`.toLowerCase().includes(q))) found.push({ m, text });
    }
    return found;
  }, [deferred, messages]);

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2.5 border-b border-(--tg-bar-line) bg-(--tg-bar) px-2 md:px-4">
      <button type="button" onClick={onOpenDrawer} aria-label="Open the menu" title="Menu" className={cn(ROUND, 'md:hidden')}>
        <Icon name="menu" className="size-4.5" />
      </button>
      <ChatAvatar id={projectId} name={projectName} size={40} />
      <div className="min-w-0 flex-1">
        <h1 className="m-0 truncate text-[16px] leading-5 font-medium text-(--tg-text)">{projectName}</h1>
        <p className="m-0 mt-0.5 truncate text-[14px] leading-4 text-(--tg-in-meta)" title="Everyone with access to this project can read this conversation">
          {people.length > 0 ? `${people.length} ${people.length === 1 ? 'member' : 'members'}` : 'project chat'}
        </p>
      </div>

      <div ref={searchWrap} className="relative">
        <button ref={searchButton} type="button" className={ROUND} aria-label="Search this conversation" title="Search this conversation" aria-expanded={searchOpen}
          onClick={() => setSearchOpen((o) => !o)}>
          <Icon name="search" className="size-4" />
        </button>
        {searchOpen ? (
          <div className={cn(POPOVER, 'rounded-2xl text-fg ', 'absolute top-full right-0 mt-2 w-[min(420px,calc(100vw-24px))] overflow-hidden max-sm:-right-12')} role="dialog" aria-label="Search this conversation">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Icon name="search" className="size-4 shrink-0 text-muted" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find messages, people or issues" aria-label="Search messages"
                className="h-11 min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] text-fg shadow-none outline-none placeholder:text-muted" />
              {query ? <button type="button" onClick={() => setQuery('')} className={cn(ICON_BUTTON, 'size-7')} aria-label="Clear search"><Icon name="close" className="size-3.5" /></button> : null}
            </div>
            <div className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5" aria-live="polite">
              {deferred.length < 2 ? (
                <p className="m-0 px-2.5 py-3 text-[13px] text-muted">Type at least 2 characters.</p>
              ) : results.length === 0 ? (
                <p className="m-0 px-2.5 py-3 text-[13px] text-muted">No messages match “{deferred}”.</p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {results.map(({ m, text }) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => { setSearchOpen(false); onJump(m.id); }}
                        className="flex w-full cursor-pointer gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left shadow-none hover:bg-(--hover) focus-visible:bg-(--hover) focus-visible:outline-none">
                        <Avatar name={m.userName ?? 'Deleted user'} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2 text-xs"><b className="truncate font-semibold text-fg">{m.userName ?? 'Deleted user'}</b><span className="shrink-0 text-muted">{dayLabel(m.createdAt)} · {clock(m.createdAt)}</span></span>
                          <span className="line-clamp-2 text-[13px] text-fg-2">{text ? highlight(text, deferred) : m.issues.length > 0 ? 'Shared an issue' : ''}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[11px] text-muted">
              <span>Searching {messages.length.toLocaleString()} loaded {messages.length === 1 ? 'message' : 'messages'}{hasMore ? '; older ones aren’t loaded yet' : ''}</span>
              {hasMore ? (
                <button type="button" disabled={loadingOlder} onClick={() => { setLoadingOlder(true); void onLoadOlder().finally(() => setLoadingOlder(false)); }}
                  className="shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 text-[11px] font-semibold text-fg underline underline-offset-2 shadow-none disabled:opacity-50">
                  {loadingOlder ? 'Loading…' : 'Load older'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div ref={membersWrap} className="relative">
        <button ref={membersButton} type="button" onClick={() => setMembersOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={membersOpen}
          aria-label={`${people.length} ${people.length === 1 ? 'member' : 'members'}`} title="Members"
          className="flex h-10 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent py-0 pr-3 pl-1.5 text-[13px] font-medium text-(--tg-in-meta) shadow-none hover:bg-(--hover) hover:text-(--tg-text) aria-expanded:bg-(--chip)">
          <span className="flex -space-x-1.5 [&_.avatar]:size-6 [&_.avatar]:text-[10px] [&_.avatar]:ring-2 [&_.avatar]:ring-(--tg-bar)">
            {people.slice(0, STACKED_AVATARS).map((p) => <Avatar key={p.id} name={p.name} />)}
          </span>
          <span className="tabular-nums">{people.length || ''}</span>
        </button>
        {membersOpen ? (
          <div role="dialog" aria-label="Project members" className={cn(POPOVER, 'rounded-2xl text-fg ', 'absolute top-full right-0 mt-2 w-72 max-w-[calc(100vw-24px)] overflow-hidden')}>
            <div className="px-3.5 pt-3 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{people.length} {people.length === 1 ? 'member' : 'members'}</div>
            <ul className="m-0 max-h-72 list-none overflow-y-auto p-1.5">
              {people.map((p) => (
                <li key={p.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                  <Avatar name={p.name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[13px] font-medium text-fg">{p.name}{p.id === meId ? <span className="font-normal text-muted"> (you)</span> : null}</b>
                    <span className="block truncate text-xs text-muted">{p.email}</span>
                  </span>
                  {p.id === ownerId ? <Badge tone="neutral">Owner</Badge> : null}
                </li>
              ))}
              {people.length === 0 ? <li className="px-2 py-2 text-[13px] text-muted">No members to show.</li> : null}
            </ul>
            <Link href={manageHref} className="flex items-center gap-2 border-t border-line px-3.5 py-2.5 text-[13px] font-medium text-fg no-underline hover:bg-(--hover) hover:no-underline">
              <Icon name="users" className="size-4 text-muted" />Manage members
            </Link>
          </div>
        ) : null}
      </div>
    </header>
  );
}
