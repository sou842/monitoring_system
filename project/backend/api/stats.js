import { requireSession } from '../lib/auth.js';
import { DEFAULT_STATS_RANGE, STATS_RANGES } from '../lib/constants.js';
import { getDb } from '../lib/db.js';
import { errorResponse, handle, json, parseObjectId } from '../lib/http.js';
import { computeStats } from '../lib/stats.js';

/**
 * GET /api/stats?range=24h|7d  &projectId=…  (optional: all projects when omitted)
 * Aggregated numbers for the dashboard overview.
 */
export const GET = handle(async (request) => {
  const denied = requireSession(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const range = params.get('range') || DEFAULT_STATS_RANGE;
  if (!(range in STATS_RANGES)) return errorResponse(400, 'invalid_range', 'Unknown range');
  let projectId = null;
  if (params.get('projectId')) {
    projectId = parseObjectId(params.get('projectId'));
    if (projectId === null) return errorResponse(400, 'invalid_project', 'Invalid projectId');
  }
  return json(await computeStats(await getDb(), { projectId, range }));
});
