import type { Filter } from 'mongodb';
import { requireAdmin, type AuthResult } from '../auth.ts';
import { ADMIN_USERS_LIMIT, USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from '../constants.ts';
import { collections } from '../db.ts';
import { deleteUser } from '../deletion.ts';
import { bodyObject, errorResponse, escapeRegex, handle, json, parseObjectId, readJson } from '../http.ts';
import type { UserDoc } from '../models.ts';
import { clearProjectCache } from '../projects.ts';
import { userView } from '../users.ts';

/**
 * Admin console (admins only). Admins manage accounts; they do not get to
 * read other users' issues or events.
 *
 *   GET    /api/admin?q=…            → { totals, users: [...] }
 *   PATCH  /api/admin?id=…  { status: "active" | "disabled" } or { role: "user" | "admin" }
 *   DELETE /api/admin?id=…           → deletes the user and all their projects
 *
 * Disabling a user logs them out everywhere and makes their projects refuse new events.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 512;
const MAX_SEARCH_LENGTH = 100;

export const GET = handle(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const c = collections(auth.db);

  const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, MAX_SEARCH_LENGTH);
  const filter: Filter<UserDoc> = q ? { $or: [{ email: new RegExp(escapeRegex(q), 'i') }, { name: new RegExp(escapeRegex(q), 'i') }] } : {};
  const since = new Date(Date.now() - DAY_MS);

  const [users, totalUsers, disabledUsers, admins, projects, recentEvents] = await Promise.all([
    c.users.find(filter).sort({ createdAt: -1 }).limit(ADMIN_USERS_LIMIT).toArray(),
    c.users.countDocuments(),
    c.users.countDocuments({ status: 'disabled' }),
    c.users.countDocuments({ role: 'admin' }),
    c.projects.find({}, { projection: { ownerId: 1 } }).toArray(),
    c.events.aggregate<{ _id: unknown; n: number }>([{ $match: { receivedAt: { $gte: since } } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }]).toArray(),
  ]);

  const ownerOf = new Map(projects.map((p) => [String(p._id), p.ownerId ? String(p.ownerId) : null]));
  const projectCount = new Map<string, number>();
  for (const p of projects) if (p.ownerId) projectCount.set(String(p.ownerId), (projectCount.get(String(p.ownerId)) || 0) + 1);
  const eventCount = new Map<string, number>();
  let events24h = 0;
  for (const row of recentEvents) {
    events24h += row.n;
    const owner = ownerOf.get(String(row._id));
    if (owner) eventCount.set(owner, (eventCount.get(owner) || 0) + row.n);
  }

  return json({
    totals: {
      users: totalUsers,
      disabledUsers,
      admins,
      projects: projects.length,
      unownedProjects: projects.filter((p) => !p.ownerId).length,
      events24h,
    },
    users: users.map((u) => ({
      ...userView(u),
      projects: projectCount.get(String(u._id)) || 0,
      events24h: eventCount.get(String(u._id)) || 0,
    })),
    truncated: users.length === ADMIN_USERS_LIMIT,
  });
});

type Admin = Exclude<AuthResult, { response: Response }>;

/** Shared checks for PATCH and DELETE: a valid id, an existing user, and not yourself. */
async function targetUser(auth: Admin, request: Request): Promise<{ response: Response } | { response?: undefined; user: UserDoc }> {
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return { response: errorResponse(400, 'invalid_id', 'Missing or invalid user id') };
  if (String(id) === String(auth.user._id)) {
    return { response: errorResponse(400, 'self', 'Use the Account page to change your own account') };
  }
  const user = await collections(auth.db).users.findOne({ _id: id });
  return user === null ? { response: errorResponse(404, 'not_found', 'User not found') } : { user };
}

export const PATCH = handle(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const target = await targetUser(auth, request);
  if (target.response) return target.response;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  const c = collections(auth.db);
  const id = target.user._id;

  let updated: UserDoc | null;
  if ('status' in input) {
    if (!(USER_STATUSES as readonly unknown[]).includes(input.status)) return errorResponse(400, 'invalid_status', `status must be one of ${USER_STATUSES.join(', ')}`);
    const disable = (input.status as UserStatus) === 'disabled';
    updated = await c.users.findOneAndUpdate(
      { _id: id },
      // Bumping the session version logs a disabled user out of every browser at once.
      disable ? { $set: { status: 'disabled', disabledAt: new Date() }, $inc: { sessionVersion: 1 } } : { $set: { status: 'active' }, $unset: { disabledAt: '' } },
      { returnDocument: 'after' },
    );
    await c.projects.updateMany({ ownerId: id }, disable ? { $set: { disabled: true } } : { $unset: { disabled: '' } });
    clearProjectCache();
  } else if ('role' in input) {
    if (!(USER_ROLES as readonly unknown[]).includes(input.role)) return errorResponse(400, 'invalid_role', `role must be one of ${USER_ROLES.join(', ')}`);
    updated = await c.users.findOneAndUpdate({ _id: id }, { $set: { role: input.role as UserRole } }, { returnDocument: 'after' });
  } else {
    return errorResponse(400, 'invalid_body', 'Send { status } or { role }');
  }
  if (updated === null) return errorResponse(404, 'not_found', 'User not found');
  return json({ user: userView(updated) });
});

export const DELETE = handle(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const target = await targetUser(auth, request);
  if (target.response) return target.response;
  const removed = await deleteUser(auth.db, target.user._id);
  clearProjectCache();
  return json({ deleted: removed });
});
