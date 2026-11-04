'use client';

import Link from 'next/link';
import type { ProjectListItem } from '@/lib/types';
import { Avatar } from '../../ui/bits';
import { columnHelper, DataTable, type DataColumnMeta } from '../../ui/DataTable';
import { Icon } from '../../ui/Icon';
import { Badge, pillButton } from '../../ui/kit';

const h = columnHelper<ProjectListItem>();
const RIGHT: DataColumnMeta = { align: 'right' };

function Dot() {
  return <span className="mr-1.5 inline-block size-1.5 rounded-full bg-current" />;
}

// Columns live at module scope: the table rebuilds its row models when they change identity.
const columns = h.columns([
  h.accessor((p) => p.name.toLowerCase(), {
    id: 'name',
    header: 'Project',
    cell: ({ row }) => {
      const p = row.original;
      return (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={p.name} shape="square" size="sm" />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-fg">{p.name}</div>
            <div className="truncate font-mono text-[11px] text-muted">{p.role === 'member' ? `Shared by ${p.ownerName ?? 'the owner'}` : `Key ${p.apiKeyHint}`}</div>
          </div>
        </div>
      );
    },
  }),
  h.accessor((p) => p.role, {
    id: 'role',
    header: 'Access',
    cell: ({ row }) => <Badge tone={row.original.role === 'member' ? 'muted' : 'neutral'}>{row.original.role === 'member' ? 'Shared' : 'Owner'}</Badge>,
  }),
  h.accessor((p) => p.events24h, {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (row.original.events24h > 0 ? <Badge tone="green"><Dot />Receiving</Badge> : <Badge tone="muted"><Dot />Quiet</Badge>),
  }),
  h.accessor((p) => p.openIssues, {
    id: 'openIssues',
    header: 'Open issues',
    meta: RIGHT,
    cell: ({ row }) => (row.original.openIssues > 0
      ? <Badge tone="red" className="tabular-nums">{row.original.openIssues.toLocaleString()}</Badge>
      : <span className="text-muted tabular-nums">0</span>),
  }),
  h.accessor((p) => p.events24h, {
    id: 'events24h',
    header: 'Events (24h)',
    meta: RIGHT,
    cell: ({ row }) => <span className="tabular-nums">{row.original.events24h.toLocaleString()}</span>,
  }),
  h.accessor((p) => (p.role === 'member' ? -1 : p.allowedOrigins.length), {
    id: 'origins',
    header: 'Origins',
    cell: ({ row }) => {
      const p = row.original;
      if (p.role === 'member') return <span className="text-muted">—</span>;
      return <span className="text-muted">{p.allowedOrigins.length === 0 ? 'Any origin' : `${p.allowedOrigins.length} allowed`}</span>;
    },
  }),
  h.accessor((p) => new Date(p.createdAt).getTime(), {
    id: 'createdAt',
    header: 'Created',
    cell: ({ row }) => <span className="text-muted">{new Date(row.original.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>,
  }),
  h.display({
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    enableSorting: false,
    cell: ({ row }) => (
      <span className="flex justify-end">
        <Link href={`/projects/${row.original.id}`} className={pillButton('ghost', 'h-8 px-3 text-xs hover:no-underline')} aria-label={`Open ${row.original.name}`}>
          Open<Icon name="chevron" className="size-3.5 -rotate-90" />
        </Link>
      </span>
    ),
  }),
]);

const searchText = (p: ProjectListItem): string => `${p.name} ${p.ownerName ?? ''} ${p.role === 'member' ? 'shared' : 'owner'}`;

/** The user's projects as a table; `activeId` is marked and `onOpen` runs when a row is opened. */
export function ProjectsTable({ projects, activeId, onOpen }: { projects: ProjectListItem[] | null; activeId: string | null; onOpen: (id: string) => void }) {
  return (
    <DataTable
      className="mt-6"
      data={projects}
      columns={columns}
      getRowId={(p) => p.id}
      search={{ placeholder: 'Search projects…', text: searchText }}
      initialSort={{ id: 'name' }}
      minWidth={820}
      rowHref={(p) => `/projects/${p.id}`}
      onRowOpen={(p) => onOpen(p.id)}
      rowClassName={(p) => (p.id === activeId ? 'shadow-[inset_3px_0_0_var(--accent)]' : undefined)}
      empty="No projects match your search."
    />
  );
}
