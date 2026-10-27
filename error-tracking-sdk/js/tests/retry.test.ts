import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRY_DELAYS_MS } from '../src/constants';
import { EventQueue } from '../src/core/eventQueue';
import { Logger } from '../src/core/logger';
import { buildEvent } from '../src/core/payloadBuilder';
import { AttemptResult, retryWithBackoff } from '../src/core/retryManager';
import { MemoryStore } from '../src/transport/offlineStore';
import { TrackerEvent } from '../src/types';
import { makeScope, OK, ScriptedTransport, SERVER_ERROR, settle, UNAUTHORIZED } from './helpers';

function event(message: string): TrackerEvent {
  return buildEvent(
    { eventType: 'error', level: 'error', error: { message, type: 'Error', handled: true }, stacktrace: [], context: null },
    makeScope(),
    '2026-10-17T10:42:15.000Z',
  );
}

describe('retryWithBackoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the 1s / 2s / 4s schedule and gives up after 3 retries', async () => {
    const attemptTimes: number[] = [];
    const start = Date.now();
    const attempt = vi.fn((): Promise<AttemptResult> => {
      attemptTimes.push(Date.now() - start);
      return Promise.resolve(SERVER_ERROR);
    });

    const done = retryWithBackoff(attempt);
    await vi.runAllTimersAsync();
    const outcome = await done;

    expect(RETRY_DELAYS_MS).toEqual([1000, 2000, 4000]);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(attemptTimes).toEqual([0, 1000, 3000, 7000]);
    expect(outcome).toEqual({ ok: false, retryable: true, status: 503, attempts: 4 });
  });

  it('stops as soon as an attempt succeeds', async () => {
    const results = [SERVER_ERROR, OK];
    const attempt = vi.fn(() => Promise.resolve(results.shift() as AttemptResult));

    const done = retryWithBackoff(attempt);
    await vi.runAllTimersAsync();
    expect(await done).toEqual({ ...OK, attempts: 2 });
  });

  it('does not retry non-retryable failures', async () => {
    const attempt = vi.fn(() => Promise.resolve(UNAUTHORIZED));
    const outcome = await retryWithBackoff(attempt);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe(401);
  });

  it('treats rejected and throwing attempts as retryable network failures', async () => {
    let calls = 0;
    const attempt = (): Promise<AttemptResult> => {
      calls++;
      if (calls === 1) throw new Error('sync throw');
      if (calls === 2) return Promise.reject(new Error('network'));
      return Promise.resolve(OK);
    };
    const done = retryWithBackoff(attempt);
    await vi.runAllTimersAsync();
    expect((await done).attempts).toBe(3);
  });
});

describe('EventQueue', () => {
  const logger = new Logger(false);
  let online = true;
  const noDelay = [0, 0, 0];

  beforeEach(() => {
    online = true;
  });

  function makeQueue(transport: ScriptedTransport, store = new MemoryStore()) {
    const queue = new EventQueue({ transport, store, logger, retryDelaysMs: noDelay, isOnline: () => online });
    return { queue, store };
  }

  it('batches up to 10 events per request', async () => {
    const transport = new ScriptedTransport();
    const { queue } = makeQueue(transport);
    for (let i = 0; i < 25; i++) queue.enqueue(event('e' + i));
    await queue.flush();

    expect(transport.sent.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(queue.size).toBe(0);
  });

  it('sends a partial batch after the flush delay', async () => {
    vi.useFakeTimers();
    const transport = new ScriptedTransport();
    const { queue } = makeQueue(transport);
    queue.enqueue(event('a'));
    expect(transport.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.sent).toHaveLength(1);
    vi.useRealTimers();
  });

  it('retries a failing batch, then persists it once retries are exhausted', async () => {
    const transport = new ScriptedTransport([SERVER_ERROR, SERVER_ERROR, SERVER_ERROR, SERVER_ERROR]);
    const { queue, store } = makeQueue(transport);
    queue.enqueue(event('a'));
    await queue.flush();
    await settle();

    expect(transport.sent).toHaveLength(4);
    const persisted = store.takeAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].api_key).toBe('');
  });

  it('recovers when a retry succeeds', async () => {
    const transport = new ScriptedTransport(['reject', SERVER_ERROR, OK]);
    const { queue, store } = makeQueue(transport);
    queue.enqueue(event('a'));
    await queue.flush();

    expect(transport.sent).toHaveLength(3);
    expect(store.takeAll()).toHaveLength(0);
  });

  it('drops batches the server rejects permanently (e.g. invalid API key) and continues', async () => {
    const transport = new ScriptedTransport([UNAUTHORIZED, OK]);
    const { queue, store } = makeQueue(transport);
    for (let i = 0; i < 12; i++) queue.enqueue(event('e' + i));
    await queue.flush();

    expect(transport.sent.map((b) => b.length)).toEqual([10, 2]);
    expect(store.takeAll()).toHaveLength(0);
  });

  it('persists events while offline and sends them on restore', async () => {
    const transport = new ScriptedTransport();
    const { queue, store } = makeQueue(transport);

    online = false;
    queue.enqueue(event('offline-1'));
    queue.enqueue(event('offline-2'));
    expect(transport.sent).toHaveLength(0);

    online = true;
    await queue.restoreFromStore();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].map((e) => (e.error ? e.error.message : ''))).toEqual(['offline-1', 'offline-2']);
    expect(store.takeAll()).toHaveLength(0);
  });

  it('ignores events after close() and persists what was pending', () => {
    const transport = new ScriptedTransport();
    const { queue, store } = makeQueue(transport);
    queue.enqueue(event('pending'));
    queue.close();
    queue.enqueue(event('after-close'));
    expect(store.takeAll().map((e) => (e.error ? e.error.message : ''))).toEqual(['pending']);
  });
});

describe('EventQueue batch size limit', () => {
  it('splits batches so no request exceeds maxBatchBytes, and sends an oversized event on its own', async () => {
    const LIMIT = 6000;
    const transport = new ScriptedTransport();
    const queue = new EventQueue({
      transport,
      store: new MemoryStore(),
      logger: new Logger(false),
      retryDelaysMs: [0, 0, 0],
      isOnline: () => true,
      maxBatchBytes: LIMIT,
    });
    const padded = (name: string, length: number): TrackerEvent => ({ ...event(name), context: { padding: 'A'.repeat(length) } });
    for (let i = 0; i < 5; i++) queue.enqueue(padded('e' + i, 1000));
    queue.enqueue(padded('huge', 10000));
    await queue.flush();

    const size = (batch: TrackerEvent[]) => batch.reduce((n, e) => n + JSON.stringify(e).length, 0);
    expect(transport.sent.some((b) => b.length > 1)).toBe(true); // small events are still batched together
    for (const batch of transport.sent) if (batch.length > 1) expect(size(batch)).toBeLessThanOrEqual(LIMIT);
    expect(transport.sent.reduce((n, b) => n + b.length, 0)).toBe(6);
    expect(transport.sent[transport.sent.length - 1].map((e) => e.error && e.error.message)).toEqual(['huge']);
  });
});
