import { requireSession } from '../lib/auth.js';
import { getDb } from '../lib/db.js';
import { errorResponse, handle, json, parseObjectId } from '../lib/http.js';
import { eventView } from '../lib/views.js';

/** GET /api/event?id=… — one event in full (stack trace, breadcrumbs, screenshot, device…). */
export const GET = handle(async (request) => {
  const denied = requireSession(request);
  if (denied) return denied;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid event id');

  const db = await getDb();
  const event = await db.collection('events').findOne({ _id: id });
  if (event === null) return errorResponse(404, 'not_found', 'Event not found');
  return json({ event: eventView(event) });
});
