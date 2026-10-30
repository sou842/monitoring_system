'use client';

/**
 * Dashboard data: `api()` for calls to the app's own /api routes, and
 * `useApi(path)`, a small stale-while-revalidate cache (no packages):
 *
 * - cached data is returned at once; data older than STALE_MS is refreshed in
 *   the background and the page re-renders only when it changed;
 * - concurrent reads of one URL share one request;
 * - any change (resolve, delete, new project, login, logout…) makes every
 *   cached read suspect: data on screen is refreshed, the rest is dropped;
 * - a 401 outside /api/auth ends the session (see `onUnauthorized`).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

/** Cached data younger than this is used as is; older data is shown and refreshed in the background. */
const STALE_MS = 10000;
/** Cached data older than this is never shown, the page waits for fresh data instead. */
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
/** The loading spinner only appears if data takes longer than this, so cached pages never flash it. */
export const LOADING_DELAY_MS = 150;

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, { status = 0, code = '' }: { status?: number; code?: string } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** True for the error thrown when the session ended; the redirect to the login page already happened. */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'session_expired';
}

let unauthorizedHandler: (() => void) | null = null;

/** Registers what happens when an API call answers 401 (the dashboard shell sends the user to the login page). */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * The call ends the session (log out, delete the account): drop the cache
   * instead of refreshing what is on screen, which would only get 401s.
   */
  endsSession?: boolean;
}

/** Calls one of the app's API routes. Throws ApiError with the server's message on failure. */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method,
      credentials: 'same-origin',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('Network error. Check your connection and try again.', { code: 'network' });
  }
  if (response.status === 401 && !path.startsWith('/api/auth')) {
    clearCache();
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError('Session expired', { status: 401, code: 'session_expired' });
  }
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
  if (!response.ok) {
    throw new ApiError((data.error && data.error.message) || `Request failed (${response.status})`, {
      status: response.status,
      code: data.error && data.error.code,
    });
  }
  if (options.endsSession) clearCache();
  else if (options.method && options.method !== 'GET') invalidateAll();
  return data as T;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface Slot {
  data: unknown;
  json: string;
  at: number;
  error: Error | null;
}

const EMPTY: Slot = { data: undefined, json: '', at: 0, error: null };
const slots = new Map<string, Slot>(); // path → latest result; the Map doubles as an LRU list
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();

function emit(path: string): void {
  for (const listener of listeners.get(path) || []) listener();
}

function setSlot(path: string, slot: Slot): void {
  slots.delete(path); // re-inserting moves it to the end
  slots.set(path, slot);
  if (slots.size > CACHE_MAX_ENTRIES) {
    for (const key of slots.keys()) {
      if (slots.size <= CACHE_MAX_ENTRIES) break;
      if (!listeners.get(key)?.size) slots.delete(key);
    }
  }
  emit(path);
}

function fetchIntoCache(path: string): Promise<unknown> {
  let pending = inflight.get(path);
  if (!pending) {
    pending = api<unknown>(path)
      .then((data) => {
        const json = JSON.stringify(data);
        const previous = slots.get(path);
        // Same data as before: keep the old object, so nothing re-renders for nothing.
        setSlot(path, { data: previous && previous.json === json ? previous.data : data, json, at: Date.now(), error: null });
        return data;
      })
      .catch((error: unknown) => {
        const previous = slots.get(path);
        // Offline or a server hiccup during a background refresh: keep showing what we have.
        if (!previous || previous.data === undefined) setSlot(path, { ...EMPTY, error: error instanceof Error ? error : new Error(String(error)) });
        throw error;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  return pending;
}

/** Fetches `path` unless fresh data is cached; drops cached data too old to show. */
function ensureFresh(path: string): void {
  const slot = slots.get(path);
  const age = slot && slot.data !== undefined ? Date.now() - slot.at : Infinity;
  if (age >= CACHE_MAX_AGE_MS) {
    if (slot && (slot.data !== undefined || slot.error)) setSlot(path, EMPTY);
    fetchIntoCache(path).catch(() => {});
  } else if (age >= STALE_MS) {
    fetchIntoCache(path).catch(() => {});
  }
}

/** Warms the cache (e.g. on hover) so the next page opens instantly. Never throws. */
export function prefetch(path: string): void {
  const slot = slots.get(path);
  if (slot && slot.data !== undefined && Date.now() - slot.at < STALE_MS) return;
  fetchIntoCache(path).catch(() => {});
}

/** After a change: data on screen is refreshed in the background, everything else is dropped. */
export function invalidateAll(): void {
  for (const path of [...slots.keys()]) {
    if (listeners.get(path)?.size) fetchIntoCache(path).catch(() => {});
    else slots.delete(path);
  }
}

/** Forgets everything (logout, lost session). */
export function clearCache(): void {
  slots.clear();
}

/** The header's refresh button: fetches everything the page on screen shows. */
export async function refreshActive(): Promise<void> {
  const active = [...listeners.entries()].filter(([, set]) => set.size > 0).map(([path]) => path);
  await Promise.all(active.map((path) => fetchIntoCache(path).catch(() => {})));
}

function subscribe(path: string, listener: () => void): () => void {
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export interface ApiState<T> {
  data: T | undefined;
  error: Error | null;
  /** True while there is nothing to show yet. */
  loading: boolean;
}

/** Reads `path` through the cache; `null` reads nothing (e.g. while another request decides the path). */
export function useApi<T>(path: string | null): ApiState<T> {
  const slot = useSyncExternalStore(
    (listener) => (path === null ? () => {} : subscribe(path, listener)),
    () => (path === null ? EMPTY : slots.get(path) || EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (path !== null) ensureFresh(path);
  }, [path]);
  return { data: slot.data as T | undefined, error: slot.error, loading: path !== null && slot.data === undefined && slot.error === null };
}

/** True once `active` has stayed true for `delayMs`: a spinner that never flashes for fast loads. */
export function useDelayed(active: boolean, delayMs = LOADING_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}
