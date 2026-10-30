'use client';

import Link from 'next/link';
import { Fragment, useState, type ReactNode } from 'react';
import { refreshActive } from '@/lib/client/api';
import { Icon } from '../ui/Icon';
import { ThemeToggle } from '../ui/ThemeToggle';

export interface Crumb {
  label: string;
  href?: string;
}

/** The header's refresh button: fetches everything the page on screen shows. */
function RefreshButton() {
  const [spinning, setSpinning] = useState(false);
  return (
    <button
      className={`icon-btn${spinning ? ' spinning' : ''}`}
      type="button"
      aria-label="Refresh data"
      title="Refresh"
      onClick={async () => {
        if (spinning) return;
        setSpinning(true);
        try {
          await refreshActive();
        } finally {
          setSpinning(false);
        }
      }}
    >
      <Icon name="refresh" />
      <span>Refresh</span>
    </button>
  );
}

/** One dashboard page: the sticky header (breadcrumbs, refresh, theme) and the content. */
export function Page({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((crumb, i) => (
            <Fragment key={`${i}-${crumb.label}`}>
              {i > 0 ? <span>/</span> : null}
              {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            </Fragment>
          ))}
        </nav>
        <RefreshButton />
        <ThemeToggle />
      </header>
      <main className="app-main" aria-live="polite">{children}</main>
    </>
  );
}
