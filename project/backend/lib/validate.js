import {
  EVENT_TYPES,
  LEVELS,
  MAX_API_CALLS,
  MAX_BREADCRUMBS,
  MAX_CLOCK_SKEW_MS,
  MAX_JSON_FIELD_BYTES,
  MAX_MESSAGE_LENGTH,
  MAX_SPANS,
  MAX_STACK_FRAMES,
  MAX_STRING_LENGTH,
  MAX_URL_LENGTH,
} from './constants.js';

/**
 * Validates one incoming event against the shared cross-platform schema
 * (JS, iOS and Android SDKs all send this shape) and returns a cleaned copy:
 * known fields only, correct types, long strings truncated, long arrays cut.
 *
 * Only a few problems reject an event outright (not an object, unknown
 * event_type, missing sdk.name); everything else is coerced to `null` so one
 * odd field never loses an otherwise useful error report.
 */

const MAX_KEY_DEPTH = 6;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value, max = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function list(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

/**
 * MongoDB field names may not start with `$` or contain `.`; rewrite such keys
 * in free-form objects (context, breadcrumb data) instead of rejecting them.
 */
function sanitizeKeys(value, depth = 0) {
  if (depth > MAX_KEY_DEPTH) return '[MaxDepth]';
  if (Array.isArray(value)) return value.map((item) => sanitizeKeys(item, depth + 1));
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key.replace(/^\$/, '_').replace(/\./g, '_')] = sanitizeKeys(child, depth + 1);
  }
  return out;
}

/** Free-form object, size-capped. Oversized objects are replaced with a truncated preview. */
function freeObject(value) {
  if (!isObject(value)) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_JSON_FIELD_BYTES) {
    return { _truncated: true, preview: serialized.slice(0, MAX_JSON_FIELD_BYTES / 4) };
  }
  return sanitizeKeys(value);
}

function frame(value) {
  const f = isObject(value) ? value : {};
  return {
    filename: str(f.filename, MAX_URL_LENGTH),
    lineno: num(f.lineno),
    colno: num(f.colno),
    function: str(f.function) || '<anonymous>',
  };
}

function apiCall(value) {
  const c = isObject(value) ? value : {};
  return { url: str(c.url, MAX_URL_LENGTH) || '', method: str(c.method) || 'GET', status: num(c.status) ?? 0, duration_ms: num(c.duration_ms) ?? 0 };
}

function breadcrumb(value) {
  const b = isObject(value) ? value : {};
  return {
    timestamp: str(b.timestamp) || '',
    type: str(b.type) || 'log',
    message: str(b.message) || '',
    data: freeObject(b.data) || {},
  };
}

const TRANSACTION_KINDS = ['pageload', 'navigation', 'continued'];

function nonNegative(value) {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
}

function span(value) {
  const s = isObject(value) ? value : {};
  return {
    op: 'http',
    method: (str(s.method) || 'GET').toUpperCase(),
    url: str(s.url, MAX_URL_LENGTH) || '',
    status: num(s.status) ?? 0,
    failure: str(s.failure),
    start_ms: nonNegative(s.start_ms) ?? 0,
    duration_ms: nonNegative(s.duration_ms) ?? 0,
    server_ms: nonNegative(s.server_ms),
    download_ms: nonNegative(s.download_ms),
    size_bytes: nonNegative(s.size_bytes),
    background: bool(s.background) ?? false,
  };
}

/** The `transaction` block of a page-view event; null for other event types or when missing. */
function transaction(value, eventType) {
  if (eventType !== 'transaction' || !isObject(value)) return null;
  const vitals = isObject(value.vitals) ? value.vitals : {};
  const longTasks = isObject(value.long_tasks) ? value.long_tasks : {};
  return {
    name: str(value.name, MAX_URL_LENGTH) || '/',
    kind: TRANSACTION_KINDS.includes(value.kind) ? value.kind : 'navigation',
    start: typeof value.start === 'string' && Number.isFinite(Date.parse(value.start)) ? new Date(value.start) : null,
    duration_ms: nonNegative(value.duration_ms) ?? 0,
    background: bool(value.background) ?? false,
    vitals: {
      ttfb_ms: nonNegative(vitals.ttfb_ms),
      fcp_ms: nonNegative(vitals.fcp_ms),
      lcp_ms: nonNegative(vitals.lcp_ms),
      cls: nonNegative(vitals.cls),
      inp_ms: nonNegative(vitals.inp_ms),
      page_load_ms: nonNegative(vitals.page_load_ms),
    },
    long_tasks: { count: nonNegative(longTasks.count) ?? 0, blocking_ms: nonNegative(longTasks.blocking_ms) ?? 0 },
    spans: list(value.spans, MAX_SPANS).map(span),
    dropped_spans: nonNegative(value.dropped_spans) ?? 0,
  };
}

/** Client timestamp, or server time when missing/invalid/too far off. */
function timestamp(value, now) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || Math.abs(parsed - now.getTime()) > MAX_CLOCK_SKEW_MS) return now;
  return new Date(parsed);
}

/**
 * @param {unknown} raw  one element of the request's `events` array
 * @param {Date} now     server receive time
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
export function validateEvent(raw, now = new Date()) {
  if (!isObject(raw)) return { ok: false, reason: 'event must be an object' };
  if (!EVENT_TYPES.includes(raw.event_type)) return { ok: false, reason: `event_type must be one of ${EVENT_TYPES.join(', ')}` };
  const sdk = isObject(raw.sdk) ? raw.sdk : {};
  if (typeof sdk.name !== 'string' || sdk.name.length === 0) return { ok: false, reason: 'sdk.name is required' };
  const pageView = transaction(raw.transaction, raw.event_type);
  if (raw.event_type === 'transaction' && pageView === null) return { ok: false, reason: 'transaction events need a transaction object' };

  const error = isObject(raw.error)
    ? { message: str(raw.error.message, MAX_MESSAGE_LENGTH) || '', type: str(raw.error.type) || 'Error', handled: bool(raw.error.handled) ?? false }
    : null;
  const user = isObject(raw.user) ? raw.user : {};
  const perf = isObject(raw.performance) ? raw.performance : {};
  const memory = isObject(raw.memory) ? raw.memory : {};
  const device = isObject(raw.device) ? raw.device : {};
  const defaultLevel =
    raw.event_type === 'performance' ? 'warning' : raw.event_type === 'message' || raw.event_type === 'transaction' ? 'info' : 'error';

  return {
    ok: true,
    event: {
      sdk: { name: str(sdk.name), version: str(sdk.version) },
      event_type: raw.event_type,
      level: LEVELS.includes(raw.level) ? raw.level : defaultLevel,
      timestamp: timestamp(raw.timestamp, now),
      environment: str(raw.environment) || 'production',
      app_version: str(raw.app_version),
      user: { id: str(user.id), email: str(user.email), name: str(user.name) },
      error,
      stacktrace: list(raw.stacktrace, MAX_STACK_FRAMES).map(frame),
      breadcrumbs: list(raw.breadcrumbs, MAX_BREADCRUMBS).map(breadcrumb),
      performance: {
        page_load_ms: num(perf.page_load_ms),
        ttfb_ms: num(perf.ttfb_ms),
        fcp_ms: num(perf.fcp_ms),
        lcp_ms: num(perf.lcp_ms),
        cls: num(perf.cls),
        startup_ms: num(perf.startup_ms),
        frame_rate_fps: num(perf.frame_rate_fps),
        slow_screen: bool(perf.slow_screen) ?? false,
        api_calls: list(perf.api_calls, MAX_API_CALLS).map(apiCall),
        slow_api_calls: list(perf.slow_api_calls, MAX_API_CALLS).map(apiCall),
      },
      memory: {
        used_mb: num(memory.used_mb),
        total_mb: num(memory.total_mb),
        leak_suspected: bool(memory.leak_suspected),
        oom_kill: bool(memory.oom_kill),
      },
      device: {
        platform: str(device.platform) || 'unknown',
        os: str(device.os),
        os_version: str(device.os_version),
        manufacturer: str(device.manufacturer),
        model: str(device.model),
        browser: str(device.browser),
        browser_version: str(device.browser_version),
        screen_width: num(device.screen_width),
        screen_height: num(device.screen_height),
        url: str(device.url, MAX_URL_LENGTH),
        referrer: str(device.referrer, MAX_URL_LENGTH),
        locale: str(device.locale),
      },
      context: freeObject(raw.context),
      transaction: pageView,
    },
  };
}
