import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFromThrown, ErrorCollector, scriptsWithoutCrossorigin } from '../src/collectors/errorCollector';
import { HostTracker, httpErrorFromCall, HttpErrorCollector } from '../src/collectors/httpErrorCollector';
import { classifyInvalidJson } from '../src/collectors/jsonResponseCollector';
import { NetworkInterceptor, RequestDetails } from '../src/collectors/networkInterceptor';
import { earlyElementResourceError } from '../src/collectors/resourceCollector';
import { classifyResourceFailure, describeFailedElement, ResourceTimingEntry } from '../src/collectors/resourceDiagnosis';
import {
  causeChain,
  errorProps,
  headerLookup,
  mergeContext,
  originOf,
  responseInfo,
  serverIdHeaders,
  situation,
  thrownDetails,
  withSituation,
} from '../src/core/diagnosis';
import { Logger } from '../src/core/logger';
import { ErrorTracker } from '../src/index';
import { ApiCall, TrackerEvent } from '../src/types';
import { RecordingSink } from './helpers';

const logger = new Logger(false);

/** `new Error(message, { cause })` without needing the ES2022 lib types. */
function withCause<E extends Error>(error: E, cause: unknown): E {
  (error as E & { cause: unknown }).cause = cause;
  return error;
}

function entry(fields: Partial<ResourceTimingEntry>): ResourceTimingEntry {
  return { name: 'x', entryType: 'resource', startTime: performance.now(), duration: 120.4, toJSON: () => ({}), ...fields } as ResourceTimingEntry;
}

/** Makes `performance.getEntriesByName` return `entries` for one test. */
function stubTimingEntries(entries: ResourceTimingEntry[], total = entries.length): () => void {
  const perf = performance as Performance & Record<string, unknown>;
  const byName = perf.getEntriesByName;
  const byType = perf.getEntriesByType;
  Object.defineProperty(perf, 'getEntriesByName', { configurable: true, writable: true, value: (name: string) => entries.filter((e) => e.name === name) });
  Object.defineProperty(perf, 'getEntriesByType', { configurable: true, writable: true, value: () => new Array(total).fill(entries[0]) });
  return () => {
    Object.defineProperty(perf, 'getEntriesByName', { configurable: true, writable: true, value: byName });
    Object.defineProperty(perf, 'getEntriesByType', { configurable: true, writable: true, value: byType });
  };
}

describe('origin and situation', () => {
  it('splits a URL into host and cross-origin', () => {
    expect(originOf('/img/a.png')).toEqual({ host: location.host, crossOrigin: false });
    expect(originOf('https://open.spotifycdn.com/cdn/a.png')).toEqual({ host: 'open.spotifycdn.com', crossOrigin: true });
    expect(originOf('data:image/png;base64,AAA')).toEqual({ host: null, crossOrigin: null });
  });

  it('describes the page and network at the moment of the event', () => {
    const nav = performance.now() - 1500;
    const state = situation(nav);
    expect(state).toMatchObject({ online: true, visibility: 'visible', during_page_load: false });
    expect(state.ms_since_navigation).toBeGreaterThanOrEqual(1500);
    expect(typeof state.ms_since_page_load).toBe('number');
    expect(situation(null).ms_since_navigation).toBeNull();
    // jsdom has no navigator.connection (Chromium only).
    expect(state.connection).toBeNull();
  });

  it('reports no page age outside a page (server errors), where performance.now() is the process uptime', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(situation(null)).toMatchObject({ ms_since_page_load: null, visibility: null, during_page_load: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('adds situation without overwriting one the app set, or mutating the input', () => {
    const state = { online: true };
    const input = { order: 7 };
    expect(withSituation(input, state)).toEqual({ order: 7, situation: state });
    expect(input).toEqual({ order: 7 });
    expect(withSituation(null, state)).toEqual({ situation: state });
    expect(withSituation({ situation: 'mine' }, state)).toEqual({ situation: 'mine' });
  });

  it('merges contexts with the second winning', () => {
    expect(mergeContext(null, null)).toBeNull();
    expect(mergeContext({ a: 1, b: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(mergeContext(null, { b: 2 })).toEqual({ b: 2 });
  });
});

describe('thrown values', () => {
  it('records the cause chain, outermost first, with top frames', () => {
    const root = new SyntaxError('Unexpected token <');
    const middle = withCause(new Error('Could not parse profile'), root);
    const top = withCause(new Error('Login failed'), middle);
    const chain = causeChain(top);
    expect(chain.map((c) => (c as { type: string; message: string }).type + ': ' + (c as { message: string }).message)).toEqual([
      'Error: Could not parse profile',
      'SyntaxError: Unexpected token <',
    ]);
    expect((chain[0] as { stacktrace: unknown[] }).stacktrace.length).toBeGreaterThan(0);
  });

  it('stops at the depth limit, on cycles, and at non-Error causes', () => {
    let error = new Error('level 0');
    for (let i = 1; i <= 6; i++) error = withCause(new Error('level ' + i), error);
    expect(causeChain(error)).toHaveLength(3);

    const a = new Error('a');
    const b = withCause(new Error('b'), a);
    (a as Error & { cause: unknown }).cause = b;
    expect(causeChain(a)).toHaveLength(1);

    expect(causeChain(withCause(new Error('x'), { code: 'E_TIMEOUT' }))).toEqual([
      { type: null, message: 'code: E_TIMEOUT', stacktrace: [] },
    ]);
  });

  it('keeps an error object\'s plain fields only, and survives throwing getters', () => {
    const error = new Error('Request failed with status code 500') as Error & Record<string, unknown>;
    error.code = 'ERR_BAD_RESPONSE';
    error.status = 500;
    error.isAxiosError = true;
    error.config = { headers: { Authorization: 'secret' } };
    error.statusText = 'x'.repeat(500);
    Object.defineProperty(error, 'boom', { enumerable: true, get: () => { throw new Error('getter'); } });
    const fields = errorProps(error);
    expect(fields).toMatchObject({ code: 'ERR_BAD_RESPONSE', status: 500, isAxiosError: true });
    expect(fields).not.toHaveProperty('config');
    expect(fields).not.toHaveProperty('boom');
    expect(String(fields?.statusText).length).toBeLessThanOrEqual(201);
    expect(errorProps(new Error('plain'))).toBeNull();
  });

  it('says what kind of value was thrown when it is not an Error', () => {
    expect(thrownDetails('timeout')).toEqual({ thrown_kind: 'string' });
    expect(thrownDetails(undefined)).toEqual({ thrown_kind: 'undefined' });
    expect(thrownDetails(null)).toEqual({ thrown_kind: 'null' });
    expect(thrownDetails({ code: 1 })).toEqual({ thrown_kind: 'object' });
    expect(thrownDetails(new Error('plain'))).toBeNull();
  });

  it('never records fields outside the allowlist (URLs with tokens, response bodies, credentials)', () => {
    // Angular's HttpErrorResponse: url keeps the query string, error holds the raw body.
    const angular = Object.assign(new Error('Http failure response for https://api.test/me?token=abc: 500 Internal Server Error'), {
      name: 'HttpErrorResponse',
      status: 500,
      statusText: 'Internal Server Error',
      ok: false,
      url: 'https://api.test/me?token=abc',
      error: '<html>secret body</html>',
      headers: { authorization: 'Bearer x' },
      token: 'abc',
      responseText: 'secret',
      body: 'secret',
    });
    expect(errorProps(angular)).toEqual({ status: 500, statusText: 'Internal Server Error', ok: false });
    const details = JSON.stringify(thrownDetails(angular));
    expect(details).not.toContain('token');
    expect(details).not.toContain('secret');
  });

  it('describes a non-Error cause by its allowlisted fields only', () => {
    expect(causeChain(withCause(new Error('x'), { code: 'E1', config: { headers: { auth: 'secret' } }, data: 'body' }))[0]).toEqual({
      type: null,
      message: 'code: E1',
      stacktrace: [],
    });
    expect(causeChain(withCause(new Error('x'), { data: 'body' }))[0]).toMatchObject({ message: '[object]' });
    expect(causeChain(withCause(new Error('x'), 'plain text'))[0]).toMatchObject({ message: 'plain text' });
  });

  it('keeps the event when the thrown value is hostile', () => {
    const hostile = new Error('outer');
    Object.defineProperty(hostile, 'cause', {
      get: () => ({ get message() { throw new Error('getter'); } }),
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const proxied = withCause(new Error('outer'), revoked.proxy);
    expect(() => thrownDetails(hostile)).not.toThrow();
    expect(() => thrownDetails(proxied)).not.toThrow();
    const captured = captureFromThrown(proxied, true);
    expect(captured.error.message).toBe('outer');
  });

  it('is attached by captureFromThrown', () => {
    const error = Object.assign(withCause(new Error('outer'), new TypeError('inner')), { code: 'E1' });
    expect(captureFromThrown(error, true).context).toMatchObject({
      error_causes: [{ type: 'TypeError', message: 'inner' }],
      error_fields: { code: 'E1' },
    });
  });
});

describe('response headers', () => {
  it('reads only server request-id headers', () => {
    const headers = new Headers({ 'x-vercel-id': 'bom1::abc', 'cf-ray': '8a1-BOM', 'set-cookie': 'session=1', authorization: 'x' });
    expect(serverIdHeaders((n) => headers.get(n))).toEqual({ 'x-vercel-id': 'bom1::abc', 'cf-ray': '8a1-BOM' });
    expect(serverIdHeaders(() => null)).toBeNull();
    expect(serverIdHeaders(() => { throw new Error('nope'); })).toBeNull();
  });

  it('parses getAllResponseHeaders() text', () => {
    const lookup = headerLookup('Content-Type: text/html; charset=utf-8\r\nX-Request-Id:  r-1 \r\nx-request-id: r-2\r\n');
    expect(lookup('content-type')).toBe('text/html; charset=utf-8');
    expect(lookup('x-request-id')).toBe('r-1, r-2');
    expect(lookup('missing')).toBeNull();
    expect(headerLookup(null)('content-type')).toBeNull();
  });

  it('reads content type and a valid content length', () => {
    expect(responseInfo(headerLookup('content-type: text/html\r\ncontent-length: 0'))).toEqual({ contentType: 'text/html', contentLength: 0, serverIds: null });
    expect(responseInfo(headerLookup('content-length: abc')).contentLength).toBeNull();
  });
});

describe('failed files', () => {
  it('classifies a failure from its timing entry', () => {
    expect(classifyResourceFailure(entry({ responseStatus: 404 }), false, true, false)).toMatchObject({ cause: 'http_error', status: 404, durationMs: 120 });
    expect(classifyResourceFailure(entry({ responseStatus: 200, contentType: 'image/png', encodedBodySize: 7 }), false, true, false)).toMatchObject({
      cause: 'bad_content',
      contentType: 'image/png',
      sizeBytes: 7,
    });
    // What Chrome reports for the Spotify favicon (403, cross-origin) and for a DNS failure.
    expect(classifyResourceFailure(entry({ responseStatus: 0 }), true, true, false).cause).toBe('hidden_cross_origin');
    expect(classifyResourceFailure(entry({ responseStatus: 0 }), false, true, false).cause).toBe('no_response');
    // Browsers without responseStatus.
    expect(classifyResourceFailure(entry({}), false, true, false).cause).toBe('unknown');
    expect(classifyResourceFailure(null, false, true, false).cause).toBe('no_response');
    expect(classifyResourceFailure(null, false, true, true).cause).toBe('unknown');
    expect(classifyResourceFailure(entry({ responseStatus: 404 }), false, false, false).cause).toBe('offline');
  });

  describe('elements', () => {
    let restore: () => void = () => undefined;
    afterEach(() => {
      restore();
      document.body.innerHTML = '';
    });

    it('describes the element, the request and the host', () => {
      const url = 'https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png';
      restore = stubTimingEntries([entry({ name: url + '?v=2', responseStatus: 0, duration: 481 })]);
      document.body.innerHTML =
        '<aside id="nav"><img src="' + url + '?v=2" alt="Spotify" loading="lazy" crossorigin="anonymous"></aside>';
      const img = document.querySelector('img') as HTMLImageElement;
      let counted: string | null = null;
      const context = describeFailedElement(img, [], (host) => {
        counted = host;
        return 2;
      });
      expect(context).toEqual({
        resource: 'img',
        cause: 'hidden_cross_origin',
        status: null,
        url: url,
        host: 'open.spotifycdn.com',
        cross_origin: true,
        content_type: null,
        duration_ms: 481,
        size_bytes: null,
        selector: 'aside#nav > img',
        alt: 'Spotify',
        current_src: null,
        loading: 'lazy',
        crossorigin: 'anonymous',
        same_host_failures: 2,
      });
      expect(counted).toBe('open.spotifycdn.com');
    });

    it('never puts a data: URL in the event, and calls it bad content', () => {
      restore = stubTimingEntries([]);
      const pixel = 'data:image/png;base64,' + 'A'.repeat(200000);
      document.body.innerHTML = '<img src="' + pixel + '" alt="Preview">';
      const sink = new RecordingSink();
      const collector = new ErrorCollector(sink, logger);
      collector.install();
      (document.querySelector('img') as Element).dispatchEvent(new Event('error'));
      collector.uninstall();
      expect(sink.errors[0].error.message).toBe('Failed to load <img> data:image/png');
      expect(sink.errors[0].context).toMatchObject({ cause: 'bad_content', url: 'data:image/png', host: null, same_host_failures: null });
      expect(JSON.stringify(sink.errors[0]).length).toBeLessThan(2000);
    });

    it('caps long URLs', () => {
      restore = stubTimingEntries([]);
      document.body.innerHTML = '<img src="https://cdn.test/' + 'a'.repeat(3000) + '.png">';
      const context = describeFailedElement(document.querySelector('img') as Element, [], () => 0);
      expect(String(context.url).length).toBeLessThanOrEqual(501);
    });

    it('ignores a timing entry from an earlier load of the same URL', () => {
      const own = location.origin + '/avatar.png';
      // Loaded fine long ago; this failure has no entry of its own.
      restore = stubTimingEntries([entry({ name: own, responseStatus: 200, startTime: performance.now() - 60000, duration: 10 })]);
      document.body.innerHTML = '<img src="/avatar.png">';
      const context = describeFailedElement(document.querySelector('img') as Element, [], () => 0);
      expect(context).toMatchObject({ cause: 'unknown', status: null, duration_ms: null });
    });

    it('masks alt text under maskSelectors', () => {
      restore = stubTimingEntries([]);
      document.body.innerHTML = '<div class="private"><img src="/a.png" alt="Jane Doe"></div>';
      const context = describeFailedElement(document.querySelector('img') as Element, ['.private'], () => 0);
      expect(context.alt).toBe('[masked]');
    });

    it('reports status, counts failures per host and keeps the old message format', () => {
      const own = location.origin + '/missing.png';
      restore = stubTimingEntries([entry({ name: own, responseStatus: 404 })]);
      const sink = new RecordingSink();
      const collector = new ErrorCollector(sink, logger);
      collector.install();
      for (let i = 0; i < 2; i++) {
        const img = document.createElement('img');
        img.setAttribute('src', '/missing.png');
        document.body.appendChild(img);
        img.dispatchEvent(new Event('error'));
      }
      collector.uninstall();
      // The status stays out of the message, so browsers without it and older SDKs group into the same issue.
      expect(sink.errors[0].error.message).toBe('Failed to load <img> /missing.png');
      expect(sink.errors.map((e) => e.context?.same_host_failures)).toEqual([0, 1]);
      expect(sink.errors[0].context).toMatchObject({ cause: 'http_error', status: 404, cross_origin: false });
    });

    it('resolves script URLs against <base href>', () => {
      const base = document.createElement('base');
      base.href = 'https://cdn.base.test/app/';
      document.head.appendChild(base);
      document.body.innerHTML = '<script src="vendor.js"></script>';
      try {
        expect(scriptsWithoutCrossorigin()).toEqual(['cdn.base.test']);
      } finally {
        base.remove();
      }
    });

    it('lists cross-origin scripts loaded without crossorigin', () => {
      document.body.innerHTML =
        '<script src="https://cdn.a.test/x.js"></script><script src="https://cdn.a.test/y.js"></script>' +
        '<script src="https://cdn.b.test/z.js" crossorigin="anonymous"></script><script src="/own.js"></script>';
      expect(scriptsWithoutCrossorigin()).toEqual(['cdn.a.test']);
    });
  });

  it('gives failures found before the SDK started the same fields', () => {
    const context = earlyElementResourceError('img', 'https://cdn.test/a.png', 404, entry({ contentType: 'text/html' }) as never).context;
    expect(context).toEqual({
      resource: 'img',
      cause: 'http_error',
      status: 404,
      url: 'https://cdn.test/a.png',
      host: 'cdn.test',
      cross_origin: true,
      content_type: 'text/html',
      duration_ms: 120,
      before_sdk_start: true,
    });
  });
});

describe('servers', () => {
  it('forgets only the least recently seen host when full', () => {
    const hosts = new HostTracker();
    hosts.record('busy.test', 0, 'ok');
    for (let i = 0; i < 49; i++) hosts.record('h' + i + '.test', 1, 'ok');
    hosts.record('busy.test', 2, 'ok'); // most recent again
    hosts.record('new.test', 3, 'ok'); // the 51st host: h0 goes, busy stays
    expect(hosts.record('busy.test', 4, 'failed').msSinceOk).toBe(2);
    expect(hosts.record('h0.test', 5, 'failed').msSinceOk).toBeNull();
  });

  it('tracks recent failures and the last good answer per host', () => {
    const hosts = new HostTracker();
    expect(hosts.record('api.test', 1000, 'ok')).toEqual({ failuresBefore: 0, msSinceOk: null });
    expect(hosts.record('api.test', 2000, 'failed')).toEqual({ failuresBefore: 0, msSinceOk: 1000 });
    expect(hosts.record('api.test', 3000, 'failed')).toEqual({ failuresBefore: 1, msSinceOk: 2000 });
    expect(hosts.record('api.test', 3500, 'ignored')).toEqual({ failuresBefore: 2, msSinceOk: 2500 });
    // Failures older than the window no longer count.
    expect(hosts.record('api.test', 70000, 'failed')).toEqual({ failuresBefore: 0, msSinceOk: 69000 });
    expect(hosts.record('other.test', 70000, 'failed')).toEqual({ failuresBefore: 0, msSinceOk: null });
  });

  it('puts server ids, content type and host health on HttpError', () => {
    const call: ApiCall = { _id: 'abc', url: 'https://api.test/orders', method: 'GET', status: 502, duration_ms: 40 };
    const details: RequestDetails = {
      failure: null,
      error: null,
      callSite: () => [],
      startTime: 0,
      endTime: 40,
      rawUrl: call.url,
      response: () => ({ contentType: 'text/html', contentLength: 120, serverIds: { 'cf-ray': '8a1-BOM' } }),
    };
    expect(httpErrorFromCall(call, details, { failuresBefore: 3, msSinceOk: null }).context).toEqual({
      _id: 'abc',
      url: 'https://api.test/orders',
      method: 'GET',
      status: 502,
      duration_ms: 40,
      cause: 'server_error',
      content_type: 'text/html',
      response_headers: { 'cf-ray': '8a1-BOM' },
      host: 'api.test',
      cross_origin: true,
      same_host_failures: 3,
      ms_since_host_ok: null,
    });
  });

  describe('through the interceptor', () => {
    let originalFetch: typeof fetch;
    let network: NetworkInterceptor;
    beforeEach(() => {
      originalFetch = window.fetch;
    });
    afterEach(() => {
      network.uninstall();
      window.fetch = originalFetch;
    });

    it('reads response headers from fetch and counts earlier failures to the same server', async () => {
      const responses = [
        new Response('ok', { status: 200 }),
        new Response('down', { status: 503, headers: { 'x-request-id': 'req-1', 'content-type': 'text/plain' } }),
        new Response('down', { status: 503, headers: { 'x-request-id': 'req-2' } }),
      ];
      window.fetch = vi.fn(() => Promise.resolve(responses.shift() as Response)) as unknown as typeof fetch;
      const sink = new RecordingSink();
      network = new NetworkInterceptor('https://ingest.test/v1/events', logger);
      new HttpErrorCollector(sink, network, { httpErrors: true, httpErrorStatuses: [[500, 599]], networkErrors: true }).install();
      network.install();
      for (let i = 0; i < 3; i++) await window.fetch('https://api.test/cart');

      expect(sink.errors.map((e) => e.context)).toEqual([
        expect.objectContaining({ cause: 'server_error', content_type: 'text/plain', response_headers: { 'x-request-id': 'req-1' }, same_host_failures: 0 }),
        expect.objectContaining({ response_headers: { 'x-request-id': 'req-2' }, same_host_failures: 1 }),
      ]);
      expect(sink.errors[0].context?.ms_since_host_ok).toEqual(expect.any(Number));
    });
  });
});

describe('invalid JSON', () => {
  it('says what came back instead of JSON', () => {
    const info = (contentType: string | null, contentLength: number | null) => ({ contentType, contentLength, serverIds: null });
    expect(classifyInvalidJson(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, info(null, null))).toBe('html_page');
    expect(classifyInvalidJson('JSON.parse: unexpected character at line 1 column 1', info('text/html; charset=utf-8', null))).toBe('html_page');
    expect(classifyInvalidJson('Unexpected end of JSON input', info('application/json', 0))).toBe('empty_body');
    expect(classifyInvalidJson('Unexpected end of JSON input', info('application/json', 512))).toBe('incomplete_json');
    expect(classifyInvalidJson('JSON Parse error: Unexpected EOF', null)).toBe('empty_or_incomplete');
    // A "<" inside JSON (an HTML string value) is broken JSON, not an HTML page.
    expect(classifyInvalidJson('Unexpected token \'x\', "["<b>", x]" is not valid JSON', info('application/json', 12))).toBe('malformed_json');
    expect(classifyInvalidJson('Unexpected token \'<\', "  <html>" is not valid JSON', info(null, null))).toBe('html_page');
    expect(classifyInvalidJson('JSON Parse error: Unrecognized token \'<\'', info(null, null))).toBe('html_page');
    expect(classifyInvalidJson('Expected property name or \'}\' in JSON at position 1', info('application/json', 20))).toBe('malformed_json');
    expect(classifyInvalidJson('Unexpected token \'O\', "OK" is not valid JSON', info('text/plain', 2))).toBe('not_json');
  });
});

describe('public API', () => {
  const sent: TrackerEvent[] = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
    sent.length = 0;
    window.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init && init.body)) as { events: TrackerEvent[] };
      sent.push(...body.events);
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await ErrorTracker.close();
    window.fetch = originalFetch;
  });

  it('captureError sends SDK details, the app context (which wins) and the situation', async () => {
    ErrorTracker.init({ apiKey: 'k', endpoint: 'https://ingest.test/v1/events', detectBlankPage: false });
    const error = Object.assign(withCause(new Error('Checkout failed'), new TypeError('price is undefined')), { code: 'E_PAY' });
    ErrorTracker.captureError(error, { orderId: 42, error_fields: 'app value' });
    await ErrorTracker.flush();

    const event = sent.find((e) => e.error !== null && e.error.message === 'Checkout failed');
    expect(event?.context).toMatchObject({
      orderId: 42,
      error_fields: 'app value',
      error_causes: [{ type: 'TypeError', message: 'price is undefined' }],
      situation: { online: true, visibility: 'visible', ms_since_navigation: null },
    });
  });

  it('records the time since the last screen change', async () => {
    ErrorTracker.init({ apiKey: 'k', endpoint: 'https://ingest.test/v1/events', detectBlankPage: false });
    ErrorTracker.setScreen('Checkout');
    ErrorTracker.captureMessage('hello');
    await ErrorTracker.flush();
    const event = sent.find((e) => e.event_type === 'message');
    expect((event?.context as { situation: { ms_since_navigation: unknown } }).situation.ms_since_navigation).toEqual(expect.any(Number));
  });
});
