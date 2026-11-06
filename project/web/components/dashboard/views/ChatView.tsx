'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useApi } from '@/lib/client/api';
import { useChat, type Draft } from '@/lib/client/chat';
import { dayKey, startsGroup } from '@/lib/chatText';
import type { ChatIssueView, ChatMessageView, MembersResponse, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useDialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { useToast } from '../../ui/Toasts';
import '../chat/chat.css';
import { ChannelHeader } from '../chat/ChannelHeader';
import type { ComposerHandle } from '../chat/Composer';
import { MessageRow, type Row, type RowActions } from '../chat/MessageRow';
import { ChatAvatar, dayLabel, scrollBehavior, SendIcon } from '../chat/shared';
import { Wallpaper, type WallpaperHandle } from '../chat/Wallpaper';
import { Page } from '../Page';
import { useSession } from '../Shell';

/** Pixels from the bottom within which the list counts as "at the bottom" (and follows new messages). */
const STICK_PX = 120;
/** How far above the top older messages start loading (px), so scrolling up rarely waits. */
const LOAD_OLDER_MARGIN_PX = 600;
/** How long a message stays highlighted after jumping to it. */
const FLASH_MS = 1600;
/** Placeholder bubbles while the first page loads. */
const SKELETON_ROWS = 7;
/** After scrolling stops, the date stuck to the top fades away after this long. */
const SCROLL_IDLE_MS = 900;
/** Where a stuck date pill sits (matches `top-2` on `.tg-day`). */
const STUCK_TOP_PX = 8;
/** Size of the avatar next to a group of others' messages. */
const GROUP_AVATAR_PX = 34;
/** The conversation column (messages and the message box) is at most this wide. */
const COLUMN = 'mx-auto w-full max-w-[1400px]';

/** Looks like the closed message box, shown while the editor's code loads (so nothing jumps). */
function ComposerPlaceholder() {
  return (
    <div className={cn(COLUMN, 'flex items-end gap-2 px-2 pt-1 pb-[max(10px,env(safe-area-inset-bottom))] md:px-4')} aria-hidden="true">
      <div className="tg-input has-tail flex h-[54px] flex-1 items-center pl-14 text-[16px] text-(--tg-in-meta)">Message</div>
      <span className="tg-fab tg-send ml-1.5"><SendIcon className="size-5" /></span>
    </div>
  );
}

/** The message box is a rich editor (Tiptap): loaded only on this page, in the browser. */
const Composer = dynamic(() => import('../chat/Composer').then((m) => m.Composer), { ssr: false, loading: ComposerPlaceholder });

/** The project chat: the active project's single channel (docs/MEMBERS_AND_CHAT.md). */
export function ChatView() {
  const { user, projects, projectId, setProjectId } = useSession();
  const project = projects && projectId ? projects.find((p) => p.id === projectId) : undefined;
  const crumbs = [{ label: 'Chats' }, ...(project ? [{ label: `# ${project.name}` }] : [])];
  const me = useMemo(() => ({ id: user.id, name: user.name }), [user.id, user.name]);

  // A copied message link (/chats?project=<id>#m-<message>) opens that project's chat.
  useEffect(() => {
    if (!projects) return;
    const wanted = new URLSearchParams(window.location.search).get('project');
    if (wanted && wanted !== projectId && projects.some((p) => p.id === wanted)) setProjectId(wanted);
  }, [projects, projectId, setProjectId]);

  if (!projects) {
    return (
      <Page crumbs={crumbs} fill hideBar>
        <div className="tg flex flex-1 flex-col overflow-hidden">
          <Wallpaper />
          <HeaderSkeleton />
          <div className="relative flex-1 overflow-hidden"><Skeleton /></div>
          <div className="relative"><ComposerPlaceholder /></div>
        </div>
      </Page>
    );
  }
  if (!project) {
    return (
      <Page crumbs={crumbs} fill>
        <div className="tg grid flex-1 place-items-center overflow-hidden px-6 text-center">
          <Wallpaper />
          <div className="tg-pill relative max-w-sm rounded-2xl px-6 py-5">
            <Icon name="chat" className="mx-auto mb-2 size-8 opacity-90" />
            <h2 className="m-0 mb-1 text-base font-medium">No conversations yet</h2>
            <p className="m-0 text-[13px] leading-5 font-normal opacity-90">Every project has a chat for the people who can access it. Create a project, then add your teammates.</p>
          </div>
        </div>
      </Page>
    );
  }
  return (
    <Page crumbs={crumbs} fill hideBar>
      <Channel key={project.id} projectId={project.id} projectName={project.name} canPost={project.permissions.includes('chat.post')} isOwner={project.role === 'owner'} me={me} />
    </Page>
  );
}

/** A pulsing grey bar standing in for a line of text, in the current text colour. */
const BAR = 'h-3 animate-pulse rounded-full bg-(--tg-text)/10 motion-reduce:animate-none';

/** Looks like the channel header (avatar, name, subtitle) while projects load. */
function HeaderSkeleton() {
  return (
    <div className="relative z-10 flex h-14 shrink-0 items-center gap-2.5 border-b border-(--tg-bar-line) bg-(--tg-head) px-3 md:px-4" aria-hidden="true">
      <span className="size-10 animate-pulse rounded-full bg-(--tg-text)/10 motion-reduce:animate-none" />
      <div className="flex flex-col gap-1.5"><span className={cn(BAR, 'w-32')} /><span className={cn(BAR, 'h-2.5 w-20')} /></div>
    </div>
  );
}

/** Message-shaped placeholders (others on the left with an avatar, you on the right) while the first page loads. */
const SKELETON_MESSAGES: ReadonlyArray<{ own: boolean; name?: boolean; lines: readonly number[] }> = [
  { own: false, name: true, lines: [88, 62] },
  { own: false, lines: [46] },
  { own: true, lines: [70] },
  { own: false, name: true, lines: [92, 100, 38] },
  { own: true, lines: [58, 34] },
  { own: false, name: true, lines: [54] },
  { own: true, lines: [42] },
];

function Skeleton() {
  return (
    <div className={cn(COLUMN, 'flex flex-col gap-1.5 px-3 pt-6 md:px-5')} aria-hidden="true">
      {SKELETON_MESSAGES.slice(0, SKELETON_ROWS).map((m, i) => (
        <div key={i} className={cn('flex items-end gap-2', m.own ? 'justify-end' : 'justify-start')}>
          {!m.own && <span className="animate-pulse rounded-full bg-(--tg-text)/10 motion-reduce:animate-none" style={{ width: GROUP_AVATAR_PX, height: GROUP_AVATAR_PX }} />}
          <div className={cn('flex w-[min(320px,72%)] flex-col gap-2 rounded-[15px] px-3 py-2.5', m.own ? 'bg-(--tg-own)' : 'bg-(--tg-in)')}>
            {m.name && <span className={cn(BAR, 'h-2.5 w-20')} />}
            {m.lines.map((w, j) => <span key={j} className={BAR} style={{ width: `${w}%` }} />)}
          </div>
        </div>
      ))}
      <span className="sr-only" role="status">Loading messages…</span>
    </div>
  );
}

function toRow(p: { clientId: string; draft: Draft; status: 'sending' | 'failed'; error: string | null; createdAt: string }, me: { id: string; name: string }, projectId: string): Row {
  const r = p.draft.replyTo;
  return {
    key: p.clientId,
    clientId: p.clientId,
    status: p.status,
    error: p.error,
    msg: {
      id: p.clientId, projectId, userId: me.id, userName: me.name, text: p.draft.text, mentions: p.draft.mentions, issues: p.draft.issues,
      replyTo: r ? { id: r.id, userId: r.userId, userName: r.userName, text: r.text.slice(0, 140), deleted: false, hasIssues: r.issues.length > 0 } : null,
      reactions: [], createdAt: p.createdAt, editedAt: null, deleted: false,
    },
  };
}

/** Whether the browser says it is online (updates live). */
function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}

function Channel({ projectId, projectName, canPost, isOwner, me }: {
  projectId: string; projectName: string; canPost: boolean; isOwner: boolean; me: { id: string; name: string };
}) {
  const { openDrawer } = useSession();
  const chat = useChat(projectId, me);
  const people = useApi<MembersResponse>(`/api/projects/members?projectId=${projectId}`);
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const online = useOnline();
  const composer = useRef<ComposerHandle>(null);
  const wallpaper = useRef<WallpaperHandle>(null);
  const [replyTo, setReplyTo] = useState<ChatMessageView | null>(null);
  /** The message open in the message box for editing (one at a time). */
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => { setEditingId(null); }, [projectId]);

  const everyone = useMemo<PersonView[]>(() => (people.data ? [...(people.data.owner ? [people.data.owner] : []), ...people.data.members] : []), [people.data]);
  const byId = useMemo(() => new Map(everyone.map((p) => [p.id, p])), [everyone]);

  const rows = useMemo<Row[]>(
    () => [...chat.messages.map((m): Row => ({ key: m.id, msg: m, status: 'sent' })), ...chat.pending.map((p) => toRow(p, me, projectId))],
    [chat.messages, chat.pending, me, projectId],
  );

  // ---- which rows slide in: only ones added at the end after the chat opened (others' new messages, and
  // yours while they are being sent; your confirmed copy replaces the pending one without animating again)
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  useMemo(() => {
    if (chat.loading) return;
    const known = seen.current;
    if (!known) { seen.current = new Set(rows.map((r) => r.key)); return; }
    let lastKnown = -1;
    rows.forEach((r, i) => { if (known.has(r.key)) lastKnown = i; });
    rows.forEach((r, i) => {
      if (known.has(r.key)) return;
      if (i > lastKnown && (r.status !== 'sent' || r.msg.userId !== me.id)) fresh.current.add(r.key);
      known.add(r.key);
    });
  }, [rows, chat.loading, me.id]);

  // ---- scrolling: follow new messages while at the bottom; otherwise count them on the "jump to latest" button
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevKeys = useRef<string[]>([]);
  const restore = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  const idleTimer = useRef(0);
  const [placed, setPlaced] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [newBelow, setNewBelow] = useState(0);

  // The first unread message of this visit (by someone else, after the time we last read), fixed once the first page is in.
  const anchorRef = useRef<string | null | undefined>(undefined);
  if (!chat.loading && anchorRef.current === undefined) {
    const since = chat.lastReadAt ? new Date(chat.lastReadAt).getTime() : null;
    anchorRef.current = since === null ? null : (chat.messages.find((m) => m.userId !== me.id && new Date(m.createdAt).getTime() > since)?.id ?? null);
  }
  const unreadAnchor = anchorRef.current ?? null;

  const flash = useCallback((el: HTMLElement) => {
    el.dataset.flash = '1';
    setTimeout(() => { delete el.dataset.flash; }, FLASH_MS);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const keys = rows.map((r) => r.key);
    const prev = prevKeys.current;
    prevKeys.current = keys;
    if (rows.length === 0) return;
    if (!placed) {
      // First paint: a linked message, else the first unread one, else the newest.
      const hash = window.location.hash.startsWith('#m-') ? document.getElementById(window.location.hash.slice(1)) : null;
      const target = hash ?? (unreadAnchor ? document.getElementById('tg-unread') : null);
      if (target) {
        const offset = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        el.scrollTop = Math.max(0, offset - (hash ? el.clientHeight / 3 : 48));
        if (hash) flash(hash);
      } else {
        el.scrollTop = el.scrollHeight;
      }
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      setShowJump(!atBottom.current);
      setPlaced(true);
      return;
    }
    // Older messages were added on top: keep what the person was reading where it was.
    if (restore.current !== null && prev.length > 0 && keys[0] !== prev[0]) {
      el.scrollTop = el.scrollHeight - restore.current;
      restore.current = null;
      return;
    }
    if (atBottom.current) { el.scrollTo({ top: el.scrollHeight, behavior: prev.length > 0 ? scrollBehavior() : 'auto' }); return; }
    const lastIndex = prev.length > 0 ? keys.lastIndexOf(prev[prev.length - 1]) : -1;
    const fromOthers = lastIndex === -1 ? 0 : rows.slice(lastIndex + 1).filter((r) => r.msg.userId !== me.id).length;
    if (fromOthers > 0) { setNewBelow((n) => n + fromOthers); setShowJump(true); }
  }, [rows, placed, unreadAnchor, me.id, flash]);

  // The list also grows without new rows (an issue card, a reaction): while at the bottom, stay there.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [chat.loading]);

  // Older messages load by themselves when the top comes near (no "Load older" button to hunt for).
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadOlder } = chat;
  const loadOlderKeepingPlace = useCallback(async () => {
    const el = scroller.current;
    if (!el || loadingOlder.current) return;
    loadingOlder.current = true;
    restore.current = el.scrollHeight - el.scrollTop;
    try { await loadOlder(); } catch { restore.current = null; toast('Couldn’t load older messages', 'error'); } finally { loadingOlder.current = false; }
  }, [loadOlder, toast]);
  useEffect(() => {
    const el = scroller.current;
    const top = sentinel.current;
    if (!placed || !hasMore || !el || !top || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) void loadOlderKeepingPlace(); }, { root: el, rootMargin: `${LOAD_OLDER_MARGIN_PX}px 0px 0px 0px` });
    observer.observe(top);
    return () => observer.disconnect();
  }, [placed, hasMore, loadOlderKeepingPlace, rows.length]);
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const jumpToLatest = () => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: scrollBehavior() });
    setNewBelow(0);
  };

  // While scrolling, every date shows; once it stops, the one stuck to the top fades away.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    atBottom.current = near;
    setShowJump(!near);
    if (near) setNewBelow(0);
    el.classList.add('is-scrolling');
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      el.classList.remove('is-scrolling');
      const top = el.getBoundingClientRect().top;
      el.querySelectorAll<HTMLElement>('.tg-day').forEach((day) => {
        const section = day.parentElement;
        day.classList.toggle('is-stuck', Boolean(section && section.getBoundingClientRect().top < top && day.getBoundingClientRect().top - top <= STUCK_TOP_PX + 1));
      });
    }, SCROLL_IDLE_MS);
  };

  // ---- row actions: one stable object, reading the latest state through a ref, so memoised rows don't re-render
  const latest = useRef({ chat, openDialog, toast, action, projectId });
  latest.current = { chat, openDialog, toast, action, projectId };
  const actions = useMemo<RowActions>(() => ({
    reply: (m) => { setEditingId(null); setReplyTo(m); composer.current?.focus(); },
    react: (id, emoji) => latest.current.chat.react(id, emoji),
    edit: (m) => { setReplyTo(null); setEditingId(m.id); composer.current?.focus(); },
    remove: (m) => {
      const { action: run, openDialog: open, chat: c, toast: say } = latest.current;
      run(async () => {
        const ok = await open({ title: 'Delete this message?', message: 'It will be removed for everyone in this project. This can’t be undone.', confirmText: 'Delete', danger: true, onConfirm: () => c.remove(m.id) });
        if (ok) say('Message deleted');
      })();
    },
    copyText: (m) => { navigator.clipboard.writeText(m.text).then(() => latest.current.toast('Copied to clipboard'), () => latest.current.toast('Couldn’t copy', 'error')); },
    copyLink: (m) => {
      const url = `${window.location.origin}/chats?project=${latest.current.projectId}#m-${m.id}`;
      navigator.clipboard.writeText(url).then(() => latest.current.toast('Link copied'), () => latest.current.toast('Couldn’t copy', 'error'));
    },
    jumpTo: (id) => {
      const el = document.getElementById(`m-${id}`);
      if (!el) { latest.current.toast('That message is older than what’s loaded. Scroll up to load more.'); return; }
      el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      el.focus({ preventScroll: true });
      el.dataset.flash = '1';
      setTimeout(() => { delete el.dataset.flash; }, FLASH_MS);
    },
    retry: (clientId) => latest.current.chat.retry(clientId),
    discard: (clientId) => latest.current.chat.discard(clientId),
  }), []);

  /** The message being edited, while it is still there (deleted meanwhile = the edit ends). */
  const editingMessage = useMemo(() => (editingId ? chat.messages.find((m) => m.id === editingId && !m.deleted) ?? null : null), [editingId, chat.messages]);
  const saveEdit = useCallback(async (text: string, issues: ChatIssueView[]) => {
    if (!editingId) return;
    const saved = editingId;
    try {
      await chat.edit(saved, text, issues);
      // Only end the edit if it is still this message (another one may have been opened while saving).
      setEditingId((current) => (current === saved ? null : current));
    } catch (e) {
      toast(e instanceof Error && e.message ? `Couldn’t save: ${e.message}` : 'Couldn’t save the change', 'error');
      throw e;
    }
  }, [chat, editingId, toast]);

  const send = useCallback((draft: Draft) => {
    atBottom.current = true;
    setReplyTo(null);
    wallpaper.current?.shift();
    chat.send(draft);
  }, [chat]);

  // Arrow keys move between messages; Escape goes back to the message box.
  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target !== e.currentTarget && !target.hasAttribute('data-row')) return;
    if (e.key === 'Escape') { composer.current?.focus(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
    if (list.length === 0) return;
    e.preventDefault();
    const at = list.indexOf(target);
    const next = at === -1 ? list.length - 1 : Math.min(list.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    list[next].focus();
    list[next].scrollIntoView({ block: 'nearest' });
  }

  // ---- render: days → groups (one person in a row) → bubbles. A day's date sticks to the top while you scroll through it.
  type Group = { key: string; own: boolean; userId: string; name: string; items: ReactNode[] };
  type Day = { key: string; label: string; parts: ReactNode[]; group: Group | null };
  const days: ReactNode[] = [];
  let day: Day | null = null;
  const unreadCount = unreadAnchor ? chat.messages.filter((m) => m.userId !== me.id && m.id >= unreadAnchor).length : 0;

  const closeGroup = () => {
    const g = day?.group;
    if (!day || !g) return;
    day.parts.push(g.own ? (
      <div key={g.key} className="flex flex-col">{g.items}</div>
    ) : (
      <div key={g.key} className="flex">
        <div className="flex w-[42px] shrink-0 flex-col justify-end pb-1.5 pl-0.5">
          <span className="sticky bottom-1.5"><ChatAvatar id={g.userId} name={g.name} size={GROUP_AVATAR_PX} /></span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">{g.items}</div>
      </div>
    ));
    day.group = null;
  };
  const closeDay = () => {
    if (!day) return;
    closeGroup();
    days.push(
      <section key={day.key} aria-label={day.label} className="relative">
        <div className="tg-day pointer-events-none sticky top-2 z-10 my-2 flex justify-center"><span className="tg-pill">{day.label}</span></div>
        {day.parts}
      </section>,
    );
  };

  rows.forEach((row, i) => {
    const m = row.msg;
    const dk = dayKey(m.createdAt);
    if (!day || day.key !== dk) { closeDay(); day = { key: dk, label: dayLabel(m.createdAt), parts: [], group: null }; }
    const d: Day = day;
    const isUnreadStart = unreadAnchor !== null && m.id === unreadAnchor;
    const first = isUnreadStart || startsGroup(i > 0 ? rows[i - 1].msg : null, m);
    const next = rows[i + 1]?.msg;
    const last = !next || (unreadAnchor !== null && next.id === unreadAnchor) || startsGroup(m, next);
    if (first) {
      closeGroup();
      if (isUnreadStart) {
        d.parts.push(<div key="unread" id="tg-unread" className="tg-unread" role="separator" aria-label={`${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`}>Unread messages</div>);
      }
      d.group = { key: row.key, own: m.userId === me.id, userId: m.userId, name: m.userName ?? 'Deleted user', items: [] };
    }
    const own = m.userId === me.id;
    d.group?.items.push(
      <MessageRow key={row.key} row={row} first={first} last={last} animate={fresh.current.has(row.key)} me={me} people={byId} canPost={canPost}
        canDelete={row.status === 'sent' && !m.deleted && (own || isOwner)} editing={editingId === row.key} actions={actions} />,
    );
  });
  closeDay();

  return (
    <div className="tg flex min-h-0 flex-1 flex-col overflow-hidden">
      <ChannelHeader projectId={projectId} projectName={projectName} people={everyone} ownerId={people.data?.owner?.id ?? null} meId={me.id} manageHref={`/projects/${projectId}?tab=members`}
        onOpenDrawer={openDrawer} messages={chat.messages} hasMore={chat.hasMore} onLoadOlder={loadOlderKeepingPlace} onJump={actions.jumpTo} />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <Wallpaper ref={wallpaper} />

        {!online ? (
          <div className="relative z-20 flex shrink-0 justify-center pt-2" role="status">
            <span className="tg-pill inline-flex items-center gap-2 text-[13px]"><Icon name="wifiOff" className="size-3.5" />Waiting for network…</span>
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            role="log"
            aria-label={`Messages in ${projectName}`}
            aria-live={placed ? 'polite' : 'off'}
            aria-relevant="additions"
            tabIndex={0}
            onKeyDown={onListKeyDown}
            onScroll={onScroll}
            className="tg-scroll h-full overflow-x-hidden overflow-y-auto overscroll-contain outline-none [scrollbar-width:thin]"
          >
            {/* Clips the full-width row highlight and unread bar sideways (overflow-x: clip makes no scroll box). */}
            <div className="flex min-h-full w-full flex-col overflow-x-clip">
            <div ref={content} className={cn(COLUMN, 'flex min-w-0 flex-1 flex-col px-1 pb-2 md:px-3')}>
              {chat.error ? (
                <div className="grid flex-1 place-items-center px-6 py-10 text-center" role="alert">
                  <div className="tg-pill max-w-sm rounded-2xl px-6 py-5">
                    <Icon name="alert" className="mx-auto mb-2 size-7" />
                    <h2 className="m-0 mb-1 text-[15px] font-medium">Couldn’t load this conversation</h2>
                    <p className="m-0 mb-3 text-[13px] font-normal opacity-90">{online ? 'Something went wrong on our side or the connection dropped.' : 'You’re offline.'}</p>
                    <button type="button" onClick={chat.reload} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 bg-white/20 px-4 py-1.5 text-[13px] font-medium text-inherit shadow-none hover:bg-white/30">
                      <Icon name="retry" className="size-3.5" />Try again
                    </button>
                  </div>
                </div>
              ) : chat.loading ? <Skeleton /> : rows.length === 0 ? (
                <div className="grid flex-1 place-items-center px-6 py-10 text-center">
                  <div className="tg-pill max-w-xs rounded-2xl px-6 py-5 tg-fade-in">
                    <div className="mb-1 text-[15px] font-medium">No messages here yet…</div>
                    <p className="m-0 text-[13px] leading-5 font-normal opacity-90">
                      Everyone with access to {projectName} can read this chat.{canPost ? ' Mention a teammate with @ or share an issue with /.' : ''}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-auto pt-2">
                  <div ref={sentinel} aria-hidden="true" />
                  {chat.hasMore ? (
                    <div className="flex justify-center py-3" role="status"><span className="tg-pill inline-flex items-center gap-2 text-[13px]"><span className="spinner" />Loading older messages…</span></div>
                  ) : (
                    <div className="flex justify-center py-3"><span className="tg-pill text-[13px]">This is the very beginning of {projectName}</span></div>
                  )}
                  {days}
                </div>
              )}
            </div>
            </div>
          </div>

          {/* Round "jump to latest" button with the count of new messages. */}
          <div className={cn(COLUMN, 'pointer-events-none absolute inset-x-0 bottom-3 flex justify-end px-3 md:px-5')}>
            <button type="button" onClick={jumpToLatest} tabIndex={showJump && rows.length > 0 ? 0 : -1} aria-hidden={!(showJump && rows.length > 0)}
              aria-label={newBelow > 0 ? `${newBelow} new ${newBelow === 1 ? 'message' : 'messages'}, jump to latest` : 'Jump to the latest message'}
              className={cn('tg-fab relative size-10', showJump && rows.length > 0 ? 'pointer-events-auto' : 'translate-y-4 scale-75 opacity-0')}>
              <Icon name="arrowDown" className="size-5" />
              {newBelow > 0 ? <span className="tg-fab-badge">{newBelow > 99 ? '99+' : newBelow}</span> : null}
            </button>
          </div>
        </div>

        <footer className="relative shrink-0">
          {canPost ? (
            <Composer handle={composer} key={projectId} projectId={projectId} projectName={projectName} people={everyone} me={me}
              replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSend={send} offline={!online}
              editing={editingMessage} onCancelEdit={() => setEditingId(null)} onSaveEdit={saveEdit} />
          ) : (
            <div className={cn(COLUMN, 'px-2 pt-1 pb-[max(10px,env(safe-area-inset-bottom))] md:px-4')}>
              <p className="tg-input m-0 flex items-center justify-center gap-2 px-4 py-3.5 text-[14px] text-(--tg-in-meta)">
                <Icon name="eye" className="size-4" />You can read this chat, but you don’t have permission to post.
              </p>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
