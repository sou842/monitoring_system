import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLeakTrend, MemoryCollector, MemoryOptions, MemoryReading } from '../src/collectors/memoryCollector';
import { ClsTracker, PerformanceCollector, readPageTimings } from '../src/collectors/performanceCollector';
import { VisibilityTracker } from '../src/core/visibility';
import { NetworkInterceptor } from '../src/collectors/networkInterceptor';
import { parseUserAgent } from '../src/core/device';
import { Logger } from '../src/core/logger';
import { RecordingSink } from './helpers';

const logger = new Logger(false);
const MB = 1024 * 1024;

describe('isLeakTrend', () => {
  const rule = { readings: 4, growth: 0.2, minGrowthBytes: 10 };

  it('needs floors that rise every time, by the ratio and the minimum', () => {
    expect(isLeakTrend([100, 110, 120, 130], 100, rule)).toBe(true); // +30, +30%
    expect(isLeakTrend([100, 130, 130, 140], 100, rule)).toBe(false); // level once: a step, not a trend
    expect(isLeakTrend([100, 120, 140], 100, rule)).toBe(false); // too few floors
    expect(isLeakTrend([100, 105, 110, 115], 100, rule)).toBe(false); // +15%
    expect(isLeakTrend([20, 24, 28, 29], 20, rule)).toBe(false); // +45% but only +9
  });

  it('measures growth from the lowest floor seen, not the oldest one kept', () => {
    expect(isLeakTrend([110, 115, 120, 125], 100, rule)).toBe(true); // +25% over the baseline of 100
    expect(isLeakTrend([110, 115, 120, 125], 110, rule)).toBe(false); // +14% over 110
  });

  it('never reports without a baseline', () => {
    expect(isLeakTrend([100, 110, 120, 130], Infinity, rule)).toBe(false);
    expect(isLeakTrend([100, 110, 120, 130], 0, rule)).toBe(false);
  });
});

describe('MemoryCollector', () => {
  const INTERVAL = 30000;

  /** A collector with a fake clock; `poll()` takes one reading per poll interval. */
  function harness(options: Partial<MemoryOptions> = {}) {
    const sink = new RecordingSink();
    let time = 0;
    let usedMb = 0;
    const collector = new MemoryCollector(
      sink,
      logger,
      () => ({ usedBytes: usedMb * MB, totalBytes: 512 * MB }),
      { intervalMs: INTERVAL, leakGrowth: 0.2, leakMinGrowthMb: 10, leakReadings: 4, ...options },
      () => time,
    );
    return {
      sink,
      collector,
      poll(...mbs: number[]) {
        for (let i = 0; i < mbs.length; i++) {
          usedMb = mbs[i];
          collector.sample();
          time += INTERVAL;
        }
      },
      wait(ms: number) {
        time += ms;
      },
    };
  }

  /** A garbage-collection sawtooth over one 4-poll window whose lowest reading is `floor`. */
  function windowWithFloor(floor: number): number[] {
    return [floor + 20, floor, floor + 35, floor + 10];
  }

  it('ignores a small heap growing while the app starts (the 6.8 MB → 9.2 MB false alarm)', () => {
    const h = harness();
    h.poll(6.8, 7.5); // warm-up
    h.poll(8.0, 8.4, 8.8, 9.2, 9.2, 9.3, 9.2, 9.4, 9.3, 9.3, 9.4, 9.4, 9.5, 9.5, 9.5, 9.6);
    expect(h.sink.issues).toHaveLength(0);
    expect(h.collector.snapshot().leak_suspected).toBe(false);
  });

  it('ignores a heavy screen loading once (one step, then level floors)', () => {
    const h = harness();
    h.poll(40, 45);
    for (const floor of [50, 50, 120, 120, 121, 120, 121, 120]) h.poll(...windowWithFloor(floor));
    expect(h.sink.issues).toHaveLength(0);
  });

  it('ignores allocation churn that garbage collection clears', () => {
    const h = harness();
    h.poll(50, 50);
    for (let i = 0; i < 12; i++) h.poll(...windowWithFloor(50));
    expect(h.sink.issues).toHaveLength(0);
  });

  it('ignores growth during warm-up', () => {
    const h = harness();
    h.poll(10, 80); // the first minute: anything goes
    for (const floor of [80, 80, 80, 80, 80]) h.poll(...windowWithFloor(floor));
    expect(h.sink.issues).toHaveLength(0);
  });

  it('reports a heap that keeps growing after garbage collection, once, with the measurements', () => {
    const h = harness();
    h.poll(45, 48);
    // Floors 50, 55, 60, 65: each window's low is higher than the last.
    for (const floor of [50, 55, 60, 65]) h.poll(...windowWithFloor(floor));
    expect(h.sink.issues).toHaveLength(0); // the 65 MB window isn't complete yet
    h.poll(...windowWithFloor(70)); // its first reading closes the 65 MB window

    expect(h.sink.issues).toHaveLength(1);
    expect(h.sink.issues[0]).toEqual({
      kind: 'MemoryLeakSuspected',
      message: 'JS heap is not being released: it grew from 50MB to 65MB after garbage collection',
      context: {
        baseline_mb: 50,
        current_mb: 65,
        growth_mb: 15,
        growth_percent: 30,
        observed_minutes: 8,
        floors_mb: [50, 55, 60, 65],
        heap_total_mb: 512,
      },
    });
    expect(h.collector.snapshot().leak_suspected).toBe(true);

    for (const floor of [80, 90, 100, 110, 120]) h.poll(...windowWithFloor(floor));
    expect(h.sink.issues).toHaveLength(1); // one report per page load
  });

  it('keeps detecting across navigations (a screen not cleaned up on route change is the classic SPA leak)', () => {
    const h = harness();
    h.poll(60, 60);
    // Each window: the user visits a screen and leaves, and 4 MB stays behind every time.
    for (const floor of [60, 64, 68, 72, 76]) h.poll(...windowWithFloor(floor));
    expect(h.sink.issues).toHaveLength(1);
    expect(h.sink.issues[0].message).toContain('from 60MB to 72MB');
  });

  it('still works when background-tab throttling spreads readings minutes apart', () => {
    const h = harness();
    h.poll(50, 50);
    // One reading per throttled timer run, 5 minutes apart: every reading is its own window.
    for (const mb of [50, 55, 60, 65, 70]) {
      h.poll(mb);
      h.wait(5 * 60000);
    }
    expect(h.sink.issues).toHaveLength(1);
    expect(h.sink.issues[0].context).toMatchObject({ baseline_mb: 50, current_mb: 65 });
  });

  it('respects a custom minimum growth', () => {
    const h = harness({ leakMinGrowthMb: 20 });
    h.poll(50, 50);
    for (const floor of [50, 55, 60, 65, 70]) h.poll(...windowWithFloor(floor));
    expect(h.sink.issues).toHaveLength(0); // +15 MB < 20 MB
    h.poll(...windowWithFloor(75)); // 55 → 70 floors, +20 MB over the 50 MB baseline
    expect(h.sink.issues).toHaveLength(1);
  });

  it('respects a custom growth ratio', () => {
    const h = harness({ leakGrowth: 0.5 });
    h.poll(50, 50);
    for (const floor of [50, 55, 60, 65, 70]) h.poll(...windowWithFloor(floor));
    expect(h.sink.issues).toHaveLength(0); // +30% < 50% (the 70 MB window is still open)
  });

  it('respects a custom number of rising floors', () => {
    const h = harness({ leakReadings: 2 });
    h.poll(50, 50);
    h.poll(...windowWithFloor(50));
    h.poll(...windowWithFloor(65));
    h.poll(...windowWithFloor(65)); // closes the 65 MB window: 50 → 65 is enough with 2 floors
    expect(h.sink.issues).toHaveLength(1);
  });

  it('exposes the latest reading in the snapshot', () => {
    const h = harness();
    h.poll(100, 110);
    expect(h.collector.snapshot()).toEqual({ used_mb: 110, total_mb: 512, leak_suspected: false, oom_kill: null });
  });

  it('reports null fields when performance.memory is unavailable (non-Chromium)', () => {
    const collector = new MemoryCollector(new RecordingSink(), logger, () => null);
    collector.install();
    expect(collector.snapshot()).toEqual({ used_mb: null, total_mb: null, leak_suspected: null, oom_kill: null });
    collector.uninstall();
  });

  it('polls every 30 seconds once installed', () => {
    vi.useFakeTimers();
    const read = vi.fn((): MemoryReading => ({ usedBytes: 50 * MB, totalBytes: 100 * MB }));
    const collector = new MemoryCollector(new RecordingSink(), logger, read);
    collector.install();
    const afterInstall = read.mock.calls.length;
    vi.advanceTimersByTime(30000);
    expect(read.mock.calls.length).toBe(afterInstall + 1);
    collector.uninstall();
    vi.useRealTimers();
  });

  it('polls at a custom interval when given', () => {
    vi.useFakeTimers();
    const read = vi.fn((): MemoryReading => ({ usedBytes: 50 * MB, totalBytes: 100 * MB }));
    const collector = new MemoryCollector(new RecordingSink(), logger, read, {
      intervalMs: 10000,
      leakGrowth: 0.2,
      leakMinGrowthMb: 10,
      leakReadings: 4,
    });
    collector.install();
    const afterInstall = read.mock.calls.length;
    vi.advanceTimersByTime(10000);
    expect(read.mock.calls.length).toBe(afterInstall + 1);
    collector.uninstall();
    vi.useRealTimers();
  });
});

describe('PerformanceCollector', () => {
  function makeCollector() {
    const sink = new RecordingSink();
    const collector = new PerformanceCollector(sink, new NetworkInterceptor('https://ingest.test', logger), logger);
    return { sink, collector };
  }

  it('flags API calls over 2000ms as slow and reports them', () => {
    const { sink, collector } = makeCollector();
    collector.recordApiCall({ url: '/api/cart', method: 'POST', status: 200, duration_ms: 230 });
    collector.recordApiCall({ url: '/api/search', method: 'GET', status: 200, duration_ms: 2500 });

    const snap = collector.snapshot();
    expect(snap.api_calls).toHaveLength(2);
    expect(snap.slow_api_calls).toEqual([{ url: '/api/search', method: 'GET', status: 200, duration_ms: 2500 }]);
    expect(sink.issues).toEqual([
      {
        kind: 'SlowApiCall',
        message: 'Slow API call: GET /api/search',
        context: { url: '/api/search', method: 'GET', status: 200, duration_ms: 2500, threshold_ms: 2000 },
      },
    ]);
  });

  it('uses custom slow thresholds when given', () => {
    const sink = new RecordingSink();
    const collector = new PerformanceCollector(sink, new NetworkInterceptor('https://ingest.test', logger), logger, {
      slowApiCallMs: 3000,
      slowPageLoadMs: 5000,
    });
    collector.recordApiCall({ url: '/api/search', method: 'GET', status: 200, duration_ms: 2500 });
    collector.recordApiCall({ url: '/api/report', method: 'GET', status: 200, duration_ms: 3100 });
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { startTime: 0, loadEventEnd: 4200, responseStart: 320 } as unknown as PerformanceEntry,
    ]);
    collector.measurePageLoad();

    expect(collector.snapshot().slow_screen).toBe(false);
    expect(sink.issues.map((i) => i.message)).toEqual(['Slow API call: GET /api/report']);
  });

  it('flags page loads over 3000ms as slow', () => {
    const { sink, collector } = makeCollector();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { startTime: 0, loadEventEnd: 4200, responseStart: 320 } as unknown as PerformanceEntry,
    ]);
    collector.measurePageLoad();

    expect(collector.snapshot()).toMatchObject({ page_load_ms: 4200, ttfb_ms: 320, slow_screen: true });
    expect(sink.issues).toEqual([
      { kind: 'SlowPageLoad', message: 'Slow page load', context: { page_load_ms: 4200, ttfb_ms: 320, threshold_ms: 3000 } },
    ]);
  });

  it('does not flag fast page loads', () => {
    const { sink, collector } = makeCollector();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { startTime: 0, loadEventEnd: 1200, responseStart: 100 } as unknown as PerformanceEntry,
    ]);
    collector.measurePageLoad();
    expect(collector.snapshot().slow_screen).toBe(false);
    expect(sink.issues).toHaveLength(0);
  });

  it('returns null timings before load has finished', () => {
    const fakePerf = { getEntriesByType: () => [{ startTime: 0, loadEventEnd: 0, responseStart: 0 }] } as unknown as Performance;
    expect(readPageTimings(fakePerf)).toEqual({ pageLoadMs: null, ttfbMs: null });
  });

  it('falls back to Navigation Timing Level 1', () => {
    const fakePerf = {
      getEntriesByType: () => [],
      timing: { navigationStart: 1000, loadEventEnd: 3500, responseStart: 1200 },
    } as unknown as Performance;
    expect(readPageTimings(fakePerf)).toEqual({ pageLoadMs: 2500, ttfbMs: 200 });
  });

  describe('background tabs', () => {
    function setVisibility(state: DocumentVisibilityState, prerendering = false): void {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      Object.defineProperty(document, 'prerendering', { configurable: true, get: () => prerendering });
    }

    afterEach(() => {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      delete (document as unknown as Record<string, unknown>).prerendering;
    });

    function mockPageEntries(loadEventEnd: number, fcp: number, visibilityEntries: PerformanceEntry[] = []): void {
      vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) =>
        type === 'navigation'
          ? [{ startTime: 0, loadEventEnd: loadEventEnd, responseStart: 300 } as unknown as PerformanceEntry]
          : type === 'visibility-state'
            ? visibilityEntries
            : [],
      );
      vi.spyOn(performance, 'getEntriesByName').mockImplementation((name: string) =>
        name === 'first-contentful-paint' ? [{ startTime: fcp } as PerformanceEntry] : [],
      );
    }

    it('works out when the page was hidden, including before the SDK started', () => {
      const tracker = (now: number) => new VisibilityTracker(logger, () => now);
      const entries = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);

      setVisibility('visible');
      let t = tracker(500);
      t.install();
      expect(t.firstHiddenTime()).toBe(Infinity);
      t.uninstall();

      setVisibility('hidden');
      t = tracker(500);
      t.install();
      expect(t.firstHiddenTime()).toBe(0);
      expect(t.wasHiddenBetween(100, 200)).toBe(true);
      t.uninstall();

      setVisibility('hidden', true); // prerendering pages are hidden until shown
      t = tracker(500);
      t.install();
      expect(t.firstHiddenTime()).toBe(Infinity);
      t.uninstall();

      setVisibility('visible');
      entries.mockReturnValue([
        { name: 'visible', startTime: 0 },
        { name: 'hidden', startTime: 1500 },
        { name: 'visible', startTime: 9000 },
      ] as unknown as PerformanceEntry[]);
      t = tracker(10000);
      t.install();
      expect(t.firstHiddenTime()).toBe(1500); // hidden before the SDK loaded
      expect(t.wasHiddenBetween(2000, 3000)).toBe(true);
      expect(t.wasHiddenBetween(9500, 9800)).toBe(false);
      expect(t.wasHiddenBetween(0, 1000)).toBe(false);
      t.uninstall();
    });

    it('tracks hidden periods as they happen', () => {
      const t = new VisibilityTracker(logger);
      t.record(true, 100);
      t.record(false, 300);
      expect(t.wasHiddenBetween(50, 99)).toBe(false);
      expect(t.wasHiddenBetween(250, 400)).toBe(true);
      expect(t.wasHiddenBetween(301, 900)).toBe(false);
      t.record(true, 1000); // still hidden: the period is open-ended
      expect(t.wasHiddenBetween(5000, 6000)).toBe(true);
      expect(t.firstHiddenTime()).toBe(100);
    });

    it('drops FCP and does not judge the load of a page opened in a background tab', () => {
      setVisibility('hidden');
      mockPageEntries(25157, 76648);
      const { sink, collector } = makeCollector();
      collector.install();
      collector.measurePageLoad();

      expect(collector.snapshot()).toMatchObject({ page_load_ms: 25157, fcp_ms: null, slow_screen: false });
      expect(sink.issues).toHaveLength(0);
      collector.uninstall();
    });

    it('does not judge a load that the user sent to the background part-way', () => {
      setVisibility('visible');
      mockPageEntries(8000, 600);
      vi.spyOn(performance, 'now').mockReturnValue(2000);
      const { sink, collector } = makeCollector();
      collector.install();
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      collector.measurePageLoad();

      expect(collector.snapshot()).toMatchObject({ page_load_ms: 8000, fcp_ms: 600, slow_screen: false });
      expect(sink.issues).toHaveLength(0);
      collector.uninstall();
    });

    it('uses a hidden period from before the SDK loaded', () => {
      setVisibility('visible');
      mockPageEntries(5000, 4000, [{ name: 'hidden', startTime: 1000 } as PerformanceEntry]);
      const { sink, collector } = makeCollector();
      collector.install();
      collector.measurePageLoad();

      expect(collector.snapshot()).toMatchObject({ fcp_ms: null, slow_screen: false });
      expect(sink.issues).toHaveLength(0);
      collector.uninstall();
    });

    it('still reports a slow load in a tab that stayed visible', () => {
      setVisibility('visible');
      mockPageEntries(4200, 900);
      const { sink, collector } = makeCollector();
      collector.install();
      collector.measurePageLoad();

      expect(collector.snapshot()).toMatchObject({ page_load_ms: 4200, fcp_ms: 900, slow_screen: true });
      expect(sink.issues).toEqual([
      { kind: 'SlowPageLoad', message: 'Slow page load', context: { page_load_ms: 4200, ttfb_ms: 300, threshold_ms: 3000 } },
    ]);
      collector.uninstall();
    });
  });

  it('computes CLS as the worst session window, ignoring input-driven shifts', () => {
    const cls = new ClsTracker();
    expect(cls.value()).toBeNull();
    cls.add(0.1, 0, false);
    cls.add(0.1, 500, false); // same session → 0.2
    cls.add(5, 600, true); // ignored: recent input
    cls.add(0.05, 3000, false); // new session
    expect(cls.value()).toBe(0.2);
  });
});

describe('parseUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.60 Safari/537.36',
      { browser: 'Chrome', browserVersion: '124.0', os: 'Windows 10', osVersion: '10.0', model: null },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.51',
      { browser: 'Edge', browserVersion: '124.0', os: 'Windows 10', osVersion: '10.0', model: null },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      { browser: 'Safari', browserVersion: '17.4', os: 'macOS 10.15', osVersion: '10.15.7', model: null },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', browserVersion: '17.4', os: 'iOS 17.4', osVersion: '17.4', model: 'iPhone' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome', browserVersion: '124.0', os: 'Android 14', osVersion: '14', model: 'SM-S918B' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
      { browser: 'Firefox', browserVersion: '125.0', os: 'Linux', osVersion: null, model: null },
    ],
  ])('%s', (ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });

  it('returns nulls for an empty user agent (e.g. Node.js without a UA)', () => {
    expect(parseUserAgent('')).toEqual({ browser: null, browserVersion: null, os: null, osVersion: null, model: null });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
