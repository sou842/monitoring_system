import { requireSession } from '../lib/auth.js';
import { ISSUE_RECENT_EVENTS, ISSUE_STATUSES } from '../lib/constants.js';
import { getDb } from '../lib/db.js';
import { errorResponse, handle, json, parseObjectId, readJson } from '../lib/http.js';
import { eventSummaryView, eventView, issueView } from '../lib/views.js';

const MAX_BODY_BYTES = 1024;

/** GET /api/issue?id=… — the issue, its latest events (summaries) and the newest event in full. */
export const GET = handle(async (request) => {
  const denied = requireSession(request);
  if (denied) return denied;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid issue id');

  const db = await getDb();
  const issue = await db.collection('issues').findOne({ _id: id });
  if (issue === null) return errorResponse(404, 'not_found', 'Issue not found');
  const events = await db.collection('events').find({ issueId: id }).sort({ receivedAt: -1 }).limit(ISSUE_RECENT_EVENTS).toArray();
  const project = await db.collection('projects').findOne({ _id: issue.projectId }, { projection: { name: 1 } });

  return json({
    issue: issueView(issue),
    project: project ? { id: String(project._id), name: project.name } : null,
    events: events.map(eventSummaryView),
    latestEvent: events.length > 0 ? eventView(events[0]) : null,
  });
});

/** PATCH /api/issue?id=… `{ status: "open" | "resolved" | "ignored" }` */
export const PATCH = handle(async (request) => {
  const denied = requireSession(request);
  if (denied) return denied;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return errorResponse(400, 'invalid_id', 'Missing or invalid issue id');
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const status = body.value && body.value.status;
  if (!ISSUE_STATUSES.includes(status)) return errorResponse(400, 'invalid_status', `status must be one of ${ISSUE_STATUSES.join(', ')}`);

  const db = await getDb();
  const issue = await db.collection('issues').findOneAndUpdate(
    { _id: id },
    { $set: { status, statusChangedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (issue === null) return errorResponse(404, 'not_found', 'Issue not found');
  return json({ issue: issueView(issue) });
});
