/**
 * Integration tests for project members, permissions and the project chat
 * (docs/MEMBERS_AND_CHAT.md): real handlers against a throwaway MongoDB
 * database. Skipped when MONGODB_URI is not configured. Pusher is not
 * configured here, so realtime delivery is a no-op and the chat polls.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Db } from 'mongodb';
import { closeDb, getDb } from '../server/db.ts';
import * as auth from '../server/routes/auth.ts';
import * as chat from '../server/routes/chat.ts';
import * as events from '../server/routes/events.ts';
import * as issue from '../server/routes/issue.ts';
import * as issues from '../server/routes/issues.ts';
import * as members from '../server/routes/members.ts';
import * as projects from '../server/routes/projects.ts';
import * as pusherAuth from '../server/routes/pusherAuth.ts';
import * as stats from '../server/routes/stats.ts';
import { hasDatabase, request, sampleEvent, useTestDatabase, type RequestOptions } from './helpers.ts';

const enabled = hasDatabase();
const PASSWORD = 'correct horse battery';
const freshIp = () => `10.${randomBytes(3).join('.')}`;
const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

describe('project members and chat (integration)', { skip: enabled ? false : 'MONGODB_URI not set' }, () => {
  let db: Db;
  before(async () => {
    useTestDatabase();
    process.env.SESSION_SECRET = 'test-secret';
    // .env.local may hold real Pusher keys: tests must never send to (or depend on) a real Pusher app.
    for (const name of ['PUSHER_APP_ID', 'PUSHER_SECRET', 'NEXT_PUBLIC_PUSHER_KEY', 'NEXT_PUBLIC_PUSHER_CLUSTER']) delete process.env[name];
    db = await getDb();
  });
  after(async () => {
    try {
      if (db) for (const { name } of await db.listCollections().toArray()) await db.collection(name).drop();
    } finally {
      await closeDb();
    }
  });

  async function signup(name: string, email: string) {
    const res = await auth.POST(request('/api/auth?action=signup', { method: 'POST', body: { name, email, password: PASSWORD }, headers: { 'x-forwarded-for': freshIp() } }));
    assert.equal(res.status, 201);
    const cookie = cookieFrom(res);
    return { user: (await res.json()).user as { id: string; email: string }, as: (path: string, options: RequestOptions = {}) => request(path, { ...options, headers: { cookie, ...(options.headers || {}) } }) };
  }

  let owner: Awaited<ReturnType<typeof signup>>;
  let bob: Awaited<ReturnType<typeof signup>>;
  let carol: Awaited<ReturnType<typeof signup>>;
  let stranger: Awaited<ReturnType<typeof signup>>;
  let dana: Awaited<ReturnType<typeof signup>>;
  let projectId: string;
  let issueId: string;
  let apiKey: string;
  const membersUrl = () => `/api/projects/members?projectId=${projectId}`;

  before(async () => {
    owner = await signup('Olive Owner', 'olive@example.com');
    bob = await signup('Bob Member', 'bob@example.com');
    carol = await signup('Carol Member', 'carol@example.com');
    stranger = await signup('Sam Stranger', 'sam@example.com');
    dana = await signup('Dana Manager', 'dana@example.com');
    const created = await (await projects.POST(owner.as('/api/projects', { method: 'POST', body: { name: 'Shared app' } }))).json();
    projectId = created.project.id;
    apiKey = created.apiKey;
    const res = await events.POST(request('/api/v1/events', { method: 'POST', headers: { 'X-API-Key': created.apiKey, 'x-forwarded-for': freshIp() }, body: { events: [sampleEvent()] } }));
    assert.equal(res.status, 202);
    issueId = (await (await issues.GET(owner.as(`/api/issues?projectId=${projectId}`))).json()).issues[0].id;
  });

  describe('adding members', () => {
    it('a project nobody shared is invisible (404) to others', async () => {
      assert.equal((await issues.GET(bob.as(`/api/issues?projectId=${projectId}`))).status, 404);
      assert.equal((await members.GET(bob.as(membersUrl()))).status, 404);
      assert.equal((await issue.GET(bob.as(`/api/issue?id=${issueId}`))).status, 404);
      assert.equal(((await (await projects.GET(bob.as('/api/projects'))).json()).projects).length, 0);
    });

    it('adds an existing account by email with the default permissions', async () => {
      const res = await members.POST(owner.as(membersUrl(), { method: 'POST', body: { email: ' BOB@example.com ' } }));
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.owner.email, 'olive@example.com');
      assert.equal(data.members.length, 1);
      assert.deepEqual(data.members[0].permissions, ['issues.update', 'chat.post', 'ai.use']);
    });

    it('rejects unknown emails, the owner, repeats, bad input and strangers', async () => {
      const add = (body: unknown, who = owner) => members.POST(who.as(membersUrl(), { method: 'POST', body }));
      assert.equal((await add({ email: 'nobody@example.com' })).status, 404);
      assert.equal((await add({ email: 'olive@example.com' })).status, 409);
      assert.equal((await add({ email: 'bob@example.com' })).status, 409);
      assert.equal((await add({ email: 'not an email' })).status, 400);
      assert.equal((await add({ email: 'carol@example.com', permissions: ['root'] })).status, 400);
      assert.equal((await add({ email: 'carol@example.com' }, stranger)).status, 404);
      assert.equal((await add({ email: 'carol@example.com' }, bob)).status, 403); // member without members.manage
    });

    it('the member now sees the project with their role and permissions', async () => {
      const list = (await (await projects.GET(bob.as('/api/projects'))).json()).projects;
      assert.equal(list.length, 1);
      assert.equal(list[0].role, 'member');
      assert.equal(list[0].ownerName, 'Olive Owner');
      assert.deepEqual(list[0].permissions, ['issues.update', 'chat.post', 'ai.use']);
      const own = (await (await projects.GET(owner.as('/api/projects'))).json()).projects[0];
      assert.equal(own.role, 'owner');
      assert.equal(own.permissions.length, 7);
    });
  });

  describe('permissions', () => {
    it('a member can read issues, events, stats and the member list', async () => {
      assert.equal((await issues.GET(bob.as(`/api/issues?projectId=${projectId}`))).status, 200);
      const detail = await (await issue.GET(bob.as(`/api/issue?id=${issueId}`))).json();
      assert.equal(detail.access.isOwner, false);
      assert.equal((await stats.GET(bob.as(`/api/stats?projectId=${projectId}`))).status, 200);
      const people = await (await members.GET(bob.as(membersUrl()))).json();
      assert.equal(people.canManage, false);
      assert.equal(people.members.length, 1);
    });

    it('a member can only do what was granted', async () => {
      const resolve = (who: typeof bob) => issue.PATCH(who.as(`/api/issue?id=${issueId}`, { method: 'PATCH', body: { status: 'resolved' } }));
      assert.equal((await resolve(bob)).status, 200); // issues.update is a default
      assert.equal((await issue.DELETE(bob.as(`/api/issue?id=${issueId}`, { method: 'DELETE' }))).status, 403);
      assert.equal((await issues.DELETE(bob.as(`/api/issues?projectId=${projectId}&status=all`, { method: 'DELETE' }))).status, 403);
      assert.equal((await projects.PATCH(bob.as(`/api/projects?id=${projectId}`, { method: 'PATCH', body: { allowedOrigins: [] } }))).status, 403);
      assert.equal((await projects.POST(bob.as(`/api/projects?id=${projectId}&action=rotate-key`, { method: 'POST' }))).status, 403);
      assert.equal((await projects.DELETE(bob.as(`/api/projects?id=${projectId}`, { method: 'DELETE' }))).status, 403);
      assert.equal((await resolve(stranger)).status, 404);
    });

    it('the owner can change permissions, and the change applies at once', async () => {
      const people = await (await members.GET(owner.as(membersUrl()))).json();
      const memberId = people.members[0].memberId;
      const patch = (permissions: unknown, who = owner, id = memberId) => members.PATCH(who.as(membersUrl(), { method: 'PATCH', body: { memberId: id, permissions } }));
      assert.equal((await patch(['issues.delete', 'settings.manage', 'key.manage'])).status, 200);
      assert.equal((await issues.DELETE(bob.as(`/api/issues?projectId=${projectId}&status=resolved`, { method: 'DELETE' }))).status, 200);
      assert.equal((await projects.PATCH(bob.as(`/api/projects?id=${projectId}`, { method: 'PATCH', body: { allowedOrigins: ['https://app.example.com'] } }))).status, 200);
      assert.equal((await issue.PATCH(bob.as(`/api/issue?id=${issueId}`, { method: 'PATCH', body: { status: 'open' } }))).status, 404); // issue deleted above
      assert.equal((await patch(['bogus'])).status, 400);
      assert.equal((await patch([], bob)).status, 403);
      // Reset for the next tests; permission lists are stored in a fixed order, without repeats.
      assert.equal((await patch(['chat.post', 'issues.update', 'chat.post'])).status, 200);
      const after = await (await members.GET(owner.as(membersUrl()))).json();
      assert.deepEqual(after.members[0].permissions, ['issues.update', 'chat.post']);
    });

    it('delegated member management works, but nobody edits their own permissions', async () => {
      const carolAdd = await members.POST(owner.as(membersUrl(), { method: 'POST', body: { email: 'carol@example.com', permissions: ['members.manage'] } }));
      assert.equal(carolAdd.status, 201);
      const people = await (await members.GET(owner.as(membersUrl()))).json();
      const carolRow = people.members.find((m: { email: string }) => m.email === 'carol@example.com');
      const own = await members.PATCH(carol.as(membersUrl(), { method: 'PATCH', body: { memberId: carolRow.memberId, permissions: ['members.manage', 'issues.delete'] } }));
      assert.equal(own.status, 403);
      const bobRow = people.members.find((m: { email: string }) => m.email === 'bob@example.com');
      assert.equal((await members.PATCH(carol.as(membersUrl(), { method: 'PATCH', body: { memberId: bobRow.memberId, permissions: ['issues.update', 'chat.post'] } }))).status, 200);
    });

    it('a member manager can only hand out permissions they hold, and cannot touch other managers', async () => {
      // Carol holds only members.manage: she cannot give anything else, not even to a new account of her own.
      const addAs = (who: typeof carol, email: string, permissions: string[]) => members.POST(who.as(membersUrl(), { method: 'POST', body: { email, permissions } }));
      assert.equal((await addAs(carol, 'dana@example.com', ['issues.delete'])).status, 403);
      assert.equal((await addAs(carol, 'dana@example.com', ['key.manage', 'members.manage'])).status, 403);
      const people = await (await members.GET(carol.as(membersUrl()))).json();
      const bobRow = people.members.find((m: { email: string }) => m.email === 'bob@example.com');
      const grant = (permissions: string[]) => members.PATCH(carol.as(membersUrl(), { method: 'PATCH', body: { memberId: bobRow.memberId, permissions } }));
      assert.equal((await grant(['issues.update', 'chat.post', 'key.manage'])).status, 403); // a new permission Carol lacks
      // Saving the permissions Bob already has is fine even though Carol doesn't hold them.
      assert.equal((await grant(['issues.update', 'chat.post'])).status, 200);
      // Another manager (added by the owner) is off limits for Carol; the owner can still manage them.
      assert.equal((await addAs(owner, 'dana@example.com', ['members.manage'])).status, 201);
      const danaRow = (await (await members.GET(owner.as(membersUrl()))).json()).members.find((m: { email: string }) => m.email === 'dana@example.com');
      assert.equal((await members.PATCH(carol.as(membersUrl(), { method: 'PATCH', body: { memberId: danaRow.memberId, permissions: [] } }))).status, 403);
      const removeUrl = `${membersUrl()}&memberId=${danaRow.memberId}`;
      assert.equal((await members.DELETE(carol.as(removeUrl, { method: 'DELETE' }))).status, 403);
      assert.equal((await members.DELETE(owner.as(removeUrl, { method: 'DELETE' }))).status, 200);
      // Dana can no longer read anything.
      assert.equal((await members.GET(dana.as(membersUrl()))).status, 404);
    });
  });

  describe('project chat', () => {
    const post = (who: typeof bob, text: unknown, extra: Record<string, unknown> = {}) => chat.POST(who.as('/api/chat', { method: 'POST', body: { projectId, text, ...extra } }));
    const list = async (who: typeof bob, query = '') => (await chat.GET(who.as(`/api/chat?projectId=${projectId}${query}`))).json();
    let firstId: string;

    it('members with chat.post can write; messages carry author names', async () => {
      const res = await post(owner, '  Hello team  ', { mentions: [bob.user.id, 'x', stranger.user.id, bob.user.id] });
      assert.equal(res.status, 201);
      const { message } = await res.json();
      firstId = message.id;
      assert.equal(message.text, 'Hello team');
      assert.equal(message.userName, 'Olive Owner');
      assert.deepEqual(message.mentions, [bob.user.id]); // strangers, junk and repeats dropped
      assert.equal((await post(bob, 'Hi Olive')).status, 201);
    });

    it('rejects empty, too long and non-text messages', async () => {
      assert.equal((await post(owner, '   ')).status, 400);
      assert.equal((await post(owner, 'x'.repeat(4001))).status, 400);
      assert.equal((await post(owner, { a: 1 })).status, 400);
    });

    it('strangers get 404, and a member without chat.post can read but not write', async () => {
      assert.equal((await post(stranger, 'hi')).status, 404);
      assert.equal((await chat.GET(stranger.as(`/api/chat?projectId=${projectId}`))).status, 404);
      const people = await (await members.GET(owner.as(membersUrl()))).json();
      const bobRow = people.members.find((m: { email: string }) => m.email === 'bob@example.com');
      await members.PATCH(owner.as(membersUrl(), { method: 'PATCH', body: { memberId: bobRow.memberId, permissions: ['issues.update'] } }));
      assert.equal((await post(bob, 'can I?')).status, 403);
      assert.equal(((await list(bob)).messages).length, 2);
      await members.PATCH(owner.as(membersUrl(), { method: 'PATCH', body: { memberId: bobRow.memberId, permissions: ['issues.update', 'chat.post'] } }));
    });

    it('counts unread messages per project and clears them when the chat is read', async () => {
      await post(owner, 'unread one');
      await post(owner, 'unread two');
      const unread = async (who: typeof bob) => (await (await projects.GET(who.as('/api/projects'))).json()).projects.find((p: { id: string }) => p.id === projectId).unreadMessages;
      assert.equal(await unread(carol), 4); // carol never opened the chat (the owner's own posts count as read for the owner)
      await post(bob, 'unread three');
      assert.equal(await unread(owner), 1); // bob wrote after the owner's last post
      await list(carol);
      assert.equal(await unread(carol), 0);
    });

    it('pages history and polls for newer messages', async () => {
      const all = await list(owner);
      assert.equal(all.messages.length, 5);
      assert.equal(all.hasMore, false);
      assert.equal(all.realtime, false);
      const newer = await list(owner, `&after=${firstId}`);
      assert.equal(newer.messages.length, 4);
      const older = await list(owner, `&before=${all.messages[2].id}`);
      assert.equal(older.messages.length, 2);
      assert.equal((await chat.GET(owner.as(`/api/chat?projectId=${projectId}&after=zzz`))).status, 400);
    });

    it('deletes own messages; only the owner deletes other people\'s', async () => {
      const mine = (await (await post(bob, 'oops')).json()).message.id;
      assert.equal((await chat.DELETE(carol.as(`/api/chat?id=${mine}`, { method: 'DELETE' }))).status, 403);
      assert.equal((await chat.DELETE(bob.as(`/api/chat?id=${mine}`, { method: 'DELETE' }))).status, 200);
      assert.equal((await chat.DELETE(stranger.as(`/api/chat?id=${firstId}`, { method: 'DELETE' }))).status, 404);
      assert.equal((await chat.DELETE(owner.as(`/api/chat?id=${firstId}`, { method: 'DELETE' }))).status, 200);
      const shown = (await list(owner)).messages;
      assert.equal(shown.find((m: { id: string }) => m.id === mine).deleted, true);
      assert.equal(shown.find((m: { id: string }) => m.id === mine).text, '');
    });

    it('attaches issues of this project; issues of other projects are dropped; an empty message needs an issue', async () => {
      const newIssue = async (key: string, message: string) => {
        const res = await events.POST(request('/api/v1/events', { method: 'POST', headers: { 'X-API-Key': key, 'x-forwarded-for': freshIp() }, body: { events: [sampleEvent({ error: { message, type: 'TypeError', handled: false } })] } }));
        assert.equal(res.status, 202);
      };
      await newIssue(apiKey, 'chat attachment issue');
      const mine = (await (await issues.GET(owner.as(`/api/issues?projectId=${projectId}&status=all&q=chat+attachment`))).json()).issues[0];
      const other = await (await projects.POST(stranger.as('/api/projects', { method: 'POST', body: { name: 'Other app' } }))).json();
      await newIssue(other.apiKey, 'an issue in another project');
      const theirs = (await (await issues.GET(stranger.as(`/api/issues?projectId=${other.project.id}`))).json()).issues[0];

      const res = await post(owner, '  ', { issues: [mine.id, theirs.id, 'junk', mine.id] });
      assert.equal(res.status, 201);
      const { message } = await res.json();
      assert.equal(message.text, '');
      assert.deepEqual(message.issues.map((i: { id: string }) => i.id), [mine.id]);
      assert.equal(message.issues[0].errorType, 'TypeError');
      assert.equal(message.issues[0].status, 'open');
      assert.equal((await post(owner, '   ', { issues: [theirs.id] })).status, 400); // nothing left to send
      assert.equal((await post(owner, 'see this', { issues: [theirs.id] })).status, 201); // text only, the foreign issue is dropped
      // The card follows the issue: once it is gone, the message shows without it.
      await issue.DELETE(owner.as(`/api/issue?id=${mine.id}`, { method: 'DELETE' }));
      const shown = (await list(owner)).messages.find((m: { id: string }) => m.id === message.id);
      assert.deepEqual(shown.issues, []);
    });

    it('replies quote the original; reactions toggle per person; unknown emoji are refused', async () => {
      const original = (await (await post(owner, 'Who owns the login bug?')).json()).message;
      const reply = (await (await post(bob, 'I can take it', { replyTo: original.id })).json()).message;
      assert.equal(reply.replyTo.id, original.id);
      assert.equal(reply.replyTo.userName, 'Olive Owner');
      assert.equal(reply.replyTo.text, 'Who owns the login bug?');
      const stray = (await (await post(bob, 'no quote', { replyTo: '0'.repeat(24) })).json()).message;
      assert.equal(stray.replyTo, null); // an id that is not a message of this project is ignored

      const react = (who: typeof bob, id: string, emoji: unknown) => chat.POST(who.as('/api/chat?action=react', { method: 'POST', body: { id, emoji } }));
      const first = await (await react(bob, original.id, '👍')).json();
      assert.deepEqual(first.message.reactions, [{ emoji: '👍', count: 1, mine: true, names: ['Bob Member'] }]);
      const second = await (await react(owner, original.id, '👍')).json();
      assert.equal(second.message.reactions[0].count, 2);
      assert.equal(second.message.reactions[0].mine, true);
      const off = await (await react(bob, original.id, '👍')).json();
      assert.equal(off.message.reactions[0].count, 1);
      assert.equal(off.message.reactions[0].mine, false); // bob took his reaction away
      assert.equal((await react(bob, original.id, 'x.y')).status, 400);
      assert.equal((await react(stranger, original.id, '👍')).status, 404);
      // The single-message fetch (used after a live "message-updated") shows the same reactions.
      const fetched = (await (await chat.GET(owner.as(`/api/chat?projectId=${projectId}&message=${original.id}`))).json()).messages[0];
      assert.equal(fetched.reactions[0].count, 1);
      // A deleted message loses its reactions and cannot be reacted to.
      await chat.DELETE(owner.as(`/api/chat?id=${original.id}`, { method: 'DELETE' }));
      assert.equal((await react(bob, original.id, '👍')).status, 400);
      const quoted = (await list(owner)).messages.find((m: { id: string }) => m.id === reply.id);
      assert.equal(quoted.replyTo.deleted, true);
      assert.equal(quoted.replyTo.text, '');
    });

    it('tells the browser when the chat was last read, for the "unread" divider', async () => {
      const firstVisit = await list(carol);
      assert.ok(firstVisit.lastReadAt === null || typeof firstVisit.lastReadAt === 'string');
      await post(owner, 'a message carol has not seen');
      const secondVisit = await list(carol);
      assert.equal(typeof secondVisit.lastReadAt, 'string'); // when carol was here before
      const lastMessage = secondVisit.messages[secondVisit.messages.length - 1];
      assert.ok(new Date(lastMessage.createdAt) > new Date(secondVisit.lastReadAt)); // so it counts as unread
      assert.equal((await list(carol, `&after=${lastMessage.id}`)).lastReadAt, null); // polling does not report it
    });

    it('limits how fast one user can post', async () => {
      let last = 201;
      for (let i = 0; i < 35 && last === 201; i++) last = (await post(owner, `spam ${i}`)).status;
      assert.equal(last, 429);
    });
  });

  describe('Pusher channel authorisation', () => {
    const authorize = (who: typeof bob, channel: string) => {
      const cookie = who.as('/').headers.get('cookie') ?? '';
      return pusherAuth.POST(new Request('http://localhost/api/pusher/auth', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: `socket_id=123.456&channel_name=${channel}`,
      }));
    };

    it('refuses unknown channels and non-members; says "not configured" for members', async () => {
      assert.equal((await authorize(owner, 'private-other')).status, 403);
      assert.equal((await authorize(stranger, `private-project-${projectId}`)).status, 403);
      assert.equal((await authorize(bob, `private-project-${projectId}`)).status, 503); // Pusher env vars are not set in tests
    });
  });

  describe('leaving, removing and deleting', () => {
    it('a member can leave; a removed member loses access and unread markers', async () => {
      const people = await (await members.GET(owner.as(membersUrl()))).json();
      const bobRow = people.members.find((m: { email: string }) => m.email === 'bob@example.com');
      const carolRow = people.members.find((m: { email: string }) => m.email === 'carol@example.com');
      assert.equal((await members.DELETE(bob.as(`${membersUrl()}&memberId=${carolRow.memberId}`, { method: 'DELETE' }))).status, 403);
      const left = await members.DELETE(bob.as(`${membersUrl()}&memberId=${bobRow.memberId}`, { method: 'DELETE' }));
      assert.equal((await left.json()).left, true);
      assert.equal((await issues.GET(bob.as(`/api/issues?projectId=${projectId}`))).status, 404);
      assert.equal((await members.DELETE(owner.as(`${membersUrl()}&memberId=${carolRow.memberId}`, { method: 'DELETE' }))).status, 200);
      assert.equal(await db.collection('project_members').countDocuments({ projectId: { $exists: true } }), 0);
    });

    it('deleting the project removes its members, messages and read markers', async () => {
      await members.POST(owner.as(membersUrl(), { method: 'POST', body: { email: 'bob@example.com' } }));
      assert.equal((await projects.DELETE(owner.as(`/api/projects?id=${projectId}`, { method: 'DELETE' }))).status, 200);
      for (const name of ['project_members', 'chat_messages', 'chat_reads']) assert.equal(await db.collection(name).countDocuments(), 0, name);
    });
  });
});
