/**
 * Every tunable number and fixed string used by the SDK lives here.
 * Nothing else in the codebase should contain a bare threshold, timeout or limit.
 */

export const SDK_NAME = 'error-tracker-js';
/** Must match package.json "version" (a test enforces this). */
export const SDK_VERSION = '0.7.0';
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
/**
 * Max serialized size of one request. Serverless hosts cap request bodies
 * (Vercel: 4.5 MB); batches are split to stay well below that. A single event
 * larger than this is still sent on its own.
 */
export const MAX_BATCH_BYTES = 1000000;
/** How long to wait for more events before sending a partial batch. */
export const FLUSH_DELAY_MS = 2000;
/** Backoff before each retry; length of this array is the retry count. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];
export const REQUEST_TIMEOUT_MS = 30000;
/** Largest body sent with fetch keepalive while the page is hidden (browsers allow 64 KB in flight in total). */
export const KEEPALIVE_MAX_BYTES = 60000;
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
/** How long a reported error's text signature suppresses a second copy of the same failure. */
export const REPORTED_SIGNATURE_TTL_MS = 2000;
/** After the rate limiter starts dropping, a summary event is sent this long after the first drop. */
export const DROPPED_EVENTS_REPORT_DELAY_MS = 10000;

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
/** Always masked, in addition to config.maskSelectors. */
export const DEFAULT_MASK_SELECTORS: readonly string[] = ['input[type="password"]'];

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------
/** Default for `slowPageLoadMs`. */
export const SLOW_PAGE_LOAD_MS = 3000;
/** Default for `slowApiCallMs`. */
export const SLOW_API_CALL_MS = 2000;
/** Allowed range for `slowPageLoadMs` and `slowApiCallMs`. */
export const SLOW_THRESHOLD_MIN_MS = 100;
export const SLOW_THRESHOLD_MAX_MS = 600000;
/** HTTP statuses of the page itself that are reported as PageNotFound (404 Not Found, 410 Gone). */
export const PAGE_NOT_FOUND_STATUSES: readonly number[] = [404, 410];
/** With `captureSlowEvents`, one endpoint is reported as SlowApiCall at most once per this interval. */
export const SLOW_EVENT_COOLDOWN_MS = 5 * 60 * 1000;
/** Failed resource loads (CSS images, pre-init entries) at or above this status are reported as ResourceError. */
export const HTTP_ERROR_STATUS_MIN = 400;
/**
 * Default for `httpErrorStatuses`: server errors plus the 4xx codes that usually
 * mean a client bug (malformed request, wrong URL, wrong method, payload too large).
 * 401/403/409/422/429 are normal app flow (expired session, validation, rate limits).
 */
export const DEFAULT_HTTP_ERROR_STATUSES: ReadonlyArray<number | [number, number]> = [400, 404, 405, 413, [500, 599]];
/** Statuses accepted in `httpErrorStatuses`. */
export const HTTP_STATUS_CODE_MIN = 100;
export const HTTP_STATUS_CODE_MAX = 599;
/** Number of most recent API calls attached to every payload. */
export const MAX_API_CALLS_TRACKED = 20;
/** Delay after window `load` so loadEventEnd is populated. */
export const PAGE_LOAD_SETTLE_MS = 0;
/** CLS session window rules (per the web-vitals definition). */
export const CLS_SESSION_GAP_MS = 1000;
export const CLS_SESSION_MAX_MS = 5000;

// ---------------------------------------------------------------------------
// Page views (transaction events)
// ---------------------------------------------------------------------------
export const DEFAULT_PERFORMANCE_SAMPLE_RATE = 1.0;
/** Requests recorded per page view; more are counted in `dropped_spans`. */
export const MAX_SPANS_PER_VIEW = 100;
/** A view still open after this long is sent and continued as a new one, so a tab left open all day still reports. */
export const MAX_VIEW_DURATION_MS = 30 * 60 * 1000;
/** How often an open view is checked against MAX_VIEW_DURATION_MS. */
export const VIEW_CHECK_INTERVAL_MS = 60 * 1000;
/** Transaction events accepted per rolling minute, separate from the error budget. */
export const TRANSACTION_RATE_LIMIT_MAX = 30;
/** Event Timing entries shorter than this are ignored (16 ms is the API minimum; web-vitals uses 40). */
export const EVENT_TIMING_THRESHOLD_MS = 40;
/** INP ignores one worst interaction per this many, so one outlier on a busy page doesn't define it. */
export const INP_INTERACTIONS_PER_OUTLIER = 50;
/** Longest interactions kept per view to compute INP. */
export const INP_MAX_TRACKED = 10;
/** Main-thread time beyond this per long task counts as blocking time (Total Blocking Time definition). */
export const LONG_TASK_BLOCKING_THRESHOLD_MS = 50;
/** Resource Timing entries kept for matching to requests. */
export const MAX_PENDING_RESOURCE_ENTRIES = 300;
/** A Resource Timing entry belongs to a request when their start times are this close. */
export const RESOURCE_MATCH_TOLERANCE_MS = 50;
/** A view ended by a route change is sent this much later, so late Resource Timing entries (~60 ms in Chrome) can be matched. */
export const BREAKDOWN_SETTLE_MS = 250;

// ---------------------------------------------------------------------------
// Responsiveness (main-thread blocking and frame rate)
// ---------------------------------------------------------------------------
/** Default for `mainThreadBlockedMs`: a single main-thread task longer than this is reported as a page freeze. */
export const LONG_TASK_FREEZE_MS = 1000;
/** The Long Tasks API only reports tasks over 50 ms, so a lower threshold means nothing. */
export const LONG_TASK_FREEZE_MIN_MS = 50;
export const LONG_TASK_FREEZE_MAX_MS = 60000;
/** Minimum gap between two freeze reports, so a sluggish page cannot flood events. */
export const FREEZE_REPORT_INTERVAL_MS = 30000;
/** Delay before the first frame-rate sample, so page-load work doesn't skew it. */
export const FPS_FIRST_SAMPLE_DELAY_MS = 5000;
/** How often the frame rate is sampled while the page is visible. */
export const FPS_SAMPLE_INTERVAL_MS = 30000;
/** How long each frame-rate sample runs. */
export const FPS_SAMPLE_DURATION_MS = 1000;
/** Sampled frame rates below this are reported as LowFrameRate. Kept well under 30 fps because low-power modes cap at 30. */
export const LOW_FPS_THRESHOLD = 20;
/** Allowed range for `lowFrameRateFps`. */
export const LOW_FPS_THRESHOLD_MIN = 1;
export const LOW_FPS_THRESHOLD_MAX = 60;
export const MS_PER_SECOND = 1000;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------
/** Default for `memoryPollIntervalMs`. */
export const MEMORY_POLL_INTERVAL_MS = 30000;
/** Polling faster than this would cost the host app CPU for no benefit. */
export const MEMORY_POLL_INTERVAL_MIN_MS = 5000;
export const MEMORY_POLL_INTERVAL_MAX_MS = 3600000;
/**
 * Default for `memoryLeakReadings`: how many heap floors in a row must each be
 * higher than the one before. A floor is the lowest reading in one window, so
 * the default spans 4 windows (8 minutes at the default poll interval).
 */
export const LEAK_CONSECUTIVE_READINGS = 4;
export const LEAK_CONSECUTIVE_READINGS_MIN = 2;
export const LEAK_CONSECUTIVE_READINGS_MAX = 20;
/** Default for `memoryLeakGrowth`: growth of the heap floor over the lowest floor seen, as a ratio (20%). */
export const LEAK_GROWTH_THRESHOLD = 0.2;
export const LEAK_GROWTH_THRESHOLD_MIN = 0.01;
export const LEAK_GROWTH_THRESHOLD_MAX = 10;
/** Default for `memoryLeakMinGrowthMb`: the floor must also grow by at least this many MB, so small heaps can't trip the ratio. */
export const LEAK_MIN_GROWTH_MB = 10;
export const LEAK_MIN_GROWTH_MB_MIN = 1;
export const LEAK_MIN_GROWTH_MB_MAX = 4096;
/**
 * Each floor in the trend must rise at least this much over the one before.
 * Chrome's heap creeps up by a few KB between windows even when nothing
 * leaks, which would otherwise count as "rising". Lowered automatically when
 * `memoryLeakMinGrowthMb` / `memoryLeakReadings` describe a slower leak (see
 * LEAK_MIN_STEP_SHARE_OF_AVERAGE).
 */
export const LEAK_MIN_STEP_MB = 0.5;
/**
 * The minimum step is never more than this share of the average step a leak of
 * exactly `memoryLeakMinGrowthMb` over `memoryLeakReadings` floors would take,
 * so long or small trend settings can still be met by a real, slightly uneven leak.
 */
export const LEAK_MIN_STEP_SHARE_OF_AVERAGE = 0.5;
/**
 * No single step may be more than this share of the trend's total rise. A
 * heavy screen loading once is one big step after small creep, not a leak.
 * Only applies when the trend has at least two steps.
 */
export const LEAK_MAX_STEP_SHARE = 0.7;
/** Readings per floor window. The window's lowest reading approximates the heap left after garbage collection. */
export const MEMORY_READINGS_PER_WINDOW = 4;
/** Readings this soon after init are not used for leak detection: apps load most of their screens and caches at startup. */
export const MEMORY_WARMUP_MS = 60000;
export const BYTES_PER_MB = 1024 * 1024;
