import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/LoginForm';
import { safeNextPath } from '@/lib/next-path';
import { currentUser } from '@/server/session.ts';

export const metadata: Metadata = { title: 'Log in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNextPath((await searchParams).next);
  // Already logged in: skip the form.
  if (await currentUser()) redirect(next);
  return <LoginForm next={next} />;
}
