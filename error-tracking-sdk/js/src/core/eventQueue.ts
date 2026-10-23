import { BATCH_SIZE, FLUSH_DELAY_MS, MAX_BATCH_BYTES, MAX_QUEUE_SIZE, RETRY_DELAYS_MS } from '../constants';
import { TrackerEvent } from '../types';
import { OfflineStore } from '../transport/offlineStore';
import { Transport } from '../transport/httpTransport';
import { isOnline } from './env';
import { Logger } from './logger';
import { retryWithBackoff, Scheduler } from './retryManager';
import { safely } from './safe';

export interface EventQueueOptions {
  transport: Transport;
  store: OfflineStore;
  logger: Logger;
  batchSize?: number;
  /** Max serialized bytes per request; defaults to MAX_BATCH_BYTES. */
  maxBatchBytes?: number;
  flushDelayMs?: number;
  retryDelaysMs?: readonly number[];
  /** Injectable for tests; defaults to setTimeout. */
  schedule?: Scheduler;
  /** Injectable for tests; defaults to navigator.onLine. */
  isOnline?: () => boolean;
}

/**
 * In-memory event queue. Sends batches with retry, and falls back to the
 * offline store when the device is offline or delivery keeps failing.
 */
export class EventQueue {
  private queue: TrackerEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;

  private readonly transport: Transport;
  private readonly store: OfflineStore;
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly maxBatchBytes: number;
  private readonly flushDelayMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly schedule: Scheduler | undefined;
  private readonly online: () => boolean;

  constructor(options: EventQueueOptions) {
    this.transport = options.transport;
    this.store = options.store;
    this.logger = options.logger;
    this.batchSize = options.batchSize !== undefined ? options.batchSize : BATCH_SIZE;
    this.maxBatchBytes = options.maxBatchBytes !== undefined ? options.maxBatchBytes : MAX_BATCH_BYTES;
    this.flushDelayMs = options.flushDelayMs !== undefined ? options.flushDelayMs : FLUSH_DELAY_MS;
    this.retryDelaysMs = options.retryDelaysMs !== undefined ? options.retryDelaysMs : RETRY_DELAYS_MS;
    this.schedule = options.schedule;
    this.online = options.isOnline !== undefined ? options.isOnline : isOnline;
  }

  /** Number of events waiting in memory (not counting the batch in flight). */
  get size(): number {
    return this.queue.length;
  }

  /** Adds an event and schedules delivery. */
  enqueue(event: TrackerEvent): void {
    if (this.closed) return;

    if (!this.online()) {
      this.logger.info('offline; persisting event');
      this.store.append([event]);
      return;
    }

    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
      this.logger.warn('queue full; dropped oldest events');
    }

    if (this.queue.length >= this.batchSize) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Sends everything currently queued. Resolves when the queue is drained or parked offline. */
  flush(): Promise<void> {
    this.cancelTimer();
    if (this.inFlight !== null) {
      // A send is running; chain another pass so newly queued events go too.
      const self = this;
      return this.inFlight.then(function again() {
        return self.queue.length > 0 ? self.flush() : undefined;
      });
    }
    if (this.queue.length === 0) return Promise.resolve();

    const self = this;
    this.inFlight = this.drain().then(function done() {
      self.inFlight = null;
    });
    return this.inFlight;
  }

  /** Moves events from the offline store back into the queue and sends them. */
  restoreFromStore(): Promise<void> {
    if (this.closed || !this.online()) return Promise.resolve();
    const persisted = this.store.takeAll();
    if (persisted.length === 0) return Promise.resolve();
    this.logger.info('restoring ' + persisted.length + ' persisted event(s)');
    this.queue = persisted.concat(this.queue).slice(-MAX_QUEUE_SIZE);
    return this.flush();
  }

  /** Writes queued (not in-flight) events to the offline store, e.g. when the page is hidden. */
  persistPending(): void {
    this.cancelTimer();
    if (this.queue.length === 0) return;
    this.store.append(this.queue);
    this.queue = [];
  }

  /**
   * The page is unloading. Queued events go out in one keepalive request when
   * the transport supports it and they fit; otherwise they are persisted for
   * the next visit, as before. (Unloading by navigation fires no
   * visibilitychange, so this is the last chance to send them.)
   */
  sendBeforeUnload(): void {
    this.cancelTimer();
    if (this.queue.length === 0) return;
    const transport = this.transport;
    const events = this.queue;
    const sent =
      typeof transport.sendOnUnload === 'function' &&
      this.online() &&
      safely(this.logger, 'send on unload', function handOff() {
        return transport.sendOnUnload !== undefined && transport.sendOnUnload(events);
      }, false);
    if (sent) {
      this.logger.info('sent ' + events.length + ' event(s) with keepalive while unloading');
      this.queue = [];
      return;
    }
    this.persistPending();
  }

  /** Stops accepting events. Pending events are persisted for the next session. */
  close(): void {
    this.persistPending();
    this.closed = true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const self = this;
    this.flushTimer = setTimeout(function timedFlush() {
      self.flushTimer = null;
      self.flush();
    }, this.flushDelayMs);
  }

  private cancelTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * How many queued events fit in the next request: at most batchSize events
   * and at most maxBatchBytes serialized (always at least one event).
   */
  private nextBatchLength(): number {
    let bytes = 0;
    const limit = Math.min(this.batchSize, this.queue.length);
    for (let i = 0; i < limit; i++) {
      bytes += JSON.stringify(this.queue[i]).length;
      if (bytes > this.maxBatchBytes) return Math.max(1, i);
    }
    return limit;
  }

  /** Sends batch after batch until the queue is empty or delivery has to stop. */
  private drain(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();

    if (!this.online()) {
      this.persistPending();
      return Promise.resolve();
    }

    const batch = this.queue.splice(0, this.nextBatchLength());
    const self = this;
    return retryWithBackoff(
      function attempt() {
        return self.transport.send(batch);
      },
      this.retryDelaysMs,
      this.schedule,
    ).then(function handle(outcome) {
      if (outcome.ok) {
        self.logger.info('sent ' + batch.length + ' event(s)');
        return self.drain();
      }
      if (!outcome.retryable) {
        // e.g. 400/401/403: resending the same payload cannot succeed.
        self.logger.warn('endpoint rejected batch with status ' + String(outcome.status) + '; dropping ' + batch.length + ' event(s)');
        return self.drain();
      }
      self.logger.warn('delivery failed after ' + outcome.attempts + ' attempt(s); persisting for later');
      self.store.append(batch);
      self.persistPending();
      return undefined;
    });
  }
}
