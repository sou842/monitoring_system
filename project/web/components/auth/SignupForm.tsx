'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, clearCache } from '@/lib/client/api';
import { firstName } from '@/lib/format';
import type { UserView } from '@/lib/types';
import { Button } from '../ui/bits';
import { EMAIL_PATTERN, Field, MIN_PASSWORD_LENGTH, newPasswordProblem, PasswordField, StrengthMeter } from '../ui/fields';
import { useToast } from '../ui/Toasts';
import { AuthLayout } from './AuthLayout';

type FieldName = 'name' | 'email' | 'password';

/** Which field a server error code belongs to. */
const FIELD_FOR_CODE: Record<string, FieldName> = { invalid_email: 'email', email_taken: 'email', invalid_name: 'name', weak_password: 'password' };

/** Sign-up form; `next` is where to go afterwards. */
export function SignupForm({ next }: { next: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<Record<FieldName, string>>({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  useEffect(() => refs.name.current?.focus(), [refs.name]);

  const set = (field: FieldName) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBanner(null);
    const problems: Partial<Record<FieldName, string>> = {};
    if (!values.name.trim()) problems.name = 'Enter your name';
    if (!EMAIL_PATTERN.test(values.email.trim())) problems.email = 'Enter a valid email address';
    const weak = newPasswordProblem(values.password, values.email);
    if (weak) problems.password = weak;
    setErrors(problems);
    const first = (['name', 'email', 'password'] as const).find((f) => problems[f]);
    if (first) return refs[first].current?.focus();

    setBusy(true);
    try {
      const { user } = await api<{ user: UserView }>('/api/auth?action=signup', { method: 'POST', body: values });
      toast(`Welcome, ${firstName(user)}! Your account is ready.`);
      clearCache();
      router.replace(next);
      router.refresh();
    } catch (error) {
      setBusy(false);
      const field = error instanceof ApiError ? FIELD_FOR_CODE[error.code] : undefined;
      const message = error instanceof Error ? error.message : 'Something went wrong';
      if (field) {
        setErrors((e) => ({ ...e, [field]: message }));
        refs[field].current?.focus();
      } else {
        setBanner(message);
      }
    }
  }

  return (
    <AuthLayout>
      <div>
        <h1>Create your account</h1>
        <p className="auth-sub">Start tracking errors in your apps. It only takes a minute.</p>
        <form className="auth-form" noValidate onSubmit={submit}>
          {banner ? <div className="notice error" role="alert">{banner}</div> : null}
          <Field ref={refs.name} label="Full name" name="name" autoComplete="name" maxLength={80} placeholder="Jane Doe" value={values.name} onValue={set('name')} error={errors.name} />
          <Field ref={refs.email} label="Work email" type="email" name="email" autoComplete="email" maxLength={254} placeholder="you@company.com" value={values.email} onValue={set('email')} error={errors.email} />
          <PasswordField
            ref={refs.password}
            label="Password"
            name="new-password"
            autoComplete="new-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters. A longer passphrase is stronger.`}
            value={values.password}
            onValue={set('password')}
            error={errors.password}
            after={<StrengthMeter password={values.password} />}
          />
          <Button className="primary block" type="submit" busy={busy}>Create account</Button>
        </form>
        <p className="auth-switch">Already have an account? <Link href={next === '/dashboard' ? '/login' : `/login?next=${encodeURIComponent(next)}`}>Log in</Link></p>
      </div>
    </AuthLayout>
  );
}
