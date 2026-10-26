import { MAX_ALLOWED_ORIGINS, MAX_ORIGIN_LENGTH } from './constants.js';

/**
 * Allowed origins: the websites whose pages may send events with a project's
 * key. Browsers set the `Origin` header themselves, so another site can't use
 * a key copied from your page through its visitors' browsers. (A script outside
 * a browser can fake the header; the per-IP rate limit covers that case.)
 *
 * An origin is scheme + host + port, e.g. `https://myapp.com` or
 * `http://localhost:3000`. Exact matches only, no wildcards.
 */

/**
 * `input` as a canonical origin (`HTTPS://MyApp.com:443/` → `https://myapp.com`),
 * or `{ error }` explaining why it isn't one. A full URL is cut down to its
 * origin; `trimmed` tells the caller that happened.
 *
 * @returns {{ origin: string, trimmed: boolean } | { error: string }}
 */
export function normalizeOrigin(input) {
  if (typeof input !== 'string') return { error: 'Must be text' };
  const text = input.trim();
  if (text.length === 0) return { error: 'Enter an origin, e.g. https://myapp.com' };
  if (text.length > MAX_ORIGIN_LENGTH) return { error: `At most ${MAX_ORIGIN_LENGTH} characters` };
  if (text.includes('*')) return { error: 'Wildcards are not supported; add each origin' };
  if (!text.includes('://')) return { error: 'Include http:// or https://, e.g. http://localhost:3000' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'Not a valid origin; use the form https://myapp.com' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http:// and https:// origins' };
  if (url.username || url.password) return { error: 'Must not contain a user name or password' };
  // URL.origin is already lowercase and leaves out default ports (:80, :443).
  const origin = url.origin;
  return { origin, trimmed: text.replace(/\/$/, '').toLowerCase() !== origin };
}

/**
 * Validates a whole list as sent by the dashboard: normalizes every entry and
 * removes duplicates.
 *
 * @returns {{ ok: true, origins: string[] } | { ok: false, errors: Array<{ index: number, value: string, error: string }>, message: string }}
 */
export function cleanOriginList(list) {
  if (!Array.isArray(list)) return { ok: false, errors: [], message: 'allowedOrigins must be a list' };
  const origins = [];
  const errors = [];
  list.forEach((value, index) => {
    const result = normalizeOrigin(value);
    if ('error' in result) errors.push({ index, value: String(value).slice(0, MAX_ORIGIN_LENGTH), error: result.error });
    else if (!origins.includes(result.origin)) origins.push(result.origin);
  });
  if (errors.length > 0) return { ok: false, errors, message: `Invalid origin: ${errors[0].error}` };
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    return { ok: false, errors: [], message: `At most ${MAX_ALLOWED_ORIGINS} origins per project` };
  }
  return { ok: true, origins };
}

/**
 * Whether a request with this `Origin` header may send events to `project`.
 * No list → every origin. No header → allowed: server-side SDKs and mobile
 * apps don't send one. `Origin: null` (file:// pages, sandboxed frames) only
 * passes when there is no list.
 */
export function isOriginAllowed(project, originHeader) {
  const allowed = Array.isArray(project.allowedOrigins) ? project.allowedOrigins : [];
  if (allowed.length === 0) return true;
  if (originHeader === null || originHeader === undefined || originHeader === '') return true;
  const result = normalizeOrigin(originHeader);
  return !('error' in result) && allowed.includes(result.origin);
}
