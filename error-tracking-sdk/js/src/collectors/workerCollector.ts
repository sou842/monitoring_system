import { MAX_MESSAGE_LENGTH, UNKNOWN_FUNCTION } from '../constants';
import { getWindow, stripQuery } from '../core/env';
import { Logger } from '../core/logger';
import { locationSignature, markSignatureReported } from '../core/reportedErrors';
import { guard, safelyRun } from '../core/safe';
import { truncate } from '../core/serialize';
import { StackFrame } from '../types';
import { CapturedError, Collector, CollectorSink } from './collector';

const WORKER_ERROR_TYPE = 'WorkerError';

type WorkerConstructor = typeof Worker;
/** `Worker` lives on the global object but is not declared on TypeScript's `Window`. */
type WindowWithWorker = Window & { Worker?: WorkerConstructor };

/** Builds the error for an `error` event fired on a Worker object. */
export function workerErrorFromEvent(event: Event, workerUrl: string): CapturedError {
  const errorEvent = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent ? event : null;
  const message =
    errorEvent !== null && errorEvent.message
      ? errorEvent.message
      : // No message means the worker script itself could not be loaded or parsed.
        'Worker failed to start: ' + workerUrl;
  const stacktrace: StackFrame[] =
    errorEvent !== null && errorEvent.filename
      ? [{ filename: stripQuery(errorEvent.filename), lineno: errorEvent.lineno || null, colno: errorEvent.colno || null, function: UNKNOWN_FUNCTION }]
      : [];

  return {
    error: { message: truncate(message, MAX_MESSAGE_LENGTH), type: WORKER_ERROR_TYPE, handled: false },
    stacktrace: stacktrace,
    context: { worker_url: workerUrl },
  };
}

/**
 * Reports uncaught errors inside dedicated Web Workers, and workers that fail
 * to load. Errors inside a worker never reach the page's `window` error
 * handler in every browser, so `window.Worker` is wrapped to attach an
 * `error` listener to each worker the app creates. The returned object is the
 * real Worker, so `instanceof Worker` and all behaviour are unchanged.
 *
 * Service Worker errors are not visible from the page and are not covered.
 */
export class WorkerCollector implements Collector {
  private original: WorkerConstructor | null = null;
  private patched: WorkerConstructor | null = null;

  constructor(
    private readonly sink: CollectorSink,
    private readonly logger: Logger,
  ) {}

  install(): void {
    const win = getWindow() as WindowWithWorker | null;
    if (this.original !== null || win === null || typeof win.Worker !== 'function') return;
    const Original: WorkerConstructor = win.Worker;
    const self = this;

    const Tracked = function TrackedWorker(scriptUrl: string | URL, options?: WorkerOptions): Worker {
      // Constructing may throw (bad URL, CSP); that must reach the app unchanged.
      const worker = new Original(scriptUrl, options);
      safelyRun(self.logger, 'worker error tracking', function attach() {
        const url = stripQuery(typeof scriptUrl === 'string' ? scriptUrl : scriptUrl.href);
        worker.addEventListener(
          'error',
          guard(self.logger, 'worker error handler', function onWorkerError(event: Event) {
            const captured = workerErrorFromEvent(event, url);
            const top = captured.stacktrace.length > 0 ? captured.stacktrace[0] : null;
            // Some browsers re-dispatch the same error on window; let the error collector skip it.
            markSignatureReported(locationSignature(captured.error.message, top !== null ? top.filename : null, top !== null ? top.lineno : null));
            self.sink.onError(captured);
          }),
        );
      });
      return worker;
    } as unknown as WorkerConstructor;
    Tracked.prototype = Original.prototype;

    this.original = Original;
    this.patched = Tracked;
    win.Worker = Tracked;
  }

  uninstall(): void {
    const win = getWindow() as WindowWithWorker | null;
    if (this.original === null || win === null) return;
    // Only restore if nobody wrapped on top of us.
    if (win.Worker === this.patched) win.Worker = this.original;
    this.original = null;
    this.patched = null;
  }
}
