import { ObjectId } from 'mongodb';
import { MAX_BODY_BYTES } from './constants.js';

/** JSON response with no-store caching (everything here is live data). */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Error response in one consistent shape: `{ error: { code, message } }`. */
export function errorResponse(status, code, message, headers = {}) {
  return json({ error: { code, message } }, status, headers);
}

/**
 * Reads and parses a JSON body, refusing anything over `maxBytes`.
 * Returns `{ ok: true, value }` or `{ ok: false, response }`.
 */
export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: errorResponse(413, 'payload_too_large', `Body exceeds ${maxBytes} bytes`) };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse(400, 'unreadable_body', 'Could not read request body') };
  }
  if (Buffer.byteLength(text) > maxBytes) {
    return { ok: false, response: errorResponse(413, 'payload_too_large', `Body exceeds ${maxBytes} bytes`) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid_json', 'Body is not valid JSON') };
  }
}

/** Parses a 24-hex-character MongoDB id, or returns null. */
export function parseObjectId(value) {
  return typeof value === 'string' && ObjectId.isValid(value) && value.length === 24 ? new ObjectId(value) : null;
}

/**
 * Wraps a handler so an unexpected exception becomes a logged 500 instead
 * of an unhandled crash, and never leaks internals to the caller.
 */
export function handle(fn) {
  return async function handler(request) {
    try {
      return await fn(request);
    } catch (error) {
      console.error('[backend] unhandled error', error);
      return errorResponse(500, 'internal_error', 'Something went wrong');
    }
  };
}
