import { ownedProject, ownedProjectIds } from '../lib/access.js';
import { requireUser } from '../lib/auth.js';
import { DEFAULT_STATS_RANGE, STATS_RANGES } from '../lib/constants.js';
import { errorResponse, handle, json, parseObjectId } from '../lib/http.js';
import { computeStats } from '../lib/stats.js';

/**
 * GET /api/stats?range=24h|7d  &projectId=…  (optional: all of your projects when omitted)
 * Aggregated numbers for the dashboard overview.
 */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;

  const params = new URL(request.url).searchParams;
  const range = params.get('range') || DEFAULT_STATS_RANGE;
  if (!(range in STATS_RANGES)) return errorResponse(400, 'invalid_range', 'Unknown range');
  let projectIds;
  if (params.get('projectId')) {
    const projectId = parseObjectId(params.get('projectId'));
    if (projectId === null) return errorResponse(400, 'invalid_project', 'Invalid projectId');
    if ((await ownedProject(db, user, projectId)) === null) return errorResponse(404, 'not_found', 'Project not found');
    projectIds = [projectId];
  } else {
    projectIds = await ownedProjectIds(db, user);
  }
  return json(await computeStats(db, { projectIds, range }));
});
