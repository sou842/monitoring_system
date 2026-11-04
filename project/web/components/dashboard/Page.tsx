'use client';

import Link from 'next/link';
import { Fragment, useState, type ReactNode } from 'react';
import { refreshActive } from '@/lib/client/api';
import { Icon } from '../ui/Icon';
import { useSession } from './Shell';

export interface Crumb {
  label: string;
  href?: string;
}

/** Scrolls the page area (not the window: the app scrolls inside its frame) back to the top. */
export function scrollPageToTop(): void {
  document.querySelector('.page-scroll')?.scrollTo({ top: 0 });
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

/** One dashboard page: the top bar (menu on phones, breadcrumbs, refresh) and the scrolling content. */
export function Page({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  const { openDrawer } = useSession();
  return (
    <>
      <header className="page-bar">
        <button type="button" className="bar-menu" onClick={openDrawer} aria-label="Open the menu" title="Menu">
          <Icon name="menu" />
        </button>
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((crumb, i) => (
            <Fragment key={`${i}-${crumb.label}`}>
              {i > 0 ? <span aria-hidden="true">/</span> : null}
              {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            </Fragment>
          ))}
        </nav>
        <RefreshButton />
      </header>
      <div className="page-scroll">
        <main className="app-main" aria-live="polite">{children}</main>
      </div>
    </>
  );
}
