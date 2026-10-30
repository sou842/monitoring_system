import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import LayoutCrashTrigger from '@/components/demo/LayoutCrashTrigger';
import { THEME_SCRIPT } from '@/components/ui/ThemeToggle';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Error Tracker', template: '%s · Error Tracker' },
  description: 'Error, performance and crash monitoring for your web apps. Free to sign up.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Set by middleware.ts; the inline theme script must carry it to pass the Content-Security-Policy.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    // The theme script changes data-theme before React hydrates.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {/* SDK demo: lets the "Crash root layout" button test app/global-error.tsx. Renders nothing otherwise. */}
        <LayoutCrashTrigger />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
