/**
 * Integration tests: real API handlers against a throwaway MongoDB database
 * (monitor_test_<random>, dropped afterwards). Skipped when MONGODB_URI is
 * not configured. Cloudinary is not called: events here carry no screenshots.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hasDatabase, request, sampleEvent, useTestDatabase } from './helpers.js';

const enabled = hasDatabase();
let api;
let db;
let cookie;

describe('backend API (integration)', { skip: enabled ? false : 'MONGODB_URI not set' }, () => {
  before(async () => {
    useTestDatabase();
    process.env.DASHBOARD_PASSWORD = 'test-password';
    process.env.SESSION_SECRET = 'test-secret';
    api = {
      events: await import('../api/v1/events.js'),
      login: await import('../api/auth/login.js'),
      projects: await import('../api/projects.js'),
      issues: await import('../api/issues.js'),
      issue: await import('../api/issue.js'),
      event: await import('../api/event.js'),
      health: await import('../api/health.js'),
    };
    db = await (await import('../lib/db.js')).getDb();
    const res = await api.login.POST(request('/api/auth/login', { method: 'POST', body: { password: 'test-password' } }));
    cookie = res.headers.get('set-cookie').split(';')[0];
  });

  after(async () => {
    try {
      // Dropping collections (not the database) works with a plain readWrite Atlas user.
      if (db) for (const { name } of await db.listCollections().toArray()) await db.collection(name).drop();
    } finally {
      await (await import('../lib/db.js')).closeDb();
    }
  });

  const authed = (path, options = {}) => request(path, { ...options, headers: { cookie, ...(options.headers || {}) } });
  const ingest = (key, events) => api.events.POST(request('/api/v1/events', { method: 'POST', headers: { 'X-API-Key': key }, body: { events } }));

  let projectId;
  let apiKey;

  it('reports healthy', async () => {
    const res = await api.health.GET();
    assert.equal(res.status, 200);
  });

  it('refuses dashboard APIs without a session and wrong passwords', async () => {
    assert.equal((await api.projects.GET(request('/api/projects'))).status, 401);
    const wrong = await api.login.POST(request('/api/auth/login', { method: 'POST', body: { password: 'nope' } }));
    assert.equal(wrong.status, 401);
  });

  it('creates a project and returns its API key once', async () => {
    const res = await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: '  Web   shop ' } }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.project.name, 'Web shop');
    assert.match(body.apiKey, /^et_/);
    projectId = body.project.id;
    apiKey = body.apiKey;

    const stored = await db.collection('projects').findOne({});
    assert.equal(JSON.stringify(stored).includes(apiKey), false, 'plain key must not be stored');
    const list = await (await api.projects.GET(authed('/api/projects'))).json();
    assert.equal(list.projects[0].apiKeyHint.endsWith('…'), true);
  });

  it('rejects ingestion without a valid key', async () => {
    assert.equal((await ingest('et_wrong', [sampleEvent()])).status, 401);
    const noKey = await api.events.POST(request('/api/v1/events', { method: 'POST', body: { events: [sampleEvent()] } }));
    assert.equal(noKey.status, 401);
  });

  it('stores valid events, rejects invalid ones individually, and groups repeats into one issue', async () => {
    const res = await ingest(apiKey, [
      sampleEvent({ error: { message: 'Order 1001 failed', type: 'PaymentError', handled: false } }),
      sampleEvent({ error: { message: 'Order 2002 failed', type: 'PaymentError', handled: false }, environment: 'staging' }),
      { event_type: 'bogus' },
    ]);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.accepted, 2);
    assert.deepEqual(body.rejected.map((r) => r.index), [2]);

    const list = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}`))).json();
    assert.equal(list.total, 1);
    assert.equal(list.issues[0].count, 2);
    assert.deepEqual(list.issues[0].environments.sort(), ['production', 'staging']);
    assert.deepEqual(list.environments, ['production', 'staging']);
  });

  it('filters and searches issues', async () => {
    await ingest(apiKey, [sampleEvent({ event_type: 'performance', level: 'warning', error: { message: 'Slow page load: 4200ms', type: 'SlowPageLoad', handled: true }, stacktrace: [] })]);
    const perf = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&type=performance`))).json();
    assert.deepEqual(perf.issues.map((i) => i.errorType), ['SlowPageLoad']);
    const search = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&q=payment`))).json();
    assert.deepEqual(search.issues.map((i) => i.errorType), ['PaymentError']);
    const env = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&env=staging`))).json();
    assert.equal(env.total, 1);
  });

  it('shows an issue with its events, changes status, and reopens a resolved issue on regression', async () => {
    const list = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&q=payment`))).json();
    const id = list.issues[0].id;

    const detail = await (await api.issue.GET(authed(`/api/issue?id=${id}`))).json();
    assert.equal(detail.events.length, 2);
    assert.equal(detail.latestEvent.payload.error.type, 'PaymentError');
    assert.equal(detail.project.name, 'Web shop');
    const one = await (await api.event.GET(authed(`/api/event?id=${detail.events[1].id}`))).json();
    assert.equal(one.event.id, detail.events[1].id);

    const resolved = await (await api.issue.PATCH(authed(`/api/issue?id=${id}`, { method: 'PATCH', body: { status: 'resolved' } }))).json();
    assert.equal(resolved.issue.status, 'resolved');
    assert.equal((await api.issue.PATCH(authed(`/api/issue?id=${id}`, { method: 'PATCH', body: { status: 'bogus' } }))).status, 400);

    await ingest(apiKey, [sampleEvent({ error: { message: 'Order 3003 failed', type: 'PaymentError', handled: false } })]);
    const again = await (await api.issue.GET(authed(`/api/issue?id=${id}`))).json();
    assert.equal(again.issue.status, 'open');
    assert.ok(again.issue.regressedAt);
    assert.equal(again.issue.count, 3);
  });

  it('rotates the API key: the old key stops working, the new one works', async () => {
    const res = await (await api.projects.POST(authed(`/api/projects?id=${projectId}&action=rotate-key`, { method: 'POST' }))).json();
    assert.notEqual(res.apiKey, apiKey);
    // Ingestion caches keys briefly per instance; a fresh lookup must reject the old key.
    const { findProjectByApiKey } = await import('../lib/projects.js');
    assert.equal(await findProjectByApiKey(db, apiKey, Date.now() + 10 * 60 * 1000), null);
    assert.equal((await ingest(res.apiKey, [sampleEvent()])).status, 202);
    apiKey = res.apiKey;
  });

  it('rejects oversized and malformed bodies', async () => {
    const tooMany = await ingest(apiKey, Array.from({ length: 51 }, () => sampleEvent()));
    assert.equal(tooMany.status, 413);
    const bad = await api.events.POST(new Request('http://localhost/api/v1/events', { method: 'POST', headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }, body: '{not json' }));
    assert.equal(bad.status, 400);
    const huge = await api.events.POST(new Request('http://localhost/api/v1/events', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', 'Content-Length': String(5 * 1024 * 1024) },
      body: '{}',
    }));
    assert.equal(huge.status, 413);
  });

  it('answers CORS preflight for browser SDKs on any origin', () => {
    const res = api.events.OPTIONS();
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers'), /X-API-Key/);
  });
});
