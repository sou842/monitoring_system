'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, clearCache, onUnauthorized, useApi } from '@/lib/client/api';
import type { ProjectListItem, ProjectsResponse, UserView } from '@/lib/types';
import { Avatar } from '../ui/bits';
import { Icon, type IconName } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { ResizeHandle, usePanelWidth } from '../ui/ResizeHandle';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useToast } from '../ui/Toasts';

interface Session {
  /** The logged-in user ({ id, email, name, role }). */
  user: UserView;
  /** Updates the user shown in the sidebar (after a rename or a role check). */
  setUser: (user: UserView) => void;
  /** Folds the sidebar away while a side panel (Ask AI) needs the room; false brings it back. Doesn't change the saved preference. */
  collapseForPanel: (on: boolean) => void;
  /** The element right of the page where side panels (Ask AI, later chat history and thread info) render themselves; null until mounted. */
  rightSlot: HTMLElement | null;
  /** Opens the navigation drawer (phones, where the sidebar is hidden). */
  openDrawer: () => void;
  /** Your projects; null until the list has loaded. */
  projects: ProjectListItem[] | null;
  /** The project every data page (Dashboard, Performance) shows; null while loading or when you have none. */
  projectId: string | null;
  /** Picks the active project (remembered in this browser). */
  setProjectId: (id: string) => void;
}

const SessionContext = createContext<Session | null>(null);

/** The logged-in user, inside the dashboard. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession() is only available inside the dashboard');
  return session;
}

const PROJECT_KEY = 'et_selected_project';

interface NavEntry {
  label: string;
  icon: IconName;
  /** Missing while the feature isn't built: the row is shown with a "Soon" tag and doesn't link anywhere. */
  href?: string;
  /** Paths under which the entry counts as active. */
  match?: string[];
  /** Active only on the exact path (Projects: a project's own page highlights that project instead). */
  exact?: boolean;
}

const MAIN_NAV: NavEntry[] = [
  { label: 'Assistant', icon: 'ghost' },
  { href: '/dashboard', label: 'Dashboard', icon: 'grid', match: ['/dashboard'] },
  // href is replaced by the active project's issues page in the sidebar.
  { href: '/performance', label: 'Performance', icon: 'performance', match: ['/performance'] },
  { href: '/projects', label: 'Issues', icon: 'inbox', match: ['/issues'] },
  { href: '/chats', label: 'Chats', icon: 'chat', match: ['/chats'] },
];
const ADMIN_NAV: NavEntry[] = [{ href: '/admin', label: 'Admin', icon: 'shield', match: ['/admin'] }];

const COLLAPSED_KEY = 'et_sidebar_collapsed';
const WIDTH_KEY = 'et_sidebar_width';
/** Sidebar width in px: default, and the range the drag handle allows. */
const SIDEBAR_WIDTH = 220;
const SIDEBAR_MIN_WIDTH = 190;
const SIDEBAR_MAX_WIDTH = 420;
/** Projects listed in the sidebar before "All projects". */
const SIDEBAR_PROJECTS = 8;

const isUnder = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** One sidebar row: a link, or a "Soon" row for a planned feature. */
function NavItem({ entry, pathname, collapsed, badge = 0 }: { entry: NavEntry; pathname: string; collapsed: boolean; badge?: number }) {
  const content = (
    <>
      <Icon name={entry.icon} />
      <span className="nav-text">{entry.label}</span>
      {badge > 0 ? <span className="nav-count">{badge > 99 ? '99+' : badge}</span> : null}
      {entry.href ? null : <span className="pill-soon">Soon</span>}
    </>
  );
  if (!entry.href) {
    return <div className="nav-item is-soon" aria-disabled="true" title={`${entry.label} is coming soon`}>{content}</div>;
  }
  // The Projects row also stays lit on an issue page (its project isn't known here).
  const active = entry.exact ? pathname === entry.href || isUnder(pathname, '/issues') : (entry.match ?? [entry.href]).some((m) => isUnder(pathname, m));
  return (
    <Link href={entry.href} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? entry.label : undefined}>
      {content}
    </Link>
  );
}

/** A collapsible group of sidebar rows with a small label. */
function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="side-group" open>
      <summary className="side-label"><span>{label}</span><Icon name="chevron" /></summary>
      <div className="side-items">{children}</div>
    </details>
  );
}

/**
 * The logged-in frame (docs/DESIGN.md): team rail, sidebar, the page, and a slot
 * on the right for side panels. The server layout has already checked the
 * session; a 401 from any later API call sends the user back to the login page,
 * returning here afterwards.
 */
export function Shell({ user: initialUser, children }: { user: UserView; children: ReactNode }) {
  const [user, setUser] = useState(initialUser);
  const router = useRouter();
  const pathname = usePathname();
  const { action } = useToast();
  const [userCollapsed, setCollapsed] = useState(false);
  const [panelCollapse, setPanelCollapse] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null);
  const collapsed = userCollapsed || panelCollapse;
  const sidebar = usePanelWidth(WIDTH_KEY, SIDEBAR_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  const { data: projectList } = useApi<ProjectsResponse>('/api/projects');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const projectItems = projectList ? projectList.projects : null;
  // The remembered project if it still exists, else the first one.
  const activeProject = projectItems ? (projectItems.find((p) => p.id === pickedId) ?? projectItems[0] ?? null) : null;
  const projectId = activeProject ? activeProject.id : null;
  // Stable identity: pages call it from effects (a project's page marks itself as the active one).
  const setProjectId = useCallback((id: string) => {
    setPickedId(id);
    try { localStorage.setItem(PROJECT_KEY, id); } catch { /* storage blocked */ }
  }, []);
  // Picking a project in the sidebar menu: a page that shows one project (its issues, one of its issues) follows the choice.
  const pickProject = (id: string) => {
    setProjectId(id);
    if (id !== projectId && (isUnder(pathname, '/projects') && pathname !== '/projects' || isUnder(pathname, '/issues'))) router.push(`/projects/${id}`);
  };

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1');
      setPickedId(localStorage.getItem(PROJECT_KEY));
    } catch { /* storage blocked */ }
  }, []);

  // A new page closes the phone drawer; so does Escape.
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const toggleSidebar = () => {
    // Expanding while a panel has folded it: just undo the fold.
    if (panelCollapse) { setPanelCollapse(false); return; }
    setCollapsed((was) => {
      try { localStorage.setItem(COLLAPSED_KEY, was ? '0' : '1'); } catch { /* storage blocked */ }
      return !was;
    });
  };

  useEffect(() => setUser(initialUser), [initialUser]);
  useEffect(() => {
    onUnauthorized(() => {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    });
    return () => onUnauthorized(null);
  }, [router]);

  const logout = action(async () => {
    await api('/api/auth?action=logout', { method: 'POST', endsSession: true }).catch(() => {});
    // The development login bypass (LoginForm) is a plain cookie the server can't clear; without this the dev "admin" stays logged in.
    document.cookie = 'et_dev=; path=/; max-age=0; SameSite=Lax';
    clearCache();
    router.replace('/login');
    router.refresh();
  });

  const projects = projectList ? projectList.projects : [];
  const shown = projects.slice(0, SIDEBAR_PROJECTS);
  const unreadTotal = projects.reduce((sum, p) => sum + p.unreadMessages, 0);

  return (
    <SessionContext.Provider value={{ user, setUser, collapseForPanel: setPanelCollapse, rightSlot, openDrawer: () => setDrawer(true), projects: projectItems, projectId, setProjectId }}>
      <div>
        <div className={`app-frame${collapsed ? ' collapsed' : ''}${drawer ? ' drawer-open' : ''}`}>
          {/* <nav className="rail" aria-label="Teams">
            {TEAMS.map((t) => (
              <button key={t.id} type="button" className={`rail-tile${t.id === ACTIVE_TEAM_ID ? ' active' : ''}`} title={t.name} aria-label={`${t.name} team`} aria-pressed={t.id === ACTIVE_TEAM_ID}>
                {t.name[0]}
              </button>
            ))}
            <button type="button" className="rail-tile rail-add" title="Create team (coming soon)" aria-label="Create team (coming soon)" aria-disabled="true">
              <Icon name="plus" />
            </button>
            <span className="rail-grow" />
            <Menu placement="right-end" trigger={({ open, toggle }) => (
              <button type="button" className="rail-me" onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="Your account menu" title={user.name}>
                <Avatar name={user.name} />
              </button>
            )}>
              <div className="menu-head"><b>{user.name}</b><small>{user.email}</small></div>
              <Link className="menu-item" role="menuitem" href="/account"><Icon name="user" />Account</Link>
              <div className="menu-row" onClick={(e) => e.stopPropagation()}><span>Theme</span><ThemeToggle /></div>
              <button type="button" className="menu-item danger" role="menuitem" onClick={logout}><Icon name="logout" />Log out</button>
            </Menu>
          </nav> */}

          <aside className="side" style={{ '--sidebar-w': `${sidebar.width}px` } as CSSProperties}>
            {collapsed ? null : <ResizeHandle panel={sidebar} edge="right" label="Resize sidebar" />}
            <div className="side-head">
              <Menu className="team-menu" trigger={({ open, toggle }) => (
                <button type="button" className="team-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open} title="Switch project">
                  <span className="team-name">{activeProject ? activeProject.name : projectItems ? 'No projects' : 'Loading…'}</span>
                  <Icon name="chevron" />
                </button>
              )}>
                <div className="menu-label">Projects</div>
                {(projectItems ?? []).map((p) => (
                  <button key={p.id} type="button" className="menu-item" role="menuitemradio" aria-checked={p.id === projectId} onClick={() => pickProject(p.id)}>
                    <Avatar name={p.name} size="sm" shape="square" />{p.name}
                    {p.id === projectId ? <Icon name="check" className="menu-check" /> : null}
                  </button>
                ))}
                <Link className="menu-item" role="menuitem" href="/projects?new=1"><Icon name="plus" />New project</Link>
                <Link className="menu-item" role="menuitem" href="/projects"><Icon name="folder" />Manage projects</Link>
              </Menu>
              <button className="side-toggle" type="button" onClick={toggleSidebar} aria-expanded={!collapsed}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
                <Icon name="sidebar" />
              </button>
            </div>

            <div className="side-scroll">
              <nav className="side-items" aria-label="Main">
                {MAIN_NAV.map((entry) => {
                  // "Issues" goes straight to the active project's issues.
                  const e = entry.label === 'Issues' && projectId
                    ? { ...entry, href: `/projects/${projectId}`, match: ['/issues', `/projects/${projectId}`] }
                    : entry;
                  return <NavItem key={entry.label} entry={e} pathname={pathname} collapsed={collapsed} badge={entry.label === 'Chats' ? unreadTotal : 0} />;
                })}
              </nav>

              <NavGroup label="Projects">
                {shown.map((p) => {
                  const active = isUnder(pathname, `/projects/${p.id}`);
                  return (
                    <Link key={p.id} href={`/projects/${p.id}`} onClick={() => setProjectId(p.id)} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? p.name : undefined}>
                      <Avatar name={p.name} size="sm" shape="square" />
                      <span className="nav-text">{p.name}</span>
                      {p.openIssues > 0 ? <span className="nav-count">{p.openIssues > 999 ? '999+' : p.openIssues}</span> : null}
                    </Link>
                  );
                })}
                {projects.length > shown.length ? <Link href="/projects" className="nav-item muted-item"><Icon name="folder" /><span className="nav-text">All projects ({projects.length})</span></Link> : null}
                <Link href="/projects?new=1" className="nav-item muted-item" title={collapsed ? 'New project' : undefined}><Icon name="plus" /><span className="nav-text">New project</span></Link>
              </NavGroup>

              {user.role === 'admin' ? (
                <NavGroup label="Admin">
                  {ADMIN_NAV.map((entry) => <NavItem key={entry.label} entry={entry} pathname={pathname} collapsed={collapsed} />)}
                </NavGroup>
              ) : null}
            </div>

            <div className="side-foot">
              <Menu className="w-full" placement="top-stretch" trigger={({ open, toggle }) => (
                <button type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open} title="Account menu"
                  className={`user-card w-full cursor-pointer border-0 text-left ${open || isUnder(pathname, '/account') ? ' active' : ''}`}>
                  <Avatar name={user.name} size="sm" />
                  <span className="user-text min-w-0 flex-1"><b>{user.name}</b><small>{user.email}</small></span>
                  <Icon name="chevron" className="size-3.5 shrink-0 rotate-180 text-muted" />
                </button>
              )}>
                <Link className="menu-item" role="menuitem" href="/account"><Icon name="user" />Account</Link>
                <div className="menu-row" onClick={(e) => e.stopPropagation()}><span>Theme</span><ThemeToggle /></div>
                <button type="button" className="menu-item danger" role="menuitem" onClick={logout}><Icon name="logout" />Log out</button>
              </Menu>
              {/* The rail (with the account menu) is hidden on phones, so theme and log out live here too. */}
              <div className="side-phone">
                <ThemeToggle />
                <button type="button" className="icon-btn" onClick={logout}><Icon name="logout" /><span>Log out</span></button>
              </div>
            </div>
          </aside>

          <div className="content">{children}</div>
          <div className="right-slot" ref={setRightSlot} />
          <button type="button" className="drawer-backdrop" aria-label="Close the menu" tabIndex={-1} onClick={() => setDrawer(false)} />
        </div>
      </div>
    </SessionContext.Provider>
  );
}
