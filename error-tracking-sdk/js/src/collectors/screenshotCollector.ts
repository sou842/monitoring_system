import {
  MASK_COLOR,
  MAX_SCREENSHOT_LENGTH,
  SCREENSHOT_FALLBACK_QUALITY,
  SCREENSHOT_MAX_SCALE,
  SCREENSHOT_MAX_WIDTH,
  SCREENSHOT_MIME_TYPE,
  SCREENSHOT_MIN_INTERVAL_MS,
  SCREENSHOT_QUALITY,
  SCREENSHOT_TIMEOUT_MS,
} from '../constants';
import { getDocument, getWindow, isPageVisible } from '../core/env';
import { Logger } from '../core/logger';
import { safelyRun } from '../core/safe';

/** The subset of html2canvas options the SDK uses. */
export interface Html2CanvasOptions {
  logging: boolean;
  useCORS: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  onclone: (clonedDocument: Document) => void;
}

export type Html2Canvas = (element: HTMLElement, options: Html2CanvasOptions) => Promise<HTMLCanvasElement>;

interface WindowWithHtml2Canvas extends Window {
  html2canvas?: Html2Canvas;
}

export interface ScreenshotOptions {
  maskSelectors: readonly string[];
  libraryUrl: string;
  /** SRI hash for `libraryUrl`; empty string disables the integrity attribute. */
  libraryIntegrity: string;
}

/** Returns every element matching any selector. Invalid selectors are skipped. */
export function findMaskedElements(root: ParentNode, selectors: readonly string[]): Element[] {
  const found: Element[] = [];
  for (let i = 0; i < selectors.length; i++) {
    let matches: NodeListOf<Element>;
    try {
      matches = root.querySelectorAll(selectors[i]);
    } catch (_e) {
      continue;
    }
    for (let j = 0; j < matches.length; j++) {
      if (found.indexOf(matches[j]) === -1) found.push(matches[j]);
    }
  }
  return found;
}

/**
 * Pre-render masking applied to html2canvas's cloned DOM: masked elements are
 * painted solid black and form values are blanked, so their content never
 * reaches the renderer. The live page is not touched.
 */
export function maskClonedDocument(clone: Document, selectors: readonly string[]): void {
  const elements = findMaskedElements(clone, selectors);
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as HTMLElement;
    if (el.style === undefined) continue;
    el.style.setProperty('background', MASK_COLOR, 'important');
    el.style.setProperty('color', MASK_COLOR, 'important');
    el.style.setProperty('border-color', MASK_COLOR, 'important');
    el.style.setProperty('text-shadow', 'none', 'important');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = '';
      el.setAttribute('value', '');
      el.setAttribute('placeholder', '');
    }
    // Hide descendants (images, nested text) so only the black box renders.
    const children = el.querySelectorAll('*');
    for (let j = 0; j < children.length; j++) {
      (children[j] as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
    }
  }
}

/**
 * Post-render masking: draws an opaque rectangle over each masked element's
 * on-screen bounds. Belt-and-braces with `maskClonedDocument`.
 */
export function paintMasks(ctx: CanvasRenderingContext2D, elements: Element[], scale: number): void {
  ctx.fillStyle = MASK_COLOR;
  for (let i = 0; i < elements.length; i++) {
    const rect = elements[i].getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    ctx.fillRect(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
  }
}

/**
 * Captures the visible viewport as a JPEG data URL using html2canvas, which
 * is loaded from a CDN on first use (it is never bundled with the SDK).
 * Elements matching the mask selectors are blacked out.
 *
 * Screenshots are skipped when the page is hidden, when one was taken in the
 * last 10 s, or when capture takes longer than 3 s.
 */
export class ScreenshotCollector {
  private loader: Promise<Html2Canvas> | null = null;
  private lastCaptureAt = 0;

  constructor(
    private readonly options: ScreenshotOptions,
    private readonly logger: Logger,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Resolves to a data URL, or `null` if no screenshot could or should be taken. Never rejects. */
  capture(): Promise<string | null> {
    const win = getWindow() as WindowWithHtml2Canvas | null;
    const doc = getDocument();
    if (win === null || doc === null || doc.documentElement === null) return Promise.resolve(null);

    if (!isPageVisible()) {
      this.logger.warn('page is hidden; skipping screenshot');
      return Promise.resolve(null);
    }
    const now = this.clock();
    if (now - this.lastCaptureAt < SCREENSHOT_MIN_INTERVAL_MS) {
      this.logger.info('screenshot throttled');
      return Promise.resolve(null);
    }
    this.lastCaptureAt = now;

    const self = this;
    const work = this.loadLibrary(win)
      .then(function render(html2canvas) {
        return self.render(html2canvas, win, doc);
      })
      .then(null, function onFailure(error: unknown): string | null {
        self.logger.warn('screenshot failed', error);
        return null;
      });

    return withTimeout(work, SCREENSHOT_TIMEOUT_MS, function onTimeout() {
      self.logger.warn('screenshot timed out');
    });
  }

  private render(html2canvas: Html2Canvas, win: Window, doc: Document): Promise<string | null> {
    if (!isPageVisible()) return Promise.resolve(null);

    const selectors = this.options.maskSelectors;
    // Never wider than SCREENSHOT_MAX_WIDTH pixels: big monitors would otherwise produce large images.
    const scale = Math.min(win.devicePixelRatio || 1, SCREENSHOT_MAX_SCALE, SCREENSHOT_MAX_WIDTH / Math.max(1, win.innerWidth));
    // Measure masked elements on the live page before rendering.
    const masked = findMaskedElements(doc, selectors);
    const logger = this.logger;

    return html2canvas(doc.documentElement, {
      logging: false,
      useCORS: true,
      x: win.scrollX || win.pageXOffset || 0,
      y: win.scrollY || win.pageYOffset || 0,
      width: win.innerWidth,
      height: win.innerHeight,
      scale: scale,
      onclone: function onClone(clone: Document) {
        safelyRun(logger, 'mask cloned document', function mask() {
          maskClonedDocument(clone, selectors);
        });
      },
    }).then(function encode(canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        // Without a 2D context the post-render mask cannot be guaranteed: refuse to send.
        logger.warn('canvas 2D context unavailable; discarding screenshot');
        return null;
      }
      paintMasks(ctx, masked, scale);

      let dataUrl = canvas.toDataURL(SCREENSHOT_MIME_TYPE, SCREENSHOT_QUALITY);
      if (dataUrl.length > MAX_SCREENSHOT_LENGTH) {
        dataUrl = canvas.toDataURL(SCREENSHOT_MIME_TYPE, SCREENSHOT_FALLBACK_QUALITY);
      }
      if (dataUrl.length > MAX_SCREENSHOT_LENGTH) {
        logger.warn('screenshot exceeds size budget; discarding it');
        return null;
      }
      return dataUrl;
    });
  }

  private loadLibrary(win: WindowWithHtml2Canvas): Promise<Html2Canvas> {
    if (typeof win.html2canvas === 'function') return Promise.resolve(win.html2canvas);
    if (this.loader !== null) return this.loader;

    const options = this.options;
    const self = this;
    this.loader = new Promise<Html2Canvas>(function load(resolve, reject) {
      const doc = win.document;
      const script = doc.createElement('script');
      script.src = options.libraryUrl;
      script.async = true;
      script.crossOrigin = 'anonymous';
      if (options.libraryIntegrity.length > 0) script.integrity = options.libraryIntegrity;
      script.onload = function onLoad() {
        if (typeof win.html2canvas === 'function') {
          resolve(win.html2canvas);
        } else {
          reject(new Error('html2canvas loaded but did not register itself'));
        }
      };
      script.onerror = function onError() {
        reject(new Error('failed to load html2canvas from ' + options.libraryUrl));
      };
      (doc.head || doc.documentElement).appendChild(script);
    }).then(null, function resetLoader(error: unknown): Promise<Html2Canvas> {
      // Allow a later attempt (e.g. after the CDN recovers).
      self.loader = null;
      return Promise.reject(error);
    });
    return this.loader;
  }
}

function withTimeout(work: Promise<string | null>, timeoutMs: number, onTimeout: () => void): Promise<string | null> {
  return new Promise<string | null>(function race(resolve) {
    let settled = false;
    const timer = setTimeout(function expire() {
      if (settled) return;
      settled = true;
      onTimeout();
      resolve(null);
    }, timeoutMs);
    work.then(function done(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}
