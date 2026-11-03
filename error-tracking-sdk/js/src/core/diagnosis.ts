/**
 * Diagnostic details the SDK adds to an event's `context`, so an issue can be
 * understood without reproducing it: where a URL points, the state of the page
 * and network, what the browser's timing data says about a request, and the
 * parts of a thrown value the stack trace leaves out.
 *
 * Everything here reads data the browser already has (no extra requests), runs
 * only while an event is being built, and returns `null` for anything the
 * browser does not provide.
 */
import {
  MAX_CAUSE_FRAMES,
  MAX_CAUSE_MESSAGE_LENGTH,
  MAX_DIAGNOSTIC_STRING_LENGTH,
  MAX_DIAGNOSTIC_URL_LENGTH,
  MAX_ERROR_CAUSE_DEPTH,
  ERROR_FIELD_ALLOWLIST,
  MAX_TRACKED_HOSTS,
  SERVER_ID_HEADERS,
} from '../constants';
import { JsonObject, JsonValue } from '../types';
import { getDocument, getNavigator, getPerformance, getWindow, nowMs, stripQuery } from './env';
import { truncate } from './serialize';
import { parseStackFromError } from './stackParser';

/** Where a URL points, compared with the page. */
export interface UrlOrigin {
  /** Host name with port, e.g. `cdn.example.com`; null when the URL can't be parsed. */
  host: string | null;
  /**
   * True when scheme, host or port differ from the page's. The browser then
   * hides most details of the request (status, headers, sizes) unless the
   * server allows them with CORS.
   */
  crossOrigin: boolean | null;
}

/** Splits `url` (absolute, or relative to the page) into host and same/cross-origin. */
export function originOf(url: string): UrlOrigin {
  const win = getWindow();
  try {
    const base = win !== null ? win.location.href : undefined;
    const parsed = new URL(url, base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { host: null, crossOrigin: null };
    return { host: parsed.host, crossOrigin: win !== null ? parsed.origin !== win.location.origin : null };
  } catch (_e) {
    return { host: null, crossOrigin: null };
  }
}

/** `navigator.connection` (Chromium only); not in TypeScript's DOM types. */
interface NetworkInformationLike {
  effectiveType?: unknown;
}

/**
 * The state of the page and network when an event happened, attached as
 * `context.situation` to every error, message and performance event:
 * - `online`: the browser's connectivity flag;
 * - `connection`: `slow-2g` | `2g` | `3g` | `4g` (Chromium), else null;
 * - `visibility`: `visible` | `hidden`;
 * - `ms_since_page_load`: time since the page started loading (null outside a page, e.g. Node);
 * - `ms_since_navigation`: time since the last route or screen change, null if none yet;
 * - `during_page_load`: true until the page's load event has fired.
 * @param lastNavigationMs `performance.now()` of the last route or screen change, or null.
 */
export function situation(lastNavigationMs: number | null): JsonObject {
  const nav = getNavigator();
  const doc = getDocument();
  const perf = getPerformance();
  let connection: string | null = null;
  if (nav !== null) {
    const info = (nav as Navigator & { connection?: NetworkInformationLike }).connection;
    if (info !== undefined && info !== null && typeof info.effectiveType === 'string') connection = info.effectiveType;
  }
  const now = nowMs();
  return {
    online: nav !== null && typeof nav.onLine === 'boolean' ? nav.onLine : null,
    connection: connection,
    visibility: doc !== null && typeof doc.visibilityState === 'string' ? doc.visibilityState : null,
    // Outside a page (Next.js server errors) performance.now() is the process uptime, not a page age.
    ms_since_page_load: doc !== null && perf !== null && typeof perf.now === 'function' ? Math.round(now) : null,
    ms_since_navigation: lastNavigationMs !== null ? Math.max(0, Math.round(now - lastNavigationMs)) : null,
    during_page_load: doc !== null && typeof doc.readyState === 'string' ? doc.readyState !== 'complete' : null,
  };
}

/**
 * Returns `context` with `situation` added. A `situation` key the app set
 * itself (through `captureError`'s context) is left as it is.
 */
export function withSituation(context: JsonObject | null, state: JsonObject): JsonObject {
  const out: JsonObject = {};
  if (context !== null) {
    for (const key in context) {
      if (Object.prototype.hasOwnProperty.call(context, key)) out[key] = context[key];
    }
    if (Object.prototype.hasOwnProperty.call(context, 'situation')) return out;
  }
  out.situation = state;
  return out;
}

/** Copies `extra`'s fields over `base` (both may be null). */
export function mergeContext(base: JsonObject | null | undefined, extra: JsonObject | null | undefined): JsonObject | null {
  if ((base === null || base === undefined) && (extra === null || extra === undefined)) return null;
  const out: JsonObject = {};
  const sources = [base, extra];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (source === null || source === undefined) continue;
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thrown values
// ---------------------------------------------------------------------------

function isErrorLike(value: unknown): value is { message: string } {
  return value !== null && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string';
}

/** What kind of value was thrown: `error` for Error-like objects, else `typeof` (with `null`). */
export function thrownKind(value: unknown): string {
  if (value === null) return 'null';
  if (isErrorLike(value)) return 'error';
  return typeof value;
}

/** Reads one property without letting a throwing getter escape. */
function readProp(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch (_e) {
    return undefined;
  }
}

/**
 * The error object's own fields from `ERROR_FIELD_ALLOWLIST` (`code`,
 * `status`, `statusText`, ...), e.g. axios' `code: "ERR_BAD_RESPONSE"`.
 * Strings, numbers and booleans only, strings cut to
 * `MAX_DIAGNOSTIC_STRING_LENGTH`. Other fields are never read: they can hold
 * URLs with tokens, response bodies or credentials.
 */
export function errorProps(error: object): JsonObject | null {
  const out: JsonObject = {};
  let count = 0;
  for (let i = 0; i < ERROR_FIELD_ALLOWLIST.length; i++) {
    const key = ERROR_FIELD_ALLOWLIST[i];
    let own = false;
    try {
      own = Object.prototype.hasOwnProperty.call(error, key);
    } catch (_e) {
      own = false;
    }
    if (!own) continue;
    const value = readProp(error, key);
    if (typeof value === 'string') {
      out[key] = truncate(value, MAX_DIAGNOSTIC_STRING_LENGTH);
    } else if ((typeof value === 'number' && isFinite(value)) || typeof value === 'boolean') {
      out[key] = value;
    } else {
      continue;
    }
    count++;
  }
  return count > 0 ? out : null;
}

/** The type name of an Error-like value (its `name`, else its constructor's name). */
function errorTypeOf(value: object): string | null {
  const name = readProp(value, 'name');
  if (typeof name === 'string' && name.length > 0) return name;
  const ctor = readProp(value, 'constructor') as { name?: unknown } | undefined;
  return ctor !== undefined && ctor !== null && typeof ctor.name === 'string' && ctor.name.length > 0 ? ctor.name : null;
}

/**
 * The chain of `error.cause` values (ES2022), outermost first: libraries and
 * apps often wrap the real failure ("Request failed" ← "Unexpected token <").
 * Each link: `{ type, message, stacktrace }` (top frames only).
 */
export function causeChain(error: unknown): JsonValue[] {
  const chain: JsonValue[] = [];
  const seen: unknown[] = [error];
  let current: unknown = error !== null && typeof error === 'object' ? readProp(error, 'cause') : undefined;
  while (current !== undefined && current !== null && chain.length < MAX_ERROR_CAUSE_DEPTH) {
    if (seen.indexOf(current) !== -1) break;
    seen.push(current);
    if (isErrorLike(current)) {
      chain.push({
        type: errorTypeOf(current),
        message: truncate(current.message, MAX_CAUSE_MESSAGE_LENGTH),
        stacktrace: parseStackFromError(current).slice(0, MAX_CAUSE_FRAMES) as unknown as JsonValue[],
      });
      current = readProp(current, 'cause');
    } else {
      chain.push({ type: null, message: describeCause(current), stacktrace: [] });
      break;
    }
  }
  return chain;
}

/**
 * A non-Error `cause` as text. Objects are described by their allowlisted
 * fields only (`code: E_TIMEOUT`), never serialized whole: a cause object can
 * be a response, a request config or anything else.
 */
function describeCause(value: unknown): string {
  if (typeof value === 'string') return truncate(value, MAX_CAUSE_MESSAGE_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== null && typeof value === 'object') {
    const fields = errorProps(value);
    if (fields === null) return '[object]';
    const parts: string[] = [];
    for (const key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) parts.push(key + ': ' + String(fields[key]));
    }
    return parts.join(', ');
  }
  return '[' + typeof value + ']';
}

/**
 * What the stack trace leaves out about a thrown value:
 * - `thrown_kind` when it isn't an Error (`string`, `object`, `undefined`, ...):
 *   such values have no stack, so this explains an empty trace;
 * - `error_causes`: the `cause` chain;
 * - `error_fields`: the error's own plain fields (`code`, `status`, ...).
 * Returns null when there is nothing to add.
 */
export function thrownDetails(thrown: unknown): JsonObject | null {
  // A hostile value (throwing getters, a revoked Proxy) may cost these
  // details, never the event they belong to.
  try {
    return readThrownDetails(thrown);
  } catch (_e) {
    return null;
  }
}

function readThrownDetails(thrown: unknown): JsonObject | null {
  const out: JsonObject = {};
  let any = false;
  const kind = thrownKind(thrown);
  if (kind !== 'error') {
    out.thrown_kind = kind;
    any = true;
  }
  if (thrown !== null && typeof thrown === 'object') {
    const causes = causeChain(thrown);
    if (causes.length > 0) {
      out.error_causes = causes;
      any = true;
    }
    if (kind === 'error') {
      const fields = errorProps(thrown);
      if (fields !== null) {
        out.error_fields = fields;
        any = true;
      }
    }
  }
  return any ? out : null;
}

/**
 * A URL safe to put in a diagnostic field: query and fragment removed,
 * `data:`/`blob:` URLs reduced to their scheme and media type (a failed
 * `data:` image would otherwise put the whole, possibly private, image in the
 * event), and capped at `MAX_DIAGNOSTIC_URL_LENGTH`.
 */
export function diagnosticUrl(url: string): string {
  const inline = /^(data|blob):/i.exec(url);
  if (inline !== null) {
    if (inline[1].toLowerCase() === 'blob') return 'blob:';
    const media = /^data:([^;,]*)/i.exec(url);
    return 'data:' + (media !== null ? truncate(media[1], MAX_DIAGNOSTIC_STRING_LENGTH) : '');
  }
  return truncate(stripQuery(url), MAX_DIAGNOSTIC_URL_LENGTH);
}

/** True for `data:` and `blob:` URLs, which never reach a server. */
export function isInlineUrl(url: string): boolean {
  return /^(data|blob):/i.test(url);
}

/**
 * Values per key with a fixed number of keys: when full, the least recently
 * used key is forgotten (not all of them, so a busy host keeps its history).
 */
export class BoundedRecord<T> {
  private values: { [key: string]: T } = {};
  /** Keys, least recently used first. */
  private order: string[] = [];

  /**
   * @param create makes the value for a new key
   * @param maxKeys keys kept at most
   */
  constructor(
    private readonly create: () => T,
    private readonly maxKeys: number = MAX_TRACKED_HOSTS,
  ) {}

  /** The value for `key`, created if missing; marks `key` as most recently used. */
  get(key: string): T {
    const at = this.order.indexOf(key);
    if (at !== -1) {
      this.order.splice(at, 1);
    } else {
      if (this.order.length >= this.maxKeys) {
        const oldest = this.order.shift();
        if (oldest !== undefined) delete this.values[oldest];
      }
      this.values[key] = this.create();
    }
    this.order.push(key);
    return this.values[key];
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Picks the server request-id headers (`SERVER_ID_HEADERS`) out of a header
 * lookup. Returns null when none is present or readable.
 */
export function serverIdHeaders(read: (name: string) => string | null): JsonObject | null {
  const out: JsonObject = {};
  let any = false;
  for (let i = 0; i < SERVER_ID_HEADERS.length; i++) {
    let value: string | null = null;
    try {
      value = read(SERVER_ID_HEADERS[i]);
    } catch (_e) {
      value = null;
    }
    if (typeof value === 'string' && value.length > 0) {
      out[SERVER_ID_HEADERS[i]] = truncate(value, MAX_DIAGNOSTIC_STRING_LENGTH);
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Parses `XMLHttpRequest.getAllResponseHeaders()` into a lookup. That method
 * (unlike `getResponseHeader()`) never logs "Refused to get unsafe header"
 * to the console for headers the server didn't expose.
 */
export function headerLookup(raw: string | null): (name: string) => string | null {
  const map: { [name: string]: string } = {};
  if (typeof raw === 'string') {
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const colon = lines[i].indexOf(':');
      if (colon <= 0) continue;
      const name = lines[i].slice(0, colon).replace(/^\s+|\s+$/g, '').toLowerCase();
      const value = lines[i].slice(colon + 1).replace(/^\s+|\s+$/g, '');
      map[name] = Object.prototype.hasOwnProperty.call(map, name) ? map[name] + ', ' + value : value;
    }
  }
  return function lookup(name: string) {
    return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
  };
}

/** What a request's response said about itself, read only when the request is reported. */
export interface ResponseInfo {
  /** `Content-Type`, or null when absent or hidden. */
  contentType: string | null;
  /** `Content-Length` as a number, or null when absent, hidden or invalid. */
  contentLength: number | null;
  /** Server request-id headers, or null. */
  serverIds: JsonObject | null;
}

/** Builds `ResponseInfo` from a header lookup. */
export function responseInfo(read: (name: string) => string | null): ResponseInfo {
  let contentType: string | null = null;
  let contentLength: number | null = null;
  try {
    const type = read('content-type');
    if (typeof type === 'string' && type.length > 0) contentType = truncate(type, MAX_DIAGNOSTIC_STRING_LENGTH);
    const length = read('content-length');
    if (typeof length === 'string' && /^\d+$/.test(length)) contentLength = parseInt(length, 10);
  } catch (_e) {
    // Header access can't fail in real browsers; stay safe in odd environments.
  }
  return { contentType: contentType, contentLength: contentLength, serverIds: serverIdHeaders(read) };
}
