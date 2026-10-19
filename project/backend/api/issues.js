import { ownedProject } from '../lib/access.js';
import { requireUser } from '../lib/auth.js';
import { EVENT_TYPES, ISSUES_PAGE_SIZE, ISSUE_STATUSES } from '../lib/constants.js';
import { deleteIssues } from '../lib/deletion.js';
import { errorResponse, handle, json, parseObjectId, readJson } from '../lib/http.js';
import { issueView } from '../lib/views.js';

const SORTS = { lastSeen: { lastSeen: -1 }, count: { count: -1, lastSeen: -1 }, firstSeen: { firstSeen: -1 } };
const MAX_SEARCH_LENGTH = 200;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/issues?projectId=…  (required)
 *   &status=open|resolved|ignored|all   (default open)
 *   &type=error|message|performance|crash
 *   &env=production   &q=search text   &sort=lastSeen|count|firstSeen   &page=1
 *
 * Returns the page of issues plus per-status counts and the project's environments for filters.
 */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;

  const params = new URL(request.url).searchParams;
  const projectId = parseObjectId(params.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  const { db } = auth;
  if ((await ownedProject(db, auth.user, projectId)) === null) return errorResponse(404, 'not_found', 'Project not found');

  const status = params.get('status') || 'open';
  const filter = { projectId };
  if (status !== 'all') {
    if (!ISSUE_STATUSES.includes(status)) return errorResponse(400, 'invalid_status', 'Unknown status');
    filter.status = status;
  }
  const type = params.get('type');
  if (type && EVENT_TYPES.includes(type)) filter.eventType = type;
  const env = params.get('env');
  if (env) filter.environments = env;
  const q = (params.get('q') || '').trim().slice(0, MAX_SEARCH_LENGTH);
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ message: pattern }, { errorType: pattern }, { culprit: pattern }];
  }
  const sort = SORTS[params.get('sort')] || SORTS.lastSeen;
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);

  const issues = db.collection('issues');
  const [rows, total, statusCounts, environments] = await Promise.all([
    issues.find(filter).sort(sort).skip((page - 1) * ISSUES_PAGE_SIZE).limit(ISSUES_PAGE_SIZE).toArray(),
    issues.countDocuments(filter),
    issues.aggregate([{ $match: { projectId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    issues.distinct('environments', { projectId }),
  ]);

  const counts = Object.fromEntries(ISSUE_STATUSES.map((s) => [s, 0]));
  for (const row of statusCounts) counts[row._id] = row.n;

  return json({ issues: rows.map(issueView), total, page, pageSize: ISSUES_PAGE_SIZE, counts, environments: environments.sort() });
});

const MAX_DELETE_IDS = 500;

/**
 * DELETE /api/issues?projectId=…  with either
 *   body { ids: [...] }       → deletes those issues (of this project), or
 *   &status=open|resolved|ignored|all → deletes every issue with that status ("clear all").
 * Events go with their issues. Returns the number of issues and events removed.
 */
export const DELETE = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db } = auth;
  const params = new URL(request.url).searchParams;
  const projectId = parseObjectId(params.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  if ((await ownedProject(db, auth.user, projectId)) === null) return errorResponse(404, 'not_found', 'Project not found');

  const text = await request.text();
  if (text.length > 0) {
    const body = await readJson(new Request(request.url, { method: 'POST', body: text }), MAX_DELETE_IDS * 40);
    if (!body.ok) return body.response;
    const raw = body.value && body.value.ids;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DELETE_IDS) {
      return errorResponse(400, 'invalid_ids', `ids must be a list of 1 to ${MAX_DELETE_IDS} issue ids`);
    }
    const ids = raw.map(parseObjectId);
    if (ids.includes(null)) return errorResponse(400, 'invalid_ids', 'ids contains an invalid issue id');
    return json({ deleted: await deleteIssues(db, { projectId, _id: { $in: ids } }) });
  }

  const status = params.get('status');
  if (status !== 'all' && !ISSUE_STATUSES.includes(status)) {
    return errorResponse(400, 'invalid_status', 'Pass ids in the body, or status=open|resolved|ignored|all');
  }
  const filter = status === 'all' ? { projectId } : { projectId, status };
  return json({ deleted: await deleteIssues(db, filter) });
});
