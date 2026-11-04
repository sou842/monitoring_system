'use client';

import Pusher from 'pusher-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessageView, ChatResponse } from '../types';
import { api, refreshActive } from './api';

/** Seconds between polls when Pusher isn't set up: while the tab is visible, and while it is hidden. */
const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 15000;

/** Adds `incoming` to `list` (newer last), skipping ids already there. */
function merge(list: ChatMessageView[], incoming: ChatMessageView[]): ChatMessageView[] {
  const known = new Set(list.map((m) => m.id));
  const added = incoming.filter((m) => !known.has(m.id));
  return added.length === 0 ? list : [...list, ...added].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface ChatState {
  messages: ChatMessageView[];
  /** True until the first page has loaded. */
  loading: boolean;
  error: string | null;
  /** More (older) messages exist than the ones loaded. */
  hasMore: boolean;
  /** Messages arrive live through Pusher (otherwise the page polls). */
  live: boolean;
  send: (text: string, mentions: string[], issues: string[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  loadOlder: () => Promise<void>;
}

/**
 * One project's chat: loads the newest page, then stays current, live through
 * Pusher when the server has it configured (private channel, authorised by
 * /api/pusher/auth) and by polling otherwise. Opening or receiving messages
 * marks the chat read on the server (GET /api/chat does that).
 */
export function useChat(projectId: string | null): ChatState {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [live, setLive] = useState(false);
  const lastId = useRef<string | null>(null);
  const first = useRef<string | null>(null);

  // Remember the ends of the list for "newer than" and "older than" requests.
  useEffect(() => {
    lastId.current = messages.length > 0 ? messages[messages.length - 1].id : null;
    first.current = messages.length > 0 ? messages[0].id : null;
  }, [messages]);

  /** Fetches everything newer than the last message we have (this also marks the chat read). */
  const catchUp = useCallback(async () => {
    if (!projectId) return;
    const after = lastId.current;
    const res = await api<ChatResponse>(`/api/chat?projectId=${projectId}${after ? `&after=${after}` : ''}`);
    if (res.messages.length > 0) setMessages((list) => merge(list, res.messages));
  }, [projectId]);

  // Load the first page whenever the project changes.
  useEffect(() => {
    setMessages([]);
    setLoading(true);
    setError(null);
    setHasMore(false);
    setLive(false);
    if (!projectId) { setLoading(false); return; }
    let cancelled = false;
    api<ChatResponse>(`/api/chat?projectId=${projectId}`)
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages);
        setHasMore(res.hasMore);
        setLive(res.realtime && Boolean(process.env.NEXT_PUBLIC_PUSHER_KEY));
        void refreshActive(); // the unread badge in the sidebar
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the chat'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  // Live updates through Pusher.
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!live || !projectId || !key || !cluster) return;
    const client = new Pusher(key, { cluster, channelAuthorization: { endpoint: '/api/pusher/auth', transport: 'ajax' } });
    const channel = client.subscribe(`private-project-${projectId}`);
    // The event only says "something new": the text comes from the API (which checks access) and marks the chat read.
    channel.bind('message', () => { void catchUp().catch(() => {}); });
    channel.bind('message-deleted', ({ id }: { id: string }) => {
      setMessages((list) => list.map((m) => (m.id === id ? { ...m, text: '', mentions: [], deleted: true } : m)));
    });
    // After a reconnect, anything sent while we were away.
    channel.bind('pusher:subscription_succeeded', () => { void catchUp().catch(() => {}); });
    return () => {
      channel.unbind_all();
      client.unsubscribe(`private-project-${projectId}`);
      client.disconnect();
    };
  }, [live, projectId, catchUp]);

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

  const send = useCallback(async (text: string, mentions: string[], issues: string[]) => {
    if (!projectId) return;
    const res = await api<{ message: ChatMessageView }>('/api/chat', { method: 'POST', body: { projectId, text, mentions, issues } });
    setMessages((list) => merge(list, [res.message]));
  }, [projectId]);

  const remove = useCallback(async (id: string) => {
    await api(`/api/chat?id=${id}`, { method: 'DELETE' });
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, text: '', mentions: [], deleted: true } : m)));
  }, []);

  const loadOlder = useCallback(async () => {
    if (!projectId || !first.current) return;
    const res = await api<ChatResponse>(`/api/chat?projectId=${projectId}&before=${first.current}`);
    setHasMore(res.hasMore);
    setMessages((list) => merge(list, res.messages));
  }, [projectId]);

  return { messages, loading, error, hasMore, live, send, remove, loadOlder };
}
