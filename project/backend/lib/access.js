/**
 * Ownership checks. Every dashboard read and write goes through these, so a
 * user can only reach their own projects and the issues/events inside them.
 * Callers answer 404 (not 403) for someone else's data, so ids of other
 * users' projects aren't even confirmed to exist.
 */

/** The project when `user` owns it, otherwise null. */
export function ownedProject(db, user, projectId) {
  return db.collection('projects').findOne({ _id: projectId, ownerId: user._id });
}

/** Ids of every project `user` owns. */
export function ownedProjectIds(db, user) {
  return db.collection('projects').distinct('_id', { ownerId: user._id });
}

/** The issue when it belongs to one of `user`'s projects, otherwise null. */
export async function ownedIssue(db, user, issueId) {
  const issue = await db.collection('issues').findOne({ _id: issueId });
  if (issue === null) return null;
  return (await ownedProject(db, user, issue.projectId)) === null ? null : issue;
}

/** The event when it belongs to one of `user`'s projects, otherwise null. */
export async function ownedEvent(db, user, eventId) {
  const event = await db.collection('events').findOne({ _id: eventId });
  if (event === null) return null;
  return (await ownedProject(db, user, event.projectId)) === null ? null : event;
}
