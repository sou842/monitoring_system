/**
 * Error Tracker JS SDK — public API.
 *
 * Every method is safe to call at any time: before `init()` calls are
 * buffered and replayed once the SDK starts, and no method ever throws into
 * the host application.
 */
import { MAX_PRE_INIT_CALLS, SDK_VERSION } from './constants';
import { Client } from './core/client';
import { resolveConfig } from './core/config';
import { sharedLogger } from './core/logger';
import { safely, safelyRun } from './core/safe';
import { BreadcrumbInput, ErrorTrackerConfig, EventLevel, TrackedUser } from './types';

type PendingCall = (client: Client) => void;

let client: Client | null = null;
let pending: PendingCall[] = [];

/** Runs `call` now if initialized, otherwise buffers it until `init()`. */
function withClient(label: string, call: PendingCall): void {
  safelyRun(client !== null ? client.logger : sharedLogger, label, function dispatch() {
    if (client !== null) {
      call(client);
      return;
    }
    if (pending.length >= MAX_PRE_INIT_CALLS) {
      sharedLogger.warn(label + ' called before init(); pre-init buffer full, dropping call');
      return;
    }
    pending.push(call);
  });
}

/**
 * Starts the SDK: validates config, installs collectors and begins delivering
 * events. Calling it again while running is ignored; call `close()` first to
 * re-initialize. An invalid config leaves the SDK disabled (and logs a warning
 * when `debug` is true) rather than throwing.
 */
function init(config: ErrorTrackerConfig): void {
  safelyRun(sharedLogger, 'init', function start() {
    sharedLogger.setEnabled(config !== null && typeof config === 'object' && config.debug === true);
    if (client !== null) {
      sharedLogger.warn('init() called more than once; ignoring');
      return;
    }
    const resolved = resolveConfig(config);
    if (!resolved.ok) {
      sharedLogger.warn('invalid config: ' + resolved.reason + '; SDK disabled');
      return;
    }

    const created = new Client(resolved.config);
    created.start();
    client = created;

    const replay = pending;
    pending = [];
    for (let i = 0; i < replay.length; i++) {
      const call = replay[i];
      safelyRun(created.logger, 'replay pre-init call', function run() {
        call(created);
      });
    }
  });
}

/**
 * Reports a caught error. `handled` is `true` on the resulting event.
 * @param error The thrown value; non-Error values are converted to a message.
 * @param context Extra JSON-serializable data attached as `context`.
 */
function captureError(error: unknown, context?: Record<string, unknown>): void {
  withClient('captureError', function run(c) {
    c.captureError(error, context);
  });
}

/**
 * Reports a free-form message.
 * @param message Text of the message.
 * @param level Severity; defaults to `'info'`.
 */
function captureMessage(message: string, level: EventLevel = 'info'): void {
  withClient('captureMessage', function run(c) {
    c.captureMessage(message, level);
  });
}

/**
 * Reports that a page does not exist, as a `PageNotFound` event. Call it from
 * your router's "not found" page (Next.js `app/not-found.js`, a React Router
 * `path="*"` route, …) so client-side route misses are tracked too. On a page
 * the SDK already detected as a 404, the duplicate is dropped.
 * @param url The missing URL; defaults to the current page.
 */
function capturePageNotFound(url?: string): void {
  withClient('capturePageNotFound', function run(c) {
    c.capturePageNotFound(url);
  });
}

/**
 * Attaches a user to all subsequent events. Pass `null` to clear it (e.g. on logout).
 */
function setUser(user: TrackedUser | null): void {
  withClient('setUser', function run(c) {
    c.setUser(user);
  });
}

/**
 * Names the screen the app is showing; every later event carries it in
 * `screen`. Use it when screens change without the URL changing (Appzillon,
 * tab or wizard UIs, apps on one URL). A new screen also starts a new page
 * view, so the Performance view shows each screen separately. Pass `null` to
 * clear it. Calling it again with the current screen does nothing.
 * @param name Screen name, e.g. `'LoanApproval'`; trimmed, and cut to 200 characters.
 */
function setScreen(name: string | null): void {
  withClient('setScreen', function run(c) {
    c.setScreen(name);
  });
}

/**
 * Records a custom breadcrumb in the trail attached to future events.
 */
function addBreadcrumb(breadcrumb: BreadcrumbInput): void {
  withClient('addBreadcrumb', function run(c) {
    c.onBreadcrumb(breadcrumb);
  });
}

/**
 * Sends queued events immediately. Resolves when the queue is drained or
 * parked offline; never rejects. Resolves immediately before `init()`.
 */
function flush(): Promise<void> {
  return safely(sharedLogger, 'flush', function run() {
    return client !== null ? client.flush() : Promise.resolve();
  }, Promise.resolve());
}

/**
 * Flushes, then removes every hook the SDK installed (global handlers, fetch/XHR,
 * history, console). Unsent events are persisted for the next session.
 */
function close(): Promise<void> {
  return safely(sharedLogger, 'close', function run() {
    const current = client;
    client = null;
    pending = [];
    return current !== null ? current.close() : Promise.resolve();
  }, Promise.resolve());
}

/** Whether `init()` has completed successfully. */
function isInitialized(): boolean {
  return client !== null;
}

/** The SDK's public surface. */
export const ErrorTracker = {
  init: init,
  captureError: captureError,
  captureMessage: captureMessage,
  capturePageNotFound: capturePageNotFound,
  setUser: setUser,
  setScreen: setScreen,
  addBreadcrumb: addBreadcrumb,
  flush: flush,
  close: close,
  isInitialized: isInitialized,
  version: SDK_VERSION,
};

export { init, captureError, captureMessage, capturePageNotFound, setUser, setScreen, addBreadcrumb, flush, close, isInitialized };
export default ErrorTracker;

export type {
  ApiCall,
  Breadcrumb,
  BreadcrumbInput,
  BreadcrumbType,
  DevicePayload,
  ErrorPayload,
  ErrorTrackerConfig,
  EventBatch,
  EventLevel,
  EventType,
  JsonObject,
  JsonValue,
  MemoryPayload,
  PerformancePayload,
  Span,
  StackFrame,
  TrackedUser,
  TrackerEvent,
  TransactionPayload,
  TransactionVitals,
  UserPayload,
} from './types';
