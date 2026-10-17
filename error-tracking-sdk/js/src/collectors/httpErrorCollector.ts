import { HTTP_ERROR_STATUS_MIN, MAX_MESSAGE_LENGTH } from '../constants';
import { markReported } from '../core/reportedErrors';
import { truncate } from '../core/serialize';
import { ApiCall } from '../types';
import { CapturedError, Collector, CollectorSink } from './collector';
import { NetworkFailure, NetworkInterceptor, RequestDetails } from './networkInterceptor';

const HTTP_ERROR_TYPE = 'HttpError';
const NETWORK_ERROR_TYPE = 'NetworkError';

const FAILURE_DESCRIPTIONS: Record<NetworkFailure, string> = {
  offline: 'device offline',
  timeout: 'timed out',
  aborted: 'aborted',
  network: 'no response (connection refused, DNS, SSL or CORS)',
};

/** Builds the error for a response with an error status, e.g. `GET /api/cart → 500`. */
export function httpErrorFromCall(call: ApiCall, details?: RequestDetails): CapturedError {
  return {
    error: {
      message: truncate(call.method + ' ' + call.url + ' → ' + call.status, MAX_MESSAGE_LENGTH),
      type: HTTP_ERROR_TYPE,
      // The request did not throw; the app received the response and decides what to do with it.
      handled: true,
    },
    stacktrace: details !== undefined ? details.callSite() : [],
    context: { url: call.url, method: call.method, status: call.status, duration_ms: call.duration_ms },
  };
}

/** Builds the error for a request that never got a response. */
export function networkErrorFromCall(call: ApiCall, details: RequestDetails): CapturedError {
  const failure = details.failure !== null ? details.failure : 'network';
  return {
    error: {
      message: truncate(call.method + ' ' + call.url + ' failed: ' + FAILURE_DESCRIPTIONS[failure], MAX_MESSAGE_LENGTH),
      type: NETWORK_ERROR_TYPE,
      // The failure was handed back to the app (rejected promise / XHR error event).
      handled: true,
    },
    stacktrace: details.callSite(),
    context: { url: call.url, method: call.method, failure: failure, duration_ms: call.duration_ms },
  };
}

export interface HttpErrorOptions {
  /** Report 4xx/5xx responses. */
  httpErrors: boolean;
  /** Report requests that got no response (except user aborts). */
  networkErrors: boolean;
}

/**
 * Turns failed fetch/XHR requests into `error` events:
 * - `HttpError` for responses with a 4xx or 5xx status;
 * - `NetworkError` for requests that never got a response (offline, timeout,
 *   connection refused, DNS/SSL failure, CORS). Requests the app cancelled
 *   itself are not errors and are skipped.
 *
 * Each event's stack trace points at the line of app code that made the request.
 * The rejection value of a failed fetch is marked as reported, so if the app
 * leaves that promise uncaught it is not reported a second time.
 */
export class HttpErrorCollector implements Collector {
  private installed = false;

  constructor(
    private readonly sink: CollectorSink,
    private readonly network: NetworkInterceptor,
    private readonly options: HttpErrorOptions,
  ) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const self = this;
    this.network.subscribe(function onApiCall(call, details) {
      if (self.installed) self.handle(call, details);
    });
  }

  uninstall(): void {
    // The interceptor drops all listeners on its own uninstall; this flag
    // covers the window between the two.
    this.installed = false;
  }

  private handle(call: ApiCall, details: RequestDetails): void {
    if (details.failure === null) {
      if (this.options.httpErrors && call.status >= HTTP_ERROR_STATUS_MIN) this.sink.onError(httpErrorFromCall(call, details));
      return;
    }
    if (!this.options.networkErrors || details.failure === 'aborted') return;
    markReported(details.error);
    this.sink.onError(networkErrorFromCall(call, details));
  }
}
