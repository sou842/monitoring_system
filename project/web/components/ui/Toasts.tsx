'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { isSessionExpired } from '@/lib/client/api';

const TOAST_MS = 3600;
const TOAST_EXIT_MS = 250;

type ToastKind = 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  leaving: boolean;
}

interface ToastApi {
  /** Short confirmation at the bottom of the screen. */
  toast: (message: string, kind?: ToastKind) => void;
  /**
   * Wraps an async click handler: a failure becomes an error toast instead of
   * an unhandled rejection (a lost session is already handled by a redirect).
   */
  action: <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) => (...args: A) => Promise<void>;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;

/** Hosts the toast stack; wrap the app in it once. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = nextId++;
    setItems((list) => [...list, { id, message, kind, leaving: false }]);
    setTimeout(() => {
      setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), TOAST_EXIT_MS);
    }, TOAST_MS);
  }, []);

  const action = useCallback<ToastApi['action']>(
    (fn) =>
      async (...args) => {
        try {
          await fn(...args);
        } catch (error) {
          if (!isSessionExpired(error)) toast(error instanceof Error && error.message ? error.message : 'Something went wrong', 'error');
        }
      },
    [toast],
  );

  const value = useMemo(() => ({ toast, action }), [toast, action]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}${t.leaving ? ' leaving' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-dot" />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** `toast()` and `action()` from the nearest ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast() needs a <ToastProvider> above it');
  return api;
}
