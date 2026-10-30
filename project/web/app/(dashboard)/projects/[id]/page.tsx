import type { Metadata } from 'next';
import { ProjectIssuesView } from '@/components/dashboard/views/ProjectIssuesView';

export const metadata: Metadata = { title: 'Issues' };

export default async function ProjectIssuesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectIssuesView projectId={id} />;
}
