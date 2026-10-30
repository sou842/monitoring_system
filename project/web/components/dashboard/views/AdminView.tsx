'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/client/api';
import { formatDate, queryString, timeAgo } from '@/lib/format';
import type { AdminResponse, AdminUserRow } from '@/lib/types';
import { Avatar, Badge, EmptyState, ErrorNotice, Kpi, Loading } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { useSession } from '../Shell';

type Change = 'disable' | 'enable' | 'promote' | 'demote';

const CHANGES: Record<Change, {
  body: Record<string, string>;
  title: (u: AdminUserRow) => string;
  message: (u: AdminUserRow) => string;
  confirm: string;
  done: (u: AdminUserRow) => string;
  danger?: boolean;
}> = {
  disable: { body: { status: 'disabled' }, title: (u) => `Disable ${u.name}?`, confirm: 'Disable account', done: (u) => `${u.name} was disabled`, danger: true,
    message: (u) => `${u.email} will be logged out everywhere and can't log in. Their projects stop accepting events until the account is enabled again.` },
  enable: { body: { status: 'active' }, title: (u) => `Enable ${u.name}?`, confirm: 'Enable account', done: (u) => `${u.name} was enabled`,
    message: (u) => `${u.email} can log in again and their projects accept events again.` },
  promote: { body: { role: 'admin' }, title: (u) => `Make ${u.name} an admin?`, confirm: 'Make admin', done: (u) => `${u.name} is now an admin`,
    message: (u) => `${u.email} will be able to manage every account, including yours.` },
  demote: { body: { role: 'user' }, title: (u) => `Remove admin rights from ${u.name}?`, confirm: 'Remove admin', done: (u) => `${u.name} is no longer an admin`,
    message: (u) => `${u.email} keeps their account and projects, but can no longer open this page.` },
};

/** Accounts and usage across the installation (admins only; they can't read other users' issues). */
export function AdminView({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const query = useSearchParams();
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const { user: me } = useSession();
  const q = (query.get('q') || '').trim();
  const [search, setSearch] = useState(q);
  const { data, error } = useApi<AdminResponse>(isAdmin ? `/api/admin${queryString({ q })}` : null);

  useEffect(() => setSearch(q), [q]);

  if (!isAdmin) {
    return (
      <Page crumbs={[{ label: 'Admin' }]}>
        <EmptyState icon="folder" title="Admins only" text="You need admin rights to open this page." />
      </Page>
    );
  }

  const change = (user: AdminUserRow, kind: Change) => action(async () => {
    const c = CHANGES[kind];
    const ok = await openDialog({
      title: c.title(user),
      message: c.message(user),
      confirmText: c.confirm,
      danger: Boolean(c.danger),
      onConfirm: () => api(`/api/admin?id=${user.id}`, { method: 'PATCH', body: c.body }),
    });
    if (ok) toast(c.done(user));
  });

  const remove = (user: AdminUserRow) => action(async () => {
    const ok = await openDialog({
      title: `Delete ${user.name}?`,
      message: `This permanently deletes ${user.email}, their ${user.projects} project(s) and all issues and events in them. This can't be undone.`,
      confirmText: 'Delete user',
      danger: true,
      input: { label: `Type “${user.email}” to confirm`, autocomplete: 'off' },
      onConfirm: async (typed) => {
        if (typed.trim().toLowerCase() !== user.email) throw new Error('The email does not match');
        await api(`/api/admin?id=${user.id}`, { method: 'DELETE' });
      },
    });
    if (ok !== null) toast(`${user.email} deleted`);
  });

  return (
    <Page crumbs={[{ label: 'Admin' }]}>
      <div className="page-head"><h1>Admin</h1></div>
      <p className="page-sub">Accounts and usage across the whole installation. Admins manage accounts; they cannot read other users’ issues.</p>
      {error ? <ErrorNotice error={error} /> : !data ? <Loading /> : (
        <>
          <div className="kpi-grid">
            <Kpi label="Users" value={data.totals.users.toLocaleString()} note={`${data.totals.disabledUsers} disabled · ${data.totals.admins} admin(s)`} />
            <Kpi label="Projects" value={data.totals.projects.toLocaleString()} note={data.totals.unownedProjects > 0 ? `${data.totals.unownedProjects} without an owner` : 'All owned'} />
            <Kpi label="Events (24h)" value={data.totals.events24h.toLocaleString()} note="Across all projects" />
            <Kpi label="Avg. projects / user" value={(data.totals.users === 0 ? 0 : Math.round((data.totals.projects / data.totals.users) * 10) / 10).toLocaleString()} />
          </div>
          <div className="filters section">
            <input
              type="search"
              placeholder="Search by name or email…"
              aria-label="Search users"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/admin${queryString({ q: search.trim() })}`, { scroll: false }); }}
            />
          </div>
          {data.users.length === 0 ? (
            <EmptyState icon="search" title="No users found" text={q ? `Nobody matches “${q}”.` : 'No accounts yet.'} />
          ) : (
            <div className="card table-wrap">
              <table className="table">
                <thead>
                  <tr>{['User', 'Role', 'Status', 'Projects', 'Events 24h', 'Joined', 'Last login', ''].map((h, i) => <th key={`${h}-${i}`} className={i === 3 || i === 4 ? 'num' : ''}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {data.users.map((u) => {
                    const self = u.id === me.id;
                    return (
                      <tr key={u.id} className={u.status === 'disabled' ? 'is-disabled' : ''}>
                        <td>
                          <div className="user-cell">
                            <Avatar name={u.name} />
                            <div><b>{u.name}</b>{self ? <Badge text="you" kind="info" /> : null}<div className="muted small">{u.email}</div></div>
                          </div>
                        </td>
                        <td><Badge text={u.role} kind={u.role === 'admin' ? 'open' : 'info'} /></td>
                        <td><Badge text={u.status} kind={u.status === 'active' ? 'resolved' : 'error'} /></td>
                        <td className="num">{u.projects.toLocaleString()}</td>
                        <td className="num">{u.events24h.toLocaleString()}</td>
                        <td className="muted" title={formatDate(u.createdAt)}>{new Date(u.createdAt).toLocaleDateString()}</td>
                        <td className="muted" title={formatDate(u.lastLoginAt)}>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : '–'}</td>
                        <td className="actions">
                          {self ? <span className="muted small">Use Account page</span> : (
                            <div className="row nowrap">
                              {u.status === 'active'
                                ? <button type="button" className="sm" onClick={change(u, 'disable')}>Disable</button>
                                : <button type="button" className="sm" onClick={change(u, 'enable')}>Enable</button>}
                              {u.role === 'admin'
                                ? <button type="button" className="sm" onClick={change(u, 'demote')}>Remove admin</button>
                                : <button type="button" className="sm" onClick={change(u, 'promote')}>Make admin</button>}
                              <button type="button" className="sm danger" onClick={remove(u)}>Delete</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data.truncated ? <p className="muted small section">Showing the newest 500 accounts. Search to find others.</p> : null}
        </>
      )}
    </Page>
  );
}
