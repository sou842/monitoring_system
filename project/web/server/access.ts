import type { Db, ObjectId } from 'mongodb';
import { collections } from './db.ts';
import type { EventDoc, IssueDoc, ProjectDoc, UserDoc } from './models.ts';

/**
 * Ownership checks. Every dashboard read and write goes through these, so a
 * user can only reach their own projects and the issues/events inside them.
 * Callers answer 404 (not 403) for someone else's data, so ids of other
 * users' projects aren't even confirmed to exist.
 */

/** The project when `user` owns it, otherwise null. */
export function ownedProject(db: Db, user: UserDoc, projectId: ObjectId): Promise<ProjectDoc | null> {
  return collections(db).projects.findOne({ _id: projectId, ownerId: user._id });
}

/** Ids of every project `user` owns. */
export function ownedProjectIds(db: Db, user: UserDoc): Promise<ObjectId[]> {
  return collections(db).projects.distinct('_id', { ownerId: user._id });
}

/** The issue when it belongs to one of `user`'s projects, otherwise null. */
export async function ownedIssue(db: Db, user: UserDoc, issueId: ObjectId): Promise<IssueDoc | null> {
  const issue = await collections(db).issues.findOne({ _id: issueId });
  if (issue === null) return null;
  return (await ownedProject(db, user, issue.projectId)) === null ? null : issue;
}

/** The event when it belongs to one of `user`'s projects, otherwise null. */
export async function ownedEvent(db: Db, user: UserDoc, eventId: ObjectId): Promise<EventDoc | null> {
  const event = await collections(db).events.findOne({ _id: eventId });
  if (event === null) return null;
  return (await ownedProject(db, user, event.projectId)) === null ? null : event;
}
