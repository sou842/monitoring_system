import {
  CLS_SESSION_GAP_MS,
  CLS_SESSION_MAX_MS,
  MAX_API_CALLS_TRACKED,
  PAGE_LOAD_SETTLE_MS,
  SLOW_API_CALL_MS,
  SLOW_PAGE_LOAD_MS,
} from '../constants';
import { CircularBuffer } from '../core/circularBuffer';
import { emptyPerformance } from '../core/payloadBuilder';
import { getDocument, getPerformance, getWindow, toMs } from '../core/env';
import { Logger } from '../core/logger';
import { guard, safelyRun } from '../core/safe';
import { ApiCall, PerformancePayload } from '../types';
import { Collector, CollectorSink } from './collector';
import { NetworkInterceptor } from './networkInterceptor';

/** Fields of a `layout-shift` entry (not yet in TypeScript's DOM lib). */
interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

/** Fields of a `largest-contentful-paint` entry. */
interface LcpEntry extends PerformanceEntry {
  renderTime: number;
  loadTime: number;
}

/** Raw page timings, already relative to navigation start. */
export interface PageTimings {
  pageLoadMs: number | null;
  ttfbMs: number | null;
}

/** Reads load time and TTFB from Navigation Timing Level 2, falling back to Level 1. */
export function readPageTimings(perf: Performance): PageTimings {
  const entries = typeof perf.getEntriesByType === 'function' ? perf.getEntriesByType('navigation') : [];
  if (entries.length > 0) {
    const nav = entries[0] as PerformanceNavigationTiming;
    return {
      pageLoadMs: nav.loadEventEnd > 0 ? toMs(nav.loadEventEnd - nav.startTime) : null,
      ttfbMs: nav.responseStart > 0 ? toMs(nav.responseStart - nav.startTime) : null,
    };
  }

  // Fallback: performance.timing (Navigation Timing Level 1) is deprecated but
  // is the only source in Safari < 15 and older Chromium-based webviews.
  // TODO: test on Safari 12-14
  const timing = perf.timing;
  if (timing !== undefined && timing.navigationStart > 0) {
    return {
      pageLoadMs: timing.loadEventEnd > 0 ? toMs(timing.loadEventEnd - timing.navigationStart) : null,
      ttfbMs: timing.responseStart > 0 ? toMs(timing.responseStart - timing.navigationStart) : null,
    };
  }
  return { pageLoadMs: null, ttfbMs: null };
}

/** Tracks CLS using the web-vitals "session window" definition. */
export class ClsTracker {
  private sessionValue = 0;
  private sessionStart = 0;
  private sessionLast = 0;
  private max = 0;
  private seen = false;

  add(value: number, startTime: number, hadRecentInput: boolean): void {
    if (hadRecentInput) return;
    this.seen = true;
    const continuesSession =
      this.sessionValue > 0 &&
      startTime - this.sessionLast < CLS_SESSION_GAP_MS &&
      startTime - this.sessionStart < CLS_SESSION_MAX_MS;
    if (continuesSession) {
      this.sessionValue += value;
    } else {
      this.sessionValue = value;
      this.sessionStart = startTime;
    }
    this.sessionLast = startTime;
    if (this.sessionValue > this.max) this.max = this.sessionValue;
  }

  value(): number | null {
    return this.seen ? Math.round(this.max * 10000) / 10000 : null;
  }
}

/**
 * Collects page-load metrics (load time, TTFB, FCP, LCP, CLS) and the duration
 * of every fetch/XHR call. Reports a `performance` event when the page load
 * exceeds 3 s or an API call exceeds 2 s.
 */
export class PerformanceCollector implements Collector {
  private installed = false;
  private metrics: PerformancePayload = emptyPerformance();
  private readonly apiCalls = new CircularBuffer<ApiCall>(MAX_API_CALLS_TRACKED);
  private readonly slowApiCalls = new CircularBuffer<ApiCall>(MAX_API_CALLS_TRACKED);
  private readonly cls = new ClsTracker();
  private observers: PerformanceObserver[] = [];
  private lcpFinal = false;
  private readonly handleLoad: () => void;
  private readonly finalizeLcp: () => void;

  constructor(
    private readonly sink: CollectorSink,
    private readonly network: NetworkInterceptor,
    private readonly logger: Logger,
  ) {
    const self = this;
    this.handleLoad = guard(logger, 'page load metrics', function onLoad() {
      setTimeout(
        guard(logger, 'page load metrics', function measure() {
          self.measurePageLoad();
        }),
        PAGE_LOAD_SETTLE_MS,
      );
    });
    this.finalizeLcp = function onFirstInput() {
      // LCP stops being reported once the user interacts with the page.
      self.lcpFinal = true;
    };
  }

  install(): void {
    const win = getWindow();
    const doc = getDocument();
    if (this.installed || win === null || doc === null) return;
    this.installed = true;

    const self = this;
    this.network.subscribe(function onApiCall(call) {
      self.recordApiCall(call);
    });

    this.observe('paint', function onPaint(entry) {
      if (entry.name === 'first-contentful-paint') self.metrics.fcp_ms = toMs(entry.startTime);
    });
    this.observe('largest-contentful-paint', function onLcp(entry) {
      if (self.lcpFinal) return;
      const lcp = entry as LcpEntry;
      self.metrics.lcp_ms = toMs(lcp.renderTime || lcp.loadTime || lcp.startTime);
    });
    this.observe('layout-shift', function onShift(entry) {
      const shift = entry as LayoutShiftEntry;
      self.cls.add(shift.value, shift.startTime, shift.hadRecentInput);
    });

    win.addEventListener('keydown', this.finalizeLcp, { once: true, capture: true } as AddEventListenerOptions);
    win.addEventListener('pointerdown', this.finalizeLcp, { once: true, capture: true } as AddEventListenerOptions);

    if (doc.readyState === 'complete') {
      this.handleLoad();
    } else {
      win.addEventListener('load', this.handleLoad);
    }
  }

  uninstall(): void {
    const win = getWindow();
    if (!this.installed || win === null) return;
    for (let i = 0; i < this.observers.length; i++) {
      safelyRun(this.logger, 'disconnect observer', disconnect(this.observers[i]));
    }
    this.observers = [];
    win.removeEventListener('load', this.handleLoad);
    win.removeEventListener('keydown', this.finalizeLcp, true);
    win.removeEventListener('pointerdown', this.finalizeLcp, true);
    this.installed = false;
  }

  /** Current metrics for inclusion in a payload. */
  snapshot(): PerformancePayload {
    const m = this.metrics;
    return {
      page_load_ms: m.page_load_ms,
      ttfb_ms: m.ttfb_ms,
      fcp_ms: m.fcp_ms,
      lcp_ms: m.lcp_ms,
      cls: this.cls.value(),
      startup_ms: null,
      frame_rate_fps: null,
      slow_screen: m.slow_screen,
      api_calls: this.apiCalls.toArray(),
      slow_api_calls: this.slowApiCalls.toArray(),
    };
  }

  /** Records a completed request; exposed so it can be unit-tested without patching fetch. */
  recordApiCall(call: ApiCall): void {
    this.apiCalls.push(call);
    if (call.duration_ms > SLOW_API_CALL_MS) {
      this.slowApiCalls.push(call);
      this.sink.onPerformanceIssue(
        'SlowApiCall',
        'Slow API call: ' + call.method + ' ' + call.url + ' took ' + call.duration_ms + 'ms',
      );
    }
  }

  /** Reads navigation timings; exposed for tests. */
  measurePageLoad(): void {
    const perf = getPerformance();
    if (perf === null) return;
    const timings = readPageTimings(perf);
    this.metrics.page_load_ms = timings.pageLoadMs;
    this.metrics.ttfb_ms = timings.ttfbMs;

    if (this.metrics.fcp_ms === null && typeof perf.getEntriesByName === 'function') {
      const fcp = perf.getEntriesByName('first-contentful-paint');
      if (fcp.length > 0) this.metrics.fcp_ms = toMs(fcp[0].startTime);
    }

    if (timings.pageLoadMs !== null && timings.pageLoadMs > SLOW_PAGE_LOAD_MS) {
      this.metrics.slow_screen = true;
      this.sink.onPerformanceIssue('SlowPageLoad', 'Slow page load: ' + timings.pageLoadMs + 'ms');
    }
  }

  private observe(type: string, onEntry: (entry: PerformanceEntry) => void): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const supported = PerformanceObserver.supportedEntryTypes;
    if (supported !== undefined && supported.indexOf(type) === -1) return;

    const logger = this.logger;
    safelyRun(logger, 'observe ' + type, () => {
      const observer = new PerformanceObserver(
        guard(logger, type + ' observer', function onList(list: PerformanceObserverEntryList) {
          const entries = list.getEntries();
          for (let i = 0; i < entries.length; i++) onEntry(entries[i]);
        }),
      );
      observer.observe({ type: type, buffered: true });
      this.observers.push(observer);
    });
  }
}

function disconnect(observer: PerformanceObserver): () => void {
  return function run() {
    observer.disconnect();
  };
}
