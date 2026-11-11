import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_ID_STORAGE_KEY,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_STORAGE_KEY,
  SESSION_TOUCH_WRITE_MS,
} from '../src/constants';
import { Identity } from '../src/core/identity';
import ErrorTracker from '../src/index';
import { TrackerEvent } from '../src/types';
import { mockFetch } from './helpers';

const HEX32 = /^[0-9a-f]{32}$/;

/** Minimal Storage stand-in; `failWrites` simulates a full or blocked store. */
function memoryStorage(failWrites = false): Storage {
  const data: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(data).length;
    },
    clear: () => Object.keys(data).forEach((k) => delete data[k]),
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    key: (i: number) => Object.keys(data)[i] ?? null,
    removeItem: (k: string) => {
      delete data[k];
    },
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error('QuotaExceededError');
      data[k] = String(v);
    },
  };
}

function throwingStorage(): Storage {
  const s = memoryStorage();
  s.getItem = () => {
    throw new Error('SecurityError');
  };
  s.setItem = () => {
    throw new Error('SecurityError');
  };
  return s;
}

describe('Identity: device id', () => {
  it('creates a 32-hex id once and reuses the stored one', () => {
    const local = memoryStorage();
    const first = new Identity(true, { localStorage: local, sessionStorage: memoryStorage(), inBrowser: true });
    const id = first.deviceId();
    expect(id).toMatch(HEX32);
    expect(local.getItem(DEVICE_ID_STORAGE_KEY)).toBe(id);
    const second = new Identity(true, { localStorage: local, sessionStorage: memoryStorage(), inBrowser: true });
    expect(second.deviceId()).toBe(id);
  });

  it('replaces a stored value that is not in the SDK format', () => {
    const local = memoryStorage();
    local.setItem(DEVICE_ID_STORAGE_KEY, 'user@example.com');
    const id = new Identity(true, { localStorage: local, sessionStorage: null, inBrowser: true }).deviceId();
    expect(id).toMatch(HEX32);
    expect(local.getItem(DEVICE_ID_STORAGE_KEY)).toBe(id);
  });

  it('keeps an in-memory id for the page when storage throws or is full', () => {
    for (const local of [throwingStorage(), memoryStorage(true), null]) {
      const identity = new Identity(true, { localStorage: local, sessionStorage: null, inBrowser: true });
      const id = identity.deviceId();
      expect(id).toMatch(HEX32);
      expect(identity.deviceId()).toBe(id);
    }
  });

  it('is null with trackDevice off (nothing written) and outside a browser', () => {
    const local = memoryStorage();
    expect(new Identity(false, { localStorage: local, sessionStorage: memoryStorage(), inBrowser: true }).deviceId()).toBeNull();
    expect(local.getItem(DEVICE_ID_STORAGE_KEY)).toBeNull();
    expect(new Identity(true, { localStorage: local, sessionStorage: memoryStorage(), inBrowser: false }).deviceId()).toBeNull();
  });
});

describe('Identity: session id', () => {
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000_000;
  });

  it('keeps one session while active and survives a reload in the same tab', () => {
    const session = memoryStorage();
    const a = new Identity(true, { localStorage: null, sessionStorage: session, now, inBrowser: true });
    const id = a.currentSessionId();
    expect(id).toMatch(HEX32);
    clock += SESSION_IDLE_TIMEOUT_MS - 1;
    expect(a.currentSessionId()).toBe(id);
    // "Reload": a new instance on the same sessionStorage.
    clock += SESSION_TOUCH_WRITE_MS;
    const b = new Identity(true, { localStorage: null, sessionStorage: session, now, inBrowser: true });
    expect(b.currentSessionId()).toBe(id);
  });

  it('starts a new session after the idle timeout', () => {
    const identity = new Identity(true, { localStorage: null, sessionStorage: memoryStorage(), now, inBrowser: true });
    const id = identity.currentSessionId();
    clock += SESSION_IDLE_TIMEOUT_MS + 1;
    const next = identity.currentSessionId();
    expect(next).toMatch(HEX32);
    expect(next).not.toBe(id);
  });

  it('breadcrumb activity (touch) keeps the session alive', () => {
    const identity = new Identity(true, { localStorage: null, sessionStorage: memoryStorage(), now, inBrowser: true });
    const id = identity.currentSessionId();
    for (let i = 0; i < 4; i++) {
      clock += SESSION_IDLE_TIMEOUT_MS / 2;
      identity.touch();
    }
    clock += SESSION_IDLE_TIMEOUT_MS / 2;
    expect(identity.currentSessionId()).toBe(id);
  });

  it('a reload after the idle timeout starts a new session', () => {
    const session = memoryStorage();
    const id = new Identity(true, { localStorage: null, sessionStorage: session, now, inBrowser: true }).currentSessionId();
    clock += SESSION_IDLE_TIMEOUT_MS + SESSION_TOUCH_WRITE_MS + 1;
    const next = new Identity(true, { localStorage: null, sessionStorage: session, now, inBrowser: true }).currentSessionId();
    expect(next).not.toBe(id);
  });

  it('throttles sessionStorage writes', () => {
    const session = memoryStorage();
    const spy = vi.spyOn(session, 'setItem');
    const identity = new Identity(true, { localStorage: null, sessionStorage: session, now, inBrowser: true });
    identity.currentSessionId();
    for (let i = 0; i < 50; i++) {
      clock += 100;
      identity.touch();
      identity.currentSessionId();
    }
    expect(spy).toHaveBeenCalledTimes(1);
    clock += SESSION_TOUCH_WRITE_MS;
    identity.touch();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ignores a tampered or future stored session', () => {
    for (const stored of ['not json', '{"id":"<script>","last":1}', JSON.stringify({ id: 'a'.repeat(32), last: 9e15 }), 'null']) {
      const session = memoryStorage();
      session.setItem(SESSION_STORAGE_KEY, stored);
      const id = new Identity(true, { localStorage: null, sessionStorage: session, now, inBrowser: true }).currentSessionId();
      expect(id).toMatch(HEX32);
      expect(id).not.toBe('a'.repeat(32));
    }
  });

  it('works with blocked storage and is null outside a browser', () => {
    const identity = new Identity(true, { localStorage: null, sessionStorage: throwingStorage(), now, inBrowser: true });
    const id = identity.currentSessionId();
    expect(id).toMatch(HEX32);
    expect(identity.currentSessionId()).toBe(id);
    expect(new Identity(true, { localStorage: null, sessionStorage: memoryStorage(), now, inBrowser: false }).currentSessionId()).toBeNull();
  });
});

describe('device.id and session_id on sent events', () => {
  let fetchMock: ReturnType<typeof mockFetch>;
  const sent = (): TrackerEvent[] => fetchMock.calls.reduce<TrackerEvent[]>((all, call) => all.concat(call.body.events), []);
  const config = { apiKey: 'pk_test', endpoint: 'https://ingest.test/v1/events', performanceSampleRate: 0 };

  beforeEach(() => {
    fetchMock = mockFetch(202);
    vi.stubGlobal('fetch', fetchMock.fn);
    window.fetch = fetchMock.fn as unknown as typeof fetch;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(async () => {
    await ErrorTracker.close();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('every event carries the same device and session id, also after re-init', async () => {
    ErrorTracker.init(config);
    ErrorTracker.captureMessage('one');
    ErrorTracker.captureError(new Error('two'));
    await ErrorTracker.flush();
    await ErrorTracker.close();
    ErrorTracker.init(config);
    ErrorTracker.captureMessage('three');
    await ErrorTracker.flush();

    const events = sent();
    expect(events).toHaveLength(3);
    const deviceId = events[0].device.id;
    const sessionId = events[0].session_id;
    expect(deviceId).toMatch(HEX32);
    expect(sessionId).toMatch(HEX32);
    expect(deviceId).not.toBe(sessionId);
    for (const e of events) {
      expect(e.device.id).toBe(deviceId);
      expect(e.session_id).toBe(sessionId);
    }
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(deviceId);
  });

  it('trackDevice: false sends device.id null but keeps session_id', async () => {
    ErrorTracker.init({ ...config, trackDevice: false });
    ErrorTracker.captureMessage('one');
    await ErrorTracker.flush();
    const [event] = sent();
    expect(event.device.id).toBeNull();
    expect(event.session_id).toMatch(HEX32);
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBeNull();
  });

  it('never stores the API key next to the ids', async () => {
    ErrorTracker.init(config);
    ErrorTracker.captureMessage('one');
    await ErrorTracker.flush();
    expect(localStorage.getItem(DEVICE_ID_STORAGE_KEY)).not.toContain('pk_test');
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).not.toContain('pk_test');
  });
});
