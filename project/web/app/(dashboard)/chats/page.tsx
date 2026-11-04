import type { Metadata } from 'next';
import { ChatView } from '@/components/dashboard/views/ChatView';

export const metadata: Metadata = { title: 'Chats' };

export default function ChatsPage() {
  return <ChatView />;
}
