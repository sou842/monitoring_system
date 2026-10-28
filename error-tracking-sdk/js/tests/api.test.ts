import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_STORAGE_KEY, RATE_LIMIT_MAX_EVENTS } from '../src/constants';
import { buildEvent } from '../src/core/payloadBuilder';
import ErrorTracker from '../src/index';
import { TrackerEvent } from '../src/types';
import { expectSchemaShape, makeScope, mockFetch, settle } from './helpers';

const ENDPOINT = 'https://ingest.test/v1/events';
const BASE_CONFIG = {
  apiKey: 'pk_test_123',
  endpoint: ENDPOINT,
  environment: 'staging',
  appVersion: '2.1.4',
  // Page views have their own tests below; here they would add to every event count.
  performanceSampleRate: 0,
};

let fetchMock: ReturnType<typeof mockFetch>;

function sentEvents(): TrackerEvent[] {
  return fetchMock.calls.reduce<TrackerEvent[]>((all, call) => all.concat(call.body.events), []);
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

beforeEach(() => {
  fetchMock = mockFetch(202);
  vi.stubGlobal('fetch', fetchMock.fn);
  window.fetch = fetchMock.fn as unknown as typeof fetch;
  setOnline(true);
  localStorage.clear();
});

afterEach(async () => {
  await ErrorTracker.close();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('ErrorTracker public API', () => {
  it('sends a schema-complete error event for captureError', async () => {
    ErrorTracker.init(BASE_CONFIG);
    ErrorTracker.setUser({ id: 'usr_8821', email: 'jane@example.com' });
    ErrorTracker.addBreadcrumb({ type: 'click', message: 'Clicked Pay Now', data: { button: 'pay' } });
    ErrorTracker.captureError(new TypeError("Cannot read property 'price' of undefined"), { cartId: 'c_1' });
    await ErrorTracker.flush();

    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].init.headers).toMatchObject({ 'X-API-Key': 'pk_test_123', 'Content-Type': 'application/json' });

    const [event] = sentEvents();
    expectSchemaShape(event);
    expect(event).toMatchObject({
      api_key: 'pk_test_123',
      event_type: 'error',
      environment: 'staging',
      app_version: '2.1.4',
      user: { id: 'usr_8821', email: 'jane@example.com', name: null },
      error: { message: "Cannot read property 'price' of undefined", type: 'TypeError', handled: true },
      context: { cartId: 'c_1' },
    });
    expect(event.breadcrumbs).toContainEqual(expect.objectContaining({ type: 'click', message: 'Clicked Pay Now', data: { button: 'pay' } }));
    expect(event.stacktrace.length).toBeGreaterThan(0);
  });

  it('sends uncaught errors with handled: false', async () => {
    ErrorTracker.init(BASE_CONFIG);
    window.dispatchEvent(new ErrorEvent('error', { error: new ReferenceError('foo is not defined'), message: 'foo is not defined' }));
    await ErrorTracker.flush();
    expect(sentEvents()[0].error).toEqual({ message: 'foo is not defined', type: 'ReferenceError', handled: false });
  });

  it('applies slowApiCallMs from init() to real fetch calls', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    ErrorTracker.init({ ...BASE_CONFIG, slowApiCallMs: 3000, captureSlowEvents: true });
    // The mock fetch parses every body, so app calls send an empty batch too.
    const call = (url: string, ms: number) => {
      const pending = window.fetch(url, { method: 'POST', body: '{"events":[]}' });
      clock += ms;
      return pending;
    };

    await call('https://app.test/api/search', 2500); // slow by the default 2 s, fine with 3 s
    await call('https://app.test/api/report', 3500);
    await ErrorTracker.flush();

    const slow = sentEvents().filter((e) => e.error !== null && e.error.type === 'SlowApiCall');
    expect(slow).toHaveLength(1);
    expect(slow[0].error).toMatchObject({ message: 'Slow API call: POST https://app.test/api/report', handled: true });
    expect(slow[0].context).toMatchObject({ duration_ms: 3500, threshold_ms: 3000 });
  });

  describe('PageNotFound', () => {
    /** Pretends the current document was served with `status` at `path`. */
    function servePage(path: string, status: number | undefined): void {
      history.replaceState(null, '', path);
      const real = performance.getEntriesByType.bind(performance);
      vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) =>
        type === 'navigation' ? [{ entryType: 'navigation', startTime: 0, responseStatus: status } as unknown as PerformanceEntry] : real(type),
      );
    }

    function notFoundEvents(): TrackerEvent[] {
      return sentEvents().filter((e) => e.error !== null && e.error.type === 'PageNotFound');
    }

    afterEach(() => {
      history.replaceState(null, '', '/');
    });

    it('reports a page served with 404, without its query string', async () => {
      servePage('/abouts?token=secret#top', 404);
      ErrorTracker.init(BASE_CONFIG);
      await ErrorTracker.flush();

      const events = notFoundEvents();
      expect(events).toHaveLength(1);
      expectSchemaShape(events[0]);
      expect(events[0]).toMatchObject({
        event_type: 'error',
        level: 'warning',
        error: { message: 'Page not found: /abouts', type: 'PageNotFound', handled: true },
        stacktrace: [],
        context: { url: location.origin + '/abouts', path: '/abouts', status: 404, source: 'http-status' },
      });
    });

    it('reports 410 Gone too', async () => {
      servePage('/old-page', 410);
      ErrorTracker.init(BASE_CONFIG);
      await ErrorTracker.flush();
      expect(notFoundEvents()[0].context).toMatchObject({ path: '/old-page', status: 410 });
    });

    it('does nothing for normal pages or when the browser hides the status', async () => {
      servePage('/about', 200);
      ErrorTracker.init(BASE_CONFIG);
      await ErrorTracker.close();
      servePage('/about', undefined); // Safari: no responseStatus
      ErrorTracker.init(BASE_CONFIG);
      await ErrorTracker.flush();
      expect(notFoundEvents()).toHaveLength(0);
    });

    it('can be turned off with detectPageNotFound: false', async () => {
      servePage('/abouts', 404);
      ErrorTracker.init({ ...BASE_CONFIG, detectPageNotFound: false });
      await ErrorTracker.flush();
      expect(notFoundEvents()).toHaveLength(0);
    });

    it('capturePageNotFound() reports client-side route misses', async () => {
      servePage('/', 200);
      ErrorTracker.init(BASE_CONFIG);
      history.pushState(null, '', '/wrong_path?x=1');
      ErrorTracker.capturePageNotFound();
      ErrorTracker.capturePageNotFound('/other-missing');
      await ErrorTracker.flush();

      expect(notFoundEvents().map((e) => e.context)).toEqual([
        { url: location.origin + '/wrong_path', path: '/wrong_path', status: null, referrer: null, source: 'app' },
        { url: location.origin + '/other-missing', path: '/other-missing', status: null, referrer: null, source: 'app' },
      ]);
    });

    it('sends one event when the app also calls capturePageNotFound() on a detected 404', async () => {
      servePage('/abouts', 404);
      ErrorTracker.init(BASE_CONFIG);
      ErrorTracker.capturePageNotFound();
      await ErrorTracker.flush();
      expect(notFoundEvents()).toHaveLength(1);
      expect(notFoundEvents()[0].context).toMatchObject({ source: 'http-status' });
    });

    it('works when called before init()', async () => {
      ErrorTracker.capturePageNotFound('/early');
      ErrorTracker.init(BASE_CONFIG);
      await ErrorTracker.flush();
      expect(notFoundEvents()[0].error).toMatchObject({ message: 'Page not found: /early' });
    });
  });

  it('sends captureMessage as a message event with its level', async () => {
    ErrorTracker.init(BASE_CONFIG);
    ErrorTracker.captureMessage('Checkout started', 'warning');
    await ErrorTracker.flush();
    expect(sentEvents()[0]).toMatchObject({ event_type: 'message', level: 'warning', error: { message: 'Checkout started', type: 'Message' } });
  });

  it('buffers calls made before init() and replays them afterwards', async () => {
    ErrorTracker.setUser({ id: 'early_user' });
    ErrorTracker.captureMessage('before init');
    expect(fetchMock.calls).toHaveLength(0);

    ErrorTracker.init(BASE_CONFIG);
    await ErrorTracker.flush();
    expect(sentEvents()[0]).toMatchObject({ error: { message: 'before init' }, user: { id: 'early_user' } });
  });

  it('stays disabled (without throwing) when config is invalid', async () => {
    expect(() => ErrorTracker.init({ ...BASE_CONFIG, apiKey: '' })).not.toThrow();
    expect(ErrorTracker.isInitialized()).toBe(false);
    expect(() => ErrorTracker.init(null as unknown as typeof BASE_CONFIG)).not.toThrow();
    expect(() => ErrorTracker.init({ ...BASE_CONFIG, endpoint: 'http://[bad' })).not.toThrow();
    expect(ErrorTracker.isInitialized()).toBe(false);
  });

  it('respects sampleRate', async () => {
    ErrorTracker.init({ ...BASE_CONFIG, sampleRate: 0 });
    ErrorTracker.captureMessage('sampled out');
    await ErrorTracker.flush();
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('deduplicates identical errors fired in a loop', async () => {
    ErrorTracker.init(BASE_CONFIG);
    const error = new Error('same error');
    for (let i = 0; i < 50; i++) ErrorTracker.captureError(error);
    await ErrorTracker.flush();
    expect(sentEvents()).toHaveLength(1);
  });

  it('throttles an error storm of 1000 distinct errors per minute', async () => {
    ErrorTracker.init(BASE_CONFIG);
    for (let i = 0; i < 1000; i++) ErrorTracker.captureMessage('storm ' + i, 'error');
    await ErrorTracker.flush();
    expect(sentEvents()).toHaveLength(RATE_LIMIT_MAX_EVENTS);
    expect(fetchMock.calls.every((c) => c.body.events.length <= 10)).toBe(true);
  });

  it('queues events offline in localStorage and flushes them on reconnect', async () => {
    ErrorTracker.init(BASE_CONFIG);
    setOnline(false);
    ErrorTracker.captureMessage('offline 1');
    ErrorTracker.captureMessage('offline 2');
    await ErrorTracker.flush();

    expect(fetchMock.calls).toHaveLength(0);
    const persisted = localStorage.getItem(OFFLINE_STORAGE_KEY) as string;
    expect(JSON.parse(persisted)).toHaveLength(2);
    expect(persisted).not.toContain('pk_test_123'); // API key is never written to storage

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await settle();
    await ErrorTracker.flush();

    expect(sentEvents().map((e) => e.error && e.error.message)).toEqual(['offline 1', 'offline 2']);
    expect(sentEvents().every((e) => e.api_key === 'pk_test_123')).toBe(true);
    expect(localStorage.getItem(OFFLINE_STORAGE_KEY)).toBeNull();
  });

  it('sends events left in storage by a previous session on init', async () => {
    ErrorTracker.init(BASE_CONFIG);
    setOnline(false);
    ErrorTracker.captureMessage('from last session');
    await ErrorTracker.close();

    setOnline(true);
    ErrorTracker.init(BASE_CONFIG);
    await settle();
    await ErrorTracker.flush();
    expect(sentEvents().map((e) => e.error && e.error.message)).toEqual(['from last session']);
  });

  it('does not crash the host app when the endpoint rejects the API key', async () => {
    fetchMock = mockFetch(401);
    vi.stubGlobal('fetch', fetchMock.fn);
    ErrorTracker.init({ ...BASE_CONFIG, apiKey: 'invalid' });
    expect(() => ErrorTracker.captureMessage('rejected')).not.toThrow();
    await expect(ErrorTracker.flush()).resolves.toBeUndefined();
    expect(fetchMock.calls).toHaveLength(1); // 401 is not retried
  });

  it('does not crash when fetch itself throws synchronously', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('fetch exploded');
    });
    vi.useFakeTimers();
    ErrorTracker.init(BASE_CONFIG);
    ErrorTracker.captureMessage('x');
    const flushed = ErrorTracker.flush();
    // Walk through the 1s/2s/4s retry backoff. (runAllTimers would never end: the
    // frame-rate sampler uses a repeating timer.)
    await vi.advanceTimersByTimeAsync(10000);
    await expect(flushed).resolves.toBeUndefined();
    // Retries exhausted: the event is parked in storage rather than lost.
    expect(JSON.parse(localStorage.getItem(OFFLINE_STORAGE_KEY) as string)).toHaveLength(1);
    vi.useRealTimers();
  });

  it('applies beforeSend and survives a throwing hook', async () => {
    ErrorTracker.init({
      ...BASE_CONFIG,
      beforeSend: (event) => {
        if (event.error && event.error.message === 'drop me') return null;
        if (event.error && event.error.message === 'throw') throw new Error('bad hook');
        return { ...event, user: { id: 'scrubbed', email: null, name: null } };
      },
    });
    ErrorTracker.captureMessage('drop me');
    ErrorTracker.captureMessage('keep me');
    ErrorTracker.captureMessage('throw');
    await ErrorTracker.flush();

    const messages = sentEvents().map((e) => e.error && e.error.message);
    expect(messages).toEqual(['keep me', 'throw']);
    expect(sentEvents()[0].user.id).toBe('scrubbed');
  });

  it('public methods never throw on bad input', () => {
    ErrorTracker.init(BASE_CONFIG);
    expect(() => ErrorTracker.captureError(undefined)).not.toThrow();
    expect(() => ErrorTracker.captureMessage(null as unknown as string)).not.toThrow();
    expect(() => ErrorTracker.setUser({} as unknown as { id: string })).not.toThrow();
    expect(() => ErrorTracker.addBreadcrumb(null as unknown as { type: string; message: string })).not.toThrow();
  });

  it('is silent on the console unless debug is enabled', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    ErrorTracker.init({ ...BASE_CONFIG, apiKey: '' }); // invalid → would warn in debug
    ErrorTracker.init(BASE_CONFIG);
    ErrorTracker.captureMessage('quiet');
    await ErrorTracker.flush();
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it('logs diagnostics when debug is enabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ErrorTracker.init({ ...BASE_CONFIG, apiKey: '', debug: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ErrorTracker] invalid config'));
  });

  describe('only schema fields leave the page', () => {
    const SECRET = 'not-part-of-the-schema';

    it('ignores unknown init options', async () => {
      ErrorTracker.init({ ...BASE_CONFIG, ...{ notAnOption: true } } as typeof BASE_CONFIG);
      ErrorTracker.captureError(new Error('still works'));
      await ErrorTracker.flush();
      expect(sentEvents().map((e) => e.error?.message)).toEqual(['still works']);
      expectSchemaShape(sentEvents()[0]);
      expect(document.querySelectorAll('script')).toHaveLength(0);
    });

    it('drops extra fields added by an untyped beforeSend', async () => {
      ErrorTracker.init({ ...BASE_CONFIG, beforeSend: (event) => ({ ...event, extra: SECRET }) as TrackerEvent });
      ErrorTracker.captureError(new Error('caught'));
      await ErrorTracker.flush();

      expectSchemaShape(sentEvents()[0]);
      expect(String(fetchMock.calls[0].init.body)).not.toContain(SECRET);
    });

    it('drops extra fields from events found in the offline queue', async () => {
      const stored = { ...buildEvent(
        { eventType: 'error', level: 'error', error: { message: 'stored earlier', type: 'Error', handled: false }, stacktrace: [], context: null },
        makeScope(),
        '2026-10-20T10:00:00.000Z',
      ), extra: SECRET };
      localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify([stored]));

      ErrorTracker.init(BASE_CONFIG);
      await ErrorTracker.flush();

      expect(sentEvents().map((e) => e.error?.message)).toEqual(['stored earlier']);
      expectSchemaShape(sentEvents()[0]);
      expect(String(fetchMock.calls[0].init.body)).not.toContain(SECRET);
    });
  });

  describe('HTTP error responses', () => {
    const STATUS_BY_PATH: Record<string, number> = { '/api/fail': 500, '/api/missing': 404, '/api/ok': 200, '/api/login': 401, '/api/invalid': 422 };
    let received: TrackerEvent[];

    beforeEach(() => {
      received = [];
      const routedFetch = vi.fn((input: string, init?: RequestInit) => {
        if (input === ENDPOINT) {
          received.push(...(JSON.parse(String(init?.body)) as { events: TrackerEvent[] }).events);
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        return Promise.resolve(new Response(null, { status: STATUS_BY_PATH[new URL(input, location.href).pathname] }));
      });
      vi.stubGlobal('fetch', routedFetch);
      window.fetch = routedFetch as unknown as typeof fetch;
    });

    it('reports 5xx and client-bug 4xx responses (default statuses) as HttpError events, but not 2xx', async () => {
      ErrorTracker.init(BASE_CONFIG);
      await window.fetch('/api/ok');
      await window.fetch('/api/fail', { method: 'POST' });
      await window.fetch('/api/missing?id=7');
      await ErrorTracker.flush();

      expect(received.map((e) => e.error)).toEqual([
        { message: 'POST http://localhost:3000/api/fail → 500', type: 'HttpError', handled: true },
        { message: 'GET http://localhost:3000/api/missing → 404', type: 'HttpError', handled: true },
      ]);
      expectSchemaShape(received[0]);
      expect(received[0].event_type).toBe('error');
      expect(received[1].breadcrumbs).toContainEqual(expect.objectContaining({ type: 'api', message: 'GET http://localhost:3000/api/missing → 404' }));
    });

    it('skips 4xx statuses that are normal app flow by default', async () => {
      ErrorTracker.init(BASE_CONFIG);
      await window.fetch('/api/login');
      await window.fetch('/api/invalid');
      await ErrorTracker.flush();
      expect(received).toHaveLength(0);
    });

    it('reports only the statuses listed in httpErrorStatuses', async () => {
      ErrorTracker.init({ ...BASE_CONFIG, httpErrorStatuses: [401, [420, 429]] });
      await window.fetch('/api/login');
      await window.fetch('/api/invalid');
      await window.fetch('/api/fail');
      await window.fetch('/api/missing');
      await ErrorTracker.flush();
      expect(received.map((e) => e.context)).toEqual([
        expect.objectContaining({ status: 401 }),
        expect.objectContaining({ status: 422 }),
      ]);
    });

    it('can be turned off with captureHttpErrors: false', async () => {
      ErrorTracker.init({ ...BASE_CONFIG, captureHttpErrors: false });
      await window.fetch('/api/fail');
      await ErrorTracker.flush();
      expect(received).toHaveLength(0);
    });
  });

  it('sends one summary event for events dropped during an error storm', async () => {
    vi.useFakeTimers();
    ErrorTracker.init(BASE_CONFIG);
    for (let i = 0; i < RATE_LIMIT_MAX_EVENTS + 50; i++) ErrorTracker.captureMessage('storm ' + i, 'error');
    await vi.advanceTimersByTimeAsync(10000); // summary delay
    await ErrorTracker.flush();
    vi.useRealTimers();

    const summary = sentEvents().filter((e) => e.error && e.error.type === 'EventsDropped');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ event_type: 'message', level: 'warning', context: { dropped_count: 50 } });
    expect(sentEvents()).toHaveLength(RATE_LIMIT_MAX_EVENTS + 1);
  });

  describe('page views (transaction events)', () => {
    it('sends each page view with its request spans, in the shared schema shape', async () => {
      ErrorTracker.init({ ...BASE_CONFIG, performanceSampleRate: 1 });
      await window.fetch('https://app.test/api/cart?session=abc', { method: 'POST', body: '{"events":[]}' });
      window.history.pushState(null, '', '/checkout?step=2');
      await ErrorTracker.close();

      const views = sentEvents().filter((e) => e.event_type === 'transaction');
      expect(views.map((e) => e.transaction !== null && e.transaction.kind)).toEqual(['pageload', 'navigation']);
      views.forEach(expectSchemaShape);
      const [load, nav] = views;
      expect(load).toMatchObject({ level: 'info', error: null, breadcrumbs: [], context: null });
      expect(load.transaction).toMatchObject({ name: '/', background: false });
      expect(load.transaction && load.transaction.spans).toEqual([
        expect.objectContaining({ op: 'http', method: 'POST', url: 'https://app.test/api/cart', status: 202 }),
      ]);
      expect(nav.transaction).toMatchObject({ name: '/checkout', kind: 'navigation', spans: [] });
      window.history.replaceState(null, '', '/');
    });

    it('samples page views with performanceSampleRate, independently of sampleRate', async () => {
      ErrorTracker.init({ ...BASE_CONFIG, performanceSampleRate: 1, sampleRate: 0 });
      ErrorTracker.captureError(new Error('dropped by sampleRate'));
      await ErrorTracker.close();
      expect(sentEvents().map((e) => e.event_type)).toEqual(['transaction']);
    });

    it('lets beforeSendTransaction drop page views, and keeps beforeSend for errors only', async () => {
      const beforeSend = vi.fn((event: TrackerEvent) => event);
      ErrorTracker.init({ ...BASE_CONFIG, performanceSampleRate: 1, beforeSend, beforeSendTransaction: () => null });
      ErrorTracker.captureError(new Error('kept'));
      await ErrorTracker.close();
      expect(sentEvents().map((e) => e.event_type)).toEqual(['error']);
      expect(beforeSend).toHaveBeenCalledTimes(1);
    });

    it('sets transaction: null on every other event', async () => {
      ErrorTracker.init(BASE_CONFIG);
      ErrorTracker.captureMessage('hello');
      await ErrorTracker.flush();
      expect(sentEvents()[0].transaction).toBeNull();
    });

    it('sends no SlowApiCall issue unless captureSlowEvents is on', async () => {
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      ErrorTracker.init(BASE_CONFIG);
      const pending = window.fetch('https://app.test/api/report', { method: 'POST', body: '{"events":[]}' });
      clock += 9000;
      await pending;
      await ErrorTracker.flush();
      expect(sentEvents().filter((e) => e.error !== null && e.error.type === 'SlowApiCall')).toHaveLength(0);
    });
  });

  describe('screens (setScreen)', () => {
    it('sends screen: null until the app sets one', async () => {
      ErrorTracker.init(BASE_CONFIG);
      ErrorTracker.captureMessage('before');
      await ErrorTracker.flush();
      const [event] = sentEvents();
      expectSchemaShape(event);
      expect(event.screen).toBeNull();
    });

    it('attaches the current screen to later events and leaves a navigation breadcrumb', async () => {
      ErrorTracker.init(BASE_CONFIG);
      ErrorTracker.setScreen('  LoanApproval ');
      ErrorTracker.captureError(new Error('on loan screen'));
      ErrorTracker.setScreen('Dashboard');
      ErrorTracker.captureError(new Error('on dashboard'));
      ErrorTracker.setScreen(null);
      ErrorTracker.captureError(new Error('after clearing'));
      await ErrorTracker.flush();

      const events = sentEvents();
      expect(events.map((e) => e.screen)).toEqual(['LoanApproval', 'Dashboard', null]);
      expect(events[1].breadcrumbs).toContainEqual(
        expect.objectContaining({ type: 'navigation', message: 'Screen: Dashboard', data: { from: 'LoanApproval', to: 'Dashboard', trigger: 'setScreen' } }),
      );
      expect(events[2].breadcrumbs).toContainEqual(expect.objectContaining({ type: 'navigation', message: 'Screen cleared' }));
    });

    it('ignores repeats of the current screen, empty names and non-strings', async () => {
      ErrorTracker.init(BASE_CONFIG);
      ErrorTracker.setScreen('Home');
      ErrorTracker.setScreen('Home');
      ErrorTracker.setScreen(42 as unknown as string);
      ErrorTracker.captureMessage('check');
      await ErrorTracker.flush();
      const [event] = sentEvents();
      expect(event.screen).toBe('Home');
      expect(event.breadcrumbs.filter((b) => b.type === 'navigation')).toHaveLength(1);
    });

    it('cuts long screen names', async () => {
      ErrorTracker.init(BASE_CONFIG);
      ErrorTracker.setScreen('S'.repeat(500));
      ErrorTracker.captureMessage('check');
      await ErrorTracker.flush();
      const screen = sentEvents()[0].screen;
      expect(screen !== null && screen.length).toBeLessThanOrEqual(201);
    });

    it('applies a setScreen() call made before init()', async () => {
      ErrorTracker.setScreen('Login');
      ErrorTracker.init(BASE_CONFIG);
      ErrorTracker.captureMessage('check');
      await ErrorTracker.flush();
      expect(sentEvents()[0].screen).toBe('Login');
    });

    it('starts a new page view per screen on the same URL, each sent with its own screen', async () => {
      ErrorTracker.init({ ...BASE_CONFIG, performanceSampleRate: 1 });
      await window.fetch('https://app.test/api/config', { method: 'POST', body: '{"events":[]}' });
      // The first screen names the page-load view instead of splitting it, so its vitals belong to "Login".
      ErrorTracker.setScreen('Login');
      await window.fetch('https://app.test/api/login', { method: 'POST', body: '{"events":[]}' });
      ErrorTracker.setScreen('Dashboard');
      await window.fetch('https://app.test/api/summary', { method: 'POST', body: '{"events":[]}' });
      ErrorTracker.setScreen(null);
      ErrorTracker.setScreen('Settings');
      await ErrorTracker.close();

      const views = sentEvents().filter((e) => e.event_type === 'transaction');
      expect(views.map((e) => [e.screen, e.transaction !== null && e.transaction.kind, e.transaction !== null && e.transaction.name])).toEqual([
        ['Login', 'pageload', '/'],
        ['Dashboard', 'navigation', '/'],
        // Clearing ends the Dashboard view; the unnamed view that follows takes the next name.
        ['Settings', 'navigation', '/'],
      ]);
      expect(views[0].transaction && views[0].transaction.spans.map((s) => s.url)).toEqual(['https://app.test/api/config', 'https://app.test/api/login']);
      expect(views[1].transaction && views[1].transaction.spans.map((s) => s.url)).toEqual(['https://app.test/api/summary']);
    });

    it('sends a transaction ended by a screen change with the old screen, though it is sent later', async () => {
      vi.useFakeTimers();
      try {
        ErrorTracker.init({ ...BASE_CONFIG, performanceSampleRate: 1 });
        ErrorTracker.setScreen('A');
        ErrorTracker.setScreen('B'); // view "A" ends; it is reported ~250 ms later, after "B" is current
        await vi.advanceTimersByTimeAsync(1000);
        ErrorTracker.setScreen('C');
        await vi.advanceTimersByTimeAsync(1000);
        await ErrorTracker.flush();
        const views = sentEvents().filter((e) => e.event_type === 'transaction');
        expect(views.map((e) => e.screen)).toEqual(['A', 'B']);
      } finally {
        await ErrorTracker.close();
        vi.useRealTimers();
      }
    });
  });

  describe('memory leaks', () => {
    const MB = 1024 * 1024;

    /** Runs the SDK for `minutes` with a heap whose size is `usedMb(elapsedMs)`. */
    async function runWithHeap(minutes: number, usedMb: (elapsedMs: number) => number): Promise<TrackerEvent[]> {
      vi.useFakeTimers();
      const start = Date.now();
      vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - start);
      Object.defineProperty(performance, 'memory', {
        configurable: true,
        get: () => ({ usedJSHeapSize: usedMb(Date.now() - start) * MB, totalJSHeapSize: 512 * MB }),
      });
      ErrorTracker.init({ ...BASE_CONFIG, memoryPollIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(minutes * 60000);
      await ErrorTracker.flush();
      vi.useRealTimers();
      delete (performance as unknown as Record<string, unknown>).memory;
      return sentEvents().filter((e) => e.error !== null && e.error.type === 'MemoryLeakSuspected');
    }

    it('sends one MemoryLeakSuspected event, with measurements, for a heap that keeps growing', async () => {
      // +6 MB a minute, with garbage-collection churn of up to 8 MB on top.
      const leaks = await runWithHeap(6, (ms) => 50 + (ms / 60000) * 6 + ((ms / 5000) % 3) * 4);

      expect(leaks).toHaveLength(1);
      expect(leaks[0]).toMatchObject({ event_type: 'performance', level: 'warning', memory: { leak_suspected: true } });
      expect(leaks[0].context).toMatchObject({ growth_percent: expect.any(Number), floors_mb: expect.any(Array) });
      const context = leaks[0].context as { baseline_mb: number; current_mb: number; growth_mb: number };
      expect(context.current_mb - context.baseline_mb).toBeCloseTo(context.growth_mb, 1);
      expect(context.growth_mb).toBeGreaterThanOrEqual(10);
    });

    it('sends nothing for a heap that grows at startup and then holds steady', async () => {
      // 8 MB to 40 MB in the first 90 s (screens loading), then level with churn.
      const leaks = await runWithHeap(12, (ms) => Math.min(40, 8 + ms / 2800) + ((ms / 5000) % 3) * 4);
      expect(leaks).toHaveLength(0);
    });
  });

  it('reports a failed request once, even when the app leaves the rejection uncaught', async () => {
    ErrorTracker.init(BASE_CONFIG);
    const failure = new TypeError('Failed to fetch');
    const appFetch = window.fetch; // the SDK-wrapped fetch
    // Make the underlying network fail for app requests only.
    vi.stubGlobal('fetch', fetchMock.fn);
    const wrapped = appFetch as unknown as (url: string) => Promise<Response>;
    fetchMock.fn.mockImplementationOnce(() => Promise.reject(failure));
    await expect(wrapped('https://api.test/down')).rejects.toBe(failure);
    const unhandled = new Event('unhandledrejection');
    Object.defineProperty(unhandled, 'reason', { value: failure });
    window.dispatchEvent(unhandled);
    await ErrorTracker.flush();

    expect(sentEvents().map((e) => e.error && e.error.type)).toEqual(['NetworkError']);
    expectSchemaShape(sentEvents()[0]);
  });

  it('removes its hooks on close()', async () => {
    const originalPushState = history.pushState;
    ErrorTracker.init(BASE_CONFIG);
    expect(history.pushState).not.toBe(originalPushState);
    await ErrorTracker.close();
    expect(history.pushState).toBe(originalPushState);
    expect(ErrorTracker.isInitialized()).toBe(false);
  });
});
