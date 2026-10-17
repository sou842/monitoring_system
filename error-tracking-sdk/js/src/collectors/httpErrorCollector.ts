import { HTTP_ERROR_STATUS_MIN, MAX_MESSAGE_LENGTH } from '../constants';
import { truncate } from '../core/serialize';
import { ApiCall } from '../types';
import { CapturedError, Collector, CollectorSink } from './collector';
import { NetworkInterceptor } from './networkInterceptor';

const HTTP_ERROR_TYPE = 'HttpError';

/** Builds the error for a failed response, e.g. `GET /api/cart → 500`. */
export function httpErrorFromCall(call: ApiCall): CapturedError {
  return {
    error: {
      message: truncate(call.method + ' ' + call.url + ' → ' + call.status, MAX_MESSAGE_LENGTH),
      type: HTTP_ERROR_TYPE,
      // The request did not throw; the app received the response and decides what to do with it.
      handled: true,
    },
    stacktrace: [],
  };
}

/**
 * Reports every fetch/XHR response with a 4xx or 5xx status as an `error`
 * event. Requests that never got a response (status 0) are not reported
 * here: they surface as rejected promises / XHR errors, and aborted requests
 * would otherwise create noise.
 */
export class HttpErrorCollector implements Collector {
  private installed = false;

  constructor(
    private readonly sink: CollectorSink,
    private readonly network: NetworkInterceptor,
  ) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const self = this;
    this.network.subscribe(function onApiCall(call) {
      if (self.installed && call.status >= HTTP_ERROR_STATUS_MIN) self.sink.onError(httpErrorFromCall(call));
    });
  }

  uninstall(): void {
    // The interceptor drops all listeners on its own uninstall; this flag
    // covers the window between the two.
    this.installed = false;
  }
}
