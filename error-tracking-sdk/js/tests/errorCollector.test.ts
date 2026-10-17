import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureFromThrown, ErrorCollector } from '../src/collectors/errorCollector';
import { Logger } from '../src/core/logger';
import { RecordingSink } from './helpers';

function dispatchRejection(reason: unknown): void {
  // jsdom has no PromiseRejectionEvent constructor; build an equivalent event.
  const event = new Event('unhandledrejection') as Event & { reason: unknown; promise: Promise<unknown> };
  Object.defineProperty(event, 'reason', { value: reason });
  window.dispatchEvent(event);
}

describe('captureFromThrown', () => {
  it('extracts message, type and stack from an Error', () => {
    const captured = captureFromThrown(new TypeError("Cannot read properties of undefined (reading 'price')"), true);
    expect(captured.error).toEqual({
      message: "Cannot read properties of undefined (reading 'price')",
      type: 'TypeError',
      handled: true,
    });
    expect(captured.stacktrace.length).toBeGreaterThan(0);
  });

  it('uses the subclass name for custom errors', () => {
    class PaymentError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'PaymentError';
      }
    }
    expect(captureFromThrown(new PaymentError('declined'), true).error.type).toBe('PaymentError');
  });

  it('handles non-Error thrown values', () => {
    expect(captureFromThrown('plain string', false).error).toEqual({ message: 'plain string', type: 'Error', handled: false });
    expect(captureFromThrown({ code: 42 }, false).error.message).toBe('{"code":42}');
    expect(captureFromThrown(null, false).error.message).toBe('null');
    expect(captureFromThrown(undefined, false, 'UnhandledRejection').error.type).toBe('UnhandledRejection');
  });

  it('survives circular objects', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(captureFromThrown(circular, false).error.message).toContain('[Circular]');
  });
});

describe('ErrorCollector', () => {
  let sink: RecordingSink;
  let collector: ErrorCollector;

  beforeEach(() => {
    sink = new RecordingSink();
    collector = new ErrorCollector(sink, new Logger(false));
    collector.install();
  });

  afterEach(() => {
    collector.uninstall();
  });

  it('captures uncaught errors as unhandled', () => {
    const error = new TypeError('x is not a function');
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message, filename: 'app.js', lineno: 1, colno: 2 }));

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0].error).toEqual({ message: 'x is not a function', type: 'TypeError', handled: false });
    expect(sink.errors[0].stacktrace.length).toBeGreaterThan(0);
  });

  it('labels cross-origin "Script error." and builds a frame from the event location', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.', filename: 'https://cdn.test/lib.js', lineno: 10, colno: 4 }));
    expect(sink.errors[0].error).toEqual({ message: 'Script error.', type: 'CrossOriginScriptError', handled: false });
    expect(sink.errors[0].context).toEqual({ hint: expect.stringContaining('crossorigin="anonymous"') });
    expect(sink.errors[0].stacktrace).toEqual([
      { filename: 'https://cdn.test/lib.js', lineno: 10, colno: 4, function: '<anonymous>' },
    ]);
  });

  it('captures unhandled promise rejections with an Error reason', () => {
    dispatchRejection(new RangeError('out of range'));
    expect(sink.errors[0].error).toEqual({ message: 'out of range', type: 'RangeError', handled: false });
  });

  it('captures unhandled promise rejections with a non-Error reason', () => {
    dispatchRejection('timeout');
    expect(sink.errors[0].error).toEqual({ message: 'timeout', type: 'UnhandledRejection', handled: false });
  });

  it('captures failed resource loads without query strings', () => {
    const img = document.createElement('img');
    img.setAttribute('src', '/missing.png?token=secret');
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));
    img.remove();

    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0].error).toEqual({ message: 'Failed to load <img> /missing.png', type: 'ResourceError', handled: false });
  });

  it('skips failed <link rel="preload"> hints (the element using the file reports it)', () => {
    const link = document.createElement('link');
    link.setAttribute('rel', 'preload');
    link.setAttribute('href', '/hero.png');
    document.head.appendChild(link);
    link.dispatchEvent(new Event('error'));
    link.remove();
    expect(sink.errors).toHaveLength(0);
  });

  it('stops capturing after uninstall', () => {
    collector.uninstall();
    // Stop the test runner treating the synthetic event as a real uncaught error.
    const swallow = (e: Event): void => e.preventDefault();
    window.addEventListener('error', swallow);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('late'), message: 'late', cancelable: true }));
    window.removeEventListener('error', swallow);
    expect(sink.errors).toHaveLength(0);
  });

  it('never lets a failing sink throw into the page', () => {
    collector.uninstall();
    const throwingSink = new RecordingSink();
    throwingSink.onError = () => {
      throw new Error('sink failure');
    };
    const guarded = new ErrorCollector(throwingSink, new Logger(false));
    guarded.install();
    expect(() => window.dispatchEvent(new ErrorEvent('error', { error: new Error('x'), message: 'x' }))).not.toThrow();
    guarded.uninstall();
  });
});
