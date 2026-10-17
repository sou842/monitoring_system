import { HTTP_ERROR_STATUS_MIN, MAX_MESSAGE_LENGTH } from '../constants';
import { getDocument, nowMs, stripQuery } from '../core/env';
import { Logger } from '../core/logger';
import { guard, safelyRun } from '../core/safe';
import { truncate } from '../core/serialize';
import { CapturedError, Collector, CollectorSink } from './collector';

const RESOURCE_ERROR_TYPE = 'ResourceError';
/** Resources requested by stylesheets: background images, @import, fonts. */
const CSS_INITIATOR = 'css';
/** Font files are reported through FontFaceSet instead, which also works outside Chromium. */
const FONT_FILE = /\.(woff2?|ttf|otf|eot)$/i;

/** Element-loaded resources. After init the error collector sees these via element `error` events. */
const ELEMENT_INITIATORS = ['img', 'script', 'link'];

/** A resource timing entry. `responseStatus` is Chromium 109+, so it may be missing at runtime. */
type ResourceEntryWithStatus = PerformanceEntry & { initiatorType: string; responseEnd: number; responseStatus?: number };

/** Builds the error for an element resource that failed before the SDK started. */
export function earlyElementResourceError(tag: string, url: string, status: number): CapturedError {
  return {
    error: {
      message: truncate('Failed to load <' + tag + '> ' + url + ' (status ' + status + ')', MAX_MESSAGE_LENGTH),
      type: RESOURCE_ERROR_TYPE,
      handled: false,
    },
    stacktrace: [],
    context: { resource: tag, url: url, status: status, before_sdk_start: true },
  };
}

/** Builds the error for a stylesheet-initiated resource that came back with an error status. */
export function cssResourceError(url: string, status: number): CapturedError {
  return {
    error: {
      message: truncate('Failed to load CSS resource ' + url + ' (status ' + status + ')', MAX_MESSAGE_LENGTH),
      type: RESOURCE_ERROR_TYPE,
      handled: false,
    },
    stacktrace: [],
    context: { resource: 'css', url: url, status: status },
  };
}

/** Builds the error for a web font that failed to load or decode. */
export function fontError(family: string): CapturedError {
  return {
    error: { message: truncate("Failed to load font '" + family + "'", MAX_MESSAGE_LENGTH), type: RESOURCE_ERROR_TYPE, handled: false },
    stacktrace: [],
    context: { resource: 'font', family: family },
  };
}

/**
 * Covers resource failures that never fire an element `error` event, so the
 * error collector cannot see them:
 * - **Web fonts** (`@font-face`, `new FontFace()`): via `document.fonts`
 *   `loadingerror`, in all modern browsers.
 * - **CSS background images and `@import`ed files** with a 4xx/5xx status:
 *   via Resource Timing `responseStatus`.
 * - **`<img>`, `<script>` and `<link>` failures from before the SDK started**
 *   (e.g. a broken image in the server-rendered HTML): read from the buffered
 *   Resource Timing entries at startup.
 *
 * Resource Timing status is Chromium 109+ only, and only for same-origin
 * resources or ones served with `Timing-Allow-Origin`.
 */
export class ResourceCollector implements Collector {
  private observer: PerformanceObserver | null = null;
  private fonts: FontFaceSet | null = null;
  /** performance.now() at install; element failures that finished earlier were missed by the error collector. */
  private installedAt = 0;
  private earlyReported: string[] = [];
  private readonly handleFontError: (event: FontFaceSetLoadEvent) => void;

  constructor(
    private readonly sink: CollectorSink,
    private readonly logger: Logger,
  ) {
    const self = this;
    this.handleFontError = guard(logger, 'font error handler', function onFontError(event: FontFaceSetLoadEvent) {
      const faces = event.fontfaces || [];
      for (let i = 0; i < faces.length; i++) self.sink.onError(fontError(faces[i].family.replace(/^["']|["']$/g, '')));
    });
  }

  install(): void {
    const doc = getDocument();
    if (doc === null || this.fonts !== null || this.observer !== null) return;
    this.installedAt = nowMs();

    if (doc.fonts !== undefined && typeof doc.fonts.addEventListener === 'function') {
      doc.fonts.addEventListener('loadingerror', this.handleFontError as EventListener);
      this.fonts = doc.fonts;
    }
    this.observeCssResources();
  }

  uninstall(): void {
    if (this.fonts !== null) this.fonts.removeEventListener('loadingerror', this.handleFontError as EventListener);
    if (this.observer !== null) {
      const observer = this.observer;
      safelyRun(this.logger, 'disconnect resource observer', function disconnect() {
        observer.disconnect();
      });
    }
    this.fonts = null;
    this.observer = null;
  }

  /** Handles one resource timing entry; exposed for tests. */
  recordResource(entry: ResourceEntryWithStatus): void {
    const status = entry.responseStatus;
    // 0 or undefined: status unknown (older browser, or cross-origin without Timing-Allow-Origin).
    if (typeof status !== 'number' || status < HTTP_ERROR_STATUS_MIN) return;
    const url = stripQuery(entry.name);

    if (entry.initiatorType === CSS_INITIATOR) {
      if (!FONT_FILE.test(url)) this.sink.onError(cssResourceError(url, status));
      return;
    }
    if (ELEMENT_INITIATORS.indexOf(entry.initiatorType) !== -1 && entry.responseEnd <= this.installedAt) {
      // One file can fail twice (e.g. a <link rel="preload"> plus the <img> using it): report the URL once.
      if (this.earlyReported.indexOf(url) !== -1) return;
      this.earlyReported.push(url);
      this.sink.onError(earlyElementResourceError(entry.initiatorType, url, status));
    }
  }

  private observeCssResources(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const supported = PerformanceObserver.supportedEntryTypes;
    if (supported === undefined || supported.indexOf('resource') === -1) return;

    const self = this;
    safelyRun(this.logger, 'observe resources', function observe() {
      const observer = new PerformanceObserver(
        guard(self.logger, 'resource observer', function onList(list: PerformanceObserverEntryList) {
          const entries = list.getEntries();
          for (let i = 0; i < entries.length; i++) self.recordResource(entries[i] as ResourceEntryWithStatus);
        }),
      );
      observer.observe({ type: 'resource', buffered: true });
      self.observer = observer;
    });
  }
}
