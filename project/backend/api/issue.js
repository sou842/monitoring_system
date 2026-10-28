import { ownedIssue } from '../lib/access.js';
import { requireUser } from '../lib/auth.js';
import { ISSUE_RECENT_EVENTS, ISSUE_STATUSES } from '../lib/constants.js';
import { deleteIssues } from '../lib/deletion.js';
import { errorResponse, handle, json, parseObjectId, readJson } from '../lib/http.js';
import { insightSettingsView } from '../lib/insights.js';
import { eventSummaryView, eventView, issueView } from '../lib/views.js';

const MAX_BODY_BYTES = 1024;

/** Logged-in user plus the issue from `?id=`, when it is in one of their projects. */
async function loadIssue(request) {
  const auth = await requireUser(request);
  if (auth.response) return auth;
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return { response: errorResponse(400, 'invalid_id', 'Missing or invalid issue id') };
  const issue = await ownedIssue(auth.db, auth.user, id);
  if (issue === null) return { response: errorResponse(404, 'not_found', 'Issue not found') };
  return { db: auth.db, issue };
}

/**
 * GET /api/issue?id=… — the issue, its latest events (summaries), the newest
 * event in full, and the project's insight settings for the summary on top.
 */
export const GET = handle(async (request) => {
  const loaded = await loadIssue(request);
  if (loaded.response) return loaded.response;
  const { db, issue } = loaded;
  const [events, project] = await Promise.all([
    db.collection('events').find({ issueId: issue._id }).sort({ receivedAt: -1 }).limit(ISSUE_RECENT_EVENTS).toArray(),
    db.collection('projects').findOne({ _id: issue.projectId }, { projection: { name: 1, insights: 1 } }),
  ]);

  return json({
    issue: issueView(issue),
    project: project ? { id: String(project._id), name: project.name, insights: insightSettingsView(project.insights) } : null,
    events: events.map(eventSummaryView),
    latestEvent: events.length > 0 ? eventView(events[0]) : null,
  });
});

/** PATCH /api/issue?id=… `{ status: "open" | "resolved" | "ignored" }` */
export const PATCH = handle(async (request) => {
  const loaded = await loadIssue(request);
  if (loaded.response) return loaded.response;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const status = body.value && body.value.status;
  if (!ISSUE_STATUSES.includes(status)) return errorResponse(400, 'invalid_status', `status must be one of ${ISSUE_STATUSES.join(', ')}`);

  const issue = await loaded.db.collection('issues').findOneAndUpdate(
    { _id: loaded.issue._id },
    { $set: { status, statusChangedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (issue === null) return errorResponse(404, 'not_found', 'Issue not found');
  return json({ issue: issueView(issue) });
});

/** DELETE /api/issue?id=… — removes the issue and all of its events. */
export const DELETE = handle(async (request) => {
  const loaded = await loadIssue(request);
  if (loaded.response) return loaded.response;
  const removed = await deleteIssues(loaded.db, { _id: loaded.issue._id, projectId: loaded.issue.projectId });
  if (removed.issues === 0) return errorResponse(404, 'not_found', 'Issue not found');
  return json({ deleted: removed });
});
