import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { SDK_VERSION } from '../src/constants';
import { buildEvent, EventInput, withField } from '../src/core/payloadBuilder';
import { normalize } from '../src/core/serialize';
import { expectSchemaShape, makeScope } from './helpers';

const ERROR_INPUT: EventInput = {
  eventType: 'error',
  level: 'error',
  error: { message: "Cannot read property 'price' of undefined", type: 'TypeError', handled: false },
  stacktrace: [{ filename: 'cart.js', lineno: 142, colno: 12, function: 'handlePayment' }],
  context: { orderId: 'ord_1' },
};
const TIMESTAMP = '2026-10-17T10:42:15.000Z';

describe('buildEvent', () => {
  it('reports the same SDK version as package.json', () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('produces every schema field, using null (never undefined) for unavailable values', () => {
    const event = buildEvent(ERROR_INPUT, makeScope(), TIMESTAMP);
    expectSchemaShape(event);

    // Round-trip through JSON: undefined values would silently disappear.
    const wire = JSON.parse(JSON.stringify(event));
    expect(wire).toEqual(event);
    expect(wire.performance.startup_ms).toBeNull();
    expect(wire.performance.frame_rate_fps).toBeNull();
    expect(wire.memory.oom_kill).toBeNull();
    expect(wire.device.manufacturer).toBeNull();
  });

  it('maps input and scope to the expected values', () => {
    const scope = makeScope({
      user: { id: 'usr_8821', email: 'a@b.test' },
      breadcrumbs: [{ timestamp: TIMESTAMP, type: 'click', message: 'Clicked Pay Now', data: {} }],
    });
    const event = buildEvent(ERROR_INPUT, scope, TIMESTAMP);

    expect(event).toMatchObject({
      sdk: { name: 'error-tracker-js', version: pkg.version },
      api_key: 'test-key',
      event_type: 'error',
      level: 'error',
      timestamp: TIMESTAMP,
      environment: 'staging',
      app_version: '2.1.4',
      user: { id: 'usr_8821', email: 'a@b.test', name: null },
      error: { message: "Cannot read property 'price' of undefined", type: 'TypeError', handled: false },
      stacktrace: [{ filename: 'cart.js', lineno: 142, colno: 12, function: 'handlePayment' }],
      context: { orderId: 'ord_1' },
      device: { platform: 'js' },
    });
    expect(event.breadcrumbs).toHaveLength(1);
  });

  it('emits an all-null user when none is set', () => {
    expect(buildEvent(ERROR_INPUT, makeScope(), TIMESTAMP).user).toEqual({ id: null, email: null, name: null });
  });

  it('supports message and performance events with the same shape', () => {
    const message = buildEvent({ ...ERROR_INPUT, eventType: 'message', level: 'info', stacktrace: [], context: null }, makeScope(), TIMESTAMP);
    expectSchemaShape(message);
    expect(message.event_type).toBe('message');

    const perf = buildEvent({ eventType: 'performance', level: 'warning', error: null, stacktrace: [], context: null }, makeScope(), TIMESTAMP);
    expectSchemaShape(perf);
    expect(perf.error).toBeNull();
  });

  it('copies scope arrays so later mutation cannot change a queued event', () => {
    const scope = makeScope();
    const event = buildEvent(ERROR_INPUT, scope, TIMESTAMP);
    scope.breadcrumbs.push({ timestamp: TIMESTAMP, type: 'log', message: 'later', data: {} });
    scope.performance.api_calls.push({ _id: 'c1', url: '/x', method: 'GET', status: 200, duration_ms: 1 });
    expect(event.breadcrumbs).toHaveLength(0);
    expect(event.performance.api_calls).toHaveLength(0);
  });

  it('withField returns a modified copy and leaves the original untouched', () => {
    const event = buildEvent(ERROR_INPUT, makeScope(), TIMESTAMP);
    const redacted = withField(event, 'api_key', '');
    expect(redacted.api_key).toBe('');
    expect(event.api_key).toBe('test-key');
  });
});

describe('normalize', () => {
  it('makes arbitrary context JSON-safe', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    const result = normalize({
      circular,
      fn: function handler() {},
      date: new Date('2026-01-01T00:00:00Z'),
      err: new TypeError('bad'),
      nan: NaN,
      nested: { a: { b: { c: { d: { e: { f: 1 } } } } } },
      node: document.createElement('div'),
      skipped: undefined,
    });
    expect(result).toEqual({
      circular: { name: 'x', self: '[Circular]' },
      fn: '[Function handler]',
      date: '2026-01-01T00:00:00.000Z',
      err: { name: 'TypeError', message: 'bad' },
      nan: 'NaN',
      nested: { a: { b: { c: { d: '[MaxDepth]' } } } },
      node: '[DIV]',
    });
  });
});
