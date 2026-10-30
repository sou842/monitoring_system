import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Loads .env.local (if present) without overriding variables already set. */
export function loadEnv(): void {
  const path = new URL('../.env.local', import.meta.url);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

/** Points the app at a fresh, uniquely named database so tests never touch real data. */
export function useTestDatabase(): string {
  loadEnv();
  const name = `monitor_test_${randomBytes(4).toString('hex')}`;
  process.env.MONGODB_DB = name;
  return name;
}

export function hasDatabase(): boolean {
  loadEnv();
  return Boolean(process.env.MONGODB_URI);
}

/** A raw event as an SDK would send it (any field may be overridden, even with nonsense). */
export type RawEvent = Record<string, unknown>;

/** A valid shared-schema event, with overrides. */
export function sampleEvent(overrides: RawEvent = {}): RawEvent {
  return {
    sdk: { name: 'error-tracker-js', version: '0.2.0' },
    api_key: '',
    event_type: 'error',
    level: 'error',
    timestamp: new Date().toISOString(),
    environment: 'production',
    app_version: '2.1.4',
    user: { id: 'usr_1', email: null, name: null },
    error: { message: "Cannot read properties of undefined (reading 'price')", type: 'TypeError', handled: false },
    stacktrace: [{ filename: 'https://shop.test/static/cart-3f9a1b2c4d.js', lineno: 142, colno: 12, function: 'handlePayment' }],
    breadcrumbs: [{ timestamp: new Date().toISOString(), type: 'click', message: 'Clicked Pay Now', data: {} }],
    performance: { page_load_ms: 1200, ttfb_ms: 100, fcp_ms: 300, lcp_ms: 500, startup_ms: null, frame_rate_fps: 60, slow_screen: false, api_calls: [], slow_api_calls: [] },
    memory: { used_mb: 40, total_mb: 80, leak_suspected: false, oom_kill: null },
    device: { platform: 'js', os: 'Windows 11', os_version: '15.0', manufacturer: null, model: null, browser: 'Chrome', browser_version: '124.0', screen_width: 1920, screen_height: 1080, url: 'https://shop.test/checkout', locale: 'en-IN' },
    context: null,
    ...overrides,
  };
}

/** A valid page-view (transaction) event, with overrides for its `transaction` block. */
export function samplePageView(transaction: RawEvent = {}, overrides: RawEvent = {}): RawEvent {
  return sampleEvent({
    event_type: 'transaction',
    level: 'info',
    error: null,
    stacktrace: [],
    breadcrumbs: [],
    transaction: {
      name: '/ai/vault/6ad200e254521077e9b11bb2',
      kind: 'pageload',
      start: new Date().toISOString(),
      duration_ms: 5000,
      background: false,
      vitals: { ttfb_ms: 120, fcp_ms: 800, lcp_ms: 1400, cls: 0.05, inp_ms: 96, page_load_ms: 1900 },
      long_tasks: { count: 2, blocking_ms: 80 },
      spans: [
        { _id: '4b1e09c7d2a35f80', op: 'http', method: 'get', url: 'https://app.test/api/vault/6ad200e254521077e9b11bb2', status: 200, failure: null, start_ms: 100, duration_ms: 600, server_ms: 500, download_ms: 80, size_bytes: 2048, background: false },
        { op: 'http', method: 'GET', url: 'https://app.test/api/vault/9f31aa00bb22cc33dd44ee55', status: 500, failure: null, start_ms: 900, duration_ms: 300, server_ms: null, download_ms: null, size_bytes: null, background: false },
        { op: 'http', method: 'GET', url: 'https://app.test/api/session', status: 200, failure: null, start_ms: 1000, duration_ms: 9000, server_ms: null, download_ms: null, size_bytes: null, background: true },
      ],
      dropped_spans: 0,
      ...transaction,
    },
    ...overrides,
  });
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A Request for a handler, as the browser or an SDK would send it. */
export function request(path: string, { method = 'GET', body, headers = {} }: RequestOptions = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Asserts a validation result is ok and returns the cleaned event. */
export function validOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}
