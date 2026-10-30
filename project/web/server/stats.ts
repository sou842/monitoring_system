import type { Db, ObjectId } from 'mongodb';
import { ISSUE_EVENT_TYPES, ISSUE_STATUSES, type IssueStatus } from '../lib/schema.ts';
import type { StatsBucket, StatsResponse, TopIssue } from '../lib/types.ts';
import { STATS_RANGES, TOP_ISSUES_LIMIT, type StatsRange } from './constants.ts';
import { collections } from './db.ts';

/**
 * Numbers for the dashboard overview: events per time bucket (split by type),
 * the same total for the previous period, issue counts per status and the
 * issues that produced the most events in the range.
 *
 * `projectIds`: the projects to include (the caller's own projects, or one of them).
 */
export async function computeStats(db: Db, { projectIds, range, now = new Date() }: { projectIds: ObjectId[]; range: StatsRange; now?: Date }): Promise<StatsResponse> {
  const { buckets, stepMs } = STATS_RANGES[range];
  const start = new Date(now.getTime() - buckets * stepMs);
  const previousStart = new Date(start.getTime() - buckets * stepMs);
  const scope = { projectId: { $in: projectIds } };
  const { events, issues } = collections(db);

  const [bucketRows, previousTotal, statusRows, topRows] = await Promise.all([
    events.aggregate<{ _id: { b: number; t: string }; n: number }>([
      { $match: { ...scope, receivedAt: { $gte: start } } },
      { $group: { _id: { b: { $floor: { $divide: [{ $subtract: ['$receivedAt', start] }, stepMs] } }, t: '$eventType' }, n: { $sum: 1 } } },
    ]).toArray(),
    events.countDocuments({ ...scope, receivedAt: { $gte: previousStart, $lt: start } }),
    issues.aggregate<{ _id: string; n: number }>([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    events.aggregate<{ _id: ObjectId; n: number }>([
      { $match: { ...scope, receivedAt: { $gte: start } } },
      { $group: { _id: '$issueId', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: TOP_ISSUES_LIMIT },
    ]).toArray(),
  ]);

  const emptyCounts = () => ({ error: 0, message: 0, performance: 0, crash: 0 });
  const series: StatsBucket[] = Array.from({ length: buckets }, (_, i) => ({
    start: new Date(start.getTime() + i * stepMs).toISOString(),
    ...emptyCounts(),
  }));
  const byType: Record<string, number> = emptyCounts();
  for (const row of bucketRows) {
    const index = Math.min(Math.max(row._id.b, 0), buckets - 1);
    const type = row._id.t;
    if (!(ISSUE_EVENT_TYPES as readonly string[]).includes(type)) continue;
    series[index][type as (typeof ISSUE_EVENT_TYPES)[number]] += row.n;
    byType[type] += row.n;
  }

  const statuses: Record<IssueStatus, number> = { open: 0, resolved: 0, ignored: 0 };
  for (const row of statusRows) if ((ISSUE_STATUSES as readonly string[]).includes(row._id)) statuses[row._id as IssueStatus] = row.n;

  const topDocs = await issues.find({ _id: { $in: topRows.map((row) => row._id) } }).toArray();
  const topIssues = topRows
    .map((row): TopIssue | null => {
      const issue = topDocs.find((doc) => String(doc._id) === String(row._id));
      return issue ? { id: String(issue._id), projectId: String(issue.projectId), eventType: issue.eventType, errorType: issue.errorType, message: issue.message, status: issue.status, count: row.n } : null;
    })
    .filter((issue): issue is TopIssue => issue !== null);

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
