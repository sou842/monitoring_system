import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/dashboard/Shell';
import { currentUser } from '@/server/session.ts';
import { userView } from '@/server/users.ts';

/** Every logged-in page: checks the session, then renders the sidebar shell. */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) {
    // Set by middleware.ts: come back to this page after logging in.
    const url = (await headers()).get('x-url');
    redirect(url ? `/login?next=${encodeURIComponent(url)}` : '/login');
  }
  return <Shell user={userView(user)}>{children}</Shell>;
}
