import { uploadScreenshot } from '../../lib/cloudinary.js';
import { API_KEY_HEADER, MAX_EVENTS_PER_REQUEST } from '../../lib/constants.js';
import { getDb } from '../../lib/db.js';
import { errorResponse, handle, json, readJson } from '../../lib/http.js';
import { ingestEvents } from '../../lib/ingest.js';
import { findProjectByApiKey } from '../../lib/projects.js';
import { consumeEventBudget, consumeTransactionBudget } from '../../lib/rateLimit.js';

/**
 * POST /api/v1/events — ingestion endpoint used by the SDKs.
 *
 * Headers: `X-API-Key: <project key>`, `Content-Type: application/json`
 * Body:    `{ "events": [ <shared-schema event>, ... ] }`
 *
 * 202 `{ accepted, rejected: [{ index, reason }] }` — valid events are stored
 *     even if others in the batch are rejected.
 * 400 bad body · 401 unknown key · 413 too large · 429 over the per-minute budget.
 *
 * Browser apps on any origin may call it (CORS), as the API key identifies the project.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

function withCors(response) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  return response;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export const POST = handle(async (request) => withCors(await ingest(request)));

async function ingest(request) {
  const apiKey = request.headers.get(API_KEY_HEADER);
  if (!apiKey) return errorResponse(401, 'missing_api_key', 'Send the project API key in the X-API-Key header');

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const events = body.value && body.value.events;
  if (!Array.isArray(events) || events.length === 0) {
    return errorResponse(400, 'invalid_body', 'Body must be { "events": [ ... ] } with at least one event');
  }
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return errorResponse(413, 'too_many_events', `At most ${MAX_EVENTS_PER_REQUEST} events per request`);
  }

  const db = await getDb();
  const project = await findProjectByApiKey(db, apiKey);
  if (project === null) return errorResponse(401, 'invalid_api_key', 'Unknown API key');
  if (project.disabled) return errorResponse(403, 'project_disabled', 'This project belongs to a disabled account');

  // Errors and page views have separate budgets, so heavy traffic can't crowd out errors.
  const pageViewCount = events.filter((event) => event && event.event_type === 'transaction').length;
  const otherCount = events.length - pageViewCount;
  if (otherCount > 0) {
    const budget = await consumeEventBudget(db, project._id, otherCount);
    if (!budget.allowed) {
      return errorResponse(429, 'rate_limited', 'Too many events this minute', { 'Retry-After': String(budget.retryAfterSeconds) });
    }
  }
  // Over the page-view budget, page views are dropped (not retried): they are samples, not reports.
  const acceptTransactions = pageViewCount === 0 || (await consumeTransactionBudget(db, project._id, pageViewCount)).allowed;

  const result = await ingestEvents({ db, project, rawEvents: events, uploadScreenshot, acceptTransactions });
  return json(result, 202);
}
