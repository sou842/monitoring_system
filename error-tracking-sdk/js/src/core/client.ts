import { DROPPED_EVENTS_REPORT_DELAY_MS, MAX_MESSAGE_LENGTH, RATE_LIMIT_WINDOW_MS, TRANSACTION_RATE_LIMIT_MAX } from '../constants';
import { BreadcrumbCollector } from '../collectors/breadcrumbCollector';
import { CapturedError, Collector, CollectorSink, PerformanceIssueKind } from '../collectors/collector';
import { CspCollector } from '../collectors/cspCollector';
import { captureFromThrown, ErrorCollector } from '../collectors/errorCollector';
import { HttpErrorCollector } from '../collectors/httpErrorCollector';
import { JsonResponseCollector } from '../collectors/jsonResponseCollector';
import { MemoryCollector, MemoryReading } from '../collectors/memoryCollector';
import { NetworkInterceptor } from '../collectors/networkInterceptor';
import { PageNotFoundCollector, PageNotFoundDetails } from '../collectors/pageNotFoundCollector';
import { PageViewCollector } from '../collectors/pageViewCollector';
import { PerformanceCollector } from '../collectors/performanceCollector';
import { ResourceCollector } from '../collectors/resourceCollector';
import { ResponsivenessCollector } from '../collectors/responsivenessCollector';
import { ScreenshotCollector } from '../collectors/screenshotCollector';
import { WorkerCollector } from '../collectors/workerCollector';
import { HttpTransport, Transport } from '../transport/httpTransport';
import { LocalStorageStore, OfflineStore } from '../transport/offlineStore';
import { Breadcrumb, BreadcrumbInput, EventLevel, JsonObject, TrackedUser, TrackerEvent, TransactionPayload } from '../types';
import { CircularBuffer } from './circularBuffer';
import { ResolvedConfig } from './config';
import { DeviceInfo } from './device';
import { absoluteUrl, getDocument, getWindow, nowIso, stripQuery } from './env';
import { Deduplicator, fingerprint, RateLimiter } from './eventFilters';
import { EventQueue } from './eventQueue';
import { Logger } from './logger';
import { buildEvent, emptyPerformance, EventInput, EventScope } from './payloadBuilder';
import { guard, safely, safelyRun } from './safe';
import { normalizeObject, truncate } from './serialize';
import { VisibilityTracker } from './visibility';

/** Dependency overrides, used by tests. */
export interface ClientDependencies {
  transport?: Transport;
  store?: OfflineStore;
  random?: () => number;
  rateLimiter?: RateLimiter;
  deduplicator?: Deduplicator;
  readMemory?: () => MemoryReading | null;
  screenshot?: ScreenshotCollector;
  queueRetryDelaysMs?: readonly number[];
  queueFlushDelayMs?: number;
}

/**
 * Owns all SDK state for one `init()` call: configuration, collectors,
 * scope (user, breadcrumbs) and the delivery queue.
 */
export class Client implements CollectorSink {
  readonly logger: Logger;
  private readonly config: ResolvedConfig;
  private readonly breadcrumbs: CircularBuffer<Breadcrumb>;
  private readonly device = new DeviceInfo();
  private readonly queue: EventQueue;
  private readonly random: () => number;
  private readonly rateLimiter: RateLimiter;
  private readonly deduplicator: Deduplicator;
  private readonly network: NetworkInterceptor;
  private readonly performance: PerformanceCollector;
  private readonly visibility: VisibilityTracker;
  private readonly pageViews: PageViewCollector;
  /** Separate from the error budget, so page views can never crowd out errors. */
  private readonly transactionLimiter = new RateLimiter(TRANSACTION_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  private readonly memory: MemoryCollector;
  private readonly responsiveness: ResponsivenessCollector;
  private readonly screenshot: ScreenshotCollector;
  private readonly collectors: Collector[];
  private user: TrackedUser | null = null;
  private rateLimitWarned = false;
  /** Events dropped by the rate limiter since the last summary event. */
  private droppedCount = 0;
  private droppedTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** Events waiting on a screenshot before they can be queued. */
  private pendingCaptures: Array<Promise<void>> = [];

  private readonly handleOnline: () => void;
  private readonly handleVisibility: () => void;
  private readonly handlePageHide: () => void;

  constructor(config: ResolvedConfig, deps: ClientDependencies = {}) {
    this.config = config;
    this.logger = new Logger(config.debug);
    this.breadcrumbs = new CircularBuffer<Breadcrumb>(config.maxBreadcrumbs);
    this.random = deps.random || Math.random;
    this.rateLimiter = deps.rateLimiter || new RateLimiter();
    this.deduplicator = deps.deduplicator || new Deduplicator();

    // Transport must be created before NetworkInterceptor.install() so it
    // captures the unwrapped fetch.
    this.queue = new EventQueue({
      transport: deps.transport || new HttpTransport(config.endpoint, config.apiKey, this.logger),
      store: deps.store || new LocalStorageStore(this.logger),
      logger: this.logger,
      retryDelaysMs: deps.queueRetryDelaysMs,
      flushDelayMs: deps.queueFlushDelayMs,
    });

    this.network = new NetworkInterceptor(config.endpoint, this.logger);
    this.visibility = new VisibilityTracker(this.logger);
    this.performance = new PerformanceCollector(
      this,
      this.network,
      this.logger,
      { slowPageLoadMs: config.slowPageLoadMs, slowApiCallMs: config.slowApiCallMs, reportSlowEvents: config.captureSlowEvents },
      this.visibility,
    );
    this.pageViews = new PageViewCollector(
      (payload: TransactionPayload) => this.captureTransaction(payload),
      this.network,
      this.performance,
      this.visibility,
      this.logger,
      { sampleRate: config.performanceSampleRate, random: this.random },
    );
    this.memory = new MemoryCollector(this, this.logger, deps.readMemory, {
      intervalMs: config.memoryPollIntervalMs,
      leakGrowth: config.memoryLeakGrowth,
      leakMinGrowthMb: config.memoryLeakMinGrowthMb,
      leakReadings: config.memoryLeakReadings,
    });
    this.responsiveness = new ResponsivenessCollector(this, this.logger, {
      freezeThresholdMs: config.mainThreadBlockedMs,
      lowFpsThreshold: config.lowFrameRateFps,
    });
    this.screenshot =
      deps.screenshot ||
      new ScreenshotCollector(
        { maskSelectors: config.maskSelectors, libraryUrl: config.html2canvasUrl, libraryIntegrity: config.html2canvasIntegrity },
        this.logger,
      );
    this.collectors = [
      // First: everything below asks it whether the tab was hidden.
      this.visibility,
      new ErrorCollector(this, this.logger),
      new BreadcrumbCollector(this, this.network, config.maskSelectors, this.logger, config.captureConsoleErrors),
      this.performance,
      // Before the client's own visibility listener (added in start()), so a view
      // ended by the tab being hidden is queued before the queue is flushed.
      this.pageViews,
      this.memory,
      this.responsiveness,
      new CspCollector(this, this.logger, [config.html2canvasUrl]),
      new WorkerCollector(this, this.logger),
      new ResourceCollector(this, this.logger),
      new JsonResponseCollector(this, this.logger, (url: string) => this.network.isSdkUrl(url)),
    ];
    if (config.detectPageNotFound) {
      this.collectors.push(
        new PageNotFoundCollector((details: PageNotFoundDetails) => this.reportPageNotFound(details), this.logger),
      );
    }
    if (config.captureHttpErrors || config.captureNetworkErrors) {
      this.collectors.push(
        new HttpErrorCollector(this, this.network, { httpErrors: config.captureHttpErrors, networkErrors: config.captureNetworkErrors }),
      );
    }
    this.collectors.push(
      // Installed last: subscribers above register before requests start flowing.
      this.network,
    );

    const self = this;
    this.handleOnline = guard(this.logger, 'online handler', function onOnline() {
      self.queue.restoreFromStore();
    });
    this.handleVisibility = guard(this.logger, 'visibility handler', function onVisibility() {
      const doc = getDocument();
      if (doc === null) return;
      if (doc.visibilityState === 'hidden') {
        self.queue.flush();
      } else {
        self.queue.restoreFromStore();
      }
    });
    this.handlePageHide = guard(this.logger, 'pagehide handler', function onPageHide() {
      // The page may be unloading: send what fits in a keepalive request, keep the rest for next time.
      self.queue.sendBeforeUnload();
    });
  }

  /** Installs collectors and lifecycle listeners, then sends events left over from earlier sessions. */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (let i = 0; i < this.collectors.length; i++) {
      const collector = this.collectors[i];
      safelyRun(this.logger, 'install collector', function install() {
        collector.install();
      });
    }

    const win = getWindow();
    const doc = getDocument();
    if (win !== null) {
      win.addEventListener('online', this.handleOnline);
      win.addEventListener('pagehide', this.handlePageHide);
    }
    if (doc !== null) doc.addEventListener('visibilitychange', this.handleVisibility);

    this.device.refine();
    this.queue.restoreFromStore();
    this.logger.info('initialized', { environment: this.config.environment, sampleRate: this.config.sampleRate });
  }

  /** Removes every hook from the page. Unsent events are persisted. */
  close(): Promise<void> {
    const self = this;
    // End the open page view first, so it is sent with the final flush.
    safelyRun(this.logger, 'finish page view', function finishView() {
      self.pageViews.flushDeferred();
      self.pageViews.finish();
    });
    return this.flush().then(function teardown() {
      for (let i = 0; i < self.collectors.length; i++) {
        const collector = self.collectors[i];
        safelyRun(self.logger, 'uninstall collector', function uninstall() {
          collector.uninstall();
        });
      }
      const win = getWindow();
      const doc = getDocument();
      if (win !== null) {
        win.removeEventListener('online', self.handleOnline);
        win.removeEventListener('pagehide', self.handlePageHide);
      }
      if (doc !== null) doc.removeEventListener('visibilitychange', self.handleVisibility);
      if (self.droppedTimer !== null) clearTimeout(self.droppedTimer);
      self.droppedTimer = null;
      self.queue.close();
      self.started = false;
    });
  }

  /** Waits for events still awaiting a screenshot, then sends everything queued. */
  flush(): Promise<void> {
    const queue = this.queue;
    const pageViews = this.pageViews;
    // Page views that ended a moment ago wait briefly for timing entries; send them now.
    safelyRun(this.logger, 'send finished page views', function sendViews() {
      pageViews.flushDeferred();
    });
    return Promise.all(this.pendingCaptures.slice())
      .then(function send() {
        return queue.flush();
      })
      .then(null, () => {
        this.logger.warn('flush failed');
      });
  }

  captureError(thrown: unknown, context?: object): void {
    const captured = captureFromThrown(thrown, true);
    this.capture(
      {
        eventType: 'error',
        level: 'error',
        error: captured.error,
        stacktrace: captured.stacktrace,
        context: context !== undefined && context !== null ? normalizeObject(context) : null,
      },
      true,
    );
  }

  /** Reports that `url` (default: the current page) does not exist. */
  capturePageNotFound(url?: string): void {
    const win = getWindow();
    const doc = getDocument();
    const target = typeof url === 'string' && url.length > 0 ? url : win !== null ? win.location.href : '';
    if (target.length === 0) {
      this.logger.warn('capturePageNotFound needs a URL outside the browser; ignoring');
      return;
    }
    this.reportPageNotFound({
      url: target,
      status: null,
      referrer: doc !== null && doc.referrer.length > 0 ? doc.referrer : null,
      source: 'app',
    });
  }

  private reportPageNotFound(details: PageNotFoundDetails): void {
    const url = stripQuery(absoluteUrl(details.url));
    let path = url;
    safelyRun(this.logger, 'page path', function parsePath() {
      path = new URL(url).pathname;
    });
    // Same message and empty stack for both sources, so an app that also calls
    // capturePageNotFound() on a real 404 page is deduplicated to one event.
    this.capture(
      {
        eventType: 'error',
        level: 'warning',
        error: { message: truncate('Page not found: ' + path, MAX_MESSAGE_LENGTH), type: 'PageNotFound', handled: true },
        stacktrace: [],
        context: {
          url: url,
          path: path,
          status: details.status,
          referrer: details.referrer !== null ? stripQuery(details.referrer) : null,
          source: details.source,
        },
      },
      false,
    );
  }

  captureMessage(message: string, level: EventLevel): void {
    this.capture(
      {
        eventType: 'message',
        level: level,
        error: { message: truncate(String(message), MAX_MESSAGE_LENGTH), type: 'Message', handled: true },
        stacktrace: [],
        context: null,
      },
      false,
    );
  }

  setUser(user: TrackedUser | null): void {
    if (user === null || user === undefined) {
      this.user = null;
      return;
    }
    if (typeof user !== 'object' || user.id === undefined || user.id === null) {
      this.logger.warn('setUser requires an object with an id; ignoring');
      return;
    }
    this.user = { id: String(user.id), email: user.email, name: user.name };
  }

  // -------------------------------------------------------------------------
  // CollectorSink
  // -------------------------------------------------------------------------

  onError(captured: CapturedError): void {
    this.capture(
      {
        eventType: 'error',
        level: 'error',
        error: captured.error,
        stacktrace: captured.stacktrace,
        context: captured.context !== undefined ? captured.context : null,
      },
      true,
    );
  }

  onBreadcrumb(input: BreadcrumbInput): void {
    if (input === null || typeof input !== 'object') return;
    this.breadcrumbs.push({
      timestamp: nowIso(),
      type: typeof input.type === 'string' ? input.type : 'log',
      message: truncate(String(input.message), MAX_MESSAGE_LENGTH),
      data: input.data !== undefined ? normalizeObject(input.data) : {},
    });
  }

  onPerformanceIssue(kind: PerformanceIssueKind, message: string, context?: JsonObject): void {
    this.capture(
      {
        eventType: 'performance',
        level: 'warning',
        error: { message: message, type: kind, handled: true },
        stacktrace: [],
        context: context !== undefined ? context : null,
      },
      false,
    );
  }

  onNavigation(url: string): void {
    this.pageViews.onNavigation(url);
  }

  /**
   * Queues one page view's performance data. Page views skip `sampleRate`,
   * dedup and the error rate limit (they were sampled with
   * `performanceSampleRate` when the page loaded) and have their own budget.
   */
  private captureTransaction(payload: TransactionPayload): void {
    if (!this.transactionLimiter.tryAcquire()) {
      this.logger.info('page view dropped by the transaction rate limit');
      return;
    }
    const scope = this.scope();
    // The page view carries its own timings; the error-oriented blocks stay empty to keep it small.
    scope.breadcrumbs = [];
    scope.performance = emptyPerformance();
    const event = buildEvent(
      { eventType: 'transaction', level: 'info', error: null, stacktrace: [], context: null, transaction: payload },
      scope,
      nowIso(),
    );
    this.finish(event, this.config.beforeSendTransaction, 'beforeSendTransaction');
  }

  // -------------------------------------------------------------------------
  // Pipeline: sample → dedup → rate limit → build → screenshot → beforeSend → queue
  // -------------------------------------------------------------------------

  private capture(input: EventInput, withScreenshot: boolean): void {
    if (this.random() > this.config.sampleRate) {
      this.logger.info('event dropped by sampleRate');
      return;
    }
    if (!this.deduplicator.isNew(fingerprint(input.eventType, input.error, input.stacktrace))) {
      this.logger.info('duplicate event dropped');
      return;
    }
    if (!this.rateLimiter.tryAcquire()) {
      if (!this.rateLimitWarned) this.logger.warn('rate limit reached; dropping events');
      this.rateLimitWarned = true;
      this.recordDropped();
      return;
    }
    this.rateLimitWarned = false;

    // Snapshot scope now so breadcrumbs reflect the moment of the error, not
    // whatever happens while the screenshot renders.
    const scope = this.scope();
    const timestamp = nowIso();
    const self = this;

    if (!withScreenshot || !this.config.captureScreenshots) {
      this.finish(buildEvent(input, scope, timestamp));
      return;
    }

    const pending = this.screenshot.capture().then(
      function attach(shot) {
        scope.screenshot = shot;
        self.finish(buildEvent(input, scope, timestamp));
      },
      function withoutShot() {
        self.finish(buildEvent(input, scope, timestamp));
      },
    );
    this.pendingCaptures.push(pending);
    pending.then(function untrack() {
      const index = self.pendingCaptures.indexOf(pending);
      if (index !== -1) self.pendingCaptures.splice(index, 1);
    });
  }

  /** Counts a rate-limited event and schedules one summary event, so storms stay visible. */
  private recordDropped(): void {
    this.droppedCount++;
    if (this.droppedTimer !== null) return;
    const self = this;
    this.droppedTimer = setTimeout(
      guard(this.logger, 'dropped events summary', function report() {
        self.droppedTimer = null;
        const count = self.droppedCount;
        self.droppedCount = 0;
        if (count === 0) return;
        // Bypasses sampling, dedup and the rate limiter: this is the one event that explains the gap.
        self.finish(
          buildEvent(
            {
              eventType: 'message',
              level: 'warning',
              error: {
                message: 'Rate limit dropped ' + count + ' event(s) during an error storm',
                type: 'EventsDropped',
                handled: true,
              },
              stacktrace: [],
              context: { dropped_count: count },
            },
            self.scope(),
            nowIso(),
          ),
        );
      }),
      DROPPED_EVENTS_REPORT_DELAY_MS,
    );
  }

  private finish(
    event: TrackerEvent,
    hook: ((event: TrackerEvent) => TrackerEvent | null) | null = this.config.beforeSend,
    hookName = 'beforeSend',
  ): void {
    safelyRun(this.logger, 'enqueue event', () => {
      let final: TrackerEvent | null = event;
      if (hook !== null) {
        // A throwing hook must not lose the event or break the app; send it unmodified.
        final = safely(this.logger, hookName, function run() {
          return hook(event);
        }, event);
      }
      if (final === null || final === undefined) {
        this.logger.info('event dropped by ' + hookName);
        return;
      }
      this.queue.enqueue(final);
    });
  }

  private scope(): EventScope {
    const performance = this.performance.snapshot();
    performance.frame_rate_fps = this.responsiveness.frameRate();
    return {
      apiKey: this.config.apiKey,
      environment: this.config.environment,
      appVersion: this.config.appVersion,
      user: this.user,
      breadcrumbs: this.breadcrumbs.toArray(),
      performance: performance,
      memory: this.memory.snapshot(),
      device: this.device.snapshot(),
      screenshot: null,
    };
  }
}

