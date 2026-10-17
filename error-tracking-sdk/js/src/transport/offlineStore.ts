import { MAX_PERSISTED_EVENTS, OFFLINE_STORAGE_KEY } from '../constants';
import { getLocalStorage } from '../core/env';
import { Logger } from '../core/logger';
import { withField } from '../core/payloadBuilder';
import { TrackerEvent } from '../types';

/** Persistence for events that could not be delivered. */
export interface OfflineStore {
  append(events: TrackerEvent[]): void;
  /** Returns every stored event and clears storage. */
  takeAll(): TrackerEvent[];
}

/**
 * Stores undelivered events in localStorage under `_et_queue`.
 *
 * The API key is blanked before writing (it is re-applied by the transport
 * at send time), and storage failures — quota exceeded, disabled storage,
 * corrupt data — are handled without ever throwing.
 */
export class LocalStorageStore implements OfflineStore {
  constructor(
    private readonly logger: Logger,
    private readonly maxEvents: number = MAX_PERSISTED_EVENTS,
    private readonly key: string = OFFLINE_STORAGE_KEY,
  ) {}

  append(events: TrackerEvent[]): void {
    if (events.length === 0) return;
    const storage = getLocalStorage();
    if (storage === null) {
      this.logger.warn('localStorage unavailable; dropping ' + events.length + ' undeliverable event(s)');
      return;
    }

    let combined = this.read(storage).concat(events.map(redact)).slice(-this.maxEvents);

    // Quota strategy: first drop screenshots (by far the largest field), then
    // repeatedly halve the stored set keeping the newest events.
    let strippedScreenshots = false;
    while (combined.length > 0) {
      if (this.write(storage, combined)) return;
      if (!strippedScreenshots) {
        combined = combined.map(withoutScreenshot);
        strippedScreenshots = true;
      } else {
        combined = combined.slice(Math.ceil(combined.length / 2));
      }
    }
    this.logger.warn('localStorage is full; could not persist events');
  }

  takeAll(): TrackerEvent[] {
    const storage = getLocalStorage();
    if (storage === null) return [];
    const events = this.read(storage);
    try {
      storage.removeItem(this.key);
    } catch (e) {
      this.logger.warn('failed to clear persisted queue', e);
    }
    return events;
  }

  private read(storage: Storage): TrackerEvent[] {
    let raw: string | null;
    try {
      raw = storage.getItem(this.key);
    } catch (e) {
      this.logger.warn('failed to read persisted queue', e);
      return [];
    }
    if (raw === null || raw.length === 0) return [];

    try {
      const parsed: unknown = JSON.parse(raw);
      if (Object.prototype.toString.call(parsed) !== '[object Array]') throw new Error('not an array');
      return (parsed as unknown[]).filter(isEventLike);
    } catch (e) {
      this.logger.warn('persisted queue was corrupt; discarding it', e);
      try {
        storage.removeItem(this.key);
      } catch (_ignored) {
        // Already reported the corruption; removal failure changes nothing.
      }
      return [];
    }
  }

  private write(storage: Storage, events: TrackerEvent[]): boolean {
    try {
      storage.setItem(this.key, JSON.stringify(events));
      return true;
    } catch (e) {
      this.logger.warn('failed to write persisted queue (' + events.length + ' event(s))', e);
      return false;
    }
  }
}

/** In-memory store for environments without localStorage, and for tests. */
export class MemoryStore implements OfflineStore {
  private events: TrackerEvent[] = [];

  constructor(private readonly maxEvents: number = MAX_PERSISTED_EVENTS) {}

  append(events: TrackerEvent[]): void {
    this.events = this.events.concat(events.map(redact)).slice(-this.maxEvents);
  }

  takeAll(): TrackerEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

function redact(event: TrackerEvent): TrackerEvent {
  return withField(event, 'api_key', '');
}

function withoutScreenshot(event: TrackerEvent): TrackerEvent {
  return withField(event, 'screenshot', null);
}

function isEventLike(value: unknown): value is TrackerEvent {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { event_type?: unknown }).event_type === 'string' &&
    typeof (value as { timestamp?: unknown }).timestamp === 'string'
  );
}
