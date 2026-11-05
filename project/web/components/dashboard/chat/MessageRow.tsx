'use client';

import { memo, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CHAT_REACTIONS } from '@/lib/chat';
import { plainText } from '@/lib/chatText';
import type { ChatMessageView, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar } from '../../ui/bits';
import { Icon } from '../../ui/Icon';
import { MessageBody } from './MessageBody';
import { clock, fullDate, ICON_BUTTON, IssueCard, MENU_ITEM, onMenuKeyDown, POPOVER, useDismiss, useFocusFirst } from './shared';

/** One line of the conversation: a stored message, or one still being sent / that failed. */
export type Row = { key: string; msg: ChatMessageView; status: 'sent' | 'sending' | 'failed'; clientId?: string; error?: string | null };

/** What a row can ask the page to do. The object is stable (see ChatView), so rows only re-render when their own data changes. */
export interface RowActions {
  reply: (m: ChatMessageView) => void;
  react: (id: string, emoji: string) => void;
  remove: (m: ChatMessageView) => void;
  copyText: (m: ChatMessageView) => void;
  copyLink: (m: ChatMessageView) => void;
  jumpTo: (id: string) => void;
  retry: (clientId: string) => void;
  discard: (clientId: string) => void;
  /** Touch screens have no hover: tapping a message selects it, which shows its toolbar. */
  select: (key: string | null) => void;
  /** Pixels between `el` and the bottom of the message list (a popup with less room opens upwards). */
  roomBelow: (el: HTMLElement) => number;
}

/** The reactions the toolbar offers in one click (the full set is behind "Add reaction"). */
const QUICK_REACTIONS = ['👍', '✅', '👀'] as const;
const REACTION_NAMES: Record<string, string> = { '👍': 'thumbs up', '❤️': 'heart', '😂': 'laughing', '🎉': 'party', '👀': 'eyes', '✅': 'done' };
/** Room a popup needs below the toolbar before it flips upwards. */
const POPUP_ROOM_PX = 170;

const reactionLabel = (emoji: string) => REACTION_NAMES[emoji] ?? emoji;

/** Snippet of a quoted message. */
export const snippetOf = (m: { text: string; issues?: unknown[]; hasIssues?: boolean; deleted?: boolean }) =>
  m.deleted ? 'Message deleted' : plainText(m.text) || (m.hasIssues || (m.issues && m.issues.length > 0) ? 'Shared an issue' : '');

export const MessageRow = memo(function MessageRow({ row, groupStart, me, people, canPost, canDelete, selected, actions }: {
  row: Row;
  /** First message of a group: shows the avatar and the name. */
  groupStart: boolean;
  me: { id: string; name: string };
  people: Map<string, PersonView>;
  canPost: boolean;
  canDelete: boolean;
  selected: boolean;
  actions: RowActions;
}) {
  const m = row.msg;
  const own = m.userId === me.id;
  const author = m.userName ?? 'Deleted user';
  const mentionsMe = !own && !m.deleted && m.mentions.includes(me.id);
  const names = useMemo(() => m.mentions.map((id) => people.get(id)?.name).filter((n): n is string => Boolean(n)), [m.mentions, people]);
  const sent = row.status === 'sent' && !m.deleted;

  const [popup, setPopup] = useState<'react' | 'more' | null>(null);
  const [up, setUp] = useState(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useDismiss(popup !== null, toolbar, () => setPopup(null), trigger);
  useFocusFirst(popup !== null, popupRef);

  const open = (which: 'react' | 'more', e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    trigger.current = e.currentTarget;
    setUp(actions.roomBelow(e.currentTarget) < POPUP_ROOM_PX);
    setPopup((p) => (p === which ? null : which));
  };
  const run = (fn: () => void) => () => { setPopup(null); fn(); };

  const time = <time dateTime={m.createdAt} title={fullDate(m.createdAt)}>{clock(m.createdAt)}</time>;

  return (
    <article
      id={`m-${m.id}`}
      data-row=""
      tabIndex={-1}
      aria-label={`${own ? 'You' : author}, ${clock(m.createdAt)}${mentionsMe ? ', mentions you' : ''}${row.status === 'failed' ? ', not sent' : row.status === 'sending' ? ', sending' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button,pre')) return;
        if (window.matchMedia?.('(hover: none)').matches) actions.select(selected ? null : row.key);
      }}
      className={cn(
        'group/row relative flex gap-3 px-4 py-1 outline-none transition-colors md:px-6',
        'hover:bg-(--hover) focus-visible:bg-(--hover) focus-visible:shadow-[inset_0_0_0_2px_var(--mention)]',
        'data-[flash]:bg-(--mention-bg)',
        groupStart ? 'mt-2 pt-1.5' : '',
        mentionsMe && 'bg-(--mention-me) shadow-[inset_3px_0_0_var(--mention-me-line)] hover:bg-(--mention-me)',
        (selected || popup) && 'bg-(--hover)',
      )}
    >
      {/* Gutter: the avatar on a group's first message, the time (on hover) on the others. */}
      <div className="w-9 shrink-0 [&>.avatar]:size-9 [&>.avatar]:text-sm">
        {groupStart ? <Avatar name={author} /> : (
          <span className="block pt-[3px] text-right text-[11px] leading-4 text-muted tabular-nums opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100" aria-hidden="true">{clock(m.createdAt)}</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {groupStart ? (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className={cn('truncate text-[14px] leading-5 font-semibold', m.userName ? 'text-fg' : 'text-muted italic')}>{author}</span>
            {own ? <span className="shrink-0 text-[11px] font-medium text-muted">You</span> : null}
            <span className="shrink-0 text-xs text-muted tabular-nums">{time}</span>
          </div>
        ) : null}

        {m.replyTo ? (
          <button type="button" onClick={() => m.replyTo && actions.jumpTo(m.replyTo.id)} title="Go to the original message"
            className="mt-0.5 mb-1 flex w-fit max-w-full min-w-0 cursor-pointer overflow-hidden sm:max-w-xl items-center gap-1.5 rounded-md border-0 bg-transparent p-0 text-left text-[12.5px] leading-5 text-muted shadow-none hover:text-fg focus-visible:outline-2 focus-visible:outline-(--mention)">
            <Icon name="reply" className="size-3.5 shrink-0" />
            <span className="shrink-0 font-semibold text-fg-2">{m.replyTo.userName ?? 'Deleted user'}</span>
            <span className={cn('truncate', m.replyTo.deleted && 'italic')}>{snippetOf(m.replyTo) || 'Message'}</span>
          </button>
        ) : null}

        {m.deleted ? (
          <p className="m-0 text-[13px] leading-[22px] text-muted italic">This message was deleted.</p>
        ) : (
          <div className={cn(row.status !== 'sent' && 'opacity-70')}>
            {m.text ? <MessageBody text={m.text} names={names} myName={me.name} /> : null}
            {m.issues.length > 0 ? (
              <div className={cn('grid gap-1.5', m.text ? 'mt-1.5' : 'mt-0.5')}>
                {m.issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)}
              </div>
            ) : null}
          </div>
        )}

        {row.status === 'sending' ? <p className="m-0 mt-0.5 text-[11px] text-muted" role="status">Sending…</p> : null}
        {row.status === 'failed' && row.clientId ? (
          <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-danger" role="alert">
            <Icon name="alert" className="size-3.5" />
            <span>Not sent{row.error ? ` · ${row.error}` : ''}</span>
            <button type="button" onClick={() => actions.retry(row.clientId as string)} className="inline-flex cursor-pointer items-center gap-1 rounded border-0 bg-transparent p-0 font-semibold text-danger underline underline-offset-2 shadow-none">Retry</button>
            <button type="button" onClick={() => actions.discard(row.clientId as string)} className="cursor-pointer rounded border-0 bg-transparent p-0 text-muted underline underline-offset-2 shadow-none hover:text-fg">Discard</button>
          </p>
        ) : null}

        {m.reactions.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {m.reactions.map((r) => {
              const who = r.names.length > 0 ? r.names.join(', ') : `${r.count}`;
              return (
                <button key={r.emoji} type="button" disabled={!canPost} aria-pressed={r.mine}
                  aria-label={`${reactionLabel(r.emoji)}: ${r.count}, ${who}${r.mine ? '. Click to remove yours' : ''}`}
                  title={`${who} reacted with ${reactionLabel(r.emoji)}`}
                  onClick={() => actions.react(m.id, r.emoji)}
                  className={cn(
                    'inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-xs shadow-none transition-colors disabled:cursor-default',
                    r.mine ? 'border-(--mention)/60 bg-(--mention-bg) text-(--mention-fg)' : 'border-line bg-panel text-fg-2 hover:border-line-strong',
                  )}>
                  <span className="text-[13px] leading-none">{r.emoji}</span><span className="font-medium tabular-nums">{r.count}</span>
                </button>
              );
            })}
            {canPost && sent ? (
              <button type="button" aria-label="Add reaction" title="Add reaction" onClick={(e) => open('react', e)}
                className="grid h-6 w-7 cursor-pointer place-items-center rounded-full border border-line bg-panel p-0 text-muted shadow-none hover:border-line-strong hover:text-fg">
                <Icon name="smilePlus" className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Hover / focus toolbar, Slack-style, over the top-right corner. */}
      {sent ? (
        <div ref={toolbar}
          className={cn(
            'absolute -top-3.5 right-3 z-20 items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5 shadow-(--menu-shadow) md:right-5',
            'hidden group-hover/row:flex group-focus-within/row:flex',
            (selected || popup) && 'flex',
          )}
          role="toolbar" aria-label="Message actions">
          {canPost ? (
            <>
              {QUICK_REACTIONS.map((emoji) => (
                <button key={emoji} type="button" className={cn(ICON_BUTTON, 'text-[15px]')} title={`React with ${reactionLabel(emoji)}`} aria-label={`React with ${reactionLabel(emoji)}`}
                  onClick={(e) => { e.stopPropagation(); actions.react(m.id, emoji); }}>{emoji}</button>
              ))}
              <button type="button" className={ICON_BUTTON} title="Add reaction" aria-label="Add reaction" aria-haspopup="menu" aria-expanded={popup === 'react'} onClick={(e) => open('react', e)}>
                <Icon name="smilePlus" className="size-4" />
              </button>
              <button type="button" className={ICON_BUTTON} title="Reply" aria-label="Reply" onClick={(e) => { e.stopPropagation(); actions.reply(m); }}>
                <Icon name="reply" className="size-4" />
              </button>
            </>
          ) : null}
          <button type="button" className={ICON_BUTTON} title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded={popup === 'more'} onClick={(e) => open('more', e)}>
            <Icon name="more" className="size-4" />
          </button>

          {popup === 'react' ? (
            <div ref={popupRef} role="menu" aria-label="Add reaction" onKeyDown={onMenuKeyDown}
              className={cn(POPOVER, 'absolute right-0 flex gap-0.5 p-1', up ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}>
              {CHAT_REACTIONS.map((emoji) => {
                const mine = m.reactions.some((r) => r.emoji === emoji && r.mine);
                return (
                  <button key={emoji} type="button" role="menuitemradio" aria-checked={mine} aria-label={reactionLabel(emoji)} title={reactionLabel(emoji)}
                    onClick={run(() => actions.react(m.id, emoji))}
                    className={cn(ICON_BUTTON, 'size-9 text-lg', mine && 'bg-(--mention-bg)')}>{emoji}</button>
                );
              })}
            </div>
          ) : null}
          {popup === 'more' ? (
            <div ref={popupRef} role="menu" aria-label="More actions" onKeyDown={onMenuKeyDown}
              className={cn(POPOVER, 'absolute right-0 w-48 p-1', up ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}>
              {canPost ? <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(() => actions.reply(m))}><Icon name="reply" className="size-4 text-muted" />Reply</button> : null}
              {m.text ? <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(() => actions.copyText(m))}><Icon name="copy" className="size-4 text-muted" />Copy text</button> : null}
              <button type="button" role="menuitem" className={MENU_ITEM} onClick={run(() => actions.copyLink(m))}><Icon name="link" className="size-4 text-muted" />Copy link</button>
              {canDelete ? (
                <>
                  <div className="my-1 h-px bg-line" role="separator" />
                  <button type="button" role="menuitem" className={cn(MENU_ITEM, 'text-danger')} onClick={run(() => actions.remove(m))}><Icon name="trash" className="size-4" />Delete message</button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});
