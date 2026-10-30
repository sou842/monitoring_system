import type { ObjectId } from 'mongodb';
import { ownedProject, ownedProjectIds } from '../access.ts';
import { requireUser } from '../auth.ts';
import { DEFAULT_STATS_RANGE, MAX_STRING_LENGTH, STATS_RANGES, type StatsRange } from '../constants.ts';
import { errorResponse, handle, json, parseObjectId } from '../http.ts';
import { computeEndpointDetail, computePageDetail, computePerformance } from '../performanceStats.ts';
import { computeStats } from '../stats.ts';

/**
 * GET /api/stats?range=24h|7d  &projectId=…  (optional: all of your projects when omitted)
 * Aggregated numbers for the dashboard overview.
 *
 * GET /api/stats?view=performance&range=…&projectId=…&environment=…
 *   Web Vitals, request latency and the pages / endpoints tables.
 *   &endpoint=<key>  one endpoint over time, with its slowest calls
 *   &page=<route>    one page over time, with its slowest loads
 */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;

  const params = new URL(request.url).searchParams;
  const range = params.get('range') || DEFAULT_STATS_RANGE;
  if (!(range in STATS_RANGES)) return errorResponse(400, 'invalid_range', 'Unknown range');
  const statsRange = range as StatsRange;
  let projectIds: ObjectId[];
  if (params.get('projectId')) {
    const projectId = parseObjectId(params.get('projectId'));
    if (projectId === null) return errorResponse(400, 'invalid_project', 'Invalid projectId');
    if ((await ownedProject(db, user, projectId)) === null) return errorResponse(404, 'not_found', 'Project not found');
    projectIds = [projectId];
  } else {
    projectIds = await ownedProjectIds(db, user);
  }

  const view = params.get('view');
  if (view === null) return json(await computeStats(db, { projectIds, range: statsRange }));
  if (view !== 'performance') return errorResponse(400, 'invalid_view', 'Unknown view');

  const environment = textParam(params, 'environment');
  const endpoint = textParam(params, 'endpoint');
  const page = textParam(params, 'page');
  if (endpoint !== null) {
    const detail = await computeEndpointDetail(db, { projectIds, range: statsRange, key: endpoint, environment });
    return detail === null ? errorResponse(404, 'not_found', 'No data for this endpoint') : json(detail);
  }
  if (page !== null) {
    const detail = await computePageDetail(db, { projectIds, range: statsRange, page, environment });
    return detail === null ? errorResponse(404, 'not_found', 'No data for this page') : json(detail);
  }
  return json(await computePerformance(db, { projectIds, range: statsRange, environment }));
});

/** A short string query parameter, or null when missing or empty. */
function textParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value === null || value.length === 0 ? null : value.slice(0, MAX_STRING_LENGTH);
}
