import {
  DEVICE_ID_BYTES,
  DEVICE_ID_STORAGE_KEY,
  SESSION_ID_BYTES,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_STORAGE_KEY,
  SESSION_TOUCH_WRITE_MS,
} from '../constants';
import { getLocalStorage, getSessionStorage, getWindow } from './env';
import { randomHexId } from './ids';

/** A stored id is accepted only in the exact shape the SDK writes, so a tampered value can't carry anything else. */
const DEVICE_ID_PATTERN = new RegExp('^[0-9a-f]{' + DEVICE_ID_BYTES * 2 + '}$');
const SESSION_ID_PATTERN = new RegExp('^[0-9a-f]{' + SESSION_ID_BYTES * 2 + '}$');

/** Sources the ids come from; injectable for tests. */
export interface IdentityDependencies {
  localStorage?: Storage | null;
  sessionStorage?: Storage | null;
  now?: () => number;
  /** False outside a browser page (Node), where both ids are null. */
  inBrowser?: boolean;
}

/**
 * Anonymous ids that tell events from the same browser and the same visit apart.
 *
 * - `deviceId`: random, created once and kept in localStorage, so it stays the
 *   same across reloads, tabs and logins. It says nothing about the person; it
 *   is lost when site data is cleared, and each browser profile gets its own.
 * - `sessionId`: random, kept in sessionStorage, so it survives reloads in the
 *   same tab and every tab gets its own. A tab idle (no events or breadcrumbs)
 *   for `SESSION_IDLE_TIMEOUT_MS` starts a new session.
 *
 * Blocked storage (private mode, sandboxed iframes) falls back to an in-memory
 * id for this page. Nothing here ever throws.
 */
export class Identity {
  private readonly local: Storage | null;
  private readonly session: Storage | null;
  private readonly now: () => number;
  private readonly enabled: boolean;
  private readonly trackDevice: boolean;
  private device: string | null = null;
  private sessionId: string | null = null;
  private lastActivity = 0;
  private lastWrite = 0;

  constructor(trackDevice: boolean, deps: IdentityDependencies = {}) {
    this.enabled = deps.inBrowser !== undefined ? deps.inBrowser : getWindow() !== null;
    this.trackDevice = trackDevice;
    this.local = deps.localStorage !== undefined ? deps.localStorage : getLocalStorage();
    this.session = deps.sessionStorage !== undefined ? deps.sessionStorage : getSessionStorage();
    this.now = deps.now || Date.now;
  }

  /** This browser's id, or null when `trackDevice` is off or outside a browser. */
  deviceId(): string | null {
    if (!this.enabled || !this.trackDevice) return null;
    if (this.device === null) this.device = this.loadDevice();
    return this.device;
  }

  /**
   * The current session's id, or null outside a browser. Counts as activity:
   * calling it keeps the session alive.
   */
  currentSessionId(): string | null {
    if (!this.enabled) return null;
    const now = this.now();
    if (this.sessionId === null) this.loadSession(now);
    if (this.sessionId === null || now - this.lastActivity > SESSION_IDLE_TIMEOUT_MS) this.startSession(now);
    else this.touch(now);
    return this.sessionId;
  }

  /** Records activity (a breadcrumb) without reading the id. */
  touch(now = this.now()): void {
    if (!this.enabled || this.sessionId === null) return;
    // Idle too long already: the next currentSessionId() starts a new session instead.
    if (now - this.lastActivity > SESSION_IDLE_TIMEOUT_MS) return;
    this.lastActivity = now;
    if (now - this.lastWrite >= SESSION_TOUCH_WRITE_MS) this.saveSession(now);
  }

  private loadDevice(): string {
    const stored = read(this.local, DEVICE_ID_STORAGE_KEY);
    if (stored !== null && DEVICE_ID_PATTERN.test(stored)) return stored;
    const id = randomHexId(DEVICE_ID_BYTES);
    write(this.local, DEVICE_ID_STORAGE_KEY, id);
    return id;
  }

  private loadSession(now: number): void {
    const stored = read(this.session, SESSION_STORAGE_KEY);
    if (stored === null) return;
    try {
      const parsed: unknown = JSON.parse(stored);
      if (parsed === null || typeof parsed !== 'object') return;
      const record = parsed as { id?: unknown; last?: unknown };
      if (typeof record.id !== 'string' || !SESSION_ID_PATTERN.test(record.id)) return;
      if (typeof record.last !== 'number' || !isFinite(record.last) || record.last > now) return;
      this.sessionId = record.id;
      this.lastActivity = record.last;
      this.lastWrite = record.last;
    } catch (_e) {
      // Unreadable: a new session starts.
    }
  }

  private startSession(now: number): void {
    this.sessionId = randomHexId(SESSION_ID_BYTES);
    this.lastActivity = now;
    this.saveSession(now);
  }

  private saveSession(now: number): void {
    this.lastWrite = now;
    if (this.sessionId !== null) write(this.session, SESSION_STORAGE_KEY, JSON.stringify({ id: this.sessionId, last: now }));
  }
}

function read(storage: Storage | null, key: string): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch (_e) {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  if (storage === null) return;
  try {
    storage.setItem(key, value);
  } catch (_e) {
    // Full or blocked: the id stays in memory for this page.
  }
}
