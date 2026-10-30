import { ownedEvent } from '../access.ts';
import { requireUser } from '../auth.ts';
import { errorResponse, handle, json, parseObjectId } from '../http.ts';
import { eventView } from '../views.ts';

/** GET /api/event?id=… — one event in full (stack trace, breadcrumbs, device…), if it is in one of your projects. */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid event id');

  const event = await ownedEvent(auth.db, auth.user, id);
  if (event === null) return errorResponse(404, 'not_found', 'Event not found');
  return json({ event: eventView(event) });
});
