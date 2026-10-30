export { POST } from '@/server/routes/ai.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Long answers with tool calls can take a while; Vercel's default limit is shorter. */
export const maxDuration = 300;
