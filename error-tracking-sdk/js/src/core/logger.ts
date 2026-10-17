/**
 * Debug-only logger. Produces no output unless `debug: true` was configured.
 *
 * Every line starts with LOG_PREFIX; the breadcrumb collector's console hook
 * uses it to keep SDK diagnostics out of the breadcrumb trail.
 */

export const LOG_PREFIX = '[ErrorTracker]';

type ConsoleMethod = 'log' | 'warn' | 'error';

export class Logger {
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  info(message: string, ...details: unknown[]): void {
    this.write('log', message, details);
  }

  warn(message: string, ...details: unknown[]): void {
    this.write('warn', message, details);
  }

  error(message: string, ...details: unknown[]): void {
    this.write('error', message, details);
  }

  private write(method: ConsoleMethod, message: string, details: unknown[]): void {
    if (!this.enabled || typeof console === 'undefined') return;
    try {
      const fn = console[method];
      if (typeof fn === 'function') fn.apply(console, ([LOG_PREFIX + ' ' + message] as unknown[]).concat(details));
    } catch (_e) {
      // Console itself is broken; nothing sensible left to do.
    }
  }
}

/** Shared logger used before init() and by modules without a client reference. */
export const sharedLogger = new Logger(false);
