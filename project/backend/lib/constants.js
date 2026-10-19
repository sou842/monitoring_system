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
/** Events accepted per project per minute; more get HTTP 429 (the SDK retries later). */
export const RATE_LIMIT_EVENTS_PER_MINUTE = 1000;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const API_KEY_HEADER = 'x-api-key';

// ---------------------------------------------------------------------------
// Validation limits (longer strings are truncated, longer arrays cut)
// ---------------------------------------------------------------------------
export const MAX_STRING_LENGTH = 2000;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_URL_LENGTH = 2000;
export const MAX_STACK_FRAMES = 100;
export const MAX_BREADCRUMBS = 100;
export const MAX_API_CALLS = 50;
/** Max size of the free-form `context` / breadcrumb `data` objects once serialized. */
export const MAX_JSON_FIELD_BYTES = 16 * 1024;
/** Events whose timestamp is further than this from server time use the server time instead. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
export const EVENT_TYPES = ['error', 'message', 'performance', 'crash'];
export const LEVELS = ['info', 'warning', 'error'];

// ---------------------------------------------------------------------------
// Screenshots (Cloudinary)
// ---------------------------------------------------------------------------
/**
 * Decoded size above which a screenshot is NOT uploaded. The SDK compresses
 * before sending; this guarantees a raw, uncompressed image never reaches Cloudinary.
 */
export const MAX_SCREENSHOT_BYTES = 400 * 1024;
export const SCREENSHOT_MIME_TYPES = ['image/jpeg', 'image/webp', 'image/png'];
export const CLOUDINARY_FOLDER = 'error-tracker';
export const CLOUDINARY_TIMEOUT_MS = 10000;
/** Parallel screenshot uploads per request. */
export const SCREENSHOT_UPLOAD_CONCURRENCY = 4;

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
/** Keeps one account from filling the shared database. */
export const MAX_PROJECTS_PER_USER = 10;
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
