/**
 * Every tunable number and fixed string used by the SDK lives here.
 * Nothing else in the codebase should contain a bare threshold, timeout or limit.
 */

export const SDK_NAME = 'error-tracker-js';
export const SDK_VERSION = '1.0.0';
export const PLATFORM = 'js';

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------
export const DEFAULT_SAMPLE_RATE = 1.0;
export const DEFAULT_MAX_BREADCRUMBS = 30;
/** Hard ceiling so a misconfigured app cannot make every payload huge. */
export const MAX_BREADCRUMBS_LIMIT = 100;
export const DEFAULT_ENVIRONMENT = 'production';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
export const API_KEY_HEADER = 'X-API-Key';
export const CONTENT_TYPE_JSON = 'application/json';
export const BATCH_SIZE = 10;
/** How long to wait for more events before sending a partial batch. */
export const FLUSH_DELAY_MS = 2000;
/** Backoff before each retry; length of this array is the retry count. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];
export const REQUEST_TIMEOUT_MS = 30000;
/** In-memory queue cap; oldest events are dropped beyond this. */
export const MAX_QUEUE_SIZE = 100;
export const OFFLINE_STORAGE_KEY = '_et_queue';
/** Persisted queue cap; keeps localStorage usage bounded. */
export const MAX_PERSISTED_EVENTS = 50;
export const HTTP_STATUS_REQUEST_TIMEOUT = 408;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
export const HTTP_STATUS_SERVER_ERROR_MIN = 500;
export const HTTP_STATUS_OK_MIN = 200;
export const HTTP_STATUS_OK_MAX = 299;

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------
/** Max events accepted per rolling window (error-storm protection). */
export const RATE_LIMIT_MAX_EVENTS = 100;
export const RATE_LIMIT_WINDOW_MS = 60000;
/** Identical events inside this window are dropped as duplicates. */
export const DEDUP_WINDOW_MS = 5000;
/** Number of distinct fingerprints remembered for dedup. */
export const DEDUP_MAX_ENTRIES = 200;
/** Calls made to the public API before init() are buffered up to this count. */
export const MAX_PRE_INIT_CALLS = 100;

// ---------------------------------------------------------------------------
// Stack traces & serialization
// ---------------------------------------------------------------------------
export const MAX_STACK_FRAMES = 50;
export const MAX_SERIALIZE_DEPTH = 5;
export const MAX_SERIALIZE_KEYS = 50;
export const MAX_STRING_LENGTH = 1000;
export const MAX_MESSAGE_LENGTH = 2000;
export const UNKNOWN_FUNCTION = '<anonymous>';

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------
export const MAX_CLICK_TEXT_LENGTH = 50;
export const MAX_CSS_PATH_DEPTH = 5;
export const MASKED_TEXT = '[masked]';

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------
export const SLOW_PAGE_LOAD_MS = 3000;
export const SLOW_API_CALL_MS = 2000;
/** Responses at or above this status are reported as HttpError events. */
export const HTTP_ERROR_STATUS_MIN = 400;
/** Number of most recent API calls attached to every payload. */
export const MAX_API_CALLS_TRACKED = 20;
/** Delay after window `load` so loadEventEnd is populated. */
export const PAGE_LOAD_SETTLE_MS = 0;
/** CLS session window rules (per the web-vitals definition). */
export const CLS_SESSION_GAP_MS = 1000;
export const CLS_SESSION_MAX_MS = 5000;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------
export const MEMORY_POLL_INTERVAL_MS = 30000;
export const LEAK_CONSECUTIVE_READINGS = 3;
/** Growth ratio across the consecutive readings that flags a leak (20%). */
export const LEAK_GROWTH_THRESHOLD = 0.2;
export const BYTES_PER_MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
export const DEFAULT_HTML2CANVAS_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
/** Subresource-integrity hash of DEFAULT_HTML2CANVAS_URL. */
export const DEFAULT_HTML2CANVAS_INTEGRITY =
  'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H';
export const SCREENSHOT_MIME_TYPE = 'image/jpeg';
export const SCREENSHOT_QUALITY = 0.6;
/** Fallback quality used when the first encode is over the size budget. */
export const SCREENSHOT_FALLBACK_QUALITY = 0.3;
/** Max base64 length of a screenshot data URL (~750 KB). */
export const MAX_SCREENSHOT_LENGTH = 1000000;
/** Library load + render must finish within this or the event is sent without it. */
export const SCREENSHOT_TIMEOUT_MS = 3000;
/** At most one screenshot per interval to protect the host app's main thread. */
export const SCREENSHOT_MIN_INTERVAL_MS = 10000;
export const SCREENSHOT_MAX_SCALE = 1;
export const MASK_COLOR = '#000000';
/** Always masked, in addition to config.maskSelectors. */
export const DEFAULT_MASK_SELECTORS: readonly string[] = ['input[type="password"]'];
