import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, SESSION_TTL_MS } from './constants.js';
import { isProduction, requireEnv } from './env.js';
import { errorResponse } from './http.js';

/**
 * Dashboard login: one shared password (DASHBOARD_PASSWORD). A successful
 * login sets an HttpOnly cookie holding an expiry time signed with
 * SESSION_SECRET, so no session storage is needed.
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

export function checkPassword(candidate) {
  return typeof candidate === 'string' && safeEqual(candidate, requireEnv('DASHBOARD_PASSWORD'));
}

/** Creates a signed session token valid until `now + SESSION_TTL_MS`. */
export function createSessionToken(now = Date.now()) {
  const expires = String(now + SESSION_TTL_MS);
  return `${expires}.${sign(expires)}`;
}

/** True if the token's signature is valid and it hasn't expired. */
export function verifySessionToken(token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expires = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(expires))) return false;
  const expiresAt = Number(expires);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
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

export function isAuthenticated(request) {
  return verifySessionToken(readCookie(request, SESSION_COOKIE));
}

/** Returns a 401 response when the request has no valid session, otherwise null. */
export function requireSession(request) {
  return isAuthenticated(request) ? null : errorResponse(401, 'unauthorized', 'Log in to the dashboard first');
}
