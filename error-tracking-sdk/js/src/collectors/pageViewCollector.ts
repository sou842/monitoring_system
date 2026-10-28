import {
  EVENT_TIMING_THRESHOLD_MS,
  INP_INTERACTIONS_PER_OUTLIER,
  INP_MAX_TRACKED,
  LONG_TASK_BLOCKING_THRESHOLD_MS,
  BREAKDOWN_SETTLE_MS,
  MAX_PENDING_RESOURCE_ENTRIES,
  MAX_SPANS_PER_VIEW,
  MAX_VIEW_DURATION_MS,
  RESOURCE_MATCH_TOLERANCE_MS,
  VIEW_CHECK_INTERVAL_MS,
} from '../constants';
import { absoluteUrl, getDocument, getPerformance, getWindow, nowMs, stripQuery, toMs } from '../core/env';
import { Logger } from '../core/logger';
import { guard, safelyRun } from '../core/safe';
import { VisibilityTracker } from '../core/visibility';
import { ApiCall, PerformancePayload, Span, TransactionPayload, TransactionVitals } from '../types';
import { Collector } from './collector';
import { NetworkListener, RequestDetails } from './networkInterceptor';

/** `initiatorType` values of Resource Timing entries made by fetch and XHR. */
const REQUEST_INITIATORS = ['fetch', 'xmlhttprequest'];

/** The fields of a Resource Timing entry used for the server/download breakdown. */
export interface ResourceTiming {
  name: string;
  initiatorType: string;
  startTime: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  transferSize?: number;
  encodedBodySize?: number;
}

/** An Event Timing entry; `interactionId` is 0 for events that aren't part of a click or key press. */
interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
}

/** A span while its view is open: the raw URL and clock times are needed to match Resource Timing. */
interface PendingSpan {
  span: Span;
  rawUrl: string;
  startTime: number;
}

interface OpenView {
  name: string;
  /** The app screen (`setScreen()`) when the view started; a view never spans two screens. */
  screen: string | null;
  kind: TransactionPayload['kind'];
  startTime: number;
  spans: PendingSpan[];
  droppedSpans: number;
  /** Longest duration per interaction id, for INP. */
  interactions: Record<string, number>;
  longTaskCount: number;
  blockingMs: number;
}

/**
 * Computes INP (Interaction to Next Paint) from the longest duration of each
 * interaction: the worst one, except that one outlier is skipped per 50
 * interactions, as in web-vitals.
 */
export function computeInp(durations: readonly number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = durations.slice().sort(function desc(a, b) {
    return b - a;
  });
  const index = Math.min(Math.floor(durations.length / INP_INTERACTIONS_PER_OUTLIER), INP_MAX_TRACKED - 1, sorted.length - 1);
  return Math.round(sorted[index]);
}

/** Server and download time of a request from its Resource Timing entry; null for parts the browser hides. */
export function timingBreakdown(entry: ResourceTiming): Pick<Span, 'server_ms' | 'download_ms' | 'size_bytes'> {
  // Cross-origin requests without Timing-Allow-Origin report these as 0.
  const detailed = entry.requestStart > 0 && entry.responseStart > 0;
  const size = entry.transferSize || entry.encodedBodySize || 0;
  return {
    server_ms: detailed ? toMs(entry.responseStart - entry.requestStart) : null,
    download_ms: detailed && entry.responseEnd > 0 ? toMs(entry.responseEnd - entry.responseStart) : null,
    size_bytes: size > 0 ? size : null,
  };
}

export interface PageViewOptions {
  /** Fraction of page loads whose views are recorded (`performanceSampleRate`). */
  sampleRate: number;
  random: () => number;
  now?: () => number;
  /** Wall-clock ms at `performance.now() === 0`; defaults to `performance.timeOrigin`. */
  timeOrigin?: number;
}

/**
 * Records each page view as a `transaction` event: its route, duration, Web
 * Vitals, INP, long tasks and every fetch/XHR request as a span with the
 * browser's server/download breakdown. A view ends when the app changes route
 * or screen (`setScreen()`), the tab is hidden or closed, or after 30 minutes (it then continues as a new
 * view); hidden time is never part of a view.
 *
 * Whether a page load is recorded is decided once, from `sampleRate`, so a
 * user's views are either all recorded or none are.
 */
export class PageViewCollector implements Collector {
  private installed = false;
  private sampled = false;
  private view: OpenView | null = null;
  private screen: string | null = null;
  private resources: ResourceTiming[] = [];
  private observers: PerformanceObserver[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Finished views waiting a moment for late Resource Timing entries. */
  private deferred: Array<{ send: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  private readonly now: () => number;
  private readonly timeOrigin: number;
  private readonly handleVisibility: () => void;
  private readonly handlePageHide: () => void;
  private readonly checkDuration: () => void;
  private readonly onRequest: NetworkListener;

  constructor(
    private readonly report: (payload: TransactionPayload, screen: string | null) => void,
    private readonly network: { subscribe(listener: NetworkListener): void },
    private readonly pageLoad: { snapshot(): PerformancePayload },
    private readonly visibility: VisibilityTracker,
    private readonly logger: Logger,
    private readonly options: PageViewOptions,
  ) {
    this.now = options.now || nowMs;
    const perf = getPerformance();
    this.timeOrigin =
      options.timeOrigin !== undefined
        ? options.timeOrigin
        : perf !== null && typeof perf.timeOrigin === 'number'
          ? perf.timeOrigin
          : Date.now() - this.now();

    const self = this;
    this.onRequest = function onRequest(call: ApiCall, details: RequestDetails) {
      if (self.installed) self.recordRequest(call, details);
    };
    this.handleVisibility = guard(logger, 'page view visibility', function onVisibility() {
      const doc = getDocument();
      if (doc === null) return;
      if (doc.visibilityState === 'hidden') {
        // The page may be closing: report now, including views still waiting for timing entries.
        self.flushDeferred();
        self.finish();
      } else if (self.view === null) {
        self.begin('continued', self.currentPath(), self.now());
      }
    });
    this.handlePageHide = guard(logger, 'page view pagehide', function onPageHide() {
      self.flushDeferred();
      self.finish();
    });
    this.checkDuration = guard(logger, 'page view length', function check() {
      const view = self.view;
      if (view === null || self.now() - view.startTime < MAX_VIEW_DURATION_MS) return;
      self.finish(false);
      self.begin('continued', view.name, self.now());
    });
  }

  install(): void {
    const win = getWindow();
    const doc = getDocument();
    if (this.installed || win === null || doc === null) return;
    this.installed = true;
    this.sampled = this.options.random() < this.options.sampleRate;
    if (!this.sampled) return;

    this.network.subscribe(this.onRequest);
    // The first view covers the page load, so it starts at navigation start.
    if (doc.visibilityState !== 'hidden') this.begin('pageload', this.currentPath(), 0);
    this.observeBrowserTimings();
    doc.addEventListener('visibilitychange', this.handleVisibility);
    win.addEventListener('pagehide', this.handlePageHide);
    this.timer = setInterval(this.checkDuration, VIEW_CHECK_INTERVAL_MS);
  }

  uninstall(): void {
    if (!this.installed) return;
    this.flushDeferred();
    this.finish();
    const win = getWindow();
    const doc = getDocument();
    if (doc !== null) doc.removeEventListener('visibilitychange', this.handleVisibility);
    if (win !== null) win.removeEventListener('pagehide', this.handlePageHide);
    if (this.timer !== null) clearInterval(this.timer);
    for (let i = 0; i < this.observers.length; i++) {
      const observer = this.observers[i];
      safelyRun(this.logger, 'disconnect page view observer', function disconnect() {
        observer.disconnect();
      });
    }
    this.observers = [];
    this.resources = [];
    this.timer = null;
    this.installed = false;
  }

  /** Called on every route change: the current view ends and a new one starts. */
  onNavigation(url: string): void {
    if (!this.installed || !this.sampled) return;
    const path = pathOf(url);
    const doc = getDocument();
    this.finish(false);
    if (doc === null || doc.visibilityState !== 'hidden') this.begin('navigation', path, this.now());
  }

  /**
   * Called when the app reports a different screen (`setScreen()`): like a
   * route change, the current view ends and a new one starts on the same URL.
   * A view without a screen just takes the name: it was that screen all along
   * (typically the app naming its first screen right after the page load, whose
   * vitals would otherwise land in a short unnamed view).
   */
  onScreenChange(screen: string | null): void {
    this.screen = screen;
    if (!this.installed || !this.sampled) return;
    if (this.view !== null && this.view.screen === null && screen !== null) {
      this.view.screen = screen;
      return;
    }
    const doc = getDocument();
    this.finish(false);
    if (doc === null || doc.visibilityState !== 'hidden') this.begin('navigation', this.currentPath(), this.now());
  }

  /** Adds a finished request to the open view; exposed for tests. */
  recordRequest(call: ApiCall, details: RequestDetails): void {
    const view = this.view;
    if (view === null) return;
    if (view.spans.length >= MAX_SPANS_PER_VIEW) {
      view.droppedSpans++;
      return;
    }
    view.spans.push({
      rawUrl: details.rawUrl,
      startTime: details.startTime,
      span: {
        _id: call._id,
        op: 'http',
        method: call.method,
        url: call.url,
        status: call.status,
        failure: details.failure,
        // A request that began in the previous view counts from this view's start.
        start_ms: Math.max(0, Math.round(details.startTime - view.startTime)),
        duration_ms: call.duration_ms,
        server_ms: null,
        download_ms: null,
        size_bytes: null,
        background: this.visibility.wasHiddenBetween(details.startTime, details.endTime),
      },
    });
  }

  /** Keeps a fetch/XHR Resource Timing entry for matching; exposed for tests. */
  recordResource(entry: ResourceTiming): void {
    if (REQUEST_INITIATORS.indexOf(entry.initiatorType) === -1) return;
    this.resources.push(entry);
    if (this.resources.length > MAX_PENDING_RESOURCE_ENTRIES) this.resources.shift();
  }

  /** Records one Event Timing entry for INP; exposed for tests. */
  recordInteraction(interactionId: number, duration: number): void {
    const view = this.view;
    if (view === null || !(interactionId > 0)) return;
    const key = String(interactionId);
    const previous = view.interactions[key];
    if (previous === undefined || duration > previous) view.interactions[key] = duration;
  }

  /** Records one long task; exposed for tests. */
  recordLongTask(duration: number): void {
    const view = this.view;
    if (view === null) return;
    view.longTaskCount++;
    view.blockingMs += Math.max(0, duration - LONG_TASK_BLOCKING_THRESHOLD_MS);
  }

  /**
   * Ends the open view and reports it. With `immediate` false (a route change
   * while the page stays open), the report waits a moment: Chrome adds the
   * Resource Timing entry of a request whose body nobody read about 60 ms after
   * it finished, and the last request of a view is often the one that caused
   * the route change.
   */
  finish(immediate = true): void {
    const view = this.view;
    if (view === null) return;
    this.view = null;
    const endTime = this.now();
    const interactionDurations = Object.keys(view.interactions).map(function lookup(key) {
      return view.interactions[key];
    });
    // A tab that came back and went away again with nothing in between isn't a view worth storing.
    if (view.kind === 'continued' && view.spans.length === 0 && interactionDurations.length === 0) return;

    // Everything except the timing breakdown is fixed now; the breakdown is looked up when sent.
    const self = this;
    const payload: TransactionPayload = {
      name: view.name,
      kind: view.kind,
      start: new Date(this.timeOrigin + view.startTime).toISOString(),
      duration_ms: Math.max(0, Math.round(endTime - view.startTime)),
      background: this.visibility.wasHiddenBetween(view.startTime, endTime),
      vitals: this.vitals(view, interactionDurations),
      long_tasks: { count: view.longTaskCount, blocking_ms: Math.round(view.blockingMs) },
      spans: [],
      dropped_spans: view.droppedSpans,
    };
    const send = function send() {
      payload.spans = view.spans.map(function complete(pending) {
        return self.withBreakdown(pending);
      });
      self.report(payload, view.screen);
    };
    if (immediate) {
      send();
      return;
    }
    const deferred = {
      send: send,
      timer: setTimeout(function settle() {
        self.deferred.splice(self.deferred.indexOf(deferred), 1);
        safelyRun(self.logger, 'report page view', send);
      }, BREAKDOWN_SETTLE_MS),
    };
    this.deferred.push(deferred);
  }

  /** Sends every view still waiting for timing entries; used when the page may be closing. */
  flushDeferred(): void {
    const waiting = this.deferred;
    this.deferred = [];
    for (let i = 0; i < waiting.length; i++) {
      clearTimeout(waiting[i].timer);
      safelyRun(this.logger, 'report page view', waiting[i].send);
    }
  }

  private begin(kind: TransactionPayload['kind'], name: string, startTime: number): void {
    this.view = {
      name: name,
      screen: this.screen,
      kind: kind,
      startTime: startTime,
      spans: [],
      droppedSpans: 0,
      interactions: {},
      longTaskCount: 0,
      blockingMs: 0,
    };
  }

  private vitals(view: OpenView, interactionDurations: number[]): TransactionVitals {
    const inp = computeInp(interactionDurations);
    if (view.kind !== 'pageload') {
      return { ttfb_ms: null, fcp_ms: null, lcp_ms: null, cls: null, inp_ms: inp, page_load_ms: null };
    }
    const load = this.pageLoad.snapshot();
    // FCP/LCP are already null when the page was hidden first; page load is judged the same way.
    const loadHidden = load.page_load_ms !== null && this.visibility.wasHiddenBetween(0, load.page_load_ms);
    return {
      ttfb_ms: load.ttfb_ms,
      fcp_ms: load.fcp_ms,
      lcp_ms: load.lcp_ms,
      cls: load.cls,
      inp_ms: inp,
      page_load_ms: loadHidden ? null : load.page_load_ms,
    };
  }

  /** Fills in server/download time from the request's Resource Timing entry, when one matches. */
  private withBreakdown(pending: PendingSpan): Span {
    let entry: ResourceTiming | null = null;
    for (let i = 0; i < this.resources.length && entry === null; i++) {
      if (this.resources[i].name === pending.rawUrl && Math.abs(this.resources[i].startTime - pending.startTime) <= RESOURCE_MATCH_TOLERANCE_MS) {
        entry = this.resources.splice(i, 1)[0];
      }
    }
    // Observers get entries a little after the request ends; the timeline buffer has them at once
    // (but stops filling after 250 entries, which is why the observer is the main source).
    if (entry === null) entry = this.findInTimeline(pending);
    if (entry === null) return pending.span;
    const breakdown = timingBreakdown(entry);
    pending.span.server_ms = breakdown.server_ms;
    pending.span.download_ms = breakdown.download_ms;
    pending.span.size_bytes = breakdown.size_bytes;
    return pending.span;
  }

  private findInTimeline(pending: PendingSpan): ResourceTiming | null {
    const perf = getPerformance();
    if (perf === null || typeof perf.getEntriesByName !== 'function') return null;
    const entries = perf.getEntriesByName(pending.rawUrl, 'resource') as unknown as ResourceTiming[];
    for (let i = 0; i < entries.length; i++) {
      if (Math.abs(entries[i].startTime - pending.startTime) <= RESOURCE_MATCH_TOLERANCE_MS) return entries[i];
    }
    return null;
  }

  private currentPath(): string {
    const win = getWindow();
    return win !== null ? pathOf(win.location.href) : '/';
  }

  private observeBrowserTimings(): void {
    const self = this;
    this.observe('resource', {}, function onResource(entry) {
      self.recordResource(entry as unknown as ResourceTiming);
    });
    this.observe('event', { durationThreshold: EVENT_TIMING_THRESHOLD_MS }, function onEvent(entry) {
      const timing = entry as EventTimingEntry;
      if (timing.interactionId !== undefined) self.recordInteraction(timing.interactionId, timing.duration);
    });
    this.observe('longtask', {}, function onLongTask(entry) {
      self.recordLongTask(entry.duration);
    });
  }

  private observe(type: string, extra: { durationThreshold?: number }, onEntry: (entry: PerformanceEntry) => void): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const supported = PerformanceObserver.supportedEntryTypes;
    if (supported === undefined || supported.indexOf(type) === -1) return;
    const self = this;
    safelyRun(this.logger, 'observe ' + type + ' for page views', function observe() {
      const observer = new PerformanceObserver(
        guard(self.logger, type + ' page view observer', function onList(list: PerformanceObserverEntryList) {
          const entries = list.getEntries();
          for (let i = 0; i < entries.length; i++) onEntry(entries[i]);
        }),
      );
      const init: PerformanceObserverInit & { durationThreshold?: number } = { type: type, buffered: true };
      if (extra.durationThreshold !== undefined) init.durationThreshold = extra.durationThreshold;
      observer.observe(init);
      self.observers.push(observer);
    });
  }
}

/** The path of a URL, without origin, query string or fragment. */
function pathOf(url: string): string {
  const absolute = stripQuery(absoluteUrl(url));
  try {
    return new URL(absolute).pathname || '/';
  } catch (_e) {
    return absolute;
  }
}
