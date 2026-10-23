import { ISSUE_EVENT_TYPES as EVENT_TYPES, STATS_RANGES, TOP_ISSUES_LIMIT } from './constants.js';

/**
 * Numbers for the dashboard overview: events per time bucket (split by type),
 * the same total for the previous period, issue counts per status and the
 * issues that produced the most events in the range.
 *
 * @param {import('mongodb').Db} db
 * @param {{ projectIds: import('mongodb').ObjectId[], range: keyof typeof STATS_RANGES, now?: Date }} options
 *   `projectIds`: the projects to include (the caller's own projects, or one of them).
 */
export async function computeStats(db, { projectIds, range, now = new Date() }) {
  const { buckets, stepMs } = STATS_RANGES[range];
  const start = new Date(now.getTime() - buckets * stepMs);
  const previousStart = new Date(start.getTime() - buckets * stepMs);
  const scope = { projectId: { $in: projectIds } };
  const events = db.collection('events');
  const issues = db.collection('issues');

  const [bucketRows, previousTotal, statusRows, topRows] = await Promise.all([
    events.aggregate([
      { $match: { ...scope, receivedAt: { $gte: start } } },
      { $group: { _id: { b: { $floor: { $divide: [{ $subtract: ['$receivedAt', start] }, stepMs] } }, t: '$eventType' }, n: { $sum: 1 } } },
    ]).toArray(),
    events.countDocuments({ ...scope, receivedAt: { $gte: previousStart, $lt: start } }),
    issues.aggregate([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    events.aggregate([
      { $match: { ...scope, receivedAt: { $gte: start } } },
      { $group: { _id: '$issueId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: TOP_ISSUES_LIMIT },
    ]).toArray(),
  ]);

  const series = Array.from({ length: buckets }, (_, i) => ({
    start: new Date(start.getTime() + i * stepMs).toISOString(),
    ...Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])),
  }));
  const byType = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0]));
  for (const row of bucketRows) {
    const index = Math.min(Math.max(row._id.b, 0), buckets - 1);
    if (!(row._id.t in byType)) continue;
    series[index][row._id.t] += row.n;
    byType[row._id.t] += row.n;
  }

  const statuses = { open: 0, resolved: 0, ignored: 0 };
  for (const row of statusRows) if (row._id in statuses) statuses[row._id] = row.n;

  const topDocs = await issues.find({ _id: { $in: topRows.map((row) => row._id) } }).toArray();
  const topIssues = topRows
    .map((row) => {
      const issue = topDocs.find((doc) => String(doc._id) === String(row._id));
      return issue && { id: String(issue._id), projectId: String(issue.projectId), eventType: issue.eventType, errorType: issue.errorType, message: issue.message, status: issue.status, count: row.n };
    })
    .filter(Boolean);

  return {
    range,
    stepMs,
    total: Object.values(byType).reduce((sum, n) => sum + n, 0),
    previousTotal,
    byType,
    series,
    statuses,
    topIssues,
  };
}
