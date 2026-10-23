/**
 * Deleting data. An issue's events are stored separately, so they are always
 * removed together with the issue. Screenshots uploaded to Cloudinary are not
 * deleted: that needs the Cloudinary API secret, which this app doesn't hold.
 */

import { clearProjectCache } from './projects.js';

const DELETE_CHUNK = 5000;

/**
 * Deletes every issue matching `filter` (which must include `projectId`)
 * together with all of their events. Returns how many of each were removed.
 */
export async function deleteIssues(db, filter) {
  const ids = (await db.collection('issues').find(filter, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
  let events = 0;
  let issues = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    events += (await db.collection('events').deleteMany({ issueId: { $in: chunk } })).deletedCount;
    issues += (await db.collection('issues').deleteMany({ _id: { $in: chunk } })).deletedCount;
  }
  return { issues, events };
}

/** Deletes a project with all its issues and events. Returns null if it doesn't exist. */
export async function deleteProject(db, projectId) {
  const project = await db.collection('projects').findOne({ _id: projectId }, { projection: { _id: 1 } });
  if (project === null) return null;
  const removed = await deleteIssues(db, { projectId });
  // Events whose issue is already gone (e.g. sent while the delete was running).
  removed.events += (await db.collection('events').deleteMany({ projectId })).deletedCount;
  // Performance data has no issues; it goes with the project.
  await db.collection('transactions').deleteMany({ projectId });
  await db.collection('perf_rollups').deleteMany({ projectId });
  await db.collection('projects').deleteOne({ _id: projectId });
  // The deleted key must stop working right away in this instance.
  clearProjectCache();
  return removed;
}

/** Deletes an account with every project it owns (and their issues and events). */
export async function deleteUser(db, userId) {
  const projectIds = await db.collection('projects').distinct('_id', { ownerId: userId });
  const removed = { projects: 0, issues: 0, events: 0 };
  for (const projectId of projectIds) {
    const counts = await deleteProject(db, projectId);
    if (counts === null) continue;
    removed.projects += 1;
    removed.issues += counts.issues;
    removed.events += counts.events;
  }
  await db.collection('users').deleteOne({ _id: userId });
  return removed;
}
