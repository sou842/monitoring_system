'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, clearCache } from '@/lib/client/api';
import type { UserView } from '@/lib/types';
import { Button } from '../ui/bits';
import { EMAIL_PATTERN, Field, PasswordField } from '../ui/fields';
import { AuthLayout } from './AuthLayout';

/** Log-in form; `next` is where to go afterwards (already checked to be a page of this site). */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => emailRef.current?.focus(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBanner(null);
    const problems: typeof errors = {};
    if (!EMAIL_PATTERN.test(email.trim())) problems.email = 'Enter a valid email address';
    if (password === '') problems.password = 'Enter your password';
    setErrors(problems);
    if (problems.email) return emailRef.current?.focus();
    if (problems.password) return passwordRef.current?.focus();
    setBusy(true);
    try {
      await api<{ user: UserView }>('/api/auth?action=login', { method: 'POST', body: { email, password } });
      clearCache();
      router.replace(next);
      router.refresh();
    } catch (error) {
      setBusy(false);
      setBanner(error instanceof Error ? error.message : 'Something went wrong');
      if (error instanceof ApiError && error.code === 'invalid_credentials') passwordRef.current?.select();
    }
  }

  return (
    <AuthLayout>
      <div>
        <h1>Log in</h1>
        <p className="auth-sub">Welcome back. Enter your details to see your projects.</p>
        <form className="auth-form" noValidate onSubmit={submit}>
          {banner ? <div className="notice error" role="alert">{banner}</div> : null}
          <Field
            ref={emailRef}
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            maxLength={254}
            placeholder="you@company.com"
            value={email}
            onValue={(v) => { setEmail(v); setErrors((e) => ({ ...e, email: undefined })); }}
            error={errors.email}
          />
          <PasswordField
            ref={passwordRef}
            label="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onValue={(v) => { setPassword(v); setErrors((e) => ({ ...e, password: undefined })); }}
            error={errors.password}
          />
          <Button className="primary block" type="submit" busy={busy}>Log in</Button>
        </form>
        <p className="auth-switch">New to Error Tracker? <Link href={next === '/dashboard' ? '/signup' : `/signup?next=${encodeURIComponent(next)}`}>Create an account</Link></p>
      </div>
    </AuthLayout>
  );
}
