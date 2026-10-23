import { BreadcrumbInput, ErrorPayload, JsonObject, StackFrame } from '../types';

/** Lifecycle shared by every collector. Both methods must be idempotent and never throw. */
export interface Collector {
  install(): void;
  uninstall(): void;
}

/** An error ready to be turned into an event. */
export interface CapturedError {
  error: ErrorPayload;
  stacktrace: StackFrame[];
  /** Extra details attached as the event's `context` (e.g. CSP directive, request failure kind). */
  context?: JsonObject | null;
}

/** Kinds of performance problems that produce their own `performance` event. */
export type PerformanceIssueKind =
  | 'SlowPageLoad'
  | 'SlowApiCall'
  | 'MemoryLeakSuspected'
  | 'MainThreadBlocked'
  | 'LowFrameRate';

/** Callbacks collectors use to hand data to the client. */
export interface CollectorSink {
  onError(captured: CapturedError): void;
  onBreadcrumb(breadcrumb: BreadcrumbInput): void;
  /** `context` holds the measurements behind the report (e.g. heap sizes for a leak). */
  onPerformanceIssue(kind: PerformanceIssueKind, message: string, context?: JsonObject): void;
  /** The app changed route (pushState, replaceState with a new path, popstate); `url` is the new location. */
  onNavigation(url: string): void;
}
