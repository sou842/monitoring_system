import { PAGE_NOT_FOUND_STATUSES } from '../constants';
import { getDocument, getPerformance, getWindow } from '../core/env';
import { Logger } from '../core/logger';
import { safelyRun } from '../core/safe';
import { Collector } from './collector';

/** Navigation entry field added in Chromium 109 / Firefox; missing in Safari. */
type NavigationEntryWithStatus = PerformanceEntry & { responseStatus?: number };

/** A page that does not exist, as reported to the client. */
export interface PageNotFoundDetails {
  /** Full page URL; the client strips the query string. */
  url: string;
  /** HTTP status of the page, or null when the app reported the miss itself. */
  status: number | null;
  referrer: string | null;
  /** `http-status`: detected from the page's HTTP status. `app`: reported via `capturePageNotFound()`. */
  source: 'http-status' | 'app';
}

/** HTTP status of the current document, or null when the browser does not expose it. */
export function readDocumentStatus(): number | null {
  const perf = getPerformance();
  if (perf === null || typeof perf.getEntriesByType !== 'function') return null;
  const entries = perf.getEntriesByType('navigation');
  if (entries.length === 0) return null;
  const status = (entries[0] as NavigationEntryWithStatus).responseStatus;
  // 0 means the browser withheld the status.
  return typeof status === 'number' && status > 0 ? status : null;
}

/**
 * Reports a `PageNotFound` event when the page itself was served with a 404
 * or 410 status, e.g. a visitor typed `/abouts` instead of `/about`.
 *
 * Reads `responseStatus` from Navigation Timing, which Chromium 109+ and
 * Firefox provide. Safari does not, and client-side route misses in single-page
 * apps never produce an HTTP status: apps cover both with `capturePageNotFound()`.
 */
export class PageNotFoundCollector implements Collector {
  private checked = false;

  constructor(
    private readonly report: (details: PageNotFoundDetails) => void,
    private readonly logger: Logger,
  ) {}

  install(): void {
    // One check per page load: the status belongs to the document, which never changes.
    if (this.checked || getWindow() === null) return;
    this.checked = true;
    const self = this;
    safelyRun(this.logger, 'page status check', function check() {
      const status = readDocumentStatus();
      if (status === null || PAGE_NOT_FOUND_STATUSES.indexOf(status) === -1) return;
      const win = getWindow();
      const doc = getDocument();
      if (win === null) return;
      self.report({
        url: win.location.href,
        status: status,
        referrer: doc !== null && doc.referrer.length > 0 ? doc.referrer : null,
        source: 'http-status',
      });
    });
  }

  uninstall(): void {
    // Nothing to remove: the check runs once at install.
  }
}
