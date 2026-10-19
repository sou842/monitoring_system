import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, SESSION_TTL_MS } from './constants.js';
import { getDb } from './db.js';
import { isProduction, requireEnv } from './env.js';
import { errorResponse, parseObjectId } from './http.js';

/**
 * Dashboard sessions: an HttpOnly cookie holding `{ user id, session version,
 * expiry }`, signed with SESSION_SECRET. Every request re-reads the user, so a
 * disabled account or a bumped session version (password change, "log out
 * other devices") takes effect immediately, without a session store.
 */

function sign(payload) {
  return createHmac('sha256', requireEnv('SESSION_SECRET')).update(payload).digest('base64url');
}

/** Constant-time string comparison (avoids leaking how much of a guess was right). */
export function safeEqual(a, b) {
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
export function createSessionToken(user, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ u: String(user._id), v: user.sessionVersion, e: now + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The token's `{ userId, version }` when its signature is valid and it hasn't expired, otherwise null. */
export function verifySessionToken(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const userId = parseObjectId(data.u);
    if (userId === null || !Number.isInteger(data.v) || !Number.isFinite(data.e) || data.e <= now) return null;
    return { userId, version: data.v };
  } catch {
    return null;
  }
}

export function readCookie(request, name) {
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

export function sessionCookie(token) {
  const secure = isProduction() ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

export function clearSessionCookie() {
  const secure = isProduction() ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** The logged-in, active user for this request, or null. */
export async function getSessionUser(request, db) {
  const session = verifySessionToken(readCookie(request, SESSION_COOKIE));
  if (session === null) return null;
  const user = await db.collection('users').findOne({ _id: session.userId });
  if (user === null || user.status !== 'active' || user.sessionVersion !== session.version) return null;
  return user;
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Refuses state-changing requests sent from another site's page. SameSite=Strict
 * cookies already block this in modern browsers; the Origin check is a second layer.
 */
export function crossSiteResponse(request) {
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

/**
 * For dashboard endpoints: `{ db, user }` for a logged-in user, otherwise
 * `{ response }` with the 401/403 to return.
 */
export async function requireUser(request) {
  const blocked = crossSiteResponse(request);
  if (blocked) return { response: blocked };
  if (readCookie(request, SESSION_COOKIE) === null) return { response: unauthorized() };
  const db = await getDb();
  const user = await getSessionUser(request, db);
  return user === null ? { response: unauthorized() } : { db, user };
}

/** Like `requireUser`, but only for admins (others get 403). */
export async function requireAdmin(request) {
  const auth = await requireUser(request);
  if (auth.response) return auth;
  if (auth.user.role !== 'admin') return { response: errorResponse(403, 'forbidden', 'Admins only') };
  return auth;
}

function unauthorized() {
  return errorResponse(401, 'unauthorized', 'Log in to the dashboard first');
}

/** Client IP for rate limiting. On Vercel the platform sets x-forwarded-for, so it can't be spoofed. */
export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}
