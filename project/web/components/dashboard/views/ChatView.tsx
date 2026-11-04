'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, useApi } from '@/lib/client/api';
import { useChat, type PendingMessage } from '@/lib/client/chat';
import { CHAT_REACTIONS } from '@/lib/chat';
import { queryString } from '@/lib/format';
import type { ChatIssueView, ChatMessageView, IssuesResponse, MembersResponse, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, Loading } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Pill, pillButton, type Tone } from '../../ui/kit';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { useSession } from '../Shell';

/** A message goes under the previous one without a new header when it's by the same person within this many minutes. */
const GROUP_MINUTES = 5;
/** Pixels from the bottom within which the list counts as "at the bottom" (and follows new messages). */
const STICK_PX = 120;
/** Most issues one message can carry (the server enforces the same). */
const MAX_ISSUES = 5;
/** Issues listed in the "/" picker, and how long typing pauses before it searches. */
const ISSUE_RESULTS = 6;
const ISSUE_SEARCH_DELAY_MS = 200;
/** Tallest the message box grows before it scrolls (px). */
const COMPOSER_MAX_HEIGHT = 144;
/** How long a quoted message stays highlighted after jumping to it. */
const FLASH_MS = 1400;

const EMOJI = ['😀', '😂', '😊', '😍', '🙏', '👏', '🎉', '🔥', '👀', '✅', '❌', '⚠️', '🐛', '🚀', '💡', '🤔', '😅', '😢', '👍', '💪'];
const EVENT_TONE: Record<string, Tone> = { crash: 'dark', error: 'red', performance: 'amber', message: 'neutral' };
const STATUS_TONE: Record<string, Tone> = { open: 'neutral', resolved: 'green', ignored: 'muted' };

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A stable colour for a person's name, from the name itself. */
function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 62% 42%)`;
}

/** `text` with every "@Name" (for the given names) wrapped by `wrap`, the rest left as is. */
function withMentions(text: string, names: string[], wrap: (part: string, key: number) => ReactNode): ReactNode[] {
  if (names.length === 0) return [text];
  const parts = text.split(new RegExp(`(@(?:${names.map(escapeRegex).join('|')}))`, 'g'));
  return parts.map((part, i) => (i % 2 === 1 ? wrap(part, i) : part));
}

/** What a message looks like in a one-line quote or preview. */
const snippetOf = (m: { text: string; issues?: unknown[]; hasIssues?: boolean; deleted?: boolean }) =>
  m.deleted ? 'Message deleted' : m.text || (m.hasIssues || (m.issues && m.issues.length > 0) ? 'Issue' : '');

/** An attached issue: a compact card that opens the issue (or, in the composer, can be removed). */
function IssueCard({ issue, onRemove, tone = 'panel' }: { issue: ChatIssueView; onRemove?: () => void; tone?: 'panel' | 'bubble' }) {
  const dot = issue.eventType === 'crash' ? 'bg-fg' : issue.eventType === 'performance' ? 'bg-amber-500' : issue.eventType === 'message' ? 'bg-muted' : 'bg-red-500';
  const body = (
    <>
      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot)} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
          {issue.errorType}
          <Pill tone={EVENT_TONE[issue.eventType] ?? 'neutral'}>{issue.eventType}</Pill>
          {issue.status !== 'open' ? <Pill tone={STATUS_TONE[issue.status] ?? 'muted'}>{issue.status}</Pill> : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-fg-2">{issue.message || '(no message)'}</span>
        <span className="mt-0.5 block text-xs text-muted">{issue.count.toLocaleString()} {issue.count === 1 ? 'event' : 'events'}</span>
      </span>
    </>
  );
  const frame = cn('flex items-start gap-2.5 rounded-xl px-3 py-2 text-fg no-underline', tone === 'bubble' ? 'bg-black/[.045] dark:bg-white/[.07]' : 'border border-line bg-panel');
  return onRemove ? (
    <span className={cn(frame, 'relative pr-9')}>
      {body}
      <button type="button" onClick={onRemove} aria-label={`Remove ${issue.errorType}`} title="Remove"
        className="absolute top-1.5 right-1.5 grid size-6 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--chip) hover:text-fg">
        <Icon name="close" className="size-3.5" />
      </button>
    </span>
  ) : (
    <Link href={`/issues/${issue.id}`} className={cn(frame, 'transition-colors hover:bg-black/[.08] hover:no-underline dark:hover:bg-white/[.12]')}>{body}</Link>
  );
}

/** The project chat: the active project's single channel, using the whole page (docs/MEMBERS_AND_CHAT.md). */
export function ChatView() {
  const { user, projects, projectId } = useSession();
  const project = projects && projectId ? projects.find((p) => p.id === projectId) : undefined;
  const crumbs = [{ label: 'Chats' }, ...(project ? [{ label: `# ${project.name}` }] : [])];

  if (!projects) return <Page crumbs={crumbs} fill><Loading /></Page>;
  if (!project) {
    return (
      <Page crumbs={crumbs} fill>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-sm">
            <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-(--chip) text-muted"><Icon name="chat" className="size-6" /></div>
            <h2 className="m-0 mb-1 text-base font-semibold text-fg">No chats yet</h2>
            <p className="m-0 text-[13px] text-muted">Every project has a chat for the people who have access to it. Create a project, then add your teammates.</p>
          </div>
        </div>
      </Page>
    );
  }
  return <Channel key={project.id} projectId={project.id} projectName={project.name} canPost={project.permissions.includes('chat.post')} isOwner={project.role === 'owner'} me={{ id: user.id, name: user.name }} crumbs={crumbs} />;
}

type Picker = { kind: 'mention' | 'issue'; query: string; index: number };
/** One line of the conversation: a stored message, or one that is still being sent / failed. */
type Row = { key: string; msg: ChatMessageView; status: 'sent' | 'sending' | 'failed'; clientId?: string; error?: string | null };

function toRow(p: PendingMessage, me: { id: string; name: string }, projectId: string): Row {
  const r = p.draft.replyTo;
  return {
    key: p.clientId,
    clientId: p.clientId,
    status: p.status,
    error: p.error,
    msg: {
      id: p.clientId, projectId, userId: me.id, userName: me.name, text: p.draft.text, mentions: p.draft.mentions, issues: p.draft.issues,
      replyTo: r ? { id: r.id, userName: r.userName, text: r.text.slice(0, 140), deleted: false, hasIssues: r.issues.length > 0 } : null,
      reactions: [], createdAt: p.createdAt, deleted: false,
    },
  };
}

function Channel({ projectId, projectName, canPost, isOwner, me, crumbs }: {
  projectId: string; projectName: string; canPost: boolean; isOwner: boolean; me: { id: string; name: string }; crumbs: Array<{ label: string }>;
}) {
  const chat = useChat(projectId, me);
  const people = useApi<MembersResponse>(`/api/projects/members?projectId=${projectId}`);
  const openDialog = useDialog();
  const { toast, action } = useToast();

  const everyone = useMemo<PersonView[]>(() => (people.data ? [...(people.data.owner ? [people.data.owner] : []), ...people.data.members] : []), [people.data]);
  const byId = useMemo(() => new Map(everyone.map((p) => [p.id, p])), [everyone]);

  const rows = useMemo<Row[]>(
    () => [...chat.messages.map((m): Row => ({ key: m.id, msg: m, status: 'sent' })), ...chat.pending.map((p) => toRow(p, me, projectId))],
    [chat.messages, chat.pending, me, projectId],
  );

  // ---- scrolling: follow new messages while at the bottom; otherwise offer a "jump to latest" button
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const placed = useRef(false);

  // The first unread message of this visit (by someone else, after the time we last read), fixed once the first page is in
  // (decided during that render, so the divider and the starting scroll position know about it).
  const anchorRef = useRef<string | null | undefined>(undefined);
  if (!chat.loading && anchorRef.current === undefined) {
    const since = chat.lastReadAt ? new Date(chat.lastReadAt).getTime() : null;
    anchorRef.current = since === null ? null : (chat.messages.find((m) => m.userId !== me.id && new Date(m.createdAt).getTime() > since)?.id ?? null);
  }
  const unreadAnchor = anchorRef.current ?? null;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const added = rows.length - lastCount.current;
    lastCount.current = rows.length;
    if (rows.length === 0) return;
    if (!placed.current) {
      // First paint of the conversation: start at the first unread message, else at the newest.
      placed.current = true;
      const anchor = unreadAnchor ? document.getElementById(`m-${unreadAnchor}`) : null;
      if (anchor) { el.scrollTop = Math.max(0, anchor.offsetTop - el.offsetTop - 70); setShowJump(true); } else { el.scrollTop = el.scrollHeight; }
      return;
    }
    // Sending a message sets atBottom (see submit), so your own messages always scroll into view.
    if (added > 0) {
      if (atBottom.current) { el.scrollTop = el.scrollHeight; setNewBelow(0); } else { setNewBelow((n) => n + added); setShowJump(true); }
    }
  }, [rows, unreadAnchor]);

  // The list also grows without new messages (a "Not sent" line appears, an issue card renders): while at the bottom, stay there.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setNewBelow(0);
  };
  const jumpTo = (id: string) => {
    const el = document.getElementById(`m-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.dataset.flash = '1';
    setTimeout(() => { delete el.dataset.flash; }, FLASH_MS);
  };

  // ---- composer
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<PersonView[]>([]);
  const [attached, setAttached] = useState<ChatIssueView[]>([]);
  const [replyTo, setReplyTo] = useState<ChatMessageView | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [issueResults, setIssueResults] = useState<ChatIssueView[]>([]);
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  useEffect(() => { if (canPost) box.current?.focus(); }, [canPost, projectId]);

  // The box grows with its text (up to COMPOSER_MAX_HEIGHT, then scrolls).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [text]);

  const mentionOptions = picker?.kind === 'mention' ? everyone.filter((p) => p.id !== me.id && p.name.toLowerCase().includes(picker.query.toLowerCase())).slice(0, 6) : [];
  const options: Array<PersonView | ChatIssueView> = picker?.kind === 'mention' ? mentionOptions : picker?.kind === 'issue' ? issueResults : [];

  // "/" opens the issue picker: search the project's issues as the person types.
  const issueQuery = picker?.kind === 'issue' ? picker.query : null;
  useEffect(() => {
    if (issueQuery === null) return;
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api<IssuesResponse>(`/api/issues${queryString({ projectId, status: 'all', sort: 'lastSeen', q: issueQuery })}`)
        .then((res) => { if (!cancelled) setIssueResults(res.issues.slice(0, ISSUE_RESULTS).map((i) => ({ id: i.id, eventType: i.eventType, errorType: i.errorType, message: i.message, status: i.status, count: i.count }))); })
        .catch(() => { if (!cancelled) setIssueResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, ISSUE_SEARCH_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [issueQuery, projectId]);

  function onChange(value: string) {
    setText(value);
    // "@" or "/" at the start of a word opens a picker for what is typed after it.
    const upToCaret = value.slice(0, box.current?.selectionStart ?? value.length);
    const mention = /(?:^|\s)@([^\s@]{0,30})$/.exec(upToCaret);
    const issue = /(?:^|\s)\/([^\s/]{0,40})$/.exec(upToCaret);
    setPicker(mention ? { kind: 'mention', query: mention[1], index: 0 } : issue && attached.length < MAX_ISSUES ? { kind: 'issue', query: issue[1], index: 0 } : null);
  }

  /** Puts the caret at `position` once React has painted the new text. */
  function caretAt(position: number) {
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(position, position);
    });
  }

  /** Replaces the "@query" or "/query" being typed with `replacement`. */
  function replaceTyped(marker: '@' | '/', replacement: string) {
    const caret = box.current?.selectionStart ?? text.length;
    const head = text.slice(0, caret).replace(new RegExp(`${escapeRegex(marker)}[^\\s@/]{0,40}$`), replacement);
    setText(head + text.slice(caret));
    setPicker(null);
    caretAt(head.length);
  }

  /** Types `insert` at the caret (with a space before it when it would stick to a word). */
  function insertAtCaret(insert: string, open?: Picker['kind']) {
    const el = box.current;
    const caret = el?.selectionStart ?? text.length;
    const gap = open && caret > 0 && !/\s/.test(text[caret - 1]) ? ' ' : '';
    setText(text.slice(0, caret) + gap + insert + text.slice(caret));
    if (open) setPicker({ kind: open, query: '', index: 0 });
    caretAt(caret + gap.length + insert.length);
  }

  function choose(option: PersonView | ChatIssueView) {
    if ('email' in option) {
      replaceTyped('@', `@${option.name} `);
      setPicked((list) => (list.some((p) => p.id === option.id) ? list : [...list, option]));
    } else {
      replaceTyped('/', '');
      setAttached((list) => (list.length >= MAX_ISSUES || list.some((i) => i.id === option.id) ? list : [...list, option]));
    }
  }

  /** Sends at once: the message shows up straight away and is delivered in the background. */
  function submit() {
    const body = text.trim();
    if (!body && attached.length === 0) return;
    chat.send({ text: body, mentions: picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id), issues: attached, replyTo });
    setText('');
    setPicked([]);
    setAttached([]);
    setReplyTo(null);
    setPicker(null);
    setEmojiOpen(false);
    atBottom.current = true;
    box.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker && options.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + 1) % options.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + options.length - 1) % options.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[picker.index]); return; }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (picker) setPicker(null); else if (emojiOpen) setEmojiOpen(false); else setReplyTo(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  }

  // ---- message actions
  const [activeId, setActiveId] = useState<string | null>(null);
  const removeMessage = (m: ChatMessageView) => action(async () => {
    const ok = await openDialog({
      title: 'Delete this message?',
      message: 'It disappears for everyone in this project.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: () => chat.remove(m.id),
    });
    if (ok) toast('Message deleted');
  });
  const copyText = (m: ChatMessageView) => {
    navigator.clipboard.writeText(m.text).then(() => toast('Copied'), () => toast('Could not copy', 'error'));
  };
  const startReply = (m: ChatMessageView) => {
    setReplyTo(m);
    setActiveId(null);
    box.current?.focus();
  };

  // ---- render
  const pickedNames = picked.map((p) => p.name).filter((n) => text.includes(`@${n}`));
  const items: ReactNode[] = [];
  let previous: Row | null = null;
  let unreadShown = false;
  const unreadCount = unreadAnchor ? chat.messages.filter((m) => m.userId !== me.id && m.id >= unreadAnchor).length : 0;
  for (const row of rows) {
    const m = row.msg;
    const newDay = !previous || dayLabel(previous.msg.createdAt) !== dayLabel(m.createdAt);
    if (newDay) {
      items.push(
        <div key={`d-${row.key}`} className="my-3 flex justify-center">
          <span className="rounded-full bg-panel/90 px-3 py-1 text-xs font-medium text-muted shadow-sm">{dayLabel(m.createdAt)}</span>
        </div>,
      );
    }
    if (!unreadShown && unreadAnchor && m.id === unreadAnchor) {
      unreadShown = true;
      items.push(
        <div key="unread" className="my-3 flex justify-center">
          <span className="rounded-full bg-(--mention)/12 px-3 py-1 text-xs font-semibold text-(--mention)">{unreadCount} unread {unreadCount === 1 ? 'message' : 'messages'}</span>
        </div>,
      );
    }
    const own = m.userId === me.id;
    const continued = !newDay && previous !== null && !(unreadShown && m.id === unreadAnchor) && previous.msg.userId === m.userId
      && new Date(m.createdAt).getTime() - new Date(previous.msg.createdAt).getTime() < GROUP_MINUTES * 60000;
    const author = m.userName ?? 'Deleted user';
    const names = m.mentions.map((id) => byId.get(id)?.name).filter((n): n is string => Boolean(n));
    const canDelete = row.status === 'sent' && !m.deleted && (own || isOwner);
    const showTools = row.status === 'sent' && !m.deleted && canPost;
    const time = (
      <span className="float-right mt-1.5 ml-3 inline-flex translate-y-0.5 items-center gap-1 text-[11px] leading-none text-muted select-none" title={new Date(m.createdAt).toLocaleString()}>
        {clock(m.createdAt)}
        {own ? <Icon name={row.status === 'sending' ? 'clock' : row.status === 'failed' ? 'alert' : 'check'} className={cn('size-3.5', row.status === 'failed' && 'text-danger')} /> : null}
      </span>
    );
    items.push(
      <div key={row.key} id={`m-${m.id}`} className={cn('group/row relative flex gap-2 rounded-xl data-[flash]:bg-amber-400/25 data-[flash]:transition-colors', own ? 'justify-end' : 'justify-start', continued ? 'mt-0.5' : 'mt-2.5')}>
        {!own ? <div className="w-8 shrink-0 pt-0.5">{continued ? null : <Avatar name={author} size="sm" />}</div> : null}
        <div className={cn('relative min-w-0 max-w-[84%] sm:max-w-[70%]', own ? 'items-end' : 'items-start')}>
          {showTools ? (
            <div className={cn('absolute -top-9 z-20 hidden items-center gap-0.5 rounded-full border border-line bg-panel p-1 shadow-(--menu-shadow) group-hover/row:flex', activeId === m.id && 'flex', own ? 'right-0' : 'left-0')}>
              {CHAT_REACTIONS.map((e) => (
                <button key={e} type="button" title={`React ${e}`} aria-label={`React ${e}`} onClick={() => { chat.react(m.id, e); setActiveId(null); }}
                  className="grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-[15px] shadow-none hover:bg-(--hover)">{e}</button>
              ))}
              <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
              <button type="button" title="Reply" aria-label="Reply" onClick={() => startReply(m)} className="grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--hover) hover:text-fg"><Icon name="reply" className="size-4" /></button>
              {m.text ? <button type="button" title="Copy" aria-label="Copy text" onClick={() => copyText(m)} className="grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--hover) hover:text-fg"><Icon name="copy" className="size-4" /></button> : null}
              {canDelete ? <button type="button" title="Delete" aria-label="Delete message" onClick={removeMessage(m)} className="grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--hover) hover:text-danger"><Icon name="trash" className="size-4" /></button> : null}
            </div>
          ) : null}

          <div
            onClick={() => { if (showTools) setActiveId((id) => (id === m.id ? null : m.id)); }}
            className={cn(
              'overflow-hidden px-3 py-1.5 text-sm shadow-[0_1px_1px_rgba(0,0,0,.08)]',
              own ? 'bg-[#f6f6f7] dark:bg-[#f6f6f7]' : 'bg-panel',
              continued ? 'rounded-2xl' : own ? 'rounded-2xl rounded-tr-sm' : 'rounded-2xl rounded-tl-sm',
              row.status === 'sending' && 'opacity-80',
            )}
          >
            {!own && !continued ? <div className="mb-0.5 truncate text-[13px] font-semibold dark:brightness-[1.7]" style={{ color: nameColor(author) }}>{author}</div> : null}
            {m.replyTo ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); if (m.replyTo) jumpTo(m.replyTo.id); }}
                className="mb-1 mt-0.5 block w-full cursor-pointer rounded-lg border-0 border-l-4 bg-black/[.045] px-2.5 py-1.5 text-left shadow-none dark:bg-white/[.07]"
                style={{ borderLeftColor: nameColor(m.replyTo.userName ?? 'Deleted user') }}>
                <span className="block truncate text-xs font-semibold" style={{ color: nameColor(m.replyTo.userName ?? 'Deleted user') }}>{m.replyTo.userName ?? 'Deleted user'}</span>
                <span className={cn('block truncate text-xs text-fg-2', m.replyTo.deleted && 'italic')}>{snippetOf(m.replyTo)}</span>
              </button>
            ) : null}
            {m.deleted ? (
              <p className="m-0 text-[13px] text-muted italic">This message was deleted{time}</p>
            ) : (
              <>
                {m.text ? (
                  <p className="m-0 leading-relaxed break-words whitespace-pre-wrap">
                    {withMentions(m.text, names, (part, i) => <span key={i} className="rounded bg-(--mention)/12 text-(--mention)">{part}</span>)}
                    {time}
                  </p>
                ) : null}
                {m.issues.length > 0 ? (
                  <div className={cn('grid gap-1.5', m.text ? 'mt-1.5' : 'mt-0.5')}>
                    {m.issues.map((issue) => <IssueCard key={issue.id} issue={issue} tone="bubble" />)}
                    {!m.text ? <div className="text-right">{time}</div> : null}
                  </div>
                ) : null}
              </>
            )}
            <div className="clear-both" />
          </div>

          {m.reactions.length > 0 ? (
            <div className={cn('relative z-10 -mt-1.5 flex flex-wrap gap-1 px-2', own ? 'justify-end' : 'justify-start')}>
              {m.reactions.map((r) => (
                <button key={r.emoji} type="button" title={r.names.join(', ')} onClick={(e) => { e.stopPropagation(); if (canPost) chat.react(m.id, r.emoji); }}
                  className={cn('inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-1.5 text-xs shadow-sm', r.mine ? 'border-(--mention)/40 bg-(--mention)/12' : 'border-line bg-panel')}>
                  <span>{r.emoji}</span>{r.count > 1 ? <span className="font-medium tabular-nums">{r.count}</span> : null}
                </button>
              ))}
            </div>
          ) : null}

          {row.status === 'failed' && row.clientId ? (
            <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-danger" role="status" title={row.error ?? undefined}>
              <Icon name="alert" className="size-3.5" />
              <span>Not sent</span>
              <button type="button" onClick={() => chat.retry(row.clientId as string)} className="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent p-0 font-semibold text-danger underline shadow-none"><Icon name="retry" className="size-3" />Retry</button>
              <button type="button" onClick={() => chat.discard(row.clientId as string)} className="cursor-pointer rounded-full border-0 bg-transparent p-0 text-muted underline shadow-none">Delete</button>
            </div>
          ) : null}
        </div>
      </div>,
    );
    previous = row;
  }

  const sendable = text.trim().length > 0 || attached.length > 0;

  return (
    <Page crumbs={crumbs} fill>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-line bg-[#eceff1] dark:bg-[#10131a]">
        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            className="h-full overflow-y-auto [background-image:radial-gradient(circle_at_1px_1px,rgba(110,120,140,.16)_1px,transparent_0)] [background-size:22px_22px]"
            onScroll={(e) => {
              const el = e.currentTarget;
              const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
              atBottom.current = near;
              if (near) { setShowJump(false); setNewBelow(0); } else setShowJump(true);
            }}
            onClick={() => setActiveId(null)}
          >
            <div ref={content} className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-3 pt-12 pb-3 md:px-6">
              {chat.error ? (
                <div className="grid flex-1 place-items-center py-10">
                  <div className="inline-flex items-center gap-2 rounded-full bg-panel px-3.5 py-2 text-xs text-muted shadow-sm" role="status">
                    <Icon name="alert" className="size-3.5 text-danger" />Couldn&apos;t load the messages
                    <button type="button" onClick={chat.reload} className="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent p-0 text-xs font-semibold text-fg underline shadow-none"><Icon name="retry" className="size-3" />Try again</button>
                  </div>
                </div>
              ) : chat.loading ? <Loading /> : (
                <>
                  {chat.hasMore ? <div className="pb-2 text-center"><button type="button" className={pillButton('secondary', 'h-8 bg-panel')} onClick={() => void chat.loadOlder()}>Load older messages</button></div> : null}
                  {rows.length === 0 ? (
                    <div className="grid flex-1 place-items-center py-10 text-center">
                      <div className="max-w-sm rounded-3xl bg-panel/90 px-6 py-6 shadow-sm">
                        <div className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-(--chip) text-muted"><Icon name="chat" className="size-6" /></div>
                        <h2 className="m-0 mb-1 text-base font-semibold text-fg"># {projectName}</h2>
                        <p className="m-0 text-[13px] text-muted">The chat for everyone with access to this project. Say hello, mention a teammate with <b>@</b>, or share an issue with <b>/</b>.</p>
                      </div>
                    </div>
                  ) : <div className="mt-auto">{items}</div>}
                </>
              )}
            </div>
          </div>

          <Link href={`/projects/${projectId}?tab=members`} className="absolute top-3 right-4 z-10 inline-flex items-center max-sm:hidden gap-1.5 rounded-full bg-panel/95 px-3 py-1.5 text-xs font-medium text-fg-2 no-underline shadow-sm backdrop-blur hover:text-fg hover:no-underline">
            <Icon name="users" className="size-3.5" />{everyone.length > 0 ? `${everyone.length}` : 'Members'}
            {chat.live ? <span className="size-1.5 rounded-full bg-green-500" title="Live" aria-label="Live" /> : null}
          </Link>

          {showJump ? (
            <button type="button" onClick={jumpToLatest} aria-label="Jump to the latest message" title="Jump to the latest message"
              className="absolute right-4 bottom-4 z-10 grid size-10 cursor-pointer place-items-center rounded-full border border-line bg-panel p-0 text-fg-2 shadow-(--menu-shadow) hover:text-fg">
              <Icon name="arrowDown" className="size-5" />
              {newBelow > 0 ? <span className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-(--mention) px-1 text-[11px] font-semibold text-white">{newBelow > 99 ? '99+' : newBelow}</span> : null}
            </button>
          ) : null}
        </div>

        <footer className="relative shrink-0 border-t border-line bg-panel px-3 py-2.5 md:px-4 flex flex-col justify-center items-center">
          {canPost ? (
            <>
              {picker && (options.length > 0 || (picker.kind === 'issue' && !searching)) ? (
                <ul role="listbox" aria-label={picker.kind === 'mention' ? 'Mention someone' : 'Attach an issue'}
                  className="absolute right-3 bottom-full left-3 z-20 mb-2 mx-auto max-h-80 max-w-xl list-none overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-(--menu-shadow) md:right-4 md:left-4">
                  <li className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted" role="presentation">
                    {picker.kind === 'mention' ? 'People in this project' : searching ? 'Searching issues…' : 'Issues in this project'}
                  </li>
                  {options.length === 0 ? <li className="px-2.5 py-2 text-[13px] text-muted" role="presentation">No issues match “{picker.query}”.</li> : null}
                  {options.map((option, i) => (
                    <li key={option.id} role="option" aria-selected={i === picker.index}>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); choose(option); }} onMouseEnter={() => setPicker({ ...picker, index: i })}
                        className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 py-2 text-left text-[13px] shadow-none', i === picker.index && 'bg-(--hover)')}>
                        {'email' in option ? (
                          <>
                            <Avatar name={option.name} size="sm" />
                            <span className="min-w-0"><b className="block truncate font-medium">{option.name}</b><span className="block truncate text-xs text-muted">{option.email}</span></span>
                          </>
                        ) : (
                          <>
                            <Pill tone={EVENT_TONE[option.eventType] ?? 'neutral'}>{option.eventType}</Pill>
                            <span className="min-w-0 flex-1"><b className="block truncate font-medium">{option.errorType}</b><span className="block truncate text-xs text-muted">{option.message || '(no message)'}</span></span>
                            <span className="shrink-0 text-xs text-muted tabular-nums">{option.count.toLocaleString()}</span>
                          </>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {emojiOpen ? (
                <div role="dialog" aria-label="Emoji" className="absolute bottom-full left-3 z-20 mb-2 grid w-64 grid-cols-7 gap-0.5 rounded-2xl border border-line bg-panel p-2 shadow-(--menu-shadow) md:left-4">
                  {EMOJI.map((e) => (
                    <button key={e} type="button" onMouseDown={(ev) => ev.preventDefault()} onClick={() => insertAtCaret(e)}
                      className="grid size-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent p-0 text-lg shadow-none hover:bg-(--hover)">{e}</button>
                  ))}
                </div>
              ) : null}

              {replyTo ? (
                <div className="w-full max-w-4xl mb-2 flex items-start gap-2 rounded-xl border-l-4 bg-panel-2 py-1.5 pr-1.5 pl-3" style={{ borderLeftColor: nameColor(replyTo.userName ?? 'Deleted user') }}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold" style={{ color: nameColor(replyTo.userName ?? 'Deleted user') }}>Replying to {replyTo.userId === me.id ? 'yourself' : (replyTo.userName ?? 'Deleted user')}</div>
                    <div className="truncate text-xs text-fg-2">{snippetOf(replyTo)}</div>
                  </div>
                  <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply" title="Cancel reply" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--chip) hover:text-fg"><Icon name="close" className="size-3.5" /></button>
                </div>
              ) : null}

              {attached.length > 0 ? (
                <div className="mb-2 grid gap-2 sm:grid-cols-1">
                  {attached.map((issue) => <IssueCard key={issue.id} issue={issue} onRemove={() => setAttached((list) => list.filter((i) => i.id !== issue.id))} />)}
                </div>
              ) : null}

              <div className="flex items-end gap-1.5 max-w-4xl w-full">
                {/* <button type="button" title="Emoji" aria-label="Emoji" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen((o) => !o); setPicker(null); }}
                  className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--hover) hover:text-fg"><Icon name="smile" className="size-5" /></button> */}
                {/* <button type="button" title="Mention someone" aria-label="Mention someone" onClick={() => insertAtCaret('@', 'mention')}
                  className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-base font-semibold text-muted shadow-none hover:bg-(--hover) hover:text-fg max-sm:hidden">@</button>
                <button type="button" title="Attach an issue" aria-label="Attach an issue" disabled={attached.length >= MAX_ISSUES} onClick={() => insertAtCaret('/', 'issue')}
                  className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-base font-semibold text-muted shadow-none hover:bg-(--hover) hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 max-sm:hidden">/</button> */}

                <div className="relative min-w-0 flex-1 rounded-3xl bg-panel-2 px-4 py-2.5">
                  <div className="relative">
                    <div ref={mirror} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden text-sm leading-6 break-words whitespace-pre-wrap text-fg">
                      {withMentions(text, pickedNames, (part, i) => <span key={i} className="rounded-[4px] bg-(--mention)/15 text-(--mention)">{part}</span>)}
                      {'​'}
                    </div>
                    <textarea
                      ref={box}
                      rows={1}
                      value={text}
                      maxLength={4000}
                      placeholder="Type a message"
                      aria-label={`Message ${projectName}`}
                      onChange={(e) => onChange(e.target.value)}
                      onKeyDown={onKeyDown}
                      onScroll={(e) => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; }}
                      className="relative block w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 break-words whitespace-pre-wrap text-transparent caret-(--fg) outline-none placeholder:text-muted"
                      style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
                    />
                  </div>
                </div>

                <button type="button" onClick={submit} disabled={!sendable} aria-label="Send message" title="Send (Enter)"
                  className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-invert-bg p-0 text-invert-fg shadow-none transition-opacity disabled:cursor-not-allowed disabled:opacity-30">
                  <Icon name="send" className="size-4.5" />
                </button>
              </div>
            </>
          ) : (
            <p className="m-0 py-1.5 text-center text-[13px] text-muted">You can read this chat but you don&apos;t have permission to write in it. Ask the project owner.</p>
          )}
        </footer>
      </div>
    </Page>
  );
}
