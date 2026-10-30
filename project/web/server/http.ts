import { ObjectId } from 'mongodb';
import { MAX_BODY_BYTES } from './constants.ts';

/** JSON response with no-store caching (everything here is live data). */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Error response in one consistent shape: `{ error: { code, message } }`. */
export function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * Reads and parses a JSON body, refusing anything over `maxBytes`.
 * Returns `{ ok: true, value }` or `{ ok: false, response }`.
 */
export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<JsonBody> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: errorResponse(413, 'payload_too_large', `Body exceeds ${maxBytes} bytes`) };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse(400, 'unreadable_body', 'Could not read request body') };
  }
  if (Buffer.byteLength(text) > maxBytes) {
    return { ok: false, response: errorResponse(413, 'payload_too_large', `Body exceeds ${maxBytes} bytes`) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid_json', 'Body is not valid JSON') };
  }
}

/** A JSON body as an object to read fields from (anything else → empty object). */
export function bodyObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Parses a 24-hex-character MongoDB id, or returns null. */
export function parseObjectId(value: unknown): ObjectId | null {
  return typeof value === 'string' && ObjectId.isValid(value) && value.length === 24 ? new ObjectId(value) : null;
}

/** Escapes text for use inside a regular expression. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wraps a handler so an unexpected exception becomes a logged 500 instead
 * of an unhandled crash, and never leaks internals to the caller.
 */
export function handle(fn: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async function handler(request: Request): Promise<Response> {
    try {
      return await fn(request);
    } catch (error) {
      console.error('[api] unhandled error', error);
      return errorResponse(500, 'internal_error', 'Something went wrong');
    }
  };
}
