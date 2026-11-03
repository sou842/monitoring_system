import type { Db, Document, ObjectId } from 'mongodb';
import type { ImpactValue, IssueImpact } from '../lib/types.ts';
import { IMPACT_MAX_EVENTS, IMPACT_TOP } from './constants.ts';
import { collections } from './db.ts';

/** Most frequent values of `expr`, as `{ _id, n }` rows. */
function top(expr: unknown): Document[] {
  return [{ $group: { _id: expr, n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: IMPACT_TOP }];
}

/** `{ $count }` facet: how many events match `filter`. */
function countOf(filter: Document): Document[] {
  return [{ $match: filter }, { $count: 'n' }];
}

/** A non-empty string field, else null (old or hand-made events may hold anything). */
function textOrNull(path: string): Document {
  return { $cond: [{ $and: [{ $eq: [{ $type: path }, 'string'] }, { $ne: [path, ''] }] }, path, null] };
}

/** "Chrome 156" from the device's browser and the major part of its version. */
const BROWSER = {
  $trim: {
    input: {
      $concat: [
        { $ifNull: [textOrNull('$payload.device.browser'), '(unknown)'] },
        ' ',
        { $arrayElemAt: [{ $split: [{ $ifNull: [textOrNull('$payload.device.browser_version'), ''] }, '.'] }, 0] },
      ],
    },
  },
};

const firstCount = (rows: unknown): number => (Array.isArray(rows) && rows[0] && typeof rows[0].n === 'number' ? rows[0].n : 0);

const values = (rows: unknown): ImpactValue[] =>
  (Array.isArray(rows) ? rows : []).map((r: Document) => ({ value: r._id === null || r._id === undefined ? '(none)' : String(r._id), count: r.n as number }));

/**
 * Who and where an issue hits, over its newest `IMPACT_MAX_EVENTS` stored
 * events: distinct users, top screens (the `setScreen()` name, else the page
 * URL), browsers and app versions, and from SDK 0.11.0 events, how many
 * happened offline or while the page was still loading. One aggregation on the
 * `{ issueId, receivedAt }` index.
 */
export async function issueImpact(db: Db, issueId: ObjectId): Promise<IssueImpact> {
  const [row] = await collections(db)
    .events.aggregate([
      { $match: { issueId } },
      { $sort: { receivedAt: -1 } },
      { $limit: IMPACT_MAX_EVENTS },
      // Only what the facets read: a full event can be tens of KB, and the page refreshes while open.
      {
        $project: {
          userId: 1,
          screen: 1,
          url: 1,
          appVersion: 1,
          'payload.device.browser': 1,
          'payload.device.browser_version': 1,
          'payload.context.situation.online': 1,
          'payload.context.situation.during_page_load': 1,
        },
      },
      {
        $facet: {
          sampled: [{ $count: 'n' }],
          users: [{ $match: { userId: { $type: 'string', $ne: '' } } }, { $group: { _id: '$userId' } }, { $count: 'n' }],
          anonymous: countOf({ $or: [{ userId: null }, { userId: '' }] }),
          screens: top({ $ifNull: [textOrNull('$screen'), textOrNull('$url')] }),
          browsers: top(BROWSER),
          versions: top(textOrNull('$appVersion')),
          // Events from SDK 0.11.0+ (which send a situation): the share of offline / loading is of these.
          withSituation: countOf({ 'payload.context.situation.online': { $exists: true } }),
          offline: countOf({ 'payload.context.situation.online': false }),
          duringPageLoad: countOf({ 'payload.context.situation.during_page_load': true }),
        },
      },
    ])
    .toArray();
  return {
    sampled: firstCount(row && row.sampled),
    users: firstCount(row && row.users),
    anonymous: firstCount(row && row.anonymous),
    screens: values(row && row.screens),
    browsers: values(row && row.browsers),
    versions: values(row && row.versions),
    withSituation: firstCount(row && row.withSituation),
    offline: firstCount(row && row.offline),
    duringPageLoad: firstCount(row && row.duringPageLoad),
  };
}
