import {
  API_KEY_HEADER,
  CONTENT_TYPE_JSON,
  HTTP_STATUS_OK_MAX,
  HTTP_STATUS_OK_MIN,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVER_ERROR_MIN,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  KEEPALIVE_MAX_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../constants';
import { isPageVisible } from '../core/env';
import { Logger } from '../core/logger';
import { withField } from '../core/payloadBuilder';
import { AttemptResult } from '../core/retryManager';
import { EventBatch, TrackerEvent } from '../types';

/** Anything that can deliver a batch of events. */
export interface Transport {
  send(events: TrackerEvent[]): Promise<AttemptResult>;
  /** Optional: hand events to a request that outlives the page. True if it was sent. */
  sendOnUnload?(events: TrackerEvent[]): boolean;
}

type FetchFn = typeof fetch;

/** Classifies an HTTP status into the retry decision used by the queue. */
export function classifyStatus(status: number): AttemptResult {
  const ok = status >= HTTP_STATUS_OK_MIN && status <= HTTP_STATUS_OK_MAX;
  const retryable =
    !ok &&
    (status >= HTTP_STATUS_SERVER_ERROR_MIN ||
      status === HTTP_STATUS_REQUEST_TIMEOUT ||
      status === HTTP_STATUS_TOO_MANY_REQUESTS);
  return { ok: ok, retryable: retryable, status: status };
}

/**
 * POSTs batches as JSON using `fetch`. The API key is applied here, at send
 * time, so it never needs to be written to persistent storage.
 */
export class HttpTransport implements Transport {
  private readonly fetchFn: FetchFn | null;
  /** Turned off after a browser refuses a keepalive request. */
  private keepaliveAllowed = true;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly logger: Logger,
    fetchFn?: FetchFn,
  ) {
    // Capture fetch now, before the network collector wraps it, so the SDK's
    // own requests are never recorded as breadcrumbs or API calls.
    if (fetchFn !== undefined) {
      this.fetchFn = fetchFn;
    } else if (typeof fetch === 'function') {
      this.fetchFn = fetch.bind(typeof window !== 'undefined' ? window : undefined);
    } else {
      this.fetchFn = null;
    }
  }

  send(events: TrackerEvent[]): Promise<AttemptResult> {
    if (this.fetchFn === null) {
      this.logger.warn('fetch is not available in this environment; events cannot be sent');
      return Promise.resolve<AttemptResult>({ ok: false, retryable: false, status: null });
    }

    let body: string;
    try {
      body = this.serialize(events);
    } catch (e) {
      this.logger.warn('failed to serialize batch; dropping it', e);
      return Promise.resolve<AttemptResult>({ ok: false, retryable: false, status: null });
    }

    const logger = this.logger;
    const self = this;
    // While the page is hidden it may be about to unload, which cancels a
    // normal request; `keepalive` lets it finish. Browsers cap keepalive
    // bodies (64 KB in total), so only small batches use it.
    const keepalive = this.keepaliveAllowed && body.length <= KEEPALIVE_MAX_BYTES && !isPageVisible();
    const attempt = keepalive
      ? this.post(body, true).then(null, function withoutKeepalive(error: unknown) {
          // Some browsers refuse keepalive for requests that need a CORS preflight: send it normally, and stop trying.
          logger.warn('keepalive request failed; retrying without keepalive', error);
          self.keepaliveAllowed = false;
          return self.post(body, false);
        })
      : this.post(body, false);

    return attempt.then(
      function onResponse(response) {
        const result = classifyStatus(response.status);
        if (!result.ok) logger.warn('endpoint responded with status ' + response.status);
        return result;
      },
      function onNetworkError(error: unknown): AttemptResult {
        logger.warn('network error while sending events', error);
        return { ok: false, retryable: true, status: null };
      },
    );
  }

  /**
   * The page is unloading: sends `events` in one keepalive request, which the
   * browser finishes after the page is gone. Fire-and-forget (there is no page
   * left to hear the answer). Returns false when the batch is too large for
   * keepalive or keepalive is unavailable, so the caller can persist it.
   */
  sendOnUnload(events: TrackerEvent[]): boolean {
    if (this.fetchFn === null || !this.keepaliveAllowed) return false;
    let body: string;
    try {
      body = this.serialize(events);
    } catch (_e) {
      return false;
    }
    if (body.length > KEEPALIVE_MAX_BYTES) return false;
    const headers: Record<string, string> = { 'Content-Type': CONTENT_TYPE_JSON };
    headers[API_KEY_HEADER] = this.apiKey;
    try {
      this.fetchFn(this.endpoint, { method: 'POST', headers: headers, body: body, credentials: 'omit', keepalive: true }).then(null, function ignore() {
        // Nothing can be done any more; the page is gone.
      });
      return true;
    } catch (_e) {
      return false;
    }
  }

  /** One POST with a timeout. Never throws synchronously. */
  private post(body: string, keepalive: boolean): Promise<Response> {
    const fetchFn = this.fetchFn;
    if (fetchFn === null) return Promise.reject(new Error('fetch is not available'));
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      controller !== null
        ? setTimeout(function abort() {
            controller.abort();
          }, REQUEST_TIMEOUT_MS)
        : null;
    const headers: Record<string, string> = { 'Content-Type': CONTENT_TYPE_JSON };
    headers[API_KEY_HEADER] = this.apiKey;
    const init: RequestInit = {
      method: 'POST',
      headers: headers,
      body: body,
      credentials: 'omit',
      signal: controller !== null ? controller.signal : undefined,
    };
    if (keepalive) init.keepalive = true;

    let pending: Promise<Response>;
    try {
      pending = fetchFn(this.endpoint, init);
    } catch (e) {
      pending = Promise.reject(e);
    }
    return pending.then(
      function done(response) {
        if (timer !== null) clearTimeout(timer);
        return response;
      },
      function failed(error: unknown): Promise<Response> {
        if (timer !== null) clearTimeout(timer);
        return Promise.reject(error);
      },
    );
  }

  private serialize(events: TrackerEvent[]): string {
    const apiKey = this.apiKey;
    const batch: EventBatch = {
      events: events.map(function stamp(event) {
        return withField(event, 'api_key', apiKey);
      }),
    };
    return JSON.stringify(batch);
  }
}
