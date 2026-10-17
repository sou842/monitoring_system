import { BATCH_SIZE, FLUSH_DELAY_MS, MAX_QUEUE_SIZE, RETRY_DELAYS_MS } from '../constants';
import { TrackerEvent } from '../types';
import { OfflineStore } from '../transport/offlineStore';
import { Transport } from '../transport/httpTransport';
import { isOnline } from './env';
import { Logger } from './logger';
import { retryWithBackoff, Scheduler } from './retryManager';

export interface EventQueueOptions {
  transport: Transport;
  store: OfflineStore;
  logger: Logger;
  batchSize?: number;
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
  private readonly flushDelayMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly schedule: Scheduler | undefined;
  private readonly online: () => boolean;

  constructor(options: EventQueueOptions) {
    this.transport = options.transport;
    this.store = options.store;
    this.logger = options.logger;
    this.batchSize = options.batchSize !== undefined ? options.batchSize : BATCH_SIZE;
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

  /** Sends batch after batch until the queue is empty or delivery has to stop. */
  private drain(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();

    if (!this.online()) {
      this.persistPending();
      return Promise.resolve();
    }

    const batch = this.queue.splice(0, this.batchSize);
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
