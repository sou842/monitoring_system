import {
  API_KEY_HEADER,
  CONTENT_TYPE_JSON,
  HTTP_STATUS_OK_MAX,
  HTTP_STATUS_OK_MIN,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVER_ERROR_MIN,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  REQUEST_TIMEOUT_MS,
} from '../constants';
import { Logger } from '../core/logger';
import { withField } from '../core/payloadBuilder';
import { AttemptResult } from '../core/retryManager';
import { EventBatch, TrackerEvent } from '../types';

/** Anything that can deliver a batch of events. */
export interface Transport {
  send(events: TrackerEvent[]): Promise<AttemptResult>;
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

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      controller !== null
        ? setTimeout(function abort() {
            controller.abort();
          }, REQUEST_TIMEOUT_MS)
        : null;

    const headers: Record<string, string> = { 'Content-Type': CONTENT_TYPE_JSON };
    headers[API_KEY_HEADER] = this.apiKey;

    const logger = this.logger;
    return this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: headers,
      body: body,
      credentials: 'omit',
      signal: controller !== null ? controller.signal : undefined,
    }).then(
      function onResponse(response) {
        if (timer !== null) clearTimeout(timer);
        const result = classifyStatus(response.status);
        if (!result.ok) logger.warn('endpoint responded with status ' + response.status);
        return result;
      },
      function onNetworkError(error: unknown): AttemptResult {
        if (timer !== null) clearTimeout(timer);
        logger.warn('network error while sending events', error);
        return { ok: false, retryable: true, status: null };
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
