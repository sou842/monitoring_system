import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import {
  bucketOf,
  bucketValue,
  combineRows,
  endpointOf,
  endpointSummary,
  mergeUpdates,
  normalizePath,
  pageSummary,
  percentile,
  rateVital,
  rollupHour,
  rollupUpdates,
  vitalSummary,
} from '../lib/performance.js';
import { validateEvent } from '../lib/validate.js';
import { sampleEvent, samplePageView as pageView } from './helpers.js';

describe('histograms', () => {
  it('puts values in logarithmic buckets and reads percentiles back within 7%', () => {
    assert.equal(bucketOf(0), 0);
    assert.equal(bucketOf(0.4), 0);
    assert.ok(bucketOf(1000) > bucketOf(900));
    for (const value of [3, 47, 250, 1234, 98765]) {
      const back = bucketValue(bucketOf(value));
      assert.ok(Math.abs(back - value) / value < 0.075, `${value} came back as ${back}`);
    }
  });

  it('computes percentiles from bucket counts', () => {
    const h = {};
    for (let ms = 1; ms <= 100; ms++) h[bucketOf(ms * 10)] = (h[bucketOf(ms * 10)] || 0) + 1; // 10..1000 ms
    assert.ok(Math.abs(percentile(h, 0.5) - 500) / 500 < 0.08);
    assert.ok(Math.abs(percentile(h, 0.95) - 950) / 950 < 0.08);
    assert.equal(percentile({}, 0.5), null);
  });
});

describe('route names', () => {
  it('replaces ids in paths so one route is one row', () => {
    assert.equal(normalizePath('/ai/vault/6ad200e254521077e9b11bb2/pages/6ad705fe4a6cb0b5339bc829'), '/ai/vault/{id}/pages/{id}');
    assert.equal(normalizePath('/users/42/orders?tab=1'), '/users/{id}/orders');
    assert.equal(normalizePath('/item/3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6'), '/item/{id}');
    assert.equal(normalizePath('/api/auth/session'), '/api/auth/session');
    assert.equal(normalizePath('/blog/my-first-post'), '/blog/my-first-post'); // a slug without digits stays
    assert.equal(normalizePath('/v2/products'), '/v2/products'); // short segment with a digit stays
    assert.equal(normalizePath(''), '/');
  });

  it('keys endpoints by method, origin and route', () => {
    assert.deepEqual(endpointOf('get', 'https://app.test/api/vault/6ad200e254521077e9b11bb2'), {
      key: 'GET https://app.test/api/vault/{id}',
      method: 'GET',
      origin: 'https://app.test',
      path: '/api/vault/{id}',
    });
    assert.equal(endpointOf('POST', '/relative/7').key, 'POST /relative/{id}');
  });
});

describe('transaction validation', () => {
  it('accepts a page view and cleans its spans', () => {
    const result = validateEvent(pageView());
    assert.equal(result.ok, true);
    assert.equal(result.event.level, 'info');
    assert.equal(result.event.transaction.kind, 'pageload');
    assert.equal(result.event.transaction.spans[0].method, 'GET');
    assert.equal(result.event.transaction.spans.length, 3);
  });

  it('rejects a transaction event without a transaction block', () => {
    const result = validateEvent(sampleEvent({ event_type: 'transaction', transaction: null }));
    assert.deepEqual(result, { ok: false, reason: 'transaction events need a transaction object' });
  });

  it('sets transaction: null on other events, even if one was sent', () => {
    assert.equal(validateEvent(sampleEvent({ transaction: { name: '/x' } })).event.transaction, null);
  });

  it('turns negative or non-numeric timings into null', () => {
    const t = validateEvent(pageView({ vitals: { lcp_ms: -5, fcp_ms: 'fast', cls: 0.2 } })).event.transaction;
    assert.equal(t.vitals.lcp_ms, null);
    assert.equal(t.vitals.fcp_ms, null);
    assert.equal(t.vitals.cls, 0.2);
  });
});

describe('rollups', () => {
  const projectId = new ObjectId();
  const at = new Date('2026-10-23T10:42:00Z');
  const view = validateEvent(pageView()).event;

  it('adds one row for the page and one per endpoint, keeping hidden-tab timings out of histograms', () => {
    const updates = rollupUpdates(projectId, view, at);
    const byKey = Object.fromEntries(updates.map((u) => [u.filter.key, u]));
    assert.deepEqual(Object.keys(byKey).sort(), ['/ai/vault/{id}', 'GET https://app.test/api/session', 'GET https://app.test/api/vault/{id}']);

    const page = byKey['/ai/vault/{id}'];
    assert.equal(page.filter.kind, 'page');
    assert.deepEqual(page.filter.hour, new Date('2026-10-23T10:00:00Z'));
    assert.equal(page.inc.count, 1);
    assert.equal(page.inc.loads, 1);
    assert.equal(page.inc[`v.lcp.${bucketOf(1400)}`], 1);
    assert.equal(page.inc[`v.cls.${bucketOf(50)}`], 1); // CLS 0.05 stored ×1000

    const vault = byKey['GET https://app.test/api/vault/{id}'];
    assert.equal(vault.inc.count, 2); // two ids, one route
    assert.equal(vault.inc.errors, 1);
    assert.equal(vault.inc['server.n'], 1);
    assert.deepEqual(vault.insert, { method: 'GET', origin: 'https://app.test', path: '/api/vault/{id}' });

    const session = byKey['GET https://app.test/api/session'];
    assert.equal(session.inc.background, 1);
    assert.equal(Object.keys(session.inc).some((k) => k.startsWith('h.')), false);
  });

  it('merges updates for the same row within a batch', () => {
    const merged = mergeUpdates([...rollupUpdates(projectId, view, at), ...rollupUpdates(projectId, view, at)]);
    assert.equal(merged.length, 3);
    assert.equal(merged.find((u) => u.filter.kind === 'page').inc.count, 2);
  });

  it('reads stored rows back as table rows', () => {
    // What MongoDB holds after the $inc: dotted fields become nested objects.
    const stored = (update) => {
      const doc = { ...update.filter, ...update.insert };
      for (const [path, amount] of Object.entries(update.inc)) {
        const parts = path.split('.');
        let node = doc;
        for (const part of parts.slice(0, -1)) node = node[part] ??= {};
        node[parts.at(-1)] = (node[parts.at(-1)] || 0) + amount;
      }
      return doc;
    };
    const rows = mergeUpdates([...rollupUpdates(projectId, view, at), ...rollupUpdates(projectId, view, at)]).map(stored);
    const vault = rows.find((r) => r.key === 'GET https://app.test/api/vault/{id}');
    const summary = endpointSummary(vault.key, vault, combineRows([vault]));
    assert.equal(summary.count, 4);
    assert.equal(summary.errorRate, 0.5);
    assert.equal(summary.avgServer, 500);
    assert.ok(summary.p95 >= summary.p50);

    const page = rows.find((r) => r.kind === 'page');
    const pageRow = pageSummary(page.key, combineRows([page]));
    assert.equal(pageRow.views, 2);
    assert.ok(Math.abs(pageRow.lcp - 1400) / 1400 < 0.08);
    assert.ok(Math.abs(pageRow.cls - 0.05) < 0.005);
  });
});

describe('web vitals rating', () => {
  it("uses Google's thresholds", () => {
    assert.equal(rateVital('lcp', 2400), 'good');
    assert.equal(rateVital('lcp', 3000), 'needs-improvement');
    assert.equal(rateVital('lcp', 4100), 'poor');
    assert.equal(rateVital('cls', 0.3), 'poor');
    assert.equal(rateVital('load', 9000), null); // page load has no official rating
    assert.deepEqual(vitalSummary('inp', {}), { p75: null, rating: null, samples: 0 });
  });

  it('starts rollup hours on the hour', () => {
    assert.deepEqual(rollupHour(new Date('2026-10-23T10:59:59Z')), new Date('2026-10-23T10:00:00Z'));
  });
});
