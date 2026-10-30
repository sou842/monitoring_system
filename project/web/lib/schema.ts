/**
 * The shared cross-platform event schema (JS, iOS and Android SDKs all send
 * this shape), as it looks after server validation (server/validate.ts):
 * every field present, `null` where a platform can't provide it.
 *
 * Used by the server and the dashboard. In API responses dates are ISO
 * strings: see `Serialized`.
 */

export const EVENT_TYPES = ['error', 'message', 'performance', 'crash', 'transaction'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** Event types that become issues; `transaction` (page views) feeds the Performance view instead. */
export const ISSUE_EVENT_TYPES = ['error', 'message', 'performance', 'crash'] as const satisfies readonly EventType[];
export type IssueEventType = (typeof ISSUE_EVENT_TYPES)[number];
export const LEVELS = ['info', 'warning', 'error'] as const;
export type Level = (typeof LEVELS)[number];
export const ISSUE_STATUSES = ['open', 'resolved', 'ignored'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const TRANSACTION_KINDS = ['pageload', 'navigation', 'continued'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Free-form object sent by apps (`context`, breadcrumb `data`): untrusted, any JSON. */
export type FreeObject = Record<string, unknown>;

export interface StackFrame {
  filename: string | null;
  lineno: number | null;
  colno: number | null;
  function: string;
}

export interface Breadcrumb {
  timestamp: string;
  type: string;
  message: string;
  data: FreeObject;
}

export interface ApiCall {
  /** Same call, same id in every event (SDK 0.9.0+); null from older SDKs. */
  _id: string | null;
  url: string;
  method: string;
  status: number;
  duration_ms: number;
}

export interface Span {
  _id: string | null;
  op: 'http';
  method: string;
  url: string;
  status: number;
  failure: string | null;
  start_ms: number;
  duration_ms: number;
  server_ms: number | null;
  download_ms: number | null;
  size_bytes: number | null;
  background: boolean;
}

export interface Vitals {
  ttfb_ms: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  page_load_ms: number | null;
}

export interface TransactionBlock {
  name: string;
  kind: TransactionKind;
  start: Date | null;
  duration_ms: number;
  background: boolean;
  vitals: Vitals;
  long_tasks: { count: number; blocking_ms: number };
  spans: Span[];
  dropped_spans: number;
}

export interface EventPayload {
  sdk: { name: string | null; version: string | null };
  event_type: EventType;
  level: Level;
  timestamp: Date;
  environment: string;
  app_version: string | null;
  user: { id: string | null; email: string | null; name: string | null };
  /** The app's screen name (setScreen); null from older SDKs. */
  screen: string | null;
  error: { message: string; type: string; handled: boolean } | null;
  stacktrace: StackFrame[];
  breadcrumbs: Breadcrumb[];
  performance: {
    page_load_ms: number | null;
    ttfb_ms: number | null;
    fcp_ms: number | null;
    lcp_ms: number | null;
    cls: number | null;
    startup_ms: number | null;
    frame_rate_fps: number | null;
    slow_screen: boolean;
    api_calls: ApiCall[];
    slow_api_calls: ApiCall[];
  };
  memory: { used_mb: number | null; total_mb: number | null; leak_suspected: boolean | null; oom_kill: boolean | null };
  device: {
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
    referrer: string | null;
    locale: string | null;
  };
  context: FreeObject | null;
  transaction: TransactionBlock | null;
}

/** A page-view event: `transaction` is always set. */
export type PageViewEvent = EventPayload & { transaction: TransactionBlock };

/** A value as it arrives in a JSON response: dates become ISO strings. */
export type Serialized<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;
