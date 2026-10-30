'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, clearCache, onUnauthorized } from '@/lib/client/api';
import type { UserView } from '@/lib/types';
import { Avatar } from '../ui/bits';
import { Icon, type IconName } from '../ui/Icon';
import { useToast } from '../ui/Toasts';

interface Session {
  /** The logged-in user ({ id, email, name, role }). */
  user: UserView;
  /** Updates the user shown in the sidebar (after a rename or a role check). */
  setUser: (user: UserView) => void;
}

const SessionContext = createContext<Session | null>(null);

/** The logged-in user, inside the dashboard. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession() is only available inside the dashboard');
  return session;
}

const NAV: Array<{ href: string; label: string; icon: IconName; match: string[]; admin?: boolean }> = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', match: ['/dashboard'] },
  { href: '/performance', label: 'Performance', icon: 'performance', match: ['/performance'] },
  { href: '/projects', label: 'Projects', icon: 'folder', match: ['/projects', '/issues'] },
  { href: '/admin', label: 'Admin', icon: 'shield', match: ['/admin'], admin: true },
];

const isUnder = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/**
 * Sidebar + content for the logged-in pages. The server layout has already
 * checked the session; a 401 from any later API call sends the user back to
 * the login page, returning here afterwards.
 */
export function Shell({ user: initialUser, children }: { user: UserView; children: ReactNode }) {
  const [user, setUser] = useState(initialUser);
  const router = useRouter();
  const pathname = usePathname();
  const { action } = useToast();

  useEffect(() => setUser(initialUser), [initialUser]);
  useEffect(() => {
    onUnauthorized(() => {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    });
    return () => onUnauthorized(null);
  }, [router]);

  const logout = action(async () => {
    await api('/api/auth?action=logout', { method: 'POST', endsSession: true }).catch(() => {});
    clearCache();
    router.replace('/login');
    router.refresh();
  });

  return (
    <SessionContext.Provider value={{ user, setUser }}>
      <div className="shell">
        <aside className="sidebar">
          <Link className="brand" href="/dashboard"><span className="brand-mark" />ERROR&nbsp;TRACKER</Link>
          <nav className="nav" aria-label="Main">
            {NAV.filter((item) => !item.admin || user.role === 'admin').map((item) => (
              <Link key={item.href} href={item.href} className={item.match.some((m) => isUnder(pathname, m)) ? 'active' : ''}>
                <Icon name={item.icon} />
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="nav nav-bottom">
            <Link href="/account" className={`user-chip${isUnder(pathname, '/account') ? ' active' : ''}`} title="Account settings">
              <Avatar name={user.name} size="sm" />
              <span className="user-meta"><b>{user.name}</b><small>{user.email}</small></span>
            </Link>
            <button className="nav-btn" type="button" onClick={logout}>
              <Icon name="logout" />
              Log out
            </button>
          </div>
        </aside>
        <div className="content">{children}</div>
      </div>
    </SessionContext.Provider>
  );
}
