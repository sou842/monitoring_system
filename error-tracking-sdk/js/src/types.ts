/**
 * Public and wire-format types.
 *
 * The `TrackerEvent` interface mirrors the shared payload schema used by the
 * JS, iOS and Android SDKs. Every field is always present on the wire; values
 * that are unavailable on the web platform are `null`, never omitted.
 */

/** JSON-safe value produced by the SDK's serializer. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type EventType = 'error' | 'message' | 'performance' | 'crash' | 'transaction';
export type EventLevel = 'info' | 'warning' | 'error';
export type BreadcrumbType = 'navigation' | 'click' | 'api' | 'log' | 'lifecycle' | (string & {});

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** Options accepted by `ErrorTracker.init()`. */
export interface ErrorTrackerConfig {
  /** Project API key. Kept in memory only and sent in the `X-API-Key` header. */
  apiKey: string;
  /** Ingestion URL, e.g. `https://api.yourcompany.com/v1/events`. */
  endpoint: string;
  /** Deployment environment such as `production`, `staging` or `development`. */
  environment?: string;
  /** Version of the host application. */
  appVersion?: string;
  /** Fraction of events to keep, 0.0–1.0. Defaults to 1.0. */
  sampleRate?: number;
  /** Size of the breadcrumb ring buffer. Defaults to 30. */
  maxBreadcrumbs?: number;
  /** CSS selectors whose elements are blacked out in screenshots and click breadcrumbs. */
  maskSelectors?: string[];
  /** Log SDK diagnostics to the console. Defaults to false. */
  debug?: boolean;
  /** Report fetch/XHR responses with an error status (see `httpErrorStatuses`) as error events. Defaults to true. */
  captureHttpErrors?: boolean;
  /**
   * Which response statuses are reported as `HttpError`: single codes and
   * inclusive `[min, max]` ranges, e.g. `[400, [500, 599]]`. Invalid entries are
   * ignored; an empty list reports none. Defaults to
   * `[400, 404, 405, 413, [500, 599]]`, leaving out 4xx codes that are usually
   * normal app flow (401, 403, 409, 422, 429, ...).
   */
  httpErrorStatuses?: ReadonlyArray<number | readonly [number, number]>;
  /**
   * Report fetch/XHR requests that got no response (offline, timeout, CORS,
   * DNS/SSL failure) as NetworkError events. User-cancelled requests are
   * never reported. Defaults to true.
   */
  captureNetworkErrors?: boolean;
  /** Report every `console.error(...)` call as an error event. Defaults to false (libraries log a lot of noise). */
  captureConsoleErrors?: boolean;
  /**
   * Report a `PageNotFound` event when the page itself was served with a 404 or
   * 410 status (Chromium 109+ and Firefox). Defaults to true.
   */
  detectPageNotFound?: boolean;
  /** Attach a screenshot to error events. Defaults to true. */
  captureScreenshots?: boolean;
  /** Override where html2canvas is loaded from (self-hosting is recommended). */
  html2canvasUrl?: string;
  /** SRI hash for `html2canvasUrl`. Set to an empty string to disable the integrity check. */
  html2canvasIntegrity?: string;
  /** A fetch/XHR call slower than this (ms) is reported as `SlowApiCall`. Defaults to 2000 (allowed 100–600000). */
  slowApiCallMs?: number;
  /** A page load slower than this (ms) is reported as `SlowPageLoad`. Defaults to 3000 (allowed 100–600000). */
  slowPageLoadMs?: number;
  /** A single main-thread task longer than this (ms) is reported as `MainThreadBlocked`. Defaults to 1000 (allowed 50–60000). */
  mainThreadBlockedMs?: number;
  /** A sampled frame rate below this (fps) is reported as `LowFrameRate`. Defaults to 20 (allowed 1–60). */
  lowFrameRateFps?: number;
  /** How often the JS heap is read (ms). Defaults to 30000 (allowed 5000–3600000). */
  memoryPollIntervalMs?: number;
  /**
   * Growth of the heap floor (the heap left after garbage collection) over the
   * lowest floor seen, as a ratio, that flags `MemoryLeakSuspected`, e.g. 0.2 = 20%.
   * Defaults to 0.2 (allowed 0.01–10).
   */
  memoryLeakGrowth?: number;
  /**
   * The heap floor must also grow by at least this many MB, so small heaps
   * can't trip the ratio. Defaults to 10 (allowed 1–4096).
   */
  memoryLeakMinGrowthMb?: number;
  /**
   * How many heap floors in a row must each be higher than the one before.
   * Each floor covers 4 polls, so the default of 4 spans 8 minutes at the
   * default poll interval. Defaults to 4 (allowed 2–20).
   */
  memoryLeakReadings?: number;
  /**
   * Fraction of page views whose performance data (a `transaction` event with
   * timings for the page and every request) is sent, 0.0–1.0. Independent of
   * `sampleRate`, which applies to errors and messages. Defaults to 1.0.
   */
  performanceSampleRate?: number;
  /**
   * Also report each slow API call and slow page load as its own issue
   * (`SlowApiCall` / `SlowPageLoad` events) using `slowApiCallMs` /
   * `slowPageLoadMs`. Slow requests and pages are already visible in the
   * Performance view, so this defaults to false.
   */
  captureSlowEvents?: boolean;
  /**
   * Last chance to scrub or drop an event before it is queued.
   * Return the (optionally modified) event, or `null` to drop it.
   * Not called for `transaction` events; see `beforeSendTransaction`.
   */
  beforeSend?: (event: TrackerEvent) => TrackerEvent | null;
  /** Like `beforeSend`, for `transaction` (performance) events. Return `null` to drop one. */
  beforeSendTransaction?: (event: TrackerEvent) => TrackerEvent | null;
}

/** User attached to every subsequent event. */
export interface TrackedUser {
  id: string;
  email?: string;
  name?: string;
}

/** Breadcrumb supplied through `ErrorTracker.addBreadcrumb()`. */
export interface BreadcrumbInput {
  type: BreadcrumbType;
  message: string;
  data?: object;
}

// ---------------------------------------------------------------------------
// Wire format (shared schema)
// ---------------------------------------------------------------------------

export interface SdkInfo {
  name: string;
  version: string;
}

export interface UserPayload {
  id: string | null;
  email: string | null;
  name: string | null;
}

export interface ErrorPayload {
  message: string;
  type: string;
  handled: boolean;
}

export interface StackFrame {
  filename: string | null;
  lineno: number | null;
  colno: number | null;
  function: string;
}

export interface Breadcrumb {
  timestamp: string;
  type: BreadcrumbType;
  message: string;
  data: JsonObject;
}

export interface ApiCall {
  url: string;
  method: string;
  /** HTTP status; 0 when the request failed before a response arrived. */
  status: number;
  duration_ms: number;
}

export interface PerformancePayload {
  page_load_ms: number | null;
  ttfb_ms: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  /** Cumulative Layout Shift score (unitless). JS-only extension of the shared schema. */
  cls: number | null;
  startup_ms: number | null;
  frame_rate_fps: number | null;
  slow_screen: boolean;
  api_calls: ApiCall[];
  slow_api_calls: ApiCall[];
}

export interface MemoryPayload {
  used_mb: number | null;
  total_mb: number | null;
  leak_suspected: boolean | null;
  oom_kill: boolean | null;
}

export interface DevicePayload {
  platform: string;
  os: string | null;
  os_version: string | null;
  manufacturer: string | null;
  model: string | null;
  browser: string | null;
  browser_version: string | null;
  screen_width: number | null;
  screen_height: number | null;
  url: string | null;
  /** JS-only extension of the shared schema. */
  referrer: string | null;
  locale: string | null;
}

/** One timed operation inside a page view. Only HTTP requests for now. */
export interface Span {
  op: 'http';
  method: string;
  /** Query string and fragment removed. */
  url: string;
  /** HTTP status; 0 when no response arrived. */
  status: number;
  /** Why no response arrived (`offline`, `timeout`, `aborted`, `network`), or null. */
  failure: string | null;
  /** When the request started, in ms after the page view started. */
  start_ms: number;
  duration_ms: number;
  /**
   * From Resource Timing, when the browser exposes it (same-origin, or a
   * `Timing-Allow-Origin` header): time from sending the request to the first
   * response byte (server work plus one round trip), time to download the
   * body, and the response size. Null otherwise.
   */
  server_ms: number | null;
  download_ms: number | null;
  size_bytes: number | null;
  /** True when the tab was hidden at some point during the request; such timings are not used for percentiles. */
  background: boolean;
}

/** Core Web Vitals and load timings of one page view; null when not measured or not trustworthy. */
export interface TransactionVitals {
  ttfb_ms: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  cls: number | null;
  /** Interaction to Next Paint: how long the page took to respond to clicks and key presses. */
  inp_ms: number | null;
  page_load_ms: number | null;
}

/** Performance data of one page view, sent as a `transaction` event. */
export interface TransactionPayload {
  /** URL path of the page (query string and fragment removed). */
  name: string;
  /**
   * `pageload`: the first view after the page loaded. `navigation`: a
   * single-page-app route change. `continued`: the same page after the tab
   * came back from the background, or after a very long view was split.
   */
  kind: 'pageload' | 'navigation' | 'continued';
  /** When the view started (ISO 8601). */
  start: string;
  duration_ms: number;
  /** True when the tab was hidden at some point during the view. */
  background: boolean;
  vitals: TransactionVitals;
  long_tasks: { count: number; blocking_ms: number };
  spans: Span[];
  /** Spans left out because the view had more than the per-view limit. */
  dropped_spans: number;
}

/** A single event as sent to the ingestion endpoint. */
export interface TrackerEvent {
  sdk: SdkInfo;
  api_key: string;
  event_type: EventType;
  /** Severity. JS-only extension of the shared schema. */
  level: EventLevel;
  timestamp: string;
  environment: string;
  app_version: string | null;
  user: UserPayload;
  error: ErrorPayload | null;
  stacktrace: StackFrame[];
  breadcrumbs: Breadcrumb[];
  screenshot: string | null;
  performance: PerformancePayload;
  memory: MemoryPayload;
  device: DevicePayload;
  /** Extra data passed to `captureError(error, context)`. JS-only extension. */
  context: JsonObject | null;
  /** Page-view performance data; set only on `transaction` events, null on all others. */
  transaction: TransactionPayload | null;
}

/** Body of a batched POST to the endpoint. */
export interface EventBatch {
  events: TrackerEvent[];
}
