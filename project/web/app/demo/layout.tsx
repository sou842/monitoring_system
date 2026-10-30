import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './demo.css';

export const metadata: Metadata = { title: 'SDK demo' };

/** Pages that break on purpose, so the SDK has something to report (see the scenario buttons on /demo). */
export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <div className="demo">
      <nav>
        <Link href="/demo">Demo home</Link>
        <Link href="/demo/products">Products</Link>
        <Link href="/demo/about">About</Link>
        <Link href="/dashboard">Dashboard</Link>
      </nav>
      <main>{children}</main>
    </div>
  );
}
