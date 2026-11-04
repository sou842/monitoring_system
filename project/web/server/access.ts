import type { Db, ObjectId } from 'mongodb';
import { PERMISSIONS, type Permission } from '../lib/permissions.ts';
import { collections } from './db.ts';
import { errorResponse } from './http.ts';
import type { EventDoc, IssueDoc, ProjectDoc, UserDoc } from './models.ts';

/**
 * Access checks. Every dashboard read and write goes through these, so a user
 * only reaches projects they own or are a member of (docs/MEMBERS_AND_CHAT.md),
 * and the issues/events inside them. Callers answer 404 (not 403) when the
 * user has no access at all, so ids of other people's projects aren't even
 * confirmed to exist; a member without a permission gets 403 (`forbidden`).
 */

/** What the logged-in user may do in one project. */
export interface ProjectAccess {
  project: ProjectDoc;
  isOwner: boolean;
  /** Every permission for the owner; the member's own list otherwise. */
  permissions: Permission[];
  can: (permission: Permission) => boolean;
}

function accessFor(project: ProjectDoc, isOwner: boolean, permissions: Permission[]): ProjectAccess {
  const granted = isOwner ? [...PERMISSIONS] : permissions;
  return { project, isOwner, permissions: granted, can: (p) => granted.includes(p) };
}

/** The user's access to a project: owner, member, or null (no access). */
export async function projectAccess(db: Db, user: UserDoc, projectId: ObjectId): Promise<ProjectAccess | null> {
  const c = collections(db);
  const project = await c.projects.findOne({ _id: projectId });
  if (project === null) return null;
  if (project.ownerId && project.ownerId.equals(user._id)) return accessFor(project, true, []);
  const member = await c.members.findOne({ projectId, userId: user._id });
  return member === null ? null : accessFor(project, false, member.permissions);
}

/** Ids of every project the user owns or is a member of. */
export async function accessibleProjectIds(db: Db, user: UserDoc): Promise<ObjectId[]> {
  const c = collections(db);
  const [owned, shared] = await Promise.all([
    c.projects.distinct('_id', { ownerId: user._id }),
    c.members.distinct('projectId', { userId: user._id }),
  ]);
  return [...owned, ...shared];
}

/** The issue and the user's access to its project, or null when they have no access. */
export async function issueAccess(db: Db, user: UserDoc, issueId: ObjectId): Promise<{ issue: IssueDoc; access: ProjectAccess } | null> {
  const issue = await collections(db).issues.findOne({ _id: issueId });
  if (issue === null) return null;
  const access = await projectAccess(db, user, issue.projectId);
  return access === null ? null : { issue, access };
}

/** The event when it belongs to a project the user can see, otherwise null. */
export async function accessibleEvent(db: Db, user: UserDoc, eventId: ObjectId): Promise<EventDoc | null> {
  const event = await collections(db).events.findOne({ _id: eventId });
  if (event === null) return null;
  return (await projectAccess(db, user, event.projectId)) === null ? null : event;
}

/** The 403 answer for a member who lacks `permission`. */
export function forbidden(permission: Permission | 'owner'): Response {
  return errorResponse(403, 'forbidden', permission === 'owner' ? 'Only the project owner can do this' : `You don't have the "${permission}" permission in this project`);
}
