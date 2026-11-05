'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useApi } from '@/lib/client/api';
import { useChat, type Draft } from '@/lib/client/chat';
import { dayKey, startsGroup } from '@/lib/chatText';
import type { ChatMessageView, MembersResponse, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useDialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { pillButton } from '../../ui/kit';
import { useToast } from '../../ui/Toasts';
import { ChannelHeader } from '../chat/ChannelHeader';
import type { ComposerHandle } from '../chat/Composer';
import { MessageRow, type Row, type RowActions } from '../chat/MessageRow';
import { dayLabel, scrollBehavior } from '../chat/shared';
import { Page } from '../Page';
import { useSession } from '../Shell';

/** Pixels from the bottom within which the list counts as "at the bottom" (and follows new messages). */
const STICK_PX = 120;
/** How far above the top older messages start loading (px), so scrolling up rarely waits. */
const LOAD_OLDER_MARGIN_PX = 600;
/** How long a message stays highlighted after jumping to it. */
const FLASH_MS = 1600;
/** Placeholder rows while the first page loads. */
const SKELETON_ROWS = 6;

/** Looks like the closed message box, shown while the editor's code loads (so nothing jumps). */
function ComposerPlaceholder() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6" aria-hidden="true">
      <div className="flex h-[42px] items-center rounded-xl border border-line-strong bg-panel px-3 text-[14px] text-muted">Type a message</div>
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

  if (!projects) return <Page crumbs={crumbs} fill hideBar><div className="flex-1 bg-(--content)"><Skeleton /></div></Page>;
  if (!project) {
    return (
      <Page crumbs={crumbs} fill>
        <div className="grid flex-1 place-items-center bg-(--content) px-6 text-center">
          <div className="max-w-sm">
            <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-(--chip) text-muted"><Icon name="chat" className="size-6" /></div>
            <h2 className="m-0 mb-1 text-base font-semibold text-fg">No conversations yet</h2>
            <p className="m-0 text-[13px] text-muted">Every project has a chat for the people who can access it. Create a project, then add your teammates.</p>
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

/** Grey placeholder rows, shaped like messages. */
function Skeleton() {
  return (
    <div className="flex flex-col gap-5 px-4 pt-6 md:px-6" aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex gap-3 animate-pulse motion-reduce:animate-none">
          <div className="size-9 shrink-0 rounded-full bg-(--chip)" />
          <div className="flex-1 space-y-2 pt-0.5">
            <div className="h-3 w-32 rounded bg-(--chip)" />
            <div className="h-3 rounded bg-(--chip)" style={{ width: `${45 + ((i * 37) % 45)}%` }} />
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
      replyTo: r ? { id: r.id, userName: r.userName, text: r.text.slice(0, 140), deleted: false, hasIssues: r.issues.length > 0 } : null,
      reactions: [], createdAt: p.createdAt, deleted: false,
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
  const [replyTo, setReplyTo] = useState<ChatMessageView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const everyone = useMemo<PersonView[]>(() => (people.data ? [...(people.data.owner ? [people.data.owner] : []), ...people.data.members] : []), [people.data]);
  const byId = useMemo(() => new Map(everyone.map((p) => [p.id, p])), [everyone]);

  const rows = useMemo<Row[]>(
    () => [...chat.messages.map((m): Row => ({ key: m.id, msg: m, status: 'sent' })), ...chat.pending.map((p) => toRow(p, me, projectId))],
    [chat.messages, chat.pending, me, projectId],
  );

  // ---- scrolling: follow new messages while at the bottom; otherwise count them on the "jump to latest" button
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevKeys = useRef<string[]>([]);
  const restore = useRef<number | null>(null);
  const loadingOlder = useRef(false);
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
      const target = hash ?? (unreadAnchor ? document.getElementById(`m-${unreadAnchor}`) : null);
      if (target) {
        el.scrollTop = Math.max(0, target.offsetTop - (hash ? el.clientHeight / 3 : 64));
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
    if (atBottom.current) { el.scrollTop = el.scrollHeight; return; }
    const lastIndex = prev.length > 0 ? keys.lastIndexOf(prev[prev.length - 1]) : -1;
    const fromOthers = lastIndex === -1 ? 0 : rows.slice(lastIndex + 1).filter((r) => r.msg.userId !== me.id).length;
    if (fromOthers > 0) { setNewBelow((n) => n + fromOthers); setShowJump(true); }
  }, [rows, placed, unreadAnchor, me.id, flash]);

  // The list also grows without new rows (a "Not sent" line, an issue card): while at the bottom, stay there.
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

  const jumpToLatest = () => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: scrollBehavior() });
    setNewBelow(0);
  };

  // ---- row actions: one stable object, reading the latest state through a ref, so memoised rows don't re-render
  const latest = useRef({ chat, openDialog, toast, action, projectId });
  latest.current = { chat, openDialog, toast, action, projectId };
  const actions = useMemo<RowActions>(() => ({
    reply: (m) => { setReplyTo(m); setSelected(null); composer.current?.focus(); },
    react: (id, emoji) => latest.current.chat.react(id, emoji),
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
    select: (key) => setSelected(key),
    roomBelow: (el) => (scroller.current?.getBoundingClientRect().bottom ?? window.innerHeight) - el.getBoundingClientRect().bottom,
  }), []);

  const send = useCallback((draft: Draft) => {
    atBottom.current = true;
    setReplyTo(null);
    chat.send(draft);
  }, [chat]);

  // Arrow keys move between messages (each one then shows its toolbar); Escape goes back to the message box.
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

  // ---- render: one section per day (its date sticks to the top while you scroll through it)
  const sections: ReactNode[] = [];
  let current: { key: string; label: string; items: ReactNode[] } | null = null;
  const unreadCount = unreadAnchor ? chat.messages.filter((m) => m.userId !== me.id && m.id >= unreadAnchor).length : 0;
  const flush = () => {
    if (!current) return;
    sections.push(
      <section key={current.key} aria-label={current.label}>
        <div className="pointer-events-none sticky top-2 z-10 my-3 flex justify-center">
          <span className="rounded-full border border-line bg-panel px-3 py-0.5 text-xs font-semibold text-fg-2 shadow-(--shadow-sm)">{current.label}</span>
        </div>
        {current.items}
      </section>,
    );
  };
  rows.forEach((row, i) => {
    const m = row.msg;
    const day = dayKey(m.createdAt);
    if (!current || current.key !== day) { flush(); current = { key: day, label: dayLabel(m.createdAt), items: [] }; }
    const isUnreadStart = unreadAnchor !== null && m.id === unreadAnchor;
    if (isUnreadStart) {
      current.items.push(
        <div key="unread" className="my-2 flex items-center gap-2 px-4 md:px-6" role="separator" aria-label={`${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`}>
          <span className="h-px flex-1 bg-(--unread)" />
          <span className="text-[11px] font-bold tracking-wide text-(--unread) uppercase">New</span>
        </div>,
      );
    }
    const prev = i > 0 ? rows[i - 1].msg : null;
    const own = m.userId === me.id;
    current.items.push(
      <MessageRow key={row.key} row={row} groupStart={isUnreadStart || startsGroup(prev, m)} me={me} people={byId} canPost={canPost}
        canDelete={row.status === 'sent' && !m.deleted && (own || isOwner)} selected={selected === row.key} actions={actions} />,
    );
  });
  flush();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-(--content)">
      <ChannelHeader projectName={projectName} people={everyone} ownerId={people.data?.owner?.id ?? null} meId={me.id} manageHref={`/projects/${projectId}?tab=members`}
        onOpenDrawer={openDrawer} messages={chat.messages} hasMore={chat.hasMore} onLoadOlder={loadOlderKeepingPlace} onJump={actions.jumpTo} />

      {!online ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-line bg-(--amber-soft) px-4 py-1.5 text-xs font-medium text-(--amber)" role="status">
          <Icon name="wifiOff" className="size-3.5" />You’re offline. New messages will appear when you reconnect.
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          role="log"
          aria-label={`Messages in #${projectName}`}
          aria-live={placed ? 'polite' : 'off'}
          aria-relevant="additions"
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="h-full overflow-y-auto overscroll-contain outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--mention)]"
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
            atBottom.current = near;
            setShowJump(!near);
            if (near) setNewBelow(0);
          }}
        >
          <div ref={content} className="mx-auto flex min-h-full w-full max-w-5xl flex-col pb-3">
            {chat.error ? (
              <div className="grid flex-1 place-items-center px-6 py-10 text-center" role="alert">
                <div>
                  <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-(--red-soft) text-danger"><Icon name="alert" className="size-5" /></div>
                  <h2 className="m-0 mb-1 text-[15px] font-semibold text-fg">Couldn’t load this conversation</h2>
                  <p className="m-0 mb-4 text-[13px] text-muted">{online ? 'Something went wrong on our side or the connection dropped.' : 'You’re offline.'}</p>
                  <button type="button" className={pillButton('secondary')} onClick={chat.reload}><Icon name="retry" className="size-3.5" />Try again</button>
                </div>
              </div>
            ) : chat.loading ? <Skeleton /> : rows.length === 0 ? (
              <div className="grid flex-1 place-items-center px-6 py-10 text-center">
                <div className="max-w-sm">
                  <div className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-(--chip) text-fg-2"><Icon name="hash" className="size-6" /></div>
                  <h2 className="m-0 mb-1 text-base font-semibold text-fg">This is the start of #{projectName}</h2>
                  <p className="m-0 text-[13px] leading-5 text-muted">
                    Everyone with access to this project can read it.{canPost ? <> Mention a teammate with <kbd className="rounded border border-line px-1 font-mono">@</kbd> or share an issue with <kbd className="rounded border border-line px-1 font-mono">/</kbd>.</> : null}
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-auto">
                <div ref={sentinel} aria-hidden="true" />
                {chat.hasMore ? (
                  <div className="flex justify-center py-3 text-xs text-muted" role="status"><span className="spinner mr-2" />Loading older messages…</div>
                ) : (
                  <div className="px-4 pt-8 pb-2 md:px-6">
                    <div className="mb-2 grid size-12 place-items-center rounded-xl bg-(--chip) text-fg-2" aria-hidden="true"><Icon name="hash" className="size-5" /></div>
                    <h2 className="m-0 text-lg font-semibold text-fg">#{projectName}</h2>
                    <p className="m-0 mt-0.5 text-[13px] text-muted">This is the very beginning of the conversation.</p>
                  </div>
                )}
                {sections}
              </div>
            )}
          </div>
        </div>

        {showJump && rows.length > 0 ? (
          <button type="button" onClick={jumpToLatest} aria-label={newBelow > 0 ? `${newBelow} new ${newBelow === 1 ? 'message' : 'messages'}, jump to latest` : 'Jump to the latest message'}
            className={cn(
              'absolute bottom-3 left-1/2 z-20 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold shadow-(--menu-shadow) transition-colors',
              newBelow > 0 ? 'border-transparent bg-invert-bg text-invert-fg hover:opacity-90' : 'border-line bg-panel text-fg-2 hover:text-fg',
            )}>
            <Icon name="arrowDown" className="size-3.5" />
            {newBelow > 0 ? `${newBelow > 99 ? '99+' : newBelow} new ${newBelow === 1 ? 'message' : 'messages'}` : 'Jump to latest'}
          </button>
        ) : null}
      </div>

      <footer className="shrink-0 bg-(--content)">
        {canPost ? (
          <Composer handle={composer} key={projectId} projectId={projectId} projectName={projectName} people={everyone} me={me}
            replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSend={send} offline={!online} />
        ) : (
          <div className="mx-auto w-full max-w-5xl px-4 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6">
            <p className="m-0 flex items-center justify-center gap-2 rounded-xl border border-line bg-panel-2 px-4 py-3 text-[13px] text-muted">
              <Icon name="eye" className="size-4" />You can read this conversation, but you don’t have permission to post. Ask the project owner for access.
            </p>
          </div>
        )}
      </footer>
    </div>
  );
}
