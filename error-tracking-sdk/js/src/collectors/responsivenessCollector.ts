import {
  FPS_FIRST_SAMPLE_DELAY_MS,
  FPS_SAMPLE_DURATION_MS,
  FPS_SAMPLE_INTERVAL_MS,
  FREEZE_REPORT_INTERVAL_MS,
  LONG_TASK_FREEZE_MS,
  LOW_FPS_THRESHOLD,
  MS_PER_SECOND,
} from '../constants';
import { getWindow, isPageVisible, nowMs } from '../core/env';
import { Logger } from '../core/logger';
import { guard, safelyRun } from '../core/safe';
import { Collector, CollectorSink } from './collector';

/** A sample is discarded if it took this many times longer than planned (tab was hidden mid-sample). */
const MAX_SAMPLE_STRETCH = 2;

export interface ResponsivenessDependencies {
  now?: () => number;
  requestFrame?: (callback: () => void) => void;
  sampleIntervalMs?: number;
}

/**
 * Watches main-thread responsiveness:
 * - **Freezes:** uses the Long Tasks API (Chromium browsers only) and reports
 *   a `MainThreadBlocked` performance event when one task blocks the page for
 *   longer than 1 s. At most one report per 30 s.
 * - **Frame rate:** 5 s after start and then every 30 s, while the page is
 *   visible, counts animation frames for 1 s. The latest value fills `performance.frame_rate_fps`, and a
 *   sample under 20 fps is reported as `LowFrameRate`.
 *
 * A page stuck in an infinite loop never finishes its task, so it cannot be
 * reported from inside the page.
 */
export class ResponsivenessCollector implements Collector {
  private observer: PerformanceObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstSampleTimer: ReturnType<typeof setTimeout> | null = null;
  private sampling = false;
  private fps: number | null = null;
  private lastFreezeReport = -Infinity;
  private lastLowFpsReport = -Infinity;
  private readonly now: () => number;
  private readonly requestFrame: ((callback: () => void) => void) | null;
  private readonly sampleIntervalMs: number;
  private readonly runSample: () => void;

  constructor(
    private readonly sink: CollectorSink,
    private readonly logger: Logger,
    deps: ResponsivenessDependencies = {},
  ) {
    this.now = deps.now || nowMs;
    const win = getWindow();
    this.requestFrame =
      deps.requestFrame ||
      (win !== null && typeof win.requestAnimationFrame === 'function'
        ? function frame(callback: () => void) {
            win.requestAnimationFrame(callback);
          }
        : null);
    this.sampleIntervalMs = deps.sampleIntervalMs !== undefined ? deps.sampleIntervalMs : FPS_SAMPLE_INTERVAL_MS;
    const self = this;
    this.runSample = guard(logger, 'frame rate sample', function sample() {
      self.sampleFrameRate();
    });
  }

  install(): void {
    if (this.timer !== null || getWindow() === null) return;
    this.observeLongTasks();
    if (this.requestFrame === null) return;
    // The first sample waits a few seconds so page-load work doesn't skew it.
    this.firstSampleTimer = setTimeout(this.runSample, FPS_FIRST_SAMPLE_DELAY_MS);
    this.timer = setInterval(this.runSample, this.sampleIntervalMs);
  }

  uninstall(): void {
    if (this.observer !== null) {
      const observer = this.observer;
      safelyRun(this.logger, 'disconnect long task observer', function disconnect() {
        observer.disconnect();
      });
    }
    if (this.timer !== null) clearInterval(this.timer);
    if (this.firstSampleTimer !== null) clearTimeout(this.firstSampleTimer);
    this.observer = null;
    this.timer = null;
    this.firstSampleTimer = null;
  }

  /** Latest sampled frame rate, or null if none was measured yet. */
  frameRate(): number | null {
    return this.fps;
  }

  /** Handles one long task; exposed for tests. */
  recordLongTask(durationMs: number): void {
    if (durationMs <= LONG_TASK_FREEZE_MS) return;
    const now = this.now();
    if (now - this.lastFreezeReport < FREEZE_REPORT_INTERVAL_MS) return;
    this.lastFreezeReport = now;
    this.sink.onPerformanceIssue(
      'MainThreadBlocked',
      'Main thread blocked for ' + Math.round(durationMs) + 'ms (page unresponsive)',
    );
  }

  /** Counts frames for one sample window; exposed for tests. */
  sampleFrameRate(): void {
    const requestFrame = this.requestFrame;
    if (this.sampling || requestFrame === null || !isPageVisible()) return;
    this.sampling = true;

    const self = this;
    const start = this.now();
    let frames = 0;

    const onFrame = guard(this.logger, 'frame rate sample', function onFrame() {
      frames++;
      const elapsed = self.now() - start;
      if (elapsed < FPS_SAMPLE_DURATION_MS) {
        requestFrame(onFrame);
        return;
      }
      self.sampling = false;
      // Hidden tabs pause animation frames; a stretched sample would read as a fake slowdown.
      if (elapsed > FPS_SAMPLE_DURATION_MS * MAX_SAMPLE_STRETCH || !isPageVisible()) return;
      self.recordFrameRate(Math.round((frames * MS_PER_SECOND) / elapsed));
    });
    requestFrame(onFrame);
  }

  private recordFrameRate(fps: number): void {
    this.fps = fps;
    if (fps >= LOW_FPS_THRESHOLD) return;
    const now = this.now();
    if (now - this.lastLowFpsReport < FREEZE_REPORT_INTERVAL_MS) return;
    this.lastLowFpsReport = now;
    this.sink.onPerformanceIssue('LowFrameRate', 'Low frame rate: ' + fps + ' fps (janky scrolling/animation)');
  }

  private observeLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const supported = PerformanceObserver.supportedEntryTypes;
    // Long Tasks API: Chromium only. Firefox/Safari simply get no freeze reports.
    if (supported === undefined || supported.indexOf('longtask') === -1) return;

    const self = this;
    safelyRun(this.logger, 'observe long tasks', function observe() {
      const observer = new PerformanceObserver(
        guard(self.logger, 'long task observer', function onList(list: PerformanceObserverEntryList) {
          const entries = list.getEntries();
          for (let i = 0; i < entries.length; i++) self.recordLongTask(entries[i].duration);
        }),
      );
      observer.observe({ type: 'longtask', buffered: true });
      self.observer = observer;
    });
  }
}
