import { MAX_MESSAGE_LENGTH, UNKNOWN_FUNCTION } from '../constants';
import { getWindow, stripQuery } from '../core/env';
import { Logger } from '../core/logger';
import { locationSignature, markReported, wasReported, wasSignatureReported } from '../core/reportedErrors';
import { guard } from '../core/safe';
import { describeValue, truncate } from '../core/serialize';
import { parseStackFromError } from '../core/stackParser';
import { StackFrame } from '../types';
import { CapturedError, Collector, CollectorSink } from './collector';

const UNHANDLED_REJECTION_TYPE = 'UnhandledRejection';
const RESOURCE_ERROR_TYPE = 'ResourceError';
const DEFAULT_ERROR_TYPE = 'Error';
const CROSS_ORIGIN_ERROR_TYPE = 'CrossOriginScriptError';
/** `<link rel>` values that only hint at a future load. */
const RESOURCE_HINT_RELS = ['preload', 'prefetch', 'modulepreload'];
const CROSS_ORIGIN_MESSAGE = /^Script error\.?$/;
const CROSS_ORIGIN_HINT =
  'Error details are hidden by the browser because the script came from another origin. ' +
  'Load it with crossorigin="anonymous" and serve it with an Access-Control-Allow-Origin header to get the real message and stack.';

/**
 * Converts any thrown value into an error payload plus parsed stack trace.
 * Used for global handlers and for `captureError()`.
 */
export function captureFromThrown(thrown: unknown, handled: boolean, fallbackType: string = DEFAULT_ERROR_TYPE): CapturedError {
  const isErrorLike =
    thrown !== null && typeof thrown === 'object' && typeof (thrown as { message?: unknown }).message === 'string';

  let type = fallbackType;
  if (isErrorLike) {
    const name = (thrown as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) {
      type = name;
    } else {
      const ctor = (thrown as { constructor?: { name?: unknown } }).constructor;
      if (ctor !== undefined && typeof ctor.name === 'string' && ctor.name.length > 0) type = ctor.name;
    }
  }

  // Later sightings of the same object (unhandledrejection, console.error) are then skipped.
  markReported(thrown);

  return {
    error: {
      message: truncate(isErrorLike ? (thrown as { message: string }).message : describeValue(thrown), MAX_MESSAGE_LENGTH),
      type: type,
      handled: handled,
    },
    stacktrace: parseStackFromError(thrown),
  };
}

/**
 * Captures uncaught exceptions, unhandled promise rejections and failed
 * resource loads (scripts, images, stylesheets).
 *
 * A capture-phase `error` listener is used rather than assigning
 * `window.onerror`: it receives the same ErrorEvent, cannot be overwritten by
 * the host app reassigning `onerror`, and also sees resource load failures,
 * which do not bubble to `onerror`.
 */
export class ErrorCollector implements Collector {
  private installed = false;
  private readonly handleError: (event: Event) => void;
  private readonly handleRejection: (event: PromiseRejectionEvent) => void;

  constructor(
    private readonly sink: CollectorSink,
    logger: Logger,
  ) {
    const self = this;
    this.handleError = guard(logger, 'error handler', function onError(event: Event) {
      if (isErrorEvent(event)) {
        if (wasReported(event.error)) return;
        // e.g. a Web Worker error already reported by the worker collector, re-dispatched on window.
        const filename = event.filename ? stripQuery(event.filename) : null;
        if (wasSignatureReported(locationSignature(event.message, filename, event.lineno || null))) return;
      }
      const captured = self.fromErrorEvent(event);
      if (captured !== null) self.sink.onError(captured);
    });
    this.handleRejection = guard(logger, 'rejection handler', function onRejection(event: PromiseRejectionEvent) {
      // e.g. a failed fetch already reported as NetworkError, or invalid JSON already reported.
      if (wasReported(event.reason)) return;
      self.sink.onError(captureFromThrown(event.reason, false, UNHANDLED_REJECTION_TYPE));
    });
  }

  install(): void {
    const win = getWindow();
    if (this.installed || win === null) return;
    win.addEventListener('error', this.handleError, true);
    win.addEventListener('unhandledrejection', this.handleRejection);
    this.installed = true;
  }

  uninstall(): void {
    const win = getWindow();
    if (!this.installed || win === null) return;
    win.removeEventListener('error', this.handleError, true);
    win.removeEventListener('unhandledrejection', this.handleRejection);
    this.installed = false;
  }

  private fromErrorEvent(event: Event): CapturedError | null {
    if (isErrorEvent(event)) {
      let captured: CapturedError;
      if (event.error !== null && event.error !== undefined) {
        captured = captureFromThrown(event.error, false);
      } else if (CROSS_ORIGIN_MESSAGE.test(event.message || '')) {
        // The browser hides details of errors thrown by scripts from another
        // origin unless they are loaded with CORS. Label it so it isn't mistaken for a bug in our code.
        captured = {
          error: { message: event.message, type: CROSS_ORIGIN_ERROR_TYPE, handled: false },
          stacktrace: [] as StackFrame[],
          context: { hint: CROSS_ORIGIN_HINT },
        };
      } else {
        captured = {
          error: { message: truncate(event.message || 'Unknown error', MAX_MESSAGE_LENGTH), type: DEFAULT_ERROR_TYPE, handled: false },
          stacktrace: [] as StackFrame[],
        };
      }
      if (captured.stacktrace.length === 0 && event.filename) {
        captured.stacktrace = [
          { filename: event.filename, lineno: event.lineno || null, colno: event.colno || null, function: UNKNOWN_FUNCTION },
        ];
      }
      return captured;
    }

    const target = event.target;
    if (target !== null && target !== getWindow() && isElement(target)) {
      // A failed preload/prefetch hint is a duplicate: the element that actually
      // uses the file (e.g. the <img> React preloads) reports its own failure.
      if (isResourceHint(target)) return null;
      const source = resourceUrl(target);
      return {
        error: {
          message: truncate('Failed to load <' + target.tagName.toLowerCase() + '>' + (source !== null ? ' ' + source : ''), MAX_MESSAGE_LENGTH),
          type: RESOURCE_ERROR_TYPE,
          handled: false,
        },
        stacktrace: [],
      };
    }
    return null;
  }
}

function isErrorEvent(event: Event): event is ErrorEvent {
  return typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent;
}

function isElement(target: EventTarget): target is Element {
  return typeof Element !== 'undefined' && target instanceof Element;
}

function isResourceHint(el: Element): boolean {
  if (el.tagName !== 'LINK') return false;
  const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
  for (let i = 0; i < rel.length; i++) {
    if (RESOURCE_HINT_RELS.indexOf(rel[i]) !== -1) return true;
  }
  return false;
}

function resourceUrl(el: Element): string | null {
  const raw = el.getAttribute('src') || el.getAttribute('href');
  return raw !== null && raw.length > 0 ? stripQuery(raw) : null;
}
