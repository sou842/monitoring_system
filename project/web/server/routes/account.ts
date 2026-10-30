import { clearSessionCookie, createSessionToken, requireUser, sessionCookie } from '../auth.ts';
import { MAX_PROJECTS_PER_USER } from '../constants.ts';
import { collections } from '../db.ts';
import { deleteUser } from '../deletion.ts';
import { bodyObject, errorResponse, handle, json, readJson } from '../http.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords.ts';
import { cleanUserName, userView } from '../users.ts';

/**
 * The logged-in user's own account:
 *
 *   GET    /api/account                          → { user, usage: { projects, projectLimit } } (projectLimit null = none)
 *   PATCH  /api/account  { name }                → rename
 *   PATCH  /api/account  { currentPassword, newPassword } → change password, logs out other sessions
 *   POST   /api/account?action=logout-others     → ends every other session
 *   DELETE /api/account  { password }            → deletes the account and all its projects
 *
 * A wrong current password answers 400 (not 401), so the dashboard doesn't treat it as a lost session.
 */

const MAX_BODY_BYTES = 2048;

export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const projects = await collections(auth.db).projects.countDocuments({ ownerId: auth.user._id });
  return json({ user: userView(auth.user), usage: { projects, projectLimit: MAX_PROJECTS_PER_USER } });
});

export const PATCH = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  const users = collections(db).users;

  if ('newPassword' in input) {
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      return errorResponse(400, 'wrong_password', 'Current password is wrong');
    }
    const problem = passwordProblem(input.newPassword, user.email);
    if (problem) return errorResponse(400, 'weak_password', problem);
    const updated = await users.findOneAndUpdate(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(input.newPassword as string), passwordChangedAt: new Date() }, $inc: { sessionVersion: 1 } },
      { returnDocument: 'after' },
    );
    if (updated === null) return errorResponse(404, 'not_found', 'Account not found');
    // This browser stays logged in with a fresh cookie; every other session is now invalid.
    return json({ user: userView(updated) }, 200, { 'Set-Cookie': sessionCookie(createSessionToken(updated)) });
  }

  const name = cleanUserName(input.name);
  if (name === null) return errorResponse(400, 'invalid_name', 'Enter your name (max 80 characters)');
  const updated = await users.findOneAndUpdate({ _id: user._id }, { $set: { name } }, { returnDocument: 'after' });
  if (updated === null) return errorResponse(404, 'not_found', 'Account not found');
  return json({ user: userView(updated) });
});

export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  if (new URL(request.url).searchParams.get('action') !== 'logout-others') {
    return errorResponse(400, 'invalid_action', 'action must be logout-others');
  }
  const updated = await collections(auth.db).users.findOneAndUpdate(
    { _id: auth.user._id },
    { $inc: { sessionVersion: 1 } },
    { returnDocument: 'after' },
  );
  if (updated === null) return errorResponse(404, 'not_found', 'Account not found');
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(createSessionToken(updated)) });
});

export const DELETE = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  if (!(await verifyPassword(bodyObject(body.value).password, user.passwordHash))) {
    return errorResponse(400, 'wrong_password', 'Password is wrong');
  }
  if (user.role === 'admin' && (await collections(db).users.countDocuments({ role: 'admin' })) <= 1) {
    return errorResponse(400, 'last_admin', 'You are the only admin. Make another user admin before deleting your account.');
  }
  const removed = await deleteUser(db, user._id);
  return json({ deleted: removed }, 200, { 'Set-Cookie': clearSessionCookie() });
});
