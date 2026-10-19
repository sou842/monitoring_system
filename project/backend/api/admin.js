import { requireAdmin } from '../lib/auth.js';
import { ADMIN_USERS_LIMIT, USER_ROLES, USER_STATUSES } from '../lib/constants.js';
import { deleteUser } from '../lib/deletion.js';
import { errorResponse, handle, json, parseObjectId, readJson } from '../lib/http.js';
import { clearProjectCache } from '../lib/projects.js';
import { userView } from '../lib/users.js';

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

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const GET = handle(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const { db } = auth;

  const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, MAX_SEARCH_LENGTH);
  const filter = q ? { $or: [{ email: new RegExp(escapeRegex(q), 'i') }, { name: new RegExp(escapeRegex(q), 'i') }] } : {};
  const since = new Date(Date.now() - DAY_MS);

  const [users, totalUsers, disabledUsers, admins, projects, recentEvents] = await Promise.all([
    db.collection('users').find(filter).sort({ createdAt: -1 }).limit(ADMIN_USERS_LIMIT).toArray(),
    db.collection('users').countDocuments(),
    db.collection('users').countDocuments({ status: 'disabled' }),
    db.collection('users').countDocuments({ role: 'admin' }),
    db.collection('projects').find({}, { projection: { ownerId: 1 } }).toArray(),
    db.collection('events').aggregate([{ $match: { receivedAt: { $gte: since } } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }]).toArray(),
  ]);

  const ownerOf = new Map(projects.map((p) => [String(p._id), p.ownerId ? String(p.ownerId) : null]));
  const projectCount = new Map();
  for (const p of projects) if (p.ownerId) projectCount.set(String(p.ownerId), (projectCount.get(String(p.ownerId)) || 0) + 1);
  const eventCount = new Map();
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

/** Shared checks for PATCH and DELETE: a valid id, an existing user, and not yourself. */
async function targetUser(auth, request) {
  const id = parseObjectId(new URL(request.url).searchParams.get('id'));
  if (id === null) return { response: errorResponse(400, 'invalid_id', 'Missing or invalid user id') };
  if (String(id) === String(auth.user._id)) {
    return { response: errorResponse(400, 'self', 'Use the Account page to change your own account') };
  }
  const user = await auth.db.collection('users').findOne({ _id: id });
  return user === null ? { response: errorResponse(404, 'not_found', 'User not found') } : { user };
}

export const PATCH = handle(async (request) => {
  const auth = await requireAdmin(request);
  if (auth.response) return auth.response;
  const target = await targetUser(auth, request);
  if (target.response) return target.response;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = body.value && typeof body.value === 'object' ? body.value : {};
  const users = auth.db.collection('users');
  const id = target.user._id;

  let updated;
  if ('status' in input) {
    if (!USER_STATUSES.includes(input.status)) return errorResponse(400, 'invalid_status', `status must be one of ${USER_STATUSES.join(', ')}`);
    const disable = input.status === 'disabled';
    updated = await users.findOneAndUpdate(
      { _id: id },
      // Bumping the session version logs a disabled user out of every browser at once.
      disable ? { $set: { status: 'disabled', disabledAt: new Date() }, $inc: { sessionVersion: 1 } } : { $set: { status: 'active' }, $unset: { disabledAt: '' } },
      { returnDocument: 'after' },
    );
    await auth.db.collection('projects').updateMany({ ownerId: id }, disable ? { $set: { disabled: true } } : { $unset: { disabled: '' } });
    clearProjectCache();
  } else if ('role' in input) {
    if (!USER_ROLES.includes(input.role)) return errorResponse(400, 'invalid_role', `role must be one of ${USER_ROLES.join(', ')}`);
    updated = await users.findOneAndUpdate({ _id: id }, { $set: { role: input.role } }, { returnDocument: 'after' });
  } else {
    return errorResponse(400, 'invalid_body', 'Send { status } or { role }');
  }
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
