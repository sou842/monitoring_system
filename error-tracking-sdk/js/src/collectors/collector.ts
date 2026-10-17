import { BreadcrumbInput, ErrorPayload, StackFrame } from '../types';

/** Lifecycle shared by every collector. Both methods must be idempotent and never throw. */
export interface Collector {
  install(): void;
  uninstall(): void;
}

/** An error ready to be turned into an event. */
export interface CapturedError {
  error: ErrorPayload;
  stacktrace: StackFrame[];
}

/** Kinds of performance problems that produce their own `performance` event. */
export type PerformanceIssueKind = 'SlowPageLoad' | 'SlowApiCall' | 'MemoryLeakSuspected';

/** Callbacks collectors use to hand data to the client. */
export interface CollectorSink {
  onError(captured: CapturedError): void;
  onBreadcrumb(breadcrumb: BreadcrumbInput): void;
  onPerformanceIssue(kind: PerformanceIssueKind, message: string): void;
  onNavigation(): void;
}
