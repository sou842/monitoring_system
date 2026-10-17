import { absoluteUrl, getWindow, isOnline, nowMs, stripQuery } from '../core/env';
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
}

export type NetworkListener = (call: ApiCall, details: RequestDetails) => void;

interface TrackedXhr extends XMLHttpRequest {
  __et_method?: string;
  __et_url?: string;
  __et_failure?: NetworkFailure | null;
}

/** Frames added by the SDK (`rawStack` + the fetch/XHR wrapper), removed from call-site stacks. */
const WRAPPER_FRAMES = 2;

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
  private patchedOpen: XMLHttpRequest['open'] | null = null;
  private patchedSend: XMLHttpRequest['send'] | null = null;
  private readonly ignoredUrl: string;

  constructor(
    sdkEndpoint: string,
    private readonly logger: Logger,
  ) {
    this.ignoredUrl = stripQuery(absoluteUrl(sdkEndpoint));
  }

  subscribe(listener: NetworkListener): void {
    this.listeners.push(listener);
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
      }
    }
    this.originalFetch = null;
    this.patchedFetch = null;
    this.originalOpen = null;
    this.originalSend = null;
    this.patchedOpen = null;
    this.patchedSend = null;
    this.listeners = [];
    this.installed = false;
  }

  private emit(method: string, rawUrl: string, status: number, startedAt: number, details: RequestDetails): void {
    if (this.isSdkUrl(rawUrl)) return;
    const call: ApiCall = {
      url: stripQuery(absoluteUrl(rawUrl)),
      method: method.toUpperCase(),
      status: status,
      duration_ms: Math.max(0, Math.round(nowMs() - startedAt)),
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
      });

      return original.call(this === undefined ? win : this, input, init).then(
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

  private wrapXhr(): void {
    if (typeof XMLHttpRequest === 'undefined') return;
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const self = this;
    this.originalOpen = originalOpen;
    this.originalSend = originalSend;

    proto.open = function trackedOpen(this: TrackedXhr, method: string, url: string | URL) {
      safelyRun(self.logger, 'XHR open tracking', () => {
        this.__et_method = method;
        this.__et_url = typeof url === 'string' ? url : url.href;
        this.__et_failure = null;
      });
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(this, arguments as unknown as Parameters<XMLHttpRequest['open']>);
    } as XMLHttpRequest['open'];

    proto.send = function trackedSend(this: TrackedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this;
      safelyRun(self.logger, 'XHR send tracking', function track() {
        const startedAt = nowMs();
        const callSite = lazyCallSite(rawStack());
        const markFailure = function mark(kind: NetworkFailure) {
          return function onFailure() {
            xhr.__et_failure = kind;
          };
        };
        xhr.addEventListener('abort', markFailure('aborted'));
        xhr.addEventListener('timeout', markFailure('timeout'));
        xhr.addEventListener('error', function onError() {
          // Checked at failure time: connectivity may have changed since send().
          xhr.__et_failure = isOnline() ? 'network' : 'offline';
        });
        xhr.addEventListener('loadend', function onLoadEnd() {
          let failure = xhr.__et_failure || null;
          // Status 0 with no failure event still means no response (e.g. CORS).
          if (failure === null && xhr.status === 0) failure = isOnline() ? 'network' : 'offline';
          self.emit(xhr.__et_method || 'GET', xhr.__et_url || '', xhr.status, startedAt, {
            failure: failure,
            error: null,
            callSite: callSite,
          });
        });
      });
      return originalSend.call(this, body);
    };
    this.patchedOpen = proto.open;
    this.patchedSend = proto.send;
  }
}
