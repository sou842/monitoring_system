import { MAX_MESSAGE_LENGTH } from '../constants';
import { originOf, responseInfo, ResponseInfo } from '../core/diagnosis';
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

/** Parser messages for a body that ended too early (Chrome, Firefox, Safari). */
const END_OF_INPUT = /unexpected end of (json )?input|unexpected end of data|unexpected eof/i;
/**
 * Parser messages for a body that starts with `<`. Safari: "Unrecognized token
 * '<'". Chrome: "Unexpected token '<', "<!DOCTYPE "... is not valid JSON",
 * where the quoted part is the start of the body; when it starts with
 * something else, the `<` was inside the JSON (e.g. an HTML string value), so
 * this is not an HTML page.
 */
const STARTS_WITH_TAG = /token '<'(?!, "\s*[^<\s])/i;

/**
 * What came back instead of JSON, judged from the parser's message and the
 * response headers (the body itself is never read or sent):
 * - `html_page`: an HTML page (login redirect, proxy or server error page, SPA fallback);
 * - `empty_body`: nothing (`Content-Length: 0`);
 * - `incomplete_json`: a complete response whose JSON stops early (or is only
 *   whitespace): a server-side bug. A transfer cut off by the network fails as
 *   a network error instead and never gets here;
 * - `empty_or_incomplete`: the JSON ended early and the length is unknown;
 * - `malformed_json`: served as JSON but not valid JSON;
 * - `not_json`: some other content.
 */
export type InvalidJsonCause = 'html_page' | 'empty_body' | 'incomplete_json' | 'empty_or_incomplete' | 'malformed_json' | 'not_json';

/** Classifies an invalid JSON body; see `InvalidJsonCause`. */
export function classifyInvalidJson(reason: string, info: ResponseInfo | null): InvalidJsonCause {
  const type = info !== null && info.contentType !== null ? info.contentType.toLowerCase() : '';
  const length = info !== null ? info.contentLength : null;
  if (END_OF_INPUT.test(reason)) {
    if (length === 0) return 'empty_body';
    return length !== null ? 'incomplete_json' : 'empty_or_incomplete';
  }
  if (type.indexOf('html') !== -1 || STARTS_WITH_TAG.test(reason)) return 'html_page';
  if (type.indexOf('json') !== -1) return 'malformed_json';
  return 'not_json';
}

/**
 * Builds the error for a response body that could not be parsed as JSON.
 * @param url the response URL (query removed)
 * @param status the response status
 * @param cause the parser's error
 * @param callStack stack captured where the app called `json()`
 * @param info the response's content type, length and server ids, when available
 */
export function invalidJsonError(
  url: string,
  status: number,
  cause: unknown,
  callStack: string | undefined,
  info: ResponseInfo | null = null,
): CapturedError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const origin = originOf(url);
  return {
    error: {
      message: truncate('Invalid JSON from ' + url + ' (status ' + status + '): ' + reason, MAX_MESSAGE_LENGTH),
      type: INVALID_JSON_TYPE,
      // The parse error was handed back to the app's code.
      handled: true,
    },
    stacktrace: parseStack(callStack).slice(WRAPPER_FRAMES),
    context: {
      url: url,
      status: status,
      cause: classifyInvalidJson(reason, info),
      content_type: info !== null ? info.contentType : null,
      content_length: info !== null ? info.contentLength : null,
      response_headers: info !== null ? info.serverIds : null,
      host: origin.host,
      cross_origin: origin.crossOrigin,
    },
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
            const info = responseInfo(function get(name: string) {
              return response.headers.get(name);
            });
            self.sink.onError(invalidJsonError(url, response.status, error, callStack, info));
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
