import type { Db } from 'mongodb';
import { ISSUE_STATUSES, type IssueStatus } from '../../lib/schema.ts';
import { ownedIssue } from '../access.ts';
import { requireUser } from '../auth.ts';
import { ISSUE_RECENT_EVENTS } from '../constants.ts';
import { collections } from '../db.ts';
import { deleteIssues } from '../deletion.ts';
import { bodyObject, errorResponse, handle, json, parseObjectId, readJson } from '../http.ts';
import { insightSettingsView } from '../insights.ts';
import type { IssueDoc } from '../models.ts';
import { eventSummaryView, eventView, issueView } from '../views.ts';

const MAX_BODY_BYTES = 1024;

/** Logged-in user plus the issue from `?id=`, when it is in one of their projects. */
async function loadIssue(request: Request): Promise<{ response: Response } | { response?: undefined; db: Db; issue: IssueDoc }> {
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
  const c = collections(db);
  const [events, project] = await Promise.all([
    c.events.find({ issueId: issue._id }).sort({ receivedAt: -1 }).limit(ISSUE_RECENT_EVENTS).toArray(),
    c.projects.findOne({ _id: issue.projectId }, { projection: { name: 1, insights: 1 } }),
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
  const status = bodyObject(body.value).status;
  if (!(ISSUE_STATUSES as readonly unknown[]).includes(status)) return errorResponse(400, 'invalid_status', `status must be one of ${ISSUE_STATUSES.join(', ')}`);

  const issue = await collections(loaded.db).issues.findOneAndUpdate(
    { _id: loaded.issue._id },
    { $set: { status: status as IssueStatus, statusChangedAt: new Date() } },
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
