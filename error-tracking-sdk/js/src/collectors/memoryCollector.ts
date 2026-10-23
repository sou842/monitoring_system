import {
  BYTES_PER_MB,
  LEAK_CONSECUTIVE_READINGS,
  LEAK_GROWTH_THRESHOLD,
  LEAK_MAX_STEP_SHARE,
  LEAK_MIN_GROWTH_MB,
  LEAK_MIN_STEP_MB,
  LEAK_MIN_STEP_SHARE_OF_AVERAGE,
  MEMORY_POLL_INTERVAL_MS,
  MEMORY_READINGS_PER_WINDOW,
  MEMORY_WARMUP_MS,
  MS_PER_SECOND,
} from '../constants';
import { getPerformance, nowMs } from '../core/env';
import { Logger } from '../core/logger';
import { guard } from '../core/safe';
import { JsonObject, MemoryPayload } from '../types';
import { Collector, CollectorSink } from './collector';

/** One heap sample, in bytes. */
export interface MemoryReading {
  usedBytes: number;
  totalBytes: number;
}

/** Non-standard Chromium `performance.memory`. */
interface ChromeMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
}

const SECONDS_PER_MINUTE = 60;
const PERCENT = 100;

/** Reads `performance.memory`, which only Chromium-based browsers provide. */
export function readChromeMemory(): MemoryReading | null {
  const perf = getPerformance() as (Performance & { memory?: ChromeMemoryInfo }) | null;
  if (perf === null || perf.memory === undefined) return null;
  return { usedBytes: perf.memory.usedJSHeapSize, totalBytes: perf.memory.totalJSHeapSize };
}

/** Leak-detection settings. */
export interface LeakRule {
  /** How many floors in a row must each be higher than the one before. */
  readings: number;
  /** Required growth of the newest floor over the baseline, as a ratio (0.2 = 20%). */
  growth: number;
  /** Required growth of the newest floor over the baseline, in bytes. */
  minGrowthBytes: number;
  /** Each floor must be at least this many bytes above the one before. */
  minStepBytes: number;
  /** Largest allowed share (0–1) of the trend's total rise in a single step, when there are 2+ steps. */
  maxStepShare: number;
}

/**
 * True when the last `rule.readings` heap floors each rise above the one
 * before by at least `minStepBytes`, no single step makes up more than
 * `maxStepShare` of the total rise, and the newest floor is above `baseline`
 * (the lowest floor seen) by both the growth ratio and the minimum number of bytes.
 *
 * A single jump (a heavy screen loading once) is not a leak: the floors around
 * it stay level, or barely creep. Neither is a sawtooth of allocations that
 * garbage collection clears: the floors don't move.
 */
export function isLeakTrend(floors: readonly number[], baseline: number, rule: LeakRule): boolean {
  if (floors.length < rule.readings || !(baseline > 0)) return false;
  const recent = floors.slice(-rule.readings);
  let largestStep = 0;
  for (let i = 1; i < recent.length; i++) {
    const step = recent[i] - recent[i - 1];
    if (step < rule.minStepBytes) return false;
    if (step > largestStep) largestStep = step;
  }
  const totalRise = recent[recent.length - 1] - recent[0];
  if (recent.length > 2 && largestStep > totalRise * rule.maxStepShare) return false;
  const growth = recent[recent.length - 1] - baseline;
  return growth >= rule.minGrowthBytes && growth / baseline >= rule.growth;
}

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/**
 * Smallest step between floors that counts as rising: LEAK_MIN_STEP_MB, or
 * less when the configured growth spread over the configured steps is small.
 */
export function minLeakStepBytes(minGrowthBytes: number, readings: number): number {
  const averageStep = minGrowthBytes / Math.max(1, readings - 1);
  return Math.min(LEAK_MIN_STEP_MB * BYTES_PER_MB, averageStep * LEAK_MIN_STEP_SHARE_OF_AVERAGE);
}

/** Polling and leak-detection settings. */
export interface MemoryOptions {
  intervalMs: number;
  /** Growth ratio, e.g. 0.2 = 20%. */
  leakGrowth: number;
  /** Minimum growth in MB. */
  leakMinGrowthMb: number;
  /** Number of floors in a row that must keep rising. */
  leakReadings: number;
}

/**
 * Polls JS heap usage (every 30 s by default) and reports a suspected leak
 * when the memory the page keeps after garbage collection grows steadily.
 *
 * How a leak is told apart from normal memory use:
 * - **Warm-up:** readings from the first minute after init are ignored, since
 *   apps load most of their screens and caches at startup.
 * - **Floors:** readings are grouped into windows of 4 polls, and only each
 *   window's lowest reading (its floor) is used. Garbage the browser collects
 *   later never lifts a floor, so normal allocation churn is ignored.
 * - **Trend:** the last N floors (4 by default) must each be higher than the
 *   one before, by at least 0.5 MB (less for slow-leak settings), and no single step may be more than 70% of
 *   the total rise. A screen that loads once and keeps its data raises one
 *   floor in one big step, then the floors stay level.
 * - **Size:** the newest floor must be above the lowest floor seen by 20% and
 *   by 10 MB (both configurable), so small heaps can't trip the ratio.
 *
 * Navigation does not reset anything: the most common single-page-app leak is
 * a screen that isn't cleaned up when the user leaves it. A full page load
 * starts a new SDK instance anyway. One report per page load.
 */
export class MemoryCollector implements Collector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: MemoryReading | null = null;
  private leakSuspected = false;
  private startedAt: number | null = null;
  /** Window being filled: when it started and its lowest reading so far. */
  private window: { start: number; min: number } | null = null;
  /** Floors of the most recent closed windows, oldest first. */
  private floors: number[] = [];
  /** Lowest floor seen since warm-up, and when its window started. */
  private baseline = Infinity;
  private baselineAt = 0;
  private readonly windowMs: number;
  private readonly rule: LeakRule;
  private readonly poll: () => void;

  constructor(
    private readonly sink: CollectorSink,
    logger: Logger,
    private readonly read: () => MemoryReading | null = readChromeMemory,
    private readonly options: MemoryOptions = {
      intervalMs: MEMORY_POLL_INTERVAL_MS,
      leakGrowth: LEAK_GROWTH_THRESHOLD,
      leakMinGrowthMb: LEAK_MIN_GROWTH_MB,
      leakReadings: LEAK_CONSECUTIVE_READINGS,
    },
    private readonly now: () => number = nowMs,
  ) {
    this.windowMs = options.intervalMs * MEMORY_READINGS_PER_WINDOW;
    this.rule = {
      readings: options.leakReadings,
      growth: options.leakGrowth,
      minGrowthBytes: options.leakMinGrowthMb * BYTES_PER_MB,
      minStepBytes: minLeakStepBytes(options.leakMinGrowthMb * BYTES_PER_MB, options.leakReadings),
      maxStepShare: LEAK_MAX_STEP_SHARE,
    };
    const self = this;
    this.poll = guard(logger, 'memory poll', function poll() {
      self.sample();
    });
  }

  install(): void {
    if (this.timer !== null || this.read() === null) return;
    if (this.startedAt === null) this.startedAt = this.now();
    this.sample();
    this.timer = setInterval(this.poll, this.options.intervalMs);
  }

  uninstall(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Takes one reading; exposed for tests. */
  sample(): void {
    const reading = this.read();
    if (reading === null) return;
    const now = this.now();
    if (this.startedAt === null) this.startedAt = now;
    this.latest = reading;
    if (now - this.startedAt < MEMORY_WARMUP_MS) return;

    const used = reading.usedBytes;
    const current = this.window;
    if (current === null) {
      this.window = { start: now, min: used };
      return;
    }
    if (now - current.start < this.windowMs) {
      if (used < current.min) current.min = used;
      return;
    }
    // This reading starts a new window, so the current one is complete. Timers
    // in background tabs can be throttled to one run a minute or less; a
    // window then just covers a longer stretch of time.
    this.window = { start: now, min: used };
    this.addFloor(current.min, current.start, now);
  }

  snapshot(): MemoryPayload {
    if (this.latest === null) {
      return { used_mb: null, total_mb: null, leak_suspected: null, oom_kill: null };
    }
    return {
      used_mb: toMb(this.latest.usedBytes),
      total_mb: toMb(this.latest.totalBytes),
      leak_suspected: this.leakSuspected,
      // Browsers give pages no signal for OOM kills.
      oom_kill: null,
    };
  }

  private addFloor(floor: number, windowStart: number, now: number): void {
    this.floors.push(floor);
    if (this.floors.length > this.rule.readings) this.floors.shift();
    if (floor < this.baseline) {
      this.baseline = floor;
      this.baselineAt = windowStart;
    }
    if (this.leakSuspected || !isLeakTrend(this.floors, this.baseline, this.rule)) return;

    this.leakSuspected = true;
    const growth = floor - this.baseline;
    const context: JsonObject = {
      baseline_mb: toMb(this.baseline),
      current_mb: toMb(floor),
      growth_mb: toMb(growth),
      growth_percent: Math.round((growth / this.baseline) * PERCENT),
      observed_minutes: Math.round(((now - this.baselineAt) / MS_PER_SECOND / SECONDS_PER_MINUTE) * 10) / 10,
      floors_mb: this.floors.map(toMb),
      heap_total_mb: this.latest !== null ? toMb(this.latest.totalBytes) : null,
    };
    // Numbers in the message are in MB, which the backend strips when grouping.
    this.sink.onPerformanceIssue(
      'MemoryLeakSuspected',
      'JS heap is not being released: it grew from ' + toMb(this.baseline) + 'MB to ' + toMb(floor) +
        'MB after garbage collection',
      context,
    );
  }
}
