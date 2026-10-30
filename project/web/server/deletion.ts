/**
 * Deleting data. An issue's events are stored separately, so they are always
 * removed together with the issue.
 */

import type { Db, Filter, ObjectId } from 'mongodb';
import { collections } from './db.ts';
import type { IssueDoc } from './models.ts';
import { clearProjectCache } from './projects.ts';

const DELETE_CHUNK = 5000;

export interface DeletedCounts {
  issues: number;
  events: number;
}

/**
 * Deletes every issue matching `filter` (which must include `projectId`)
 * together with all of their events. Returns how many of each were removed.
 */
export async function deleteIssues(db: Db, filter: Filter<IssueDoc>): Promise<DeletedCounts> {
  const c = collections(db);
  const ids = (await c.issues.find(filter, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
  let events = 0;
  let issues = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    events += (await c.events.deleteMany({ issueId: { $in: chunk } })).deletedCount;
    issues += (await c.issues.deleteMany({ _id: { $in: chunk } })).deletedCount;
  }
  return { issues, events };
}

/** Deletes a project with all its issues and events. Returns null if it doesn't exist. */
export async function deleteProject(db: Db, projectId: ObjectId): Promise<DeletedCounts | null> {
  const c = collections(db);
  const project = await c.projects.findOne({ _id: projectId }, { projection: { _id: 1 } });
  if (project === null) return null;
  const removed = await deleteIssues(db, { projectId });
  // Events whose issue is already gone (e.g. sent while the delete was running).
  removed.events += (await c.events.deleteMany({ projectId })).deletedCount;
  // Performance data has no issues; it goes with the project.
  await c.transactions.deleteMany({ projectId });
  await c.rollups.deleteMany({ projectId });
  await c.projects.deleteOne({ _id: projectId });
  // The deleted key must stop working right away in this instance.
  clearProjectCache();
  return removed;
}

/** Deletes an account with every project it owns (and their issues and events). */
export async function deleteUser(db: Db, userId: ObjectId): Promise<{ projects: number; issues: number; events: number }> {
  const c = collections(db);
  const projectIds = await c.projects.distinct('_id', { ownerId: userId });
  const removed = { projects: 0, issues: 0, events: 0 };
  for (const projectId of projectIds) {
    const counts = await deleteProject(db, projectId);
    if (counts === null) continue;
    removed.projects += 1;
    removed.issues += counts.issues;
    removed.events += counts.events;
  }
  await c.users.deleteOne({ _id: userId });
  return removed;
}
