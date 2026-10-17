import {
  BYTES_PER_MB,
  LEAK_CONSECUTIVE_READINGS,
  LEAK_GROWTH_THRESHOLD,
  MEMORY_POLL_INTERVAL_MS,
} from '../constants';
import { getPerformance } from '../core/env';
import { Logger } from '../core/logger';
import { guard } from '../core/safe';
import { MemoryPayload } from '../types';
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

/** Reads `performance.memory`, which only Chromium-based browsers provide. */
export function readChromeMemory(): MemoryReading | null {
  const perf = getPerformance() as (Performance & { memory?: ChromeMemoryInfo }) | null;
  if (perf === null || perf.memory === undefined) return null;
  return { usedBytes: perf.memory.usedJSHeapSize, totalBytes: perf.memory.totalJSHeapSize };
}

/**
 * True when the last N readings grow strictly and the newest is more than
 * the growth threshold above the oldest of the N.
 */
export function isLeakPattern(
  usedBytes: readonly number[],
  consecutive: number = LEAK_CONSECUTIVE_READINGS,
  threshold: number = LEAK_GROWTH_THRESHOLD,
): boolean {
  if (usedBytes.length < consecutive) return false;
  const recent = usedBytes.slice(-consecutive);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] <= recent[i - 1]) return false;
  }
  return recent[0] > 0 && (recent[recent.length - 1] - recent[0]) / recent[0] > threshold;
}

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/**
 * Polls JS heap usage every 30 s and flags a suspected leak when the heap
 * grows by more than 20% across 3 consecutive readings with no navigation in
 * between. Readings reset on every navigation.
 */
export class MemoryCollector implements Collector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readings: number[] = [];
  private latest: MemoryReading | null = null;
  private leakSuspected = false;
  private readonly poll: () => void;

  constructor(
    private readonly sink: CollectorSink,
    logger: Logger,
    private readonly read: () => MemoryReading | null = readChromeMemory,
    private readonly intervalMs: number = MEMORY_POLL_INTERVAL_MS,
  ) {
    const self = this;
    this.poll = guard(logger, 'memory poll', function poll() {
      self.sample();
    });
  }

  install(): void {
    if (this.timer !== null || this.read() === null) return;
    this.sample();
    this.timer = setInterval(this.poll, this.intervalMs);
  }

  uninstall(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called on navigation: a new page means a new baseline. */
  resetBaseline(): void {
    this.readings = [];
    this.leakSuspected = false;
  }

  /** Takes one reading; exposed for tests. */
  sample(): void {
    const reading = this.read();
    if (reading === null) return;
    this.latest = reading;
    this.readings.push(reading.usedBytes);
    if (this.readings.length > LEAK_CONSECUTIVE_READINGS) this.readings.shift();

    if (!this.leakSuspected && isLeakPattern(this.readings)) {
      this.leakSuspected = true;
      this.sink.onPerformanceIssue(
        'MemoryLeakSuspected',
        'JS heap grew from ' + toMb(this.readings[0]) + 'MB to ' + toMb(reading.usedBytes) +
          'MB across ' + LEAK_CONSECUTIVE_READINGS + ' readings without navigation',
      );
    }
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
}
