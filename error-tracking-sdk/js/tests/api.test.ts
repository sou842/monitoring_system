import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_STORAGE_KEY, RATE_LIMIT_MAX_EVENTS } from '../src/constants';
import ErrorTracker from '../src/index';
import { TrackerEvent } from '../src/types';
import { expectSchemaShape, mockFetch, settle } from './helpers';

const ENDPOINT = 'https://ingest.test/v1/events';
const BASE_CONFIG = {
  apiKey: 'pk_test_123',
  endpoint: ENDPOINT,
  environment: 'staging',
  appVersion: '2.1.4',
  captureScreenshots: false,
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
      screenshot: null,
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

  it('attaches a masked screenshot to error events and flush() waits for it', async () => {
    document.body.innerHTML = '<div class="ssn">123-45-6789</div><p>public</p>';
    vi.spyOn(document.querySelector('.ssn') as Element, 'getBoundingClientRect').mockReturnValue({
      left: 5, top: 6, width: 70, height: 20, right: 75, bottom: 26, x: 5, y: 6, toJSON: () => ({}),
    } as DOMRect);
    const fillRect = vi.fn();
    const win = window as Window & { html2canvas?: unknown };
    win.html2canvas = vi.fn(() =>
      Promise.resolve({ getContext: () => ({ fillStyle: '', fillRect }), toDataURL: () => 'data:image/jpeg;base64,MASKED' }),
    );

    ErrorTracker.init({ ...BASE_CONFIG, captureScreenshots: true, maskSelectors: ['.ssn'] });
    ErrorTracker.captureError(new Error('with screenshot'));
    await ErrorTracker.flush();

    expect(sentEvents()[0].screenshot).toBe('data:image/jpeg;base64,MASKED');
    expect(fillRect).toHaveBeenCalledWith(5, 6, 70, 20);
    delete win.html2canvas;
    document.body.innerHTML = '';
  });

  describe('HTTP error responses', () => {
    const STATUS_BY_PATH: Record<string, number> = { '/api/fail': 500, '/api/missing': 404, '/api/ok': 200 };
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

    it('reports 4xx and 5xx responses as HttpError events, but not 2xx', async () => {
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
