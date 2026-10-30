// SDK ingestion: the URL every SDK posts to, unchanged since the backend moved into this app.
export { OPTIONS, POST } from '@/server/routes/events.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
