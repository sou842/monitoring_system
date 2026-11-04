import { ObjectId, type Db } from 'mongodb';
import type { Permission } from '../lib/permissions.ts';
import { collections } from './db.ts';
import type { ProjectDoc } from './models.ts';

/**
 * Project members (docs/MEMBERS_AND_CHAT.md): the owner (`projects.ownerId`) plus
 * one `project_members` row per added user, each with its own permissions.
 */

export interface PersonView {
  id: string;
  name: string;
  email: string;
}

export interface MemberView extends PersonView {
  /** The membership row id (used to change or remove it). */
  memberId: string;
  permissions: Permission[];
  addedAt: Date;
}

/** Owner and members of a project, with names and emails (members oldest first). */
export async function projectPeople(db: Db, project: ProjectDoc): Promise<{ owner: PersonView | null; members: MemberView[] }> {
  const c = collections(db);
  const rows = await c.members.find({ projectId: project._id }).sort({ createdAt: 1 }).toArray();
  const ids = [...rows.map((r) => r.userId), ...(project.ownerId ? [project.ownerId] : [])];
  const users = await c.users.find({ _id: { $in: ids } }, { projection: { name: 1, email: 1 } }).toArray();
  const person = (id: ObjectId): PersonView | null => {
    const u = users.find((x) => x._id.equals(id));
    return u ? { id: String(u._id), name: u.name, email: u.email } : null;
  };
  const members: MemberView[] = [];
  for (const row of rows) {
    const p = person(row.userId);
    if (p) members.push({ ...p, memberId: String(row._id), permissions: row.permissions, addedAt: row.createdAt });
  }
  return { owner: project.ownerId ? person(project.ownerId) : null, members };
}

/** Ids of everyone who can see the project (owner first). */
export async function projectUserIds(db: Db, project: ProjectDoc): Promise<ObjectId[]> {
  const memberIds = await collections(db).members.distinct('userId', { projectId: project._id });
  return [...(project.ownerId ? [project.ownerId] : []), ...memberIds];
}

/** Adds `userId` to the project. Returns false when they already are a member (unique index). */
export async function addMember(db: Db, projectId: ObjectId, userId: ObjectId, permissions: Permission[], addedBy: ObjectId, now = new Date()): Promise<{ id: ObjectId } | null> {
  const _id = new ObjectId();
  try {
    await collections(db).members.insertOne({ _id, projectId, userId, permissions, addedBy, createdAt: now, updatedAt: now });
    return { id: _id };
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: unknown }).code === 11000) return null;
    throw error;
  }
}

/** Removes a membership and the user's chat read marker for that project. */
export async function removeMember(db: Db, projectId: ObjectId, userId: ObjectId): Promise<void> {
  const c = collections(db);
  await c.members.deleteOne({ projectId, userId });
  await c.chatReads.deleteOne({ projectId, userId });
}
