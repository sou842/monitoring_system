import {
  MASKED_TEXT,
  MAX_CLICK_TEXT_LENGTH,
  MAX_CSS_PATH_DEPTH,
  MAX_MESSAGE_LENGTH,
} from '../constants';
import { getDocument, getWindow, stripQuery } from '../core/env';
import { LOG_PREFIX, Logger } from '../core/logger';
import { guard, safelyRun } from '../core/safe';
import { describeValue, truncate } from '../core/serialize';
import { ApiCall } from '../types';
import { Collector, CollectorSink } from './collector';
import { NetworkInterceptor } from './networkInterceptor';

type ConsoleLevel = 'warn' | 'error';
type ConsoleFn = (...args: unknown[]) => void;
type HistoryFn = History['pushState'];

const CONSOLE_LEVELS: ConsoleLevel[] = ['warn', 'error'];
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [onclick]';
const FORM_FIELD_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

/** Returns true if `el` or an ancestor matches any selector. Invalid selectors are ignored. */
export function isMasked(el: Element, selectors: readonly string[]): boolean {
  for (let i = 0; i < selectors.length; i++) {
    try {
      if (el.closest(selectors[i]) !== null) return true;
    } catch (_e) {
      // Invalid selector supplied by the host app; skip it.
    }
  }
  return false;
}

/** Short CSS path such as `form#checkout > div.actions > button.primary`. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current !== null && parts.length < MAX_CSS_PATH_DEPTH) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(part + '#' + current.id);
      break;
    }
    const className = typeof current.className === 'string' ? current.className.trim() : '';
    if (className.length > 0) part += '.' + className.split(/\s+/).slice(0, 2).join('.');
    parts.unshift(part);
    if (current.tagName === 'BODY') break;
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/** Human-readable label for a clicked element, never exposing form values or masked text. */
export function describeElementText(el: Element, maskSelectors: readonly string[]): string {
  if (isMasked(el, maskSelectors)) return MASKED_TEXT;
  if (FORM_FIELD_TAGS.indexOf(el.tagName) !== -1) {
    return truncate(el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('type') || '', MAX_CLICK_TEXT_LENGTH);
  }
  const label = el.getAttribute('aria-label');
  if (label !== null && label.length > 0) return truncate(label, MAX_CLICK_TEXT_LENGTH);
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return truncate(text, MAX_CLICK_TEXT_LENGTH);
}

/**
 * Records clicks, navigations, page visibility changes, console warnings and
 * errors, and network requests as breadcrumbs.
 */
export class BreadcrumbCollector implements Collector {
  private installed = false;
  private lastUrl: string | null = null;
  private originalPushState: HistoryFn | null = null;
  private originalReplaceState: HistoryFn | null = null;
  private originalConsole: Partial<Record<ConsoleLevel, ConsoleFn>> = {};
  private inConsoleHook = false;

  private readonly handleClick: (event: MouseEvent) => void;
  private readonly handlePopState: () => void;
  private readonly handleVisibility: () => void;

  constructor(
    private readonly sink: CollectorSink,
    private readonly network: NetworkInterceptor,
    private readonly maskSelectors: readonly string[],
    private readonly logger: Logger,
  ) {
    const self = this;
    this.handleClick = guard(logger, 'click breadcrumb', function onClick(event: MouseEvent) {
      self.recordClick(event);
    });
    this.handlePopState = guard(logger, 'navigation breadcrumb', function onPop() {
      self.recordNavigation('popstate');
    });
    this.handleVisibility = guard(logger, 'lifecycle breadcrumb', function onVisibility() {
      const doc = getDocument();
      if (doc !== null) self.sink.onBreadcrumb({ type: 'lifecycle', message: 'Page ' + doc.visibilityState });
    });
  }

  install(): void {
    const win = getWindow();
    const doc = getDocument();
    if (this.installed || win === null || doc === null) return;
    this.installed = true;
    this.lastUrl = stripQuery(win.location.href);

    doc.addEventListener('click', this.handleClick, true);
    doc.addEventListener('visibilitychange', this.handleVisibility);
    win.addEventListener('popstate', this.handlePopState);
    safelyRun(this.logger, 'history instrumentation', () => this.wrapHistory(win));
    safelyRun(this.logger, 'console instrumentation', () => this.wrapConsole());

    const self = this;
    this.network.subscribe(function onApiCall(call: ApiCall) {
      self.sink.onBreadcrumb({
        type: 'api',
        message: call.method + ' ' + call.url + ' → ' + (call.status === 0 ? 'network error' : String(call.status)),
        data: { url: call.url, method: call.method, status: call.status, duration_ms: call.duration_ms },
      });
    });
  }

  uninstall(): void {
    const win = getWindow();
    const doc = getDocument();
    if (!this.installed || win === null || doc === null) return;

    doc.removeEventListener('click', this.handleClick, true);
    doc.removeEventListener('visibilitychange', this.handleVisibility);
    win.removeEventListener('popstate', this.handlePopState);
    if (this.originalPushState !== null) win.history.pushState = this.originalPushState;
    if (this.originalReplaceState !== null) win.history.replaceState = this.originalReplaceState;
    for (let i = 0; i < CONSOLE_LEVELS.length; i++) {
      const original = this.originalConsole[CONSOLE_LEVELS[i]];
      if (original !== undefined) console[CONSOLE_LEVELS[i]] = original;
    }
    this.originalPushState = null;
    this.originalReplaceState = null;
    this.originalConsole = {};
    this.installed = false;
  }

  private recordClick(event: MouseEvent): void {
    const target = event.target;
    if (target === null || typeof Element === 'undefined' || !(target instanceof Element)) return;
    const el = target.closest(INTERACTIVE_SELECTOR) || target;
    const text = describeElementText(el, this.maskSelectors);
    const tag = el.tagName.toLowerCase();
    this.sink.onBreadcrumb({
      type: 'click',
      message: 'Clicked ' + (text.length > 0 ? text : tag),
      data: { tag: tag, text: text, selector: cssPath(el) },
    });
  }

  private recordNavigation(trigger: string): void {
    const win = getWindow();
    if (win === null) return;
    const to = stripQuery(win.location.href);
    if (to === this.lastUrl) return;
    const from = this.lastUrl;
    this.lastUrl = to;
    this.sink.onBreadcrumb({ type: 'navigation', message: 'Navigated to ' + to, data: { from: from, to: to, trigger: trigger } });
    this.sink.onNavigation();
  }

  private wrapHistory(win: Window): void {
    const history = win.history;
    const self = this;
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    this.originalPushState = originalPush;
    this.originalReplaceState = originalReplace;

    history.pushState = function trackedPushState(this: History, data: unknown, unused: string, url?: string | URL | null) {
      const result = originalPush.call(this, data, unused, url);
      safelyRun(self.logger, 'pushState breadcrumb', function record() {
        self.recordNavigation('pushState');
      });
      return result;
    };
    history.replaceState = function trackedReplaceState(this: History, data: unknown, unused: string, url?: string | URL | null) {
      const result = originalReplace.call(this, data, unused, url);
      safelyRun(self.logger, 'replaceState breadcrumb', function record() {
        self.recordNavigation('replaceState');
      });
      return result;
    };
  }

  private wrapConsole(): void {
    if (typeof console === 'undefined') return;
    const self = this;

    CONSOLE_LEVELS.forEach(function wrap(level) {
      const original = console[level] as ConsoleFn | undefined;
      if (typeof original !== 'function') return;
      self.originalConsole[level] = original;

      console[level] = function trackedConsole(...args: unknown[]) {
        const isSdkLog = typeof args[0] === 'string' && args[0].indexOf(LOG_PREFIX) === 0;
        // Re-entrancy guard: a breadcrumb sink that logs must not loop forever.
        if (!self.inConsoleHook && !isSdkLog) {
          self.inConsoleHook = true;
          safelyRun(self.logger, 'console breadcrumb', function record() {
            const message = args.map(describeValue).join(' ');
            self.sink.onBreadcrumb({
              type: 'log',
              message: truncate(message, MAX_MESSAGE_LENGTH),
              data: { level: level },
            });
          });
          self.inConsoleHook = false;
        }
        original.apply(console, args);
      };
    });
  }
}
