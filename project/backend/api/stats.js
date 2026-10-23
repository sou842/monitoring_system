import { ownedProject, ownedProjectIds } from '../lib/access.js';
import { requireUser } from '../lib/auth.js';
import { DEFAULT_STATS_RANGE, MAX_STRING_LENGTH, STATS_RANGES } from '../lib/constants.js';
import { errorResponse, handle, json, parseObjectId } from '../lib/http.js';
import { computePageDetail, computePerformance, computeEndpointDetail } from '../lib/performanceStats.js';
import { computeStats } from '../lib/stats.js';

/**
 * GET /api/stats?range=24h|7d  &projectId=…  (optional: all of your projects when omitted)
 * Aggregated numbers for the dashboard overview.
 *
 * GET /api/stats?view=performance&range=…&projectId=…&environment=…
 *   Web Vitals, request latency and the pages / endpoints tables.
 *   &endpoint=<key>  one endpoint over time, with its slowest calls
 *   &page=<route>    one page over time, with its slowest loads
 *
 * (One function for both, to stay within the Vercel Hobby limit of 12 functions.)
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

  const view = params.get('view');
  if (view === null) return json(await computeStats(db, { projectIds, range }));
  if (view !== 'performance') return errorResponse(400, 'invalid_view', 'Unknown view');

  const environment = textParam(params, 'environment');
  const endpoint = textParam(params, 'endpoint');
  const page = textParam(params, 'page');
  if (endpoint !== null) {
    const detail = await computeEndpointDetail(db, { projectIds, range, key: endpoint, environment });
    return detail === null ? errorResponse(404, 'not_found', 'No data for this endpoint') : json(detail);
  }
  if (page !== null) {
    const detail = await computePageDetail(db, { projectIds, range, page, environment });
    return detail === null ? errorResponse(404, 'not_found', 'No data for this page') : json(detail);
  }
  return json(await computePerformance(db, { projectIds, range, environment }));
});

/** A short string query parameter, or null when missing or empty. */
function textParam(params, name) {
  const value = params.get(name);
  return value === null || value.length === 0 ? null : value.slice(0, MAX_STRING_LENGTH);
}
