import { ObjectId, type Db, type UpdateFilter } from 'mongodb';
import type { EventPayload, PageViewEvent } from '../lib/schema.ts';
import { collections } from './db.ts';
import { culprit, fingerprint } from './grouping.ts';
import type { EventDoc, IssueDoc, ProjectDoc, TransactionDoc } from './models.ts';
import { endpointOf, mergeUpdates, pageRouteOf, rollupUpdates } from './performance.ts';
import { isDuplicateKey } from './users.ts';
import { validateEvent } from './validate.ts';

export interface IngestResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * Stores a batch of events for one project:
 *   validate → group into issues → insert events.
 *
 * Invalid events are rejected individually; valid ones in the same batch are
 * still stored.
 */
export async function ingestEvents({ db, project, rawEvents, now = new Date(), acceptTransactions = true }: {
  db: Db;
  project: Pick<ProjectDoc, '_id'>;
  rawEvents: unknown[];
  now?: Date;
  acceptTransactions?: boolean;
}): Promise<IngestResult> {
  const rejected: IngestResult['rejected'] = [];
  const valid: EventPayload[] = [];
  const pageViews: PageViewEvent[] = [];
  rawEvents.forEach((raw, index) => {
    const result = validateEvent(raw, now);
    if (!result.ok) rejected.push({ index, reason: result.reason });
    else if (result.event.transaction === null) valid.push(result.event);
    else if (acceptTransactions) pageViews.push(result.event as PageViewEvent);
    else rejected.push({ index, reason: 'rate_limited' });
  });
  // Page views never become issues: they feed the Performance view.
  const storedViews = pageViews.length > 0 ? await ingestPageViews(db, project._id, pageViews, now) : 0;
  if (valid.length === 0) return { accepted: storedViews, rejected };

  const projectId = project._id;
  const docs: EventDoc[] = [];
  for (const event of valid) {
    const issue = await upsertIssue(db, projectId, event, now);
    docs.push(eventDocument(projectId, issue._id, event, now));
  }
  await collections(db).events.insertMany(docs, { ordered: false });
  return { accepted: docs.length + storedViews, rejected };
}

/**
 * Stores page views (for "slowest samples", kept a few days) and adds them to
 * the hourly rollups the Performance view reads. Returns how many were stored.
 */
async function ingestPageViews(db: Db, projectId: ObjectId, views: PageViewEvent[], now: Date): Promise<number> {
  const c = collections(db);
  await c.transactions.insertMany(views.map((view) => pageViewDocument(projectId, view, now)), { ordered: false });
  const updates = mergeUpdates(views.flatMap((view) => rollupUpdates(projectId, view, now)));
  await c.rollups.bulkWrite(
    updates.map((update) => ({
      updateOne: {
        filter: update.filter,
        update: { $inc: update.inc, $setOnInsert: update.insert },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return views.length;
}

/** Page view as stored: the route it is grouped under, its timings, and each span's endpoint key. */
function pageViewDocument(projectId: ObjectId, view: PageViewEvent, now: Date): TransactionDoc {
  const t = view.transaction;
  return {
    _id: new ObjectId(),
    projectId,
    receivedAt: now,
    environment: view.environment,
    appVersion: view.app_version,
    userId: view.user.id,
    browser: view.device.browser,
    browserVersion: view.device.browser_version,
    os: view.device.os,
    route: pageRouteOf(view),
    name: t.name,
    screen: view.screen,
    kind: t.kind,
    start: t.start,
    duration_ms: t.duration_ms,
    background: t.background,
    vitals: t.vitals,
    long_tasks: t.long_tasks,
    spans: t.spans.map((span) => ({ ...span, key: endpointOf(span.method, span.url).key })),
    dropped_spans: t.dropped_spans,
  };
}

/**
 * Finds or creates the issue for this event and updates its counters.
 * A resolved issue that happens again is reopened (a regression).
 */
async function upsertIssue(db: Db, projectId: ObjectId, event: EventPayload, now: Date): Promise<IssueDoc> {
  const issues = collections(db).issues;
  const fp = fingerprint(event);
  const update: UpdateFilter<IssueDoc> = {
    $setOnInsert: {
      projectId,
      fingerprint: fp,
      eventType: event.event_type,
      errorType: event.error ? event.error.type : event.event_type,
      message: event.error ? event.error.message : '',
      culprit: culprit(event.stacktrace),
      firstSeen: now,
      status: 'open',
    },
    $set: { lastSeen: now, level: event.level, lastMessage: event.error ? event.error.message : '' },
    $inc: { count: 1 },
    $addToSet: { environments: event.environment, platforms: event.device.platform },
  };
  let issue: IssueDoc | null;
  try {
    issue = await issues.findOneAndUpdate({ projectId, fingerprint: fp }, update, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    // Two requests created the same new issue at once: the loser simply updates it.
    if (!isDuplicateKey(error)) throw error;
    issue = await issues.findOneAndUpdate({ projectId, fingerprint: fp }, update, { returnDocument: 'after' });
  }
  if (issue === null) throw new Error('Issue upsert returned no document');
  if (issue.status === 'resolved') {
    await issues.updateOne({ _id: issue._id }, { $set: { status: 'open', regressedAt: now } });
    issue.status = 'open';
  }
  return issue;
}

/** Event as stored: indexed summary fields plus the full validated payload. */
function eventDocument(projectId: ObjectId, issueId: ObjectId, event: EventPayload, now: Date): EventDoc {
  return {
    _id: new ObjectId(),
    projectId,
    issueId,
    receivedAt: now,
    timestamp: event.timestamp,
    eventType: event.event_type,
    level: event.level,
    environment: event.environment,
    appVersion: event.app_version,
    errorType: event.error ? event.error.type : null,
    message: event.error ? event.error.message : null,
    handled: event.error ? event.error.handled : null,
    userId: event.user.id,
    url: event.device.url,
    screen: event.screen,
    platform: event.device.platform,
    payload: event,
  };
}
