import { getDocument, getPerformance, nowMs } from './env';
import { Logger } from './logger';
import { guard } from './safe';

/** Hidden periods kept; older ones are merged into the first, which is all `firstHiddenTime` needs. */
const MAX_HIDDEN_PERIODS = 50;

/** A stretch of time the page was hidden, in ms since navigation start; `end` is Infinity while it is still hidden. */
interface HiddenPeriod {
  start: number;
  end: number;
}

/** Subset of the `visibility-state` performance entry (Chromium 115+). */
type VisibilityEntry = PerformanceEntry & { name: string };

/**
 * Remembers when the page was hidden. Browsers hold back background tabs
 * (no painting, throttled timers and network callbacks), so any timing that
 * overlaps a hidden period says more about the tab than about the app, and
 * is left out of slow reports and percentiles.
 *
 * Times are `performance.now()` values (ms since navigation start).
 */
export class VisibilityTracker {
  private periods: HiddenPeriod[] = [];
  private installed = false;
  private readonly handleChange: () => void;

  constructor(
    logger: Logger,
    private readonly now: () => number = nowMs,
  ) {
    const self = this;
    this.handleChange = guard(logger, 'visibility tracking', function onChange() {
      const doc = getDocument();
      if (doc !== null) self.record(doc.visibilityState === 'hidden', self.now());
    });
  }

  install(): void {
    const doc = getDocument();
    if (this.installed || doc === null) return;
    this.installed = true;
    this.readHistory(doc);
    doc.addEventListener('visibilitychange', this.handleChange, true);
  }

  uninstall(): void {
    const doc = getDocument();
    if (!this.installed || doc === null) return;
    doc.removeEventListener('visibilitychange', this.handleChange, true);
    this.installed = false;
  }

  /** When the page was first hidden, or Infinity if it has been visible the whole time. */
  firstHiddenTime(): number {
    return this.periods.length > 0 ? this.periods[0].start : Infinity;
  }

  /** True if the page was hidden at any moment between `start` and `end`. */
  wasHiddenBetween(start: number, end: number): boolean {
    for (let i = 0; i < this.periods.length; i++) {
      if (this.periods[i].start <= end && this.periods[i].end >= start) return true;
    }
    return false;
  }

  /** Records a visibility change; exposed for tests. */
  record(hidden: boolean, at: number): void {
    const last = this.periods.length > 0 ? this.periods[this.periods.length - 1] : null;
    if (hidden) {
      if (last !== null && last.end === Infinity) return;
      this.periods.push({ start: at, end: Infinity });
      if (this.periods.length > MAX_HIDDEN_PERIODS) {
        // Merge the two oldest: the first start survives, overlap checks stay conservative.
        const merged = { start: this.periods[0].start, end: this.periods[1].end };
        this.periods.splice(0, 2, merged);
      }
    } else if (last !== null && last.end === Infinity) {
      last.end = at;
    }
  }

  /**
   * Hidden periods from before the SDK started: `visibility-state` entries
   * where available, otherwise only whether the page is hidden right now.
   * A prerendering page is hidden but will be shown, so it doesn't count.
   */
  private readHistory(doc: Document): void {
    const perf = getPerformance();
    const entries: VisibilityEntry[] =
      perf !== null && typeof perf.getEntriesByType === 'function' ? (perf.getEntriesByType('visibility-state') as VisibilityEntry[]) : [];
    for (let i = 0; i < entries.length; i++) this.record(entries[i].name === 'hidden', entries[i].startTime);
    const prerendering = (doc as Document & { prerendering?: boolean }).prerendering === true;
    if (doc.visibilityState === 'hidden' && !prerendering) {
      // Hidden from the start unless an entry said otherwise.
      if (this.periods.length === 0) this.record(true, 0);
    } else {
      this.record(false, this.now());
    }
  }
}
