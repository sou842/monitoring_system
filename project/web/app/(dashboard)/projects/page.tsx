import type { Metadata } from 'next';
import { ProjectsView } from '@/components/dashboard/views/ProjectsView';

export const metadata: Metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return <ProjectsView />;
}
