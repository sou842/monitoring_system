'use client';

import type { ReactNode } from 'react';
import { DialogProvider } from './ui/Dialog';
import { ToastProvider } from './ui/Toasts';

/** App-wide UI hosts (toasts, the modal dialog). In the root layout, so a toast survives a page change. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <DialogProvider>{children}</DialogProvider>
    </ToastProvider>
  );
}
