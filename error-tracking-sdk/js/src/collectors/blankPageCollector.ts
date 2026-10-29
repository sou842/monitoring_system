import {
  BLANK_PAGE_CAUSE_WINDOW_MS,
  BLANK_PAGE_CONFIRM_MS,
  BLANK_PAGE_GRID_STEPS,
  BLANK_PAGE_MAX_ANCESTORS,
  BLANK_PAGE_MAX_CANDIDATES,
  BLANK_PAGE_MAX_COVERED_ELEMENTS,
  BLANK_PAGE_MAX_NODES_SCANNED,
  BLANK_PAGE_MAX_REPORTS,
  BLANK_PAGE_MAX_SHADOW_DEPTH,
  BLANK_PAGE_MIN_CONTENT_PX,
  BLANK_PAGE_MAX_SIGNALS,
  BLANK_PAGE_MAX_WAIT_MS,
  BLANK_PAGE_PENDING_MAX_MS,
  BLANK_PAGE_QUIET_MS,
  BLANK_PAGE_SESSION_STATUSES,
  HTTP_ERROR_STATUS_MIN,
  MAX_MESSAGE_LENGTH,
} from '../constants';
import { getDocument, getWindow, isPageVisible, nowMs, stripQuery } from '../core/env';
import { Logger } from '../core/logger';
import { guard, safely, safelyRun } from '../core/safe';
import { truncate } from '../core/serialize';
import { ApiCall, ErrorPayload, JsonObject } from '../types';
import { Collector } from './collector';
import { NetworkInterceptor, RequestDetails } from './networkInterceptor';
import { readDocumentStatus } from './pageNotFoundCollector';

/** What made the SDK look at the page. */
export type BlankPageTrigger = 'load' | 'dom_change' | 'screen_change' | 'navigation' | 'error';

/** The most likely reason the page is blank, picked from what happened just before. */
export type BlankPageCause =
  | 'page_http_error'
  | 'resource_failed'
  | 'code_load_failed'
  | 'csp_blocked'
  | 'js_error'
  | 'session_expired'
  | 'api_failed'
  | 'api_pending'
  | 'main_thread_blocked'
  | 'covered_by_overlay'
  | 'nothing_rendered';

/** Event message per cause. Fixed text, so the backend groups one issue per cause. */
const CAUSE_MESSAGES: { [cause in BlankPageCause]: string } = {
  page_http_error: 'Blank page: the page itself failed to load',
  resource_failed: 'Blank page: a script or stylesheet failed to load',
  code_load_failed: 'Blank page: app code failed to load',
  csp_blocked: 'Blank page: content blocked by Content Security Policy',
  js_error: 'Blank page after a JavaScript error',
  session_expired: 'Blank page after the session expired',
  api_failed: 'Blank page after an API call failed',
  api_pending: 'Blank page while waiting for an API call',
  main_thread_blocked: 'Blank page while the main thread was blocked',
  covered_by_overlay: 'Blank page: content covered by an empty overlay',
  nothing_rendered: 'Blank page: nothing rendered and no error',
};

/** A higher number wins when several triggers arrive before one check. */
const TRIGGER_PRIORITY: { [trigger in BlankPageTrigger]: number } = {
  dom_change: 0,
  load: 1,
  navigation: 2,
  screen_change: 3,
  error: 4,
};

/** Lazily loaded code that failed: webpack/Vite/Next chunks and dynamic `import()`. */
const CODE_LOAD_ERROR = /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i;
/** ResourceError messages for elements whose failure can leave the page empty. */
const CODE_RESOURCE = /^Failed to load <(script|link)>/;
const CODE_RESOURCE_KINDS = ['script', 'link', 'css'];
/** Elements that show something by themselves, with or without text. */
const CONTENT_TAGS = ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OBJECT', 'EMBED', 'PICTURE'];
const TEXT_NODE = 3;

/** What the sampled points of the viewport showed. */
export interface BlankPageSample {
  /** False when the browser can't tell what is drawn (no `elementsFromPoint`, zero-size viewport). */
  supported: boolean;
  /** Every sampled point shows no content. */
  blank: boolean;
  points: number;
  /** Points where an opaque element without content sits on top. */
  covered: number;
  /** Covered points with real content underneath (an overlay hiding the page). */
  coveredContent: number;
  /** Content elements in the viewport checked at their own position. */
  elementsChecked: number;
  /** An element the user sees; checked first next time, so a page that keeps its content costs one hit test. */
  seen: Element | null;
}

const UNSUPPORTED: BlankPageSample = {
  supported: false,
  blank: false,
  points: 0,
  covered: 0,
  coveredContent: 0,
  elementsChecked: 0,
  seen: null,
};
/** Text inside these is never drawn. */
const NON_VISUAL_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE'];
/** `NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT`. */
const SHOW_ELEMENTS_AND_TEXT = 0x1 | 0x4;

type PointResult = 'content' | 'empty' | 'covered' | 'covered_content';

function isTransparent(color: string): boolean {
  if (color === '' || color === 'transparent') return true;
  const match = /rgba?\(([^)]*)\)/.exec(color);
  if (match === null) return false;
  const parts = match[1].split(/[\s,/]+/).filter(function nonEmpty(part) {
    return part.length > 0;
  });
  return parts.length >= 4 && parseFloat(parts[3]) === 0;
}

function hasOwnText(el: Element): boolean {
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === TEXT_NODE && node.nodeValue !== null && /\S/.test(node.nodeValue)) return true;
  }
  return false;
}

function hasContent(el: Element, style: CSSStyleDeclaration): boolean {
  if (CONTENT_TAGS.indexOf(el.tagName.toUpperCase()) !== -1) return true;
  // Shapes inside an inline <svg> (path, circle, …).
  if ((el as SVGElement).ownerSVGElement) return true;
  if (style.backgroundImage !== '' && style.backgroundImage !== 'none') return true;
  return hasOwnText(el);
}

/** True when the element or an ancestor has `opacity: 0` (e.g. a fade-in that never ran). */
function hiddenByOpacity(el: Element, win: Window): boolean {
  let node: Element | null = el;
  for (let depth = 0; node !== null && depth < BLANK_PAGE_MAX_ANCESTORS; depth++) {
    if (win.getComputedStyle(node).opacity === '0') return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Content drawn inside an open shadow root (web components such as Ionic's):
 * the document only reports the host element at that point.
 */
function hasShadowContent(host: Element, win: Window, x: number, y: number, depth: number): boolean {
  const root = host.shadowRoot;
  if (root === null || typeof root.elementsFromPoint !== 'function' || depth >= BLANK_PAGE_MAX_SHADOW_DEPTH) return false;
  const stack = root.elementsFromPoint(x, y);
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (el === host) break;
    if (hasContent(el, win.getComputedStyle(el)) || hasShadowContent(el, win, x, y, depth + 1)) return true;
  }
  return false;
}

/**
 * Looks through the stack of elements drawn at one point, top first. Content
 * on top means the user sees something there. An opaque element without
 * content hides everything under it; the walk goes on only to learn whether
 * it is hiding real content (an overlay) or nothing.
 */
function checkPoint(doc: Document, win: Window, x: number, y: number, found?: { el: Element | null }): PointResult {
  const stack = doc.elementsFromPoint(x, y);
  let covered = false;
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (el === doc.documentElement || el === doc.body) break;
    const style = win.getComputedStyle(el);
    if ((hasContent(el, style) || hasShadowContent(el, win, x, y, 0)) && !hiddenByOpacity(el, win)) {
      if (found !== undefined) found.el = el;
      return covered ? 'covered_content' : 'content';
    }
    if (!covered && style.opacity !== '0' && !isTransparent(style.backgroundColor)) covered = true;
  }
  return covered ? 'covered' : 'empty';
}

type ElementCheck = 'seen' | 'covered' | 'skip';

/**
 * Whether the user sees `el`: it must be at least BLANK_PAGE_MIN_CONTENT_PX
 * on both sides (not 1×1 screen-reader-only text) and inside the viewport, and
 * nothing opaque may cover its centre. Hit-testing skips `pointer-events:
 * none` and `visibility: hidden`, so when the point shows no content those
 * are checked on the element itself.
 */
function checkElement(doc: Document, win: Window, el: Element, width: number, height: number, sample: BlankPageSample): ElementCheck {
  const rect = el.getBoundingClientRect();
  if (!(rect.width >= BLANK_PAGE_MIN_CONTENT_PX && rect.height >= BLANK_PAGE_MIN_CONTENT_PX)) return 'skip';
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) return 'skip';
  sample.elementsChecked++;
  const x = Math.min(width - 1, Math.max(0, rect.left + rect.width / 2));
  const y = Math.min(height - 1, Math.max(0, rect.top + rect.height / 2));
  const result = checkPoint(doc, win, x, y);
  if (result === 'content') return 'seen';
  if (result === 'covered_content') return 'covered';
  if (win.getComputedStyle(el).visibility !== 'visible' || hiddenByOpacity(el, win)) return 'skip';
  return result === 'empty' ? 'seen' : 'covered';
}

/**
 * The content elements in the viewport, in document order (text, images,
 * inputs, …). The first one the user sees ends the search. Content under
 * something opaque counts towards `coveredContent` (an overlay hiding the page).
 */
function checkContentElements(doc: Document, win: Window, width: number, height: number, sample: BlankPageSample): void {
  const walker = doc.createTreeWalker(doc.body, SHOW_ELEMENTS_AND_TEXT);
  let scanned = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (++scanned > BLANK_PAGE_MAX_NODES_SCANNED || sample.elementsChecked >= BLANK_PAGE_MAX_CANDIDATES) return;
    // Enough to know an overlay hides the page; the grid still finds content placed on top of it (a dialog).
    if (sample.coveredContent >= BLANK_PAGE_MAX_COVERED_ELEMENTS) return;
    let el: Element | null = null;
    if (node.nodeType === TEXT_NODE) {
      if (node.nodeValue !== null && /\S/.test(node.nodeValue)) el = node.parentElement;
    } else if (CONTENT_TAGS.indexOf((node as Element).tagName.toUpperCase()) !== -1) {
      el = node as Element;
    }
    if (el === null || NON_VISUAL_TAGS.indexOf(el.tagName.toUpperCase()) !== -1) continue;
    const check = checkElement(doc, win, el, width, height, sample);
    if (check === 'seen') {
      sample.blank = false;
      sample.seen = el;
      return;
    }
    if (check === 'covered') sample.coveredContent++;
  }
}

/**
 * Points on the two centre lines of the viewport. Finds what the element scan
 * can't: background images and content inside shadow roots.
 */
function checkGrid(doc: Document, win: Window, width: number, height: number, sample: BlankPageSample): void {
  const middle = BLANK_PAGE_GRID_STEPS / 2;
  const found: { el: Element | null } = { el: null };
  for (let i = 1; i < BLANK_PAGE_GRID_STEPS; i++) {
    const results: PointResult[] = [checkPoint(doc, win, (width * i) / BLANK_PAGE_GRID_STEPS, height / 2, found)];
    // The centre point is on both lines; sample it once.
    if (i !== middle) results.push(checkPoint(doc, win, width / 2, (height * i) / BLANK_PAGE_GRID_STEPS, found));
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      sample.points++;
      if (result === 'content') {
        sample.blank = false;
        sample.seen = found.el;
        return;
      }
      if (result === 'covered' || result === 'covered_content') sample.covered++;
      if (result === 'covered_content') sample.coveredContent++;
    }
  }
}

/**
 * Tells whether the user sees anything. Cheapest first: the element seen last
 * time (`hint`), then the content elements in the viewport, then a grid of
 * 17 points for content the element scan can't see. Each hit test costs about
 * 0.3 ms on a page with 10 000 elements, so a page that keeps its content
 * costs one. Reads only what the browser already laid out; nothing is
 * captured or sent besides the counts.
 */
export function samplePage(hint: Element | null = null): BlankPageSample {
  const doc = getDocument();
  const win = getWindow();
  if (doc === null || win === null || typeof doc.elementsFromPoint !== 'function' || doc.body === null) return UNSUPPORTED;
  const width = win.innerWidth;
  const height = win.innerHeight;
  if (!(width > 0 && height > 0)) return UNSUPPORTED;

  const sample: BlankPageSample = {
    supported: true,
    blank: true,
    points: 0,
    covered: 0,
    coveredContent: 0,
    elementsChecked: 0,
    seen: null,
  };
  if (hint !== null && doc.documentElement.contains(hint) && checkElement(doc, win, hint, width, height, sample) === 'seen') {
    sample.blank = false;
    sample.seen = hint;
    return sample;
  }
  checkContentElements(doc, win, width, height, sample);
  if (sample.blank) checkGrid(doc, win, width, height, sample);
  return sample;
}

interface ErrorSignal {
  at: number;
  type: string;
  message: string;
  handled: boolean;
  resource: string | null;
}

interface RequestSignal {
  at: number;
  call: ApiCall;
  failure: string | null;
}

/** Called with the event message and its context when a blank page is confirmed. */
export type BlankPageReporter = (message: string, context: JsonObject) => void;

/**
 * Reports `BlankPage` when the user is left looking at an empty screen: at
 * load, after a screen or route change, after an error, or whenever the DOM
 * changes and then goes quiet. The page must stay blank for
 * BLANK_PAGE_CONFIRM_MS (longer while API calls are still running) before it
 * is reported, at most once per screen.
 *
 * The event says why, from what happened just before: a failed page load,
 * script or chunk, a CSP block, an uncaught error, an expired session, a
 * failed or hanging API call, a frozen main thread, an empty overlay, or
 * nothing at all.
 */
export class BlankPageCollector implements Collector {
  private installed = false;
  /** Checks start once the page has loaded: a page that is still loading is expected to be white. */
  private armed = false;
  private observer: MutationObserver | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private firstScheduledAt = 0;
  private lastActivityAt = 0;
  private pendingTrigger: BlankPageTrigger | null = null;
  private blankSince: number | null = null;
  private blankTrigger: BlankPageTrigger = 'dom_change';
  private recheckWhenVisible = false;
  private reportedKeys: string[] = [];
  private errors: ErrorSignal[] = [];
  private requests: RequestSignal[] = [];
  private longTask: { at: number; durationMs: number } | null = null;
  /** The element where content was last seen; dropped as soon as a check no longer sees it. */
  private lastSeen: Element | null = null;

  private readonly handleLoad: () => void;
  private readonly handleVisibility: () => void;
  private readonly handleMutations: () => void;
  private readonly onCheckTimer: () => void;
  private readonly onConfirmTimer: () => void;

  /**
   * @param currentKey Names the current screen (screen name or path); one report per key.
   * @param sample Reads the page; replaced in tests because jsdom has no layout.
   */
  constructor(
    private readonly report: BlankPageReporter,
    private readonly network: NetworkInterceptor,
    private readonly currentKey: () => string,
    private readonly logger: Logger,
    private readonly sample: (hint: Element | null) => BlankPageSample = samplePage,
  ) {
    const self = this;
    this.handleLoad = guard(logger, 'blank page load handler', function onLoad() {
      self.arm();
    });
    this.handleVisibility = guard(logger, 'blank page visibility handler', function onVisibility() {
      if (!isPageVisible() || !self.recheckWhenVisible) return;
      self.recheckWhenVisible = false;
      self.blankSince = null;
      self.scheduleCheck('dom_change');
    });
    this.handleMutations = guard(logger, 'blank page mutation handler', function onMutations() {
      self.scheduleCheck('dom_change');
    });
    this.onCheckTimer = guard(logger, 'blank page check', function onCheck() {
      self.runScheduledCheck();
    });
    this.onConfirmTimer = guard(logger, 'blank page confirm', function onConfirm() {
      self.confirmTimer = null;
      self.evaluate(self.blankTrigger);
    });
  }

  install(): void {
    if (this.installed) return;
    const win = getWindow();
    const doc = getDocument();
    if (win === null || doc === null) return;
    this.installed = true;
    const self = this;

    this.network.subscribe(function onApiCall(call: ApiCall, details: RequestDetails) {
      if (self.installed) self.noteRequest(call, details);
    });
    if (typeof MutationObserver !== 'undefined') {
      safelyRun(this.logger, 'blank page observer', function observe() {
        const observer = new MutationObserver(self.handleMutations);
        observer.observe(doc.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden'],
        });
        self.observer = observer;
      });
    }
    doc.addEventListener('visibilitychange', this.handleVisibility);
    if (doc.readyState === 'complete') {
      this.arm();
    } else {
      win.addEventListener('load', this.handleLoad);
    }
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    this.armed = false;
    if (this.observer !== null) this.observer.disconnect();
    this.observer = null;
    this.lastSeen = null;
    if (this.checkTimer !== null) clearTimeout(this.checkTimer);
    if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
    this.checkTimer = null;
    this.confirmTimer = null;
    const win = getWindow();
    const doc = getDocument();
    if (win !== null) win.removeEventListener('load', this.handleLoad);
    if (doc !== null) doc.removeEventListener('visibilitychange', this.handleVisibility);
  }

  /** Looks at the page once things settle; `trigger` is recorded in the event. */
  scheduleCheck(trigger: BlankPageTrigger): void {
    if (!this.installed || !this.armed) return;
    const now = nowMs();
    this.lastActivityAt = now;
    if (trigger === 'screen_change' || trigger === 'navigation') {
      // A new screen gets its own confirmation wait, even if the old one was already blank.
      this.blankSince = null;
      if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    if (this.pendingTrigger === null || TRIGGER_PRIORITY[trigger] > TRIGGER_PRIORITY[this.pendingTrigger]) {
      this.pendingTrigger = trigger;
    }
    if (this.checkTimer !== null) return;
    this.firstScheduledAt = now;
    this.checkTimer = setTimeout(this.onCheckTimer, BLANK_PAGE_QUIET_MS);
  }

  /** Remembers an error as a possible cause, and checks the page soon after it. */
  noteError(error: ErrorPayload, context: JsonObject | null): void {
    const resource = context !== null && typeof context.resource === 'string' ? context.resource : null;
    this.errors.push({ at: nowMs(), type: String(error.type), message: String(error.message), handled: error.handled === true, resource });
    if (this.errors.length > BLANK_PAGE_MAX_SIGNALS) this.errors.shift();
    this.scheduleCheck('error');
  }

  /** Remembers a long main-thread task as a possible cause. */
  noteLongTask(durationMs: number): void {
    this.longTask = { at: nowMs(), durationMs: durationMs };
  }

  private arm(): void {
    if (!this.installed || this.armed) return;
    this.armed = true;
    this.scheduleCheck('load');
  }

  private noteRequest(call: ApiCall, details: RequestDetails): void {
    const failed = call.status >= HTTP_ERROR_STATUS_MIN || (details.failure !== null && details.failure !== 'aborted');
    if (!failed) return;
    this.requests.push({ at: nowMs(), call: call, failure: details.failure });
    if (this.requests.length > BLANK_PAGE_MAX_SIGNALS) this.requests.shift();
  }

  /** Waits until the DOM has been quiet for BLANK_PAGE_QUIET_MS, but no longer than BLANK_PAGE_MAX_WAIT_MS. */
  private runScheduledCheck(): void {
    this.checkTimer = null;
    const now = nowMs();
    const quietFor = now - this.lastActivityAt;
    const waited = now - this.firstScheduledAt;
    if (quietFor < BLANK_PAGE_QUIET_MS && waited < BLANK_PAGE_MAX_WAIT_MS) {
      this.checkTimer = setTimeout(this.onCheckTimer, Math.min(BLANK_PAGE_QUIET_MS - quietFor, BLANK_PAGE_MAX_WAIT_MS - waited));
      return;
    }
    const trigger = this.pendingTrigger !== null ? this.pendingTrigger : 'dom_change';
    this.pendingTrigger = null;
    this.evaluate(trigger);
  }

  private evaluate(trigger: BlankPageTrigger): void {
    if (!this.installed || this.reportedKeys.length >= BLANK_PAGE_MAX_REPORTS) return;
    if (!isPageVisible()) {
      // Nothing is drawn for a hidden tab; look again when the user comes back.
      this.recheckWhenVisible = true;
      return;
    }
    const key = safely(this.logger, 'blank page key', this.currentKey, '');
    if (this.reportedKeys.indexOf(key) !== -1) {
      // Already reported on this screen: don't spend hit tests on it again.
      this.blankSince = null;
      return;
    }
    const self = this;
    const sample = safely(
      this.logger,
      'blank page sample',
      function read() {
        return self.sample(self.lastSeen);
      },
      UNSUPPORTED,
    );
    this.lastSeen = sample.seen;
    if (!sample.supported || !sample.blank) {
      this.blankSince = null;
      if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
      return;
    }

    const now = nowMs();
    if (this.blankSince === null) {
      this.blankSince = now;
      this.blankTrigger = trigger;
    }
    const blankFor = now - this.blankSince;
    const pending = this.network.pendingRequests();
    let wait = 0;
    if (blankFor < BLANK_PAGE_CONFIRM_MS) {
      wait = BLANK_PAGE_CONFIRM_MS - blankFor;
    } else if (pending > 0 && blankFor < BLANK_PAGE_PENDING_MAX_MS) {
      wait = Math.min(BLANK_PAGE_CONFIRM_MS, BLANK_PAGE_PENDING_MAX_MS - blankFor);
    }
    if (wait > 0) {
      if (this.confirmTimer === null) this.confirmTimer = setTimeout(this.onConfirmTimer, wait);
      return;
    }

    this.reportedKeys.push(key);
    if (this.reportedKeys.length >= BLANK_PAGE_MAX_REPORTS && this.observer !== null) {
      // Nothing more will be reported on this page load; stop watching the DOM.
      this.observer.disconnect();
      this.observer = null;
    }
    this.reportBlank(this.blankSince, blankFor, pending, sample);
  }

  private reportBlank(blankSince: number, blankFor: number, pending: number, sample: BlankPageSample): void {
    const from = blankSince - BLANK_PAGE_CAUSE_WINDOW_MS;
    const errors = this.errors.filter(function recent(signal) {
      return signal.at >= from;
    });
    const requests = this.requests.filter(function recent(signal) {
      return signal.at >= from;
    });
    const longTask = this.longTask !== null && this.longTask.at >= from ? this.longTask : null;
    const pageStatus = safely(this.logger, 'page status', readDocumentStatus, null);

    let cause: BlankPageCause = 'nothing_rendered';
    let error: ErrorSignal | null = null;
    let request: RequestSignal | null = null;
    // The client only passes uncaught errors and errors the app reported itself (error boundaries).
    const uncaught = latest(errors, function isScriptError(e) {
      return e.type !== 'ResourceError' && e.type !== 'CspViolation';
    });

    if (pageStatus !== null && pageStatus >= HTTP_ERROR_STATUS_MIN) {
      cause = 'page_http_error';
    } else if ((error = latest(errors, isCodeResourceFailure)) !== null) {
      cause = 'resource_failed';
    } else if ((error = latest(errors, isCodeLoadError)) !== null) {
      cause = 'code_load_failed';
    } else if ((error = latest(errors, isCspViolation)) !== null) {
      cause = 'csp_blocked';
    } else if ((error = uncaught) !== null) {
      cause = 'js_error';
    } else if ((request = latest(requests, isSessionEnd)) !== null) {
      cause = 'session_expired';
    } else if ((request = latest(requests, isAny)) !== null) {
      cause = 'api_failed';
    } else if (pending > 0) {
      cause = 'api_pending';
    } else if (longTask !== null) {
      cause = 'main_thread_blocked';
    } else if (sample.coveredContent > 0) {
      cause = 'covered_by_overlay';
    }
    // Show the nearest error and failed call even when they weren't picked as the cause.
    if (error === null) error = uncaught;
    if (request === null) request = latest(requests, isAny);

    const win = getWindow();
    const doc = getDocument();
    const body = doc !== null ? doc.body : null;
    const visibleText = body !== null && typeof body.innerText === 'string' ? body.innerText.replace(/\s+/g, '').length : null;

    this.report(CAUSE_MESSAGES[cause], {
      cause: cause,
      trigger: this.blankTrigger,
      blank_for_ms: Math.round(blankFor),
      url: win !== null ? stripQuery(win.location.href) : null,
      page_status: pageStatus,
      points_sampled: sample.points,
      points_covered: sample.covered,
      points_covering_content: sample.coveredContent,
      elements_checked: sample.elementsChecked,
      visible_text_chars: visibleText,
      dom_elements: body !== null ? body.getElementsByTagName('*').length : null,
      pending_requests: pending,
      main_thread_blocked_ms: longTask !== null ? Math.round(longTask.durationMs) : null,
      error:
        error !== null
          ? {
              type: error.type,
              message: truncate(error.message, MAX_MESSAGE_LENGTH),
              handled: error.handled,
              ms_before_blank: Math.round(blankSince - error.at),
            }
          : null,
      request:
        request !== null
          ? {
              _id: request.call._id,
              url: request.call.url,
              method: request.call.method,
              status: request.call.status,
              failure: request.failure,
              ms_before_blank: Math.round(blankSince - request.at),
            }
          : null,
    });
  }
}

/** The most recent signal matching `test`, or null. */
function latest<T>(signals: T[], test: (signal: T) => boolean): T | null {
  for (let i = signals.length - 1; i >= 0; i--) {
    if (test(signals[i])) return signals[i];
  }
  return null;
}

function isAny(): boolean {
  return true;
}

function isCodeResourceFailure(e: ErrorSignal): boolean {
  if (e.type !== 'ResourceError') return false;
  return e.resource !== null ? CODE_RESOURCE_KINDS.indexOf(e.resource) !== -1 : CODE_RESOURCE.test(e.message);
}

function isCodeLoadError(e: ErrorSignal): boolean {
  return CODE_LOAD_ERROR.test(e.type) || CODE_LOAD_ERROR.test(e.message);
}

function isCspViolation(e: ErrorSignal): boolean {
  return e.type === 'CspViolation';
}

function isSessionEnd(r: RequestSignal): boolean {
  return BLANK_PAGE_SESSION_STATUSES.indexOf(r.call.status) !== -1;
}
