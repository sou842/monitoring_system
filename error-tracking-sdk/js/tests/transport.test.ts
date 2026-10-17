import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_STORAGE_KEY } from '../src/constants';
import { Logger } from '../src/core/logger';
import { buildEvent } from '../src/core/payloadBuilder';
import { classifyStatus, HttpTransport } from '../src/transport/httpTransport';
import { LocalStorageStore } from '../src/transport/offlineStore';
import { TrackerEvent } from '../src/types';
import { makeScope, mockFetch } from './helpers';

const logger = new Logger(false);

function event(message: string, screenshot: string | null = null): TrackerEvent {
  return buildEvent(
    { eventType: 'error', level: 'error', error: { message, type: 'Error', handled: true }, stacktrace: [], context: null },
    makeScope({ screenshot }),
    '2026-10-17T10:42:15.000Z',
  );
}

describe('classifyStatus', () => {
  it.each([
    [200, true, false],
    [202, true, false],
    [400, false, false],
    [401, false, false],
    [403, false, false],
    [408, false, true],
    [429, false, true],
    [500, false, true],
    [503, false, true],
  ])('status %i → ok=%s retryable=%s', (status, ok, retryable) => {
    expect(classifyStatus(status)).toEqual({ ok, retryable, status });
  });
});

describe('HttpTransport', () => {
  it('POSTs a JSON batch with the API key header and stamps api_key on each event', async () => {
    const { fn, calls } = mockFetch(202);
    const transport = new HttpTransport('https://ingest.test/v1/events', 'secret-key', logger, fn as unknown as typeof fetch);
    const stored = { ...event('a'), api_key: '' }; // as restored from offline storage

    const result = await transport.send([stored]);

    expect(result).toEqual({ ok: true, retryable: false, status: 202 });
    expect(calls[0].url).toBe('https://ingest.test/v1/events');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', 'X-API-Key': 'secret-key' });
    expect(calls[0].body.events[0].api_key).toBe('secret-key');
  });

  it('reports network failures as retryable', async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const transport = new HttpTransport('https://ingest.test', 'k', logger, failing as unknown as typeof fetch);
    expect(await transport.send([event('a')])).toEqual({ ok: false, retryable: true, status: null });
  });

  it('reports 5xx as retryable and 4xx as permanent', async () => {
    const t500 = new HttpTransport('https://ingest.test', 'k', logger, mockFetch(500).fn as unknown as typeof fetch);
    const t401 = new HttpTransport('https://ingest.test', 'k', logger, mockFetch(401).fn as unknown as typeof fetch);
    expect((await t500.send([event('a')])).retryable).toBe(true);
    expect((await t401.send([event('a')])).retryable).toBe(false);
  });
});

describe('LocalStorageStore', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it(`persists under "${OFFLINE_STORAGE_KEY}" without the API key and clears on takeAll`, () => {
    const store = new LocalStorageStore(logger);
    store.append([event('a'), event('b')]);

    const raw = localStorage.getItem(OFFLINE_STORAGE_KEY) as string;
    expect(raw).not.toContain('test-key');
    expect(JSON.parse(raw)).toHaveLength(2);

    expect(store.takeAll().map((e) => e.error && e.error.message)).toEqual(['a', 'b']);
    expect(localStorage.getItem(OFFLINE_STORAGE_KEY)).toBeNull();
  });

  it('caps stored events, keeping the newest', () => {
    const store = new LocalStorageStore(logger, 3);
    store.append([event('1'), event('2')]);
    store.append([event('3'), event('4')]);
    expect(store.takeAll().map((e) => e.error && e.error.message)).toEqual(['2', '3', '4']);
  });

  it('discards corrupt storage instead of throwing', () => {
    localStorage.setItem(OFFLINE_STORAGE_KEY, '{not json');
    const store = new LocalStorageStore(logger);
    expect(store.takeAll()).toEqual([]);
    localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify([{ junk: true }, event('ok')]));
    expect(store.takeAll()).toHaveLength(1);
  });

  it('on quota exceeded, drops screenshots first and then the oldest events', () => {
    const store = new LocalStorageStore(logger);
    const realSetItem = Storage.prototype.setItem;
    const QUOTA = 6000;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (value.length > QUOTA) throw new DOMException('quota', 'QuotaExceededError');
      realSetItem.call(this, key, value);
    });

    const big = 'data:image/jpeg;base64,' + 'A'.repeat(10000);
    expect(() => store.append([event('1', big), event('2', big), event('3', big)])).not.toThrow();

    const kept = JSON.parse(localStorage.getItem(OFFLINE_STORAGE_KEY) as string) as TrackerEvent[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((e) => e.screenshot === null)).toBe(true);
    const newest = kept[kept.length - 1];
    expect(newest.error?.message).toBe('3');
  });

  it('never throws when storage access is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const store = new LocalStorageStore(logger);
    expect(() => store.append([event('a')])).not.toThrow();
    expect(store.takeAll()).toEqual([]);
  });
});
