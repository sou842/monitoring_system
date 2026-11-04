import type { Metadata } from 'next';
import { AssistantView } from '@/components/dashboard/views/AssistantView';

export const metadata: Metadata = { title: 'Assistant' };

export default function AssistantPage() {
  return <AssistantView />;
}
