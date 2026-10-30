'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, clearCache, useApi } from '@/lib/client/api';
import type { AccountResponse, UserView } from '@/lib/types';
import { Avatar, Button, ErrorNotice, Loading, SettingsCard } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { Field, MIN_PASSWORD_LENGTH, newPasswordProblem, PasswordField, StrengthMeter } from '../../ui/fields';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { useSession } from '../Shell';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong');

function ProfileForm({ user }: { user: UserView }) {
  const { setUser } = useSession();
  const { toast } = useToast();
  const [name, setName] = useState(user.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter your name');
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ user: UserView }>('/api/account', { method: 'PATCH', body: { name } });
      setUser(res.user);
      setName(res.user.name);
      toast('Profile saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_name') setError(e.message);
      else toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" noValidate onSubmit={submit}>
      <Field ref={nameRef} label="Name" autoComplete="name" maxLength={80} value={name} onValue={(v) => { setName(v); setError(null); }} error={error} />
      <Field label="Email" type="email" readOnly value={user.email} onValue={() => {}} hint="Your email is your login and cannot be changed." />
      <div className="form-actions"><Button className="primary" type="submit" busy={busy}>Save changes</Button></div>
    </form>
  );
}

type PasswordFieldName = 'current' | 'next' | 'repeat';

function PasswordForm({ email }: { email: string }) {
  const { toast } = useToast();
  const [values, setValues] = useState<Record<PasswordFieldName, string>>({ current: '', next: '', repeat: '' });
  const [errors, setErrors] = useState<Partial<Record<PasswordFieldName, string>>>({});
  const [busy, setBusy] = useState(false);
  const refs = { current: useRef<HTMLInputElement>(null), next: useRef<HTMLInputElement>(null), repeat: useRef<HTMLInputElement>(null) };
  const set = (field: PasswordFieldName) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems: Partial<Record<PasswordFieldName, string>> = {};
    if (!values.current) problems.current = 'Enter your current password';
    const weak = newPasswordProblem(values.next, email);
    if (weak) problems.next = weak;
    if (values.repeat !== values.next) problems.repeat = 'Passwords do not match';
    setErrors(problems);
    const first = (['current', 'next', 'repeat'] as const).find((f) => problems[f]);
    if (first) return refs[first].current?.focus();
    setBusy(true);
    try {
      await api('/api/account', { method: 'PATCH', body: { currentPassword: values.current, newPassword: values.next } });
      setValues({ current: '', next: '', repeat: '' });
      toast('Password updated. Other devices were logged out.');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'wrong_password') setErrors({ current: e.message });
      else if (e instanceof ApiError && e.code === 'weak_password') setErrors({ next: e.message });
      else toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" noValidate onSubmit={submit}>
      <PasswordField ref={refs.current} label="Current password" autoComplete="current-password" value={values.current} onValue={set('current')} error={errors.current} />
      <PasswordField ref={refs.next} label="New password" autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        value={values.next} onValue={set('next')} error={errors.next} after={<StrengthMeter password={values.next} />} />
      <PasswordField ref={refs.repeat} label="Confirm new password" autoComplete="new-password" value={values.repeat} onValue={set('repeat')} error={errors.repeat} />
      <div className="form-actions"><Button className="primary" type="submit" busy={busy}>Update password</Button></div>
    </form>
  );
}

/** Profile, password, sessions and account deletion. */
export function AccountView() {
  const router = useRouter();
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const { setUser } = useSession();
  const { data, error } = useApi<AccountResponse>('/api/account');

  useEffect(() => {
    if (data) setUser(data.user);
  }, [data, setUser]);

  const logoutOthers = action(async () => {
    const ok = await openDialog({
      title: 'Log out other devices?',
      message: 'Every other browser where you are logged in will be signed out. You stay logged in here.',
      confirmText: 'Log out others',
      onConfirm: () => api('/api/account?action=logout-others', { method: 'POST' }),
    });
    if (ok) toast('Other devices were logged out');
  });

  const deleteAccount = action(async () => {
    if (!data) return;
    const done = await openDialog({
      title: 'Delete your account?',
      message: `This permanently deletes your account and ${data.usage.projects} project(s) with all their issues and events. Apps using your API keys will stop reporting. This can't be undone.`,
      confirmText: 'Delete my account',
      danger: true,
      input: { label: 'Enter your password to confirm', type: 'password', autocomplete: 'current-password' },
      onConfirm: (password) => api('/api/account', { method: 'DELETE', body: { password }, endsSession: true }),
    });
    if (done === null) return;
    clearCache();
    toast('Your account was deleted');
    router.replace('/signup');
    router.refresh();
  });

  return (
    <Page crumbs={[{ label: 'Account' }]}>
      {error ? <ErrorNotice error={error} /> : !data ? <Loading /> : (
        <>
          <div className="page-head"><h1>Account</h1></div>
          <p className="page-sub">Manage your profile, password and sessions.</p>
          <div className="settings">
            <SettingsCard title="Profile">
              <div className="profile-row">
                <Avatar name={data.user.name} size="lg" />
                <div>
                  <b>{data.user.name}</b>
                  <div className="muted small">
                    {`${data.user.role === 'admin' ? 'Admin · ' : ''}Member since ${new Date(data.user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`}
                  </div>
                </div>
                <span className="spacer" />
                <div className="usage">
                  <b>{data.usage.projectLimit === null ? String(data.usage.projects) : `${data.usage.projects} / ${data.usage.projectLimit}`}</b>
                  <span className="muted small">{data.usage.projectLimit === null ? 'projects' : 'projects used'}</span>
                </div>
              </div>
              <ProfileForm user={data.user} />
            </SettingsCard>
            <SettingsCard title="Password" description="Changing your password logs you out on every other device.">
              <PasswordForm email={data.user.email} />
            </SettingsCard>
            <SettingsCard title="Sessions" description="Signed in on a shared or lost device? End those sessions here.">
              <div className="row"><button type="button" onClick={logoutOthers}>Log out other devices</button></div>
            </SettingsCard>
            <SettingsCard title="Delete account" description="Permanently remove your account, your projects and all of their data." className="danger-zone">
              <div className="row"><button type="button" className="danger solid" onClick={deleteAccount}>Delete account</button></div>
            </SettingsCard>
          </div>
        </>
      )}
    </Page>
  );
}
