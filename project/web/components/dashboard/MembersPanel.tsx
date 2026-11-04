'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { DEFAULT_MEMBER_PERMISSIONS, PERMISSIONS, PERMISSION_INFO, type Permission } from '@/lib/permissions';
import { api, useApi } from '@/lib/client/api';
import type { MembersResponse, MemberView, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, ErrorNotice, Loading } from '../ui/bits';
import { useDialog } from '../ui/Dialog';
import { CARD, Pill, PillButton, pillButton } from '../ui/kit';
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
  if (permissions.length === 0) return <Pill tone="muted">View only</Pill>;
  return (
    <div className="flex flex-wrap gap-1">
      {permissions.map((p) => <Pill key={p} tone="neutral">{PERMISSION_INFO[p].label}</Pill>)}
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

  return (
    <div className="grid gap-4">
      <section className={cn(CARD, 'p-5 md:p-6')}>
        <div className="mb-4 flex items-center gap-2">
          <h3 className="m-0 text-sm font-semibold">People with access</h3>
          <Pill tone="muted">{data.members.length + 1}</Pill>
        </div>
        <div className="grid divide-y divide-line/70">
          {data.owner ? (
            <div className="py-3 first:pt-0">
              <Person person={data.owner} badge={<Pill tone="dark">Owner</Pill>}>
                <div className="mt-1 text-xs text-muted">Can do everything, including deleting the project</div>
              </Person>
            </div>
          ) : null}
          {data.members.length === 0 ? <p className="m-0 py-4 text-[13px] text-muted">Nobody else has access yet.{data.canManage ? ' Add a teammate below.' : ''}</p> : null}
          {data.members.map((m) => {
            const isEditing = editing?.memberId === m.memberId;
            const mine = m.id === user.id;
            return (
              <div key={m.memberId} className="py-3 last:pb-0">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Person person={m} badge={mine ? <Pill tone="muted">You</Pill> : undefined}>
                      <div className="mt-1.5"><PermissionChips permissions={m.permissions} /></div>
                    </Person>
                  </div>
                  <div className="flex gap-1.5">
                    {data.canManage && !mine && (data.isOwner || !m.permissions.includes('members.manage')) ? <PillButton className="h-8" onClick={() => setEditing(isEditing ? null : { memberId: m.memberId, permissions: m.permissions })}>{isEditing ? 'Cancel' : 'Edit'}</PillButton> : null}
                    {(mine || (data.canManage && (data.isOwner || !m.permissions.includes('members.manage')))) ? <PillButton variant="danger" className="h-8" onClick={remove(m)}>{mine ? 'Leave' : 'Remove'}</PillButton> : null}
                  </div>
                </div>
                {isEditing && editing ? (
                  <div className="mt-3 grid gap-3">
                    <PermissionPicker value={editing.permissions} onChange={(permissions) => setEditing({ ...editing, permissions })} unavailable={unavailable.filter((p) => !m.permissions.includes(p))} />
                    <div><PillButton variant="primary" onClick={saveEdit}>Save permissions</PillButton></div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

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
