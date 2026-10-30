import type { Metadata } from 'next';
import { DashboardView } from '@/components/dashboard/views/DashboardView';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return <DashboardView />;
}
