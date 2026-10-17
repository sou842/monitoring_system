import { createHash } from 'node:crypto';

/**
 * Decides which events are "the same problem" so they are grouped into one
 * issue with a count, instead of one row per occurrence.
 *
 * Fingerprint = event type + error type + normalized message + top stack frame.
 * Normalizing removes the parts that vary between occurrences of the same bug:
 * IDs, long numbers, durations, sizes, build hashes in file names, query strings.
 */

const MAX_NORMALIZED_LENGTH = 500;

const REPLACEMENTS = [
  // UUIDs and long hex IDs (Mongo ids, hashes, request ids)
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{uuid}'],
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '{hex}'],
  // Query strings and fragments in URLs
  [/(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/g, '$1'],
  // Numeric path segments: /users/123/orders -> /users/{n}/orders
  [/\/\d+(?=\/|\b)/g, '/{n}'],
  // Measurements: 2505ms, 1.5s, 12 fps, 142.3MB, 50 event(s)
  [/\b\d+(\.\d+)?\s?(ms|s|fps|mb|kb|bytes|events?|event\(s\))\b/gi, '{n}$2'],
  // Counters like "#42"
  [/#\d+/g, '#{n}'],
  // Any remaining long number (ids, timestamps); short ones such as HTTP status codes stay.
  [/\b\d{4,}\b/g, '{n}'],
];

/** Message with occurrence-specific details replaced by placeholders. */
export function normalizeMessage(message) {
  let out = String(message || '');
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  return out.trim().slice(0, MAX_NORMALIZED_LENGTH);
}

/**
 * File path without origin, query string or build hash, so the same source
 * file matches across deploys (`/_next/static/chunks/page-69f0…d9.js` →
 * `/_next/static/chunks/page.js`) and across environments (localhost vs prod).
 */
export function normalizeFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return '';
  // Server-side (Node) frames on Windows use backslashes: C:\app\server\route.js
  let path = filename.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  path = path.replace(/[-.][0-9a-f]{8,}(?=\.[a-z0-9]+$)/i, '');
  return path;
}

/** The first stack frame that has a file name (the closest app code). */
export function topFrame(stacktrace) {
  return (stacktrace || []).find((f) => f && f.filename) || null;
}

/** "handlePayment (cart.js:142)" — short label shown in issue lists. */
export function culprit(stacktrace) {
  const frame = topFrame(stacktrace);
  if (frame === null) return null;
  const file = normalizeFilename(frame.filename).split('/').pop();
  return `${frame.function} (${file}${frame.lineno !== null ? ':' + frame.lineno : ''})`;
}

/** Stable grouping key for an event (validated shape). */
export function fingerprint(event) {
  const frame = topFrame(event.stacktrace);
  const parts = [
    event.event_type,
    event.error ? event.error.type : '',
    normalizeMessage(event.error ? event.error.message : ''),
    // Function + file, not line/column: those shift with every code change.
    frame ? `${frame.function}@${normalizeFilename(frame.filename)}` : '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}
