/**
 * Remembers error objects the SDK has already turned into events, so a single
 * failure is never reported twice. Example: a failed `fetch` is reported as a
 * NetworkError, and the same TypeError may later reach `unhandledrejection`
 * or `console.error`; those later sightings are skipped.
 *
 * Uses a WeakSet, so remembered errors are still garbage-collected normally.
 */

import { REPORTED_SIGNATURE_TTL_MS } from '../constants';

const reported: WeakSet<object> | null = typeof WeakSet !== 'undefined' ? new WeakSet<object>() : null;

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** Marks `value` as reported. Primitives cannot be tracked and are ignored. */
export function markReported(value: unknown): void {
  if (reported !== null && isObject(value)) reported.add(value);
}

/** True if `value` was already turned into an event. */
export function wasReported(value: unknown): boolean {
  return reported !== null && isObject(value) && reported.has(value);
}

/**
 * Some failures reach the SDK twice as *different* objects, e.g. an unhandled
 * error inside a Web Worker fires on the Worker and may then be re-dispatched
 * on `window`. Those are matched by a text signature that expires quickly.
 */
const signatures: Record<string, number> = {};

/** Remembers a signature (e.g. message + file + line) as reported, for a short time. */
export function markSignatureReported(signature: string, now: number = Date.now()): void {
  signatures[signature] = now;
  // Keep the map tiny: drop anything already expired.
  Object.keys(signatures).forEach(function prune(key) {
    if (now - signatures[key] > REPORTED_SIGNATURE_TTL_MS) delete signatures[key];
  });
}

/** True if the signature was reported within the last few seconds. */
export function wasSignatureReported(signature: string, now: number = Date.now()): boolean {
  const seen = signatures[signature];
  return seen !== undefined && now - seen <= REPORTED_SIGNATURE_TTL_MS;
}

/** Signature for an error that has only text and a location (no error object). */
export function locationSignature(message: string, filename: string | null, lineno: number | null): string {
  return message + '|' + String(filename) + '|' + String(lineno);
}
