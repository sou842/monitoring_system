import { Logger } from './logger';

/**
 * Runs `fn` and converts any exception into a debug warning plus `fallback`.
 * This is the SDK's main guarantee that it never throws into the host app.
 */
export function safely<T>(logger: Logger, label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    logger.warn(label + ' failed', e);
    return fallback;
  }
}

/** `safely` for functions with no meaningful return value. */
export function safelyRun(logger: Logger, label: string, fn: () => void): void {
  safely<void>(logger, label, fn, undefined);
}

/** Wraps a callback so exceptions inside it are swallowed (with a debug log). */
export function guard<A extends unknown[]>(
  logger: Logger,
  label: string,
  fn: (...args: A) => void,
): (...args: A) => void {
  return function guarded(...args: A): void {
    safelyRun(logger, label, function run() {
      fn.apply(null, args);
    });
  };
}
