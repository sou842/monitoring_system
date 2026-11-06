'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { CHAT_REACTIONS, EMOJI_PALETTE } from '@/lib/chat';
import { plainText } from '@/lib/chatText';
import type { ChatMessageView, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Icon } from '../../ui/Icon';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { MessageBody } from './MessageBody';
import { BigEmoji, bigEmojiOf, clock, Emoji, fullDate, IssueCard, peerColor } from './shared';

/** One line of the conversation: a stored message, or one still being sent / that failed. */
export type Row = { key: string; msg: ChatMessageView; status: 'sent' | 'sending' | 'failed'; clientId?: string; error?: string | null };

/** What a row can ask the page to do. The object is stable (see ChatView), so rows only re-render when their own data changes. */
export interface RowActions {
  reply: (m: ChatMessageView) => void;
  react: (id: string, emoji: string) => void;
  remove: (m: ChatMessageView) => void;
  /** Opens your own message in the message box for editing. */
  edit: (m: ChatMessageView) => void;
  copyText: (m: ChatMessageView) => void;
  copyLink: (m: ChatMessageView) => void;
  jumpTo: (id: string) => void;
  retry: (clientId: string) => void;
  discard: (clientId: string) => void;
}

const REACTION_NAMES: Record<string, string> = { '👍': 'like', '👎': 'dislike', '❤️': 'heart', '😂': 'laughing', '🔥': 'fire', '👏': 'clap' };
const PALETTE_NAMES = new Map(EMOJI_PALETTE);
const reactionLabel = (emoji: string) => REACTION_NAMES[emoji] ?? PALETTE_NAMES.get(emoji) ?? emoji;

/** Touch: how long a press must last to open the menu. */
const LONG_PRESS_MS = 420;
/** Touch: movement that turns a press into a scroll or a swipe. */
const DRAG_START_PX = 8;
/** Swipe-to-reply: how far the bubble follows the finger, and the distance that triggers a reply. */
const SWIPE_MAX_PX = 84;
const SWIPE_REPLY_PX = 56;

/** A reaction under a message: Noto emoji (animated while hovered or focused) and the count. */
function ReactionChip({ emoji, count, mine, disabled, label, title, onClick }: {
  emoji: string; count: number; mine: boolean; disabled: boolean; label: string; title: string; onClick: () => void;
}) {
  const [play, setPlay] = useState(false);
  return (
    <button type="button" className="tg-reaction" disabled={disabled} aria-pressed={mine} aria-label={label} title={title} onClick={onClick}
      onPointerEnter={() => setPlay(true)} onPointerLeave={() => setPlay(false)} onFocus={() => setPlay(true)} onBlur={() => setPlay(false)}>
      <Emoji emoji={emoji} size={20} play={play} /><span className="tabular-nums">{count}</span>
    </button>
  );
}

/** Snippet of a quoted message. */
export const snippetOf = (m: { text: string; issues?: unknown[]; hasIssues?: boolean; deleted?: boolean }) =>
  m.deleted ? 'Message deleted' : plainText(m.text) || (m.hasIssues || (m.issues && m.issues.length > 0) ? 'Shared an issue' : '');

/** Whether the person has text selected inside `el` (then right-click keeps the browser's own menu, for copying). */
function hasSelectionIn(el: HTMLElement): boolean {
  const s = window.getSelection();
  return Boolean(s && !s.isCollapsed && s.toString().trim() && s.anchorNode && el.contains(s.anchorNode));
}

/**
 * One message as a bubble: others' on the left, yours on the right; the last bubble of a group has a tail.
 * Right-click or long-press opens the menu (reactions + actions), double-click or swipe left replies,
 * and from the keyboard Enter / the Menu key / Shift+F10 open the menu of the focused message.
 */
export const MessageRow = memo(function MessageRow({ row, first, last, animate, me, people, canPost, canDelete, editing, actions }: {
  row: Row;
  /** First bubble of a group (shows the sender's name). */
  first: boolean;
  /** Last bubble of a group (has the tail). */
  last: boolean;
  /** Arrived after the chat opened: slides in. */
  animate: boolean;
  me: { id: string; name: string };
  people: Map<string, PersonView>;
  canPost: boolean;
  canDelete: boolean;
  /** The inline editor is open on this message. */
  /** This message is open in the message box (it gets an outline). */
  editing: boolean;
  actions: RowActions;
}) {
  const m = row.msg;
  const own = m.userId === me.id;
  const author = m.userName ?? 'Deleted user';
  const mentionsMe = !own && !m.deleted && m.mentions.includes(me.id);
  const names = useMemo(() => m.mentions.map((id) => people.get(id)?.name).filter((n): n is string => Boolean(n)), [m.mentions, people]);
  const sent = row.status === 'sent' && !m.deleted;
  const hasMenu = sent || row.status === 'failed';
  const canEdit = own && sent && canPost;

  const article = useRef<HTMLElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // ---- touch: long-press opens the menu, a sideways drag to the left replies
  const press = useRef<{ x: number; y: number; mode: 'wait' | 'swipe' | 'scroll' | 'done'; timer: number } | null>(null);
  const [swipe, setSwipe] = useState(0);
  const endPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'touch' || !hasMenu || (e.target as HTMLElement).closest('textarea')) return;
    const { clientX: x, clientY: y } = e;
    press.current = {
      x, y, mode: 'wait',
      timer: window.setTimeout(() => {
        if (!press.current || press.current.mode !== 'wait') return;
        press.current.mode = 'done';
        navigator.vibrate?.(8);
        setMenu({ x, y });
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.mode === 'done' || p.mode === 'scroll') return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (p.mode === 'wait') {
      if (Math.abs(dx) < DRAG_START_PX && Math.abs(dy) < DRAG_START_PX) return;
      clearTimeout(p.timer);
      p.mode = canPost && sent && dx < 0 && Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
      if (p.mode === 'swipe') e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (p.mode === 'swipe') setSwipe(Math.max(-SWIPE_MAX_PX, Math.min(0, dx)));
  };
  const onPointerUp = () => {
    if (press.current?.mode === 'swipe' && swipe <= -SWIPE_REPLY_PX) { navigator.vibrate?.(8); actions.reply(m); }
    endPress();
    setSwipe(0);
  };

  // ---- mouse and keyboard
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    if (!hasMenu) return;
    const target = e.target as HTMLElement;
    // Links and selected text keep the browser's menu (open in new tab, copy selection).
    if (target.closest('a') || (bubble.current && hasSelectionIn(bubble.current))) return;
    e.preventDefault();
    endPress();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const onDoubleClick = (e: MouseEvent<HTMLElement>) => {
    if (!canPost || !sent || (e.target as HTMLElement).closest('a,button,pre,input,textarea')) return;
    window.getSelection()?.removeAllRanges();
    actions.reply(m);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || !hasMenu) return;
    if (e.key === 'Enter' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = bubble.current?.getBoundingClientRect();
      if (r) setMenu({ x: own ? r.right - 220 : r.left + 12, y: r.bottom + 4 });
    }
  };

  const entries: MenuEntry[] = row.status === 'failed' && row.clientId
    ? [
      { label: 'Try again', icon: 'retry', onSelect: () => actions.retry(row.clientId as string) },
      ...(m.text ? [{ label: 'Copy text', icon: 'copy' as const, onSelect: () => actions.copyText(m) }] : []),
      { label: 'Discard', icon: 'trashPlain', danger: true, onSelect: () => actions.discard(row.clientId as string) },
    ]
    : [
      ...(canPost ? [{ label: 'Reply', icon: 'reply' as const, onSelect: () => actions.reply(m) }] : []),
      ...(canEdit ? [{ label: 'Edit', icon: 'pencil' as const, onSelect: () => actions.edit(m) }] : []),
      ...(m.text ? [{ label: 'Copy text', icon: 'copy' as const, onSelect: () => actions.copyText(m) }] : []),
      { label: 'Copy link', icon: 'link', onSelect: () => actions.copyLink(m) },
      ...(canDelete ? [{ label: 'Delete', icon: 'trashPlain' as const, danger: true, onSelect: () => actions.remove(m) }] : []),
    ];
  const reactions = canPost && sent
    ? CHAT_REACTIONS.map((emoji) => ({ emoji, label: reactionLabel(emoji), mine: m.reactions.some((r) => r.emoji === emoji && r.mine), onSelect: () => actions.react(m.id, emoji) }))
    : undefined;
  const moreReactions = canPost && sent
    ? { mine: m.reactions.filter((r) => r.mine).map((r) => r.emoji), onSelect: (emoji: string) => actions.react(m.id, emoji) }
    : undefined;

  // ---- the time and delivery state, drawn in the bubble's corner (an invisible copy keeps room for it)
  const status = !own ? null
    : row.status === 'sending' ? <Icon name="clock" className="size-3.5" />
    : row.status === 'failed' ? <Icon name="alert" className="size-3.5 text-(--tg-danger)" />
    : m.deleted ? null : <Icon name="check" className="size-[15px]" />;
  const edited = m.editedAt && !m.deleted ? <span className="tg-edited" title={`Edited ${fullDate(m.editedAt)}`}>edited</span> : null;
  const metaContent = <>{edited}<time dateTime={m.createdAt} title={fullDate(m.createdAt)}>{clock(m.createdAt)}</time>{status}</>;
  const spacer = <span className="tg-meta-spacer" aria-hidden="true">{metaContent}</span>;
  const textLast = Boolean(m.text) && m.reactions.length === 0;
  // Issue cards come first. With nothing above them (no sender name, no reply quote) they run edge to edge at the top of the bubble.
  const flushIssues = m.issues.length > 0 && !(first && !own) && !m.replyTo;
  // The same for the quote of the message being answered.
  const flushQuote = Boolean(m.replyTo) && !(first && !own);
  // A message of only 1–3 emoji (no reply quote, no issue cards) is drawn big, without a bubble.
  const big = !m.deleted && !m.replyTo && m.issues.length === 0 && m.text ? bigEmojiOf(m.text) : null;

  const label = `${own ? 'You' : author}, ${clock(m.createdAt)}${m.editedAt && !m.deleted ? ', edited' : ''}${mentionsMe ? ', mentions you' : ''}${row.status === 'failed' ? ', not sent' : row.status === 'sending' ? ', sending' : ''}`;

  return (
    <article
      ref={article}
      id={`m-${m.id}`}
      data-row=""
      tabIndex={-1}
      aria-label={label}
      aria-haspopup={hasMenu ? 'menu' : undefined}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { endPress(); setSwipe(0); }}
      className={cn('tg-row isolate flex touch-pan-y outline-none', own ? 'justify-end pr-[9px]' : 'justify-start pl-[9px]', last ? 'pb-1.5' : 'pb-[3px]')}
    >
      {row.status === 'failed' ? (
        <button type="button" title={row.error ? `Not sent: ${row.error}` : 'Not sent'} aria-label="Not sent. Show options"
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left - 200, y: r.bottom + 4 }); }}
          className="tg-fade-in mr-2 grid size-[22px] shrink-0 cursor-pointer place-items-center self-end rounded-full border-0 bg-(--tg-danger) p-0 text-[13px] font-bold text-white shadow-none">!</button>
      ) : null}
      <div className="relative min-w-0 max-w-[min(480px,calc(100%-48px))]"
        style={{ transform: swipe ? `translateX(${swipe}px)` : undefined, transition: swipe ? 'none' : 'transform .22s cubic-bezier(.2,.8,.3,1)' }}>
        <div
          ref={bubble}
          className={cn('tg-bubble [-webkit-touch-callout:none] [@media(hover:none)]:select-none', own ? 'is-own' : 'is-in', first && 'is-first', last && 'is-last', big && 'is-big-emoji', animate && 'tg-enter', editing && 'outline-2 outline-offset-2 outline-(--tg-accent)')}
          style={{ '--peer': peerColor(m.userId) } as CSSProperties}
        >
          {first && !own ? (
            <div className="mb-0.5 truncate text-[14px] leading-[18px] font-medium" style={{ color: 'var(--peer)' }}>{author}</div>
          ) : null}

          {m.replyTo ? (
            <button type="button" className={cn('tg-quote', flushQuote && '-mt-1.5 -ml-2.5 mb-1.5 w-[calc(100%+19px)] max-w-none rounded-tl-(--tg-tl) rounded-tr-(--tg-tr) rounded-b-none bg-black/[0.05] py-2 pr-3 pl-3 hover:bg-black/[0.08] dark:bg-white/[0.07] dark:hover:bg-white/10')} style={{ '--peer': peerColor(m.replyTo.userId) } as CSSProperties}
              onClick={() => m.replyTo && actions.jumpTo(m.replyTo.id)} title="Go to the original message">
              <span className="truncate font-medium" style={{ color: 'var(--peer)' }}>{m.replyTo.userName ?? 'Deleted user'}</span>
              <span className={cn('truncate font-normal opacity-90', m.replyTo.deleted && 'italic')}>{snippetOf(m.replyTo) || 'Message'}</span>
            </button>
          ) : null}

          {m.deleted ? (
            <p className="m-0 text-[15px] leading-[21px] italic opacity-70">Message deleted{spacer}</p>
          ) : (
            <div className={cn(row.status === 'sending' && 'opacity-80')}>
              {m.issues.length > 0 ? (
                <div className={cn('grid grid-cols-[minmax(0,1fr)]', flushIssues ? '-mt-1.5 -mr-[9px] -ml-2.5 gap-px overflow-hidden rounded-tl-(--tg-tl) rounded-tr-(--tg-tr)' : 'gap-1', m.text && 'mb-1.5')}>
                  {m.issues.map((issue) => <IssueCard key={issue.id} issue={issue} inBubble flush={flushIssues} />)}
                </div>
              ) : null}
              {big ? <BigEmoji emoji={big} play={animate} /> : m.text ? <MessageBody text={m.text} names={names} myName={me.name} bubble trailing={textLast ? spacer : undefined} /> : null}
              {m.reactions.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {m.reactions.map((r) => {
                    const who = r.names.length > 0 ? r.names.join(', ') : `${r.count}`;
                    return (
                      <ReactionChip key={r.emoji} emoji={r.emoji} count={r.count} mine={r.mine} disabled={!canPost}
                        label={`${reactionLabel(r.emoji)}: ${r.count}, ${who}${r.mine ? '. Click to remove yours' : ''}`}
                        title={`${who} reacted with ${reactionLabel(r.emoji)}`}
                        onClick={() => actions.react(m.id, r.emoji)} />
                    );
                  })}
                  {spacer}
                </div>
              ) : !textLast && !big ? <div className="h-3.5">{spacer}</div> : null}
            </div>
          )}

          <span className="tg-meta">{metaContent}</span>
        </div>

        {swipe < 0 ? (
          <span className="tg-swipe-icon" style={{ right: swipe - 40, opacity: Math.min(1, -swipe / SWIPE_REPLY_PX), transform: `scale(${-swipe >= SWIPE_REPLY_PX ? 1.1 : 0.85})` }} aria-hidden="true">
            <Icon name="reply" className="size-4" />
          </span>
        ) : null}
      </div>

      {row.status === 'failed' ? (
        <span className="sr-only" role="alert">Not sent{row.error ? `: ${row.error}` : ''}. Open the message menu to try again.</span>
      ) : null}

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={entries} reactions={reactions} more={moreReactions} onClose={closeMenu} returnFocus={article.current} /> : null}
    </article>
  );
});
