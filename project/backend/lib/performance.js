import {
  CLS_SCALE,
  FAILED_HTTP_STATUSES,
  HISTOGRAM_BASE,
  HISTOGRAM_MAX_BUCKET,
  ROLLUP_BUCKET_MS,
  VITAL_THRESHOLDS,
} from './constants.js';

/**
 * Performance data from `transaction` events (one per page view):
 *
 * - Every page view is stored for a few days so the slowest ones can be shown.
 * - It is also added to hourly **rollups**: one document per (project, hour,
 *   environment, page or endpoint) holding counts and a latency histogram.
 *   Percentiles over any time range are computed by adding histograms
 *   together, so a 7-day p95 never needs millions of raw spans.
 *
 * Everything in this file is pure (no database) so it can be unit-tested.
 */

const LOG_BASE = Math.log(HISTOGRAM_BASE);
const VITALS = ['lcp', 'fcp', 'inp', 'cls', 'ttfb', 'load'];

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** Histogram bucket for a value in ms (CLS: already scaled). */
export function bucketOf(value) {
  if (!(value >= 1)) return 0;
  return Math.min(HISTOGRAM_MAX_BUCKET, 1 + Math.floor(Math.log(value) / LOG_BASE));
}

/** A representative value for a bucket: the geometric middle of its range. */
export function bucketValue(index) {
  if (index <= 0) return 0.5;
  return Math.pow(HISTOGRAM_BASE, index - 0.5);
}

/** Adds histogram `from` into `into` (both `{ bucket: count }`), returning `into`. */
export function addHistogram(into, from) {
  for (const [bucket, count] of Object.entries(from || {})) into[bucket] = (into[bucket] || 0) + count;
  return into;
}

/** The value below which `p` (0–1) of the histogram's samples fall, or null when it is empty. */
export function percentile(histogram, p) {
  const buckets = Object.keys(histogram || {})
    .map(Number)
    .sort((a, b) => a - b);
  const total = buckets.reduce((sum, b) => sum + histogram[b], 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (const bucket of buckets) {
    seen += histogram[bucket];
    if (seen >= rank) return bucketValue(bucket);
  }
  return bucketValue(buckets[buckets.length - 1]);
}

/** Count of samples in a histogram. */
export function histogramCount(histogram) {
  return Object.values(histogram || {}).reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------
// Naming: pages and endpoints are grouped by route, not by exact URL
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^(?=.*\d)[0-9a-f]{8,}$/i;
const NUMBER = /^\d+$/;
/** Long tokens mixing letters and digits (slugs with ids, base64 tokens). */
const TOKEN = /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{16,}$/i;

/**
 * Replaces the parts of a path that identify one record with `{id}`, so
 * `/users/42/orders/6ad2…b2` and `/users/7/orders/9f31…aa` are one route.
 */
export function normalizePath(path) {
  const clean = String(path || '/').replace(/[?#].*$/, '') || '/';
  return clean
    .split('/')
    .map((segment) => (NUMBER.test(segment) || UUID.test(segment) || HEX_ID.test(segment) || TOKEN.test(segment) ? '{id}' : segment))
    .join('/');
}

/** Grouping key and labels for a request: method + origin + route. */
export function endpointOf(method, url) {
  let origin = '';
  let path = String(url || '');
  try {
    const parsed = new URL(path);
    origin = parsed.origin;
    path = parsed.pathname;
  } catch {
    // Relative or malformed URL: keep it as a path.
  }
  const route = normalizePath(path);
  const verb = String(method || 'GET').toUpperCase();
  return { key: `${verb} ${origin}${route}`, method: verb, origin, path: route };
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

/** Start of the rollup bucket (hour) containing `date`. */
export function rollupHour(date) {
  const ms = date.getTime();
  return new Date(ms - (ms % ROLLUP_BUCKET_MS));
}

/**
 * Whether a request counts as failed: a status in FAILED_HTTP_STATUSES, or no
 * response at all (offline, timeout, CORS). Requests the app cancelled itself
 * are not failures.
 */
export function isFailure(span) {
  if (span.status === 0) return span.failure !== 'aborted';
  return FAILED_HTTP_STATUSES.some((entry) =>
    Array.isArray(entry) ? span.status >= entry[0] && span.status <= entry[1] : span.status === entry);
}

/**
 * The rollup increments one stored page view contributes: one row for its
 * page and one per distinct endpoint it called. Timings measured while the
 * tab was hidden are counted (`background`) but kept out of histograms.
 *
 * @returns {Array<{ filter: object, insert: object, inc: object }>}
 */
export function rollupUpdates(projectId, view, receivedAt) {
  const hour = rollupHour(receivedAt);
  const base = { projectId, hour, environment: view.environment };
  const t = view.transaction;
  const updates = new Map();

  const row = (kind, key, insert) => {
    const id = `${kind}|${key}`;
    if (!updates.has(id)) updates.set(id, { filter: { ...base, kind, key }, insert, inc: {} });
    return updates.get(id).inc;
  };
  const add = (inc, field, amount = 1) => {
    inc[field] = (inc[field] || 0) + amount;
  };

  const page = row('page', normalizePath(t.name), {});
  add(page, 'count');
  if (t.background) add(page, 'background');
  if (t.kind === 'pageload') add(page, 'loads');
  add(page, 'blocking_ms', t.long_tasks.blocking_ms);
  // The SDK already sends null for any vital a hidden tab made untrustworthy (FCP, LCP, load).
  const v = t.vitals;
  const samples = { lcp: v.lcp_ms, fcp: v.fcp_ms, inp: v.inp_ms, ttfb: v.ttfb_ms, load: v.page_load_ms, cls: v.cls === null ? null : v.cls * CLS_SCALE };
  for (const vital of VITALS) if (samples[vital] !== null) add(page, `v.${vital}.${bucketOf(samples[vital])}`);

  for (const span of t.spans) {
    const endpoint = endpointOf(span.method, span.url);
    const inc = row('endpoint', endpoint.key, { method: endpoint.method, origin: endpoint.origin, path: endpoint.path });
    add(inc, 'count');
    if (isFailure(span)) add(inc, 'errors');
    if (span.background) {
      add(inc, 'background');
      continue;
    }
    add(inc, `h.${bucketOf(span.duration_ms)}`);
    if (span.server_ms !== null) {
      add(inc, 'server.sum', span.server_ms);
      add(inc, 'server.n');
    }
    if (span.download_ms !== null) {
      add(inc, 'download.sum', span.download_ms);
      add(inc, 'download.n');
    }
  }
  return [...updates.values()];
}

/** Merges updates for the same rollup row, so one batch writes each row once. */
export function mergeUpdates(updates) {
  const merged = new Map();
  for (const update of updates) {
    const f = update.filter;
    const id = `${f.projectId}|${f.hour.getTime()}|${f.environment}|${f.kind}|${f.key}`;
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, { filter: f, insert: update.insert, inc: { ...update.inc } });
      continue;
    }
    for (const [field, amount] of Object.entries(update.inc)) existing.inc[field] = (existing.inc[field] || 0) + amount;
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Reading rollups back
// ---------------------------------------------------------------------------

/** "good" | "needs-improvement" | "poor" for a Web Vital value, or null. */
export function rateVital(vital, value) {
  const limits = VITAL_THRESHOLDS[vital];
  if (limits === undefined || value === null) return null;
  if (value <= limits.good) return 'good';
  return value > limits.poor ? 'poor' : 'needs-improvement';
}

function round(value, digits = 0) {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** p75 summary of one vital from a merged `v.<vital>` histogram. */
export function vitalSummary(vital, histogram) {
  const raw = percentile(histogram, 0.75);
  const value = raw === null ? null : vital === 'cls' ? round(raw / CLS_SCALE, 3) : round(raw);
  return { p75: value, rating: rateVital(vital, value), samples: histogramCount(histogram) };
}

/** Adds rollup rows of one page or endpoint together. */
export function combineRows(rows) {
  const out = { count: 0, errors: 0, background: 0, loads: 0, blocking_ms: 0, h: {}, v: {}, server: { sum: 0, n: 0 }, download: { sum: 0, n: 0 } };
  for (const row of rows) {
    for (const field of ['count', 'errors', 'background', 'loads', 'blocking_ms']) out[field] += row[field] || 0;
    addHistogram(out.h, row.h);
    for (const [vital, histogram] of Object.entries(row.v || {})) addHistogram((out.v[vital] ??= {}), histogram);
    for (const part of ['server', 'download']) {
      out[part].sum += (row[part] && row[part].sum) || 0;
      out[part].n += (row[part] && row[part].n) || 0;
    }
  }
  return out;
}

/** Table row for an endpoint, from its combined rollups. */
export function endpointSummary(key, labels, combined) {
  return {
    key,
    method: labels.method,
    origin: labels.origin,
    path: labels.path,
    count: combined.count,
    errorRate: combined.count > 0 ? round(combined.errors / combined.count, 4) : 0,
    p50: round(percentile(combined.h, 0.5)),
    p75: round(percentile(combined.h, 0.75)),
    p95: round(percentile(combined.h, 0.95)),
    avgServer: combined.server.n > 0 ? round(combined.server.sum / combined.server.n) : null,
    avgDownload: combined.download.n > 0 ? round(combined.download.sum / combined.download.n) : null,
    background: combined.background,
  };
}

/** Table row for a page, from its combined rollups. */
export function pageSummary(name, combined) {
  const p75 = (vital) => vitalSummary(vital, combined.v[vital] || {}).p75;
  return {
    name,
    views: combined.count,
    loads: combined.loads,
    load: p75('load'),
    lcp: p75('lcp'),
    fcp: p75('fcp'),
    inp: p75('inp'),
    cls: p75('cls'),
    ttfb: p75('ttfb'),
    avgBlockingMs: combined.count > 0 ? round(combined.blocking_ms / combined.count) : 0,
  };
}

export { VITALS };
