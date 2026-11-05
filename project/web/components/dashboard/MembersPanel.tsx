'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { DEFAULT_MEMBER_PERMISSIONS, PERMISSIONS, PERMISSION_INFO, type Permission } from '@/lib/permissions';
import { api, useApi } from '@/lib/client/api';
import type { MembersResponse, MemberView, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, ErrorNotice, Loading } from '../ui/bits';
import { columnHelper, DataTable } from '../ui/DataTable';
import { useDialog } from '../ui/Dialog';
import { CARD, Badge, PillButton, pillButton } from '../ui/kit';
import { useToast } from '../ui/Toasts';
import { useSession } from './Shell';

/** A row of checkboxes, one per permission, with a short explanation under each name. */
function PermissionPicker({ value, onChange, unavailable = [] }: { value: Permission[]; onChange: (next: Permission[]) => void; /** Permissions the person adding can't hand out (they don't hold them). */ unavailable?: Permission[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {PERMISSIONS.map((p) => (
        <label key={p} className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-panel-2 px-3 py-2.5 text-[13px]">
          <input
            type="checkbox"
            checked={value.includes(p)}
            disabled={unavailable.includes(p)}
            title={unavailable.includes(p) ? 'You can only give permissions you have yourself' : undefined}
            onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
          />
          <span className="min-w-0">
            <b className="block font-medium">{PERMISSION_INFO[p].label}</b>
            <span className="text-xs text-muted">{PERMISSION_INFO[p].text}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** The permissions of a member as small chips ("Can only view" when none). */
function PermissionChips({ permissions }: { permissions: Permission[] }) {
  if (permissions.length === 0) return <Badge tone="muted">View only</Badge>;
  return (
    <div className="flex flex-wrap gap-1">
      {permissions.map((p) => <Badge key={p} tone="neutral">{PERMISSION_INFO[p].label}</Badge>)}
    </div>
  );
}

function Person({ person, badge, children }: { person: PersonView; badge?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={person.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><b className="truncate text-sm font-medium">{person.name}</b>{badge}</div>
        <div className="truncate text-xs text-muted">{person.email}</div>
        {children}
      </div>
    </div>
  );
}

/** One line of the people table: the owner, or a member. */
interface PersonRow {
  id: string;
  person: PersonView;
  /** Null for the owner. */
  member: MemberView | null;
}

/** What the table's buttons need; the columns read it through a ref so they can stay the same object between renders. */
interface RowTools {
  userId: string;
  canManage: boolean;
  isOwner: boolean;
  editingId: string | null;
  edit: (member: MemberView) => void;
  remove: (member: MemberView) => () => void;
}
const NO_TOOLS: RowTools = { userId: '', canManage: false, isOwner: false, editingId: null, edit: () => {}, remove: () => () => {} };

const personHelper = columnHelper<PersonRow>();
function buildColumns(tools: MutableRefObject<RowTools>) {
  return personHelper.columns([
    personHelper.accessor((r) => r.person.name.toLowerCase(), {
      id: 'person',
      header: 'Person',
      cell: ({ row }) => {
        const { person, member } = row.original;
        const badge = !member ? <Badge className="px-2 py-0" tone="dark">Owner</Badge> : member.id === tools.current.userId ? <Badge className="text-xs" tone="muted">You</Badge> : undefined;
        return <Person person={person} badge={badge} />;
      },
    }),
    personHelper.display({
      id: 'access',
      header: 'Access',
      cell: ({ row }) => (row.original.member
        ? <PermissionChips permissions={row.original.member.permissions} />
        : <span className="text-xs text-muted">Can do everything, including deleting the project</span>),
    }),
    personHelper.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const m = row.original.member;
        const { userId, canManage, isOwner, editingId, edit, remove } = tools.current;
        if (!m) return null;
        const mine = m.id === userId;
        const manageable = canManage && (isOwner || !m.permissions.includes('members.manage'));
        return (
          <div className="flex justify-end gap-1.5">
            {manageable && !mine ? <PillButton className="h-8" onClick={() => edit(m)}>{editingId === m.memberId ? 'Cancel' : 'Edit'}</PillButton> : null}
            {mine || manageable ? <PillButton variant="danger" className="h-8" onClick={remove(m)}>{mine ? 'Leave' : 'Remove'}</PillButton> : null}
          </div>
        );
      },
    }),
  ]);
}

/** A project's people: the owner and the members with their permissions; add, edit and remove when allowed. */
export function MembersPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const router = useRouter();
  const { user } = useSession();
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const url = `/api/projects/members?projectId=${projectId}`;
  const { data, error } = useApi<MembersResponse>(url);

  const [email, setEmail] = useState('');
  const [newPermissions, setNewPermissions] = useState<Permission[]>([...DEFAULT_MEMBER_PERMISSIONS]);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ memberId: string; permissions: Permission[] } | null>(null);
  const tools = useRef<RowTools>(NO_TOOLS);
  const columns = useMemo(() => buildColumns(tools), []);
  const rows = useMemo<PersonRow[]>(() => (data ? [...(data.owner ? [{ id: 'owner', person: data.owner, member: null }] : []), ...data.members.map((m) => ({ id: m.memberId, person: m as PersonView, member: m }))] : []), [data]);

  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Loading />;
  // Managers who aren't the owner can hand out only what they hold, and can't touch other managers.
  const unavailable = data.isOwner ? [] : PERMISSIONS.filter((p) => !data.permissions.includes(p));

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return setAddError('Enter the email of an existing account');
    setAdding(true);
    try {
      await api<MembersResponse>(url, { method: 'POST', body: { email, permissions: newPermissions.filter((p) => !unavailable.includes(p)) } });
      toast(`Added ${email.trim()}`);
      setEmail('');
      setAddError(null);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setAdding(false);
    }
  }

  const saveEdit = action(async () => {
    if (!editing) return;
    await api<MembersResponse>(url, { method: 'PATCH', body: editing });
    setEditing(null);
    toast('Permissions saved');
  });

  const remove = (member: MemberView) => action(async () => {
    const mine = member.id === user.id;
    const ok = await openDialog({
      title: mine ? `Leave "${projectName}"?` : `Remove ${member.name}?`,
      message: mine ? 'You lose access to this project, its issues and its chat. The owner can add you again.' : `${member.name} loses access to this project, its issues and its chat.`,
      confirmText: mine ? 'Leave project' : 'Remove',
      danger: true,
      onConfirm: () => api(`${url}&memberId=${member.memberId}`, { method: 'DELETE' }),
    });
    if (!ok) return;
    toast(mine ? 'You left the project' : `Removed ${member.name}`);
    if (mine) router.push('/projects');
  });

  const editingMember = editing ? data.members.find((m) => m.memberId === editing.memberId) ?? null : null;
  tools.current = {
    userId: user.id,
    canManage: data.canManage,
    isOwner: data.isOwner,
    editingId: editing ? editing.memberId : null,
    edit: (m) => setEditing(editing?.memberId === m.memberId ? null : { memberId: m.memberId, permissions: m.permissions }),
    remove,
  };

  return (
    <div className="grid gap-4">
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        title={<span className="inline-flex items-center gap-2">People with access<Badge tone="muted">{rows.length}</Badge></span>}
        initialSort={{ id: 'person' }}
        minWidth={560}
        empty={`Nobody else has access yet.${data.canManage ? ' Add a teammate below.' : ''}`}
      />

      {editingMember && editing ? (
        <section className={cn(CARD, 'p-5 md:p-6')}>
          <h3 className="m-0 mb-1 text-sm font-semibold">Permissions for {editingMember.name}</h3>
          <p className="mt-0 mb-4 text-[13px] text-muted">{editingMember.email}</p>
          <div className="grid gap-3">
            <PermissionPicker value={editing.permissions} onChange={(permissions) => setEditing({ ...editing, permissions })} unavailable={unavailable.filter((p) => !editingMember.permissions.includes(p))} />
            <div className="flex gap-2">
              <PillButton variant="primary" onClick={saveEdit}>Save permissions</PillButton>
              <PillButton variant="ghost" onClick={() => setEditing(null)}>Cancel</PillButton>
            </div>
          </div>
        </section>
      ) : null}

      {data.canManage ? (
        <section className={cn(CARD, 'p-5 md:p-6')}>
          <h3 className="m-0 text-sm font-semibold">Add a member</h3>
          <p className="mt-1 mb-4 text-[13px] text-muted">They need an account already. They get access at once, with the permissions you pick. Viewing issues is always included.</p>
          <form noValidate onSubmit={add} className="grid gap-4">
            <div>
              <input
                type="email"
                aria-label="Email of the person to add"
                placeholder="teammate@company.com"
                autoComplete="off"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setAddError(null); }}
                className="h-10 w-full max-w-md rounded-full border border-line-strong bg-panel px-4 text-[13px] placeholder:text-faint"
              />
              {addError ? <p className="mt-2 mb-0 text-[13px] text-danger" role="alert">{addError}</p> : null}
            </div>
            <PermissionPicker value={newPermissions.filter((p) => !unavailable.includes(p))} onChange={setNewPermissions} unavailable={unavailable} />
            <div><button type="submit" disabled={adding} className={pillButton('primary')}>{adding ? 'Adding…' : 'Add member'}</button></div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
