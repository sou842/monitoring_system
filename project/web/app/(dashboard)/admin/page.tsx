import type { Metadata } from 'next';
import { AdminView } from '@/components/dashboard/views/AdminView';
import { currentUser } from '@/server/session.ts';

export const metadata: Metadata = { title: 'Admin' };

export default async function AdminPage() {
  // Read fresh on every visit, so a user promoted a moment ago sees the page at once.
  const user = await currentUser();
  return <AdminView isAdmin={user !== null && user.role === 'admin'} />;
}
