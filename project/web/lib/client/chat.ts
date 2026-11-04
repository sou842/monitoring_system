'use client';

import Pusher from 'pusher-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatIssueView, ChatMessageView, ChatReactionView, ChatResponse } from '../types';
import { api, refreshActive } from './api';

/** Seconds between polls when Pusher isn't set up: while the tab is visible, and while it is hidden. */
const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 15000;

/** Adds `incoming` to `list` (oldest first); a message that is already there is replaced (it may have changed). */
function merge(list: ChatMessageView[], incoming: ChatMessageView[]): ChatMessageView[] {
  if (incoming.length === 0) return list;
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
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
  /** Messages arrive live through Pusher (otherwise the page polls). */
  live: boolean;
  /** When you read the chat before this visit (null = never); messages by others after it are "unread". */
  lastReadAt: string | null;
  /** Shows the message at once and delivers it in the background; failures end up in `pending` with status "failed". */
  send: (draft: Draft) => void;
  retry: (clientId: string) => void;
  discard: (clientId: string) => void;
  remove: (id: string) => Promise<void>;
  /** Adds your reaction, or takes it away; the screen updates first. */
  react: (id: string, emoji: string) => void;
  loadOlder: () => Promise<void>;
}

let counter = 0;
const newClientId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

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
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const lastId = useRef<string | null>(null);
  const first = useRef<string | null>(null);
  const pendingRef = useRef<PendingMessage[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** The first-page request in flight, so a repeated effect run (React StrictMode in development) reuses it: loading the chat marks it read, and a second request would erase "what was unread". */
  const firstPage = useRef<{ key: string; request: Promise<ChatResponse> } | null>(null);

  // Remember the ends of the list for "newer than" and "older than" requests.
  useEffect(() => {
    lastId.current = messages.length > 0 ? messages[messages.length - 1].id : null;
    first.current = messages.length > 0 ? messages[0].id : null;
  }, [messages]);

  const updatePending = useCallback((next: (list: PendingMessage[]) => PendingMessage[]) => {
    pendingRef.current = next(pendingRef.current);
    setPending(pendingRef.current);
  }, []);

  /** Fetches everything newer than the last message we have (this also marks the chat read). */
  const catchUp = useCallback(async () => {
    if (!projectId) return;
    const after = lastId.current;
    const res = await api<ChatResponse>(`/api/chat?projectId=${projectId}${after ? `&after=${after}` : ''}`);
    if (res.messages.length > 0) setMessages((list) => merge(list, res.messages));
  }, [projectId]);

  /** Fetches one message again (after a reaction by someone else). */
  const refreshMessage = useCallback(async (id: string) => {
    if (!projectId) return;
    const res = await api<ChatResponse>(`/api/chat?projectId=${projectId}&message=${id}`);
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
    setLastReadAt(null);
    if (!projectId) { setLoading(false); return; }
    let cancelled = false;
    const key = `${projectId}:${reloadCount}`;
    if (firstPage.current?.key !== key) firstPage.current = { key, request: api<ChatResponse>(`/api/chat?projectId=${projectId}`) };
    firstPage.current.request
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages);
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
    const channel = client.subscribe(`private-project-${projectId}`);
    // The events only say "something changed": the content comes from the API (which checks access) and marks the chat read.
    channel.bind('message', () => { void catchUp().catch(() => {}); });
    channel.bind('message-updated', ({ id }: { id: string }) => { void refreshMessage(id).catch(() => {}); });
    channel.bind('message-deleted', ({ id }: { id: string }) => {
      setMessages((list) => list.map((m) => (m.id === id ? { ...m, text: '', mentions: [], issues: [], reactions: [], replyTo: null, deleted: true } : m)));
    });
    // After a reconnect, anything sent while we were away.
    channel.bind('pusher:subscription_succeeded', () => { void catchUp().catch(() => {}); });
    return () => {
      channel.unbind_all();
      client.unsubscribe(`private-project-${projectId}`);
      client.disconnect();
    };
  }, [live, projectId, catchUp, refreshMessage]);

  // Polling when there is no Pusher.
  useEffect(() => {
    if (live || loading || !projectId || error) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      try { await catchUp(); } catch { /* try again next time */ }
      if (!stopped) timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    };
    timer = setTimeout(tick, POLL_VISIBLE_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [live, loading, projectId, error, catchUp]);

  /** Sends one pending message; on success it is replaced by the real one, on failure it stays marked "failed". */
  const deliver = useCallback((clientId: string) => {
    queue.current = queue.current.then(async () => {
      const item = pendingRef.current.find((p) => p.clientId === clientId);
      if (!item || !projectId) return;
      try {
        const res = await api<{ message: ChatMessageView }>('/api/chat', {
          method: 'POST',
          body: { projectId, text: item.draft.text, mentions: item.draft.mentions, issues: item.draft.issues.map((i) => i.id), replyTo: item.draft.replyTo?.id },
        });
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
    setHasMore(res.hasMore);
    setMessages((list) => merge(list, res.messages));
  }, [projectId]);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);

  return { messages, pending, loading, error, reload, hasMore, live, lastReadAt, send, retry, discard, remove, react, loadOlder };
}
