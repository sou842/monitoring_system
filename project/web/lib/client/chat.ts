'use client';

import Pusher, { type PresenceChannel } from 'pusher-js';

/** "Is typing" lapses this long after the last signal; you send a signal at most this often. */
const TYPING_SHOWN_MS = 5000;
const TYPING_SEND_EVERY_MS = 3000;
import { useCallback, useEffect, useRef, useState } from 'react';
import { REPLY_SNIPPET_LENGTH } from '../chat';
import type { ChatIssueView, ChatMessageView, ChatReactionView, ChatResponse } from '../types';
import { api, refreshActive } from './api';

/** Seconds between polls when Pusher isn't set up: while the tab is visible, and while it is hidden. */
const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 15000;
/** Safety sync while Pusher is connected (catches an event lost on the way). */
const POLL_SAFETY_MS = 60000;
/** Most catch-up requests in a row (each returns up to 200 messages); after that the chat reloads instead. */
const MAX_CATCH_UP_ROUNDS = 5;

/** Replaces messages of `list` that changed (edited, reacted to, deleted); ones not loaded are ignored (no holes in the history). */
function applyChanges(list: ChatMessageView[], changed: ChatMessageView[]): ChatMessageView[] {
  if (changed.length === 0) return list;
  const byId = new Map(changed.map((m) => [m.id, m]));
  return freshQuotes(list.some((m) => byId.has(m.id)) ? list.map((m) => byId.get(m.id) ?? m) : list, changed);
}

/** Adds `incoming` to `list` (oldest first); a message that is already there is replaced (it may have changed). */
function merge(list: ChatMessageView[], incoming: ChatMessageView[]): ChatMessageView[] {
  if (incoming.length === 0) return list;
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return freshQuotes([...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), incoming);
}

/** Replies that quote one of `sources` show its current text (after an edit or delete), like the server would. */
function freshQuotes(list: ChatMessageView[], sources: ChatMessageView[]): ChatMessageView[] {
  const byId = new Map(sources.map((m) => [m.id, m]));
  let changed = false;
  const next = list.map((m) => {
    const source = m.replyTo ? byId.get(m.replyTo.id) : undefined;
    if (!m.replyTo || !source) return m;
    const text = source.deleted ? '' : source.text.slice(0, REPLY_SNIPPET_LENGTH);
    const hasIssues = !source.deleted && source.issues.length > 0;
    if (m.replyTo.text === text && m.replyTo.deleted === source.deleted && m.replyTo.hasIssues === hasIssues) return m;
    changed = true;
    return { ...m, replyTo: { ...m.replyTo, text, deleted: source.deleted, hasIssues } };
  });
  return changed ? next : list;
}

/** A random id for one send, so a retry is recognised by the server (unique across tabs and devices). */
function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  }
}

/** What the person typed, to send. */
export interface Draft {
  text: string;
  mentions: string[];
  issues: ChatIssueView[];
  /** The message being answered. */
  replyTo: ChatMessageView | null;
}

/** A message that is on its way (or did not make it): shown at once, before the server has answered. */
export interface PendingMessage {
  clientId: string;
  draft: Draft;
  status: 'sending' | 'failed';
  /** Why it failed (short), for the tooltip next to "Not sent". */
  error: string | null;
  createdAt: string;
}

export interface ChatState {
  messages: ChatMessageView[];
  /** Messages being sent or failed, oldest first; shown after `messages`. */
  pending: PendingMessage[];
  /** True until the first page has loaded. */
  loading: boolean;
  /** Why the first page could not be loaded (null = fine). */
  error: string | null;
  reload: () => void;
  /** More (older) messages exist than the ones loaded. */
  hasMore: boolean;
  /** Messages arrive live through Pusher and the connection is up (otherwise the page polls). */
  live: boolean;
  /** Ids of the people with the chat open right now (empty without a live connection). */
  online: string[];
  /** Ids of the people typing a message right now. */
  typingIds: string[];
  notifyTyping: () => void;
  /** When you read the chat before this visit (null = never); messages by others after it are "unread". */
  lastReadAt: string | null;
  /** Shows the message at once and delivers it in the background; failures end up in `pending` with status "failed". */
  send: (draft: Draft) => void;
  retry: (clientId: string) => void;
  discard: (clientId: string) => void;
  remove: (id: string) => Promise<void>;
  /** Saves new text and attached issues for your own message; the screen updates first and goes back on failure (the promise rejects). */
  edit: (id: string, text: string, issues: ChatIssueView[]) => Promise<void>;
  /** Adds your reaction, or takes it away; the screen updates first. */
  react: (id: string, emoji: string) => void;
  loadOlder: () => Promise<void>;
}


/**
 * One project's chat: loads the newest page, then stays current, live through
 * Pusher when the server has it configured (private channel, authorised by
 * /api/pusher/auth) and by polling otherwise. Opening or receiving messages
 * marks the chat read on the server (GET /api/chat does that). Sending is
 * optimistic: the message appears at once and is delivered in order in the
 * background.
 */
export function useChat(projectId: string | null, me: { id: string; name: string }): ChatState {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [live, setLive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState<string[]>([]);
  const [typingIds, setTypingIds] = useState<string[]>([]);
  const presenceRef = useRef<PresenceChannel | null>(null);
  const typingTimers = useRef(new Map<string, number>());
  const lastTypingSent = useRef(0);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const lastId = useRef<string | null>(null);
  const first = useRef<string | null>(null);
  const pendingRef = useRef<PendingMessage[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Server cursor for "what changed since" (edits, reactions, deletes of loaded messages). */
  const syncedAt = useRef<string | null>(null);
  /** One catch-up at a time; a request for another while one runs makes it run once more afterwards. */
  const syncing = useRef<{ running: Promise<void> | null; again: boolean }>({ running: null, again: false });
  /** The first-page request in flight, so a repeated effect run (React StrictMode in development) reuses it: loading the chat marks it read, and a second request would erase "what was unread". */
  const firstPage = useRef<{ key: string; request: Promise<ChatResponse> } | null>(null);

  /** The project on screen now: a request that answers after a switch must not touch the new project's chat. */
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const messagesRef = useRef<ChatMessageView[]>(messages);
  messagesRef.current = messages;

  // Remember the ends of the list for "newer than" and "older than" requests.
  useEffect(() => {
    lastId.current = messages.length > 0 ? messages[messages.length - 1].id : null;
    first.current = messages.length > 0 ? messages[0].id : null;
  }, [messages]);

  const updatePending = useCallback((next: (list: PendingMessage[]) => PendingMessage[]) => {
    pendingRef.current = next(pendingRef.current);
    setPending(pendingRef.current);
  }, []);

  /**
   * Fetches everything newer than the last message we have, plus loaded messages that changed since the last sync
   * (this also marks the chat read). Asks again while the server says there is more; a very long gap reloads.
   */
  const syncOnce = useCallback(async () => {
    if (!projectId) return;
    for (let round = 0; round < MAX_CATCH_UP_ROUNDS; round++) {
      const after = lastId.current;
      const since = syncedAt.current;
      const query = `projectId=${projectId}${after ? `&after=${after}` : ''}${since && after ? `&since=${encodeURIComponent(since)}` : ''}`;
      const res = await api<ChatResponse>(`/api/chat?${query}`);
      if (activeProject.current !== projectId) return;
      syncedAt.current = res.syncedAt;
      if (res.messages.length > 0 || res.changed.length > 0) {
        setMessages((list) => merge(applyChanges(list, res.changed), res.messages));
        // The ref is normally moved by an effect after render; move it now so the next round continues from here.
        if (res.messages.length > 0) lastId.current = res.messages[res.messages.length - 1].id;
      }
      if (!res.hasMore) return;
    }
    if (activeProject.current === projectId) setReloadCount((n) => n + 1); // too far behind: start again from the newest page
  }, [projectId]);

  /** Runs one sync at a time; asking while one runs makes it run once more right after. */
  const catchUp = useCallback((): Promise<void> => {
    const state = syncing.current;
    if (state.running) { state.again = true; return state.running; }
    const run = (async () => {
      try {
        do { state.again = false; await syncOnce(); } while (state.again);
      } finally { state.running = null; }
    })();
    state.running = run;
    return run;
  }, [syncOnce]);

  /** Fetches one message again (after a reaction by someone else). */
  const refreshMessage = useCallback(async (id: string) => {
    if (!projectId) return;
    const res = await api<ChatResponse>(`/api/chat?projectId=${projectId}&message=${id}`);
    if (activeProject.current !== projectId) return;
    if (res.messages.length > 0) setMessages((list) => merge(list, res.messages));
  }, [projectId]);

  // Load the first page whenever the project changes (or the person asks to try again).
  useEffect(() => {
    setMessages([]);
    updatePending(() => []);
    setLoading(true);
    setError(null);
    setHasMore(false);
    setLive(false);
    setConnected(false);
    setLastReadAt(null);
    syncedAt.current = null;
    syncing.current = { running: null, again: false };
    if (!projectId) { setLoading(false); return; }
    let cancelled = false;
    const key = `${projectId}:${reloadCount}`;
    if (firstPage.current?.key !== key) firstPage.current = { key, request: api<ChatResponse>(`/api/chat?projectId=${projectId}`) };
    firstPage.current.request
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages);
        syncedAt.current = res.syncedAt;
        setHasMore(res.hasMore);
        setLastReadAt(res.lastReadAt);
        setLive(res.realtime && Boolean(process.env.NEXT_PUBLIC_PUSHER_KEY));
        void refreshActive(); // the unread badge in the sidebar
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the chat'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, reloadCount, updatePending]);

  // Live updates through Pusher.
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!live || !projectId || !key || !cluster) return;
    const client = new Pusher(key, { cluster, channelAuthorization: { endpoint: '/api/pusher/auth', transport: 'ajax' } });
    // While the socket is down (a proxy blocking WebSockets, a laptop waking up…) the page polls instead.
    client.connection.bind('state_change', ({ current }: { current: string }) => setConnected(current === 'connected'));
    const channel = client.subscribe(`private-project-${projectId}`);
    // The events only say "something changed": the content comes from the API (which checks access) and marks the chat read.
    channel.bind('message', () => { void catchUp().catch(() => {}); });
    channel.bind('message-updated', ({ id }: { id: string }) => { void refreshMessage(id).catch(() => {}); });
    channel.bind('message-deleted', ({ id }: { id: string }) => {
      setMessages((list) => list.map((m) => (m.id === id ? { ...m, text: '', mentions: [], issues: [], reactions: [], replyTo: null, deleted: true } : m)));
    });
    // After a reconnect, anything sent while we were away.
    channel.bind('pusher:subscription_succeeded', () => { void catchUp().catch(() => {}); });

    // Who is online and who is typing: a presence channel (Pusher signs the user id, so it can't be faked);
    // "typing" is a client event, which Pusher forwards with the sender's verified id. It lapses after a few seconds.
    const presence = client.subscribe(`presence-project-${projectId}`) as PresenceChannel;
    const idOf = (m: { id: string }) => String(m.id);
    const syncOnline = () => { const ids: string[] = []; presence.members.each((m: { id: string }) => ids.push(idOf(m))); setOnline(ids); };
    presence.bind('pusher:subscription_succeeded', syncOnline);
    presence.bind('pusher:member_added', syncOnline);
    presence.bind('pusher:member_removed', (m: { id: string }) => {
      syncOnline();
      const t = typingTimers.current.get(idOf(m));
      if (t) { clearTimeout(t); typingTimers.current.delete(idOf(m)); }
      setTypingIds((list) => list.filter((id) => id !== idOf(m)));
    });
    presence.bind('client-typing', (_data: unknown, meta?: { user_id?: string }) => {
      const id = meta?.user_id;
      if (!id) return;
      clearTimeout(typingTimers.current.get(id));
      typingTimers.current.set(id, window.setTimeout(() => {
        typingTimers.current.delete(id);
        setTypingIds((list) => list.filter((x) => x !== id));
      }, TYPING_SHOWN_MS));
      setTypingIds((list) => (list.includes(id) ? list : [...list, id]));
    });
    presenceRef.current = presence;
    return () => {
      presenceRef.current = null;
      presence.unbind_all();
      typingTimers.current.forEach((t) => clearTimeout(t));
      typingTimers.current.clear();
      setOnline([]);
      setTypingIds([]);
      client.unsubscribe(`presence-project-${projectId}`);
      channel.unbind_all();
      client.unsubscribe(`private-project-${projectId}`);
      client.disconnect();
      setConnected(false);
    };
  }, [live, projectId, catchUp, refreshMessage]);

  // Back to the tab, or back online: catch up at once instead of waiting for the next poll or event.
  useEffect(() => {
    if (loading || !projectId || error) return;
    const wake = () => { if (!document.hidden) void catchUp().catch(() => {}); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => { document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [loading, projectId, error, catchUp]);

  // Polling when there is no Pusher, or while its connection is down.
  const realtimeUp = live && connected;
  useEffect(() => {
    if (loading || !projectId || error) return;
    // With Pusher up, a slow safety sync still runs: an event lost on the way must not leave the screen stale for good.
    const delay = () => (realtimeUp ? POLL_SAFETY_MS : document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (!(realtimeUp && document.hidden)) {
        try { await catchUp(); } catch { /* try again next time */ }
      }
      if (!stopped) timer = setTimeout(tick, delay());
    };
    timer = setTimeout(tick, delay());
    return () => { stopped = true; clearTimeout(timer); };
  }, [realtimeUp, loading, projectId, error, catchUp]);

  /** Sends one pending message; on success it is replaced by the real one, on failure it stays marked "failed". */
  const deliver = useCallback((clientId: string) => {
    queue.current = queue.current.then(async () => {
      const item = pendingRef.current.find((p) => p.clientId === clientId);
      if (!item || !projectId) return;
      try {
        const res = await api<{ message: ChatMessageView }>('/api/chat', {
          method: 'POST',
          body: { projectId, clientId, text: item.draft.text, mentions: item.draft.mentions, issues: item.draft.issues.map((i) => i.id), replyTo: item.draft.replyTo?.id },
        });
        if (activeProject.current !== projectId) return;
        setMessages((list) => merge(list, [res.message]));
        updatePending((list) => list.filter((p) => p.clientId !== clientId));
      } catch (e) {
        const reason = e instanceof Error && e.message ? e.message : 'Could not send';
        updatePending((list) => list.map((p) => (p.clientId === clientId ? { ...p, status: 'failed', error: reason } : p)));
      }
    });
  }, [projectId, updatePending]);

  const send = useCallback((draft: Draft) => {
    const clientId = newClientId();
    updatePending((list) => [...list, { clientId, draft, status: 'sending', error: null, createdAt: new Date().toISOString() }]);
    deliver(clientId);
  }, [deliver, updatePending]);

  const retry = useCallback((clientId: string) => {
    updatePending((list) => list.map((p) => (p.clientId === clientId ? { ...p, status: 'sending', error: null } : p)));
    deliver(clientId);
  }, [deliver, updatePending]);

  const discard = useCallback((clientId: string) => updatePending((list) => list.filter((p) => p.clientId !== clientId)), [updatePending]);

  const remove = useCallback(async (id: string) => {
    await api(`/api/chat?id=${id}`, { method: 'DELETE' });
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, text: '', mentions: [], issues: [], reactions: [], replyTo: null, deleted: true } : m)));
  }, []);

  const edit = useCallback(async (id: string, text: string, issues: ChatIssueView[]) => {
    const before = messagesRef.current.find((m) => m.id === id);
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, text, issues, editedAt: new Date().toISOString() } : m)));
    try {
      const res = await api<{ message: ChatMessageView | null }>('/api/chat', { method: 'PATCH', body: { id, text, issues: issues.map((i) => i.id) } });
      if (res.message) setMessages((list) => merge(list, [res.message as ChatMessageView]));
    } catch (e) {
      const original = before;
      if (original) setMessages((list) => list.map((m) => (m.id === id ? original : m)));
      void refreshMessage(id).catch(() => {});
      throw e;
    }
  }, [refreshMessage]);

  const react = useCallback((id: string, emoji: string) => {
    // Show it straight away...
    setMessages((list) => list.map((m) => {
      if (m.id !== id) return m;
      const existing = m.reactions.find((r) => r.emoji === emoji);
      let reactions: ChatReactionView[];
      if (existing?.mine) {
        reactions = m.reactions.flatMap((r) => (r.emoji !== emoji ? [r] : r.count <= 1 ? [] : [{ ...r, count: r.count - 1, mine: false, names: r.names.filter((n) => n !== me.name) }]));
      } else if (existing) {
        reactions = m.reactions.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, mine: true, names: [...r.names, me.name] } : r));
      } else {
        reactions = [...m.reactions, { emoji, count: 1, mine: true, names: [me.name] }];
      }
      return { ...m, reactions };
    }));
    // ...then tell the server; on failure fetch the real state back.
    api<{ message: ChatMessageView | null }>('/api/chat?action=react', { method: 'POST', body: { id, emoji } })
      .then((res) => { if (res.message) setMessages((list) => merge(list, [res.message as ChatMessageView])); })
      .catch(() => { void refreshMessage(id).catch(() => {}); });
  }, [me.name, refreshMessage]);

  const loadOlder = useCallback(async () => {
    if (!projectId || !first.current) return;
    const res = await api<ChatResponse>(`/api/chat?projectId=${projectId}&before=${first.current}`);
    if (activeProject.current !== projectId) return;
    setHasMore(res.hasMore);
    setMessages((list) => merge(list, res.messages));
  }, [projectId]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);

  /** Tells the others you are typing (at most once every few seconds; does nothing without a live connection). */
  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (!presenceRef.current || now - lastTypingSent.current < TYPING_SEND_EVERY_MS) return;
    lastTypingSent.current = now;
    try { presenceRef.current.trigger('client-typing', {}); } catch { /* not subscribed yet, or the socket is down: skip */ }
  }, []);

  return { messages, pending, loading, error, reload, hasMore, live: realtimeUp, online, typingIds, notifyTyping, lastReadAt, send, retry, discard, remove, edit, react, loadOlder };
}
