import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeInp, PageViewCollector, ResourceTiming, timingBreakdown } from '../src/collectors/pageViewCollector';
import { NetworkListener, RequestDetails } from '../src/collectors/networkInterceptor';
import { Logger } from '../src/core/logger';
import { emptyPerformance } from '../src/core/payloadBuilder';
import { VisibilityTracker } from '../src/core/visibility';
import { ApiCall, PerformancePayload, TransactionPayload } from '../src/types';

const logger = new Logger(false);
const TIME_ORIGIN = Date.UTC(2026, 9, 23, 10, 0, 0);

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

/** A collector with a fake clock, network and page-load metrics. */
function harness(options: { sampleRate?: number; random?: number; load?: Partial<PerformancePayload> } = {}) {
  let clock = 0;
  let listener: NetworkListener | null = null;
  const sent: TransactionPayload[] = [];
  const visibility = new VisibilityTracker(logger, () => clock);
  const collector = new PageViewCollector(
    (payload) => sent.push(payload),
    { subscribe: (l: NetworkListener) => (listener = l) },
    { snapshot: () => ({ ...emptyPerformance(), ttfb_ms: 120, fcp_ms: 800, lcp_ms: 1400, cls: 0.05, page_load_ms: 1900, ...options.load }) },
    visibility,
    logger,
    { sampleRate: options.sampleRate !== undefined ? options.sampleRate : 1, random: () => (options.random !== undefined ? options.random : 0), now: () => clock, timeOrigin: TIME_ORIGIN },
  );
  return {
    collector,
    visibility,
    sent,
    setClock(ms: number) {
      clock = ms;
    },
    /** A finished request, as the network interceptor reports it. */
    request(url: string, start: number, end: number, status = 200, method = 'GET') {
      clock = end;
      const call: ApiCall = { url: url.replace(/[?#].*$/, ''), method: method, status: status, duration_ms: end - start };
      const details: RequestDetails = { failure: null, error: null, callSite: () => [], startTime: start, endTime: end, rawUrl: url };
      if (listener !== null) listener(call, details);
    },
  };
}

function resource(name: string, startTime: number, requestStart: number, responseStart: number, responseEnd: number, transferSize = 2048): ResourceTiming {
  return { name, initiatorType: 'fetch', startTime, requestStart, responseStart, responseEnd, transferSize };
}

describe('computeInp', () => {
  it('is the worst interaction, skipping one outlier per 50', () => {
    expect(computeInp([])).toBeNull();
    expect(computeInp([40, 120, 64])).toBe(120);
    const many = Array.from({ length: 60 }, (_, i) => 50 + i); // 50..109
    expect(computeInp(many)).toBe(108); // the single worst (109) is skipped
  });
});

describe('timingBreakdown', () => {
  it('splits a request into server and download time', () => {
    expect(timingBreakdown(resource('x', 100, 110, 610, 700))).toEqual({ server_ms: 500, download_ms: 90, size_bytes: 2048 });
  });

  it('returns nulls for cross-origin requests without Timing-Allow-Origin', () => {
    expect(timingBreakdown({ ...resource('x', 100, 0, 0, 700), transferSize: 0, encodedBodySize: 0 })).toEqual({
      server_ms: null,
      download_ms: null,
      size_bytes: null,
    });
  });
});

describe('PageViewCollector', () => {
  it('sends the page load as a view with vitals, INP, long tasks and request spans', () => {
    const h = harness();
    h.collector.install();
    h.request('http://localhost:3000/api/cart?session=abc', 100, 700);
    h.collector.recordResource(resource('http://localhost:3000/api/cart?session=abc', 101, 110, 610, 690));
    h.collector.recordResource({ ...resource('http://localhost:3000/style.css', 0, 1, 2, 3), initiatorType: 'link' }); // not a request
    h.collector.recordInteraction(1, 48);
    h.collector.recordInteraction(1, 96); // same click, longer event: the longest counts
    h.collector.recordInteraction(2, 72);
    h.collector.recordLongTask(120);
    h.collector.recordLongTask(60);
    h.setClock(5000);
    h.collector.onNavigation('http://localhost:3000/products/42?tab=reviews');
    expect(h.sent).toHaveLength(0); // waits a moment for late timing entries
    h.collector.flushDeferred();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({
      name: '/',
      kind: 'pageload',
      start: new Date(TIME_ORIGIN).toISOString(),
      duration_ms: 5000,
      background: false,
      vitals: { ttfb_ms: 120, fcp_ms: 800, lcp_ms: 1400, cls: 0.05, inp_ms: 96, page_load_ms: 1900 },
      long_tasks: { count: 2, blocking_ms: 80 },
      spans: [
        {
          op: 'http',
          method: 'GET',
          url: 'http://localhost:3000/api/cart',
          status: 200,
          failure: null,
          start_ms: 100,
          duration_ms: 600,
          server_ms: 500,
          download_ms: 80,
          size_bytes: 2048,
          background: false,
        },
      ],
      dropped_spans: 0,
    });
    h.collector.uninstall();
  });

  it('starts a navigation view on route change, without page-load vitals', () => {
    const h = harness();
    h.collector.install();
    h.setClock(2000);
    h.collector.onNavigation('/products/42?tab=reviews');
    h.request('http://localhost:3000/api/products/42', 2100, 2400);
    h.collector.recordInteraction(7, 200);
    h.setClock(9000);
    h.collector.flushDeferred(); // the page-load view, still waiting after the route change
    h.collector.finish();

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({
      name: '/products/42',
      kind: 'navigation',
      start: new Date(TIME_ORIGIN + 2000).toISOString(),
      duration_ms: 7000,
      vitals: { ttfb_ms: null, fcp_ms: null, lcp_ms: null, cls: null, inp_ms: 200, page_load_ms: null },
    });
    expect(h.sent[1].spans[0]).toMatchObject({ start_ms: 100, duration_ms: 300 });
    h.collector.uninstall();
  });

  it('ends the view when the tab is hidden and continues it when the tab comes back', () => {
    const h = harness();
    h.collector.install();
    h.setClock(3000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.sent.map((v) => v.kind)).toEqual(['pageload']);

    h.setClock(60000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    h.request('http://localhost:3000/api/feed', 60100, 60300);
    h.setClock(65000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(h.sent.map((v) => v.kind)).toEqual(['pageload', 'continued']);
    expect(h.sent[1]).toMatchObject({ name: '/', duration_ms: 5000, start: new Date(TIME_ORIGIN + 60000).toISOString() });
    h.collector.uninstall();
  });

  it('does not send a continued view with nothing in it', () => {
    const h = harness();
    h.collector.install();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.sent.map((v) => v.kind)).toEqual(['pageload']);
    h.collector.uninstall();
  });

  it('flags requests and page loads that overlapped a hidden period', () => {
    const h = harness();
    h.collector.install();
    h.visibility.record(true, 500);
    h.visibility.record(false, 900);
    h.request('http://localhost:3000/api/a', 400, 1200); // overlaps 500–900
    h.request('http://localhost:3000/api/b', 1000, 1300);
    h.setClock(4000);
    h.collector.finish();

    expect(h.sent[0].spans.map((s) => s.background)).toEqual([true, false]);
    expect(h.sent[0].background).toBe(true);
    expect(h.sent[0].vitals.page_load_ms).toBeNull(); // the load (1900 ms) overlapped the hidden period
    h.collector.uninstall();
  });

  it('keeps at most 100 spans per view and counts the rest', () => {
    const h = harness();
    h.collector.install();
    for (let i = 0; i < 105; i++) h.request('http://localhost:3000/api/item/' + i, i * 10, i * 10 + 5);
    h.collector.finish();
    expect(h.sent[0].spans).toHaveLength(100);
    expect(h.sent[0].dropped_spans).toBe(5);
    h.collector.uninstall();
  });

  it('splits a view that stays open longer than 30 minutes', () => {
    vi.useFakeTimers();
    const h = harness();
    h.collector.install();
    h.setClock(31 * 60000);
    vi.advanceTimersByTime(60000 + 250);
    expect(h.sent.map((v) => v.kind)).toEqual(['pageload']);
    h.request('http://localhost:3000/api/poll', 31 * 60000 + 10, 31 * 60000 + 50);
    h.collector.finish();
    expect(h.sent.map((v) => v.kind)).toEqual(['pageload', 'continued']);
    h.collector.uninstall();
    vi.useRealTimers();
  });

  it('records nothing for a page load that was not sampled', () => {
    const h = harness({ sampleRate: 0.5, random: 0.9 });
    h.collector.install();
    h.request('http://localhost:3000/api/a', 0, 10);
    h.collector.onNavigation('/next');
    h.collector.finish();
    expect(h.sent).toHaveLength(0);
    h.collector.uninstall();
  });

  it('takes the timing breakdown from the timeline when the observer has not delivered it yet', () => {
    const h = harness();
    h.collector.install();
    h.request('http://localhost:3000/api/slow', 100, 1600);
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue([resource('http://localhost:3000/api/slow', 102, 110, 1580, 1595) as unknown as PerformanceEntry]);
    h.collector.finish();
    expect(h.sent[0].spans[0]).toMatchObject({ server_ms: 1470, download_ms: 15 });
    h.collector.uninstall();
  });

  it('sends a view ended by a route change a moment later, with timing entries that arrived meanwhile', () => {
    vi.useFakeTimers();
    const h = harness();
    h.collector.install();
    h.request('http://localhost:3000/api/login', 100, 900);
    h.collector.onNavigation('/home');
    expect(h.sent).toHaveLength(0);
    h.collector.recordResource(resource('http://localhost:3000/api/login', 101, 105, 880, 895)); // ~60 ms late
    vi.advanceTimersByTime(250);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].spans[0]).toMatchObject({ server_ms: 775, download_ms: 15 });
    h.collector.uninstall();
    vi.useRealTimers();
  });

  it('sends waiting views at once when the tab is hidden', () => {
    const h = harness();
    h.collector.install();
    h.collector.onNavigation('/home');
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.sent.map((v) => v.kind)).toEqual(['pageload', 'navigation']);
    h.collector.uninstall();
  });

  it('starts no page-load view when the page loads in a background tab', () => {
    setVisibility('hidden');
    const h = harness();
    h.collector.install();
    h.collector.finish();
    expect(h.sent).toHaveLength(0);
    h.collector.uninstall();
  });
});
