import { PERFORMANCE_TABLE_LIMIT, SLOWEST_SAMPLES_LIMIT, STATS_RANGES, TRANSACTION_RETENTION_DAYS, SECONDS_PER_DAY } from './constants.js';
import {
  combineRows,
  endpointSummary,
  isFailure,
  pageSummary,
  percentile,
  rollupHour,
  vitalSummary,
  VITALS,
} from './performance.js';

/**
 * Numbers for the dashboard's Performance view, read from hourly rollups
 * (see lib/performance.js) and, for "slowest samples", from stored page views.
 */

const MS_PER_SECOND = 1000;

function timeWindow(range, now) {
  const { buckets, stepMs } = STATS_RANGES[range];
  const start = new Date(now.getTime() - buckets * stepMs);
  return { buckets, stepMs, start };
}

function rollupFilter(projectIds, start, environment, extra = {}) {
  const filter = { projectId: { $in: projectIds }, hour: { $gte: rollupHour(start) }, ...extra };
  if (environment) filter.environment = environment;
  return filter;
}

function bucketIndex(hour, start, stepMs, buckets) {
  return Math.min(Math.max(Math.floor((hour.getTime() - start.getTime()) / stepMs), 0), buckets - 1);
}

function emptySeries(start, stepMs, buckets) {
  return Array.from({ length: buckets }, (_, i) => ({ start: new Date(start.getTime() + i * stepMs).toISOString(), rows: [] }));
}

function round(value) {
  return value === null ? null : Math.round(value);
}

/** Raw page views exist only for the last few days; samples can't go further back. */
function samplesSince(start, now) {
  const oldest = new Date(now.getTime() - TRANSACTION_RETENTION_DAYS * SECONDS_PER_DAY * MS_PER_SECOND);
  return start > oldest ? start : oldest;
}

/**
 * Overview: Web Vitals (p75 with Google's rating), totals, a request-latency
 * series, and the pages and endpoints tables.
 *
 * @param {import('mongodb').Db} db
 * @param {{ projectIds: import('mongodb').ObjectId[], range: keyof typeof STATS_RANGES, environment?: string | null, now?: Date }} options
 */
export async function computePerformance(db, { projectIds, range, environment = null, now = new Date() }) {
  const { buckets, stepMs, start } = timeWindow(range, now);
  const rollups = db.collection('perf_rollups');
  const [rows, environments] = await Promise.all([
    rollups.find(rollupFilter(projectIds, start, environment), { projection: { _id: 0 } }).toArray(),
    rollups.distinct('environment', rollupFilter(projectIds, start, null)),
  ]);

  const pages = new Map();
  const endpoints = new Map();
  const series = emptySeries(start, stepMs, buckets);
  for (const row of rows) {
    const groups = row.kind === 'page' ? pages : endpoints;
    if (!groups.has(row.key)) groups.set(row.key, { labels: row, rows: [] });
    groups.get(row.key).rows.push(row);
    series[bucketIndex(row.hour, start, stepMs, buckets)].rows.push(row);
  }

  const allPages = combineRows([...pages.values()].flatMap((g) => g.rows));
  const allEndpoints = combineRows([...endpoints.values()].flatMap((g) => g.rows));

  return {
    range,
    stepMs,
    environment,
    environments: environments.filter(Boolean).sort(),
    totals: {
      views: allPages.count,
      loads: allPages.loads,
      requests: allEndpoints.count,
      errorRate: allEndpoints.count > 0 ? Math.round((allEndpoints.errors / allEndpoints.count) * 10000) / 10000 : 0,
      p75: round(percentile(allEndpoints.h, 0.75)),
      p95: round(percentile(allEndpoints.h, 0.95)),
    },
    vitals: Object.fromEntries(VITALS.map((vital) => [vital, vitalSummary(vital, allPages.v[vital] || {})])),
    series: series.map((bucket) => {
      const pageRows = combineRows(bucket.rows.filter((r) => r.kind === 'page'));
      const endpointRows = combineRows(bucket.rows.filter((r) => r.kind === 'endpoint'));
      return {
        start: bucket.start,
        views: pageRows.count,
        requests: endpointRows.count,
        p75: round(percentile(endpointRows.h, 0.75)),
        lcp: vitalSummary('lcp', pageRows.v.lcp || {}).p75,
      };
    }),
    pages: [...pages.entries()]
      .map(([name, group]) => pageSummary(name, combineRows(group.rows)))
      .sort((a, b) => b.views - a.views)
      .slice(0, PERFORMANCE_TABLE_LIMIT),
    endpoints: [...endpoints.entries()]
      .map(([key, group]) => endpointSummary(key, group.labels, combineRows(group.rows)))
      .sort((a, b) => b.count - a.count)
      .slice(0, PERFORMANCE_TABLE_LIMIT),
  };
}

/** One endpoint over time (p50/p75/p95, calls, errors) and its slowest recent calls. */
export async function computeEndpointDetail(db, { projectIds, range, key, environment = null, now = new Date() }) {
  const { buckets, stepMs, start } = timeWindow(range, now);
  const rows = await db.collection('perf_rollups').find(rollupFilter(projectIds, start, environment, { kind: 'endpoint', key }), { projection: { _id: 0 } }).toArray();
  if (rows.length === 0) return null;

  const series = emptySeries(start, stepMs, buckets);
  for (const row of rows) series[bucketIndex(row.hour, start, stepMs, buckets)].rows.push(row);

  const match = { projectId: { $in: projectIds }, 'spans.key': key, receivedAt: { $gte: samplesSince(start, now) } };
  if (environment) match.environment = environment;
  const samples = await db
    .collection('transactions')
    .aggregate([
      { $match: match },
      { $unwind: '$spans' },
      { $match: { 'spans.key': key, 'spans.background': false } },
      { $sort: { 'spans.duration_ms': -1 } },
      { $limit: SLOWEST_SAMPLES_LIMIT },
      {
        $project: {
          // The call's own id (null for spans from SDKs before 0.9.0), not the page view's.
          _id: { $ifNull: ['$spans._id', null] },
          receivedAt: 1,
          page: { $ifNull: ['$screen', '$name'] },
          environment: 1,
          browser: 1,
          os: 1,
          url: '$spans.url',
          status: '$spans.status',
          failure: '$spans.failure',
          duration_ms: '$spans.duration_ms',
          server_ms: '$spans.server_ms',
          download_ms: '$spans.download_ms',
          size_bytes: '$spans.size_bytes',
        },
      },
    ])
    .toArray();

  return {
    range,
    stepMs,
    summary: endpointSummary(key, rows[0], combineRows(rows)),
    series: series.map((bucket) => {
      const combined = combineRows(bucket.rows);
      return {
        start: bucket.start,
        count: combined.count,
        errors: combined.errors,
        p50: round(percentile(combined.h, 0.5)),
        p75: round(percentile(combined.h, 0.75)),
        p95: round(percentile(combined.h, 0.95)),
      };
    }),
    samples: samples.map((sample) => ({ ...sample, failed: isFailure(sample) })),
  };
}

/** One page over time (views, p75 load and LCP) and its slowest recent page loads. */
export async function computePageDetail(db, { projectIds, range, page, environment = null, now = new Date() }) {
  const { buckets, stepMs, start } = timeWindow(range, now);
  const rows = await db.collection('perf_rollups').find(rollupFilter(projectIds, start, environment, { kind: 'page', key: page }), { projection: { _id: 0 } }).toArray();
  if (rows.length === 0) return null;

  const series = emptySeries(start, stepMs, buckets);
  for (const row of rows) series[bucketIndex(row.hour, start, stepMs, buckets)].rows.push(row);
  const combined = combineRows(rows);

  const match = {
    projectId: { $in: projectIds },
    route: page,
    kind: 'pageload',
    background: false,
    'vitals.page_load_ms': { $ne: null },
    receivedAt: { $gte: samplesSince(start, now) },
  };
  if (environment) match.environment = environment;
  const samples = await db
    .collection('transactions')
    .find(match, {
      projection: { _id: 0, receivedAt: 1, name: 1, environment: 1, browser: 1, os: 1, vitals: 1, long_tasks: 1, spanCount: { $size: '$spans' } },
    })
    .sort({ 'vitals.page_load_ms': -1 })
    .limit(SLOWEST_SAMPLES_LIMIT)
    .toArray();

  return {
    range,
    stepMs,
    summary: pageSummary(page, combined),
    vitals: Object.fromEntries(VITALS.map((vital) => [vital, vitalSummary(vital, combined.v[vital] || {})])),
    series: series.map((bucket) => {
      const c = combineRows(bucket.rows);
      return { start: bucket.start, views: c.count, load: vitalSummary('load', c.v.load || {}).p75, lcp: vitalSummary('lcp', c.v.lcp || {}).p75 };
    }),
    samples,
  };
}

