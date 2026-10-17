import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLeakPattern, MemoryCollector, MemoryReading } from '../src/collectors/memoryCollector';
import { ClsTracker, PerformanceCollector, readPageTimings } from '../src/collectors/performanceCollector';
import { NetworkInterceptor } from '../src/collectors/networkInterceptor';
import { parseUserAgent } from '../src/core/device';
import { Logger } from '../src/core/logger';
import { RecordingSink } from './helpers';

const logger = new Logger(false);
const MB = 1024 * 1024;

describe('MemoryCollector', () => {
  it('detects >20% growth across 3 strictly increasing readings', () => {
    expect(isLeakPattern([100, 110, 121])).toBe(true); // +21%
    expect(isLeakPattern([100, 110, 119])).toBe(false); // +19%
    expect(isLeakPattern([100, 130, 125])).toBe(false); // not monotonic
    expect(isLeakPattern([100, 150])).toBe(false); // too few readings
  });

  function collectorWith(readings: Array<MemoryReading | null>) {
    const sink = new RecordingSink();
    const queue = readings.slice();
    const collector = new MemoryCollector(sink, logger, () => (queue.length > 0 ? (queue.shift() as MemoryReading | null) : null));
    return { sink, collector };
  }

  it('reports a leak once and exposes it in the snapshot', () => {
    const r = (mb: number): MemoryReading => ({ usedBytes: mb * MB, totalBytes: 256 * MB });
    const { sink, collector } = collectorWith([r(100), r(110), r(125), r(140)]);
    collector.sample();
    collector.sample();
    expect(collector.snapshot()).toEqual({ used_mb: 110, total_mb: 256, leak_suspected: false, oom_kill: null });

    collector.sample();
    collector.sample();
    expect(sink.issues).toHaveLength(1);
    expect(sink.issues[0].kind).toBe('MemoryLeakSuspected');
    expect(collector.snapshot().leak_suspected).toBe(true);
  });

  it('resets the baseline on navigation', () => {
    const r = (mb: number): MemoryReading => ({ usedBytes: mb * MB, totalBytes: 256 * MB });
    const { sink, collector } = collectorWith([r(100), r(110), r(130)]);
    collector.sample();
    collector.sample();
    collector.resetBaseline();
    collector.sample();
    expect(sink.issues).toHaveLength(0);
  });

  it('reports null fields when performance.memory is unavailable (non-Chromium)', () => {
    const { collector } = collectorWith([]);
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
    expect(sink.issues).toEqual([{ kind: 'SlowApiCall', message: 'Slow API call: GET /api/search took 2500ms' }]);
  });

  it('flags page loads over 3000ms as slow', () => {
    const { sink, collector } = makeCollector();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { startTime: 0, loadEventEnd: 4200, responseStart: 320 } as unknown as PerformanceEntry,
    ]);
    collector.measurePageLoad();

    expect(collector.snapshot()).toMatchObject({ page_load_ms: 4200, ttfb_ms: 320, slow_screen: true });
    expect(sink.issues).toEqual([{ kind: 'SlowPageLoad', message: 'Slow page load: 4200ms' }]);
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
