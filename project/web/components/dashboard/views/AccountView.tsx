'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, clearCache, useApi } from '@/lib/client/api';
import type { AccountResponse, UserProfile, UserView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, Button, ErrorNotice, Loading, SettingsCard } from '../../ui/bits';
import { Badge, CARD, PageTitle, pillButton, PillButton } from '../../ui/kit';
import { useDialog } from '../../ui/Dialog';
import { Field, MIN_PASSWORD_LENGTH, newPasswordProblem, PasswordField, StrengthMeter } from '../../ui/fields';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { useSession } from '../Shell';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong');

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}

function ProfileForm({ user }: { user: UserView }) {
  const { setUser } = useSession();
  const { toast } = useToast();
  const [name, setName] = useState(user.name);
  const [details, setDetails] = useState<UserProfile>(user.profile);
  const [error, setError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const zones = useMemo(timeZones, []);
  const dirty = name !== user.name || PROFILE_KEYS.some((key) => details[key] !== user.profile[key]);
  const setDetail = (key: keyof UserProfile) => (value: string) => {
    setDetails((d) => ({ ...d, [key]: value }));
    setProfileError(null);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter your name');
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ user: UserView }>('/api/account', { method: 'PATCH', body: { name, ...details } });
      setUser(res.user);
      setName(res.user.name);
      setDetails(res.user.profile);
      toast('Profile saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_name') setError(e.message);
      else if (e instanceof ApiError && e.code === 'invalid_profile') setProfileError(e.message);
      else toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field ref={nameRef} label="Full name" autoComplete="name" maxLength={80} value={name} onValue={(v) => { setName(v); setError(null); }} error={error} />
        <Field label="Email" type="email" readOnly value={user.email} onValue={() => {}} hint="Your login. It can't be changed." />
        <Field label="Job title" autoComplete="organization-title" maxLength={MAX_PROFILE.jobTitle} placeholder="e.g. Frontend developer" value={details.jobTitle} onValue={setDetail('jobTitle')} />
        <Field label="Company" autoComplete="organization" maxLength={MAX_PROFILE.company} value={details.company} onValue={setDetail('company')} />
        <Field label="Phone" type="tel" autoComplete="tel" maxLength={MAX_PROFILE.phone} placeholder="+91 98765 43210" value={details.phone} onValue={setDetail('phone')} />
        <Field label="Location" autoComplete="address-level2" maxLength={MAX_PROFILE.location} placeholder="City, country" value={details.location} onValue={setDetail('location')} />
        <div className="field sm:col-span-2">
          <label className="field-label" htmlFor="profile-timezone">Time zone</label>
          <select id="profile-timezone" value={details.timezone} onChange={(e) => setDetail('timezone')(e.target.value)}>
            <option value="">Not set</option>
            {details.timezone && !zones.includes(details.timezone) ? <option value={details.timezone}>{details.timezone}</option> : null}
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </div>
        <div className="field sm:col-span-2">
          <label className="field-label" htmlFor="profile-bio">About you</label>
          <textarea
            id="profile-bio"
            rows={3}
            maxLength={MAX_PROFILE.bio}
            value={details.bio}
            onChange={(e) => setDetail('bio')(e.target.value)}
            placeholder="A line or two your teammates will see."
            className="w-full resize-y rounded-xl border border-line-strong bg-panel px-3 py-2 text-[13px]"
          />
          <p className="field-hint text-right">{details.bio.length} / {MAX_PROFILE.bio}</p>
        </div>
        <Field label="LinkedIn" type="url" maxLength={MAX_PROFILE.linkedin} placeholder="linkedin.com/in/your-name" value={details.linkedin} onValue={setDetail('linkedin')} />
        <Field label="GitHub" type="url" maxLength={MAX_PROFILE.github} placeholder="github.com/your-username" value={details.github} onValue={setDetail('github')} />
        <div className="sm:col-span-2">
          <Field label="Website" type="url" maxLength={MAX_PROFILE.website} placeholder="yoursite.com" value={details.website} onValue={setDetail('website')} />
        </div>
      </div>
      {profileError ? <p className="field-error" role="alert">{profileError}</p> : null}
      <div className="flex items-center justify-end gap-2">
        {dirty ? <PillButton variant="ghost" onClick={() => { setName(user.name); setDetails(user.profile); setError(null); setProfileError(null); }}>Discard</PillButton> : null}
        <Button className={pillButton('primary')} type="submit" busy={busy} disabled={!dirty}>Save changes</Button>
      </div>
    </form>
  );
}

const PROFILE_KEYS = ['jobTitle', 'company', 'phone', 'location', 'timezone', 'bio', 'linkedin', 'github', 'website'] as const;
/** Same limits as the server (`MAX_PROFILE_FIELD_LENGTH`); the server is what enforces them. */
const MAX_PROFILE = { jobTitle: 80, company: 80, phone: 30, location: 80, bio: 300, linkedin: 200, github: 200, website: 200 };

/** IANA zone names the browser knows, or an empty list on browsers without `Intl.supportedValuesOf`. */
function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
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
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <PasswordField ref={refs.current} label="Current password" autoComplete="current-password" value={values.current} onValue={set('current')} error={errors.current} />
      <PasswordField ref={refs.next} label="New password" autoComplete="new-password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        value={values.next} onValue={set('next')} error={errors.next} after={<StrengthMeter password={values.next} />} />
      <PasswordField ref={refs.repeat} label="Confirm new password" autoComplete="new-password" value={values.repeat} onValue={set('repeat')} error={errors.repeat} />
      <div className="flex justify-end"><Button className={pillButton('primary')} type="submit" busy={busy}>Update password</Button></div>
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
          <PageTitle title="Account" sub="Manage your profile, password and sessions." />
          <div className={cn(CARD, 'mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 p-4 md:p-5')}>
            <Avatar name={data.user.name} size="lg" />
            <div className="min-w-0 flex-1 basis-56">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="m-0 truncate text-base font-semibold">{data.user.name}</h2>
                {data.user.role === 'admin' ? <Badge tone="dark">Admin</Badge> : null}
              </div>
              <p className="m-0 mt-0.5 truncate text-[13px] text-muted">
                {[data.user.profile.jobTitle, data.user.profile.company].filter(Boolean).join(' at ') || data.user.email}
              </p>
              {data.user.profile.bio ? <p className="m-0 mt-1.5 max-w-prose text-[13px] whitespace-pre-line text-fg-2">{data.user.profile.bio}</p> : null}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                {([['LinkedIn', data.user.profile.linkedin], ['GitHub', data.user.profile.github], ['Website', data.user.profile.website]] as const)
                  .filter(([, url]) => url)
                  .map(([label, url]) => (
                    <a key={label} href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-fg underline underline-offset-2">{label}</a>
                  ))}
              </div>
            </div>
            <dl className="m-0 flex gap-6 text-[13px] max-sm:w-full">
              <Stat label={data.usage.projectLimit === null ? 'Projects' : 'Projects used'} value={data.usage.projectLimit === null ? String(data.usage.projects) : `${data.usage.projects} / ${data.usage.projectLimit}`} />
              <Stat label="Member since" value={new Date(data.user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} />
            </dl>
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <SettingsCard title="Profile" description="Details your teammates can see. Everything except your name is optional.">
              <ProfileForm user={data.user} />
            </SettingsCard>
            <div className="grid min-w-0 gap-4">
              <SettingsCard title="Password" description="Changing your password logs you out on every other device.">
                <PasswordForm email={data.user.email} />
              </SettingsCard>
              <SettingsCard title="Sessions" description="Signed in on a shared or lost device? End those sessions here.">
                <div><PillButton onClick={logoutOthers}>Log out other devices</PillButton></div>
              </SettingsCard>
              <SettingsCard title="Delete account" description="Permanently remove your account, your projects and all of their data.">
                <div><PillButton variant="danger" onClick={deleteAccount}>Delete account</PillButton></div>
              </SettingsCard>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
