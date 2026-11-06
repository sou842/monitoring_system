'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { queryString } from '@/lib/format';
import type { ChatIssueView, IssueListItem, IssuesResponse } from '@/lib/types';

/** The search runs once typing has paused this long (just "/" or a search already fetched runs at once). */
const SEARCH_DEBOUNCE_MS = 300;
/** A fetched first page is reused for this long (the picker opens instantly, new issues show up soon enough). */
const CACHE_TTL_MS = 60_000;
/** Most first pages kept (one per project and search text). */
const CACHE_MAX = 40;

const firstPages = new Map<string, { at: number; response: IssuesResponse }>();
const inflight = new Map<string, Promise<IssuesResponse>>();

const keyOf = (projectId: string, q: string) => `${projectId}\n${q}`;
const urlOf = (projectId: string, q: string, page: number) =>
  `/api/issues${queryString({ projectId, status: 'all', sort: 'lastSeen', q, page: page > 1 ? page : null })}`;

function cached(projectId: string, q: string): IssuesResponse | null {
  const hit = firstPages.get(keyOf(projectId, q));
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.response : null;
}

function fetchPage(projectId: string, q: string, page: number): Promise<IssuesResponse> {
  if (page > 1) return api<IssuesResponse>(urlOf(projectId, q, page));
  const key = keyOf(projectId, q);
  const running = inflight.get(key);
  if (running) return running;
  const request = api<IssuesResponse>(urlOf(projectId, q, 1))
    .then((response) => {
      firstPages.set(key, { at: Date.now(), response });
      if (firstPages.size > CACHE_MAX) firstPages.delete(firstPages.keys().next().value as string);
      return response;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/** Warms the cache with the project's newest issues, so the "/" list is there the moment it opens. */
export function prefetchIssues(projectId: string): void {
  if (!cached(projectId, '')) fetchPage(projectId, '', 1).catch(() => {});
}

const toView = (i: IssueListItem): ChatIssueView => ({ id: i.id, eventType: i.eventType, errorType: i.errorType, message: i.message, status: i.status, count: i.count });

interface PickerState { items: ChatIssueView[]; page: number; total: number; loading: boolean; loadingMore: boolean; failed: boolean }
const EMPTY: PickerState = { items: [], page: 0, total: 0, loading: false, loadingMore: false, failed: false };

/**
 * The issues behind the "/" picker: `query` is the text typed after the slash (null while the picker is closed).
 * The first page comes from the cache when there is one (see `prefetchIssues`), a search asks the server, and
 * `loadMore` adds the next page for scrolling.
 */
export function useIssuePicker(projectId: string, query: string | null) {
  const [state, setState] = useState<PickerState>(EMPTY);
  /** Bumps whenever the search changes, so answers to an older search are dropped. */
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Debounce: `settled` follows `query` only after typing pauses (at once when there is nothing to wait for).
  const [settled, setSettled] = useState<string | null>(query);
  useEffect(() => {
    if (query === null || query === '' || cached(projectId, query)) { setSettled(query); return; }
    const timer = setTimeout(() => setSettled(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, query]);

  useEffect(() => {
    if (settled === null) { generation.current++; setState(EMPTY); return; }
    const mine = ++generation.current;
    const hit = cached(projectId, settled);
    if (hit) setState({ items: hit.issues.map(toView), page: 1, total: hit.total, loading: false, loadingMore: false, failed: false });
    // Without a saved page the previous results stay until the new ones arrive (no flashing while typing).
    else setState((s) => ({ ...s, loading: true, loadingMore: false, failed: false }));
    // A cached page may be a minute old: show it, and refresh quietly behind it.
    fetchPage(projectId, settled, 1)
      .then((response) => {
        if (generation.current !== mine) return;
        setState((s) => (hit && s.page > 1 ? s : { items: response.issues.map(toView), page: 1, total: response.total, loading: false, loadingMore: false, failed: false }));
      })
      .catch(() => { if (generation.current === mine) setState({ ...EMPTY, failed: true }); });
  }, [projectId, settled]);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (settled === null || s.loading || s.loadingMore || s.failed || s.page === 0 || s.items.length >= s.total) return;
    const mine = generation.current;
    setState((cur) => ({ ...cur, loadingMore: true }));
    fetchPage(projectId, settled, s.page + 1)
      .then((response) => {
        if (generation.current !== mine) return;
        setState((cur) => {
          const seen = new Set(cur.items.map((i) => i.id));
          return { ...cur, items: [...cur.items, ...response.issues.filter((i) => !seen.has(i.id)).map(toView)], page: response.page, total: response.total, loadingMore: false };
        });
      })
      .catch(() => { if (generation.current === mine) setState((cur) => ({ ...cur, loadingMore: false })); });
  }, [projectId, settled]);

  return { items: state.items, total: state.total, loading: state.loading || (query !== null && query !== settled), loadingMore: state.loadingMore, failed: state.failed, hasMore: state.items.length < state.total, loadMore };
}
