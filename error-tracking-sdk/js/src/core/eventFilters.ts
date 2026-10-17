import {
  DEDUP_MAX_ENTRIES,
  DEDUP_WINDOW_MS,
  RATE_LIMIT_MAX_EVENTS,
  RATE_LIMIT_WINDOW_MS,
} from '../constants';
import { ErrorPayload, StackFrame } from '../types';

type Clock = () => number;

const defaultClock: Clock = function now() {
  return Date.now();
};

/**
 * Sliding-window rate limiter that protects the host app and the backend
 * from error storms (e.g. an exception thrown inside an animation frame).
 */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxEvents: number = RATE_LIMIT_MAX_EVENTS,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
    private readonly clock: Clock = defaultClock,
  ) {}

  /** Returns true and records the event if it fits within the limit. */
  tryAcquire(): boolean {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) this.timestamps.shift();
    if (this.timestamps.length >= this.maxEvents) return false;
    this.timestamps.push(now);
    return true;
  }
}

/**
 * Drops events whose fingerprint was already seen within the dedup window,
 * so a loop throwing the same error does not send hundreds of copies.
 */
export class Deduplicator {
  private seen: Record<string, number> = {};
  private order: string[] = [];

  constructor(
    private readonly windowMs: number = DEDUP_WINDOW_MS,
    private readonly maxEntries: number = DEDUP_MAX_ENTRIES,
    private readonly clock: Clock = defaultClock,
  ) {}

  /** Returns true if this fingerprint is new (or its previous sighting has expired). */
  isNew(fingerprint: string): boolean {
    const now = this.clock();
    const last = this.seen[fingerprint];
    if (last !== undefined && now - last < this.windowMs) return false;

    if (last === undefined) {
      this.order.push(fingerprint);
      if (this.order.length > this.maxEntries) {
        const evicted = this.order.shift();
        if (evicted !== undefined) delete this.seen[evicted];
      }
    }
    this.seen[fingerprint] = now;
    return true;
  }
}

/** Fingerprint used for dedup: event type + error identity + top stack frame. */
export function fingerprint(
  eventType: string,
  error: ErrorPayload | null,
  stacktrace: StackFrame[],
): string {
  const top = stacktrace.length > 0 ? stacktrace[0] : null;
  return [
    eventType,
    error !== null ? error.type : '',
    error !== null ? error.message : '',
    top !== null ? String(top.filename) + ':' + String(top.lineno) + ':' + String(top.colno) : '',
  ].join('|');
}
