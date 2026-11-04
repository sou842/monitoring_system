import { cleanPermissions, DEFAULT_MEMBER_PERMISSIONS, type Permission } from '../../lib/permissions.ts';
import { forbidden, projectAccess, type ProjectAccess } from '../access.ts';
import { requireUser } from '../auth.ts';
import { MAX_MEMBERS_PER_PROJECT, MEMBER_ADDS_PER_HOUR, MEMBER_ADD_WINDOW_MS } from '../constants.ts';
import { collections } from '../db.ts';
import { bodyObject, errorResponse, handle, json, parseObjectId, readJson } from '../http.ts';
import { addMember, projectPeople, removeMember } from '../members.ts';
import { consume } from '../rateLimit.ts';
import { normalizeEmail } from '../users.ts';

const MAX_BODY_BYTES = 2048;

/**
 * Delegation limits for members who manage members (the owner has none): they can hand out only
 * permissions they hold themselves, and cannot change or remove another manager. Otherwise one
 * member could add a second account of their own with powers they were never given.
 */
const CANNOT_GRANT = 'You can only give permissions you have yourself';
const CANNOT_TOUCH_MANAGER = 'Only the project owner can change or remove another member manager';
const grantsMoreThanHeld = (access: ProjectAccess, permissions: Permission[]) => !access.isOwner && permissions.some((p) => !access.can(p));

/**
 * GET    /api/projects/members?projectId=…  owner + members (any member can see the list)
 * POST   /api/projects/members?projectId=…  `{ email, permissions? }` adds an existing account (`members.manage`)
 * PATCH  /api/projects/members?projectId=…  `{ memberId, permissions }` changes a member's permissions (`members.manage`)
 * DELETE /api/projects/members?projectId=…&memberId=…  removes a member (`members.manage`); a member may remove themselves
 */
export const GET = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const projectId = parseObjectId(new URL(request.url).searchParams.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  const access = await projectAccess(auth.db, auth.user, projectId);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');
  const people = await projectPeople(auth.db, access.project);
  return json({ ...people, isOwner: access.isOwner, permissions: access.permissions, canManage: access.can('members.manage'), limit: MAX_MEMBERS_PER_PROJECT });
});

export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const projectId = parseObjectId(new URL(request.url).searchParams.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  const access = await projectAccess(db, user, projectId);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');
  if (!access.can('members.manage')) return forbidden('members.manage');

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  const email = normalizeEmail(input.email);
  if (email === null) return errorResponse(400, 'invalid_email', 'Enter a valid email address');
  const permissions = 'permissions' in input ? cleanPermissions(input.permissions) : [...DEFAULT_MEMBER_PERMISSIONS];
  if (permissions === null) return errorResponse(400, 'invalid_permissions', 'permissions must be a list of known permission names');
  if (grantsMoreThanHeld(access, permissions)) return errorResponse(403, 'forbidden', CANNOT_GRANT);

  // Adding by email shows whether an account exists, so the number of tries is limited.
  const budget = await consume(db, `member-add:${user._id}`, 1, MEMBER_ADDS_PER_HOUR, MEMBER_ADD_WINDOW_MS);
  if (!budget.allowed) return errorResponse(429, 'rate_limited', 'Too many tries, wait a while', { 'Retry-After': String(budget.retryAfterSeconds) });

  const target = await collections(db).users.findOne({ email });
  if (target === null || target.status !== 'active') return errorResponse(404, 'no_account', 'No account with this email. They need to sign up first.');
  if (access.project.ownerId && access.project.ownerId.equals(target._id)) return errorResponse(409, 'is_owner', 'This person owns the project');
  if ((await collections(db).members.countDocuments({ projectId })) >= MAX_MEMBERS_PER_PROJECT) {
    return errorResponse(403, 'member_limit', `A project can have at most ${MAX_MEMBERS_PER_PROJECT} members`);
  }
  if ((await addMember(db, projectId, target._id, permissions, user._id)) === null) return errorResponse(409, 'already_member', 'Already a member of this project');

  const people = await projectPeople(db, access.project);
  return json({ ...people, isOwner: access.isOwner, permissions: access.permissions, canManage: true, limit: MAX_MEMBERS_PER_PROJECT }, 201);
});

export const PATCH = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const projectId = parseObjectId(new URL(request.url).searchParams.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  const access = await projectAccess(db, user, projectId);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');
  if (!access.can('members.manage')) return forbidden('members.manage');

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  const memberId = parseObjectId(input.memberId);
  if (memberId === null) return errorResponse(400, 'invalid_member', 'Missing or invalid memberId');
  const permissions = cleanPermissions(input.permissions);
  if (permissions === null) return errorResponse(400, 'invalid_permissions', 'permissions must be a list of known permission names');

  const member = await collections(db).members.findOne({ _id: memberId, projectId });
  if (member === null) return errorResponse(404, 'not_found', 'Member not found');
  // A member can't change their own permissions (nobody grants themselves more, or locks themselves out by accident).
  if (member.userId.equals(user._id)) return errorResponse(403, 'forbidden', 'You cannot change your own permissions');
  if (!access.isOwner && member.permissions.includes('members.manage')) return errorResponse(403, 'forbidden', CANNOT_TOUCH_MANAGER);
  // Only newly granted permissions count: a member keeps what they already had.
  if (grantsMoreThanHeld(access, permissions.filter((p) => !member.permissions.includes(p)))) return errorResponse(403, 'forbidden', CANNOT_GRANT);
  await collections(db).members.updateOne({ _id: memberId }, { $set: { permissions, updatedAt: new Date() } });
  const people = await projectPeople(db, access.project);
  return json({ ...people, isOwner: access.isOwner, permissions: access.permissions, canManage: true, limit: MAX_MEMBERS_PER_PROJECT });
});

export const DELETE = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const { db, user } = auth;
  const params = new URL(request.url).searchParams;
  const projectId = parseObjectId(params.get('projectId'));
  if (projectId === null) return errorResponse(400, 'invalid_project', 'Missing or invalid projectId');
  const memberId = parseObjectId(params.get('memberId'));
  if (memberId === null) return errorResponse(400, 'invalid_member', 'Missing or invalid memberId');
  const access = await projectAccess(db, user, projectId);
  if (access === null) return errorResponse(404, 'not_found', 'Project not found');

  const member = await collections(db).members.findOne({ _id: memberId, projectId });
  if (member === null) return errorResponse(404, 'not_found', 'Member not found');
  const leaving = member.userId.equals(user._id);
  if (!leaving && !access.can('members.manage')) return forbidden('members.manage');
  if (!leaving && !access.isOwner && member.permissions.includes('members.manage')) return errorResponse(403, 'forbidden', CANNOT_TOUCH_MANAGER);
  await removeMember(db, projectId, member.userId);
  return json({ removed: true, left: leaving });
});
