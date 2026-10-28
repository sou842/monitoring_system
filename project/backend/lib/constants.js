/**
 * Every limit, threshold and fixed name used by the backend lives here.
 */

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------
/** Vercel rejects function bodies over ~4.5 MB; refuse earlier with a clear 413. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Max events accepted in one request (the SDK sends at most 10). */
export const MAX_EVENTS_PER_REQUEST = 50;
/**
 * Events accepted per project per minute; more get HTTP 429 (the SDK retries
 * later). `null` = no per-project limit (the user's choice, 2026-10-26): the
 * per-IP limit below is what stops one source from flooding a project.
 */
export const RATE_LIMIT_EVENTS_PER_MINUTE = null;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/**
 * Events accepted per minute from one IP for one project, so one source can't
 * flood a project. Errors are rare in production, so this leaves room for many
 * users behind one office IP.
 */
export const RATE_LIMIT_EVENTS_PER_IP_PER_MINUTE = 150;
/** Page views accepted per minute from one IP for one project; more are dropped (not retried). */
export const RATE_LIMIT_TRANSACTIONS_PER_IP_PER_MINUTE = 150;
/**
 * IPv6 clients are counted per /64 network (the first 4 of 8 groups): one
 * connection usually gets a whole /64 and could switch address every request.
 */
export const IPV6_RATE_LIMIT_GROUPS = 4;
export const IPV6_GROUPS = 8;
/** Longer "IP addresses" are cut before being used in a counter key. */
export const MAX_IP_LENGTH = 64;
export const API_KEY_HEADER = 'x-api-key';

// ---------------------------------------------------------------------------
// Allowed origins (per project; an empty list allows every origin)
// ---------------------------------------------------------------------------
export const MAX_ALLOWED_ORIGINS = 20;
export const MAX_ORIGIN_LENGTH = 200;

// ---------------------------------------------------------------------------
// Issue insights (per project: library paths, frames to hide, hints)
// ---------------------------------------------------------------------------
/** Per list: library paths, frames to hide, hints. */
export const MAX_INSIGHT_ENTRIES = 50;
/** A library path, frame name or hint's `match` text. */
export const MAX_INSIGHT_PATTERN_LENGTH = 200;
export const MAX_HINT_TEXT_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Validation limits (longer strings are truncated, longer arrays cut)
// ---------------------------------------------------------------------------
export const MAX_STRING_LENGTH = 2000;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_URL_LENGTH = 2000;
/** Longest app screen name kept (`screen`, set with the SDK's setScreen()); the JS SDK sends at most 200. */
export const MAX_SCREEN_LENGTH = 200;
export const MAX_STACK_FRAMES = 100;
export const MAX_BREADCRUMBS = 100;
export const MAX_API_CALLS = 50;
/** Longest API-call `_id` kept (`api_calls[]._id`, `spans[]._id`); the JS SDK sends 16 hex characters. */
export const MAX_REQUEST_ID_LENGTH = 64;
/** Max size of the free-form `context` / breadcrumb `data` objects once serialized. */
export const MAX_JSON_FIELD_BYTES = 16 * 1024;
/** Events whose timestamp is further than this from server time use the server time instead. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
export const EVENT_TYPES = ['error', 'message', 'performance', 'crash', 'transaction'];
/** Event types that become issues; `transaction` (page views) feeds the Performance view instead. */
export const ISSUE_EVENT_TYPES = EVENT_TYPES.filter((type) => type !== 'transaction');
export const LEVELS = ['info', 'warning', 'error'];

// ---------------------------------------------------------------------------
// Retention (MongoDB TTL indexes delete old documents automatically)
// ---------------------------------------------------------------------------
export const EVENT_RETENTION_DAYS = 30;
/** Issues not seen for this long are deleted (their events are long gone). */
export const ISSUE_RETENTION_DAYS = 90;
export const SECONDS_PER_DAY = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = 'et_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ISSUES_PAGE_SIZE = 50;
export const ISSUE_RECENT_EVENTS = 50;
export const PROJECT_CACHE_TTL_MS = 60 * 1000;
export const ISSUE_STATUSES = ['open', 'resolved', 'ignored'];
export const API_KEY_PREFIX = 'et_';
export const API_KEY_BYTES = 24;
export const MAX_PROJECT_NAME_LENGTH = 80;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
export const MIN_PASSWORD_LENGTH = 8;
/** Upper bound so a huge "password" can't be used to burn CPU in scrypt. */
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_USER_NAME_LENGTH = 80;
/** Projects one account may own; `null` = no limit (the user's choice, 2026-10-26). */
export const MAX_PROJECTS_PER_USER = null;
export const USER_ROLES = ['user', 'admin'];
export const USER_STATUSES = ['active', 'disabled'];
/** scrypt cost settings (~50 ms per hash) and sizes. Stored with each hash, so they can be raised later. */
export const SCRYPT_COST = 16384;
export const SCRYPT_BLOCK_SIZE = 8;
export const SCRYPT_PARALLELISM = 1;
export const SCRYPT_SALT_BYTES = 16;
export const SCRYPT_KEY_BYTES = 64;
export const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
/** Login attempts allowed per account (from one IP) and per IP, within the window. */
export const LOGIN_ATTEMPTS_PER_ACCOUNT = 10;
export const LOGIN_ATTEMPTS_PER_IP = 50;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** New accounts allowed per IP within the window. */
export const SIGNUPS_PER_IP = 5;
export const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
export const ADMIN_USERS_LIMIT = 500;

/** MongoDB server error code for a unique-index violation. */
export const MONGO_DUPLICATE_KEY = 11000;

// ---------------------------------------------------------------------------
// Dashboard statistics (api/stats.js)
// ---------------------------------------------------------------------------
const HOUR_MS = 60 * 60 * 1000;
/** Selectable ranges: how many buckets, and how long each one is. */
export const STATS_RANGES = {
  '24h': { buckets: 24, stepMs: HOUR_MS },
  '7d': { buckets: 7, stepMs: 24 * HOUR_MS },
};
export const DEFAULT_STATS_RANGE = '24h';
export const TOP_ISSUES_LIMIT = 6;

// ---------------------------------------------------------------------------
// Performance (transaction events → api/stats.js?view=performance)
// ---------------------------------------------------------------------------
/** Page views (transaction events) accepted per project per minute, separate from the error budget. */
export const RATE_LIMIT_TRANSACTIONS_PER_MINUTE = 1000;
/** Spans kept per page view (the SDK sends at most 100). */
export const MAX_SPANS = 100;
/** Raw page views are kept this long for "slowest samples"; hourly rollups much longer. */
export const TRANSACTION_RETENTION_DAYS = 7;
export const ROLLUP_RETENTION_DAYS = 90;
export const ROLLUP_BUCKET_MS = HOUR_MS;
/**
 * Latency histograms use logarithmic buckets: bucket i (i ≥ 1) holds values in
 * [BASE^(i-1), BASE^i) ms, bucket 0 holds values under 1 ms. With 1.15 every
 * percentile is within ±7% of the exact value, using at most ~120 buckets.
 */
export const HISTOGRAM_BASE = 1.15;
export const HISTOGRAM_MAX_BUCKET = 120;
/**
 * HTTP statuses that count as a failed request in the Performance view: the JS
 * SDK's default `httpErrorStatuses` (server errors plus the 4xx codes that
 * usually mean a client bug). 401, 403, 409, 422, 429, ... are normal app flow
 * (expired session, permissions, validation, rate limits), not failures.
 * Single codes or inclusive [min, max] ranges.
 */
export const FAILED_HTTP_STATUSES = [400, 404, 405, 413, [500, 599]];
/** CLS is unitless (0.1 is "good"); it is stored ×1000 in the same histograms. */
export const CLS_SCALE = 1000;
/** Rows returned in the pages and endpoints tables, and slowest samples in a detail view. */
export const PERFORMANCE_TABLE_LIMIT = 100;
export const SLOWEST_SAMPLES_LIMIT = 10;
/**
 * Google's Core Web Vitals thresholds: ≤ good is "good", > poor is "poor",
 * anything between "needs improvement". Rated at the 75th percentile.
 */
export const VITAL_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  fcp: { good: 1800, poor: 3000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  ttfb: { good: 800, poor: 1800 },
};
