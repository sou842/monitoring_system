import { expect, vi } from 'vitest';
import { CapturedError, CollectorSink, PerformanceIssueKind } from '../src/collectors/collector';
import { emptyMemory, emptyPerformance, EventScope } from '../src/core/payloadBuilder';
import { AttemptResult } from '../src/core/retryManager';
import { Transport } from '../src/transport/httpTransport';
import { BreadcrumbInput, JsonObject, TrackerEvent } from '../src/types';

/** Collector sink that records everything it receives. */
export class RecordingSink implements CollectorSink {
  errors: CapturedError[] = [];
  breadcrumbs: BreadcrumbInput[] = [];
  issues: Array<{ kind: PerformanceIssueKind; message: string; context?: JsonObject }> = [];

  onError(captured: CapturedError): void {
    this.errors.push(captured);
  }
  onBreadcrumb(breadcrumb: BreadcrumbInput): void {
    this.breadcrumbs.push(breadcrumb);
  }
  navigations: string[] = [];

  onNavigation(url: string): void {
    this.navigations.push(url);
  }
  onPerformanceIssue(kind: PerformanceIssueKind, message: string, context?: JsonObject): void {
    this.issues.push(context !== undefined ? { kind, message, context } : { kind, message });
  }
}

/** Transport whose responses are scripted per attempt. */
export class ScriptedTransport implements Transport {
  sent: TrackerEvent[][] = [];
  private responses: Array<AttemptResult | 'reject'>;

  constructor(responses: Array<AttemptResult | 'reject'> = []) {
    this.responses = responses;
  }

  send(events: TrackerEvent[]): Promise<AttemptResult> {
    this.sent.push(events);
    const next = this.responses.length > 0 ? this.responses.shift() : OK;
    if (next === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve(next as AttemptResult);
  }
}

export const OK: AttemptResult = { ok: true, retryable: false, status: 202 };
export const SERVER_ERROR: AttemptResult = { ok: false, retryable: true, status: 503 };
export const UNAUTHORIZED: AttemptResult = { ok: false, retryable: false, status: 401 };

export function makeScope(overrides: Partial<EventScope> = {}): EventScope {
  return {
    apiKey: 'test-key',
    environment: 'staging',
    appVersion: '2.1.4',
    user: null,
    breadcrumbs: [],
    performance: emptyPerformance(),
    memory: emptyMemory(),
    device: {
      platform: 'js',
      os: 'Windows 11',
      os_version: '15.0.0',
      manufacturer: null,
      model: null,
      browser: 'Chrome',
      browser_version: '124.0',
      screen_width: 1920,
      screen_height: 1080,
      url: 'https://app.example.com/checkout',
      referrer: null,
      locale: 'en-IN',
    },
    ...overrides,
  };
}

/** Lets pending promise callbacks run (works with fake timers too). */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Mocked fetch that records request bodies and returns the given status. */
export function mockFetch(status = 202) {
  const calls: Array<{ url: string; init: RequestInit; body: { events: TrackerEvent[] } }> = [];
  const fn = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(null, { status }));
  });
  return { fn, calls };
}

/**
 * Key sets of the shared cross-platform schema. JS-only extensions are listed
 * separately so any accidental drift from the shared contract is visible.
 */
const SHARED_SCHEMA = {
  root: ['sdk', 'api_key', 'event_type', 'timestamp', 'environment', 'app_version', 'user', 'error', 'stacktrace', 'breadcrumbs', 'performance', 'memory', 'device', 'transaction'],
  sdk: ['name', 'version'],
  user: ['id', 'email', 'name'],
  error: ['message', 'type', 'handled'],
  frame: ['filename', 'lineno', 'colno', 'function'],
  breadcrumb: ['timestamp', 'type', 'message', 'data'],
  performance: ['page_load_ms', 'ttfb_ms', 'fcp_ms', 'lcp_ms', 'startup_ms', 'frame_rate_fps', 'slow_screen', 'api_calls', 'slow_api_calls'],
  apiCall: ['url', 'method', 'status', 'duration_ms'],
  memory: ['used_mb', 'total_mb', 'leak_suspected', 'oom_kill'],
  device: ['platform', 'os', 'os_version', 'manufacturer', 'model', 'browser', 'browser_version', 'screen_width', 'screen_height', 'url', 'locale'],
};
const JS_EXTENSIONS = { root: ['level', 'context'], performance: ['cls'], device: ['referrer'] };

function keys(obj: object): string[] {
  return Object.keys(obj).sort();
}

/** Asserts `event` has exactly the shared-schema keys (plus documented JS extensions) at every level. */
export function expectSchemaShape(event: TrackerEvent): void {
  expect(keys(event)).toEqual(SHARED_SCHEMA.root.concat(JS_EXTENSIONS.root).sort());
  expect(keys(event.sdk)).toEqual(SHARED_SCHEMA.sdk.slice().sort());
  expect(keys(event.user)).toEqual(SHARED_SCHEMA.user.slice().sort());
  if (event.error !== null) expect(keys(event.error)).toEqual(SHARED_SCHEMA.error.slice().sort());
  event.stacktrace.forEach((f) => expect(keys(f)).toEqual(SHARED_SCHEMA.frame.slice().sort()));
  event.breadcrumbs.forEach((b) => expect(keys(b)).toEqual(SHARED_SCHEMA.breadcrumb.slice().sort()));
  expect(keys(event.performance)).toEqual(SHARED_SCHEMA.performance.concat(JS_EXTENSIONS.performance).sort());
  event.performance.api_calls.forEach((c) => expect(keys(c)).toEqual(SHARED_SCHEMA.apiCall.slice().sort()));
  expect(keys(event.memory)).toEqual(SHARED_SCHEMA.memory.slice().sort());
  expect(keys(event.device)).toEqual(SHARED_SCHEMA.device.concat(JS_EXTENSIONS.device).sort());
}

