'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { api, useApi } from '@/lib/client/api';
import { formatDate, queryString, timeAgo } from '@/lib/format';
import type { AdminResponse, AdminUserRow } from '@/lib/types';
import { Avatar, EmptyState, ErrorNotice, Kpi, Loading } from '../../ui/bits';
import { Badge, toneOfKind } from '../../ui/kit';
import { columnHelper, DataTable, type DataColumnMeta } from '../../ui/DataTable';
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

interface RowActions {
  change: (user: AdminUserRow, kind: Change) => () => void;
  remove: (user: AdminUserRow) => () => void;
  meId: string;
}
const NO_ACTIONS: RowActions = { change: () => () => {}, remove: () => () => {}, meId: '' };
const RIGHT: DataColumnMeta = { align: 'right' };
const h = columnHelper<AdminUserRow>();

const ROW_BUTTON = 'h-7 cursor-pointer rounded-full border border-line-strong bg-panel px-3 text-xs font-medium text-fg shadow-none hover:bg-(--hover)';

function buildColumns(ref: MutableRefObject<RowActions>) {
  return h.columns([
    h.accessor((u) => u.name.toLowerCase(), {
      id: 'user',
      header: 'User',
      cell: ({ row }) => {
        const u = row.original;
        return (
          <div className="flex items-center gap-3">
            <Avatar name={u.name} />
            <div className="min-w-0">
              <div className="flex items-center gap-2"><b className="font-semibold">{u.name}</b>{u.id === ref.current.meId ? <Badge tone="neutral">You</Badge> : null}</div>
              <div className="text-xs text-muted">{u.email}</div>
            </div>
          </div>
        );
      },
    }),
    h.accessor((u) => u.role, { id: 'role', header: 'Role', cell: ({ row }) => <Badge tone={toneOfKind(row.original.role === 'admin' ? 'open' : 'info')} className="capitalize">{row.original.role}</Badge> }),
    h.accessor((u) => u.status, { id: 'status', header: 'Status', cell: ({ row }) => <Badge tone={toneOfKind(row.original.status === 'active' ? 'resolved' : 'error')} className="capitalize">{row.original.status}</Badge> }),
    h.accessor((u) => u.projects, { id: 'projects', header: 'Projects', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{row.original.projects.toLocaleString()}</span> }),
    h.accessor((u) => u.events24h, { id: 'events24h', header: 'Events 24h', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{row.original.events24h.toLocaleString()}</span> }),
    h.accessor((u) => new Date(u.createdAt).getTime(), {
      id: 'createdAt',
      header: 'Joined',
      cell: ({ row }) => <span className="text-muted" title={formatDate(row.original.createdAt)}>{new Date(row.original.createdAt).toLocaleDateString()}</span>,
    }),
    h.accessor((u) => (u.lastLoginAt ? new Date(u.lastLoginAt).getTime() : 0), {
      id: 'lastLoginAt',
      header: 'Last login',
      cell: ({ row }) => <span className="text-muted" title={formatDate(row.original.lastLoginAt)}>{row.original.lastLoginAt ? timeAgo(row.original.lastLoginAt) : '–'}</span>,
    }),
    h.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const u = row.original;
        const { change, remove, meId } = ref.current;
        if (u.id === meId) return <span className="block text-right text-xs text-muted">Use Account page</span>;
        return (
          <div className="flex justify-end gap-1.5 whitespace-nowrap">
            {u.status === 'active'
              ? <button type="button" className={ROW_BUTTON} onClick={change(u, 'disable')}>Disable</button>
              : <button type="button" className={ROW_BUTTON} onClick={change(u, 'enable')}>Enable</button>}
            {u.role === 'admin'
              ? <button type="button" className={ROW_BUTTON} onClick={change(u, 'demote')}>Remove admin</button>
              : <button type="button" className={ROW_BUTTON} onClick={change(u, 'promote')}>Make admin</button>}
            <button type="button" className={`${ROW_BUTTON} text-danger hover:border-danger`} onClick={remove(u)}>Delete</button>
          </div>
        );
      },
    }),
  ]);
}

/** Accounts and usage across the installation (admins only; they can't read other users' issues). */
export function AdminView({ isAdmin }: { isAdmin: boolean }) {
  const actions = useRef<RowActions>(NO_ACTIONS);
  const columns = useMemo(() => buildColumns(actions), []);
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

  // The table's columns keep their identity between renders, so they reach the latest handlers through a ref.
  actions.current = { change, remove, meId: me.id };

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
            <DataTable
              data={data.users}
              columns={columns}
              getRowId={(u) => u.id}
              initialSort={{ id: 'user' }}
              minWidth={980}
              rowClassName={(u) => (u.status === 'disabled' ? 'opacity-60' : undefined)}
            />

          )}
          {data.truncated ? <p className="muted small section">Showing the newest 500 accounts. Search to find others.</p> : null}
        </>
      )}
    </Page>
  );
}
