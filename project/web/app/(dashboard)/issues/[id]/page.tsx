import type { Metadata } from 'next';
import { IssueView } from '@/components/dashboard/views/IssueView';

export const metadata: Metadata = { title: 'Issue' };

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IssueView issueId={id} />;
}
