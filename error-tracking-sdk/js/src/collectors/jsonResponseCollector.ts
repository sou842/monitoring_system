import { MAX_MESSAGE_LENGTH } from '../constants';
import { absoluteUrl, getWindow, stripQuery } from '../core/env';
import { Logger } from '../core/logger';
import { markReported } from '../core/reportedErrors';
import { safelyRun } from '../core/safe';
import { truncate } from '../core/serialize';
import { parseStack } from '../core/stackParser';
import { CapturedError, Collector, CollectorSink } from './collector';

const INVALID_JSON_TYPE = 'InvalidJsonResponse';
/** The `json()` wrapper's own frame, removed from call-site stacks. */
const WRAPPER_FRAMES = 1;

/** Builds the error for a response body that could not be parsed as JSON. */
export function invalidJsonError(url: string, status: number, cause: unknown, callStack: string | undefined): CapturedError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return {
    error: {
      message: truncate('Invalid JSON from ' + url + ' (status ' + status + '): ' + reason, MAX_MESSAGE_LENGTH),
      type: INVALID_JSON_TYPE,
      // The parse error was handed back to the app's code.
      handled: true,
    },
    stacktrace: parseStack(callStack).slice(WRAPPER_FRAMES),
    context: { url: url, status: status },
  };
}

/**
 * Reports responses whose body is not valid JSON when the app calls
 * `response.json()`, even if the app catches the resulting SyntaxError.
 * A malformed body from an API is a bug on one side or the other, so it is
 * worth knowing about either way.
 *
 * Only parse failures (SyntaxError) are reported; aborted or already-read
 * bodies are left alone. The error object is marked as reported so an
 * uncaught rejection of it is not reported a second time.
 */
export class JsonResponseCollector implements Collector {
  private original: Response['json'] | null = null;
  private patched: Response['json'] | null = null;

  constructor(
    private readonly sink: CollectorSink,
    private readonly logger: Logger,
    private readonly isSdkUrl: (url: string) => boolean,
  ) {}

  install(): void {
    // Browser only, like every other automatic collector: never patch globals in a Node server.
    if (this.original !== null || getWindow() === null) return;
    if (typeof Response === 'undefined' || typeof Response.prototype.json !== 'function') return;
    const original = Response.prototype.json;
    const self = this;

    const patched = function trackedJson(this: Response): Promise<unknown> {
      const response = this;
      const callStack = new Error().stack;
      return original.call(response).then(null, function onParseError(error: unknown) {
        if (error instanceof Error && error.name === 'SyntaxError') {
          safelyRun(self.logger, 'invalid JSON report', function report() {
            const url = stripQuery(absoluteUrl(response.url || ''));
            if (self.isSdkUrl(url)) return;
            markReported(error);
            self.sink.onError(invalidJsonError(url, response.status, error, callStack));
          });
        }
        throw error;
      });
    };

    this.original = original;
    this.patched = patched;
    Response.prototype.json = patched;
  }

  uninstall(): void {
    if (this.original === null) return;
    // Only restore if nobody wrapped on top of us.
    if (Response.prototype.json === this.patched) Response.prototype.json = this.original;
    this.original = null;
    this.patched = null;
  }
}
