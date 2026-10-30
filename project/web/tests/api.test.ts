/**
 * Integration tests: real API handlers against a throwaway MongoDB database
 * (monitor_test_<random>, collections dropped afterwards). Skipped when
 * MONGODB_URI is not configured.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ObjectId, type Db } from 'mongodb';
import type { UserView } from '../lib/types.ts';
import { closeDb, getDb } from '../server/db.ts';
import * as account from '../server/routes/account.ts';
import * as admin from '../server/routes/admin.ts';
import * as auth from '../server/routes/auth.ts';
import * as event from '../server/routes/event.ts';
import * as events from '../server/routes/events.ts';
import * as health from '../server/routes/health.ts';
import * as issue from '../server/routes/issue.ts';
import * as issues from '../server/routes/issues.ts';
import * as projects from '../server/routes/projects.ts';
import * as stats from '../server/routes/stats.ts';
import { hasDatabase, request, sampleEvent, samplePageView, useTestDatabase, type RequestOptions } from './helpers.ts';

const enabled = hasDatabase();
const PASSWORD = 'correct horse battery';
// The handlers read their configuration when called, so importing them before before() runs is fine.
const api = { events, auth, account, admin, projects, issues, issue, event, health, stats };
let db: Db;

/** A fake client IP per call, so the per-IP sign-up and ingestion limits don't interfere between tests. */
const freshIp = () => `10.${randomBytes(3).join('.')}`;
const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

describe('backend API (integration)', { skip: enabled ? false : 'MONGODB_URI not set' }, () => {
  before(async () => {
    useTestDatabase();
    process.env.SESSION_SECRET = 'test-secret';
    db = await getDb();
  });

  after(async () => {
    try {
      // Dropping collections (not the database) works with a plain readWrite Atlas user.
      if (db) for (const { name } of await db.listCollections().toArray()) await db.collection(name).drop();
    } finally {
      await closeDb();
    }
  });

  const authPost = (action: string, body: unknown, headers: Record<string, string> = {}) =>
    api.auth.POST(request(`/api/auth?action=${action}`, { method: 'POST', body, headers: { 'x-forwarded-for': freshIp(), ...headers } }));
  async function signup(name: string, email: string, password = PASSWORD): Promise<{ cookie: string; user: UserView }> {
    const res = await authPost('signup', { name, email, password });
    assert.equal(res.status, 201, `signup ${email}`);
    return { cookie: cookieFrom(res), user: (await res.json()).user };
  }
  const as = (cookie: string) => (path: string, options: RequestOptions = {}) => request(path, { ...options, headers: { cookie, ...(options.headers || {}) } });
  const ingest = (key: string, batch: unknown[], headers: Record<string, string> = {}) =>
    api.events.POST(request('/api/v1/events', { method: 'POST', headers: { 'X-API-Key': key, 'x-forwarded-for': freshIp(), ...headers }, body: { events: batch } }));

  let alice: { cookie: string; user: UserView };
  let authed: ReturnType<typeof as>; // request builder with Alice's cookie
  let projectId: string;
  let apiKey: string;

  it('reports healthy', async () => {
    const res = await api.health.GET();
    assert.equal(res.status, 200);
  });

  describe('accounts', () => {
    it('signs up with a normalized email and starts a session', async () => {
      alice = await signup('  Alice   Smith ', ' Alice@Example.COM ');
      authed = as(alice.cookie);
      assert.equal(alice.user.email, 'alice@example.com');
      assert.equal(alice.user.name, 'Alice Smith');
      assert.equal(alice.user.role, 'user');
      const session = await (await api.auth.GET(authed('/api/auth'))).json();
      assert.equal(session.authenticated, true);
      assert.equal(session.user.email, 'alice@example.com');
      const stored = await db.collection('users').findOne({ email: 'alice@example.com' });
      assert.match(stored?.passwordHash ?? '', /^scrypt\$/);
      assert.equal(JSON.stringify(stored).includes(PASSWORD), false, 'plain password must not be stored');
    });

    it('rejects bad sign-ups', async () => {
      assert.equal((await authPost('signup', { name: 'X', email: 'not-an-email', password: PASSWORD })).status, 400);
      assert.equal((await authPost('signup', { name: 'X', email: 'x@example.com', password: 'short' })).status, 400);
      assert.equal((await authPost('signup', { name: '', email: 'x@example.com', password: PASSWORD })).status, 400);
      const taken = await authPost('signup', { name: 'Other', email: 'ALICE@example.com', password: PASSWORD });
      assert.equal(taken.status, 409);
      assert.equal((await taken.json()).error.code, 'email_taken');
    });

    it('logs in with the right password only, and logs out', async () => {
      const wrong = await authPost('login', { email: 'alice@example.com', password: 'nope-nope' });
      assert.equal(wrong.status, 401);
      const unknown = await authPost('login', { email: 'nobody@example.com', password: PASSWORD });
      assert.equal(unknown.status, 401);
      assert.equal((await unknown.json()).error.message, (await wrong.json()).error.message, 'same message for unknown email and wrong password');

      const ok = await authPost('login', { email: 'ALICE@example.com', password: PASSWORD });
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
      const out = await authPost('logout', {});
      assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
    });

    it('refuses dashboard APIs without a valid session', async () => {
      assert.equal((await api.projects.GET(request('/api/projects'))).status, 401);
      assert.equal((await api.projects.GET(request('/api/projects', { headers: { cookie: 'et_session=forged.token' } }))).status, 401);
      assert.equal((await (await api.auth.GET(request('/api/auth'))).json()).authenticated, false);
    });

    it('refuses state-changing requests from another site', async () => {
      const res = await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: 'Evil' }, headers: { origin: 'https://evil.example', host: 'localhost' } }));
      assert.equal(res.status, 403);
      const login = await authPost('login', { email: 'alice@example.com', password: PASSWORD }, { origin: 'https://evil.example', host: 'localhost' });
      assert.equal(login.status, 403);
    });

    it('rate-limits repeated login attempts', async () => {
      await signup('Rate', 'rate@example.com');
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await authPost('login', { email: 'rate@example.com', password: 'wrong-password' }, { 'x-forwarded-for': ip })).status);
      assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
      assert.equal(statuses[10], 429);
      const blocked = await authPost('login', { email: 'rate@example.com', password: PASSWORD }, { 'x-forwarded-for': ip });
      assert.equal(blocked.status, 429, 'even the right password waits until the window ends');
    });
  });

  describe('projects, issues and events', () => {
    it('creates a project and returns its API key once', async () => {
      const res = await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: '  Web   shop ' } }));
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.project.name, 'Web shop');
      assert.match(body.apiKey, /^et_/);
      projectId = body.project.id;
      apiKey = body.apiKey;

      const stored = await db.collection('projects').findOne({ _id: new ObjectId(projectId) });
      assert.equal(JSON.stringify(stored).includes(apiKey), false, 'plain key must not be stored');
      assert.equal(String(stored?.ownerId), alice.user.id);
      const list = await (await api.projects.GET(authed('/api/projects'))).json();
      assert.equal(list.projects[0].apiKeyHint.endsWith('…'), true);
      assert.equal(list.limit, null, 'no project limit per account');
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

    it("finds the issue and the exact event that recorded an API call, by the call's _id", async () => {
      const created = await (await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: 'Call ids' } }))).json();
      const id = created.project.id;
      const callId = '9f3c2a7b41d0e865';
      const call = (_id, url) => ({ _id, url, method: 'POST', status: 200, duration_ms: 812 });
      const failing = (message, calls) =>
        sampleEvent({ error: { message, type: 'AppzillonServerError', handled: true }, performance: { ...(sampleEvent().performance as Record<string, unknown>), api_calls: calls } });
      await ingest(created.apiKey, [
        failing('Server returned error: OrdersQuery', [call('0000000000000001', 'https://shop.test/a'), call(callId, 'https://shop.test/AppzillonWeb')]),
        failing('Server returned error: UsersQuery', [call('0000000000000002', 'https://shop.test/b')]),
      ]);
      await ingest(created.apiKey, [failing('Server returned error: OrdersQuery', [call(callId, 'https://shop.test/AppzillonWeb')])]);

      const found = await (await api.issues.GET(authed(`/api/issues?projectId=${id}&q=${callId}`))).json();
      assert.deepEqual(found.issues.map((i) => i.message), ['Server returned error: OrdersQuery']);
      const withCall = await db.collection('events').find({ 'payload.performance.api_calls._id': callId }).toArray();
      assert.equal(withCall.length, 2);
      assert.ok(withCall.some((e) => String(e._id) === found.issues[0].matchedEventId), 'links to an event that recorded the call');
      const opened = await (await api.event.GET(authed(`/api/event?id=${found.issues[0].matchedEventId}`))).json();
      assert.ok(opened.event.payload.performance.api_calls.some((c) => c._id === callId));

      const plain = await (await api.issues.GET(authed(`/api/issues?projectId=${id}&q=UsersQuery`))).json();
      assert.deepEqual(plain.issues.map((i) => i.matchedEventId), [null], 'a text search links no event');
      const unknown = await (await api.issues.GET(authed(`/api/issues?projectId=${id}&q=ffffffffffffffff`))).json();
      assert.equal(unknown.total, 0);
      const otherProject = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&q=${callId}`))).json();
      assert.equal(otherProject.total, 0, 'only events of the searched project count');

      const plan = await db.collection('events').find({ 'payload.performance.api_calls._id': callId }).explain();
      assert.match(JSON.stringify(plan.queryPlanner.winningPlan), /IXSCAN/, 'the lookup uses the index');
      const spanPlan = await db.collection('transactions').find({ 'spans._id': callId }).explain();
      assert.match(JSON.stringify(spanPlan.queryPlanner.winningPlan), /IXSCAN/);

      await api.projects.DELETE(authed(`/api/projects?id=${id}`, { method: 'DELETE' }));
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
      const { findProjectByApiKey } = await import('../server/projects.ts');
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
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /X-API-Key/);
    });

    it('accepts browser events only from allowed origins, once a project lists any', async () => {
      const patch = (body, as = authed) => api.projects.PATCH(as(`/api/projects?id=${projectId}`, { method: 'PATCH', body }));
      const fromOrigin = (origin) => ingest(apiKey, [sampleEvent()], origin === null ? {} : { Origin: origin });
      assert.equal((await fromOrigin('https://evil.test')).status, 202, 'no list: any origin');

      const bad = await patch({ allowedOrigins: ['https://ok.test', 'shop.test', '*.shop.test', 'ftp://shop.test'] });
      assert.equal(bad.status, 400);
      const badBody = await bad.json();
      assert.equal(badBody.error.code, 'invalid_origins');
      assert.deepEqual(badBody.error.details.map((d) => d.index), [1, 2, 3]);
      assert.equal((await patch({ allowedOrigins: 'https://shop.test' })).status, 400);
      assert.equal((await patch({ allowedOrigins: Array.from({ length: 21 }, (_, i) => `https://s${i}.test`) })).status, 400);

      const res = await patch({ allowedOrigins: ['HTTPS://Shop.test:443/', 'http://localhost:3000', 'https://shop.test/checkout?x=1'] });
      assert.equal(res.status, 200);
      const expected = ['https://shop.test', 'http://localhost:3000'];
      assert.deepEqual((await res.json()).project.allowedOrigins, expected, 'normalized and de-duplicated');
      const list = await (await api.projects.GET(authed('/api/projects'))).json();
      assert.deepEqual(list.projects.find((p) => p.id === projectId).allowedOrigins, expected);

      assert.equal((await fromOrigin('https://shop.test')).status, 202);
      assert.equal((await fromOrigin('http://localhost:3000')).status, 202);
      assert.equal((await fromOrigin(null)).status, 202, 'server-side and mobile SDKs send no Origin');
      const refused = await fromOrigin('https://evil.test');
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, 'origin_not_allowed');
      assert.equal(refused.headers.get('access-control-allow-origin'), '*', 'the SDK must see the 403, not a CORS failure');
      assert.equal((await fromOrigin('http://localhost:3001')).status, 403, 'the port must match');
      assert.equal((await fromOrigin('http://shop.test')).status, 403, 'the scheme must match');
      assert.equal((await fromOrigin('null')).status, 403);

      assert.equal((await api.projects.PATCH(request(`/api/projects?id=${projectId}`, { method: 'PATCH', body: { allowedOrigins: [] } }))).status, 401);
      assert.equal((await patch({ allowedOrigins: [] })).status, 200);
      assert.equal((await fromOrigin('https://evil.test')).status, 202, 'an empty list allows any origin again');
    });

    it('saves issue-insight settings and hands them to the issue page', async () => {
      const patch = (body) => api.projects.PATCH(authed(`/api/projects?id=${projectId}`, { method: 'PATCH', body }));
      const settings = { libraryPaths: [' /vendor/ ', '/vendor/'], hiddenFrames: ['wrapped'], hints: [{ match: 'PaymentError', text: 'Check the payment gateway.' }] };
      const saved = { libraryPaths: ['/vendor/'], hiddenFrames: ['wrapped'], hints: [{ match: 'PaymentError', text: 'Check the payment gateway.' }] };

      assert.equal((await patch({})).status, 400, 'nothing to update');
      const bad = await patch({ insights: { hints: [{ match: 'x' }] } });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.code, 'invalid_insights');
      const both = await patch({ allowedOrigins: ['https://shop.test'], insights: { libraryPaths: 'x' } });
      assert.equal(both.status, 400);
      const unchanged = await (await api.projects.GET(authed('/api/projects'))).json();
      assert.deepEqual(unchanged.projects.find((p) => p.id === projectId).allowedOrigins, [], 'nothing saved when any part is invalid');

      const res = await patch({ insights: settings });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.project.insights, saved);
      assert.deepEqual(body.project.allowedOrigins, [], 'origins untouched');

      const list = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&q=payment`))).json();
      const detail = await (await api.issue.GET(authed(`/api/issue?id=${list.issues[0].id}`))).json();
      assert.deepEqual(detail.project.insights, saved);
    });

    it('limits events per IP', async () => {
      // Each half must run inside one rate-limit window (one minute): start in a fresh one if little is left.
      const freshWindow = async () => {
        const msLeft = 60000 - (Date.now() % 60000);
        if (msLeft < 30000) await new Promise((resolve) => setTimeout(resolve, msLeft + 100));
      };
      await freshWindow();
      const ip = { 'x-forwarded-for': freshIp() };
      const batch = Array.from({ length: 50 }, () => sampleEvent());
      for (let i = 0; i < 3; i++) assert.equal((await ingest(apiKey, batch, ip)).status, 202);

      const over = await ingest(apiKey, [sampleEvent()], ip);
      assert.equal(over.status, 429);
      assert.equal((await over.json()).error.code, 'rate_limited_ip');
      assert.ok(Number(over.headers.get('retry-after')) >= 1);
      assert.equal(over.headers.get('access-control-allow-origin'), '*');
      assert.equal((await ingest(apiKey, [sampleEvent()])).status, 202, 'other IPs still get through');

      await freshWindow();
      const viewIp = { 'x-forwarded-for': freshIp() };
      const views = Array.from({ length: 50 }, () => samplePageView());
      for (let i = 0; i < 3; i++) assert.equal((await (await ingest(apiKey, views, viewIp)).json()).accepted, 50);
      const overViews = await (await ingest(apiKey, [samplePageView()], viewIp)).json();
      assert.equal(overViews.accepted, 0);
      assert.deepEqual(overViews.rejected, [{ index: 0, reason: 'rate_limited' }], 'page views over the limit are dropped, not retried');
    });

    it('deletes issues (with their events): one, selected ones, by status, and requires a login', async () => {
      const del = (path: string, body?: unknown) => authed(path, { method: 'DELETE', body });
      const issueList = async (query = '') => (await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&status=all${query}`))).json());
      const eventCount = () => db.collection('events').countDocuments({ projectId: new ObjectId(projectId) });

      assert.equal((await api.issue.DELETE(request('/api/issue?id=' + '0'.repeat(24), { method: 'DELETE' }))).status, 401);
      assert.equal((await api.issues.DELETE(request(`/api/issues?projectId=${projectId}&status=all`, { method: 'DELETE' }))).status, 401);

      await ingest(apiKey, [
        sampleEvent({ error: { message: 'Delete me A', type: 'DeleteA', handled: false } }),
        sampleEvent({ error: { message: 'Delete me B', type: 'DeleteB', handled: false } }),
        sampleEvent({ error: { message: 'Delete me C', type: 'DeleteC', handled: false } }),
      ]);
      const before = await issueList();
      const byType = Object.fromEntries(before.issues.map((i) => [i.errorType, i.id]));

      const eventsBefore = await eventCount();
      const one = await (await api.issue.DELETE(del(`/api/issue?id=${byType.DeleteA}`))).json();
      assert.deepEqual(one.deleted, { issues: 1, events: 1 });
      assert.equal(await eventCount(), eventsBefore - 1);
      assert.equal((await api.issue.GET(authed(`/api/issue?id=${byType.DeleteA}`))).status, 404);
      assert.equal((await api.issue.DELETE(del(`/api/issue?id=${byType.DeleteA}`))).status, 404);

      const some = await (await api.issues.DELETE(del(`/api/issues?projectId=${projectId}`, { ids: [byType.DeleteB] }))).json();
      assert.deepEqual(some.deleted, { issues: 1, events: 1 });
      assert.equal((await api.issues.DELETE(del(`/api/issues?projectId=${projectId}`, { ids: ['nope'] }))).status, 400);
      assert.equal((await api.issues.DELETE(del(`/api/issues?projectId=${projectId}`, { ids: [] }))).status, 400);
      assert.equal((await api.issues.DELETE(del(`/api/issues?projectId=${projectId}`))).status, 400, 'needs ids or a status');

      // Another project's issues are untouched even if their id is passed.
      const other = await (await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: 'Other' } }))).json();
      await ingest(other.apiKey, [sampleEvent({ error: { message: 'Other app bug', type: 'OtherBug', handled: false } })]);
      const otherIssue = (await (await api.issues.GET(authed(`/api/issues?projectId=${other.project.id}`))).json()).issues[0];
      const cross = await (await api.issues.DELETE(del(`/api/issues?projectId=${projectId}`, { ids: [otherIssue.id] }))).json();
      assert.deepEqual(cross.deleted, { issues: 0, events: 0 });

      await api.issue.PATCH(authed(`/api/issue?id=${byType.DeleteC}`, { method: 'PATCH', body: { status: 'resolved' } }));
      const resolved = await (await api.issues.DELETE(del(`/api/issues?projectId=${projectId}&status=resolved`))).json();
      assert.equal(resolved.deleted.issues, 1);
      assert.equal((await issueList('&q=DeleteC')).total, 0);
      assert.ok((await issueList()).total > 0, 'open issues remain');

      await api.issues.DELETE(del(`/api/issues?projectId=${projectId}&status=all`));
      assert.equal((await issueList()).total, 0);
      assert.equal(await eventCount(), 0);
      assert.equal((await (await api.issues.GET(authed(`/api/issues?projectId=${other.project.id}`))).json()).total, 1);

      const gone = await (await api.projects.DELETE(del(`/api/projects?id=${other.project.id}`))).json();
      assert.deepEqual(gone.deleted, { issues: 1, events: 1 });
      assert.equal(await db.collection('projects').countDocuments({ name: 'Other' }), 0);
      assert.equal((await api.projects.DELETE(del(`/api/projects?id=${other.project.id}`))).status, 404);
    });

    it('computes dashboard stats per bucket, type and status, and requires a login', async () => {
      const created = await (await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: 'Stats app' } }))).json();
      await ingest(created.apiKey, [
        sampleEvent(),
        sampleEvent(),
        sampleEvent({ event_type: 'performance', error: { message: 'Slow', type: 'SlowPageLoad', handled: true } }),
      ]);
      const stats = await (await api.stats.GET(authed(`/api/stats?projectId=${created.project.id}&range=24h`))).json();
      assert.equal(stats.total, 3);
      assert.equal(stats.byType.error, 2);
      assert.equal(stats.byType.performance, 1);
      assert.equal(stats.series.length, 24);
      assert.equal(stats.series.reduce((sum, b) => sum + b.error, 0), 2);
      assert.equal(stats.series.at(-1).error, 2, 'events received just now land in the newest bucket');
      assert.equal(stats.statuses.open, 2);
      assert.equal(stats.topIssues[0].count, 2);
      assert.equal((await (await api.stats.GET(authed('/api/stats?range=7d'))).json()).series.length, 7);
      assert.equal((await api.stats.GET(authed('/api/stats?range=1y'))).status, 400);
      assert.equal((await api.stats.GET(request('/api/stats'))).status, 401);
    });

    it('never stores or serves fields outside the schema', async () => {
      const created = await (await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: 'Extra fields app' } }))).json();
      const id = created.project.id;
      const blob = 'data:image/jpeg;base64,' + 'A'.repeat(2000);
      const res = await ingest(created.apiKey, [sampleEvent({ attachment: blob })]);
      assert.deepEqual(await res.json(), { accepted: 1, rejected: [] }, 'the error itself is still accepted');

      const stored = await db.collection('events').findOne({ projectId: new ObjectId(id) });
      assert.equal(JSON.stringify(stored).includes('attachment'), false);
      assert.equal(JSON.stringify(stored).includes(blob), false);
      const issues = await (await api.issues.GET(authed(`/api/issues?projectId=${id}`))).json();
      const detail = await (await api.issue.GET(authed(`/api/issue?id=${issues.issues[0].id}`))).json();
      const event = await (await api.event.GET(authed(`/api/event?id=${detail.events[0].id}`))).json();
      assert.equal(JSON.stringify(event).includes(blob), false);

      await api.projects.DELETE(authed(`/api/projects?id=${id}`, { method: 'DELETE' }));
    });

    it('stores page views as performance data, never as issues, and serves the Performance view', async () => {
      const created = await (await api.projects.POST(authed('/api/projects', { method: 'POST', body: { name: 'Perf app' } }))).json();
      const id = created.project.id;
      const res = await ingest(created.apiKey, [samplePageView(), samplePageView({ kind: 'navigation', name: '/settings' }), sampleEvent()]);
      assert.deepEqual(await res.json(), { accepted: 3, rejected: [] });

      const issues = await (await api.issues.GET(authed(`/api/issues?projectId=${id}`))).json();
      assert.equal(issues.issues.length, 1, 'only the error became an issue');
      assert.equal(await db.collection('transactions').countDocuments({ projectId: new ObjectId(id) }), 2);
      const overview = await (await api.stats.GET(authed(`/api/stats?projectId=${id}&range=24h`))).json();
      assert.equal(overview.total, 1, 'page views are not counted as events in the overview');

      const perf = await (await api.stats.GET(authed(`/api/stats?view=performance&projectId=${id}&range=24h`))).json();
      assert.equal(perf.totals.views, 2);
      assert.equal(perf.totals.loads, 1);
      assert.equal(perf.totals.requests, 6);
      assert.deepEqual(perf.environments, ['production']);
      assert.equal(perf.vitals.lcp.rating, 'good');
      assert.deepEqual(perf.pages.map((p) => p.name).sort(), ['/ai/vault/{id}', '/settings']);
      const vault = perf.endpoints.find((e) => e.key === 'GET https://app.test/api/vault/{id}');
      assert.equal(vault.count, 4);
      assert.equal(vault.errorRate, 0.5);
      const session = perf.endpoints.find((e) => e.key === 'GET https://app.test/api/session');
      assert.equal(session.background, 2);
      assert.equal(session.p75, null, 'hidden-tab timings stay out of percentiles');

      const endpoint = await (await api.stats.GET(authed(`/api/stats?view=performance&projectId=${id}&endpoint=${encodeURIComponent(vault.key)}`))).json();
      assert.equal(endpoint.summary.count, 4);
      assert.equal(endpoint.series.length, 24);
      assert.equal(endpoint.samples[0].duration_ms, 600, 'slowest call first');
      assert.equal(endpoint.samples[0].server_ms, 500);
      assert.equal(endpoint.samples[0]._id, '4b1e09c7d2a35f80', "each sample carries the call's _id");

      const page = await (await api.stats.GET(authed(`/api/stats?view=performance&projectId=${id}&page=${encodeURIComponent('/ai/vault/{id}')}`))).json();
      assert.equal(page.summary.views, 1);
      assert.equal(page.samples.length, 1);
      assert.equal(page.samples[0].vitals.page_load_ms, 1900);

      const staging = await (await api.stats.GET(authed(`/api/stats?view=performance&projectId=${id}&environment=staging`))).json();
      assert.equal(staging.totals.views, 0);
      assert.deepEqual(staging.environments, ['production'], 'the environment list ignores the filter');
      assert.equal((await api.stats.GET(authed(`/api/stats?view=performance&projectId=${id}&endpoint=nope`))).status, 404);
      assert.equal((await api.stats.GET(authed('/api/stats?view=bogus'))).status, 400);

      await api.projects.DELETE(authed(`/api/projects?id=${id}`, { method: 'DELETE' }));
      assert.equal(await db.collection('transactions').countDocuments({ projectId: new ObjectId(id) }), 0);
      assert.equal(await db.collection('perf_rollups').countDocuments({ projectId: new ObjectId(id) }), 0);
    });
  });

  describe('privacy between users', () => {
    let bob;
    let asBob;
    let issueId;
    let eventId;

    before(async () => {
      bob = await signup('Bob', 'bob@example.com');
      asBob = as(bob.cookie);
      await ingest(apiKey, [sampleEvent({ error: { message: 'Alice only', type: 'AlicePrivate', handled: false } })]);
      const list = await (await api.issues.GET(authed(`/api/issues?projectId=${projectId}&q=AlicePrivate`))).json();
      issueId = list.issues[0].id;
      eventId = (await (await api.issue.GET(authed(`/api/issue?id=${issueId}`))).json()).events[0].id;
    });

    it("hides other users' projects, issues, events and stats", async () => {
      assert.deepEqual((await (await api.projects.GET(asBob('/api/projects'))).json()).projects, []);
      assert.equal((await api.issues.GET(asBob(`/api/issues?projectId=${projectId}`))).status, 404);
      assert.equal((await api.issue.GET(asBob(`/api/issue?id=${issueId}`))).status, 404);
      assert.equal((await api.event.GET(asBob(`/api/event?id=${eventId}`))).status, 404);
      assert.equal((await api.stats.GET(asBob(`/api/stats?projectId=${projectId}`))).status, 404);
      assert.equal((await api.stats.GET(asBob(`/api/stats?view=performance&projectId=${projectId}`))).status, 404);
      const own = await (await api.stats.GET(asBob('/api/stats'))).json();
      assert.equal(own.total, 0, "Bob's overview doesn't count Alice's events");
      assert.deepEqual(own.topIssues, []);
    });

    it("cannot change or delete other users' data", async () => {
      const del = (path: string, body?: unknown) => asBob(path, { method: 'DELETE', body });
      assert.equal((await api.issue.PATCH(asBob(`/api/issue?id=${issueId}`, { method: 'PATCH', body: { status: 'resolved' } }))).status, 404);
      assert.equal((await api.issue.DELETE(del(`/api/issue?id=${issueId}`))).status, 404);
      assert.equal((await api.issues.DELETE(del(`/api/issues?projectId=${projectId}&status=all`))).status, 404);
      assert.equal((await api.projects.POST(asBob(`/api/projects?id=${projectId}&action=rotate-key`, { method: 'POST' }))).status, 404);
      const bobOrigins = await api.projects.PATCH(asBob(`/api/projects?id=${projectId}`, { method: 'PATCH', body: { allowedOrigins: ['https://bob.test'] } }));
      assert.equal(bobOrigins.status, 404);
      assert.equal((await api.projects.DELETE(del(`/api/projects?id=${projectId}`))).status, 404);

      const issue = await (await api.issue.GET(authed(`/api/issue?id=${issueId}`))).json();
      assert.equal(issue.issue.status, 'open', "Alice's issue is unchanged");
      assert.equal((await ingest(apiKey, [sampleEvent()])).status, 202, "Alice's key still works");
    });

    it('has no limit on the number of projects per user', async () => {
      for (let i = 0; i < 11; i++) {
        assert.equal((await api.projects.POST(asBob('/api/projects', { method: 'POST', body: { name: `Bob ${i}` } }))).status, 201);
      }
      const account = await (await api.account.GET(asBob('/api/account'))).json();
      assert.deepEqual(account.usage, { projects: 11, projectLimit: null });
      assert.equal((await (await api.projects.GET(asBob('/api/projects'))).json()).limit, null);
    });
  });

  describe('account settings', () => {
    let carol;

    before(async () => {
      carol = await signup('Carol', 'carol@example.com');
    });

    it('renames the account', async () => {
      const res = await api.account.PATCH(as(carol.cookie)('/api/account', { method: 'PATCH', body: { name: '  Carol  King ' } }));
      assert.equal((await res.json()).user.name, 'Carol King');
      assert.equal((await api.account.PATCH(as(carol.cookie)('/api/account', { method: 'PATCH', body: { name: '' } }))).status, 400);
    });

    it('changes the password: other sessions end, this one continues', async () => {
      const other = cookieFrom(await authPost('login', { email: 'carol@example.com', password: PASSWORD }));
      const wrong = await api.account.PATCH(as(carol.cookie)('/api/account', { method: 'PATCH', body: { currentPassword: 'nope', newPassword: 'brand new password' } }));
      assert.equal(wrong.status, 400);
      assert.equal((await wrong.json()).error.code, 'wrong_password');
      assert.equal((await api.account.PATCH(as(carol.cookie)('/api/account', { method: 'PATCH', body: { currentPassword: PASSWORD, newPassword: 'short' } }))).status, 400);

      const ok = await api.account.PATCH(as(carol.cookie)('/api/account', { method: 'PATCH', body: { currentPassword: PASSWORD, newPassword: 'brand new password' } }));
      assert.equal(ok.status, 200);
      const fresh = cookieFrom(ok);
      assert.equal((await api.projects.GET(as(other)('/api/projects'))).status, 401, 'other session ended');
      assert.equal((await api.projects.GET(as(carol.cookie)('/api/projects'))).status, 401, 'old cookie ended');
      assert.equal((await api.projects.GET(as(fresh)('/api/projects'))).status, 200, 'new cookie works');
      assert.equal((await authPost('login', { email: 'carol@example.com', password: PASSWORD })).status, 401);
      assert.equal((await authPost('login', { email: 'carol@example.com', password: 'brand new password' })).status, 200);
      carol.cookie = fresh;
    });

    it('logs out other devices', async () => {
      const other = cookieFrom(await authPost('login', { email: 'carol@example.com', password: 'brand new password' }));
      const res = await api.account.POST(as(carol.cookie)('/api/account?action=logout-others', { method: 'POST' }));
      assert.equal(res.status, 200);
      carol.cookie = cookieFrom(res);
      assert.equal((await api.projects.GET(as(other)('/api/projects'))).status, 401);
      assert.equal((await api.projects.GET(as(carol.cookie)('/api/projects'))).status, 200);
    });

    it('deletes the account with all its projects, after checking the password', async () => {
      const created = await (await api.projects.POST(as(carol.cookie)('/api/projects', { method: 'POST', body: { name: 'Carol app' } }))).json();
      await ingest(created.apiKey, [sampleEvent()]);
      assert.equal((await api.account.DELETE(as(carol.cookie)('/api/account', { method: 'DELETE', body: { password: 'wrong' } }))).status, 400);

      const res = await api.account.DELETE(as(carol.cookie)('/api/account', { method: 'DELETE', body: { password: 'brand new password' } }));
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).deleted, { projects: 1, issues: 1, events: 1 });
      assert.equal(await db.collection('users').countDocuments({ email: 'carol@example.com' }), 0);
      assert.equal((await ingest(created.apiKey, [sampleEvent()])).status, 401, 'the deleted project key no longer works');
      assert.equal((await api.projects.GET(as(carol.cookie)('/api/projects'))).status, 401);
    });
  });

  describe('admin console', () => {
    let dave;
    let daveKey;

    before(async () => {
      dave = await signup('Dave', 'dave@example.com');
      const created = await (await api.projects.POST(as(dave.cookie)('/api/projects', { method: 'POST', body: { name: 'Dave app' } }))).json();
      daveKey = created.apiKey;
      await ingest(daveKey, [sampleEvent(), sampleEvent()]);
    });

    it('is only for admins', async () => {
      assert.equal((await api.admin.GET(authed('/api/admin'))).status, 403);
      assert.equal((await api.admin.GET(request('/api/admin'))).status, 401);
    });

    it('make-admin promotes a user and gives them projects without an owner', async () => {
      const orphan = await db.collection('projects').insertOne({ name: 'Legacy', apiKeyHash: 'legacy-hash', apiKeyHint: 'et_x…', createdAt: new Date() });
      const run = promisify(execFile);
      const { stdout } = await run(process.execPath, ['scripts/make-admin.ts', 'ALICE@example.com'], { env: { ...process.env }, cwd: new URL('..', import.meta.url) });
      assert.match(stdout, /alice@example.com is now an admin/);
      assert.match(stdout, /given to this account: 1/);
      const legacy = await db.collection('projects').findOne({ _id: orphan.insertedId });
      assert.equal(String(legacy?.ownerId), alice.user.id);
      assert.equal((await api.admin.GET(authed('/api/admin'))).status, 200, 'the existing session now has admin rights');
    });

    it('lists users with their usage', async () => {
      const data = await (await api.admin.GET(authed('/api/admin'))).json();
      const row = data.users.find((u) => u.email === 'dave@example.com');
      assert.equal(row.projects, 1);
      assert.equal(row.events24h, 2);
      assert.equal(JSON.stringify(data).includes('passwordHash'), false);
      assert.ok(data.totals.users >= 4);
      assert.equal(data.totals.admins, 1);
      const search = await (await api.admin.GET(authed('/api/admin?q=DAVE'))).json();
      assert.deepEqual(search.users.map((u) => u.email), ['dave@example.com']);
    });

    it('disables a user: their sessions end, login and ingestion are refused; enabling restores them', async () => {
      const patch = (body) => api.admin.PATCH(authed(`/api/admin?id=${dave.user.id}`, { method: 'PATCH', body }));
      assert.equal((await patch({ status: 'disabled' })).status, 200);
      assert.equal((await api.projects.GET(as(dave.cookie)('/api/projects'))).status, 401);
      const login = await authPost('login', { email: 'dave@example.com', password: PASSWORD });
      assert.equal(login.status, 403);
      assert.equal((await login.json()).error.code, 'account_disabled');
      assert.equal((await ingest(daveKey, [sampleEvent()])).status, 403);

      assert.equal((await patch({ status: 'active' })).status, 200);
      assert.equal((await authPost('login', { email: 'dave@example.com', password: PASSWORD })).status, 200);
      assert.equal((await ingest(daveKey, [sampleEvent()])).status, 202);
      assert.equal((await patch({ status: 'bogus' })).status, 400);
    });

    it('changes roles, but never your own account', async () => {
      const promoted = await (await api.admin.PATCH(authed(`/api/admin?id=${dave.user.id}`, { method: 'PATCH', body: { role: 'admin' } }))).json();
      assert.equal(promoted.user.role, 'admin');
      await api.admin.PATCH(authed(`/api/admin?id=${dave.user.id}`, { method: 'PATCH', body: { role: 'user' } }));
      assert.equal((await api.admin.PATCH(authed(`/api/admin?id=${alice.user.id}`, { method: 'PATCH', body: { status: 'disabled' } }))).status, 400);
      assert.equal((await api.admin.DELETE(authed(`/api/admin?id=${alice.user.id}`, { method: 'DELETE' }))).status, 400);
    });

    it('the only admin cannot delete their own account', async () => {
      const res = await api.account.DELETE(authed('/api/account', { method: 'DELETE', body: { password: PASSWORD } }));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'last_admin');
    });

    it('deletes a user with all their projects', async () => {
      const res = await (await api.admin.DELETE(authed(`/api/admin?id=${dave.user.id}`, { method: 'DELETE' }))).json();
      assert.equal(res.deleted.projects, 1);
      assert.equal(await db.collection('users').countDocuments({ email: 'dave@example.com' }), 0);
      assert.equal((await ingest(daveKey, [sampleEvent()])).status, 401);
      assert.equal((await api.admin.DELETE(authed(`/api/admin?id=${dave.user.id}`, { method: 'DELETE' }))).status, 404);
    });
  });
});
