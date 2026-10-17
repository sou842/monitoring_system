/**
 * Guarded access to browser globals so the SDK can be imported in Node.js,
 * SSR and web workers without throwing.
 */

export function getWindow(): Window | null {
  return typeof window !== 'undefined' ? window : null;
}

export function getDocument(): Document | null {
  return typeof document !== 'undefined' ? document : null;
}

export function getNavigator(): Navigator | null {
  return typeof navigator !== 'undefined' ? navigator : null;
}

export function getPerformance(): Performance | null {
  return typeof performance !== 'undefined' ? performance : null;
}

/** localStorage throws on access in some privacy modes, so even reading the property is guarded. */
export function getLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (_e) {
    return null;
  }
}

export function isOnline(): boolean {
  const nav = getNavigator();
  // Treat "unknown" as online so we attempt delivery rather than buffer forever.
  return nav === null || nav.onLine !== false;
}

export function isPageVisible(): boolean {
  const doc = getDocument();
  return doc !== null && doc.visibilityState !== 'hidden';
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** High-resolution monotonic time where available. */
export function nowMs(): number {
  const perf = getPerformance();
  return perf !== null && typeof perf.now === 'function' ? perf.now() : Date.now();
}

/** Removes the query string and fragment, which commonly carry tokens or PII. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Resolves relative URLs against the page so comparisons are reliable. */
export function absoluteUrl(url: string): string {
  const doc = getDocument();
  try {
    return doc !== null ? new URL(url, doc.baseURI).href : url;
  } catch (_e) {
    return url;
  }
}

/** Rounds to whole milliseconds; negative or non-finite values become null. */
export function toMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !isFinite(value) || value < 0) return null;
  return Math.round(value);
}
