import { MASKED_TEXT, MAX_DIAGNOSTIC_STRING_LENGTH, RESOURCE_ENTRY_MAX_AGE_MS, RESOURCE_TIMING_BUFFER_SIZE } from '../constants';
import { diagnosticUrl, isInlineUrl, originOf } from '../core/diagnosis';
import { cssPath, isMasked } from '../core/dom';
import { absoluteUrl, getPerformance, isOnline, nowMs } from '../core/env';
import { truncate } from '../core/serialize';
import { JsonObject } from '../types';

/**
 * Why a file failed to load, as far as the browser lets a page know:
 * - `http_error`: the server answered 4xx/5xx (status in `status`);
 * - `bad_content`: the server answered 2xx/3xx but the browser couldn't use the
 *   file (corrupt image, wrong `Content-Type`, blocked MIME type), or an inline
 *   `data:`/`blob:` URL couldn't be used;
 * - `hidden_cross_origin`: the file is on another origin, so the browser hides
 *   the status; it may be 403/404, a DNS failure or a blocked request;
 * - `no_response`: no response at all (connection failed, blocked by an
 *   extension or the browser);
 * - `offline`: the device was offline;
 * - `unknown`: the browser gave no timing data to tell (older browsers,
 *   Resource Timing buffer full, or only an entry from an earlier load).
 */
export type ResourceCause = 'http_error' | 'bad_content' | 'hidden_cross_origin' | 'no_response' | 'offline' | 'unknown';

/** A Resource Timing entry; `responseStatus` (Chromium 109+) and `contentType` (Chromium 125+) may be missing. */
export type ResourceTimingEntry = PerformanceEntry & {
  responseStatus?: number;
  contentType?: string;
  encodedBodySize?: number;
};

/** The timing entry of a failed load, if the browser recorded one for it. */
export interface EntryLookup {
  /** The entry of this load: the newest one for the URL, ended within `RESOURCE_ENTRY_MAX_AGE_MS`. */
  entry: ResourceTimingEntry | null;
  /** True when the only entries for the URL are older: earlier loads, which say nothing about this one. */
  stale: boolean;
}

/**
 * Finds the browser's timing entry for `url` (exact URL, query included).
 * @param url the requested URL
 * @param now `performance.now()` when the failure was seen
 */
export function findResourceEntry(url: string, now: number = nowMs()): EntryLookup {
  const perf = getPerformance();
  if (perf === null || typeof perf.getEntriesByName !== 'function') return { entry: null, stale: false };
  try {
    const entries = perf.getEntriesByName(url, 'resource');
    if (entries.length === 0) return { entry: null, stale: false };
    const newest = entries[entries.length - 1] as ResourceTimingEntry;
    const ended = newest.startTime + newest.duration;
    return now - ended <= RESOURCE_ENTRY_MAX_AGE_MS ? { entry: newest, stale: false } : { entry: null, stale: true };
  } catch (_e) {
    return { entry: null, stale: false };
  }
}

/** True when the browser may have stopped recording entries because its buffer is full. */
function timingBufferMayBeFull(): boolean {
  const perf = getPerformance();
  if (perf === null || typeof perf.getEntriesByType !== 'function') return true;
  try {
    return perf.getEntriesByType('resource').length >= RESOURCE_TIMING_BUFFER_SIZE;
  } catch (_e) {
    return true;
  }
}

/** What the timing data says about one failed file. */
export interface ResourceTimingFacts {
  cause: ResourceCause;
  /** HTTP status, when the browser shows it (same origin, or cross-origin with CORS). */
  status: number | null;
  contentType: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
}

/**
 * Classifies a failed load from its Resource Timing entry.
 * @param entry the entry of this load, or null when there is none
 * @param crossOrigin whether the file is on another origin
 * @param online the browser's connectivity flag
 * @param noEntryUnknown true when a missing entry proves nothing (timing buffer
 *   full, or only entries of earlier loads exist), so the cause is `unknown`
 */
export function classifyResourceFailure(
  entry: ResourceTimingEntry | null,
  crossOrigin: boolean | null,
  online: boolean,
  noEntryUnknown: boolean,
): ResourceTimingFacts {
  const status = entry !== null && typeof entry.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : null;
  const facts: ResourceTimingFacts = {
    cause: 'unknown',
    status: status,
    contentType:
      entry !== null && typeof entry.contentType === 'string' && entry.contentType.length > 0
        ? truncate(entry.contentType, MAX_DIAGNOSTIC_STRING_LENGTH)
        : null,
    durationMs: entry !== null && isFinite(entry.duration) ? Math.round(entry.duration) : null,
    sizeBytes: status !== null && entry !== null && typeof entry.encodedBodySize === 'number' ? entry.encodedBodySize : null,
  };
  if (!online) {
    facts.cause = 'offline';
  } else if (status !== null) {
    facts.cause = status >= 400 ? 'http_error' : 'bad_content';
  } else if (entry !== null) {
    if (typeof entry.responseStatus !== 'number') facts.cause = 'unknown';
    else facts.cause = crossOrigin === true ? 'hidden_cross_origin' : 'no_response';
  } else {
    facts.cause = noEntryUnknown ? 'unknown' : crossOrigin === true ? 'hidden_cross_origin' : 'no_response';
  }
  return facts;
}

function attr(el: Element, name: string): string | null {
  const value = el.getAttribute(name);
  return value !== null ? truncate(value, MAX_DIAGNOSTIC_STRING_LENGTH) : null;
}

/** The URL the element actually requested: `currentSrc` (srcset/picture), else `src`/`href`. */
function requestedUrl(el: Element): string | null {
  const current = (el as HTMLImageElement).currentSrc;
  if (typeof current === 'string' && current.length > 0) return current;
  const raw = el.getAttribute('src') || el.getAttribute('href');
  return raw !== null && raw.length > 0 ? absoluteUrl(raw) : null;
}

/**
 * `context` for an `<img>`/`<script>`/`<link>`/... that fired `error`:
 * `{ resource, cause, status, url, host, cross_origin, content_type,
 * duration_ms, size_bytes, selector, alt, current_src, loading, crossorigin,
 * same_host_failures }`. URLs go through `diagnosticUrl` (no query, no inline
 * data, length-capped); `alt` is masked like click text.
 * @param el the element that failed
 * @param maskSelectors selectors whose text must not be recorded
 * @param countFailure records this failure for its host and returns how many
 *   files from that host failed before it on this page
 */
export function describeFailedElement(
  el: Element,
  maskSelectors: readonly string[],
  countFailure: (host: string) => number,
): JsonObject {
  const requested = requestedUrl(el);
  const inline = requested !== null && isInlineUrl(requested);
  const origin = requested !== null && !inline ? originOf(requested) : { host: null, crossOrigin: null };
  let facts: ResourceTimingFacts;
  if (inline) {
    // A data:/blob: URL never reaches a server: the content itself was unusable (or the blob was revoked).
    facts = { cause: 'bad_content', status: null, contentType: null, durationMs: null, sizeBytes: null };
  } else {
    const lookup = requested !== null ? findResourceEntry(requested) : { entry: null, stale: false };
    const noEntryUnknown = lookup.entry === null && (lookup.stale || timingBufferMayBeFull());
    facts = classifyResourceFailure(lookup.entry, origin.crossOrigin, isOnline(), noEntryUnknown);
  }
  const src = el.getAttribute('src');
  const currentSrc = requested !== null ? diagnosticUrl(requested) : null;
  const srcUrl = src !== null && src.length > 0 ? diagnosticUrl(absoluteUrl(src)) : null;
  let alt: string | null = null;
  if (el.tagName === 'IMG') alt = isMasked(el, maskSelectors) ? MASKED_TEXT : attr(el, 'alt');
  return {
    resource: el.tagName.toLowerCase(),
    cause: facts.cause,
    status: facts.status,
    url: srcUrl !== null ? srcUrl : currentSrc,
    host: origin.host,
    cross_origin: origin.crossOrigin,
    content_type: facts.contentType,
    duration_ms: facts.durationMs,
    size_bytes: facts.sizeBytes,
    selector: cssPath(el),
    alt: alt,
    // Only when srcset/<picture> picked another file than src.
    current_src: currentSrc !== null && srcUrl !== null && currentSrc !== srcUrl ? currentSrc : null,
    loading: attr(el, 'loading'),
    crossorigin: attr(el, 'crossorigin'),
    same_host_failures: origin.host !== null ? countFailure(origin.host) : null,
  };
}
