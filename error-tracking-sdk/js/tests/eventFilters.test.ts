import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_MAX_EVENTS } from '../src/constants';
import { Deduplicator, fingerprint, RateLimiter } from '../src/core/eventFilters';

describe('RateLimiter', () => {
  it('accepts at most the limit within a window during a 1000 events/min storm', () => {
    let now = 0;
    const limiter = new RateLimiter(RATE_LIMIT_MAX_EVENTS, 60000, () => now);
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {
      now = i * 60; // 1000 events spread across one minute
      if (limiter.tryAcquire()) accepted++;
    }
    expect(accepted).toBe(RATE_LIMIT_MAX_EVENTS);
  });

  it('frees capacity as the window slides', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    now = 1000;
    expect(limiter.tryAcquire()).toBe(true);
  });
});

describe('Deduplicator', () => {
  it('drops repeats within the window and allows them after it', () => {
    let now = 0;
    const dedup = new Deduplicator(5000, 10, () => now);
    expect(dedup.isNew('a')).toBe(true);
    expect(dedup.isNew('a')).toBe(false);
    expect(dedup.isNew('b')).toBe(true);
    now = 5000;
    expect(dedup.isNew('a')).toBe(true);
  });

  it('bounds memory by evicting the oldest fingerprints', () => {
    const dedup = new Deduplicator(5000, 2, () => 0);
    dedup.isNew('a');
    dedup.isNew('b');
    dedup.isNew('c'); // evicts "a"
    expect(dedup.isNew('a')).toBe(true);
  });
});

describe('fingerprint', () => {
  it('distinguishes errors by type, message and top frame', () => {
    const err = { message: 'm', type: 'TypeError', handled: false };
    const frameA = [{ filename: 'a.js', lineno: 1, colno: 1, function: 'f' }];
    const frameB = [{ filename: 'a.js', lineno: 2, colno: 1, function: 'f' }];
    expect(fingerprint('error', err, frameA)).toBe(fingerprint('error', { ...err, handled: true }, frameA));
    expect(fingerprint('error', err, frameA)).not.toBe(fingerprint('error', err, frameB));
    expect(fingerprint('error', err, frameA)).not.toBe(fingerprint('error', { ...err, type: 'RangeError' }, frameA));
  });
});
