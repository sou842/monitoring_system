import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, ObjectId } from 'mongodb';
import { SESSION_COOKIE, SESSION_TTL_MS } from './constants.ts';
import { collections, getDb } from './db.ts';
import { isProduction, requireEnv } from './env.ts';
import { errorResponse, parseObjectId } from './http.ts';
import type { UserDoc } from './models.ts';

/**
 * Dashboard sessions: an HttpOnly cookie holding `{ user id, session version,
 * expiry }`, signed with SESSION_SECRET. Every request re-reads the user, so a
 * disabled account or a bumped session version (password change, "log out
 * other devices") takes effect immediately, without a session store.
 */

function sign(payload: string): string {
  return createHmac('sha256', requireEnv('SESSION_SECRET')).update(payload).digest('base64url');
}

/** Constant-time string comparison (avoids leaking how much of a guess was right). */
export function safeEqual(a: unknown, b: unknown): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still do a comparison so timing doesn't reveal the length mismatch early.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Signed token for `user`, valid until `now + SESSION_TTL_MS`. */
export function createSessionToken(user: Pick<UserDoc, '_id' | 'sessionVersion'>, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: String(user._id), v: user.sessionVersion, e: now + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The token's `{ userId, version }` when its signature is valid and it hasn't expired, otherwise null. */
export function verifySessionToken(token: unknown, now = Date.now()): { userId: ObjectId; version: number } | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; v?: unknown; e?: unknown };
    const userId = parseObjectId(data.u);
    if (userId === null || !Number.isInteger(data.v) || typeof data.e !== 'number' || !Number.isFinite(data.e) || data.e <= now) return null;
    return { userId, version: data.v as number };
  } catch {
    return null;
  }
}

/** One cookie's value from the request's Cookie header, or null. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Set-Cookie value that logs this browser in with `token`. */
export function sessionCookie(token: string): string {
  const secure = isProduction() ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

/** Set-Cookie value that logs this browser out. */
export function clearSessionCookie(): string {
  const secure = isProduction() ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** The active user a session token belongs to, or null (bad token, disabled account, old session). */
export async function userForSessionToken(db: Db, token: unknown): Promise<UserDoc | null> {
  const session = verifySessionToken(token);
  if (session === null) return null;
  const user = await collections(db).users.findOne({ _id: session.userId });
  if (user === null || user.status !== 'active' || user.sessionVersion !== session.version) return null;
  return user;
}

/** The logged-in, active user for this request, or null. */
export function getSessionUser(request: Request, db: Db): Promise<UserDoc | null> {
  return userForSessionToken(db, readCookie(request, SESSION_COOKIE));
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Refuses state-changing requests sent from another site's page. SameSite=Strict
 * cookies already block this in modern browsers; the Origin check is a second layer.
 */
export function crossSiteResponse(request: Request): Response | null {
  if (SAFE_METHODS.includes(request.method)) return null;
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const host = request.headers.get('host') || new URL(request.url).host;
  try {
    if (new URL(origin).host === host) return null;
  } catch {
    // Unparseable Origin: refuse below.
  }
  return errorResponse(403, 'cross_site_request', 'Request refused: it did not come from the dashboard');
}

export type AuthResult = { response: Response } | { response?: undefined; db: Db; user: UserDoc };

/**
 * For dashboard endpoints: `{ db, user }` for a logged-in user, otherwise
 * `{ response }` with the 401/403 to return.
 */
export async function requireUser(request: Request): Promise<AuthResult> {
  const blocked = crossSiteResponse(request);
  if (blocked) return { response: blocked };
  if (readCookie(request, SESSION_COOKIE) === null) return { response: unauthorized() };
  const db = await getDb();
  const user = await getSessionUser(request, db);
  return user === null ? { response: unauthorized() } : { db, user };
}

/** Like `requireUser`, but only for admins (others get 403). */
export async function requireAdmin(request: Request): Promise<AuthResult> {
  const auth = await requireUser(request);
  if (auth.response) return auth;
  if (auth.user.role !== 'admin') return { response: errorResponse(403, 'forbidden', 'Admins only') };
  return auth;
}

function unauthorized(): Response {
  return errorResponse(401, 'unauthorized', 'Log in to the dashboard first');
}

/** Client IP for rate limiting. On Vercel the platform sets x-forwarded-for, so it can't be spoofed. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}
