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

export type EventType = 'error' | 'message' | 'performance' | 'crash';
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
  /** Report fetch/XHR responses with a 4xx/5xx status as error events. Defaults to true. */
  captureHttpErrors?: boolean;
  /**
   * Report fetch/XHR requests that got no response (offline, timeout, CORS,
   * DNS/SSL failure) as NetworkError events. User-cancelled requests are
   * never reported. Defaults to true.
   */
  captureNetworkErrors?: boolean;
  /** Report every `console.error(...)` call as an error event. Defaults to false (libraries log a lot of noise). */
  captureConsoleErrors?: boolean;
  /** Attach a screenshot to error events. Defaults to true. */
  captureScreenshots?: boolean;
  /** Override where html2canvas is loaded from (self-hosting is recommended). */
  html2canvasUrl?: string;
  /** SRI hash for `html2canvasUrl`. Set to an empty string to disable the integrity check. */
  html2canvasIntegrity?: string;
  /**
   * Last chance to scrub or drop an event before it is queued.
   * Return the (optionally modified) event, or `null` to drop it.
   */
  beforeSend?: (event: TrackerEvent) => TrackerEvent | null;
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
}

/** Body of a batched POST to the endpoint. */
export interface EventBatch {
  events: TrackerEvent[];
}
