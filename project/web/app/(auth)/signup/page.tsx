import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SignupForm } from '@/components/auth/SignupForm';
import { safeNextPath } from '@/lib/next-path';
import { currentUser } from '@/server/session.ts';

export const metadata: Metadata = { title: 'Create an account' };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNextPath((await searchParams).next);
  // Already logged in: skip the form.
  if (await currentUser()) redirect(next);
  return <SignupForm next={next} />;
}
