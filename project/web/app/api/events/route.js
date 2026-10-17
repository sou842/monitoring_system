/**
 * Local stand-in for the real ingestion backend.
 * POST: prints SDK events to the terminal running `npm run dev`, and keeps
 *       server-side events in memory so the Issues page can show them.
 * GET / DELETE: list / clear the stored server-side events.
 */
export const dynamic = 'force-dynamic';

const MAX_SERVER_EVENTS = 30;
// Kept on globalThis so it survives hot reloads in dev.
const serverEvents = (globalThis.__serverEvents ??= []);

export async function POST(request) {
  const apiKey = request.headers.get('x-api-key');
  const { events = [] } = await request.json();
  console.log(`\n[events] ${events.length} event(s), api key: ${apiKey}`);
  for (const e of events) {
    console.log(`  ${e.event_type} | ${e.error?.type}: ${e.error?.message} | screenshot: ${e.screenshot ? 'yes' : 'no'} | breadcrumbs: ${e.breadcrumbs.length}`);
    if (e.context?.source === 'server') serverEvents.unshift(e);
  }
  serverEvents.splice(MAX_SERVER_EVENTS);
  return new Response(null, { status: 202 });
}

export function GET() {
  return Response.json({ events: serverEvents });
}

export function DELETE() {
  serverEvents.length = 0;
  return new Response(null, { status: 204 });
}
