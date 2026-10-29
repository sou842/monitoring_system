import { absoluteUrl, getWindow, isOnline, nowMs, stripQuery } from '../core/env';
import { randomRequestId } from '../core/ids';
import { Logger } from '../core/logger';
import { safelyRun } from '../core/safe';
import { parseStack } from '../core/stackParser';
import { ApiCall, StackFrame } from '../types';
import { Collector } from './collector';

/**
 * Why a request ended without a response.
 * - `offline`: the browser reported no connectivity.
 * - `timeout`: the request timed out (`AbortSignal.timeout()`, `xhr.timeout`).
 * - `aborted`: the app cancelled it (`AbortController.abort()`, `xhr.abort()`).
 * - `network`: anything else the browser hides behind one generic error:
 *   connection refused, DNS failure, TLS/SSL failure, CORS rejection.
 */
export type NetworkFailure = 'offline' | 'timeout' | 'aborted' | 'network';

/** Extra information about a request, beyond the schema's `ApiCall` fields. */
export interface RequestDetails {
  /** Set when no HTTP response was received; `null` when one was. */
  failure: NetworkFailure | null;
  /** The value fetch rejected with, when it rejected. */
  error: unknown;
  /** Where in the app the request was made (SDK frames removed). Parsed lazily. */
  callSite(): StackFrame[];
  /** When the request started and ended, as `performance.now()` values. */
  startTime: number;
  endTime: number;
  /**
   * The absolute URL including its query string. Only used to find the
   * request's Resource Timing entry; never recorded or sent.
   */
  rawUrl: string;
}

/** What the fetch/XHR wrappers know about a finished request; the interceptor adds the timing fields. */
type WrapperDetails = Pick<RequestDetails, 'failure' | 'error' | 'callSite'>;

export type NetworkListener = (call: ApiCall, details: RequestDetails) => void;

interface TrackedXhr extends XMLHttpRequest {
  __et_method?: string;
  __et_url?: string;
  __et_failure?: NetworkFailure | null;
  /** The interceptor that added this XHR's listeners (once per object, even when reused). */
  __et_hooked?: NetworkInterceptor;
  /** Set by send(); only sent requests are recorded. */
  __et_sent?: boolean;
  /** Set once the request has been recorded, so later events don't record it again. */
  __et_done?: boolean;
  __et_start?: number;
  __et_callSite?: () => StackFrame[];
}

/** Frames added by the SDK (`rawStack` + the fetch/XHR wrapper), removed from call-site stacks. */
const WRAPPER_FRAMES = 2;

/** `XMLHttpRequest.OPENED`: open() was called; send() may start the request. */
const XHR_OPENED = 1;
/** `XMLHttpRequest.DONE`: the request has finished, with or without a response. */
const XHR_DONE = 4;

/** Classifies a fetch rejection. */
export function classifyFetchFailure(error: unknown): NetworkFailure {
  const name = error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError') return 'aborted';
  if (name === 'TimeoutError') return 'timeout';
  return isOnline() ? 'network' : 'offline';
}

/** Captures the current stack as a raw string, for later parsing. */
function rawStack(): string | undefined {
  try {
    return new Error().stack;
  } catch (_e) {
    return undefined;
  }
}

function lazyCallSite(stack: string | undefined): () => StackFrame[] {
  let parsed: StackFrame[] | null = null;
  return function callSite() {
    if (parsed === null) parsed = parseStack(stack).slice(WRAPPER_FRAMES);
    return parsed;
  };
}

/**
 * Wraps `fetch` and `XMLHttpRequest` once and fans each completed request out
 * to listeners (breadcrumbs, performance, HTTP/network errors). Requests to
 * the SDK's own endpoint are ignored. Query strings are stripped from
 * recorded URLs.
 *
 * The wrappers never alter request or response behaviour; listener failures
 * are isolated from the host app's request.
 */
export class NetworkInterceptor implements Collector {
  private listeners: NetworkListener[] = [];
  private installed = false;
  private originalFetch: typeof fetch | null = null;
  private patchedFetch: typeof fetch | null = null;
  private originalOpen: XMLHttpRequest['open'] | null = null;
  private originalSend: XMLHttpRequest['send'] | null = null;
  private originalAbort: XMLHttpRequest['abort'] | null = null;
  private patchedOpen: XMLHttpRequest['open'] | null = null;
  private patchedSend: XMLHttpRequest['send'] | null = null;
  private patchedAbort: XMLHttpRequest['abort'] | null = null;
  private readonly ignoredUrl: string;
  /** Requests started and not finished yet (the SDK's own excluded). */
  private inFlight = 0;

  constructor(
    sdkEndpoint: string,
    private readonly logger: Logger,
  ) {
    this.ignoredUrl = stripQuery(absoluteUrl(sdkEndpoint));
  }

  subscribe(listener: NetworkListener): void {
    this.listeners.push(listener);
  }

  /** Number of app requests that have started and not finished yet. */
  pendingRequests(): number {
    return this.inFlight;
  }

  /** True for the SDK's own ingestion endpoint, which must never be tracked. */
  isSdkUrl(rawUrl: string): boolean {
    return stripQuery(absoluteUrl(rawUrl)) === this.ignoredUrl;
  }

  install(): void {
    if (this.installed) return;
    const win = getWindow();
    if (win === null) return;
    this.installed = true;
    safelyRun(this.logger, 'fetch instrumentation', () => this.wrapFetch(win));
    safelyRun(this.logger, 'XHR instrumentation', () => this.wrapXhr());
  }

  uninstall(): void {
    if (!this.installed) return;
    const win = getWindow();
    if (win !== null) {
      // Only restore if nobody wrapped on top of us; otherwise we'd drop their wrapper.
      if (this.originalFetch !== null && win.fetch === this.patchedFetch) win.fetch = this.originalFetch;
      if (typeof XMLHttpRequest !== 'undefined') {
        const proto = XMLHttpRequest.prototype;
        if (this.originalOpen !== null && proto.open === this.patchedOpen) proto.open = this.originalOpen;
        if (this.originalSend !== null && proto.send === this.patchedSend) proto.send = this.originalSend;
        if (this.originalAbort !== null && proto.abort === this.patchedAbort) proto.abort = this.originalAbort;
      }
    }
    this.originalFetch = null;
    this.patchedFetch = null;
    this.originalOpen = null;
    this.originalSend = null;
    this.originalAbort = null;
    this.patchedOpen = null;
    this.patchedSend = null;
    this.patchedAbort = null;
    this.listeners = [];
    this.inFlight = 0;
    this.installed = false;
  }

  private requestStarted(rawUrl: string): void {
    if (!this.isSdkUrl(rawUrl)) this.inFlight++;
  }

  /** A started request that will never be emitted. */
  private requestAbandoned(rawUrl: string): void {
    if (!this.isSdkUrl(rawUrl) && this.inFlight > 0) this.inFlight--;
  }

  private emit(method: string, rawUrl: string, status: number, startedAt: number, wrapper: WrapperDetails): void {
    if (this.isSdkUrl(rawUrl)) return;
    if (this.inFlight > 0) this.inFlight--;
    const endTime = nowMs();
    const absolute = absoluteUrl(rawUrl);
    const call: ApiCall = {
      _id: randomRequestId(),
      url: stripQuery(absolute),
      method: method.toUpperCase(),
      status: status,
      duration_ms: Math.max(0, Math.round(endTime - startedAt)),
    };
    const details: RequestDetails = {
      failure: wrapper.failure,
      error: wrapper.error,
      callSite: wrapper.callSite,
      startTime: startedAt,
      endTime: endTime,
      rawUrl: absolute,
    };
    for (let i = 0; i < this.listeners.length; i++) {
      const listener = this.listeners[i];
      safelyRun(this.logger, 'network listener', function notify() {
        listener(call, details);
      });
    }
  }

  private wrapFetch(win: Window): void {
    if (typeof win.fetch !== 'function') return;
    const original = win.fetch;
    const self = this;
    this.originalFetch = original;

    const patched = function trackedFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const startedAt = nowMs();
      const callSite = lazyCallSite(rawStack());
      let method = 'GET';
      let url = '';
      safelyRun(self.logger, 'fetch argument parsing', function parse() {
        if (typeof input === 'string') {
          url = input;
        } else if (typeof URL !== 'undefined' && input instanceof URL) {
          url = input.href;
        } else {
          url = (input as Request).url;
          method = (input as Request).method || method;
        }
        if (init !== undefined && init !== null && typeof init.method === 'string') method = init.method;
        self.requestStarted(url);
      });

      let pending: Promise<Response>;
      try {
        pending = original.call(this === undefined ? win : this, input, init);
      } catch (error) {
        // A fetch replacement that throws instead of rejecting: the request never started.
        self.requestAbandoned(url);
        throw error;
      }
      return pending.then(
        function onResponse(response: Response) {
          self.emit(method, url, response.status, startedAt, { failure: null, error: null, callSite: callSite });
          return response;
        },
        function onError(error: unknown) {
          self.emit(method, url, 0, startedAt, { failure: classifyFetchFailure(error), error: error, callSite: callSite });
          throw error;
        },
      );
    } as typeof fetch;

    this.patchedFetch = patched;
    win.fetch = patched;
  }

  /**
   * Records an XHR the first time it is seen to be finished. The browser fires
   * `readystatechange` (DONE), then `load`/`error`/`abort`/`timeout`, then
   * `loadend`; libraries like jQuery run the app's callbacks on the earlier
   * ones, so waiting for `loadend` would record the request only after an
   * error reported from those callbacks had already been built without it.
   */
  private finishXhr(xhr: TrackedXhr): void {
    // Listeners stay on XHR objects after uninstall(); a later install must still be able to record them.
    if (!this.installed || !xhr.__et_sent || xhr.__et_done) return;
    // Every real finish happens at DONE. A late event of the previous request after the
    // app re-opened the XHR in its onload (polling, retries) sees OPENED: not this request.
    if (xhr.readyState !== XHR_DONE) return;
    xhr.__et_done = true;
    const startedAt = xhr.__et_start || nowMs();
    let failure = xhr.__et_failure || null;
    if (failure === null && xhr.status === 0) {
      // At DONE the failure event hasn't fired yet. abort() is wrapped, so
      // only a timeout can still be mistaken for a plain network failure.
      const timedOut = xhr.timeout > 0 && nowMs() - startedAt >= xhr.timeout;
      failure = timedOut ? 'timeout' : isOnline() ? 'network' : 'offline';
    }
    this.emit(xhr.__et_method || 'GET', xhr.__et_url || '', xhr.status, startedAt, {
      failure: failure,
      error: null,
      callSite: xhr.__et_callSite || lazyCallSite(undefined),
    });
  }

  /**
   * Adds the XHR's listeners in open(), not send(): apps (and jQuery) attach
   * their `onload`/`onreadystatechange` handlers after open(), so ours run
   * first and the request is recorded before the app hears about it.
   */
  private hookXhr(xhr: TrackedXhr): void {
    if (xhr.__et_hooked === this) return;
    xhr.__et_hooked = this;
    const self = this;
    const finishWith = function finishWith(kind: NetworkFailure | null) {
      return function onFinished() {
        safelyRun(self.logger, 'XHR tracking', function finish() {
          if (kind !== null && !xhr.__et_failure) xhr.__et_failure = kind;
          self.finishXhr(xhr);
        });
      };
    };
    xhr.addEventListener('readystatechange', function onReadyStateChange() {
      if (xhr.readyState === XHR_DONE) finishWith(null)();
    });
    xhr.addEventListener('load', finishWith(null));
    xhr.addEventListener('abort', finishWith('aborted'));
    xhr.addEventListener('timeout', finishWith('timeout'));
    xhr.addEventListener('error', function onError() {
      // Checked at failure time: connectivity may have changed since send().
      finishWith(isOnline() ? 'network' : 'offline')();
    });
    xhr.addEventListener('loadend', finishWith(null));
  }

  private wrapXhr(): void {
    if (typeof XMLHttpRequest === 'undefined') return;
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalAbort = proto.abort;
    const self = this;
    this.originalOpen = originalOpen;
    this.originalSend = originalSend;
    this.originalAbort = originalAbort;

    proto.open = function trackedOpen(this: TrackedXhr, method: string, url: string | URL) {
      safelyRun(self.logger, 'XHR open tracking', () => {
        // open() on a running request cancels it without any event: it will never finish.
        if (this.__et_sent && !this.__et_done) self.requestAbandoned(this.__et_url || '');
        this.__et_method = method;
        this.__et_url = typeof url === 'string' ? url : url.href;
        this.__et_failure = null;
        this.__et_sent = false;
        this.__et_done = false;
        self.hookXhr(this);
      });
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(this, arguments as unknown as Parameters<XMLHttpRequest['open']>);
    } as XMLHttpRequest['open'];

    proto.send = function trackedSend(this: TrackedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this;
      safelyRun(self.logger, 'XHR send tracking', function track() {
        // send() only starts a request on an opened, not yet sent XHR; otherwise it throws
        // and the request in progress (or just finished) must keep its tracking state.
        if (xhr.readyState !== XHR_OPENED || xhr.__et_sent) return;
        self.hookXhr(xhr); // opened before the SDK was installed
        xhr.__et_start = nowMs();
        xhr.__et_callSite = lazyCallSite(rawStack());
        xhr.__et_failure = null;
        xhr.__et_sent = true;
        xhr.__et_done = false;
        self.requestStarted(xhr.__et_url || '');
      });
      return originalSend.call(this, body);
    };

    // abort() fires readystatechange (DONE) before the abort event, so mark it first.
    // Only an in-flight request: abort() before send() or after the end changes nothing.
    proto.abort = function trackedAbort(this: TrackedXhr) {
      safelyRun(self.logger, 'XHR abort tracking', () => {
        if (this.__et_sent && !this.__et_done) this.__et_failure = 'aborted';
      });
      return originalAbort.call(this);
    };
    this.patchedOpen = proto.open;
    this.patchedSend = proto.send;
    this.patchedAbort = proto.abort;
  }
}
