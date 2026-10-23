import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreadcrumbCollector } from '../src/collectors/breadcrumbCollector';
import { cspError, CspCollector, violationFromEvent } from '../src/collectors/cspCollector';
import { captureFromThrown, ErrorCollector } from '../src/collectors/errorCollector';
import { HttpErrorCollector } from '../src/collectors/httpErrorCollector';
import { JsonResponseCollector } from '../src/collectors/jsonResponseCollector';
import { NetworkInterceptor } from '../src/collectors/networkInterceptor';
import { ResourceCollector } from '../src/collectors/resourceCollector';
import { ResponsivenessCollector } from '../src/collectors/responsivenessCollector';
import { WorkerCollector } from '../src/collectors/workerCollector';
import { Logger } from '../src/core/logger';
import { RecordingSink } from './helpers';

const logger = new Logger(false);
const ENDPOINT = 'https://ingest.test/v1/events';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

function dispatchRejection(reason: unknown): void {
  const event = new Event('unhandledrejection') as Event & { reason: unknown };
  Object.defineProperty(event, 'reason', { value: reason });
  window.dispatchEvent(event);
}

describe('NetworkError and HttpError', () => {
  let sink: RecordingSink;
  let network: NetworkInterceptor;
  let errors: ErrorCollector;
  let originalFetch: typeof fetch;

  function install(fetchImpl: (input: RequestInfo | URL) => Promise<Response>, networkErrors = true): void {
    window.fetch = vi.fn(fetchImpl) as unknown as typeof fetch;
    network = new NetworkInterceptor(ENDPOINT, logger);
    new HttpErrorCollector(sink, network, { httpErrors: true, httpErrorStatuses: [[400, 599]], networkErrors }).install();
    network.install();
  }

  beforeEach(() => {
    originalFetch = window.fetch;
    sink = new RecordingSink();
    errors = new ErrorCollector(sink, logger);
    errors.install();
    setOnline(true);
  });

  afterEach(() => {
    network.uninstall();
    errors.uninstall();
    window.fetch = originalFetch;
    setOnline(true);
  });

  function callApi(): Promise<Response> {
    return window.fetch('https://api.test/orders?id=1', { method: 'post' });
  }

  it('reports a request with no response as NetworkError, with the app call site as stack', async () => {
    install(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(callApi()).rejects.toThrow('Failed to fetch');

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0].error).toEqual({
      message: 'POST https://api.test/orders failed: no response (connection refused, DNS, SSL or CORS)',
      type: 'NetworkError',
      handled: true,
    });
    expect(sink.errors[0].context).toMatchObject({ url: 'https://api.test/orders', method: 'POST', failure: 'network' });
    // Top frame is this test's code, not the SDK wrapper.
    expect(sink.errors[0].stacktrace[0].function).toBe('callApi');
  });

  it('labels offline and timeout failures', async () => {
    install(() => Promise.reject(new DOMException('signal timed out', 'TimeoutError')));
    await expect(callApi()).rejects.toThrow();
    expect(sink.errors[0].context).toMatchObject({ failure: 'timeout' });
    expect(sink.errors[0].error.message).toContain('timed out');

    network.uninstall();
    sink.errors = [];
    setOnline(false);
    install(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(callApi()).rejects.toThrow();
    expect(sink.errors[0].error.message).toContain('device offline');
  });

  it('ignores requests the app aborted itself', async () => {
    install(() => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')));
    await expect(callApi()).rejects.toThrow();
    expect(sink.errors).toHaveLength(0);
  });

  it('does not report the same failure again when the app leaves the promise uncaught', async () => {
    const failure = new TypeError('Failed to fetch');
    install(() => Promise.reject(failure));
    await expect(callApi()).rejects.toBe(failure);
    dispatchRejection(failure); // what the browser does when nobody catches it
    expect(sink.errors.map((e) => e.error.type)).toEqual(['NetworkError']);
  });

  it('can be turned off with networkErrors: false', async () => {
    install(() => Promise.reject(new TypeError('Failed to fetch')), false);
    await expect(callApi()).rejects.toThrow();
    expect(sink.errors).toHaveLength(0);
  });

  it('attaches context and the call site to HttpError', async () => {
    install(() => Promise.resolve(new Response(null, { status: 503 })));
    await callApi();
    expect(sink.errors[0].error.type).toBe('HttpError');
    expect(sink.errors[0].context).toMatchObject({ url: 'https://api.test/orders', method: 'POST', status: 503 });
    expect(sink.errors[0].stacktrace.length).toBeGreaterThan(0);
  });

  it('reports XHR requests that fail without a response', () => {
    install(() => Promise.resolve(new Response(null)));
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.test/legacy');
    try {
      xhr.send();
    } catch (_e) {
      // jsdom may refuse the real request; only the hooks matter here.
    }
    xhr.dispatchEvent(new Event('error'));
    xhr.dispatchEvent(new Event('loadend'));

    const networkErrors = sink.errors.filter((e) => e.error.type === 'NetworkError');
    expect(networkErrors[0].error.message).toBe(
      'GET https://api.test/legacy failed: no response (connection refused, DNS, SSL or CORS)',
    );
  });
});

describe('JsonResponseCollector', () => {
  let sink: RecordingSink;
  let collector: JsonResponseCollector;

  beforeEach(() => {
    sink = new RecordingSink();
    collector = new JsonResponseCollector(sink, logger, (url) => url === ENDPOINT);
    collector.install();
  });

  afterEach(() => collector.uninstall());

  function response(body: string, url: string, status = 200): Response {
    const res = new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  }

  it('reports malformed JSON even when the app catches the error', async () => {
    const res = response('<html>oops</html>', 'https://api.test/profile?token=secret');
    let caught: unknown = null;
    try {
      await res.json();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SyntaxError); // app behaviour unchanged
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0].error.type).toBe('InvalidJsonResponse');
    expect(sink.errors[0].error.message).toMatch(/^Invalid JSON from https:\/\/api\.test\/profile \(status 200\): /);
    expect(sink.errors[0].error.message).not.toContain('secret');
    expect(sink.errors[0].context).toEqual({ url: 'https://api.test/profile', status: 200 });
  });

  it('leaves valid JSON alone', async () => {
    await expect(response('{"ok":true}', 'https://api.test/ok').json()).resolves.toEqual({ ok: true });
    expect(sink.errors).toHaveLength(0);
  });

  it('restores Response.prototype.json on uninstall', () => {
    const patched = Response.prototype.json;
    collector.uninstall();
    expect(Response.prototype.json).not.toBe(patched);
  });
});

describe('ResponsivenessCollector', () => {
  it('reports a main-thread block over 1s, at most once per 30s', () => {
    let now = 100000;
    const sink = new RecordingSink();
    const collector = new ResponsivenessCollector(sink, logger, { now: () => now, requestFrame: () => {} });

    collector.recordLongTask(400); // normal long task: ignored
    collector.recordLongTask(1500);
    now += 5000;
    collector.recordLongTask(2000); // within 30 s: suppressed
    now += 30000;
    collector.recordLongTask(1200);

    expect(sink.issues.map((i) => i.message)).toEqual([
      'Main thread blocked for 1500ms (page unresponsive)',
      'Main thread blocked for 1200ms (page unresponsive)',
    ]);
  });

  it('says how long a block lasted, when it started and whether the page was still loading', () => {
    let now = 100000;
    const sink = new RecordingSink();
    const collector = new ResponsivenessCollector(sink, logger, { now: () => now, requestFrame: () => {}, pageLoadEndMs: () => 4894 });
    collector.recordLongTask(1570.4, 2100.7); // before the load event ended
    now += 30000;
    collector.recordLongTask(1300, 60000);
    expect(sink.issues.map((i) => i.context)).toEqual([
      { duration_ms: 1570, threshold_ms: 1000, started_at_ms: 2101, during_page_load: true },
      { duration_ms: 1300, threshold_ms: 1000, started_at_ms: 60000, during_page_load: false },
    ]);
  });

  it('treats a block as during page load while the load event has not ended', () => {
    const sink = new RecordingSink();
    const collector = new ResponsivenessCollector(sink, logger, { now: () => 100000, requestFrame: () => {}, pageLoadEndMs: () => null });
    const readyState = vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');
    collector.recordLongTask(1500, 800);
    readyState.mockRestore();
    expect(sink.issues[0].context).toMatchObject({ during_page_load: true });
  });

  it('uses a custom main-thread block threshold when given', () => {
    const sink = new RecordingSink();
    const collector = new ResponsivenessCollector(sink, logger, { now: () => 100000, requestFrame: () => {}, freezeThresholdMs: 2000 });
    collector.recordLongTask(1500); // over the default 1 s, under the custom 2 s
    expect(sink.issues).toHaveLength(0);
    collector.recordLongTask(2500);
    expect(sink.issues).toEqual([
      {
        kind: 'MainThreadBlocked',
        message: 'Main thread blocked for 2500ms (page unresponsive)',
        context: { duration_ms: 2500, threshold_ms: 2000, started_at_ms: null, during_page_load: false },
      },
    ]);
  });

  /** Drives the sampler with a fake clock: `frameMs` between frames. */
  function sample(frameMs: number, lowFpsThreshold?: number): { collector: ResponsivenessCollector; sink: RecordingSink } {
    let now = 0;
    const sink = new RecordingSink();
    const queue: Array<() => void> = [];
    const collector = new ResponsivenessCollector(sink, logger, { now: () => now, requestFrame: (cb) => queue.push(cb), lowFpsThreshold });
    collector.sampleFrameRate();
    while (queue.length > 0) {
      now += frameMs;
      (queue.shift() as () => void)();
    }
    return { collector, sink };
  }

  it('measures frame rate for the payload', () => {
    const { collector, sink } = sample(1000 / 60);
    expect(collector.frameRate()).toBe(60);
    expect(sink.issues).toHaveLength(0);
  });

  it('reports a very low frame rate', () => {
    const { collector, sink } = sample(100);
    expect(collector.frameRate()).toBe(10);
    expect(sink.issues).toEqual([
      {
        kind: 'LowFrameRate',
        message: 'Low frame rate: 10 fps (janky scrolling/animation)',
        context: { fps: 10, threshold_fps: 20, during_page_load: false },
      },
    ]);
  });

  it('uses a custom low frame rate threshold when given', () => {
    const at25 = sample(40); // 25 fps: fine by default (20), low for a 30 fps threshold
    expect(at25.collector.frameRate()).toBe(25);
    expect(at25.sink.issues).toHaveLength(0);
    const strict = sample(40, 30);
    expect(strict.sink.issues).toEqual([
      { kind: 'LowFrameRate', message: 'Low frame rate: 25 fps (janky scrolling/animation)', context: { fps: 25, threshold_fps: 30, during_page_load: false } },
    ]);
  });

  it('discards a sample stretched by the tab being hidden', () => {
    const { collector, sink } = sample(5000);
    expect(collector.frameRate()).toBeNull();
    expect(sink.issues).toHaveLength(0);
  });
});

describe('CspCollector', () => {
  function violation(fields: Partial<SecurityPolicyViolationEvent>): SecurityPolicyViolationEvent {
    const event = new Event('securitypolicyviolation');
    Object.keys(fields).forEach((key) => {
      Object.defineProperty(event, key, { value: (fields as Record<string, unknown>)[key] });
    });
    return event as SecurityPolicyViolationEvent;
  }

  it('describes enforced and report-only violations', () => {
    const blocked = cspError(violationFromEvent(
      violation({ blockedURI: 'https://evil.test/x.js?k=1', effectiveDirective: 'script-src-elem', disposition: 'enforce', sourceFile: 'https://app.test/main.js', lineNumber: 3, columnNumber: 7 }),
    ));
    expect(blocked.error).toEqual({ message: 'CSP blocked https://evil.test/x.js (script-src-elem)', type: 'CspViolation', handled: false });
    expect(blocked.stacktrace[0]).toMatchObject({ filename: 'https://app.test/main.js', lineno: 3, colno: 7 });

    const reportOnly = cspError(violationFromEvent(violation({ blockedURI: 'inline', violatedDirective: 'script-src', disposition: 'report' })));
    expect(reportOnly.error.message).toBe('CSP would block inline (script-src)');
  });

  it('falls back to the securitypolicyviolation event without the Reporting API', () => {
    const sink = new RecordingSink();
    const collector = new CspCollector(sink, logger, [], null);
    collector.install();
    document.dispatchEvent(violation({ blockedURI: 'eval', effectiveDirective: 'script-src', disposition: 'enforce' }));
    collector.uninstall();
    document.dispatchEvent(violation({ blockedURI: 'eval', effectiveDirective: 'script-src', disposition: 'enforce' }));
    expect(sink.errors.map((e) => e.error.message)).toEqual(['CSP blocked eval (script-src)']);
  });

  it("ignores violations caused by the SDK's own screenshot library", () => {
    const sink = new RecordingSink();
    const collector = new CspCollector(sink, logger, ['https://cdn.test/html2canvas.min.js'], null);
    collector.install();
    document.dispatchEvent(violation({ blockedURI: 'data', effectiveDirective: 'img-src', disposition: 'report', sourceFile: 'https://cdn.test/html2canvas.min.js' }));
    document.dispatchEvent(violation({ blockedURI: 'data', effectiveDirective: 'img-src', disposition: 'report', sourceFile: 'https://app.test/main.js' }));
    collector.uninstall();
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0].stacktrace[0].filename).toBe('https://app.test/main.js');
  });

  it('uses a buffered ReportingObserver when available, so violations from before init are included', () => {
    const sink = new RecordingSink();
    let options: unknown = null;
    let deliver: ((reports: Array<{ type: string; body: unknown }>) => void) | null = null;
    class FakeReportingObserver {
      constructor(cb: (reports: Array<{ type: string; body: unknown }>) => void, opts: unknown) {
        deliver = cb;
        options = opts;
      }
      observe(): void {}
      disconnect(): void {}
    }
    const collector = new CspCollector(sink, logger, [], FakeReportingObserver);
    collector.install();
    expect(options).toEqual({ types: ['csp-violation'], buffered: true });

    (deliver as unknown as (r: Array<{ type: string; body: unknown }>) => void)([
      { type: 'csp-violation', body: { blockedURL: 'https://cdn.test/a.png', effectiveDirective: 'img-src', disposition: 'report' } },
      { type: 'deprecation', body: {} },
    ]);
    // The event path is not also active, so nothing is reported twice.
    document.dispatchEvent(violation({ blockedURI: 'https://cdn.test/a.png', effectiveDirective: 'img-src', disposition: 'report' }));
    collector.uninstall();

    expect(sink.errors.map((e) => e.error.message)).toEqual(['CSP would block https://cdn.test/a.png (img-src)']);
  });
});

describe('WorkerCollector', () => {
  class FakeWorker extends EventTarget {
    constructor(public url: string | URL) {
      super();
    }
  }
  const win = window as unknown as { Worker?: unknown };
  let originalWorker: unknown;

  beforeEach(() => {
    originalWorker = win.Worker;
    win.Worker = FakeWorker;
  });

  afterEach(() => {
    win.Worker = originalWorker;
  });

  it('reports uncaught worker errors and returns the real worker', () => {
    const sink = new RecordingSink();
    const collector = new WorkerCollector(sink, logger);
    collector.install();

    const WorkerCtor = win.Worker as new (url: string) => FakeWorker;
    const worker = new WorkerCtor('/workers/resize.js?v=2');
    expect(worker).toBeInstanceOf(FakeWorker);

    worker.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: decode failed', filename: 'http://localhost:3000/workers/resize.js', lineno: 12, colno: 5 }));
    worker.dispatchEvent(new Event('error')); // script failed to load

    expect(sink.errors.map((e) => e.error)).toEqual([
      { message: 'Uncaught Error: decode failed', type: 'WorkerError', handled: false },
      { message: 'Worker failed to start: /workers/resize.js', type: 'WorkerError', handled: false },
    ]);
    expect(sink.errors[0].stacktrace[0]).toMatchObject({ lineno: 12, colno: 5 });

    collector.uninstall();
    expect(win.Worker).toBe(FakeWorker);
  });

  it('skips the copy some browsers re-dispatch on window', () => {
    const sink = new RecordingSink();
    const workers = new WorkerCollector(sink, logger);
    const errors = new ErrorCollector(sink, logger);
    workers.install();
    errors.install();

    const WorkerCtor = win.Worker as new (url: string) => FakeWorker;
    const worker = new WorkerCtor('/w.js');
    const detail = { message: 'Uncaught Error: boom', filename: 'http://localhost:3000/w.js', lineno: 1, colno: 1 };
    worker.dispatchEvent(new ErrorEvent('error', detail));
    window.dispatchEvent(new ErrorEvent('error', detail));

    expect(sink.errors.map((e) => e.error.type)).toEqual(['WorkerError']);
    workers.uninstall();
    errors.uninstall();
  });
});

describe('ResourceCollector', () => {
  it('reports CSS-initiated resources with an error status, but not fonts, unknown status or other initiators', () => {
    const sink = new RecordingSink();
    const collector = new ResourceCollector(sink, logger);
    const entry = (initiatorType: string, name: string, responseStatus?: number) =>
      ({ initiatorType, name, responseStatus, responseEnd: Number.MAX_SAFE_INTEGER }) as unknown as PerformanceEntry & {
        initiatorType: string;
        responseEnd: number;
        responseStatus?: number;
      };

    collector.recordResource(entry('css', 'https://app.test/img/hero.png?v=3', 404));
    collector.recordResource(entry('css', 'https://app.test/fonts/inter.woff2', 404)); // fonts: reported via FontFaceSet
    collector.recordResource(entry('css', 'https://cdn.test/bg.png', 0)); // cross-origin, status hidden
    collector.recordResource(entry('css', 'https://app.test/ok.png', 200));
    collector.recordResource(entry('img', 'https://app.test/missing.png', 404)); // after init: the error collector sees <img> errors

    expect(sink.errors.map((e) => e.error)).toEqual([
      { message: 'Failed to load CSS resource https://app.test/img/hero.png (status 404)', type: 'ResourceError', handled: false },
    ]);
  });

  it('reports <img>/<script>/<link> failures that finished before the SDK started', () => {
    const sink = new RecordingSink();
    const collector = new ResourceCollector(sink, logger);
    collector.install(); // records the install time
    const early = { initiatorType: 'img', name: 'https://app.test/hero.jpg?v=1', responseStatus: 404, responseEnd: 0 };
    const asEntry = (e: object) => e as unknown as PerformanceEntry & { initiatorType: string; responseEnd: number; responseStatus?: number };
    collector.recordResource(asEntry({ ...early, initiatorType: 'link' })); // React's <link rel="preload"> for the same image
    collector.recordResource(asEntry(early));
    collector.uninstall();
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0].error).toEqual({ message: 'Failed to load <link> https://app.test/hero.jpg (status 404)', type: 'ResourceError', handled: false });
    expect(sink.errors[0].context).toMatchObject({ before_sdk_start: true });
  });

  it('reports web fonts that fail to load', () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    const sink = new RecordingSink();
    const collector = new ResourceCollector(sink, logger);
    collector.install();

    const event = new Event('loadingerror');
    Object.defineProperty(event, 'fontfaces', { value: [{ family: '"Brand Sans"' }] });
    fonts.dispatchEvent(event);
    collector.uninstall();

    expect(sink.errors.map((e) => e.error.message)).toEqual(["Failed to load font 'Brand Sans'"]);
  });
});

describe('console.error capture (opt-in)', () => {
  function collector(capture: boolean): { sink: RecordingSink; c: BreadcrumbCollector } {
    const sink = new RecordingSink();
    const c = new BreadcrumbCollector(sink, new NetworkInterceptor(ENDPOINT, logger), [], logger, capture);
    return { sink, c };
  }
  let restore: Array<() => void> = [];

  beforeEach(() => {
    const original = console.error;
    console.error = vi.fn();
    restore = [() => (console.error = original)];
  });

  afterEach(() => restore.forEach((fn) => fn()));

  it('is off by default: console.error stays a breadcrumb only', () => {
    const { sink, c } = collector(false);
    c.install();
    console.error('payment widget failed');
    c.uninstall();
    expect(sink.breadcrumbs).toHaveLength(1);
    expect(sink.errors).toHaveLength(0);
  });

  it('when enabled, reports text messages and Error arguments', () => {
    const { sink, c } = collector(true);
    c.install();
    console.error('payment widget failed', { code: 7 });
    console.error('Render failed:', new RangeError('bad index'));
    c.uninstall();

    expect(sink.errors[0].error).toEqual({ message: 'payment widget failed {"code":7}', type: 'ConsoleError', handled: true });
    expect(sink.errors[0].stacktrace.length).toBeGreaterThan(0);
    expect(sink.errors[1].error).toEqual({ message: 'bad index', type: 'RangeError', handled: true });
    expect(sink.errors[1].context).toEqual({ console_message: 'Render failed: bad index' });
  });

  it('skips errors that were already reported (frameworks log errors they rethrow)', () => {
    const { sink, c } = collector(true);
    c.install();
    const err = new Error('already captured');
    captureFromThrown(err, false);
    console.error(err);
    c.uninstall();
    expect(sink.errors).toHaveLength(0);
  });
});

