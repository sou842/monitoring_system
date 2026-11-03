import {
  HTTP_STATUS_SERVER_ERROR_MIN,
  MAX_HOST_FAILURES_TRACKED,
  MAX_MESSAGE_LENGTH,
  SAME_HOST_WINDOW_MS,
} from '../constants';
import { BoundedRecord, originOf } from '../core/diagnosis';
import { markReported } from '../core/reportedErrors';
import { truncate } from '../core/serialize';
import { ApiCall, JsonObject } from '../types';
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

/** How one server has been doing on this page, just before a request finished. */
export interface HostHealth {
  /** Requests to this host that failed (no response or 5xx) in the last `SAME_HOST_WINDOW_MS`. */
  failuresBefore: number;
  /** Time since this host last answered without a 5xx, or null if it never has on this page. */
  msSinceOk: number | null;
}

/**
 * Remembers, per host, when it last answered fine and when it recently
 * failed. "Failed 3 times in the last minute, never answered" points at the
 * server being down; "answered 2 s ago" points at this one request (or the
 * user's network).
 */
export class HostTracker {
  /** Per host; beyond `MAX_TRACKED_HOSTS` the least recently seen host is forgotten. */
  private readonly hosts = new BoundedRecord(function create(): { lastOk: number | null; failures: number[] } {
    return { lastOk: null, failures: [] };
  });

  /**
   * Records a finished request and returns the host's state from before it.
   * @param host the request's host
   * @param at when it finished (`performance.now()`)
   * @param outcome `ok` (answered without 5xx), `failed` (no response or 5xx) or `ignored` (cancelled)
   */
  record(host: string, at: number, outcome: 'ok' | 'failed' | 'ignored'): HostHealth {
    const state = this.hosts.get(host);
    const recent: number[] = [];
    for (let i = 0; i < state.failures.length; i++) {
      if (at - state.failures[i] <= SAME_HOST_WINDOW_MS) recent.push(state.failures[i]);
    }
    const health: HostHealth = {
      failuresBefore: recent.length,
      msSinceOk: state.lastOk !== null ? Math.max(0, Math.round(at - state.lastOk)) : null,
    };
    if (outcome === 'failed') {
      recent.push(at);
      if (recent.length > MAX_HOST_FAILURES_TRACKED) recent.shift();
    } else if (outcome === 'ok') {
      state.lastOk = at;
    }
    state.failures = recent;
    return health;
  }
}

/** Fields both HTTP and network errors carry: where the request went and how that server has been doing. */
function hostContext(call: ApiCall, health: HostHealth | null): JsonObject {
  const origin = originOf(call.url);
  return {
    host: origin.host,
    cross_origin: origin.crossOrigin,
    same_host_failures: health !== null ? health.failuresBefore : null,
    ms_since_host_ok: health !== null ? health.msSinceOk : null,
  };
}

function copyInto(target: JsonObject, source: JsonObject): JsonObject {
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
  }
  return target;
}

/**
 * Builds the error for a response with an error status, e.g. `GET /api/cart → 500`.
 * @param call the request
 * @param details what the interceptor knows about it (call site, response headers)
 * @param health the host's state before this request, if tracked
 */
export function httpErrorFromCall(call: ApiCall, details?: RequestDetails, health?: HostHealth): CapturedError {
  const response = details !== undefined && details.response !== undefined ? details.response() : null;
  const context: JsonObject = {
    _id: call._id,
    url: call.url,
    method: call.method,
    status: call.status,
    duration_ms: call.duration_ms,
    cause: call.status >= HTTP_STATUS_SERVER_ERROR_MIN ? 'server_error' : 'client_error',
    content_type: response !== null ? response.contentType : null,
    response_headers: response !== null ? response.serverIds : null,
  };
  return {
    error: {
      message: truncate(call.method + ' ' + call.url + ' → ' + call.status, MAX_MESSAGE_LENGTH),
      type: HTTP_ERROR_TYPE,
      // The request did not throw; the app received the response and decides what to do with it.
      handled: true,
    },
    stacktrace: details !== undefined ? details.callSite() : [],
    context: copyInto(context, hostContext(call, health !== undefined ? health : null)),
  };
}

/**
 * Builds the error for a request that never got a response.
 * @param call the request
 * @param details what the interceptor knows about it (failure kind, call site)
 * @param health the host's state before this request, if tracked
 */
export function networkErrorFromCall(call: ApiCall, details: RequestDetails, health?: HostHealth): CapturedError {
  const failure = details.failure !== null ? details.failure : 'network';
  const context: JsonObject = {
    _id: call._id,
    url: call.url,
    method: call.method,
    failure: failure,
    duration_ms: call.duration_ms,
    cause: failure,
  };
  return {
    error: {
      message: truncate(call.method + ' ' + call.url + ' failed: ' + FAILURE_DESCRIPTIONS[failure], MAX_MESSAGE_LENGTH),
      type: NETWORK_ERROR_TYPE,
      // The failure was handed back to the app (rejected promise / XHR error event).
      handled: true,
    },
    stacktrace: details.callSite(),
    context: copyInto(context, hostContext(call, health !== undefined ? health : null)),
  };
}

export interface HttpErrorOptions {
  /** Report responses whose status is in `httpErrorStatuses`. */
  httpErrors: boolean;
  /** Inclusive `[min, max]` status ranges reported as HttpError. */
  httpErrorStatuses: ReadonlyArray<[number, number]>;
  /** Report requests that got no response (except user aborts). */
  networkErrors: boolean;
}

/**
 * Turns failed fetch/XHR requests into `error` events:
 * - `HttpError` for responses whose status is in `httpErrorStatuses`;
 * - `NetworkError` for requests that never got a response (offline, timeout,
 *   connection refused, DNS/SSL failure, CORS). Requests the app cancelled
 *   itself are not errors and are skipped.
 *
 * Each event's stack trace points at the line of app code that made the
 * request, and its context says how the same server has been doing on this
 * page (recent failures, last good answer) plus the server's request id from
 * the response headers, when the browser shows them.
 * The rejection value of a failed fetch is marked as reported, so if the app
 * leaves that promise uncaught it is not reported a second time.
 */
export class HttpErrorCollector implements Collector {
  private installed = false;
  private readonly hosts = new HostTracker();

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
    const host = originOf(call.url).host;
    const outcome =
      details.failure === 'aborted' ? 'ignored' : details.failure !== null || call.status >= HTTP_STATUS_SERVER_ERROR_MIN ? 'failed' : 'ok';
    const health = host !== null ? this.hosts.record(host, details.endTime, outcome) : undefined;

    if (details.failure === null) {
      if (this.options.httpErrors && this.isErrorStatus(call.status)) this.sink.onError(httpErrorFromCall(call, details, health));
      return;
    }
    if (!this.options.networkErrors || details.failure === 'aborted') return;
    markReported(details.error);
    this.sink.onError(networkErrorFromCall(call, details, health));
  }

  private isErrorStatus(status: number): boolean {
    const ranges = this.options.httpErrorStatuses;
    for (let i = 0; i < ranges.length; i++) {
      if (status >= ranges[i][0] && status <= ranges[i][1]) return true;
    }
    return false;
  }
}
