import {
  clearSessionCookie,
  clientIp,
  createSessionToken,
  crossSiteResponse,
  getSessionUser,
  readCookie,
  sessionCookie,
} from '../auth.ts';
import { SESSION_COOKIE } from '../constants.ts';
import { collections, getDb } from '../db.ts';
import { bodyObject, errorResponse, handle, json, readJson } from '../http.ts';
import { burnPasswordCheck, passwordProblem, verifyPassword } from '../passwords.ts';
import { consumeLoginAttempt, consumeSignup, type Budget } from '../rateLimit.ts';
import { cleanUserName, createUser, normalizeEmail, userView } from '../users.ts';

/**
 * Dashboard accounts:
 *
 *   GET  /api/auth                  → { authenticated, user }
 *   POST /api/auth?action=signup    { name, email, password } → 201, sets the session cookie
 *   POST /api/auth?action=login     { email, password }       → sets the session cookie
 *   POST /api/auth?action=logout    → clears the cookie
 */

const MAX_BODY_BYTES = 2048;

export const GET = handle(async (request) => {
  if (readCookie(request, SESSION_COOKIE) === null) return json({ authenticated: false, user: null });
  const user = await getSessionUser(request, await getDb());
  return json({ authenticated: user !== null, user: user ? userView(user) : null });
});

export const POST = handle(async (request) => {
  const blocked = crossSiteResponse(request);
  if (blocked) return blocked;
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  if (action !== 'signup' && action !== 'login') return errorResponse(400, 'invalid_action', 'action must be signup, login or logout');

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  return action === 'signup' ? signup(request, input) : login(request, input);
});

async function signup(request: Request, input: Record<string, unknown>): Promise<Response> {
  const email = normalizeEmail(input.email);
  if (email === null) return errorResponse(400, 'invalid_email', 'Enter a valid email address');
  const name = cleanUserName(input.name);
  if (name === null) return errorResponse(400, 'invalid_name', 'Enter your name (max 80 characters)');
  const problem = passwordProblem(input.password, email);
  if (problem) return errorResponse(400, 'weak_password', problem);
  const password = input.password as string; // passwordProblem() returned null, so it is a valid string

  const db = await getDb();
  const limit = await consumeSignup(db, clientIp(request));
  if (!limit.allowed) return tooMany(limit, 'Too many accounts created from this network. Try again later.');

  const user = await createUser(db, { email, name, password });
  if (user === null) return errorResponse(409, 'email_taken', 'An account with this email already exists. Log in instead.');
  return json({ user: userView(user) }, 201, { 'Set-Cookie': sessionCookie(createSessionToken(user)) });
}

async function login(request: Request, input: Record<string, unknown>): Promise<Response> {
  const email = normalizeEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  if (email === null || password.length === 0) return errorResponse(400, 'invalid_credentials', 'Enter your email and password');

  const db = await getDb();
  const limit = await consumeLoginAttempt(db, clientIp(request), email);
  if (!limit.allowed) return tooMany(limit, 'Too many login attempts. Wait a few minutes and try again.');

  const users = collections(db).users;
  const user = await users.findOne({ email });
  if (user === null) {
    await burnPasswordCheck(password);
    return wrongCredentials();
  }
  if (!(await verifyPassword(password, user.passwordHash))) return wrongCredentials();
  // Checked only after the password, so this doesn't reveal which accounts exist.
  if (user.status !== 'active') return errorResponse(403, 'account_disabled', 'This account has been disabled. Contact the administrator.');

  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return json({ user: userView(user) }, 200, { 'Set-Cookie': sessionCookie(createSessionToken(user)) });
}

function wrongCredentials(): Response {
  return errorResponse(401, 'invalid_credentials', 'Wrong email or password');
}

function tooMany(limit: Budget, message: string): Response {
  return errorResponse(429, 'rate_limited', message, { 'Retry-After': String(limit.retryAfterSeconds) });
}
