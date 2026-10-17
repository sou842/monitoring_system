/**
 * Local stand-in for the real ingestion backend: prints SDK events to the
 * terminal running `npm run dev`.
 */
export async function POST(request) {
  const apiKey = request.headers.get('x-api-key');
  const { events = [] } = await request.json();
  console.log(`\n[events] ${events.length} event(s), api key: ${apiKey}`);
  for (const e of events) {
    console.log(`  ${e.event_type} | ${e.error?.type}: ${e.error?.message} | screenshot: ${e.screenshot ? 'yes' : 'no'} | breadcrumbs: ${e.breadcrumbs.length}`);
  }
  return new Response(null, { status: 202 });
}
