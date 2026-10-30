import type { Metadata } from 'next';
import { PerformanceView } from '@/components/dashboard/views/PerformanceView';

export const metadata: Metadata = { title: 'Performance' };

export default function PerformancePage() {
  return <PerformanceView />;
}
