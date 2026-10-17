import { SDK_NAME, SDK_VERSION } from '../constants';
import {
  Breadcrumb,
  DevicePayload,
  ErrorPayload,
  EventLevel,
  EventType,
  JsonObject,
  MemoryPayload,
  PerformancePayload,
  StackFrame,
  TrackedUser,
  TrackerEvent,
  UserPayload,
} from '../types';

/** What happened: the event-specific part of a payload. */
export interface EventInput {
  eventType: EventType;
  level: EventLevel;
  error: ErrorPayload | null;
  stacktrace: StackFrame[];
  context: JsonObject | null;
}

/** Ambient state captured at the moment of the event. */
export interface EventScope {
  apiKey: string;
  environment: string;
  appVersion: string | null;
  user: TrackedUser | null;
  breadcrumbs: Breadcrumb[];
  performance: PerformancePayload;
  memory: MemoryPayload;
  device: DevicePayload;
  screenshot: string | null;
}

/** Performance block with every field present and nothing measured. */
export function emptyPerformance(): PerformancePayload {
  return {
    page_load_ms: null,
    ttfb_ms: null,
    fcp_ms: null,
    lcp_ms: null,
    cls: null,
    startup_ms: null,
    frame_rate_fps: null,
    slow_screen: false,
    api_calls: [],
    slow_api_calls: [],
  };
}

/** Memory block with every field present and nothing measured. */
export function emptyMemory(): MemoryPayload {
  return { used_mb: null, total_mb: null, leak_suspected: null, oom_kill: null };
}

function buildUser(user: TrackedUser | null): UserPayload {
  if (user === null) return { id: null, email: null, name: null };
  return {
    id: typeof user.id === 'string' ? user.id : String(user.id),
    email: typeof user.email === 'string' ? user.email : null,
    name: typeof user.name === 'string' ? user.name : null,
  };
}

/**
 * Assembles a schema-complete event. All arrays and nested objects are copied
 * so later mutation of SDK state cannot alter an event already in the queue.
 */
export function buildEvent(input: EventInput, scope: EventScope, timestamp: string): TrackerEvent {
  return {
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    api_key: scope.apiKey,
    event_type: input.eventType,
    level: input.level,
    timestamp: timestamp,
    environment: scope.environment,
    app_version: scope.appVersion,
    user: buildUser(scope.user),
    error: input.error !== null ? { message: input.error.message, type: input.error.type, handled: input.error.handled } : null,
    stacktrace: input.stacktrace.slice(),
    breadcrumbs: scope.breadcrumbs.slice(),
    screenshot: scope.screenshot,
    performance: {
      page_load_ms: scope.performance.page_load_ms,
      ttfb_ms: scope.performance.ttfb_ms,
      fcp_ms: scope.performance.fcp_ms,
      lcp_ms: scope.performance.lcp_ms,
      cls: scope.performance.cls,
      startup_ms: scope.performance.startup_ms,
      frame_rate_fps: scope.performance.frame_rate_fps,
      slow_screen: scope.performance.slow_screen,
      api_calls: scope.performance.api_calls.slice(),
      slow_api_calls: scope.performance.slow_api_calls.slice(),
    },
    memory: {
      used_mb: scope.memory.used_mb,
      total_mb: scope.memory.total_mb,
      leak_suspected: scope.memory.leak_suspected,
      oom_kill: scope.memory.oom_kill,
    },
    device: {
      platform: scope.device.platform,
      os: scope.device.os,
      os_version: scope.device.os_version,
      manufacturer: scope.device.manufacturer,
      model: scope.device.model,
      browser: scope.device.browser,
      browser_version: scope.device.browser_version,
      screen_width: scope.device.screen_width,
      screen_height: scope.device.screen_height,
      url: scope.device.url,
      referrer: scope.device.referrer,
      locale: scope.device.locale,
    },
    context: input.context,
  };
}

/** Returns a shallow copy of `event` with one top-level field replaced. */
export function withField<K extends keyof TrackerEvent>(event: TrackerEvent, key: K, value: TrackerEvent[K]): TrackerEvent {
  const copy = {} as TrackerEvent;
  (Object.keys(event) as Array<keyof TrackerEvent>).forEach(function assign(k) {
    (copy as unknown as Record<string, unknown>)[k] = event[k];
  });
  copy[key] = value;
  return copy;
}
