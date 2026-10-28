import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomRequestId } from '../src/core/ids';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('randomRequestId', () => {
  it('returns 16 lowercase hex characters, different every time', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = randomRequestId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });

  it('keeps leading zeros of each byte', () => {
    vi.stubGlobal('crypto', { getRandomValues: (buffer: Uint8Array) => buffer.fill(5) });
    expect(randomRequestId()).toBe('0505050505050505');
  });

  it('falls back to Math.random without crypto', () => {
    vi.stubGlobal('crypto', undefined);
    expect(randomRequestId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to Math.random when getRandomValues throws', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('not allowed');
      },
    });
    expect(randomRequestId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
