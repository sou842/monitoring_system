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
import { Icon, type IconName } from '../../ui/Icon';
import { Badge, pillButton, type Tone } from '../../ui/kit';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { useSession } from '../Shell';

/** Pixels from the bottom within which the list counts as "at the bottom" (and follows new messages). */
const STICK_PX = 120;
/** Most issues one message can carry (the server enforces the same). */
const MAX_ISSUES = 5;
/** Issues listed in the "/" picker, and how long typing pauses before it searches. */
const ISSUE_RESULTS = 6;
const ISSUE_SEARCH_DELAY_MS = 200;
/** Tallest the message box grows before it scrolls (px). */
const COMPOSER_MAX_HEIGHT = 144;
/** Room (px) a message's popup needs below its button; with less, it opens upwards instead. */
const POPUP_MENU_PX = 130;
const POPUP_REACT_PX = 56;
/** How long a quoted message stays highlighted after jumping to it. */
const FLASH_MS = 1400;

const EMOJI = ['😀', '😂', '😊', '😍', '🙏', '👏', '🎉', '🔥', '👀', '✅', '❌', '⚠️', '🐛', '🚀', '💡', '🤔', '😅', '😢', '👍', '💪'];
const EVENT_TONE: Record<string, Tone> = { crash: 'dark', error: 'red', performance: 'amber', message: 'neutral' };
/** Maps each reaction emoji to its Lucide icon name, for the reaction picker toolbar. */
const REACTION_ICON_MAP: Record<string, IconName> = { '👍': 'thumbsUp', '❤️': 'heart', '😂': 'smile', '🎉': 'party', '👀': 'eye', '✅': 'checkDouble' };
/** The icon for each kind of issue the SDK reports (by error type); anything else falls back to its event type. */
const ISSUE_ICON_BY_TYPE: Record<string, IconName> = {
  HttpError: 'serverCrash', NetworkError: 'wifiOff', InvalidJsonResponse: 'fileJson', ResourceError: 'imageOff', CspViolation: 'shieldAlert',
  WorkerError: 'cpu', ConsoleError: 'terminal', CrossOriginScriptError: 'globe', PageNotFound: 'fileSearch', BlankPage: 'blankPage',
  SlowPageLoad: 'hourglass', SlowApiCall: 'timer', MemoryLeakSuspected: 'memory', MainThreadBlocked: 'octagonPause', LowFrameRate: 'gauge',
};
const ISSUE_ICON_BY_EVENT: Record<string, IconName> = { crash: 'bomb', error: 'bug', performance: 'gauge', message: 'messageSquare' };
/** Soft tinted tile colours per event type. */
const ISSUE_TILE: Record<string, string> = {
  crash: 'bg-fg/10 text-fg', error: 'bg-red-500/10 text-red-500', performance: 'bg-amber-500/12 text-amber-600 dark:text-amber-400', message: 'bg-(--chip) text-muted',
};
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

/** An attached issue: a compact one-row card that opens the issue (or, in the composer, can be removed). */
function IssueCard({ issue, onRemove }: { issue: ChatIssueView; onRemove?: () => void }) {
  const glyph = ISSUE_ICON_BY_TYPE[issue.errorType] ?? ISSUE_ICON_BY_EVENT[issue.eventType] ?? 'bug';
  const body = (
    <>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', ISSUE_TILE[issue.eventType] ?? ISSUE_TILE.error)} aria-hidden="true"><Icon name={glyph} className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] leading-5 font-semibold">
          <span className="truncate">{issue.errorType}</span>
          {issue.status !== 'open' ? <Badge tone={STATUS_TONE[issue?.status] ?? 'muted'}>{issue.status}</Badge> : null}
        </span>
        <span className="block truncate text-xs leading-4 text-muted">{issue.message || '(no message)'}</span>
      </span>
      <span className="shrink-0 rounded-full bg-(--chip) px-2 py-0.5 text-[11px] font-medium text-fg-2 tabular-nums" title={`${issue.count.toLocaleString()} ${issue.count === 1 ? 'event' : 'events'}`}>{issue.count > 999 ? '999+' : issue.count.toLocaleString()}</span>
    </>
  );
  const frame = 'flex w-full max-w-sm items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-1.5 text-fg no-underline';
  return onRemove ? (
    <span className={cn(frame, 'relative pr-2')}>
      {body}
      <button type="button" onClick={onRemove} aria-label={`Remove ${issue.errorType}`} title="Remove"
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--chip) hover:text-fg">
        <Icon name="close" className="size-3.5" />
      </button>
    </span>
  ) : (
    <Link href={`/issues/${issue.id}`} className={cn(frame, 'transition-colors hover:border-(--fg)/25 hover:no-underline')}>{body}</Link>
  );
}

/** The floating "N members" button at the top right; opens a dropdown listing everyone with access to the project. */
function MembersDropdown({ people, ownerId, meId, live, manageHref }: { people: PersonView[]; ownerId: string | null; meId: string; live: boolean; manageHref: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={wrap} className="relative z-20 shrink-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} title="Members"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 bg-panel/95 px-3 py-1.5 text-xs font-medium text-fg-2 shadow-sm backdrop-blur hover:text-fg">
        <Icon name="users" className="size-3.5" />{people.length > 0 ? people.length : 'Members'}
        {live ? <span className="size-1.5 rounded-full bg-green-500" title="Live" aria-label="Live" /> : null}
        <Icon name="chevron" className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div role="menu" aria-label="Project members" className="absolute top-full right-0 mt-2 w-72 max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--menu-shadow)">
          <div className="px-3.5 pt-3 pb-1.5 text-xs font-medium text-muted">{people.length} {people.length === 1 ? 'member' : 'members'}</div>
          <ul className="m-0 max-h-72 list-none overflow-y-auto p-1.5">
            {people.map((p) => (
              <li key={p.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                <Avatar name={p.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[13px] font-medium text-fg">{p.name}{p.id === meId ? ' (you)' : ''}</b>
                  <span className="block truncate text-xs text-muted">{p.email}</span>
                </span>
                {p.id === ownerId ? <Badge tone="neutral">Owner</Badge> : null}
              </li>
            ))}
            {people.length === 0 ? <li className="px-2 py-2 text-[13px] text-muted">No members to show.</li> : null}
          </ul>
          <Link href={manageHref} className="block border-t border-line px-3.5 py-2.5 text-[13px] font-medium text-fg no-underline hover:bg-(--hover) hover:no-underline">Manage members</Link>
        </div>
      ) : null}
    </div>
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
  const { openDrawer } = useSession();
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
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [openReact, setOpenReact] = useState<string | null>(null);
  // Whether the open popup goes above its button: decided when it opens, from the room left below it in the message list.
  const [popUp, setPopUp] = useState(false);
  const decidePlacement = (button: HTMLElement, needed: number) => {
    const list = scroller.current?.getBoundingClientRect();
    setPopUp(list ? list.bottom - button.getBoundingClientRect().bottom < needed : false);
  };
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
    setOpenMenu(null);
    box.current?.focus();
  };

  // ---- render
  const pickedNames = picked.map((p) => p.name).filter((n) => text.includes(`@${n}`));
  const items: ReactNode[] = [];
  let previous: Row | null = null;
  let unreadShown = false;
  const unreadCount = unreadAnchor ? chat.messages.filter((m) => m.userId !== me.id && m.id >= unreadAnchor).length : 0;
  rows.forEach((row) => {
    const m = row.msg;
    const newDay = !previous || dayLabel(previous.msg.createdAt) !== dayLabel(m.createdAt);
    if (newDay) {
      items.push(
        <div key={`d-${row.key}`} className="mt-4 mb-1 flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="rounded-full border border-line bg-panel px-3 py-0.5 text-xs font-medium text-muted">{dayLabel(m.createdAt)}</span>
          <span className="h-px flex-1 bg-line" />
        </div>,
      );
    }
    if (!unreadShown && unreadAnchor && m.id === unreadAnchor) {
      unreadShown = true;
      items.push(
        <div key="unread" className="mt-3 mb-1 flex items-center gap-3">
          <span className="h-px flex-1 bg-(--mention)/40" />
          <span className="text-xs font-semibold text-(--mention)">{unreadCount} unread {unreadCount === 1 ? 'message' : 'messages'}</span>
          <span className="h-px flex-1 bg-(--mention)/40" />
        </div>,
      );
    }
    const own = m.userId === me.id;
    const continued = !newDay && previous !== null && !(unreadShown && m.id === unreadAnchor) && previous.msg.userId === m.userId;
    const author = m.userName ?? 'Deleted user';
    const names = m.mentions.map((id) => byId.get(id)?.name).filter((n): n is string => Boolean(n));
    const canDelete = row.status === 'sent' && !m.deleted && (own || isOwner);
    const showTools = row.status === 'sent' && !m.deleted && canPost;
    const menuOpen = openMenu === m.id;
    const reactOpen = openReact === m.id;
    const stamp = (
      <span className="inline-flex items-center gap-1 text-[11px] leading-none whitespace-nowrap text-muted select-none" title={new Date(m.createdAt).toLocaleString()}>
        {clock(m.createdAt)}
        {own && row.status !== 'sent' ? <Icon name={row.status === 'sending' ? 'clock' : 'alert'} className={cn('size-3', row.status === 'failed' && 'text-danger')} /> : null}
      </span>
    );
    // Hover toolbar at the top right of the row (Slack-style): react, reply, copy, delete.
    const toolBtn = 'grid size-7 cursor-pointer place-items-center rounded-lg border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--hover) hover:text-fg';
    const tools = showTools ? (
      <div className={cn('absolute -top-3.5 right-2 z-20 hidden items-center gap-0.5 rounded-xl border border-line bg-panel p-0.5 shadow-(--menu-shadow) group-hover/row:flex max-sm:flex', (menuOpen || reactOpen) && 'flex')}>
        {!own ? (
          <div className="relative">
            <button type="button" title="React" aria-label="React" onClick={(e) => { e.stopPropagation(); decidePlacement(e.currentTarget, POPUP_REACT_PX); setOpenMenu(null); setOpenReact(reactOpen ? null : m.id); }} className={toolBtn}>
              <Icon name="smile" className="size-4" />
            </button>
            {reactOpen ? (
              <div role="menu" aria-label="React" className={cn('absolute right-0 z-30 flex items-center gap-0.5 rounded-full border border-line bg-panel p-1 shadow-(--menu-shadow)', popUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}>
                {CHAT_REACTIONS.map((e) => (
                  <button key={e} type="button" title={e} aria-label={`React with ${e}`} onClick={(ev) => { ev.stopPropagation(); chat.react(m.id, e); setOpenReact(null); }}
                    className="grid size-7 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--hover) hover:text-fg">
                    <Icon name={REACTION_ICON_MAP[e] ?? 'smile'} className="size-4" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <button type="button" title="Reply" aria-label="Reply" onClick={(e) => { e.stopPropagation(); startReply(m); }} className={toolBtn}><Icon name="reply" className="size-4" /></button>
        <div className="relative">
          <button type="button" title="More" aria-label="More options" onClick={(e) => { e.stopPropagation(); decidePlacement(e.currentTarget, POPUP_MENU_PX); setOpenReact(null); setOpenMenu(menuOpen ? null : m.id); }} className={toolBtn}>
            <Icon name="chevron" className="size-4" />
          </button>
          {menuOpen ? (
            <div role="menu" className={cn('absolute right-0 z-30 min-w-[132px] overflow-hidden rounded-xl border border-line bg-panel py-1 text-left shadow-(--menu-shadow)', popUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}>
              {m.text ? (
                <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); setOpenMenu(null); copyText(m); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-none border-0 bg-transparent px-3 py-1.5 text-left text-[13px] text-fg shadow-none hover:bg-(--hover)"><Icon name="copy" className="size-4 text-muted" />Copy</button>
              ) : null}
              {canDelete ? (
                <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); setOpenMenu(null); removeMessage(m)(); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-none border-0 bg-transparent px-3 py-1.5 text-left text-[13px] text-danger shadow-none hover:bg-(--hover)"><Icon name="trash" className="size-4" />Delete</button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    ) : null;
    items.push(
      <div key={row.key} id={`m-${m.id}`} className={cn('group/row relative flex gap-3 rounded-xl px-2 py-1 transition-colors data-[flash]:bg-amber-400/25', continued ? 'mt-0' : 'mt-4', row.status === 'sending' && 'opacity-70')}>
        {/* Avatar on the first message of a run; later ones show their time in the same column when hovered. */}
        <div className="w-[34px] shrink-0 pt-0.5">
          {continued ? (
            <span className="hidden w-full pt-1.5 text-center text-[10px] leading-none whitespace-nowrap text-muted group-hover/row:block" title={new Date(m.createdAt).toLocaleString()}>{clock(m.createdAt)}</span>
          ) : <Avatar name={author} />}
        </div>
        <div className="min-w-0 flex-1">
          {!continued ? (
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-semibold text-fg">{author}{own ? <span className="font-normal text-muted"> (you)</span> : null}</span>
              {stamp}
            </div>
          ) : null}
          {m.replyTo ? (
            <button type="button" onClick={(e) => { e.stopPropagation(); if (m.replyTo) jumpTo(m.replyTo.id); }} title="Go to the original message"
              className="mt-1 mb-1.5 block w-full max-w-md min-w-0 cursor-pointer rounded-lg border-0 border-l-[3px] bg-(--chip) py-1.5 pr-3 pl-3 text-left shadow-none transition-colors hover:bg-(--hover)"
              style={{ borderLeftColor: nameColor(m.replyTo.userName ?? 'Deleted user') }}>
              <span className="flex items-center gap-1.5 text-[11px] leading-4 text-muted">
                <Icon name="reply" className="size-3 shrink-0" />Replying to
                <span className="truncate text-xs font-semibold" style={{ color: nameColor(m.replyTo.userName ?? 'Deleted user') }}>{m.replyTo.userName ?? 'Deleted user'}</span>
              </span>
              <span className={cn('mt-0.5 line-clamp-2 block text-[13px] leading-snug text-fg-2', m.replyTo.deleted && 'italic text-muted')}>{snippetOf(m.replyTo) || 'Message'}</span>
            </button>
          ) : null}
          {m.deleted ? (
            <p className="m-0 text-[13px] text-muted italic">This message was deleted</p>
          ) : (
            <>
              {m.text ? (
                <p className="m-0 mt-0.5 text-[14.5px] leading-[1.6] wrap-break-word whitespace-pre-wrap text-fg">
                  {withMentions(m.text, names, (part, i) => <span key={i} className="rounded bg-(--mention)/12 text-(--mention)">{part}</span>)}
                </p>
              ) : null}
              {m.issues.length > 0 ? (
                <div className="mt-1.5 grid max-w-md gap-1.5">
                  {m.issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)}
                </div>
              ) : null}
            </>
          )}

          {m.reactions.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {m.reactions.map((r) => (
                <button key={r.emoji} type="button" title={r.names.join(', ')} onClick={(e) => { e.stopPropagation(); if (canPost && !own) chat.react(m.id, r.emoji); }}
                  className={cn('inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs shadow-none', own ? 'cursor-default' : 'cursor-pointer', r.mine ? 'border-(--mention)/40 bg-(--mention)/12' : 'border-line bg-panel')}>
                  <span>{r.emoji}</span>{r.count > 1 ? <span className="font-medium tabular-nums">{r.count}</span> : null}
                </button>
              ))}
            </div>
          ) : null}

          {row.status === 'failed' && row.clientId ? (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-danger" role="status" title={row.error ?? undefined}>
              <Icon name="alert" className="size-3.5" />
              <span>Not sent</span>
              <button type="button" onClick={() => chat.retry(row.clientId as string)} className="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent p-0 font-semibold text-danger underline shadow-none"><Icon name="retry" className="size-3" />Retry</button>
              <button type="button" onClick={() => chat.discard(row.clientId as string)} className="cursor-pointer rounded-full border-0 bg-transparent p-0 text-muted underline shadow-none">Delete</button>
            </div>
          ) : null}
        </div>
        {tools}
      </div>,
    );
    previous = row;
  });

  const sendable = text.trim().length > 0 || attached.length > 0;

  return (
    <Page crumbs={crumbs} fill hideBar>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 md:px-6">
          <button type="button" onClick={openDrawer} aria-label="Open the menu" title="Menu"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-fg-2 shadow-none hover:bg-(--hover) hover:text-fg md:hidden">
            <Icon name="menu" className="size-4.5" />
          </button>
          <Avatar name={projectName} size="sm" shape="square" />
          <div className="min-w-0 flex-1">
            <h1 className="m-0 truncate text-[15px] leading-5 font-semibold text-fg"># {projectName}</h1>
            <p className="m-0 truncate text-xs leading-4 text-muted">{everyone.length > 0 ? `${everyone.length} ${everyone.length === 1 ? 'member' : 'members'}` : 'Project chat'}{chat.live ? ' · Live' : ''}</p>
          </div>
          <MembersDropdown people={everyone} ownerId={people.data?.owner?.id ?? null} meId={me.id} live={chat.live} manageHref={`/projects/${projectId}?tab=members`} />
        </header>
        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            className="h-full overflow-y-auto bg-panel"
            onScroll={(e) => {
              const el = e.currentTarget;
              const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
              atBottom.current = near;
              if (near) { setShowJump(false); setNewBelow(0); } else setShowJump(true);
            }}
            onClick={() => { setOpenMenu(null); setOpenReact(null); }}
          >
            <div ref={content} className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-3 pt-4 pb-4 md:px-6">
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
                      <div className="max-w-sm px-6 py-6">
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

          {showJump ? (
            <button type="button" onClick={jumpToLatest} aria-label="Jump to the latest message" title="Jump to the latest message"
              className="absolute right-6 bottom-4 z-10 grid size-10 cursor-pointer place-items-center rounded-full border border-line bg-panel p-0 text-fg-2 shadow-(--menu-shadow) hover:text-fg">
              <Icon name="arrowDown" className="size-5" />
              {newBelow > 0 ? <Badge className="absolute -top-1.5 -right-1.5 min-w-5 justify-center bg-(--mention) px-1 font-semibold text-white">{newBelow > 99 ? '99+' : newBelow}</Badge> : null}
            </button>
          ) : null}
        </div>

        <footer className="relative mx-auto flex w-full max-w-4xl shrink-0 flex-col items-center justify-center bg-panel px-3 pt-1 pb-3 md:px-6">
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
                            <Badge tone={EVENT_TONE[option.eventType] ?? 'neutral'}>{option.eventType}</Badge>
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
                <div className="mb-2 flex w-full items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2">
                  <Icon name="reply" className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1 text-xs leading-4">
                    <span className="text-muted">Replying to </span>
                    <span className="font-semibold" style={{ color: nameColor(replyTo.userName ?? 'Deleted user') }}>{replyTo.userId === me.id ? 'yourself' : (replyTo.userName ?? 'Deleted user')}</span>
                    <div className="truncate text-fg-2">{snippetOf(replyTo)}</div>
                  </div>
                  <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply" title="Cancel reply" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--chip) hover:text-fg"><Icon name="close" className="size-3.5" /></button>
                </div>
              ) : null}

              {attached.length > 0 ? (
                <div className="mb-2 grid w-full max-w-md gap-2 self-start">
                  {attached.map((issue) => <IssueCard key={issue.id} issue={issue} onRemove={() => setAttached((list) => list.filter((i) => i.id !== issue.id))} />)}
                </div>
              ) : null}

              <div className="w-full rounded-2xl border border-line bg-panel px-4 pt-3 pb-2.5 shadow-[0_2px_14px_rgba(0,0,0,.06)] transition-colors focus-within:border-(--fg)/35">
                <div className="relative">
                  <div ref={mirror} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden text-sm leading-6 wrap-break-word whitespace-pre-wrap text-fg">
                    {withMentions(text, pickedNames, (part, i) => <span key={i} className="rounded-sm bg-(--mention)/15 text-(--mention)">{part}</span>)}
                    {'​'}
                  </div>
                  <textarea
                    ref={box}
                    rows={1}
                    value={text}
                    maxLength={4000}
                    placeholder="Write a message…"
                    aria-label={`Message ${projectName}`}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={onKeyDown}
                    onScroll={(e) => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; }}
                    className="relative block w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 wrap-break-word whitespace-pre-wrap text-transparent caret-(--fg) outline-none placeholder:text-muted"
                    style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
                  />
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <button type="button" title="Mention someone" aria-label="Mention someone" onClick={() => insertAtCaret('@', 'mention')}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-transparent px-3 text-xs font-medium text-fg-2 shadow-none hover:bg-(--hover) hover:text-fg">
                    <span className="text-sm leading-none">@</span>Mention
                  </button>
                  <button type="button" title="Attach an issue" aria-label="Attach an issue" disabled={attached.length >= MAX_ISSUES} onClick={() => insertAtCaret('/', 'issue')}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-transparent px-3 text-xs font-medium text-fg-2 shadow-none hover:bg-(--hover) hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
                    <span className="text-sm leading-none">/</span>Add issue
                  </button>
                  <button type="button" title="Emoji" aria-label="Emoji" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen((o) => !o); setPicker(null); }}
                    className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--hover) hover:text-fg"><Icon name="smile" className="size-4" /></button>
                  <button type="button" onClick={submit} disabled={!sendable} aria-label="Send message" title="Send (Enter)"
                    className="ml-auto grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-invert-bg p-0 text-invert-fg shadow-none transition-opacity disabled:cursor-not-allowed disabled:opacity-30">
                    <Icon name="send" className="size-4" />
                  </button>
                </div>
              </div>
              <p className="m-0 mt-1.5 text-center text-[11px] text-muted max-sm:hidden"><kbd className="font-sans font-medium">Enter</kbd> to send · <kbd className="font-sans font-medium">Shift + Enter</kbd> for a new line</p>
            </>
          ) : (
            <p className="m-0 py-1.5 text-center text-[13px] text-muted">You can read this chat but you don&apos;t have permission to write in it. Ask the project owner.</p>
          )}
        </footer>
      </div>
    </Page>
  );
}
