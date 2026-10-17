import { absoluteUrl, getWindow, nowMs, stripQuery } from '../core/env';
import { Logger } from '../core/logger';
import { safelyRun } from '../core/safe';
import { ApiCall } from '../types';
import { Collector } from './collector';

export type NetworkListener = (call: ApiCall) => void;

interface TrackedXhr extends XMLHttpRequest {
  __et_method?: string;
  __et_url?: string;
}

/**
 * Wraps `fetch` and `XMLHttpRequest` once and fans each completed request out
 * to listeners (breadcrumbs, performance). Requests to the SDK's own endpoint
 * are ignored. Query strings are stripped from recorded URLs.
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

  private emit(method: string, rawUrl: string, status: number, startedAt: number): void {
    const url = stripQuery(absoluteUrl(rawUrl));
    if (url === this.ignoredUrl) return;
    const call: ApiCall = {
      url: url,
      method: method.toUpperCase(),
      status: status,
      duration_ms: Math.max(0, Math.round(nowMs() - startedAt)),
    };
    for (let i = 0; i < this.listeners.length; i++) {
      const listener = this.listeners[i];
      safelyRun(this.logger, 'network listener', function notify() {
        listener(call);
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
          self.emit(method, url, response.status, startedAt);
          return response;
        },
        function onError(error: unknown) {
          self.emit(method, url, 0, startedAt);
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
      });
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(this, arguments as unknown as Parameters<XMLHttpRequest['open']>);
    } as XMLHttpRequest['open'];

    proto.send = function trackedSend(this: TrackedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this;
      safelyRun(self.logger, 'XHR send tracking', function track() {
        const startedAt = nowMs();
        xhr.addEventListener('loadend', function onLoadEnd() {
          self.emit(xhr.__et_method || 'GET', xhr.__et_url || '', xhr.status, startedAt);
        });
      });
      return originalSend.call(this, body);
    };
    this.patchedOpen = proto.open;
    this.patchedSend = proto.send;
  }
}
